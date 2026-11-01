"""Exercise the actual Streamable HTTP transport and authoritative mutations."""
import uuid

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from app import main
from app.game.state import Building, RESOURCES
from app.world.geometry import surface_distance, move_on_surface, unit, cross
from test_server import client, register, ORIGIN

HEADERS = {'accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25'}


def rpc(client, token, method, params=None):
    return client.post('/mcp/', headers={**HEADERS, 'authorization': f'Bearer {token}'},
                       json={'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}})


def call(client, token, name, **arguments):
    response = rpc(client, token, 'tools/call', {'name': name, 'arguments': arguments})
    assert response.status_code == 200, response.text
    result = response.json()['result']
    if result.get('isError'):
        return result
    return result['structuredContent']


def prepare(identity):
    main.app.state.game.join(identity)
    runtime = main.app.state.game.runtime(identity)
    with runtime.transaction() as state:
        state.stage = 'running'
    return runtime


def test_mcp_lifespan_discovery_auth_and_revocation(client):
    assert client.post('/mcp/', json={}).status_code == 401
    identity, token = register(client, 'mcp_auth')
    # Cookie alone is deliberately insufficient, including for discovery.
    assert client.post('/mcp/', json={}).status_code == 401
    headers = {**HEADERS, 'authorization': f'Bearer {token}', 'origin': 'http://evil.example'}
    assert client.post('/mcp/', headers=headers, json={}).status_code == 403
    response = rpc(client, token, 'initialize', {
        'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'test', 'version': '1'}})
    assert response.status_code == 200
    assert response.json()['result']['serverInfo']['name'] == 'Mars Colony'
    assert response.headers['cache-control'] == 'no-store'
    listing = rpc(client, token, 'tools/list').json()['result']['tools']
    tools = {item['name']: item for item in listing}
    assert len(tools) == 13
    assert tools['get_world']['annotations']['readOnlyHint']
    assert tools['remove_building']['annotations']['destructiveHint']
    assert tools['place_building']['annotations']['idempotentHint']
    assert 'ctx' not in tools['place_building']['inputSchema']['properties']
    assert call(client, token, 'get_world')['isError']  # Must join through the game first.
    assert not main.app.state.game.runtime(identity).state.players
    prepare(identity)
    assert call(client, token, 'get_world')['self_id'] == identity['user_id']
    assert client.post('/api/auth/logout', headers={'origin': ORIGIN}).status_code == 204
    assert rpc(client, token, 'tools/list').status_code == 401


def test_mcp_building_rules_retries_pause_and_restart(client):
    identity, token = register(client, 'mcp_builder')
    runtime = prepare(identity)
    near = call(client, token, 'get_nearby_cells')['cells']
    assert near and all(cell['distance'] <= 4.5 for cell in near)
    cell = next(cell for cell in near if cell['buildable'] and cell['distance'] > 1.1)
    arguments = dict(cell_id=cell['cell_id'], building_type='solar_panel', request_id=str(uuid.uuid4()))
    before = runtime.state.team_storage[identity['team_id']]['iron']
    built = call(client, token, 'place_building', **arguments)
    assert built['payload']['ok']
    assert call(client, token, 'place_building', **arguments) == built
    assert runtime.state.team_storage[identity['team_id']]['iron'] == before - 5
    conflict = call(client, token, 'place_building', **{**arguments, 'building_type': 'warehouse'})
    assert conflict['payload']['code'] == 'REQUEST_CONFLICT'
    occupied = call(client, token, 'place_building', **{**arguments, 'request_id': str(uuid.uuid4())})
    assert occupied['payload']['code'] == 'CELL_OCCUPIED'
    far = next(c for c in runtime.planet.cells.values() if c.buildable and surface_distance(
        runtime.state.players[identity['user_id']].position, c.center, runtime.planet.radius) > 10)
    assert call(client, token, 'place_building', cell_id=far.cell_id, building_type='solar_panel',
                request_id=str(uuid.uuid4()))['payload']['code'] == 'OUT_OF_RANGE'
    with runtime.transaction() as state:
        state.team_storage[identity['team_id']] = dict.fromkeys(RESOURCES, 0)
    other = next(c for c in near if c['buildable'] and c['distance'] > 1.1 and c != cell)
    assert call(client, token, 'place_building', cell_id=other['cell_id'], building_type='solar_panel',
                request_id=str(uuid.uuid4()))['payload']['code'] == 'INSUFFICIENT_RESOURCES'
    with runtime.transaction() as state:
        state.admin_paused = True
    assert 'WORLD_PAUSED' in str(call(client, token, 'remove_building', building_id=built['payload']['building_id'],
                                    request_id=str(uuid.uuid4())))
    assert call(client, token, 'get_world')['paused']
    with runtime.transaction() as state:
        state.admin_paused = False
        center = runtime.planet.cells[cell['cell_id']].center
        state.players[identity['user_id']].position = move_on_surface(
            center, unit(cross(center, (0, 1, 0))), 1.2, runtime.planet.radius)
    assert call(client, token, 'remove_building', building_id=built['payload']['building_id'],
                request_id=str(uuid.uuid4()))['payload']['ok']
    # Persisted receipts still suppress a repeat after reconstructing the runtime.
    main.app.state.game_writer.flush()
    main.app.state.game.worlds.clear()
    assert call(client, token, 'place_building', **arguments) == built
    assert built['payload']['building_id'] not in main.app.state.game.runtime(identity).state.buildings


def test_mcp_private_data_ownership_and_resource_validation(client):
    alice, a_token = register(client, 'mcp_alice')
    bob, b_token = register(client, 'mcp_bob')
    with main.db.connect() as db:
        db.execute("INSERT INTO teams(id, world_id, name) VALUES ('enemy', 'demo-world', 'Enemy')")
        db.execute("UPDATE team_members SET team_id='enemy' WHERE user_id=?", (bob['user_id'],))
    bob = main.db.identity(b_token)
    runtime = prepare(alice)
    assert call(client, a_token, 'purchase_rover', request_id=str(uuid.uuid4()))['payload']['code'] == 'OFFICE_REQUIRED'
    prepare(bob)
    near = call(client, a_token, 'get_nearby_cells')['cells']
    cell_id = near[-1]['cell_id']
    with runtime.transaction() as state:
        state.buildings['enemy-building'] = Building('enemy-building', cell_id, 'warehouse', 'enemy', bob['user_id'])
        state.buildings['base'] = Building('base', cell_id, 'dome_base', alice['team_id'], alice['user_id'])
        state.players[bob['user_id']].inventory['iron'] = 37
    view = call(client, a_token, 'get_world')
    assert 'inventory' not in next(p for p in view['players'] if p['player_id'] == alice['user_id'])
    assert 'stock' not in next(b for b in view['buildings'] if b['building_id'] == 'enemy-building')
    assert view['team_id'] == alice['team_id']
    for name in ('remove_building', 'pickup_resource'):
        extra = {} if name == 'remove_building' else {'resource': 'iron', 'amount': 1}
        result = call(client, a_token, name, building_id='enemy-building', request_id=str(uuid.uuid4()), **extra)
        assert result['payload']['code'] == 'FORBIDDEN'
    assert call(client, a_token, 'remove_building', building_id='base', request_id=str(uuid.uuid4()))['payload']['code'] == 'FORBIDDEN'
    for amount in (-1, 0, 51, True, 1.5, '1'):
        assert call(client, a_token, 'pickup_resource', building_id='base', resource='iron', amount=amount,
                    request_id=str(uuid.uuid4()))['isError']
    for name, args in [('place_building', {'building_type': 'dome_base', 'cell_id': cell_id}),
                       ('program_rover', {'rover_id': 'unknown', 'program': 'x' * 513, 'expected_revision': 0}),
                       ('world.restart', {})]:
        assert call(client, a_token, name, request_id=str(uuid.uuid4()), **args)['isError']
    with runtime.transaction() as state:
        state.team_storage[alice['team_id']] = dict.fromkeys(RESOURCES, 0)
    assert call(client, a_token, 'purchase_rover', request_id=str(uuid.uuid4()))['payload']['code'] == 'INSUFFICIENT_RESOURCES'


def test_official_sdk_client(client):
    """Full SDK handshake, listing and call against the mounted ASGI server."""
    identity, token = register(client, 'mcp_sdk')
    prepare(identity)

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                     base_url='http://localhost:8000',
                                     headers={'authorization': f'Bearer {token}'}) as http:
            async with streamable_http_client('http://localhost:8000/mcp/', http_client=http) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    assert len((await session.list_tools()).tools) == 13
                    result = await session.call_tool('get_world', {})
                    assert not result.isError
                    assert result.structuredContent['self_id'] == identity['user_id']
    client.portal.call(run)


def test_mcp_resource_capacity_and_rover_programs(client):
    from app.game.rover import ensure_start
    identity, token = register(client, 'mcp_rover')
    runtime = prepare(identity)
    with runtime.transaction() as state:
        ensure_start(state, runtime.planet)
        state.team_storage[identity['team_id']]['iron'] = 80
        base = next(b for b in state.buildings.values() if b.building_type == 'dome_base')
        center = runtime.planet.cells[base.cell_id].center
        state.players[identity['user_id']].position = move_on_surface(
            center, unit(cross(center, (0, 1, 0))), 1.1, runtime.planet.radius)
        base.stock['iron'] = 50
    args = dict(building_id=base.building_id, resource='iron', amount=50, request_id=str(uuid.uuid4()))
    assert call(client, token, 'pickup_resource', **args)['payload']['ok']
    assert call(client, token, 'pickup_resource', **args)['payload']['ok']
    assert runtime.state.players[identity['user_id']].inventory['iron'] == 50
    with runtime.transaction() as state:
        state.buildings[base.building_id].stock['iron'] = 1
    assert call(client, token, 'pickup_resource', **{**args, 'amount': 1, 'request_id': str(uuid.uuid4())})['payload']['code'] == 'INVENTORY_FULL'
    assert call(client, token, 'deposit_resource', **{**args, 'request_id': str(uuid.uuid4())})['payload']['code'] == 'INVENTORY_FULL'
    assert call(client, token, 'deposit_resource', **{**args, 'amount': 49, 'request_id': str(uuid.uuid4())})['payload']['ok']
    rover_id = next(iter(runtime.state.rovers))
    with runtime.transaction() as state:
        state.rovers[rover_id]['status'] = 'idle'
    current = runtime.state.rovers[rover_id]['program_revision']
    def program(text, revision=current):
        return call(client, token, 'program_rover', rover_id=rover_id, program=text,
                    expected_revision=revision, request_id=str(uuid.uuid4()))['payload']
    assert not program('import os')['ok']
    assert program('wait(1)')['ok']
    assert program('wait(1)')['code'] == 'REVISION_CONFLICT'
    assert call(client, token, 'start_rover', rover_id=rover_id, expected_revision=current + 1,
                request_id=str(uuid.uuid4()))['payload']['ok']
    assert program('wait(2)', current + 2)['code'] == 'ROVER_RUNNING'
    assert call(client, token, 'stop_rover', rover_id=rover_id, request_id=str(uuid.uuid4()))['payload']['ok']
    assert runtime.state.rovers[rover_id]['status'] == 'idle'


def test_mcp_body_limit_and_session_identity_cannot_be_overridden(client):
    identity, token = register(client, 'mcp_limits')
    prepare(identity)
    assert call(client, token, 'get_world', user_id='someone-else', team_id='enemy', world_id='other')['self_id'] == identity['user_id']
    response = rpc(client, token, 'tools/call', {'name': 'program_rover', 'arguments': {'program': 'x' * 17000}})
    assert response.status_code == 413
