import pytest
from fastapi.testclient import TestClient
from app import main
from app.storage import Database

ORIGIN = {'origin': 'http://localhost:8000'}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, 'db', Database(tmp_path / 'test.sqlite3'))
    main.agent_busy.clear()
    with TestClient(main.app) as client:
        yield client
    main.agent_busy.clear()


def register(client, name):
    response = client.post('/api/auth/register', headers=ORIGIN,
                           json={'username': name, 'password': 'longpassword'})
    assert response.status_code == 201
    return response.json()


def test_agent_auth_and_private_history(client, monkeypatch):
    assert client.get('/api/agent/messages').status_code == 401
    assert client.post('/api/agent/ask', headers=ORIGIN, json={'text': 'hi'}).status_code == 401
    alice = register(client, 'alice')
    main.app.state.game.join(alice)
    calls = []

    def complete(history, text, context):
        calls.append((history, text, context))
        return 'Стройте бур рядом с ресурсной жилой.'

    monkeypatch.setattr(main.agent, 'complete', complete)
    assert client.post('/api/agent/ask', json={'text': 'hello'}).status_code == 403
    assert client.post('/api/agent/ask', headers=ORIGIN, json={'text': '   '}).status_code == 422
    response = client.post('/api/agent/ask', headers=ORIGIN, json={'text': 'Где строить бур?'})
    assert response.status_code == 200
    assert calls[0][2]['stage'] == 'lobby'
    assert 'inventory' in calls[0][2]
    assert calls[0][2]['team_storage']['iron'] == 100
    assert calls[0][2]['oxygen_percent'] == 0
    assert calls[0][2]['config']['recipes']['drill'] == {'iron': 5}
    messages = client.get('/api/agent/messages').json()['messages']
    assert [m['role'] for m in messages] == ['user', 'assistant']
    assert response.json()['text'] == messages[1]['text']
    client.post('/api/agent/ask', headers=ORIGIN, json={'text': 'А дальше?'})
    assert calls[1][0] == messages
    register(client, 'bob')
    assert client.get('/api/agent/messages').json()['messages'] == []


def test_agent_failure_and_busy_do_not_save_fake_answers(client, monkeypatch):
    identity = register(client, 'alice')

    def unavailable(*args):
        raise OSError('offline')

    monkeypatch.setattr(main.agent, 'complete', unavailable)
    response = client.post('/api/agent/ask', headers=ORIGIN, json={'text': 'Привет'})
    assert response.status_code == 503
    assert not main.agent_busy
    assert client.get('/api/agent/messages').json()['messages'] == []
    main.agent_busy.add(identity['user_id'])
    assert client.post('/api/agent/ask', headers=ORIGIN, json={'text': 'Привет'}).status_code == 429


def test_boss_registration_history_and_disabled_character(client, monkeypatch):
    identity = register(client, 'bossuser')
    main.app.state.game.join(identity)
    assert {'id': 'boss', 'name': 'Босс'} in client.get('/api/agents').json()['agents']
    monkeypatch.setattr(main.agent, 'complete', lambda rows, text, ctx: 'Управление ещё не подключено.')
    response = client.post('/api/agent/ask', headers=ORIGIN,
                           json={'agent_id': 'boss', 'text': 'Добавь ресурсы'})
    assert response.status_code == 200
    assert response.json()['character']['id'] == 'boss'
    assert len(client.get('/api/agent/messages?agent_id=boss').json()['messages']) == 2
    assert client.get('/api/agent/messages?agent_id=expedition').json()['messages'] == []
    runtime = main.app.state.game.runtime(identity)
    with runtime.transaction() as state:
        state.admin_characters = main.admin.characters(state)
        next(item for item in state.admin_characters if item['id'] == 'boss')['enabled'] = False
    assert not any(item['id'] == 'boss' for item in client.get('/api/agents').json()['agents'])
    assert client.post('/api/agent/ask', headers=ORIGIN,
                       json={'agent_id': 'boss', 'text': 'Привет'}).status_code == 503


def test_boss_prompt_discloses_missing_tools(client):
    identity = register(client, 'bossprompt')
    messages = main.agent.prompt_messages(main.db, identity, 'Построй бур', {}, 'boss',
                                          character={'prompt': 'Ты администратор.'}, history_rows=[])
    assert 'Инструменты управления Босса сейчас не подключены' in messages[0]['content']
