import uuid

from fastapi.testclient import TestClient

from app import main
from app.storage import Database


def test_player_color_command_reaches_game_service_over_websocket(monkeypatch, tmp_path):
    monkeypatch.setattr(main, 'db', Database(tmp_path / 'color.sqlite3'))
    origin = 'http://localhost:8000'
    with TestClient(main.app) as client:
        response = client.post('/api/auth/register', headers={'origin': origin},
                               json={'username': 'color_user', 'password': 'longpassword'})
        assert response.status_code == 201
        token = response.cookies['mars_session']
        with client.websocket_connect('/ws', headers={'origin': origin,
                                                      'cookie': f'mars_session={token}'}) as ws:
            assert ws.receive_json()['type'] == 'session.ready'
            ws.send_json({'type': 'world.subscribe', 'payload': {}})
            message = ws.receive_json()
            assert message['type'] == 'world.offer'
            ws.send_json({'type': 'world.accept', 'payload': {}})
            message = ws.receive_json()
            while message['type'] != 'world.snapshot':
                if message['type'] == 'world.offer':
                    ws.send_json({'type': 'world.accept', 'payload': {}})
                message = ws.receive_json()

            request_id = str(uuid.uuid4())
            ws.send_json({'type': 'player.color', 'request_id': request_id,
                          'payload': {'color': '#42b8ff'}})
            for _ in range(20):
                result = ws.receive_json()
                if result.get('request_id') == request_id:
                    break
            else:
                raise AssertionError('No action.result for player.color')

            assert result['type'] == 'action.result'
            assert result['payload']['ok'] is True
            assert result['payload']['color'] == '#42b8ff'
            identity = response.json()
            player = main.app.state.game.runtime(identity).state.players[identity['user_id']]
            assert player.color == '#42b8ff'
