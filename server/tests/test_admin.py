import time

import pytest
from fastapi.testclient import TestClient
from app import main
from app.game.state import WorldState
from app.game.rover import new_rover
from app.storage import Database

TOKEN = 'admin-test-token-with-enough-entropy'
HEADERS = {'authorization': 'Bearer '+TOKEN, 'origin': 'http://localhost:8000'}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, 'db', Database(tmp_path / 'mars.sqlite3'))
    monkeypatch.setenv('MARS_ADMIN_TOKEN', TOKEN)
    with TestClient(main.app) as client:
        yield client


def register(client):
    return client.post('/api/auth/register', headers=HEADERS,
                       json={'username': 'admin_test', 'password': 'longpassword'}).json()


def edit_payload(data):
    return {k: data[k] for k in ('version', 'paused', 'oxygen_percent', 'team_storage', 'characters', 'active_character')}


def test_access_and_world_persistence(client):
    assert client.get('/admin').status_code == 200
    assert client.get('/api/admin/overview').status_code == 401
    identity = register(client)
    assert client.get('/api/admin/overview').status_code == 401  # Player cookie grants no admin access.
    main.app.state.game.join(identity)
    path = '/api/admin/worlds/'+identity['world_id']
    response = client.get(path, headers=HEADERS)
    assert response.headers['cache-control'] == 'no-store'
    payload = edit_payload(response.json())
    payload.update(paused=True, oxygen_percent=42)
    payload['characters'][0]['prompt'] = 'Ты — геолог.'
    assert client.put(path, headers={'authorization': HEADERS['authorization']}, json=payload).status_code == 403
    invalid = dict(payload, oxygen_percent=101)
    assert client.put(path, headers=HEADERS, json=invalid).status_code == 422
    assert client.put(path, headers=HEADERS, json=payload).status_code == 200
    assert client.put(path, headers=HEADERS, json=payload).status_code == 409
    restored = WorldState.from_dict(main.db.load_game(identity['world_id']))
    assert restored.admin_paused and restored.oxygen_percent == 42
    assert restored.admin_characters[0]['prompt'] == 'Ты — геолог.'
    dto = main.app.state.game.dto(identity)
    assert 'admin_characters' not in dto and 'Ты — геолог.' not in str(dto)
    payload['version'] += 1
    payload['team_storage'][identity['team_id']]['iron'] = -1
    assert client.put(path, headers=HEADERS, json=payload).status_code == 422
    assert main.app.state.game.runtime(identity).state.admin_version == 1


def test_character_behavior_and_separate_history(client, monkeypatch):
    identity = register(client)
    path = '/api/admin/worlds/'+identity['world_id']
    calls = []
    monkeypatch.setattr(main.agent, 'complete', lambda history, text, context: calls.append((history, context)) or 'Ответ')
    assert client.post('/api/agent/ask', headers=HEADERS, json={'text':'Первый'}).status_code == 200
    payload = edit_payload(client.get(path, headers=HEADERS).json())
    payload['characters'].append(dict(id='geologist',name='Геолог',enabled=True,prompt='Изучай камни',temperature=.1))
    payload['active_character'] = 'geologist'
    assert client.put(path, headers=HEADERS, json=payload).status_code == 200
    assert client.get('/api/agent/messages').json()['messages'] == []
    assert client.post('/api/agent/ask', headers=HEADERS, json={'text':'Второй'}).status_code == 200
    assert calls[-1][0] == []
    assert calls[-1][1]['_character']['prompt'] == 'Изучай камни'
    payload['version'] += 1
    payload['characters'][1]['enabled'] = False
    assert client.put(path, headers=HEADERS, json=payload).status_code == 200
    assert client.post('/api/agent/ask', headers=HEADERS, json={'text':'Третий'}).status_code == 503


def test_all_connections_telemetry_and_disconnect(client):
    register(client)
    with client.websocket_connect('/ws', headers=HEADERS) as first:
        assert first.receive_json()['type'] == 'session.ready'
        with client.websocket_connect('/ws', headers=HEADERS) as second:
            assert second.receive_json()['type'] == 'session.ready'
            first.send_json({'type':'telemetry.report','payload':{'fps':59.5,'frameP95':18,'drawCalls':42}})
            probe = first.receive_json()
            assert probe['type'] == 'telemetry.ping'
            first.send_json({'type':'telemetry.pong','payload':probe['payload']})
            for _ in range(30):
                clients = client.get('/api/admin/overview', headers=HEADERS).json()['clients']
                measured = next(c for c in clients if c.get('fps') is not None)
                if measured['ping_ms'] is not None:
                    break
                time.sleep(.01)
            assert len(clients) == 2
            assert len({c['connection_id'] for c in clients}) == 2
            assert measured['fps'] == 59.5 and measured['ping_ms'] >= 0
            assert 'session_token' not in str(clients)
        assert len(client.get('/api/admin/overview', headers=HEADERS).json()['clients']) == 1
    assert client.get('/api/admin/overview', headers=HEADERS).json()['clients'] == []


def test_rover_validation_control_and_conflict(client):
    identity = register(client)
    runtime = main.app.state.game.runtime(identity)
    rover = new_rover(identity['team_id'], (30.,0.,0.), '#ff6b4a')
    with runtime.transaction() as state:
        state.rovers[rover['rover_id']] = rover
    path = f"/api/admin/worlds/{identity['world_id']}/rovers/{rover['rover_id']}"
    data = dict(expected_revision=0, program='invalid code', action='start')
    assert client.put(path, headers=HEADERS, json=data).status_code == 422
    data['program'] = 'wait(1)'
    assert client.put(path, headers=HEADERS, json=data).status_code == 200
    assert runtime.state.rovers[rover['rover_id']]['status'] == 'running'
    assert client.put(path, headers=HEADERS, json=data).status_code == 409
    data.update(expected_revision=1,action='stop')
    assert client.put(path, headers=HEADERS, json=data).status_code == 200
    assert runtime.state.rovers[rover['rover_id']]['status'] == 'idle'


def test_generated_key_survives_restart(tmp_path, monkeypatch):
    from app import admin
    monkeypatch.delenv('MARS_ADMIN_TOKEN', raising=False)
    admin.initialize(main.app, tmp_path)
    original = main.app.state.admin_key
    assert (tmp_path/'admin.key').stat().st_mode & 0o777 == 0o600
    admin.initialize(main.app, tmp_path)
    assert main.app.state.admin_key == original
