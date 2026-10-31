from contextlib import ExitStack
import uuid

from app.lobby import Lobby
from test_server import client, register, ORIGIN


def read(ws, kind, predicate=lambda payload: True):
    for _ in range(200):
        message = ws.receive_json()
        if message['type'] == 'world.offer':
            ws.send_json({'type': 'world.accept', 'payload': {}})
        if message['type'] == kind and predicate(message['payload']):
            return message['payload']
    raise AssertionError('Expected message did not arrive: ' + kind)


def open_player(client, stack, token):
    ws = stack.enter_context(client.websocket_connect('/ws', headers={
        'origin': ORIGIN, 'cookie': f'mars_session={token}'}))
    assert ws.receive_json()['type'] == 'session.ready'
    ws.send_json({'type': 'world.subscribe', 'payload': {}})
    read(ws, 'world.snapshot')
    return ws


def ready(ws, value=True):
    ws.send_json({'type': 'lobby.ready', 'payload': {'ready': value}})


def test_four_players_vote_cancel_and_start_together(client):
    accounts = [register(client, 'lobby_' + str(i)) for i in range(4)]
    with ExitStack() as stack:
        sockets = [open_player(client, stack, token) for _, token in accounts]
        roster = read(sockets[0], 'lobby.state', lambda state: len(state['players']) == 4)
        assert not any(player['ready'] for player in roster['players'])
        sockets[0].send_json({'type': 'world.start', 'request_id': str(uuid.uuid4()), 'payload': {}})
        assert read(sockets[0], 'action.result')['code'] == 'READY_REQUIRED'
        sockets[0].send_json({'type': 'lobby.ready', 'payload': {'ready': 'true'}})
        assert read(sockets[0], 'lobby.error')['code'] == 'INVALID_ARGUMENT'
        sockets[0].send_json({'type': 'lobby.profile', 'payload': {'color': 2, 'variant': 7}})
        roster = read(sockets[3], 'lobby.state', lambda state: any(
            player['avatar'] == {'color': 2, 'variant': 7} for player in state['players']))
        assert next(p for p in roster['players'] if p['avatar'])['username'] == 'lobby_0'
        for ws in sockets[:3]:
            ready(ws)
        roster = read(sockets[3], 'lobby.state', lambda state: sum(p['ready'] for p in state['players']) == 3)
        assert roster['stage'] == 'lobby'
        ready(sockets[0], False)
        read(sockets[3], 'lobby.state', lambda state: sum(p['ready'] for p in state['players']) == 2)
        ready(sockets[3])
        roster = read(sockets[0], 'lobby.state', lambda state: sum(p['ready'] for p in state['players']) == 3)
        assert roster['stage'] == 'lobby'
        ready(sockets[0])
        for ws in sockets:
            state = read(ws, 'lobby.state', lambda state: state['stage'] == 'running')
            assert all(player['ready'] for player in state['players'])


def test_duplicate_tabs_disconnect_and_reconnect(client):
    alice, a_token = register(client, 'alice_lobby')
    _, b_token = register(client, 'bob_lobby')
    with ExitStack() as stack:
        a = open_player(client, stack, a_token)
        b = open_player(client, stack, b_token)
        duplicate = open_player(client, stack, a_token)
        ready(a)
        state = read(b, 'lobby.state', lambda state: any(p['ready'] for p in state['players']))
        assert len(state['players']) == 2
        duplicate.close()
        # Closing one tab preserves the account's readiness.
        b.send_json({'type': 'lobby.profile', 'payload': {'color': 0, 'variant': 0}})
        state = read(b, 'lobby.state', lambda state: any(p['avatar'] for p in state['players']))
        assert next(p for p in state['players'] if p['user_id'] == alice['user_id'])['ready']
        a.close()
        read(b, 'lobby.state', lambda state: len(state['players']) == 1)
        again = open_player(client, stack, a_token)
        state = read(b, 'lobby.state', lambda state: len(state['players']) == 2)
        assert not any(p['ready'] for p in state['players'])
        ready(b)
        state = read(again, 'lobby.state', lambda state: any(p['ready'] for p in state['players']))
        assert state['stage'] == 'lobby'
        ready(again)
        read(b, 'lobby.state', lambda state: state['stage'] == 'running')


def test_world_isolation_and_loading_barrier():
    class Game:
        worlds = {}
        def command(self, identity, command):
            self.started = identity['world_id']
            return {'payload': {'ok': True}}
    game = Game()
    lobby = Lobby(game)
    a = {'world_id': 'one', 'user_id': 'a', 'username': 'alice'}
    b = {'world_id': 'one', 'user_id': 'b', 'username': 'bob'}
    c = {'world_id': 'two', 'user_id': 'c', 'username': 'carol'}
    for socket, identity in [(1, a), (2, b), (3, c)]:
        lobby.connect(socket, identity)
    lobby.loaded.add(1)
    assert lobby.set_ready(2, {'ready': True}) == 'NOT_READY'
    lobby.set_ready(1, {'ready': True})
    assert not hasattr(game, 'started')
    assert len(lobby.players('one')) == 2
    # An unready disconnect leaves only the player who already voted.
    lobby.disconnect(2)
    assert game.started == 'one'
    assert not lobby.players('two')[0]['ready']

def test_saved_running_world_requires_new_votes():
    from types import SimpleNamespace
    game = SimpleNamespace(worlds={'saved': SimpleNamespace(state=SimpleNamespace(stage='running'))})
    lobby = Lobby(game)
    alice = {'world_id': 'saved', 'user_id': 'a', 'username': 'alan'}
    bob = {'world_id': 'saved', 'user_id': 'b', 'username': 'bob'}
    lobby.connect(1, alice)
    lobby.connect(2, bob)
    lobby.loaded.update([1, 2])
    assert lobby.stage('saved') == 'lobby'
    lobby.set_ready(1, {'ready': True})
    assert lobby.stage('saved') == 'lobby'
    lobby.set_ready(2, {'ready': True})
    assert lobby.stage('saved') == 'running'
    lobby.disconnect(1)
    lobby.connect(3, alice)
    lobby.loaded.add(3)
    assert lobby.stage('saved') == 'lobby'
    assert not next(p for p in lobby.players('saved') if p['user_id'] == 'a')['ready']
    lobby.set_ready(3, {'ready': True})
    assert lobby.stage('saved') == 'running'
    lobby.disconnect(3)
    lobby.disconnect(2)
    lobby.connect(4, alice)
    lobby.loaded.add(4)
    assert lobby.stage('saved') == 'lobby'