"""Boss tools through the actual MCP transport, including persistence and streams."""
import uuid

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
import pytest

from app import main
from app.game import step
from app.game.rover import mass
from app.transport import Stream, byte_size
from app.world.geometry import surface_distance
from app.world.terrain import terrain_height, seed_from_world_id
from test_server import client, register, ORIGIN

HEADERS = {'accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25'}


def rpc(client, method, params=None, token=None):
    return client.post('/mcp/admin/', headers={**HEADERS, 'authorization': 'Bearer '+(
        token if token is not None else main.app.state.admin_key)},
        json={'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}})


def call(client, tool_name, **arguments):
    response = rpc(client, 'tools/call', {'name': tool_name, 'arguments': arguments})
    assert response.status_code == 200, response.text
    result = response.json()['result']
    return result if result.get('isError') else result['structuredContent']


def edit(client, tool_name, world_id='demo-world', **arguments):
    arguments.setdefault('request_id', str(uuid.uuid4()))
    return call(client, tool_name, world_id=world_id, **arguments)


def join(client, username='boss_player'):
    identity, token = register(client, username)
    main.app.state.game.join(identity)
    return identity, token, main.app.state.game.runtime(identity)


def cells(runtime, count=3):
    occupied = {b.cell_id for b in runtime.state.buildings.values()} | set(runtime.state.mountains)
    return [c.cell_id for c in runtime.planet.cells.values()
            if c.buildable and c.cell_id not in occupied][:count]


def enemy(client):
    identity, token = register(client, 'boss_enemy')
    with main.db.connect() as db:
        db.execute("INSERT INTO teams(id,world_id,name) VALUES ('enemy','demo-world','Enemy')")
        db.execute("UPDATE team_members SET team_id='enemy' WHERE user_id=?", (identity['user_id'],))
    identity = main.db.identity(token)
    main.app.state.game.join(identity)
    return identity


def test_admin_auth_discovery_and_sdk(client):
    assert client.post('/mcp/admin/', json={}).status_code == 401
    actor, token, runtime = join(client)
    assert rpc(client, 'tools/list', token=token).status_code == 401
    assert client.post('/mcp/', headers={**HEADERS, 'authorization': 'Bearer '+main.app.state.admin_key}, json={}).status_code == 401
    response = client.post('/mcp/admin/', headers={**HEADERS, 'authorization': 'Bearer '+main.app.state.admin_key,
                           'origin': 'http://evil.example'}, json={})
    assert response.status_code == 403
    listing = rpc(client, 'tools/list')
    assert listing.headers['cache-control'] == 'no-store'
    tools = {t['name']: t for t in listing.json()['result']['tools']}
    assert len(tools) == 17
    assert tools['admin_get_world']['annotations']['readOnlyHint']
    assert tools['admin_restart_world']['annotations']['destructiveHint']
    assert tools['admin_create_building']['annotations']['idempotentHint']
    assert call(client, 'admin_get_overview')['worlds'][0]['id'] == actor['world_id']
    assert call(client, 'admin_get_world', world_id='missing')['isError']
    assert 'admin_key' not in str(call(client, 'admin_get_world', world_id=actor['world_id']))

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url=ORIGIN,
                                     headers={'authorization': 'Bearer '+main.app.state.admin_key}) as http:
            async with streamable_http_client(ORIGIN+'/mcp/admin/', http_client=http) as (read, write, _):
                async with ClientSession(read, write) as session:
                    initialized = await session.initialize()
                    assert initialized.serverInfo.name == 'Mars Colony Boss'
                    assert len((await session.list_tools()).tools) == 17
                    result = await session.call_tool('admin_get_world', {'world_id': actor['world_id']})
                    assert not result.isError
                    assert result.structuredContent['players'][0]['user_id'] == actor['user_id']
    client.portal.call(run)
    old = main.app.state.admin_key
    main.app.state.admin_key = 'replacement-key-with-enough-entropy'
    assert rpc(client, 'tools/list', token=old).status_code == 401


def test_no_player_session_or_enrollment_required(client):
    assert call(client, 'admin_get_world', world_id='demo-world')['players'] == []
    assert edit(client, 'admin_set_world', edit={'paused': True, 'oxygen_percent': 25})['ok']
    assert edit(client, 'admin_set_world', edit={'stage': 'running'})['code'] == 'PLAYERS_REQUIRED'
    assert not main.app.state.game.runtime({'world_id': 'demo-world'}).state.players


def test_teleport_any_player_while_paused_and_reset_motion(client):
    alice, _, runtime = join(client)
    bob = enemy(client)
    assert edit(client, 'admin_set_world', edit={'paused': True})['ok']
    with runtime.transaction() as state:
        p = state.players[bob['user_id']]
        p.move = (1., 0., 0.)
        p.input_tick = state.tick
        p.running = p.jump_held = p.jump_pending = True
        p.vertical_speed = 4.
        p.support_building_id = 'stale'
    for destination in ({'cell_id': cells(runtime)[0]}, {'position': [1, 2, 3]},
                        {'latitude': 90, 'longitude': 0, 'altitude': 5}, {'player_id': alice['user_id']}):
        result = edit(client, 'admin_teleport_player', player_id=bob['user_id'], destination=destination)
        assert result['ok']
        p = runtime.state.players[bob['user_id']]
        assert not any(p.move) and not p.running and not p.jump_pending and p.vertical_speed == 0
        assert p.support_building_id is None
        expected = runtime.planet.radius + terrain_height(p.position, seed_from_world_id(alice['world_id'])) + destination.get('altitude', 0)
        assert sum(v*v for v in p.position)**.5 == pytest.approx(expected)
    view = main.app.state.game.dto(bob)
    assert surface_distance(view['players'][0]['position'], p.position, runtime.planet.radius) < 1e-5
    for invalid in ({'position': [0, 0, 0]}, {'position': [1, 2]}, {'latitude': 91, 'longitude': 0},
                    {'cell_id': 'x', 'position': [1, 0, 0]}, {'latitude': 0}, {'position': [True, 0, 1]}):
        assert edit(client, 'admin_teleport_player', player_id=bob['user_id'], destination=invalid)['isError']
    assert edit(client, 'admin_teleport_player', player_id=bob['user_id'], destination={'cell_id': 'missing'})['code'] == 'CELL_NOT_FOUND'


def test_versions_retries_and_persistent_receipts(client):
    actor, _, runtime = join(client)
    req = str(uuid.uuid4())
    args = dict(edit={'paused': True, 'oxygen_percent': 34}, expected_version=0, request_id=req)
    first = edit(client, 'admin_set_world', **args)
    assert first['ok'] and first['version'] == 1
    assert edit(client, 'admin_set_world', **args) == first
    assert len(runtime.state.admin_audit) == 1
    assert edit(client, 'admin_set_world', **{**args, 'edit': {'paused': False}})['code'] == 'REQUEST_CONFLICT'
    assert edit(client, 'admin_set_world', edit={'paused': False}, expected_version=0)['code'] == 'VERSION_CONFLICT'
    assert runtime.state.admin_paused
    main.app.state.game_writer.flush()
    main.app.state.game.worlds.clear()
    assert edit(client, 'admin_set_world', **args) == first
    assert call(client, 'admin_get_world', world_id=actor['world_id'])['audit'][0]['request_id'] == req


def test_entity_creation_transform_removal_and_private_resources(client):
    actor, _, runtime = join(client)
    bob = enemy(client)
    a, b, c = cells(runtime)
    request_id = str(uuid.uuid4())
    args = dict(cell_id=a, building_type='solar_panel', creator_id=bob['user_id'], request_id=request_id)
    before = runtime.state.team_storage
    created = edit(client, 'admin_create_building', **args)
    assert created['ok']
    building_id = created['building_id']
    assert edit(client, 'admin_create_building', **args) == created
    assert runtime.state.team_storage == before
    assert runtime.state.buildings[building_id].team_id == 'enemy'
    assert edit(client, 'admin_edit_building', building_id=building_id,
                edit={'cell_id': b, 'building_type': 'warehouse', 'creator_id': actor['user_id'], 'completed': False})['ok']
    built = runtime.state.buildings[building_id]
    assert built.cell_id == b and built.team_id == actor['team_id'] and built.construction_status == 'planned'
    assert edit(client, 'admin_set_resources', target='building', target_id=building_id, resources={'iron': 1000})['ok']
    assert runtime.state.team_storage[actor['team_id']]['iron'] == 1000
    assert edit(client, 'admin_set_player', player_id=bob['user_id'], edit={'inventory': {'water': 300}, 'color': '#42b8ff'})['ok']
    assert edit(client, 'admin_set_resources', target='player', target_id=bob['user_id'], resources={'iron': 999})['ok']
    assert edit(client, 'admin_set_resources', target='team', target_id='enemy', resources={'oxygen': 700})['ok']
    full = call(client, 'admin_get_world', world_id=actor['world_id'])
    assert next(p for p in full['players'] if p['user_id'] == bob['user_id'])['inventory']['iron'] == 999
    assert full['team_storage']['enemy']['oxygen'] == 700
    assert edit(client, 'admin_create_building', cell_id=b, building_type='warehouse', creator_id=actor['user_id'])['code'] == 'CELL_OCCUPIED'
    assert edit(client, 'admin_remove_entity', entity_type='building', entity_id=building_id)['ok']
    assert building_id not in runtime.state.buildings
    # Landing dome deletion must survive the runtime's start-up repair.
    assert edit(client, 'admin_set_world', edit={'stage': 'running', 'paused': True})['ok']
    dome = next(b for b in runtime.state.buildings.values() if b.building_type == 'dome_base')
    assert edit(client, 'admin_remove_entity', entity_type='building', entity_id=dome.building_id)['ok']
    main.app.state.game_writer.flush()
    main.app.state.game.worlds.clear()
    restored = main.app.state.game.runtime(actor).state
    assert not any(b.cell_id == dome.cell_id for b in restored.buildings.values())
    for amount in (-1, True, '1', 1.5, 1000001):
        assert edit(client, 'admin_set_resources', target='team', target_id=actor['team_id'], resources={'iron': amount})['isError']


def test_rover_control_any_team_program_points_and_atomic_cargo(client):
    actor, _, runtime = join(client)
    bob = enemy(client)
    created = edit(client, 'admin_create_rover', owner_player_id=bob['user_id'], destination={'cell_id': cells(runtime)[0]})
    rover_id = created['rover_id']
    assert runtime.state.rovers[rover_id]['team_id'] == 'enemy'
    assert edit(client, 'admin_set_rover_point', team_id='enemy', name='target', latitude=12.34, longitude=-56.78)['ok']
    args = dict(rover_id=rover_id, action='start', program='move_to(target)', expected_revision=0)
    assert edit(client, 'admin_edit_rover', **args)['ok']
    assert edit(client, 'admin_edit_rover', **args)['code'] == 'REVISION_CONFLICT'
    assert edit(client, 'admin_edit_rover', rover_id=rover_id, action='stop')['ok']
    before = runtime.state
    assert edit(client, 'admin_edit_rover', rover_id=rover_id, action='start', program='import os')['isError']
    assert runtime.state == before
    assert edit(client, 'admin_set_resources', target='rover', target_id=rover_id, resources={'copper': 10})['ok']
    before = runtime.state
    assert edit(client, 'admin_set_resources', target='rover', target_id=rover_id, resources={'copper': 100})['code'] == 'CARGO_FULL'
    assert runtime.state == before
    assert mass(runtime.state.rovers[rover_id]) == 15
    assert edit(client, 'admin_teleport_rover', rover_id=rover_id, destination={'latitude': -20, 'longitude': 35})['ok']
    assert runtime.state.rovers[rover_id]['status'] == 'idle'
    assert edit(client, 'admin_remove_entity', entity_type='rover', entity_id=rover_id)['ok']
    assert rover_id not in runtime.state.rovers


def test_cell_edits_isolated_persisted_and_used_by_gameplay(client):
    actor, token, runtime = join(client)
    a, b, _ = cells(runtime)
    original = main.app.state.game.planet.cells[a]
    assert edit(client, 'admin_edit_cells', edits=[{'cell_id': a, 'resource': 'copper', 'buildable': False},
                                                 {'cell_id': b, 'mountain': True}])['ok']
    assert runtime.planet.cells[a].resource == 'copper' and not runtime.planet.cells[a].buildable
    assert main.app.state.game.planet.cells[a] == original
    assert b in runtime.state.mountains
    all_cells = call(client, 'admin_get_cells', world_id=actor['world_id'], limit=200)
    assert all_cells['total'] > 200 and all_cells['next_offset'] == 200
    assert next(c for c in all_cells['cells'] if c['cell_id'] == a)['resource'] == 'copper'
    # A failed batch must also roll back earlier edits in the same request.
    before = runtime.state
    assert edit(client, 'admin_edit_cells', edits=[{'cell_id': a, 'resource': 'water'}, {'cell_id': 'missing', 'mountain': True}])['code'] == 'CELL_NOT_FOUND'
    assert runtime.state == before
    assert edit(client, 'admin_create_building', cell_id=a, building_type='drill', creator_id=actor['user_id'])['ok']
    assert edit(client, 'admin_edit_cells', edits=[{'cell_id': a, 'resource': None}])['code'] == 'DRILL_REQUIRES_DEPOSIT'
    assert edit(client, 'admin_edit_cells', edits=[{'cell_id': a, 'mountain': True}])['code'] == 'CELL_OCCUPIED'
    assert edit(client, 'admin_set_world', edit={'stage': 'running', 'paused': True})['ok']
    with runtime.transaction() as state:
        drill = next(b for b in state.buildings.values() if b.cell_id == a)
        drill.production_ticks = 20
        step(state, .05, runtime.planet)
    assert next(b for b in runtime.state.buildings.values() if b.cell_id == a).stock['copper'] == 1
    main.app.state.game_writer.flush()
    main.app.state.game.worlds.clear()
    assert main.app.state.game.runtime(actor).planet.cells[a].resource == 'copper'
    with main.db.connect() as db:
        db.execute("INSERT INTO worlds(id,map_version,stage) VALUES ('separate','pending','lobby')")
    other = main.app.state.game.runtime({'world_id': 'separate'})
    assert other.planet.cells[a] == original
    assert b not in other.state.mountains


def test_live_stream_refreshes_edited_chunks_and_byte_sizes(client):
    actor, _, runtime = join(client)
    stream = Stream(main.app.state.game, actor)

    class Socket:
        def __init__(self):
            self.messages = []

        async def send_json(self, message):
            self.messages.append(message)

    socket = Socket()
    client.portal.call(stream.chunks, socket)
    assert stream.offered
    chunk_id = next(iter(stream.offered))
    cell_id = stream.offered[chunk_id]['cells'][0]['cell_id']
    old_offer = stream.offer_ids[chunk_id]
    assert edit(client, 'admin_edit_cells', edits=[{'cell_id': cell_id, 'resource': 'copper', 'buildable': False}])['ok']
    socket.messages.clear()
    client.portal.call(stream.chunks, socket)
    assert stream.offer_ids[chunk_id] > old_offer
    assert any(m['type'] == 'chunk.unload' and m['payload']['chunk_id'] == chunk_id for m in socket.messages)
    changed = next(c for c in stream.offered[chunk_id]['cells'] if c['cell_id'] == cell_id)
    assert changed['resource'] == 'copper' and not changed['buildable']
    offer = next(m['payload'] for m in socket.messages if m['type'] == 'chunk.offer' and m['payload']['chunk_id'] == chunk_id)
    assert offer['byte_size'] == byte_size(stream.offered[chunk_id])
    socket.messages.clear()
    client.portal.call(stream.chunk_request, socket, {'chunk_id': chunk_id, 'offer_id': old_offer})
    assert not socket.messages


def test_restart_cross_team_resets_overlay_and_replay_has_no_lobby_side_effect(client):
    actor, _, runtime = join(client)
    enemy(client)
    assert edit(client, 'admin_set_world', edit={'stage': 'running', 'paused': True, 'oxygen_percent': 65})['ok']
    assert edit(client, 'admin_edit_cells', edits=[{'cell_id': cells(runtime)[0], 'resource': 'water'}])['ok']
    request_id = str(uuid.uuid4())
    result = edit(client, 'admin_restart_world', request_id=request_id)
    assert result['ok'] and result['generation'] == 1
    state = runtime.state
    assert state.stage == 'lobby' and state.tick == 0 and state.oxygen_percent == 0
    assert not state.buildings and not state.rovers and not state.cell_overrides
    assert len(state.players) == 2
    assert len({p.team_id for p in state.players.values()}) == 2
    assert main.app.state.lobby.stage(actor['world_id']) == 'lobby'
    assert edit(client, 'admin_set_world', edit={'stage': 'running'})['ok']
    assert edit(client, 'admin_restart_world', request_id=request_id) == result
    assert runtime.state.stage == 'running'
    assert main.app.state.lobby.stage(actor['world_id']) == 'running'


def test_character_config_and_body_validation(client):
    actor, _, runtime = join(client)
    profiles = [dict(id='boss', name='Босс', prompt='Управляй колонией.', enabled=True, temperature=.2)]
    assert edit(client, 'admin_set_characters', profiles=profiles, active_character='boss')['ok']
    assert runtime.state.admin_active_character == 'boss'
    assert 'Управляй колонией.' not in str(main.app.state.game.dto(actor))
    assert edit(client, 'admin_set_characters', profiles=profiles*2, active_character='boss')['code'] == 'INVALID_CHARACTER'
    assert edit(client, 'admin_set_player', player_id=actor['user_id'], edit={'team_id': 'enemy'})['isError']
    assert edit(client, 'admin_edit_cells', edits=[{'cell_id': cells(runtime)[0], 'buildable': None}])['code'] == 'INVALID_ARGUMENT'
    response = rpc(client, 'tools/call', {'name': 'admin_set_characters', 'arguments': {'profiles': 'x'*66000}})
    assert response.status_code == 413


def test_cell_edit_triggers_offer_while_paused(client):
    actor, _, runtime = join(client)
    assert edit(client, 'admin_set_world', edit={'paused': True})['ok']
    stream = Stream(main.app.state.game, actor)

    class Socket:
        def __init__(self):
            self.messages = []

        async def send_json(self, message):
            self.messages.append(message)

    socket = Socket()
    client.portal.call(stream.offer, socket)
    client.portal.call(stream.accept, socket)
    chunk_id = next(iter(stream.offered))
    cell_id = stream.offered[chunk_id]['cells'][0]['cell_id']
    before = stream.last['map_revision']
    assert edit(client, 'admin_edit_cells', edits=[{'cell_id': cell_id, 'buildable': not runtime.planet.cells[cell_id].buildable}])['ok']
    socket.messages.clear()
    client.portal.call(stream.offer, socket)
    assert socket.messages[0]['type'] == 'world.offer'
    client.portal.call(stream.accept, socket)
    assert stream.last['map_revision'] > before
    assert any(m['type'] == 'chunk.unload' and m['payload']['chunk_id'] == chunk_id for m in socket.messages)


def test_failed_persistence_publishes_neither_edit_nor_receipt(client, monkeypatch):
    actor, _, runtime = join(client)
    before = runtime.state

    def fail(draft):
        raise OSError('persistence unavailable')

    monkeypatch.setattr(runtime, '_persist', fail)
    result = edit(client, 'admin_set_player', player_id=actor['user_id'], edit={'inventory': {'iron': 123}})
    assert result['isError']
    assert runtime.state == before


def test_boss_start_and_restart_with_live_websocket(client):
    from starlette.websockets import WebSocketDisconnect
    actor, token = register(client, 'boss_live')
    headers = {'origin': ORIGIN, 'cookie': 'mars_session='+token}
    with client.websocket_connect('/ws', headers=headers) as ws:
        assert ws.receive_json()['type'] == 'session.ready'
        ws.send_json({'type': 'world.subscribe', 'payload': {}})
        # Subscribing produces an offer and lobby state, without requiring an accept.
        for _ in range(2):
            ws.receive_json()
        assert edit(client, 'admin_set_world', edit={'stage': 'running', 'paused': True})['ok']
        assert main.app.state.lobby.stage(actor['world_id']) == 'running'
        assert edit(client, 'admin_restart_world')['ok']
        with pytest.raises(WebSocketDisconnect) as closed:
            while True:
                ws.receive_json()
        assert closed.value.code == 4000
    with client.websocket_connect('/ws', headers=headers) as ws:
        assert ws.receive_json()['type'] == 'session.ready'
        ws.send_json({'type': 'world.subscribe', 'payload': {}})
        received = [ws.receive_json(), ws.receive_json()]
        assert any(m['type'] == 'world.offer' for m in received)
        assert main.app.state.game.runtime(actor).state.stage == 'lobby'
