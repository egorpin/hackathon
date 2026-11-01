from threading import Event
import sqlite3
import uuid

import pytest
from fastapi.testclient import TestClient

from app import main
from app.game.state import WorldState
from app.storage import Database
from app.storage.buffered import BufferedGameWriter
from app.transport import GameService


@pytest.fixture
def storage(tmp_path):
    db = Database(tmp_path / 'buffered.sqlite3')
    db.initialize()
    identity = db.register('alice', b'salt', b'hash', 'session', 3600)
    return db, identity


def test_coalesces_and_flushes_on_close(storage):
    db, identity = storage
    batches = []
    original = db.save_game_batch

    def save(connection, states, known):
        batches.append([state.tick for state in states])
        original(connection, states, known)

    db.save_game_batch = save
    writer = BufferedGameWriter(db, interval=60)
    service = GameService(db, persist=writer.submit)
    service.join(identity)
    request = {'type': 'world.start', 'request_id': str(uuid.uuid4()), 'payload': {}}
    result = service.command(identity, request)
    for _ in range(20):
        with service.runtime(identity).transaction() as state:
            state.tick += 1
    assert db.load_game(identity['world_id']) is None
    assert service.command(identity, request) == result
    writer.close()
    assert batches == [[20]]
    assert db.load_game(identity['world_id'])['tick'] == 20
    assert db.command_result(identity, request) == result
    restored = GameService(db)
    assert restored.command(identity, request) == result
    assert restored.runtime(identity).state.tick == 20


def test_periodic_flush(storage):
    db, identity = storage
    committed = Event()
    original = db.save_game_batch

    def save(*args):
        original(*args)
        committed.set()

    db.save_game_batch = save
    writer = BufferedGameWriter(db, interval=.02)
    try:
        writer.submit(WorldState(identity['world_id'], 'test', tick=7))
        assert committed.wait(5)
        assert db.load_game(identity['world_id'])['tick'] == 7
    finally:
        writer.close()


def test_inflight_write_does_not_block_or_discard_newer_draft(storage):
    db, identity = storage
    entered, release = Event(), Event()
    original = db.save_game_batch

    def slow_save(*args):
        entered.set()
        assert release.wait(5)
        original(*args)

    db.save_game_batch = slow_save
    writer = BufferedGameWriter(db, interval=.02)
    try:
        writer.submit(WorldState(identity['world_id'], 'test', tick=1))
        assert entered.wait(5)
        writer.submit(WorldState(identity['world_id'], 'test', tick=2))
        release.set()
        writer.flush()
        assert db.load_game(identity['world_id'])['tick'] == 2
    finally:
        release.set()
        writer.close()


def test_failure_retains_latest_draft_and_retries(storage):
    db, identity = storage
    original = db.save_game_batch

    def fail(*args):
        raise sqlite3.OperationalError('disk unavailable')

    writer = BufferedGameWriter(db, interval=60)
    try:
        db.save_game_batch = fail
        writer.submit(WorldState(identity['world_id'], 'test', tick=1))
        with pytest.raises(RuntimeError, match='Could not flush'):
            writer.flush()
        writer.submit(WorldState(identity['world_id'], 'test', tick=2))
        db.save_game_batch = original
        writer.flush()
        assert db.load_game(identity['world_id'])['tick'] == 2
    finally:
        db.save_game_batch = original
        writer.close()


def test_failed_inflight_batch_cannot_replace_newer_draft(storage):
    db, identity = storage
    entered, release, committed = Event(), Event(), Event()
    original = db.save_game_batch
    attempts = []

    def save(connection, states, known):
        attempts.append(states[0].tick)
        if len(attempts) == 1:
            entered.set()
            assert release.wait(5)
            raise sqlite3.OperationalError('temporary failure')
        original(connection, states, known)
        committed.set()

    db.save_game_batch = save
    writer = BufferedGameWriter(db, interval=.02)
    try:
        writer.submit(WorldState(identity['world_id'], 'test', tick=1))
        assert entered.wait(5)
        writer.submit(WorldState(identity['world_id'], 'test', tick=2))
        release.set()
        assert committed.wait(5)
        assert attempts == [1, 2]
        assert db.load_game(identity['world_id'])['tick'] == 2
    finally:
        release.set()
        writer.close()


def test_multiple_worlds_share_one_transaction(storage):
    db, identity = storage
    with db.connect() as connection:
        connection.execute("INSERT INTO worlds(id, map_version, stage) VALUES ('second', 'test', 'running')")
    batches = []
    original = db.save_game_batch

    def save(connection, states, known):
        statements = []
        connection.set_trace_callback(statements.append)
        original(connection, states, known)
        batches.append(statements)

    db.save_game_batch = save
    writer = BufferedGameWriter(db, interval=60)
    writer.submit(WorldState(identity['world_id'], 'test', tick=4))
    writer.submit(WorldState('second', 'test', tick=8))
    writer.close()
    assert len(batches) == 1
    assert batches[0].count('COMMIT') == 1
    assert db.load_game(identity['world_id'])['tick'] == 4
    assert db.load_game('second')['tick'] == 8


def test_shutdown_reports_failed_flush(storage):
    db, identity = storage
    writer = BufferedGameWriter(db, interval=60)
    writer.submit(WorldState(identity['world_id'], 'test'))
    db.save_game_batch = lambda *args: (_ for _ in ()).throw(OSError('disk full'))
    with pytest.raises(RuntimeError, match='Final game state flush failed'):
        writer.close()
    with pytest.raises(RuntimeError, match='closed'):
        writer.submit(WorldState(identity['world_id'], 'test'))


def test_batch_rolls_back_world_and_receipt_together(storage):
    db, identity = storage
    state = WorldState(identity['world_id'], 'test')
    key = identity['user_id'] + ':' + str(uuid.uuid4())
    state.command_results[key] = {'fingerprint': 'test', 'result': {'ok': True}}
    known = {}
    with db.connect() as connection:
        connection.execute("CREATE TRIGGER reject_receipt BEFORE INSERT ON command_results "
                           "BEGIN SELECT RAISE(ABORT, 'simulated failure'); END")
        with pytest.raises(sqlite3.IntegrityError):
            db.save_game_batch(connection, [state], known)
        assert db.load_game(identity['world_id']) is None
        assert key not in known[identity['world_id']]
        connection.execute('DROP TRIGGER reject_receipt')
        db.save_game_batch(connection, [state], known)
    assert key in known[identity['world_id']]
    assert db.load_game(identity['world_id'])['command_results'][key]['result'] == {'ok': True}


def test_existing_receipts_are_not_reinserted(storage):
    db, identity = storage
    state = WorldState(identity['world_id'], 'test')
    key = identity['user_id'] + ':' + str(uuid.uuid4())
    state.command_results[key] = {'fingerprint': 'test', 'result': {'ok': True}}
    known = {}
    with db.connect() as connection:
        db.save_game_batch(connection, [state], known)
        connection.execute("CREATE TRIGGER reject_receipt BEFORE INSERT ON command_results "
                           "BEGIN SELECT RAISE(ABORT, 'unexpected insert'); END")
        state.tick += 1
        db.save_game_batch(connection, [state], known)
        # A new writer also skips receipts already in the database.
        db.save_game_batch(connection, [state], {})
    assert db.load_game(identity['world_id'])['tick'] == 1


def test_chat_cannot_take_pending_game_request_id(storage):
    db, identity = storage
    writer = BufferedGameWriter(db, interval=60)
    try:
        service = GameService(db, persist=writer.submit)
        service.join(identity)
        request = {'type': 'world.start', 'request_id': str(uuid.uuid4()), 'payload': {}}
        result = service.command(identity, request)
        assert db.command_result(identity, request) is None
        conflict, event = service.send_chat(identity, request['request_id'], 'collision')
        assert conflict['payload']['code'] == 'REQUEST_CONFLICT'
        assert event is None
        assert service.command(identity, request) == result
        chat_id = str(uuid.uuid4())
        service.send_chat(identity, chat_id, 'hello')
        assert service.command(identity, {**request, 'request_id': chat_id})['payload']['code'] == 'REQUEST_CONFLICT'
    finally:
        writer.close()


def test_lifespan_flushes_on_shutdown(tmp_path, monkeypatch):
    db = Database(tmp_path / 'lifespan.sqlite3')
    monkeypatch.setattr(main, 'db', db)
    with TestClient(main.app) as client:
        identity = client.post('/api/auth/register', headers={'origin': 'http://localhost:8000'},
                               json={'username': 'alice', 'password': 'longpassword'}).json()
        main.app.state.game.join(identity)
        with main.app.state.game.runtime(identity).transaction() as state:
            state.oxygen_percent = 17
    assert db.load_game(identity['world_id'])['oxygen_percent'] == 17
    assert not main.app.state.game_writer._thread.is_alive()
