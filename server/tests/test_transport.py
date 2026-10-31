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
