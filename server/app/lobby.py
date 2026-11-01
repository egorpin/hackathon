"""Ephemeral, world-scoped readiness. All mutations run on the ASGI event loop."""
import uuid


class Lobby:
    def __init__(self, game):
        self.game = game
        self.members = {}
        self.loaded = set()
        self.ready = set()
        self.profiles = {}
        self.active = set()

    def connect(self, socket, identity):
        self.members[socket] = dict(identity)

    def key(self, identity):
        return identity['world_id'], identity['user_id']

    def disconnect(self, socket):
        identity = self.members.pop(socket, None)
        self.loaded.discard(socket)
        if identity is None:
            return None
        key = self.key(identity)
        if not any(self.key(member) == key for member in self.members.values()):
            self.ready.discard(key)
            self.profiles.pop(key, None)
        if not self.players(identity['world_id']):
            self.active.discard(identity['world_id'])
        self.maybe_start(identity)
        return identity['world_id']

    def players(self, world_id):
        # Several tabs of one account are one player, with one ready flag.
        members = {identity['user_id']: identity for identity in self.members.values()
                   if identity['world_id'] == world_id}
        return [dict(user_id=user_id, username=identity['username'],
                     ready=self.key(identity) in self.ready,
                     avatar=self.profiles.get(self.key(identity)))
                for user_id, identity in sorted(members.items(), key=lambda item: item[1]['username'].lower())]

    def restart(self, world_id):
        self.active.discard(world_id)
        self.ready = {key for key in self.ready if key[0] != world_id}

    def stage(self, world_id):
        return 'running' if world_id in self.active else 'lobby'

    def state(self, world_id):
        return {'type': 'lobby.state', 'payload': {
            'players': self.players(world_id), 'stage': self.stage(world_id)}}

    def set_ready(self, socket, payload):
        identity = self.members[socket]
        if not isinstance(payload, dict) or set(payload) != {'ready'} or type(payload['ready']) is not bool:
            return 'INVALID_ARGUMENT'
        if socket not in self.loaded:
            return 'NOT_READY'
        if self.stage(identity['world_id']) != 'lobby':
            return 'ALREADY_STARTED'
        key = self.key(identity)
        if payload['ready']:
            self.ready.add(key)
        else:
            self.ready.discard(key)
        return self.maybe_start(identity)

    def set_profile(self, socket, payload):
        if (not isinstance(payload, dict) or set(payload) != {'color', 'variant'}
                or type(payload['color']) is not int or not 0 <= payload['color'] < 6
                or type(payload['variant']) is not int or not 0 <= payload['variant'] < 10000):
            return 'INVALID_ARGUMENT'
        self.profiles[self.key(self.members[socket])] = dict(payload)

    def maybe_start(self, identity):
        world_id = identity['world_id']
        players = self.players(world_id)
        if self.stage(world_id) != 'lobby' or not players or not all(player['ready'] for player in players):
            return None
        loaded_users = {self.key(self.members[socket]) for socket in self.loaded}
        if any((world_id, player['user_id']) not in loaded_users for player in players):
            return None
        # Check and transition contain no await: a new connection cannot race the vote.
        starter = next(member for member in self.members.values() if member['world_id'] == world_id)
        runtime = self.game.worlds.get(world_id)
        if runtime and runtime.state.stage == 'running':
            self.active.add(world_id)
            return None
        result = self.game.command(starter, {
            'type': 'world.start', 'request_id': str(uuid.uuid4()), 'payload': {}})
        if result['payload']['ok']:
            self.active.add(world_id)
        else:
            self.ready.difference_update((world_id, player['user_id']) for player in players)
            return result['payload']['code']
