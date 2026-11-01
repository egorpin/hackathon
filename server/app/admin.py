"""Same-process administration; credentials never enter game DTOs."""
import hmac
import math
import os
import secrets
import time
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from . import agent
from .game.state import RESOURCES, storage_capacity
from .game.rover import parse, ProgramError, telemetry


class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


class Character(Model):
    id: str = Field(pattern=r'^[a-z0-9_-]{1,40}$')
    name: str = Field(min_length=1, max_length=80)
    enabled: bool = True
    prompt: str = Field(min_length=1, max_length=12000)
    temperature: float = Field(default=.4, ge=0, le=2)


class WorldEdit(Model):
    version: int = Field(ge=0)
    paused: bool
    oxygen_percent: float | None = Field(default=None, ge=0, le=100)
    team_storage: dict[str, dict[str, int]] | None = None
    characters: list[Character] = Field(min_length=1, max_length=20)
    active_character: str


class RoverEdit(Model):
    expected_revision: int
    program: str = Field(max_length=512)
    action: Literal['save', 'start', 'stop']


class Telemetry(Model):
    fps: float | None = Field(default=None, ge=0, le=1000)
    frameP95: float | None = Field(default=None, ge=0, le=60000)
    drawCalls: int | None = Field(default=None, ge=0, le=1000000)
    triangles: int | None = Field(default=None, ge=0, le=1000000000)
    hidden: bool = False


def characters(state):
    return state.admin_characters or [dict(id='expedition', name='Марсик', enabled=True,
                                         prompt=agent.SYSTEM, temperature=.4)]


def active_character(state):
    return next((c for c in characters(state) if c['id'] == state.admin_active_character), None)


def initialize(app, data_dir):
    key = os.environ.get('MARS_ADMIN_TOKEN', '').strip()
    if not key:
        path = data_dir / 'admin.key'
        try:
            with open(path, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as file:
                file.write(secrets.token_urlsafe(32))
        except FileExistsError:
            pass
        key = path.read_text().strip()
    if len(key) < 24:
        raise ValueError('MARS_ADMIN_TOKEN / admin.key must contain at least 24 characters')
    app.state.admin_key = key
    app.state.started_at = time.monotonic()
    app.state.tick_ms = 0.


def install(app, backend):
    router = APIRouter(prefix='/api/admin')

    def authorize(request: Request):
        supplied = request.headers.get('authorization', '').removeprefix('Bearer ')
        if not supplied or not hmac.compare_digest(supplied.encode(), app.state.admin_key.encode()):
            raise HTTPException(401, 'Неверный ключ администратора')
        if request.method != 'GET':
            backend.require_origin(request)

    def runtime(world_id):
        with backend.db.connect() as db:
            if not db.execute('SELECT 1 FROM worlds WHERE id=?', (world_id,)).fetchone():
                raise HTTPException(404, 'Мир не найден')
        try:
            return app.state.game.runtime({'world_id': world_id})
        except ValueError as error:
            raise HTTPException(409, str(error)) from None

    @app.get('/admin', include_in_schema=False)
    @app.get('/admin/', include_in_schema=False)
    def page():
        return FileResponse(Path(__file__).with_name('admin.html'), headers={'Cache-Control': 'no-store'})

    @router.get('/overview', dependencies=[Depends(authorize)])
    async def overview():
        now = time.monotonic()
        clients = []
        for socket in list(backend.connections):
            identity = backend.db.identity(socket.state.session_token)
            if not identity:
                continue
            report = getattr(socket.state, 'telemetry', {})
            measured = getattr(socket.state, 'telemetry_at', None)
            clients.append(dict(connection_id=socket.state.connection_id, **identity,
                                **report, ping_ms=getattr(socket.state, 'ping_ms', None),
                                age_seconds=round(now-measured, 1) if measured else None,
                                connected_seconds=round(now-socket.state.connected_at)))
        with backend.db.connect() as db:
            worlds = [dict(row) for row in db.execute('SELECT id, stage FROM worlds')]
        return dict(clients=clients, worlds=worlds, uptime_seconds=round(now-app.state.started_at),
                    tick_ms=round(app.state.tick_ms, 2), ai_busy=bool(backend.agent_busy))

    @router.get('/worlds/{world_id}', dependencies=[Depends(authorize)])
    async def read_world(world_id: str):
        state = runtime(world_id).state
        return dict(id=world_id, version=state.admin_version, paused=state.admin_paused,
                    stage=state.stage, tick=state.tick, oxygen_percent=state.oxygen_percent,
                    team_storage=state.team_storage, characters=characters(state),
                    active_character=state.admin_active_character,
                    rovers=[telemetry(r) for r in state.rovers.values()],
                    players=len(state.players), buildings=len(state.buildings),
                    radius=app.state.game.planet.radius)

    @router.put('/worlds/{world_id}', dependencies=[Depends(authorize)])
    async def edit_world(world_id: str, edit: WorldEdit):
        ids = [c.id for c in edit.characters]
        if len(set(ids)) != len(ids) or edit.active_character not in ids:
            raise HTTPException(422, 'У персонажей должны быть уникальные ID; выберите активного')
        with runtime(world_id).transaction() as state:
            if state.admin_version != edit.version:
                raise HTTPException(409, 'Настройки уже изменены. Загрузите мир заново.')
            stocks = edit.team_storage if edit.team_storage is not None else state.team_storage
            if set(stocks) != set(state.team_storage):
                raise HTTPException(422, 'Нельзя добавлять или удалять команды')
            for team, stock in (edit.team_storage or {}).items():
                if set(stock) != set(state.team_storage[team]) or any(k not in RESOURCES or v < 0 or v > 1000000 for k, v in stock.items()):
                    raise HTTPException(422, 'Некорректные ресурсы')
                if sum(stock.values()) > storage_capacity(state, team):
                    raise HTTPException(422, 'Превышена вместимость склада команды')
            state.admin_paused = edit.paused
            if edit.oxygen_percent is not None:
                state.oxygen_percent = edit.oxygen_percent
            if edit.team_storage is not None:
                state.team_storage = edit.team_storage
            state.admin_characters = [c.model_dump() for c in edit.characters]
            state.admin_active_character = edit.active_character
            state.admin_version += 1
            state.revision += 1
        return {'ok': True, 'version': state.admin_version}

    @router.put('/worlds/{world_id}/rovers/{rover_id}', dependencies=[Depends(authorize)])
    async def edit_rover(world_id: str, rover_id: str, edit: RoverEdit):
        with runtime(world_id).transaction() as state:
            r = state.rovers.get(rover_id)
            if r is None:
                raise HTTPException(404, 'Ровер не найден')
            if r['program_revision'] != edit.expected_revision:
                raise HTTPException(409, 'Программа уже изменена. Загрузите мир заново.')
            if edit.action != 'stop':
                try:
                    instructions = parse(edit.program, state.rover_points.get(r['team_id'], {}))
                except ProgramError as error:
                    raise HTTPException(422, f'{error}, строка {error.line}') from None
                r.update(program=edit.program, instructions=instructions,
                         targets={i['value']: i['point'] for i in instructions if i['op']=='move_to'})
            r.update(status='running' if edit.action=='start' else 'idle', pc=0,
                     wait_ticks=0, speed=0., error=None, line=None)
            r['program_revision'] += 1
            state.admin_version += 1
            state.revision += 1
        return {'ok': True}

    @app.middleware('http')
    async def no_cache(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith('/api/admin'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    app.include_router(router)


async def receive_telemetry(socket, kind, payload):
    """One report per second, server-timed nonce round trip per connection."""
    now = time.monotonic()
    if kind == 'telemetry.report':
        if now - getattr(socket.state, 'telemetry_at', -math.inf) < .8:
            return
        try:
            report = Telemetry.model_validate(payload).model_dump()
        except ValueError:
            return
        socket.state.telemetry = report
        socket.state.telemetry_at = now
        nonce = secrets.token_hex(12)
        socket.state.ping_probe = (nonce, now)
        async with socket.state.send_lock:
            await socket.send_json({'type': 'telemetry.ping', 'payload': {'nonce': nonce}})
    elif kind == 'telemetry.pong' and isinstance(payload, dict):
        probe = getattr(socket.state, 'ping_probe', None)
        if probe and payload.get('nonce') == probe[0]:
            socket.state.ping_ms = round((now-probe[1])*1000, 1)
            socket.state.ping_probe = None
