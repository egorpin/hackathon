import json
import subprocess
import uuid

from app.storage import Database
from app.transport import GameService, Stream, byte_size
from app.game import Context, apply_command
from app.game.state import STARTING_RESOURCES
from app.world.geometry import move_on_surface


def test_restart_persists_and_replays_without_regrant(tmp_path):
    db = Database(tmp_path / 'restart.sqlite3')
    db.initialize()
    identity = db.register('alice', b'salt', b'hash', 'session', 3600)
    service = GameService(db)
    service.join(identity)
    start = {'type': 'world.start', 'request_id': str(uuid.uuid4()), 'payload': {}}
    assert service.command(identity, start)['payload']['ok']
    runtime = service.runtime(identity)
    with runtime.transaction() as state:
        state.players[identity['user_id']].seq = 9
        state.players[identity['user_id']].inventory['iron'] = 7
        state.team_storage[identity['team_id']]['iron'] = 1
        state.oxygen_percent = 43
    restart = {'type': 'world.restart', 'request_id': str(uuid.uuid4()), 'payload': {}}
    result = service.command(identity, restart)
    assert result['payload'] == {'ok': True, 'generation': 1}
    restored = GameService(db)
    restored.join(identity)
    state = restored.runtime(identity).state
    assert state.stage == 'lobby' and state.oxygen_percent == 0 and state.generation == 1
    assert state.players[identity['user_id']].seq == 9
    assert state.players[identity['user_id']].inventory['iron'] == 0
    assert all(state.team_storage[identity['team_id']][key] == value
               for key, value in STARTING_RESOURCES.items())
    assert restored.command(identity, restart) == result
    assert restored.runtime(identity).state.generation == 1
    assert restored.command(identity, start)['payload']['ok']  # historical replay does not start it
    assert restored.runtime(identity).state.stage == 'lobby'
    fresh_start = {**start, 'request_id': str(uuid.uuid4())}
    assert restored.command(identity, fresh_start)['payload']['ok']
    stale = {'type': 'player.input', 'payload': {'seq': 9, 'move': [1, 0, 0]}}
    assert restored.command(identity, stale)['payload']['code'] == 'STALE_INPUT'


def test_restart_rejects_other_teams_and_wrong_world(tmp_path):
    db = Database(tmp_path / 'teams.sqlite3')
    db.initialize()
    identity = db.register('alice', b'salt', b'hash', 'session', 3600)
    service = GameService(db)
    service.join(identity)
    runtime = service.runtime(identity)
    runtime.enroll(Context(identity['world_id'], 'other', 'other-team'))
    restart = {'type': 'world.restart', 'request_id': str(uuid.uuid4()), 'payload': {}}
    assert service.command(identity, restart)['payload']['code'] == 'FORBIDDEN'
    wrong = Context('another-world', identity['user_id'], identity['team_id'])
    assert apply_command(wrong, restart, runtime)['payload']['code'] == 'UNAUTHORIZED'
    assert runtime.state.generation == 0


def test_late_join_claims_and_clears_mountain_once(tmp_path):
    db = Database(tmp_path / 'late.sqlite3')
    db.initialize()
    alice = db.register('alice', b'salt', b'hash', 'session', 3600)
    service = GameService(db)
    service.join(alice)
    assert service.command(alice, {'type': 'world.start', 'request_id': str(uuid.uuid4()),
                                   'payload': {}})['payload']['ok']
    bob = {**alice, 'user_id': 'bob'}
    service.join(bob)
    state = service.runtime(alice).state
    assert state.stage == 'running' and len(state.mountains) == 2
    assert state.players['bob'].position is not None
    assert all(state.team_storage[alice['team_id']][key] == 2 * value
               for key, value in STARTING_RESOURCES.items())
    service.join(bob)
    assert service.runtime(alice).state.team_storage == state.team_storage
    restored = GameService(db)
    restored.join(bob)
    assert restored.runtime(alice).state.players['bob'].position == state.players['bob'].position


def test_game_persistence_and_shared_chat_request_ids(tmp_path):
    db = Database(tmp_path / 'game.sqlite3')
    db.initialize()
    identity = db.register('alice', b'salt', b'hash', 'session', 3600)
    service = GameService(db)
    service.join(identity)
    command = {'type': 'world.start', 'request_id': str(uuid.uuid4()), 'payload': {}}
    result = service.command(identity, command)
    assert result['payload']['ok']
    restored = GameService(db)
    restored.join(identity)
    assert restored.dto(identity)['stage'] == 'running'
    assert restored.command(identity, command) == result
    assert db.send_chat(identity, command['request_id'], 'collision')[0]['payload']['code'] == 'REQUEST_CONFLICT'
    chat_id = str(uuid.uuid4())
    db.send_chat(identity, chat_id, 'hello')
    assert restored.command(identity, {**command, 'request_id': chat_id})['payload']['code'] == 'REQUEST_CONFLICT'


def test_all_chunk_sizes_match_javascript(tmp_path):
    db = Database(tmp_path / 'game.sqlite3')
    db.initialize()
    service = GameService(db)
    chunks = list(service.chunks.values())
    measured = subprocess.run(['node', '--input-type=module', '-e',
        "let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(x=>Buffer.byteLength(JSON.stringify(x)))));"],
        input=json.dumps(chunks), text=True, capture_output=True, check=True)
    assert json.loads(measured.stdout) == [byte_size(chunk) for chunk in chunks]


def test_resource_overlay_restores_legacy_save(tmp_path):
    db = Database(tmp_path / 'legacy.sqlite3')
    db.initialize()
    identity = db.register('alice', b'salt', b'hash', 'session', 3600)
    service = GameService(db)
    service.join(identity)
    legacy = service.runtime(identity).state
    legacy.map_version = service.planet.version.removesuffix('-resources-v2')
    legacy.economy_version = 1
    legacy.players[identity['user_id']].inventory = {'ore': 17}
    legacy.team_storage[identity['team_id']] = {'ore': 3}
    db.save_game(legacy)
    restored = GameService(db)
    restored.join(identity)
    dto = restored.dto(identity)
    assert dto['map_version'] == restored.planet.version
    assert dto['inventory'] == {'ore': 0, 'water': 0, 'sulfur': 0, 'iron': 0, 'oxygen': 0, 'copper': 0}
    assert dto['team_storage']['ore'] == 0
    assert dto['team_storage']['iron'] == 20
    assert dto['config']['oxygen_enabled'] is True
    assert {cell['resource'] for chunk in restored.chunks.values() for cell in chunk['cells']} == {None, 'water', 'iron', 'sulfur', 'copper'}


def test_small_coordinates_match_browser_byte_reservations():
    values = [{'position': [0.000001, -0.000012, 0.0001], 'text': 'Марс 🚀'},
              [1.0, -0.0, 1e-7, 1e20, 1e21]]
    measured = subprocess.run(['node', '--input-type=module', '-e',
        "let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(x=>Buffer.byteLength(JSON.stringify(x)))));"],
        input=json.dumps(values), text=True, capture_output=True, check=True)
    assert json.loads(measured.stdout) == [byte_size(value) for value in values]


def test_stream_jump_reoffers_released_chunks_and_rejects_stale_requests(tmp_path):
    db = Database(tmp_path / 'stream.sqlite3')
    db.initialize()
    identity = db.register('alice', b'salt', b'hash', 'session', 3600)
    service = GameService(db)
    service.join(identity)
    stream = Stream(service, identity)
    stream.last = service.dto(identity)
    chunk_limit = service.total_bytes * .10 - 2 * byte_size(stream.last) - service.total_bytes * .01
    player = service.runtime(identity).state.players[identity['user_id']]

    class Socket:
        def __init__(self): self.messages = []
        async def send_json(self, message): self.messages.append(message)

    async def exercise():
        socket = Socket()
        await stream.chunks(socket)
        initial = set(stream.offered)
        assert initial and len(initial) >= 2
        assert sum(byte_size(chunk) for chunk in stream.offered.values()) <= chunk_limit
        offer = next(message['payload'] for message in socket.messages if message['type'] == 'chunk.offer')
        offers = [message['payload'] for message in socket.messages if message['type'] == 'chunk.offer']
        for item in offers:
            await stream.chunk_request(socket, item)
        assert sum(message['type'] == 'chunk.load' for message in socket.messages) >= 2
        socket.messages.clear()
        stream.release({'chunk_id': offer['chunk_id'], 'offer_id': offer['offer_id']})
        socket.messages.clear()
        player.position = tuple(component * 1.05 for component in player.position)
        await stream.chunks(socket)
        assert set(stream.offered) == initial  # altitude does not change surface interest
        replacement = next(message['payload'] for message in socket.messages if message['type'] == 'chunk.offer')
        assert replacement['chunk_id'] == offer['chunk_id'] and replacement['offer_id'] != offer['offer_id']
        socket.messages.clear()
        await stream.chunk_request(socket, {'chunk_id': offer['chunk_id'], 'offer_id': offer['offer_id']})
        assert socket.messages == []
        stream.release({'chunk_id': offer['chunk_id'], 'offer_id': offer['offer_id']})
        await stream.chunk_request(socket, {'chunk_id': replacement['chunk_id'], 'offer_id': replacement['offer_id']})
        assert socket.messages[0]['type'] == 'chunk.load'
        # Sprint around the surface with intermittent radial jump offsets and
        # a direction reversal; the server must keep a bounded working set.
        for i in range(30):
            player.move = (0., 0., 1. if i < 15 else -1.)
            player.input_tick = service.runtime(identity).state.tick
            player.position = move_on_surface(player.position, player.move, .3, service.planet.radius)
            if i % 4 == 0:
                player.position = tuple(component * 1.04 for component in player.position)
            await stream.chunks(socket)
            assert sum(byte_size(chunk) for chunk in stream.offered.values()) <= chunk_limit
            assert len(stream.chunk_cache) <= len(service.chunks)

    # The fake socket completes immediately, so no event loop or OS sockets
    # are required by this deterministic transport test.
    coroutine = exercise()
    try:
        coroutine.send(None)
    except StopIteration:
        pass
    else:
        raise AssertionError('fake socket unexpectedly suspended')
