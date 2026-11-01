"""Compare persistence adapters using disposable SQLite databases.

Run from the repository: PYTHONPATH=server python tools/benchmark-persistence.py
For Docker: docker compose exec -T server python - < tools/benchmark-persistence.py
Each block represents 100 world updates; buffered mode flushes once per block.
This measures persistence submission cost, not full gameplay latency.
"""
from contextlib import contextmanager
from copy import deepcopy
import json
import os
from pathlib import Path
import statistics
import tempfile
import time
import uuid

from app.game.state import Player, WorldState
from app.storage import Database
from app.storage.buffered import BufferedGameWriter


class MeasuredDatabase(Database):
    @contextmanager
    def connect(self):
        with super().connect() as connection:
            def trace(sql):
                if sql == 'COMMIT':
                    self.commits += 1
                if sql.startswith('INSERT OR IGNORE INTO command_results'):
                    self.receipt_inserts += 1
            connection.set_trace_callback(trace)
            yield connection


def run(root, buffered):
    db = MeasuredDatabase(root / ('buffered.sqlite3' if buffered else 'direct.sqlite3'))
    db.commits = db.receipt_inserts = 0
    db.initialize()
    identities = [db.register('player' + str(i), b'salt', b'hash', 'session' + str(i), 3600) for i in range(4)]
    state = WorldState('demo-world', 'benchmark', stage='running')
    for identity in identities:
        state.players[identity['user_id']] = Player(identity['user_id'], identity['team_id'])
    for i in range(200):
        key = identities[i % 4]['user_id'] + ':' + str(uuid.uuid4())
        state.command_results[key] = {'fingerprint': 'benchmark', 'result': {
            'type': 'action.result', 'payload': {'ok': True, 'revision': i}}}
    db.commits = db.receipt_inserts = 0
    writer = BufferedGameWriter(db, interval=60) if buffered else None
    samples = []
    started = time.perf_counter()
    try:
        for i in range(300):
            state.tick = i + 1
            draft = deepcopy(state)
            call_started = time.perf_counter()
            (writer.submit if writer else db.save_game)(draft)
            samples.append((time.perf_counter() - call_started) * 1000)
            if writer and (i + 1) % 100 == 0:
                writer.flush()
    finally:
        if writer:
            writer.close()
    elapsed = time.perf_counter() - started
    restored = db.load_game('demo-world')
    assert restored['tick'] == 300
    assert len(restored['command_results']) == 200
    print(json.dumps({'adapter': 'buffered' if buffered else 'direct', 'updates': 300,
                      'snapshot_bytes': len(json.dumps(restored).encode()),
                      'submit_ms_median': round(statistics.median(samples), 4),
                      'submit_ms_p95': round(sorted(samples)[int(len(samples) * .95) - 1], 4),
                      'elapsed_seconds': round(elapsed, 3),
                      'commits': db.commits, 'receipt_insert_attempts': db.receipt_inserts}))


with tempfile.TemporaryDirectory(prefix='mars-persistence-bench-', dir=os.environ.get('DATA_DIR')) as directory:
    for buffered in (False, True):
        run(Path(directory), buffered)
