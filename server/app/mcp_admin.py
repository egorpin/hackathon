"""Boss MCP: explicit admin tools over the same transactional game runtime."""
from copy import deepcopy
from dataclasses import asdict
import hashlib
import json
import time
import uuid
from typing import Annotated, Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .admin import Character, characters
from .game.commands import Rejected, require, restart_world
from .game.rover import (CAPACITY, NAME, mass, new_rover, parse, position as coordinates_position,
                         telemetry, ensure_start)
from .game.state import (Building, MINABLE_RESOURCES,
                         CONSTRUCTION_BUILD_TICKS, CONSTRUCTION_TRAVEL_TICKS, INPUT_TIMEOUT_TICKS)
from .mcp import Identifier, RequestId, Revision, READ, REMOVE
from .world.geometry import unit, scale
from .world.terrain import ground_position, seed_from_world_id

Number = Annotated[float, Field(strict=True, allow_inf_nan=False)]
Count = Annotated[int, Field(strict=True, ge=0, le=1000000)]
Stock = dict[Literal['ore', 'water', 'sulfur', 'iron', 'copper', 'oxygen'], Count]
Color = Literal['#ff6b4a', '#ffbd4a', '#a7d94b', '#42d6a4', '#42b8ff', '#687bff', '#bd70ff', '#ff75b8']
Kind = Literal['drill', 'warehouse', 'oxygen_generator', 'dome_base', 'solar_panel', 'wind_turbine']


class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)


class Destination(Model):
    """Exactly one destination: a cell, Cartesian direction, coordinates or player."""
    cell_id: Identifier | None = None
    position: Annotated[list[Number], Field(min_length=3, max_length=3)] | None = None
    latitude: Annotated[Number, Field(ge=-90, le=90)] | None = None
    longitude: Annotated[Number, Field(ge=-180, lt=180)] | None = None
    player_id: Identifier | None = None
    altitude: Annotated[Number, Field(ge=0, le=1000)] = 0.

    @model_validator(mode='after')
    def destination(self):
        coords = self.latitude is not None or self.longitude is not None
        if coords and (self.latitude is None or self.longitude is None):
            raise ValueError('latitude and longitude must be specified together')
        if sum((self.cell_id is not None, self.position is not None, coords, self.player_id is not None)) != 1:
            raise ValueError('Specify exactly one destination')
        if self.position is not None:
            unit(self.position)
        return self


class WorldPatch(Model):
    paused: bool | None = None
    stage: Literal['lobby', 'running'] | None = None
    oxygen_percent: Annotated[Number, Field(ge=0, le=100)] | None = None


class PlayerPatch(Model):
    color: Color | None = None
    flashlight: bool | None = None
    pitch: Annotated[Number, Field(ge=-1.45, le=1.45)] | None = None
    inventory: Stock | None = None


class BuildingPatch(Model):
    cell_id: Identifier | None = None
    building_type: Kind | None = None
    creator_id: Identifier | None = None
    completed: bool | None = None
    stock: Stock | None = None


class CellPatch(Model):
    cell_id: Identifier
    buildable: bool | None = None
    resource: Literal['water', 'sulfur', 'iron', 'copper'] | None = None
    terrain: Literal['ground', 'landing'] | None = None
    mountain: bool | None = None


class BossService:
    def __init__(self, app, backend):
        self.app, self.backend = app, backend

    def runtime(self, world_id):
        with self.backend.db.connect() as db:
            if not db.execute('SELECT 1 FROM worlds WHERE id=?', (world_id,)).fetchone():
                raise ToolError('WORLD_NOT_FOUND')
        return self.app.state.game.runtime({'world_id': world_id})

    def mutate(self, world_id, request_id, operation, arguments, expected_version, action):
        """Rollback the entire action on failure; commit receipts with successful mutations."""
        runtime = self.runtime(world_id)
        fingerprint = hashlib.sha256(json.dumps(
            dict(operation=operation, arguments=arguments, expected_version=expected_version),
            sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
        try:
            with runtime.transaction() as state:
                previous = state.admin_results.get(request_id)
                if previous:
                    require(previous['fingerprint'] == fingerprint, 'REQUEST_CONFLICT')
                    return deepcopy(previous['result'])
                require(expected_version is None or state.admin_version == expected_version, 'VERSION_CONFLICT')
                details = action(state, runtime.planet) or {}
                state.admin_version += 1
                state.revision += 1
                result = dict(ok=True, request_id=request_id, version=state.admin_version,
                              revision=state.revision, **details)
                state.admin_results[request_id] = dict(fingerprint=fingerprint, result=deepcopy(result))
                state.admin_audit.append(dict(request_id=request_id, operation=operation,
                                             timestamp=int(time.time()), version=state.admin_version))
                state.admin_audit = state.admin_audit[-100:]
                return result
        except Rejected as error:
            return dict(ok=False, request_id=request_id, code=error.code, version=runtime.state.admin_version)
        except ValueError as error:
            raise ToolError(str(error)) from None

    @staticmethod
    def player(state, player_id):
        require(player_id in state.players, 'PLAYER_NOT_FOUND')
        return state.players[player_id]

    @staticmethod
    def rover(state, rover_id):
        require(rover_id in state.rovers, 'ROVER_NOT_FOUND')
        return state.rovers[rover_id]

    @staticmethod
    def building(state, building_id):
        require(building_id in state.buildings, 'BUILDING_NOT_FOUND')
        return state.buildings[building_id]

    def destination(self, state, planet, target):
        if target.cell_id is not None:
            require(target.cell_id in planet.cells, 'CELL_NOT_FOUND')
            point = planet.cells[target.cell_id].center
        elif target.player_id is not None:
            point = self.player(state, target.player_id).position
            require(point is not None, 'TARGET_UNAVAILABLE')
        elif target.position is not None:
            point = scale(unit(target.position), planet.radius)
        else:
            point = coordinates_position(target.latitude, target.longitude, planet.radius)
        return ground_position(point, planet.radius, target.altitude, seed_from_world_id(state.world_id))

    @staticmethod
    def check_building(state, planet, cell_id, kind, skip=None):
        require(cell_id in planet.cells, 'CELL_NOT_FOUND')
        require(not any(b.cell_id == cell_id and b.building_id != skip for b in state.buildings.values()), 'CELL_OCCUPIED')
        require(cell_id not in state.mountains, 'CELL_OCCUPIED')
        require(kind != 'drill' or planet.cells[cell_id].resource in MINABLE_RESOURCES, 'RESOURCE_REQUIRED')

    @staticmethod
    def complete(building, completed):
        building.construction_status = 'completed' if completed else 'planned'
        building.construction_travel_progress = CONSTRUCTION_TRAVEL_TICKS if completed else 0
        building.construction_progress = CONSTRUCTION_BUILD_TICKS if completed else 0
        building.construction_required = CONSTRUCTION_BUILD_TICKS


def create_server(app, backend):
    service = BossService(app, backend)
    mcp = FastMCP(
        'Mars Colony Boss', stateless_http=True, json_response=True, streamable_http_path='/',
        max_request_body_size=65536,
        instructions='You are Босс, administrator of Mars Colony. Call admin_get_overview, then '
                     'admin_get_world and admin_get_cells. These tools operate across all teams without '
                     'player enrollment, range, costs or office requirements, including while paused. '
                     'Use explicit world_id and a fresh canonical UUID request_id per intent; retry with '
                     'identical arguments. Check ok/code. Use expected_version from admin_get_world '
                     'to prevent overwriting another administrator. Teleport positions are grounded '
                     'on the planet. Cell edits are per-world and persistent. Arbitrary code is not supported.',
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )

    def mutate(world_id, request_id, operation, arguments, expected_version, action):
        try:
            return service.mutate(world_id, request_id, operation, arguments, expected_version, action)
        except Rejected as error:
            raise ToolError(error.code) from None

    @mcp.tool(annotations=READ)
    async def admin_get_overview() -> dict[str, Any]:
        """List all world IDs/stages and connected players; no account passwords or session tokens."""
        with backend.db.connect() as db:
            worlds = [dict(row) for row in db.execute('SELECT id, stage FROM worlds')]
        for world in worlds:
            runtime = app.state.game.worlds.get(world['id'])
            state = runtime.state.to_dict() if runtime else backend.db.load_game(world['id'])
            if state:
                world.update(stage=state['stage'], paused=state.get('admin_paused', False),
                             version=state.get('admin_version', 0))
        clients = [dict(world_id=i['world_id'], player_id=i['user_id'], username=i['username'])
                   for socket in list(backend.connections)
                   if (i := backend.db.identity(socket.state.session_token))]
        return dict(worlds=worlds, clients=clients)

    @mcp.tool(annotations=READ)
    async def admin_get_world(world_id: Identifier) -> dict[str, Any]:
        """Unfiltered world: all players/inventories, buildings/stocks, rovers, characters and last 100 admin actions."""
        try:
            runtime = service.runtime(world_id)
        except Rejected as error:
            raise ToolError(error.code) from None
        state = runtime.state
        return dict(world_id=world_id, version=state.admin_version, revision=state.revision,
                    generation=state.generation, stage=state.stage, paused=state.admin_paused,
                    tick=state.tick, oxygen_percent=state.oxygen_percent, radius=runtime.planet.radius,
                    map_version=state.map_version, map_revision=state.map_revision, players=[asdict(p) for p in state.players.values()],
                    buildings=[asdict(b) for b in state.buildings.values()],
                    rovers=[telemetry(r) for r in state.rovers.values()], team_storage=state.team_storage,
                    landing_sites=runtime.planet.landing_sites, landing_claims=state.landing_claims,
                    mountains=state.mountains, cell_overrides=state.cell_overrides,
                    rover_points=state.rover_points, characters=characters(state),
                    active_character=state.admin_active_character, audit=state.admin_audit)

    @mcp.tool(annotations=READ)
    async def admin_get_cells(world_id: Identifier, offset: Annotated[int, Field(strict=True, ge=0)] = 0,
                              limit: Annotated[int, Field(strict=True, ge=1, le=200)] = 100) -> dict[str, Any]:
        """Page through the entire map, including deposits, geometry, buildability and occupants; no range limit."""
        try:
            runtime = service.runtime(world_id)
        except Rejected as error:
            raise ToolError(error.code) from None
        state = runtime.state
        occupied = {b.cell_id: b.building_id for b in state.buildings.values()}
        cells = list(runtime.planet.cells.values())
        return dict(cells=[{**asdict(c), 'mountain': c.cell_id in state.mountains,
                            'building_id': occupied.get(c.cell_id)} for c in cells[offset:offset+limit]],
                    total=len(cells), next_offset=offset+limit if offset+limit < len(cells) else None)

    @mcp.tool(annotations=REMOVE)
    async def admin_set_world(world_id: Identifier, edit: WorldPatch, request_id: RequestId,
                               expected_version: Revision | None = None) -> dict[str, Any]:
        """Pause/resume, set oxygen, force lobby/running without a readiness vote. Start initializes landing bases/rovers."""
        def action(state, planet):
            if edit.paused is not None:
                state.admin_paused = edit.paused
            if edit.oxygen_percent is not None:
                state.oxygen_percent = edit.oxygen_percent
            if edit.stage is not None:
                if edit.stage == 'running' and state.stage != 'running':
                    require(bool(state.players), 'PLAYERS_REQUIRED')
                    ensure_start(state, planet)
                state.stage = edit.stage
        before = service.runtime(world_id).state.admin_version
        result = mutate(world_id, request_id, 'world.edit', edit.model_dump(), expected_version, action)
        if result['ok'] and service.runtime(world_id).state.admin_version != before:
            if service.runtime(world_id).state.stage == 'running':
                app.state.lobby.active.add(world_id)
            else:
                app.state.lobby.restart(world_id)
            await backend.broadcast_lobby(world_id)
        return result

    @mcp.tool(annotations=REMOVE)
    async def admin_restart_world(world_id: Identifier, request_id: RequestId,
                                   expected_version: Revision | None = None) -> dict[str, Any]:
        """Reset gameplay, resources and edited cells to the initial lobby across all teams; retain admin settings and receipts."""
        before = service.runtime(world_id).state.generation
        result = mutate(world_id, request_id, 'world.restart', {}, expected_version, restart_world)
        if result['ok'] and service.runtime(world_id).state.generation != before:
            # Follow the browser restart path: invalidate pending offers before reconnect.
            app.state.lobby.restart(world_id)
            peers = [s for s in list(backend.connections) if getattr(s.state, 'stream', None)
                     and s.state.stream.identity['world_id'] == world_id]
            for socket in peers:
                socket.state.stream = None
            await backend.broadcast_lobby(world_id)
            for socket in peers:
                try:
                    async with socket.state.send_lock:
                        await socket.close(code=4000, reason='expedition restarted by Boss')
                except (RuntimeError, OSError):
                    pass
        return result

    @mcp.tool(annotations=REMOVE)
    async def admin_teleport_player(world_id: Identifier, player_id: Identifier, destination: Destination,
                                     request_id: RequestId, expected_version: Revision | None = None) -> dict[str, Any]:
        """Teleport any player to a cell, vector, lat/lon or another player. Reset movement/jump; altitude is above terrain."""
        def action(state, planet):
            player = service.player(state, player_id)
            player.position = service.destination(state, planet, destination)
            player.altitude, player.vertical_speed = destination.altitude, 0.
            player.move, player.input_tick = (0., 0., 0.), state.tick - INPUT_TIMEOUT_TICKS
            player.jump_held = player.jump_pending = player.running = False
            player.roof_building_id = player.support_building_id = player.support_surface_id = None
            return dict(player_id=player_id, position=player.position)
        return mutate(world_id, request_id, 'player.teleport', dict(player_id=player_id, destination=destination.model_dump()), expected_version, action)

    @mcp.tool(annotations=REMOVE)
    async def admin_set_player(world_id: Identifier, player_id: Identifier, edit: PlayerPatch,
                                request_id: RequestId, expected_version: Revision | None = None) -> dict[str, Any]:
        """Edit any player's color, flashlight, pitch and resource balances. Admin balances may exceed gameplay capacity."""
        def action(state, planet):
            player = service.player(state, player_id)
            for key, value in edit.model_dump(exclude_none=True).items():
                if key == 'inventory':
                    player.inventory.update(value)
                else:
                    setattr(player, key, value)
        return mutate(world_id, request_id, 'player.edit', dict(player_id=player_id, edit=edit.model_dump()), expected_version, action)

    @mcp.tool(annotations=REMOVE)
    async def admin_set_resources(world_id: Identifier, target: Literal['team', 'player', 'building', 'rover'],
                                   target_id: Identifier, resources: Stock, request_id: RequestId,
                                   expected_version: Revision | None = None) -> dict[str, Any]:
        """Set selected resource balances (0..1,000,000); omitted resources stay unchanged. Ignore gameplay capacities except rover mass."""
        def action(state, planet):
            if target == 'team':
                require(target_id in state.team_storage, 'TEAM_NOT_FOUND')
                pool = state.team_storage[target_id]
            elif target == 'player':
                pool = service.player(state, target_id).inventory
            elif target == 'building':
                b = service.building(state, target_id)
                pool = state.team_storage[b.team_id] if b.building_type == 'warehouse' else b.stock
            else:
                rover = service.rover(state, target_id)
                pool = rover['cargo']
            pool.update(resources)
            if target == 'rover':
                require(mass(rover) <= CAPACITY, 'CARGO_FULL')
            return dict(resources=deepcopy(pool))
        return mutate(world_id, request_id, 'resources.set', dict(target=target, target_id=target_id, resources=resources), expected_version, action)

    @mcp.tool(annotations=REMOVE)
    async def admin_create_building(world_id: Identifier, cell_id: Identifier, building_type: Kind,
                                     creator_id: Identifier, request_id: RequestId, completed: Annotated[bool, Field(strict=True)] = True,
                                     expected_version: Revision | None = None) -> dict[str, Any]:
        """Create a free building (including dome) for the creator's team anywhere, ignoring buildability/range/player collisions."""
        def action(state, planet):
            player = service.player(state, creator_id)
            service.check_building(state, planet, cell_id, building_type)
            b = Building(str(uuid.uuid4()), cell_id, building_type, player.team_id, creator_id)
            service.complete(b, completed)
            state.buildings[b.building_id] = b
            return dict(building_id=b.building_id)
        return mutate(world_id, request_id, 'building.create', dict(cell_id=cell_id, building_type=building_type,
                      creator_id=creator_id, completed=completed), expected_version, action)

    @mcp.tool(annotations=REMOVE)
    async def admin_edit_building(world_id: Identifier, building_id: Identifier, edit: BuildingPatch,
                                   request_id: RequestId, expected_version: Revision | None = None) -> dict[str, Any]:
        """Move/transform/transfer a building, set construction completion and stock. One building per cell; drills require deposits."""
        def action(state, planet):
            b = service.building(state, building_id)
            cell_id, kind = edit.cell_id or b.cell_id, edit.building_type or b.building_type
            service.check_building(state, planet, cell_id, kind, building_id)
            if cell_id != b.cell_id:
                state.landing_claims.pop(b.cell_id, None)
            b.cell_id, b.building_type = cell_id, kind
            if edit.creator_id is not None:
                player = service.player(state, edit.creator_id)
                b.creator_id, b.team_id = player.user_id, player.team_id
            if edit.completed is not None:
                service.complete(b, edit.completed)
            if edit.stock is not None:
                pool = state.team_storage[b.team_id] if b.building_type == 'warehouse' else b.stock
                pool.update(edit.stock)
        return mutate(world_id, request_id, 'building.edit', dict(building_id=building_id, edit=edit.model_dump()), expected_version, action)

    @mcp.tool(annotations=REMOVE)
    async def admin_remove_entity(world_id: Identifier, entity_type: Literal['building', 'rover', 'mountain'],
                                    entity_id: Identifier, request_id: RequestId,
                                    expected_version: Revision | None = None) -> dict[str, Any]:
        """Delete any team's building (including dome), rover or mountain (cell ID), without refund."""
        def remove(state, planet):
            if entity_type == 'building':
                b = service.building(state, entity_id)
                del state.buildings[entity_id]
                state.landing_claims.pop(b.cell_id, None)
                for p in state.players.values():
                    if entity_id in (p.roof_building_id, p.support_building_id):
                        p.roof_building_id = p.support_building_id = p.support_surface_id = None
            elif entity_type == 'rover':
                service.rover(state, entity_id)
                del state.rovers[entity_id]
            else:
                require(entity_id in state.mountains, 'MOUNTAIN_NOT_FOUND')
                state.mountains.remove(entity_id)
                state.map_revision += 1
        return mutate(world_id, request_id, 'entity.remove', dict(entity_type=entity_type, entity_id=entity_id), expected_version, remove)

    @mcp.tool(annotations=REMOVE)
    async def admin_create_rover(world_id: Identifier, owner_player_id: Identifier, destination: Destination,
                                  request_id: RequestId, expected_version: Revision | None = None) -> dict[str, Any]:
        """Spawn a free idle rover for any player's team anywhere, bypassing office, cost and fleet limit."""
        def action(state, planet):
            require(destination.altitude == 0, 'ROVER_MUST_BE_GROUNDED')
            p = service.player(state, owner_player_id)
            r = new_rover(p.team_id, service.destination(state, planet, destination), p.color)
            state.rovers[r['rover_id']] = r
            return dict(rover_id=r['rover_id'])
        return mutate(world_id, request_id, 'rover.create', dict(owner_player_id=owner_player_id, destination=destination.model_dump()), expected_version, action)

    @mcp.tool(annotations=REMOVE)
    async def admin_teleport_rover(world_id: Identifier, rover_id: Identifier, destination: Destination,
                                    request_id: RequestId, expected_version: Revision | None = None) -> dict[str, Any]:
        """Teleport and stop any rover, resetting its program execution pointer and error state."""
        def action(state, planet):
            require(destination.altitude == 0, 'ROVER_MUST_BE_GROUNDED')
            r = service.rover(state, rover_id)
            r.update(position=service.destination(state, planet, destination), status='idle', pc=0,
                     wait_ticks=0, speed=0., error=None, line=None)
        return mutate(world_id, request_id, 'rover.teleport', dict(rover_id=rover_id, destination=destination.model_dump()), expected_version, action)

    @mcp.tool(annotations=REMOVE)
    async def admin_edit_rover(world_id: Identifier, rover_id: Identifier, action: Literal['save', 'start', 'stop'],
                                request_id: RequestId, program: Annotated[str, Field(strict=True, max_length=512)] | None = None,
                                expected_revision: Revision | None = None,
                                expected_version: Revision | None = None) -> dict[str, Any]:
        """Save/start/stop any team's rover without office access; DSL validation and optional program revision check remain."""
        def edit(state, planet):
            r = service.rover(state, rover_id)
            require(expected_revision is None or r['program_revision'] == expected_revision, 'REVISION_CONFLICT')
            if action != 'stop':
                text = program if program is not None else r['program']
                instructions = parse(text, state.rover_points.get(r['team_id'], {}))
                r.update(program=text, instructions=instructions,
                         targets={i['value']: i['point'] for i in instructions if i['op'] == 'move_to'})
            r.update(status='running' if action == 'start' else 'idle', pc=0,
                     wait_ticks=0, speed=0., error=None, line=None)
            r['program_revision'] += 1
            return dict(program_revision=r['program_revision'])
        return mutate(world_id, request_id, 'rover.edit', dict(rover_id=rover_id, action=action,
                      program=program, expected_revision=expected_revision), expected_version, edit)

    @mcp.tool(annotations=REMOVE)
    async def admin_set_rover_point(world_id: Identifier, team_id: Identifier,
                                     name: Annotated[str, Field(strict=True, min_length=1, max_length=24)],
                                     latitude: Annotated[Number, Field(ge=-90, le=90)],
                                     longitude: Annotated[Number, Field(ge=-180, lt=180)], request_id: RequestId,
                                     expected_version: Revision | None = None) -> dict[str, Any]:
        """Create/replace a named rover navigation point for any team without survey/office requirements."""
        def action(state, planet):
            require(team_id in state.team_storage, 'TEAM_NOT_FOUND')
            require(NAME.fullmatch(name) is not None, 'INVALID_POINT_NAME')
            require(abs(latitude) != 90 or longitude == 0, 'INVALID_COORDINATES')
            points = state.rover_points.setdefault(team_id, {})
            points[name] = dict(name=name, latitude=latitude, longitude=longitude, author='boss',
                                version=points.get(name, {}).get('version', 0)+1)
        return mutate(world_id, request_id, 'rover.point.set', dict(team_id=team_id, name=name,
                      latitude=latitude, longitude=longitude), expected_version, action)

    @mcp.tool(annotations=REMOVE)
    async def admin_edit_cells(world_id: Identifier, edits: Annotated[list[CellPatch], Field(min_length=1, max_length=100)],
                                request_id: RequestId, expected_version: Revision | None = None) -> dict[str, Any]:
        """Atomically edit per-world terrain labels, buildability, deposits and mountains. Explicit resource:null clears deposit."""
        def action(state, planet):
            require(len({e.cell_id for e in edits}) == len(edits), 'DUPLICATE_CELL')
            for edit in edits:
                require(edit.cell_id in planet.cells, 'CELL_NOT_FOUND')
                patch = edit.model_dump(exclude_unset=True)
                patch.pop('cell_id')
                require(all(v is not None for k, v in patch.items() if k != 'resource'), 'INVALID_ARGUMENT')
                if edit.mountain is True:
                    require(not any(b.cell_id == edit.cell_id for b in state.buildings.values()), 'CELL_OCCUPIED')
                    if edit.cell_id not in state.mountains:
                        state.mountains.append(edit.cell_id)
                elif edit.mountain is False and edit.cell_id in state.mountains:
                    state.mountains.remove(edit.cell_id)
                patch.pop('mountain', None)
                if 'resource' in patch and patch['resource'] is None:
                    require(not any(b.cell_id == edit.cell_id and b.building_type == 'drill'
                                    for b in state.buildings.values()), 'DRILL_REQUIRES_DEPOSIT')
                if patch:
                    state.cell_overrides.setdefault(edit.cell_id, {}).update(patch)
            state.map_revision += 1
            return dict(edited=len(edits))
        return mutate(world_id, request_id, 'cells.edit', [e.model_dump(exclude_unset=True) for e in edits], expected_version, action)

    @mcp.tool(annotations=REMOVE)
    async def admin_set_characters(world_id: Identifier, profiles: Annotated[list[Character], Field(min_length=1, max_length=20)],
                                    active_character: Identifier, request_id: RequestId,
                                    expected_version: Revision | None = None) -> dict[str, Any]:
        """Set existing in-game assistant profiles/prompts and active character. Boss MCP credentials are never passed to characters."""
        def action(state, planet):
            ids = [c.id for c in profiles]
            require(len(set(ids)) == len(ids) and active_character in ids, 'INVALID_CHARACTER')
            state.admin_characters = [c.model_dump() for c in profiles]
            state.admin_active_character = active_character
        return mutate(world_id, request_id, 'characters.set', dict(profiles=[c.model_dump() for c in profiles],
                      active_character=active_character), expected_version, action)

    return mcp
