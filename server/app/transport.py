"""Browser DTOs and per-connection flow control for the authoritative game."""
import json
import math
import os
from decimal import Decimal
from dataclasses import asdict

from .game import Context, UnitOfWork, WorldState, apply_command, snapshot
from .game.state import BUILDING_RADIUS, MOUNTAIN_RADIUS, PLAYER_RADIUS, INPUT_TIMEOUT_TICKS
from .world import generate_planet
from .world.geometry import surface_distance, move_on_surface, unit
from .world.terrain import ground_position, seed_from_world_id


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
    # The browser reserves JSON.stringify(payload) bytes, not Python JSON bytes.
    # In particular 0.000001 is rendered as 1e-06 by Python, but not JavaScript.
    if isinstance(value, dict):
        return 2 + max(0, len(value) - 1) + sum(byte_size(key) + 1 + byte_size(item) for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return 2 + max(0, len(value) - 1) + sum(byte_size(item) for item in value)
    if isinstance(value, float):
        encoded = json.dumps(value, allow_nan=False)
        if value == 0:
            return 1
        if 1e-6 <= abs(value) < 1e21:
            encoded = format(Decimal(encoded), 'f')
            if '.' in encoded:
                encoded = encoded.rstrip('0').rstrip('.')
        elif 'e' in encoded:
            mantissa, exponent = encoded.split('e')
            encoded = mantissa.removesuffix('.0') + 'e' + ('+' if int(exponent) >= 0 else '-') + str(abs(int(exponent)))
        return len(encoded)
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8'))


class GameService:
    def __init__(self, db, persist=None):
        self.db = db
        self.persist = persist if persist is not None else db.save_game
        raw_radius = os.environ.get("MARS_PLANET_RADIUS", "30")
        try:
            radius = float(raw_radius)
        except (TypeError, ValueError):
            raise ValueError("MARS_PLANET_RADIUS must be a finite number from 20 to 120 metres") from None
        if not math.isfinite(radius) or not 20 <= radius <= 120:
            raise ValueError("MARS_PLANET_RADIUS must be a finite number from 20 to 120 metres")
        raw_subdivisions = os.environ.get("MARS_PLANET_SUBDIVISIONS", "3")
        try:
            subdivisions = int(raw_subdivisions)
        except (TypeError, ValueError):
            raise ValueError("MARS_PLANET_SUBDIVISIONS must be 3 or 4") from None
        if str(subdivisions) != raw_subdivisions.strip() or subdivisions not in (3, 4):
            raise ValueError("MARS_PLANET_SUBDIVISIONS must be 3 or 4")
        self.planet = generate_planet(subdivisions=subdivisions, radius=radius)
        self.worlds = {}
        self.chunks = {key: wire({'chunk_id': key, 'cells': [asdict(self.planet.cells[cell]) for cell in cells]})
                       for key, cells in self.planet.chunks.items()}
        for chunk in self.chunks.values():
            for cell in chunk['cells']:
                cell['surface'] = cell.pop('terrain')
        self.total_bytes = sum(byte_size(chunk) for chunk in self.chunks.values())
        self.chunk_normals = {key: [unit(self.planet.cells[cell].center) for cell in cells]
                              for key, cells in self.planet.chunks.items()}

    def runtime(self, identity):
        world_id = identity['world_id']
        if world_id not in self.worlds:
            saved = self.db.load_game(world_id)
            state = WorldState.from_dict(saved) if saved else WorldState(world_id, self.planet.version)
            # Resource overlay preserves geometry and IDs from the previous map.
            if state.map_version in (self.planet.version.removesuffix("-resources-v2"),
                                     self.planet.version.replace("-resources-v2", "-resources-v1")):
                state.map_version = self.planet.version
            if state.map_version != self.planet.version:
                raise ValueError(
                    f"Saved world '{world_id}' uses map {state.map_version}; server is configured for "
                    f"{self.planet.version}. To keep this save, restore its MARS_PLANET_RADIUS and "
                    "MARS_PLANET_SUBDIVISIONS. To benchmark another map, use a separate DATA_DIR or Docker volume. "
                    "The existing save was left unchanged."
                )
            if saved and state.stage == 'running':
                from .game.rover import ensure_start
                ensure_start(state, self.planet)
                for rover in state.rovers.values():
                    rover.update(status='idle', speed=0., error=None, line=None)
                self.persist(state)
            self.worlds[world_id] = UnitOfWork(self.planet, state, persist=self.persist)
        return self.worlds[world_id]

    def join(self, identity):
        runtime = self.runtime(identity)
        context = Context(identity['world_id'], identity['user_id'], identity['team_id'])
        runtime.enroll(context)
        # Assign an available landing site; the lobby starts the world only
        # after every connected player has confirmed readiness.
        with runtime.transaction() as state:
            player = state.players[context.user_id]
            if player.position is None:
                cell = next(cell for cell in self.planet.landing_sites if cell not in state.landing_claims)
                position = self.planet.cells[cell].center
                if state.stage == 'running':
                    obstacles = [(self.planet.cells[b.cell_id].center, BUILDING_RADIUS + PLAYER_RADIUS)
                                 for b in state.buildings.values()]
                    obstacles += [(self.planet.cells[c].center, MOUNTAIN_RADIUS + PLAYER_RADIUS)
                                  for c in state.mountains if c != cell]
                    obstacles += [(p.position, 2 * PLAYER_RADIUS) for p in state.players.values()
                                  if p.user_id != context.user_id and p.position is not None]
                    candidates = sorted(self.planet.cells.values(), key=lambda candidate:
                                        surface_distance(candidate.center, position, self.planet.radius))
                    position = next(candidate.center for candidate in candidates
                                    if all(surface_distance(candidate.center, obstacle, self.planet.radius) >= radius
                                           for obstacle, radius in obstacles))
                state.landing_claims[cell] = context.user_id
                if cell in state.mountains:
                    state.mountains.remove(cell)
                player.position = position
                if state.stage == 'running':
                    from .game.rover import ensure_start
                    ensure_start(state, self.planet)
                state.revision += 1
        return context

    def command(self, identity, message):
        context = Context(identity['world_id'], identity['user_id'], identity['team_id'])
        # Chat and gameplay share the durable request-ID namespace.
        previous = self.db.command_result(identity, message)
        if previous is not None:
            return previous
        return apply_command(context, message, self.runtime(identity))

    def send_chat(self, identity, request_id, text):
        # Gameplay receipts may not have reached SQLite yet. Reserve their IDs
        # in the shared chat/game namespace before accepting a chat message.
        runtime = self.worlds.get(identity['world_id'])
        if runtime is not None and identity['user_id'] + ':' + request_id in runtime.state.command_results:
            return {'type': 'action.result', 'request_id': request_id,
                    'payload': {'ok': False, 'code': 'REQUEST_CONFLICT'}}, None
        return self.db.send_chat(identity, request_id, text)

    def dto(self, identity):
        context = Context(identity['world_id'], identity['user_id'], identity['team_id'])
        message = snapshot(context, self.runtime(identity))
        data = message['payload']
        data['self_id'], data['team_id'] = context.user_id, context.team_id
        data['generation'] = self.runtime(identity).state.generation
        data['simulation_time'] = message['tick'] * .05
        for player in data['players']:
            player['player_id'] = player.pop('user_id')
        for building in data['buildings']:
            building['position'] = ground_position(self.planet.cells[building['cell_id']].center, self.planet.radius,
                                                   seed=seed_from_world_id(identity['world_id']))
        data['world'] = dict(radius=self.planet.radius, move_speed=4, view_radius=12,
                             build_distance=4.5, total_bytes=self.total_bytes,
                             terrain=True, terrain_seed=seed_from_world_id(identity['world_id']),
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
        self.offer_ids = {}
        self.next_offer_id = 0
        self.chunk_cache = {}
        self.mountains = None

    async def offer(self, socket):
        if self.pending is not None:
            return
        data = self.service.dto(self.identity)
        if data == self.last:
            return
        payload = data
        if self.last is not None:
            payload = {key: value for key, value in data.items() if key != 'world'}
            for collection, id_key in [('players', 'player_id'), ('buildings', 'building_id'), ('rovers', 'rover_id')]:
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
        player = state.players[self.identity['user_id']]
        position = player.position
        mountains = frozenset(state.mountains)
        if mountains != self.mountains:
            self.chunk_cache.clear()
            self.mountains = mountains
        active = state.tick - player.input_tick < INPUT_TIMEOUT_TICKS
        ahead = move_on_surface(position, player.move, 3, self.service.planet.radius) if active else position
        normal, ahead_normal = unit(position), unit(ahead)
        def nearest(normal, points):
            cosine = max(sum(a * b for a, b in zip(normal, point)) for point in points)
            return self.service.planet.radius * math.acos(max(-1., min(1., cosine)))
        candidates = []
        for key, points in self.service.chunk_normals.items():
            distance = nearest(normal, points)
            if distance <= 12:
                ahead_distance = nearest(ahead_normal, points) if active else distance
                # Prefer terrain ahead while keeping nearby offered chunks stable.
                score = min(distance, ahead_distance) - (0.5 if key in self.offered else 0)
                candidates.append((score, key))
        selected, used = {}, 0
        for distance, key in sorted(candidates):
            if key not in self.chunk_cache:
                base = self.service.chunks[key]
                chunk = {**base, 'cells': [{**cell, 'surface': 'mountain' if cell['cell_id'] in mountains else cell['surface']}
                                           for cell in base['cells']]}
                self.chunk_cache[key] = chunk, byte_size(chunk)
            chunk, size = self.chunk_cache[key]
            if used + size > self.service.total_bytes * .04:
                continue
            selected[key] = chunk
            used += size
        for key in list(self.offered):
            if self.offered[key] != selected.get(key):
                await socket.send_json({'type': 'chunk.unload', 'payload': {'chunk_id': key}})
                del self.offered[key]
                self.released.discard(key)
                self.offer_ids.pop(key, None)
        for key, chunk in selected.items():
            if key not in self.offered or key in self.released:
                self.offered[key] = chunk
                self.released.discard(key)
                self.next_offer_id += 1
                self.offer_ids[key] = self.next_offer_id
                await socket.send_json({'type': 'chunk.offer', 'payload': {'chunk_id': key, 'byte_size': self.chunk_cache[key][1],
                                                                          'offer_id': self.next_offer_id}})
        # A connection should not retain overlays for the entire planet after traversal.
        for key in self.chunk_cache.keys() - {key for _, key in candidates}:
            del self.chunk_cache[key]

    async def chunk_request(self, socket, payload):
        key = payload.get('chunk_id') if isinstance(payload, dict) else None
        if (isinstance(key, str) and key in self.offered and key not in self.released
                and payload.get('offer_id', self.offer_ids[key]) == self.offer_ids[key]):
            await socket.send_json({'type': 'chunk.load', 'payload': self.offered[key]})

    def release(self, payload):
        key = payload.get('chunk_id') if isinstance(payload, dict) else None
        if (isinstance(key, str) and key in self.offered
                and payload.get('offer_id', self.offer_ids[key]) == self.offer_ids[key]):
            self.released.add(key)
