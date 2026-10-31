"""Browser DTOs and per-connection flow control for the authoritative game."""
import json
from dataclasses import asdict

from .game import Context, UnitOfWork, WorldState, apply_command, snapshot
from .world import generate_planet
from .world.geometry import surface_distance


def wire(value):
    # Six decimal places are ample for metre coordinates. Avoid Python's 1.0
    # and exponent formatting differing from JSON.stringify in byte offers.
    if isinstance(value, float):
        value = round(value, 6)
        return int(value) if value.is_integer() else value
    if isinstance(value, dict):
        return {key: wire(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [wire(item) for item in value]
    return value


def byte_size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8'))


class GameService:
    def __init__(self, db):
        self.db = db
        self.planet = generate_planet()
        self.worlds = {}
        self.chunks = {key: wire({'chunk_id': key, 'cells': [asdict(self.planet.cells[cell]) for cell in cells]})
                       for key, cells in self.planet.chunks.items()}
        for chunk in self.chunks.values():
            for cell in chunk['cells']:
                cell['surface'] = cell.pop('terrain')
        self.total_bytes = sum(byte_size(chunk) for chunk in self.chunks.values())

    def runtime(self, identity):
        world_id = identity['world_id']
        if world_id not in self.worlds:
            saved = self.db.load_game(world_id)
            state = WorldState.from_dict(saved) if saved else WorldState(world_id, self.planet.version)
            self.worlds[world_id] = UnitOfWork(self.planet, state, persist=self.db.save_game)
        return self.worlds[world_id]

    def join(self, identity):
        runtime = self.runtime(identity)
        context = Context(identity['world_id'], identity['user_id'], identity['team_id'])
        runtime.enroll(context)
        # Assign an available landing site; the explicit Start command keeps
        # the lobby open while the remaining players connect.
        with runtime.transaction() as state:
            player = state.players[context.user_id]
            if player.position is None:
                cell = next(cell for cell in self.planet.landing_sites if cell not in state.landing_claims)
                state.landing_claims[cell] = context.user_id
                player.position = self.planet.cells[cell].center
                state.revision += 1
        return context

    def command(self, identity, message):
        context = Context(identity['world_id'], identity['user_id'], identity['team_id'])
        # Chat and gameplay share the durable request-ID namespace.
        previous = self.db.command_result(identity, message)
        if previous is not None:
            return previous
        return apply_command(context, message, self.runtime(identity))

    def dto(self, identity):
        context = Context(identity['world_id'], identity['user_id'], identity['team_id'])
        message = snapshot(context, self.runtime(identity))
        data = message['payload']
        data['self_id'], data['team_id'] = context.user_id, context.team_id
        for player in data['players']:
            player['player_id'] = player.pop('user_id')
        for building in data['buildings']:
            building['position'] = self.planet.cells[building['cell_id']].center
        data['world'] = dict(radius=self.planet.radius, move_speed=4, view_radius=12,
                             build_distance=4.5, total_bytes=self.total_bytes,
                             total_chunks=len(self.chunks), shell={'radius': self.planet.radius * .995, 'detail': 2})
        return wire(data)


class Stream:
    def __init__(self, service, identity):
        self.service = service
        self.identity = identity
        self.pending = None
        self.last = None
        self.revision = 0
        self.offered = {}
        self.released = set()

    async def offer(self, socket):
        if self.pending is not None:
            return
        data = self.service.dto(self.identity)
        if data == self.last:
            return
        payload = data
        if self.last is not None:
            payload = {key: value for key, value in data.items() if key != 'world'}
            for collection, id_key in [('players', 'player_id'), ('buildings', 'building_id')]:
                ids = {item[id_key] for item in data[collection]}
                payload['removed_' + collection] = [item[id_key] for item in self.last[collection] if item[id_key] not in ids]
        self.pending = (data, payload)
        await socket.send_json({'type': 'world.offer', 'payload': {
            'total_bytes': self.service.total_bytes, 'byte_size': byte_size(payload)}})

    async def accept(self, socket):
        if self.pending is None:
            return
        data, payload = self.pending
        self.revision += 1
        await socket.send_json({'type': 'world.snapshot' if self.last is None else 'world.delta',
                                'revision': self.revision, 'payload': payload})
        self.last, self.pending = data, None
        await self.chunks(socket)

    async def chunks(self, socket):
        runtime = self.service.runtime(self.identity)
        state = runtime.state
        position = state.players[self.identity['user_id']].position
        candidates = []
        for key, cells in self.service.planet.chunks.items():
            distance = min(surface_distance(position, self.service.planet.cells[cell].center,
                                            self.service.planet.radius) for cell in cells)
            if distance <= 12:
                candidates.append((distance, key))
        selected, used = {}, 0
        for distance, key in sorted(candidates):
            chunk = self.service.chunks[key]
            # Terrain changes at world.start; unload before offering its replacement.
            chunk = {**chunk, 'cells': [{**cell, 'surface': 'mountain' if cell['cell_id'] in state.mountains else cell['surface']}
                                       for cell in chunk['cells']]}
            size = byte_size(chunk)
            if used + size > self.service.total_bytes * .04:
                continue
            selected[key] = chunk
            used += size
        for key in list(self.offered):
            if self.offered[key] != selected.get(key):
                await socket.send_json({'type': 'chunk.unload', 'payload': {'chunk_id': key}})
                del self.offered[key]
                self.released.discard(key)
        for key, chunk in selected.items():
            if key not in self.offered:
                self.offered[key] = chunk
                await socket.send_json({'type': 'chunk.offer', 'payload': {'chunk_id': key, 'byte_size': byte_size(chunk)}})

    async def chunk_request(self, socket, payload):
        key = payload.get('chunk_id') if isinstance(payload, dict) else None
        if isinstance(key, str) and key in self.offered and key not in self.released:
            await socket.send_json({'type': 'chunk.load', 'payload': self.offered[key]})

    def release(self, payload):
        key = payload.get('chunk_id') if isinstance(payload, dict) else None
        if isinstance(key, str) and key in self.offered:
            self.released.add(key)
