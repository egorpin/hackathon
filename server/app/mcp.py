"""Player-scoped MCP tools sharing the authoritative backend and world instance."""
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import Field
from starlette.requests import Request
from starlette.responses import JSONResponse

from .game.commands import Rejected, authorize
from .game.state import Context as GameContext, INVENTORY_CAPACITY, REACH
from .world.geometry import surface_distance

Identifier = Annotated[str, Field(strict=True, min_length=1, max_length=128)]
RequestId = Annotated[str, Field(strict=True, pattern=r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
Amount = Annotated[int, Field(strict=True, ge=1, le=INVENTORY_CAPACITY)]
Revision = Annotated[int, Field(strict=True, ge=0)]
Resource = Literal['ore', 'water', 'sulfur', 'iron', 'copper']
BuildingType = Literal['drill', 'warehouse', 'oxygen_generator', 'solar_panel', 'wind_turbine']
READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)
REMOVE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=True, openWorldHint=False)


def session_identity(backend, request):
    """Only an explicit bearer credential; browser cookies grant no MCP access."""
    scheme, _, token = request.headers.get('authorization', '').partition(' ')
    if scheme.lower() != 'bearer' or not token:
        return None
    return backend.db.identity(token)


class AuthenticatedMCP:
    def __init__(self, app, backend):
        self.app, self.backend = app, backend

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        request = Request(scope)
        headers = {'Cache-Control': 'no-store'}
        if 'origin' in request.headers and not self.backend.origin_allowed(request.headers, request.url.scheme):
            response = JSONResponse({'detail': 'Origin is not allowed'}, 403, headers=headers)
        elif not session_identity(self.backend, request):
            response = JSONResponse({'detail': 'A live player session bearer token is required'}, 401,
                                    headers={**headers, 'WWW-Authenticate': 'Bearer'})
        else:
            async def no_cache(message):
                if message['type'] == 'http.response.start':
                    message['headers'] = list(message.get('headers', [])) + [(b'cache-control', b'no-store')]
                await send(message)
            return await self.app(scope, receive, no_cache)
        await response(scope, receive, send)


def create_server(app, backend):
    mcp = FastMCP(
        'Mars Colony', stateless_http=True, json_response=True, streamable_http_path='/',
        max_request_body_size=16384,
        instructions='Act for the authenticated player. Read get_world and get_nearby_cells first. '
                     'Respect range, costs, team ownership and rover program revisions. '
                     'Use a new canonical UUID request_id per intended action; reuse it with identical '
                     'arguments on retries. Check payload.ok in every action result. '
                     'World start/reset, admin editing and arbitrary code execution are unavailable.',
        # Origin checks are performed by AuthenticatedMCP using the backend's LAN-aware policy.
        # All requests additionally require an explicit, unguessable live bearer session.
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )

    def identity(ctx):
        identity = session_identity(backend, ctx.request_context.request)
        if identity is None:
            raise ToolError('UNAUTHORIZED')
        runtime = app.state.game.runtime(identity)
        state = runtime.state
        context = GameContext(identity['world_id'], identity['user_id'], identity['team_id'])
        try:
            authorize(context, state)
        except Rejected as error:
            raise ToolError(error.code) from None
        return identity, runtime, state

    def command(ctx, kind, request_id, **payload):
        actor, runtime, state = identity(ctx)
        if state.admin_paused:
            raise ToolError('WORLD_PAUSED')
        return app.state.game.command(actor, {'type': kind, 'request_id': request_id, 'payload': payload})

    @mcp.tool(annotations=READ)
    async def get_world(ctx: Context) -> dict[str, Any]:
        """Read the player's filtered view, inventory, team stock, recipes and rover fleet. Never enrolls a player."""
        actor, _, state = identity(ctx)
        return {**app.state.game.dto(actor), 'paused': state.admin_paused}

    @mcp.tool(annotations=READ)
    async def get_nearby_cells(ctx: Context) -> dict[str, Any]:
        """Inspect cells within the player's build reach, including occupancy, terrain and deposits."""
        actor, runtime, state = identity(ctx)
        player = state.players[actor['user_id']]
        occupied = {b.cell_id for b in state.buildings.values()} | set(state.mountains)
        cells = []
        if player.position is not None:
            for cell in runtime.planet.cells.values():
                distance = surface_distance(player.position, cell.center, runtime.planet.radius)
                if distance <= REACH:
                    cells.append(dict(cell_id=cell.cell_id, position=cell.center, distance=round(distance, 4),
                                      buildable=cell.buildable, resource=cell.resource,
                                      occupied=cell.cell_id in occupied))
        return {'cells': sorted(cells, key=lambda cell: cell['distance']), 'reach': REACH,
                'note': 'Placement still checks resources and collisions with players.'}

    @mcp.tool(annotations=WRITE)
    async def place_building(cell_id: Identifier, building_type: BuildingType, request_id: RequestId, ctx: Context) -> dict[str, Any]:
        """Build nearby using team resources. Requires running game, free buildable cell, sufficient stock; drills need a deposit."""
        return command(ctx, 'building.place', request_id, cell_id=cell_id, building_type=building_type)

    @mcp.tool(annotations=REMOVE)
    async def remove_building(building_id: Identifier, request_id: RequestId, ctx: Context) -> dict[str, Any]:
        """Demolish a nearby allied building and refund its paid cost and stock. Landing domes cannot be removed."""
        return command(ctx, 'building.remove', request_id, building_id=building_id)

    @mcp.tool(annotations=WRITE)
    async def pickup_resource(building_id: Identifier, resource: Resource, amount: Amount, request_id: RequestId, ctx: Context) -> dict[str, Any]:
        """Take 1–50 units from a nearby allied building, respecting available stock and inventory capacity."""
        return command(ctx, 'resource.pickup', request_id, building_id=building_id, resource=resource, amount=amount)

    @mcp.tool(annotations=WRITE)
    async def deposit_resource(building_id: Identifier, resource: Resource, amount: Amount, request_id: RequestId, ctx: Context) -> dict[str, Any]:
        """Deposit carried resources into a nearby allied building, respecting stock and destination capacity."""
        return command(ctx, 'resource.deposit', request_id, building_id=building_id, resource=resource, amount=amount)

    @mcp.tool(annotations=WRITE)
    async def give_resource(recipient_player_id: Identifier, resource: Resource, amount: Amount, request_id: RequestId, ctx: Context) -> dict[str, Any]:
        """Give carried resources to another nearby teammate within their inventory capacity."""
        return command(ctx, 'resource.give', request_id, recipient_player_id=recipient_player_id, resource=resource, amount=amount)

    @mcp.tool(annotations=WRITE)
    async def survey_position(request_id: RequestId, ctx: Context) -> dict[str, Any]:
        """Record the player's current coordinates for rover navigation; maximum 16 surveys."""
        return command(ctx, 'rover.survey', request_id)

    @mcp.tool(annotations=WRITE)
    async def register_rover_point(name: Annotated[str, Field(strict=True, min_length=1, max_length=24)],
                                   latitude: Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False)],
                                   longitude: Annotated[float, Field(ge=-180, lt=180, allow_inf_nan=False)],
                                   request_id: RequestId, ctx: Context) -> dict[str, Any]:
        """Register surveyed coordinates at an allied office. Maximum 12 points; coordinates require 4-decimal precision."""
        return command(ctx, 'rover.point.register', request_id, name=name, latitude=latitude, longitude=longitude)

    @mcp.tool(annotations=WRITE)
    async def purchase_rover(request_id: RequestId, ctx: Context) -> dict[str, Any]:
        """Buy a rover at an allied office using team resources. Maximum four rovers and a clear spawn location required."""
        return command(ctx, 'rover.purchase', request_id)

    @mcp.tool(annotations=WRITE)
    async def program_rover(rover_id: Identifier, program: Annotated[str, Field(strict=True, max_length=512)],
                            expected_revision: Revision, request_id: RequestId, ctx: Context) -> dict[str, Any]:
        """Save a stopped allied rover's restricted DSL program at an office. No Python/shell; parser checks 512-byte limit and instructions."""
        return command(ctx, 'rover.program', request_id, rover_id=rover_id, program=program, expected_revision=expected_revision)

    @mcp.tool(annotations=WRITE)
    async def start_rover(rover_id: Identifier, expected_revision: Revision, request_id: RequestId, ctx: Context) -> dict[str, Any]:
        """Start an allied rover's valid saved program at an office, using its current program revision."""
        return command(ctx, 'rover.start', request_id, rover_id=rover_id, expected_revision=expected_revision)

    @mcp.tool(annotations=WRITE)
    async def stop_rover(rover_id: Identifier, request_id: RequestId, ctx: Context) -> dict[str, Any]:
        """Stop an allied rover immediately; office access is not required."""
        return command(ctx, 'rover.stop', request_id, rover_id=rover_id)

    return mcp


def install(app, backend):
    # Stable route, fresh SDK session manager on every application lifespan.
    app.state.mcp_transport = AuthenticatedMCP(None, backend)
    app.mount('/mcp', app.state.mcp_transport, name='mcp')


@asynccontextmanager
async def lifespan(app, backend):
    server = create_server(app, backend)
    app.state.mcp_transport.app = server.streamable_http_app()
    try:
        async with server.session_manager.run():
            yield
    finally:
        app.state.mcp_transport.app = None
