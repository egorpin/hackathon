import json
import subprocess
import uuid

from app.storage import Database
from app.transport import GameService, byte_size


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
