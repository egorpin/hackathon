import concurrent.futures
import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from websockets.sync.client import connect

from app import main
from app.storage import Database
from app.game.state import Building, STARTING_RESOURCES
from app.world.geometry import cross, move_on_surface, unit

ORIGIN = "http://localhost:8000"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "db", Database(tmp_path / "test.sqlite3"))
    with TestClient(main.app) as client:
        yield client


def register(client, username):
    result = client.post("/api/auth/register", headers={"origin": ORIGIN},
                         json={"username": username, "password": "longpassword"})
    assert result.status_code == 201
    return result.json(), client.cookies.get("mars_session")


def test_authentication_and_restart(client):
    assert client.get("/api/auth/me").status_code == 401
    assert client.post("/api/auth/register", json={"username": "alice", "password": "longpassword"}).status_code == 403
    identity, token = register(client, "alice")
    assert client.get("/api/auth/me").json() == identity
    assert client.cookies.get("mars_session") == token
    main.db.initialize()
    assert main.db.identity(token) == identity
    assert client.post("/api/auth/register", headers={"origin": ORIGIN},
                       json={"username": "ALICE", "password": "longpassword"}).status_code == 409
    assert client.post("/api/auth/logout", headers={"origin": ORIGIN}).status_code == 204
    assert main.db.identity(token) is None
    assert client.post("/api/auth/login", headers={"origin": ORIGIN},
                       json={"username": "alice", "password": "wrongpassword"}).status_code == 401
    assert client.post("/api/auth/login", headers={"origin": ORIGIN},
                       json={"username": "ALICE", "password": "longpassword"}).json() == identity
    with main.db.connect() as db:
        assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert db.execute("SELECT token_hash FROM sessions").fetchone()[0] != token


def test_websocket_rejects_anonymous_and_wrong_origin(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers={"origin": ORIGIN}):
            pass
    register(client, "alice")
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers={"origin": "http://evil.example"}):
            pass


def test_lan_same_origin_auth_and_websocket(client):
    lan_origin = "http://192.168.50.10:8000"
    headers = {"host": "192.168.50.10:8000", "origin": lan_origin}
    response = client.post("/api/auth/register", headers=headers,
                           json={"username": "lan_player", "password": "longpassword"})
    assert response.status_code == 201
    token = response.cookies["mars_session"]
    with client.websocket_connect("/ws", headers={**headers, "cookie": f"mars_session={token}"}) as ws:
        assert ws.receive_json()["type"] == "session.ready"
    assert client.post("/api/auth/login", headers={**headers, "origin": "http://evil.example"},
                       json={"username": "lan_player", "password": "longpassword"}).status_code == 403


def test_team_chat_idempotency_and_isolation(client):
    alice, alice_token = register(client, "alice")
    bob, bob_token = register(client, "bob")
    with main.db.connect() as db:
        db.execute("INSERT INTO teams(id, world_id, name) VALUES ('other-team', 'demo-world', 'Other')")
        db.execute("UPDATE team_members SET team_id='other-team' WHERE user_id=?", (bob["user_id"],))
    def headers(token):
        return {"origin": ORIGIN, "cookie": f"mars_session={token}"}
    with client.websocket_connect("/ws", headers=headers(alice_token)) as a, \
         client.websocket_connect("/ws", headers=headers(bob_token)) as b:
        assert a.receive_json()["payload"]["team_id"] == alice["team_id"]
        assert b.receive_json()["payload"]["team_id"] == "other-team"
        request_id = str(uuid.uuid4())
        command = {"type": "chat.send", "request_id": request_id, "payload": {"text": "hello"}}
        a.send_json(command)
        result = a.receive_json()
        assert result["payload"]["ok"]
        assert a.receive_json()["payload"]["text"] == "hello"
        a.send_json(command)
        assert a.receive_json() == result
        a.send_json({**command, "payload": {"text": "different"}})
        assert a.receive_json()["payload"]["code"] == "REQUEST_CONFLICT"
        b.send_json({"type": "chat.send", "request_id": str(uuid.uuid4()), "payload": {"text": "private"}})
        assert b.receive_json()["payload"]["ok"]
        assert b.receive_json()["payload"]["text"] == "private"
        a.send_json({"type": "unknown"})
        assert a.receive_json()["payload"]["code"] == "NOT_IMPLEMENTED"
    with main.db.connect() as db:
        assert db.execute("SELECT count(*) FROM chat_messages").fetchone()[0] == 2


def test_chat_concurrent_retry_is_atomic(client):
    identity, _ = register(client, "alice")
    request_id = str(uuid.uuid4())
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: main.db.send_chat(identity, request_id, "same"), range(4)))
    assert all(response[0] == responses[0][0] for response in responses)
    assert sum(event is not None for _, event in responses) == 1
    with main.db.connect() as db:
        assert db.execute("SELECT count(*) FROM chat_messages").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM command_results").fetchone()[0] == 1
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("INSERT INTO team_members VALUES ('demo-world', ?, 'missing', 'player')", (str(uuid.uuid4()),))


def test_two_clients_receive_authoritative_movement(client):
    alice, a_token = register(client, 'alice')
    bob, b_token = register(client, 'bob')

    def read_state(ws, kind):
        for _ in range(100):
            message = ws.receive_json()
            if message['type'] == 'world.offer':
                ws.send_json({'type': 'world.accept', 'payload': {}})
            if message['type'] == kind:
                return message
        raise AssertionError('State was not delivered')

    def subscribe(ws):
        assert ws.receive_json()['type'] == 'session.ready'
        ws.send_json({'type': 'world.subscribe', 'payload': {}})
        return read_state(ws, 'world.snapshot')

    with client.websocket_connect('/ws', headers={'origin': ORIGIN, 'cookie': f'mars_session={a_token}'}) as a, \
         client.websocket_connect('/ws', headers={'origin': ORIGIN, 'cookie': f'mars_session={b_token}'}) as b:
        subscribe(a)
        subscribe(b)
        runtime = main.app.state.game.runtime(alice)
        a.send_json({'type': 'lobby.ready', 'payload': {'ready': True}})
        b.send_json({'type': 'lobby.ready', 'payload': {'ready': True}})
        while read_state(a, 'lobby.state')['payload']['stage'] != 'running':
            pass
        # Startup places players by their own domes. Move Bob nearby only after
        # that placement, outside every building and player collision radius.
        from app.game.rover import spawn_position
        from app.game.state import BUILDING_RADIUS, MOUNTAIN_RADIUS, PLAYER_RADIUS
        from app.world.terrain import ground_position, seed_from_world_id
        with runtime.transaction() as state:
            alice_position = state.players[alice['user_id']].position
            obstacles = [(runtime.planet.cells[item.cell_id].center, BUILDING_RADIUS + PLAYER_RADIUS + .05)
                         for item in state.buildings.values()]
            obstacles += [(runtime.planet.cells[cell].center, MOUNTAIN_RADIUS + PLAYER_RADIUS + .05)
                          for cell in state.mountains]
            obstacles.append((alice_position, 2 * PLAYER_RADIUS + .05))
            state.players[bob['user_id']].position = spawn_position(alice_position, runtime.planet, obstacles)
            position = ground_position(alice_position, runtime.planet.radius,
                                       seed=seed_from_world_id(state.world_id))
        a.send_json({'type': 'player.input', 'payload': {'seq': 1, 'move': [0, 0, 1]}})
        for _ in range(20):
            delta = read_state(b, 'world.delta')
            others = [player for player in delta['payload']['players'] if player['player_id'] == alice['user_id']]
            if others and sum((a - b) ** 2 for a, b in zip(others[0]['position'], position)) > 0.001:
                assert 'inventory' not in others[0]
                break
        else:
            raise AssertionError('The second client never received movement')


def test_restart_with_unaccepted_offer_reconnects_and_replay_is_safe(client):
    identity, token = register(client, 'restart_player')
    headers = {'origin': ORIGIN, 'cookie': f'mars_session={token}'}
    request = {'type': 'world.restart', 'request_id': str(uuid.uuid4()), 'payload': {}}

    def receive(ws, kind, accept_offers=False):
        for _ in range(200):
            message = ws.receive_json()
            if accept_offers and message['type'] == 'world.offer':
                ws.send_json({'type': 'world.accept', 'payload': {}})
            if message['type'] == kind:
                return message
        raise AssertionError(f'Expected {kind}')

    with client.websocket_connect('/ws', headers=headers) as ws:
        assert ws.receive_json()['type'] == 'session.ready'
        ws.send_json({'type': 'world.subscribe', 'payload': {}})
        receive(ws, 'world.snapshot', accept_offers=True)
        runtime = main.app.state.game.runtime(identity)
        with runtime.transaction() as state:
            cell = runtime.planet.landing_sites[0]
            state.buildings['old'] = Building('old', cell, 'warehouse', identity['team_id'], identity['user_id'])
            state.team_storage[identity['team_id']]['iron'] = 1
            state.oxygen_percent = 42
            state.revision += 1
        ws.send_json({'type': 'lobby.ready', 'payload': {'ready': True}})
        running = offered = False
        while not (running and offered):
            message = ws.receive_json()
            running |= message['type'] == 'lobby.state' and message['payload']['stage'] == 'running'
            offered |= message['type'] == 'world.offer'
        # Leave this reservation outstanding when the restart arrives.
        ws.send_json(request)
        first = receive(ws, 'action.result')
        assert first['request_id'] == request['request_id']
        assert first['payload'] == {'ok': True, 'generation': 1}
        with pytest.raises(WebSocketDisconnect) as closed:
            while True:
                ws.receive_json()
        assert closed.value.code == 4000

    with client.websocket_connect('/ws', headers=headers) as ws:
        assert ws.receive_json()['type'] == 'session.ready'
        ws.send_json({'type': 'world.subscribe', 'payload': {}})
        snapshot = receive(ws, 'world.snapshot', accept_offers=True)['payload']
        assert snapshot['generation'] == 1 and snapshot['stage'] == 'lobby'
        assert snapshot['buildings'] == [] and snapshot['oxygen_percent'] == 0
        assert all(snapshot['team_storage'][key] == value for key, value in STARTING_RESOURCES.items())
        ws.send_json(request)
        assert receive(ws, 'action.result', accept_offers=True) == first
        # A subsequent request succeeds on the same socket: replay did not close it.
        ws.send_json({'type': 'lobby.profile', 'payload': {'color': 0, 'variant': 0}})
        receive(ws, 'lobby.state', accept_offers=True)
        state = main.app.state.game.runtime(identity).state
        assert state.generation == 1 and state.team_storage[identity['team_id']]['iron'] == 40


def test_four_connections_and_logout(client):
    tokens = [register(client, f"player_{n}")[1] for n in range(4)]
    from contextlib import ExitStack
    with ExitStack() as stack:
        sockets = [stack.enter_context(client.websocket_connect(
            "/ws", headers={"origin": ORIGIN, "cookie": f"mars_session={token}"})) for token in tokens]
        for ws in sockets:
            assert ws.receive_json()["type"] == "session.ready"
        sockets[0].send_json({"type": "chat.send", "request_id": str(uuid.uuid4()), "payload": {"text": "team"}})
        assert sockets[0].receive_json()["payload"]["ok"]
        for ws in sockets:
            assert ws.receive_json()["payload"]["text"] == "team"
        client.cookies.set("mars_session", tokens[0])
        assert client.post("/api/auth/logout", headers={"origin": ORIGIN}).status_code == 204
        with pytest.raises(WebSocketDisconnect):
            sockets[0].receive_json()


def test_real_uvicorn_websocket(tmp_path):
    def recv_without_lobby(ws):
        while True:
            message = json.loads(ws.recv(timeout=3))
            if message['type'] != 'lobby.state':
                return message
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    env = {**os.environ, "DATA_DIR": str(tmp_path), "MARS_ALLOWED_ORIGINS": origin}
    server_dir = Path(__file__).resolve().parents[1]
    process = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--app-dir", str(server_dir),
                                "--host", "127.0.0.1", "--port", str(port), "--ws-max-size", "4096"],
                               env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        with httpx.Client(base_url=origin, timeout=1, trust_env=False) as client:
            deadline = time.monotonic() + 10
            while True:
                try:
                    response = client.get("/api/health")
                    break
                except (httpx.ConnectError, httpx.ConnectTimeout):
                    if process.poll() is not None or time.monotonic() > deadline:
                        raise
                    time.sleep(0.05)
            assert response.json()["status"] == "ok"
            response = client.post("/api/auth/register", headers={"origin": origin},
                                   json={"username": "alice", "password": "longpassword"})
            assert response.status_code == 201
            with connect(f"ws://127.0.0.1:{port}/ws", origin=origin,
                         additional_headers={"Cookie": f"mars_session={client.cookies['mars_session']}"},
                         open_timeout=3) as ws:
                assert json.loads(ws.recv(timeout=3))["type"] == "session.ready"
                ws.send(json.dumps({"type": "chat.send", "request_id": str(uuid.uuid4()), "payload": {"text": "hello"}}))
                assert json.loads(ws.recv(timeout=3))["payload"]["ok"]
                assert json.loads(ws.recv(timeout=3))["type"] == "chat.message"
                ws.send(json.dumps({'type': 'world.subscribe', 'payload': {}}))
                offer = recv_without_lobby(ws)
                assert offer['type'] == 'world.offer'
                ws.send(json.dumps({'type': 'world.accept', 'payload': {}}))
                initial = recv_without_lobby(ws)
                assert initial['type'] == 'world.snapshot'
                assert initial['payload']['self_id'] == response.json()['user_id']
                assert initial['payload']['stage'] == 'lobby'
                # Verify the actual browser JSON byte accounting, not Python against itself.
                measured = subprocess.run(['node', '--input-type=module', '-e',
                    "let s='';for await(const c of process.stdin)s+=c;console.log(Buffer.byteLength(JSON.stringify(JSON.parse(s))));"],
                    input=json.dumps(initial['payload']), text=True, capture_output=True, check=True)
                assert int(measured.stdout) == offer['payload']['byte_size']
                start_id = str(uuid.uuid4())
                ws.send(json.dumps({'type': 'world.start', 'request_id': start_id, 'payload': {}}))
                got_chunk = got_start = got_move = False
                position = initial['payload']['players'][0]['position']
                revision = initial['revision']
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not (got_chunk and got_start and got_move):
                    message = json.loads(ws.recv(timeout=3))
                    if message['type'] == 'world.offer':
                        ws.send(json.dumps({'type': 'world.accept', 'payload': {}}))
                    elif message['type'] == 'chunk.offer':
                        ws.send(json.dumps({'type': 'chunk.request', 'payload': {'chunk_id': message['payload']['chunk_id']}}))
                    elif message['type'] == 'chunk.load':
                        assert message['payload']['cells']
                        got_chunk = True
                    elif message['type'] == 'action.result' and message.get('request_id') == start_id:
                        assert message['payload']['code'] == 'READY_REQUIRED'
                        ws.send(json.dumps({'type': 'lobby.ready', 'payload': {'ready': True}}))
                    elif message['type'] == 'lobby.state' and message['payload']['stage'] == 'running':
                        got_start = True
                        ws.send(json.dumps({'type': 'player.input', 'payload': {'seq': 1, 'move': [0, 0, 1]}}))
                    elif message['type'] == 'world.delta':
                        assert message['revision'] == revision + 1
                        revision = message['revision']
                        got_move |= message['payload']['players'][0]['position'] != position
                assert got_chunk and got_start and got_move
            with connect(f"ws://127.0.0.1:{port}/ws", origin=origin,
                         additional_headers={'Cookie': f"mars_session={client.cookies['mars_session']}"}) as ws:
                assert json.loads(ws.recv(timeout=3))['type'] == 'session.ready'
                ws.send(json.dumps({'type': 'world.subscribe', 'payload': {}}))
                assert recv_without_lobby(ws)['type'] == 'world.offer'
                ws.send(json.dumps({'type': 'world.accept', 'payload': {}}))
                restored = recv_without_lobby(ws)
                assert restored['payload']['stage'] == 'running'
                assert restored['payload']['last_input_seq'] == 1
    finally:
        process.terminate()
        process.wait(timeout=5)


def test_build_remove_and_respawn_commands_over_websocket(client):
    identity, token = register(client, 'builder')
    with client.websocket_connect('/ws', headers={'origin': ORIGIN, 'cookie': f'mars_session={token}'}) as ws:
        assert ws.receive_json()['type'] == 'session.ready'
        ws.send_json({'type': 'world.subscribe', 'payload': {}})
        while ws.receive_json()['type'] != 'world.offer':
            pass
        ws.send_json({'type': 'lobby.ready', 'payload': {'ready': True}})
        while True:
            message = ws.receive_json()
            if message['type'] == 'lobby.state' and message['payload']['stage'] == 'running':
                break
        runtime = main.app.state.game.runtime(identity)
        def action(kind, expected_ok=True, **payload):
            request_id = str(uuid.uuid4())
            ws.send_json({'type': kind, 'request_id': request_id, 'payload': payload})
            for _ in range(100):
                message = ws.receive_json()
                if message['type'] == 'action.result' and message.get('request_id') == request_id:
                    assert message['payload']['ok'] is expected_ok, message
                    return message['payload']
            raise AssertionError('No action result')
        site = next(cell for cell, user in runtime.state.landing_claims.items() if user == identity['user_id'])
        building = next(b.building_id for b in runtime.state.buildings.values() if b.cell_id == site and b.building_type == 'dome_base')
        assert action('player.respawn')['building_id'] == building
        assert action('building.remove', expected_ok=False, building_id=building)['code'] == 'FORBIDDEN'
        assert action('player.respawn')['building_id'] == building
