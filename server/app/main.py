"""HTTP authentication and team-scoped WebSocket transport."""
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from .storage import Database

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


def require_origin(origin: str | None) -> None:
    if origin not in ALLOWED_ORIGINS:
        raise HTTPException(status_code=403, detail="Origin is not allowed")


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_]+$")
    password: str = Field(min_length=8, max_length=128)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.initialize()
    yield
    for socket in list(connections):
        await socket.close(code=1001)


app = FastAPI(title="Mars Colony", lifespan=lifespan)


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
    require_origin(request.headers.get("origin"))
    salt, token = secrets.token_bytes(16), secrets.token_urlsafe(32)
    try:
        identity = db.register(credentials.username, salt, hash_password(credentials.password, salt), token, SESSION_SECONDS)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Username already exists") from None
    set_session(response, token)
    return identity


@app.post("/api/auth/login")
def login(credentials: Credentials, request: Request, response: Response):
    require_origin(request.headers.get("origin"))
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
    require_origin(request.headers.get("origin"))
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


@app.websocket("/ws")
async def websocket_endpoint(socket: WebSocket):
    token = socket.cookies.get(COOKIE)
    identity = db.identity(token)
    if socket.headers.get("origin") not in ALLOWED_ORIGINS or not identity:
        await socket.close(code=1008)
        return
    socket.state.session_token = token
    await socket.accept()
    connections.add(socket)
    await socket.send_json({"type": "session.ready", "payload": identity})
    try:
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
            result, event = db.send_chat(identity, request_id, text)
            await socket.send_json(result)
            if event:
                await send_team(identity["world_id"], identity["team_id"], event)
    except WebSocketDisconnect:
        pass
    finally:
        connections.discard(socket)


if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="client")
