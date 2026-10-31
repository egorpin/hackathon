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
        with httpx.Client(base_url=origin, timeout=1) as client:
            deadline = time.monotonic() + 10
            while True:
                try:
                    response = client.get("/api/health")
                    break
                except httpx.ConnectError:
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
    finally:
        process.terminate()
        process.wait(timeout=5)
