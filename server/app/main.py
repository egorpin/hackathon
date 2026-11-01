"""HTTP authentication and team-scoped WebSocket transport."""
import hashlib
import asyncio
import hmac
import json
import os
import secrets
import sqlite3
import uuid
import time
from contextlib import asynccontextmanager
from contextlib import suppress
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from .storage import Database
from .storage.buffered import BufferedGameWriter
from .transport import GameService, Stream
from .lobby import Lobby
from .game import step
from . import agent, admin
import sys

DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
STATIC_DIR = Path(os.environ.get("STATIC_DIR", "client/dist"))
ALLOWED_ORIGINS = frozenset(x.strip() for x in os.environ.get(
    "MARS_ALLOWED_ORIGINS", "http://localhost:8000,http://127.0.0.1:8000,http://localhost:5173,http://127.0.0.1:5173"
).split(",") if x.strip())
SECURE_COOKIE = os.environ.get("MARS_SECURE_COOKIE", "false").lower() == "true"
SESSION_SECONDS = 7 * 24 * 60 * 60
COOKIE = "mars_session"
db = Database(DATA_DIR / "mars.sqlite3")
connections: set[WebSocket] = set()


def hash_password(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)


def origin_allowed(headers, request_scheme: str) -> bool:
    """Allow configured dev origins and the public same-origin address.

    Browsers set Host to the server they contact and Origin to the page that
    opened the request. Matching both lets Docker work on any LAN address
    without accepting cross-site requests from an unrelated page.
    """
    origin = headers.get("origin")
    if origin in ALLOWED_ORIGINS:
        return True
    try:
        parsed = urlsplit(origin or "")
    except ValueError:
        return False
    if (parsed.scheme not in ("http", "https") or not parsed.netloc or
            parsed.username is not None or parsed.password is not None or
            parsed.path or parsed.query or parsed.fragment):
        return False
    public_scheme = headers.get("x-forwarded-proto")
    if public_scheme not in ("http", "https"):
        public_scheme = "https" if request_scheme in ("https", "wss") else "http"
    host = headers.get("host", "").lower()
    return parsed.scheme == public_scheme and parsed.netloc.lower() == host


def require_origin(request: Request) -> None:
    if not origin_allowed(request.headers, request.url.scheme):
        raise HTTPException(status_code=403, detail="Origin is not allowed")


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_]+$")
    password: str = Field(min_length=8, max_length=128)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.initialize()
    admin.initialize(app, db.path.parent)
    game = GameService(db)
    writer = BufferedGameWriter(db)
    app.state.game_writer = writer
    game.persist = writer.submit
    app.state.game = game
    app.state.lobby = Lobby(app.state.game)
    task = asyncio.create_task(game_loop())
    try:
        yield
    finally:
        try:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            for socket in list(connections):
                with suppress(RuntimeError):
                    await socket.close(code=1001)
            connections.clear()
        finally:
            await asyncio.to_thread(writer.close)


async def game_loop():
    loop = asyncio.get_running_loop()
    deadline = loop.time()
    while True:
        deadline += .05
        await asyncio.sleep(max(0, deadline - loop.time()))
        tick_started = time.monotonic()
        for world_id, runtime in list(app.state.game.worlds.items()):
            if app.state.lobby.stage(world_id) != 'running' or runtime.state.admin_paused:
                continue
            with runtime.transaction() as draft:
                step(draft, .05, runtime.planet)
        app.state.tick_ms = (time.monotonic() - tick_started) * 1000
        for socket in list(connections):
            stream = getattr(socket.state, 'stream', None)
            if stream is None:
                continue
            identity = db.identity(socket.state.session_token)
            if identity != stream.identity:
                connections.discard(socket)
                with suppress(RuntimeError):
                    await socket.close(code=1008)
                continue
            try:
                async with socket.state.send_lock:
                    await stream.offer(socket)
            except (RuntimeError, WebSocketDisconnect, OSError):
                connections.discard(socket)


app = FastAPI(title="Mars Colony", lifespan=lifespan)
agent_busy = set()


class AgentQuestion(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


def agent_identity(request):
    identity = db.identity(request.cookies.get(COOKIE))
    if not identity:
        raise HTTPException(status_code=401, detail='Сначала войдите в игру.')
    return identity


@app.get('/api/agent/messages')
def agent_messages(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    identity = agent_identity(request)
    character = admin.active_character(app.state.game.runtime(identity).state)
    return {'messages': agent.history(db, identity, character['id'] if character else 'expedition'),
            'character': {'id': character['id'], 'name': character['name']} if character else None}


@app.post('/api/agent/ask')
async def agent_ask(question: AgentQuestion, request: Request, response: Response):
    require_origin(request)
    identity = agent_identity(request)
    text = question.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail='Введите вопрос.')
    if agent_busy:
        raise HTTPException(status_code=429, detail='ИИ отвечает на другой вопрос. Попробуйте чуть позже.')
    character = admin.active_character(app.state.game.runtime(identity).state)
    if character is None or not character['enabled']:
        raise HTTPException(status_code=503, detail='Персонаж отключён администратором.')
    agent_busy.add(identity['user_id'])
    response.headers['Cache-Control'] = 'no-store'
    try:
        context = {'stage': app.state.lobby.stage(identity['world_id']), '_character': character,
                   '_agent_db': db, '_agent_identity': identity, '_agent_id': character['id']}
        runtime = app.state.game.worlds.get(identity['world_id'])
        if runtime and identity['user_id'] in runtime.state.players:
            state = app.state.game.dto(identity)
            context.update({key: state[key] for key in ('inventory', 'team_storage', 'energy', 'oxygen_percent', 'oxygen_goal', 'config', 'stage') if key in state})
            context['team_buildings'] = [item['building_type'] for item in state.get('buildings', [])]
        answer = await asyncio.to_thread(agent.complete, agent.history(db, identity, character['id']), text, context)
        with db.connect() as connection:
            for role, message in [('user', text), ('assistant', answer)]:
                connection.execute('INSERT INTO agent_messages VALUES (?,?,?,?,?,?,?)',
                                   (str(uuid.uuid4()), identity['world_id'], identity['user_id'], character['id'],
                                    role, message, int(time.time())))
        return {'text': answer, 'character': {'id': character['id'], 'name': character['name']}}
    except (OSError, ValueError, KeyError):
        raise HTTPException(status_code=503, detail='Модель сейчас недоступна. Попробуйте позже.') from None
    finally:
        agent_busy.discard(identity['user_id'])


@app.post('/api/agent/ask/stream')
def agent_ask_stream(question: AgentQuestion, request: Request):
    require_origin(request)
    identity = agent_identity(request)
    text = question.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail='Введите вопрос.')
    if agent_busy:
        raise HTTPException(status_code=429, detail='ИИ отвечает на другой вопрос. Попробуйте чуть позже.')
    character = admin.active_character(app.state.game.runtime(identity).state)
    if character is None or not character['enabled']:
        raise HTTPException(status_code=503, detail='Персонаж отключён администратором.')
    busy_key = identity['user_id']
    agent_busy.add(busy_key)
    context = {'stage': app.state.lobby.stage(identity['world_id']), '_character': character,
               '_agent_db': db, '_agent_identity': identity, '_agent_id': character['id']}
    runtime = app.state.game.worlds.get(identity['world_id'])
    if runtime and identity['user_id'] in runtime.state.players:
        state = app.state.game.dto(identity)
        context.update({key: state[key] for key in ('inventory', 'team_storage', 'energy', 'oxygen_percent', 'oxygen_goal', 'config', 'stage') if key in state})
        context['team_buildings'] = [item['building_type'] for item in state.get('buildings', [])]

    def stream():
        chunks = []
        completed = False
        try:
            for chunk in agent.stream_complete(agent.history(db, identity, character['id']), text, context):
                chunks.append(chunk)
                yield json.dumps({'text': chunk}, ensure_ascii=False) + '\n'
            completed = True
            yield json.dumps({'done': True}, ensure_ascii=False) + '\n'
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            yield json.dumps({'error': 'Модель сейчас недоступна. Попробуйте позже.'}, ensure_ascii=False) + '\n'
        finally:
            if completed:
                answer = ''.join(chunks).strip()
                if answer:
                    with db.connect() as connection:
                        for role, message in [('user', text), ('assistant', answer)]:
                            connection.execute('INSERT INTO agent_messages VALUES (?,?,?,?,?,?,?)',
                                               (str(uuid.uuid4()), identity['world_id'], identity['user_id'], character['id'],
                                                role, message, int(time.time())))
            agent_busy.discard(busy_key)

    return StreamingResponse(stream(), media_type='application/x-ndjson', headers={
        'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no',
    })


@app.get("/api/health")
def health():
    with db.connect() as connection:
        connection.execute("SELECT 1 FROM worlds LIMIT 1").fetchone()
    return {"status": "ok", "stage": "server-foundation"}


def set_session(response: Response, token: str) -> None:
    response.set_cookie(COOKIE, token, max_age=SESSION_SECONDS, httponly=True,
                        secure=SECURE_COOKIE, samesite="strict", path="/")
    response.headers["Cache-Control"] = "no-store"


@app.post("/api/auth/register", status_code=201)
def register(credentials: Credentials, request: Request, response: Response):
    require_origin(request)
    salt, token = secrets.token_bytes(16), secrets.token_urlsafe(32)
    try:
        identity = db.register(credentials.username, salt, hash_password(credentials.password, salt), token, SESSION_SECONDS)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Username already exists") from None
    set_session(response, token)
    return identity


@app.post("/api/auth/login")
def login(credentials: Credentials, request: Request, response: Response):
    require_origin(request)
    user = db.password_record(credentials.username)
    actual = hash_password(credentials.password, user["salt"] if user else bytes(16))
    if not user or not hmac.compare_digest(actual, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = secrets.token_urlsafe(32)
    identity = db.create_session(user["id"], token, SESSION_SECONDS)
    set_session(response, token)
    return identity


@app.get("/api/auth/me")
def me(request: Request, response: Response):
    identity = db.identity(request.cookies.get(COOKIE))
    if not identity:
        raise HTTPException(status_code=401, detail="Not authenticated")
    response.headers["Cache-Control"] = "no-store"
    return identity


@app.post("/api/auth/logout", status_code=204)
async def logout(request: Request, response: Response):
    require_origin(request)
    token = request.cookies.get(COOKIE)
    db.delete_session(token)
    for socket in list(connections):
        if socket.state.session_token == token:
            connections.discard(socket)
            try:
                await socket.close(code=1008)
            except RuntimeError:
                pass
    response.delete_cookie(COOKIE, path="/", secure=SECURE_COOKIE, httponly=True, samesite="strict")
    response.headers["Cache-Control"] = "no-store"


async def send_team(world_id: str, team_id: str, message: dict) -> None:
    for socket in list(connections):
        identity = db.identity(socket.state.session_token)
        if not identity:
            connections.discard(socket)
            try:
                await socket.close(code=1008)
            except RuntimeError:
                pass
        elif identity["world_id"] == world_id and identity["team_id"] == team_id:
            try:
                await socket.send_json(message)
            except (RuntimeError, WebSocketDisconnect):
                connections.discard(socket)


async def broadcast_lobby(world_id):
    for peer in list(connections):
        identity = app.state.lobby.members.get(peer)
        if (identity is None or identity['world_id'] != world_id
                or peer not in app.state.lobby.loaded):
            continue
        try:
            async with peer.state.send_lock:
                # Build inside the lock so queued broadcasts never send stale votes.
                await peer.send_json(app.state.lobby.state(world_id))
        except (RuntimeError, WebSocketDisconnect, OSError):
            pass  # The receive loop removes disconnected members in finally.


@app.websocket("/ws")
async def websocket_endpoint(socket: WebSocket):
    token = socket.cookies.get(COOKIE)
    identity = db.identity(token)
    if not origin_allowed(socket.headers, socket.scope["scheme"]) or not identity:
        await socket.close(code=1008)
        return
    socket.state.session_token = token
    socket.state.connection_id = str(uuid.uuid4())
    socket.state.connected_at = time.monotonic()
    socket.state.send_lock = asyncio.Lock()
    await socket.accept()
    connections.add(socket)
    app.state.lobby.connect(socket, identity)
    try:
        await socket.send_json({"type": "session.ready", "payload": identity})
        await broadcast_lobby(identity['world_id'])
        while True:
            raw = await socket.receive_text()
            identity = db.identity(token)
            if not identity:
                await socket.close(code=1008)
                break
            if len(raw.encode("utf-8")) > 4096:
                await socket.close(code=1009)
                break
            try:
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise ValueError
            except ValueError:
                await socket.send_json({"type": "error", "payload": {"code": "INVALID_ARGUMENT"}})
                continue
            kind = message.get('type')
            if kind in ('telemetry.report', 'telemetry.pong'):
                await admin.receive_telemetry(socket, kind, message.get('payload'))
                continue
            if kind == 'world.subscribe':
                if getattr(socket.state, 'stream', None) is None:
                    try:
                        app.state.game.join(identity)
                    except ValueError as error:
                        app.state.lobby.disconnect(socket)
                        await broadcast_lobby(identity['world_id'])
                        await socket.send_json({'type': 'error', 'payload': {'code': 'WORLD_UNAVAILABLE', 'message': str(error)}})
                        continue
                    socket.state.stream = Stream(app.state.game, identity)
                    app.state.lobby.connect(socket, identity)
                    app.state.lobby.loaded.add(socket)
                    if app.state.game.runtime(identity).state.stage == 'running':
                        app.state.lobby.active.add(identity['world_id'])
                async with socket.state.send_lock:
                    await socket.state.stream.offer(socket)
                await broadcast_lobby(identity['world_id'])
                continue
            stream = getattr(socket.state, 'stream', None)
            if stream is not None and identity != stream.identity:
                await socket.close(code=1008)
                break
            if kind in ('lobby.ready', 'lobby.profile'):
                if socket not in app.state.lobby.members:
                    code = 'NOT_READY'
                elif kind == 'lobby.ready':
                    code = app.state.lobby.set_ready(socket, message.get('payload'))
                else:
                    code = app.state.lobby.set_profile(socket, message.get('payload'))
                if code:
                    await socket.send_json({'type': 'lobby.error', 'payload': {'code': code}})
                await broadcast_lobby(identity['world_id'])
                continue
            # The public start command cannot bypass the unanimous lobby vote.
            if kind == 'world.start':
                await socket.send_json({'type': 'action.result', 'request_id': message.get('request_id'),
                                        'payload': {'ok': False, 'code': 'READY_REQUIRED'}})
                continue
            if kind == 'world.restart':
                if stream is None:
                    await socket.send_json({'type': 'action.result', 'request_id': message.get('request_id'),
                                            'payload': {'ok': False, 'code': 'NOT_READY'}})
                    continue
                runtime = app.state.game.runtime(identity)
                before = runtime.state.generation
                result = app.state.game.command(identity, message)
                changed = result['payload']['ok'] and runtime.state.generation != before
                if changed:
                    app.state.lobby.restart(identity['world_id'])
                    peers = [peer for peer in list(connections)
                             if (getattr(peer.state, 'stream', None) is not None
                                 and peer.state.stream.identity['world_id'] == identity['world_id'])]
                    # Stop all streams before yielding. Reconnection clears any
                    # client reservation for an offer already in flight.
                    for peer in peers:
                        peer.state.stream = None
                await socket.send_json(result)
                if changed:
                    await broadcast_lobby(identity['world_id'])
                    for peer in peers:
                        try:
                            async with peer.state.send_lock:
                                await peer.close(code=4000, reason='expedition restarted')
                        except (RuntimeError, WebSocketDisconnect, OSError):
                            pass
                continue
            if kind in ('world.accept', 'chunk.request', 'chunk.release'):
                if stream is not None:
                    async with socket.state.send_lock:
                        if kind == 'world.accept':
                            await stream.accept(socket)
                        elif kind == 'chunk.request':
                            await stream.chunk_request(socket, message.get('payload'))
                        else:
                            stream.release(message.get('payload'))
                continue
            if kind in ('player.input', 'player.color', 'landing.select', 'world.start', 'building.place', 'building.remove', 'player.respawn', 'player.teleport',
                        'resource.pickup', 'resource.deposit', 'resource.give', 'rover.survey', 'rover.point.register', 'rover.purchase', 'rover.program', 'rover.start', 'rover.stop'):
                if stream is None:
                    await socket.send_json({'type': 'action.result', 'request_id': message.get('request_id'),
                                            'payload': {'ok': False, 'code': 'NOT_READY'}})
                    continue
                if kind not in ('landing.select', 'player.color') and app.state.lobby.stage(identity['world_id']) != 'running':
                    await socket.send_json({'type': 'action.result', 'request_id': message.get('request_id'),
                                            'payload': {'ok': False, 'code': 'READY_REQUIRED'}})
                    continue
                if kind == 'player.teleport':
                    payload = message.get('payload')
                    target_id = payload.get('player_id') if isinstance(payload, dict) else None
                    if isinstance(target_id, str) and not any(
                            member['user_id'] == target_id for member in app.state.lobby.players(identity['world_id'])):
                        await socket.send_json({'type': 'action.result', 'request_id': message.get('request_id'),
                                                'payload': {'ok': False, 'code': 'TARGET_UNAVAILABLE'}})
                        continue
                result = app.state.game.command(identity, message)
                if kind != 'player.input' or not result['payload']['ok']:
                    await socket.send_json(result)
                continue
            if message.get("type") != "chat.send":
                await socket.send_json({"type": "error", "request_id": message.get("request_id"),
                                        "payload": {"code": "NOT_IMPLEMENTED"}})
                continue
            request_id, payload = message.get("request_id"), message.get("payload")
            try:
                if not isinstance(request_id, str) or str(uuid.UUID(request_id)) != request_id:
                    raise ValueError
                if not isinstance(payload, dict) or set(payload) != {"text"}:
                    raise ValueError
                text = payload["text"]
                if not isinstance(text, str) or not 1 <= len(text.strip()) <= 500:
                    raise ValueError
            except (ValueError, TypeError, AttributeError):
                await socket.send_json({"type": "action.result", "request_id": request_id,
                                        "payload": {"ok": False, "code": "INVALID_ARGUMENT"}})
                continue
            result, event = app.state.game.send_chat(identity, request_id, text)
            await socket.send_json(result)
            if event:
                await send_team(identity["world_id"], identity["team_id"], event)
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass
    finally:
        connections.discard(socket)
        world_id = app.state.lobby.disconnect(socket)
        if world_id is not None:
            await broadcast_lobby(world_id)


admin.install(app, sys.modules[__name__])


if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="client")
