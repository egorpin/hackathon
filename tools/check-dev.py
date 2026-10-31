"""Exercise a disposable dev stack through its public client port.

Run with .venv/bin/python tools/check-dev.py http://localhost:18000.
Creates a player and starts the world: use a separate Compose project/volume.
"""
import json
import math
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx
from websockets.sync.client import connect

origin = sys.argv[1].rstrip('/')
trace, chunks, state = [], {}, {}
ws = None


def receive():
    message = json.loads(ws.recv(timeout=5))
    trace.append(message)
    kind, payload = message['type'], message['payload']
    if kind == 'world.offer':
        ws.send(json.dumps({'type': 'world.accept', 'payload': {}}))
    elif kind == 'chunk.offer':
        ws.send(json.dumps({'type': 'chunk.request', 'payload': {'chunk_id': payload['chunk_id']}}))
    elif kind == 'chunk.load':
        chunks[payload['chunk_id']] = payload
    elif kind == 'chunk.unload':
        chunks.pop(payload['chunk_id'], None)
    elif kind in ('world.snapshot', 'world.delta'):
        state.update(payload)
    return message


def until(predicate):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        message = receive()
        if predicate(message):
            return message
    raise AssertionError('Expected update was not received')


def command(kind, payload):
    request_id = str(uuid.uuid4())
    ws.send(json.dumps({'type': kind, 'request_id': request_id, 'payload': payload}))
    result = until(lambda m: m.get('request_id') == request_id)
    assert result['payload']['ok'], result
    return result['payload']


with httpx.Client(base_url=origin, timeout=10) as client:
    assert client.get('/api/health').json()['status'] == 'ok'
    assert '/@vite/client' in client.get('/').text
    assert client.get('/src/net/client.js').status_code == 200
    result = client.post('/api/auth/register', headers={'Origin': origin},
                         json={'username': 'check_' + uuid.uuid4().hex[:12], 'password': uuid.uuid4().hex})
    assert result.status_code == 201, result.text
    identity = result.json()
    assert client.get('/api/auth/me').json() == identity
    options = dict(origin=origin, additional_headers={'Cookie': f"mars_session={client.cookies['mars_session']}"})
    url = origin.replace('http', 'ws', 1) + '/ws'
    with connect(url, **options) as ws:
        assert receive()['type'] == 'session.ready'
        ws.send(json.dumps({'type': 'world.subscribe', 'payload': {}}))
        until(lambda m: m['type'] == 'chunk.load')
        assert state['self_id'] == identity['user_id']
        command('chat.send', {'text': 'Проверка 🚀'})
        until(lambda m: m['type'] == 'chat.message')
        command('world.start', {})
        until(lambda m: m['type'] == 'world.delta' and m['payload']['stage'] == 'running')
        position = state['players'][0]['position']
        radius = state['world']['radius']
        def distance(cell):
            return radius * math.acos(max(-1, min(1, sum(a*b for a,b in zip(position,cell['center'])) / radius**2)))
        cells = [cell for chunk in chunks.values() for cell in chunk['cells']
                 if cell['buildable'] and 1.1 <= distance(cell) <= 4.5]
        assert len(cells) >= 3
        buildings = {}
        for kind, cell in zip(['drill', 'warehouse', 'oxygen_generator'], cells):
            buildings[kind] = command('building.place', {'cell_id': cell['cell_id'], 'building_type': kind})['building_id']
        until(lambda m: m['type'] == 'world.delta' and len(m['payload']['buildings']) == 3)
        command('resource.deposit', {'building_id': buildings['warehouse'], 'resource': 'ore', 'amount': 1})
        until(lambda m: m['type'] == 'world.delta' and m['payload']['team_storage']['ore'] == 1)
        command('resource.pickup', {'building_id': buildings['warehouse'], 'resource': 'ore', 'amount': 1})
        command('resource.deposit', {'building_id': buildings['oxygen_generator'], 'resource': 'ore', 'amount': 1})
        until(lambda m: m['type'] == 'world.delta' and m['payload']['oxygen'] > 0)
        until(lambda m: m['type'] == 'world.delta' and any(b['building_type'] == 'drill' and b['stock']['ore'] > 0 for b in m['payload']['buildings']))
        command('resource.pickup', {'building_id': buildings['drill'], 'resource': 'ore', 'amount': 1})
        ws.send(json.dumps({'type': 'player.input', 'payload': {'seq': 1, 'move': [0, 0, 1]}}))
        until(lambda m: m['type'] == 'world.delta' and m['payload']['players'][0]['position'] != position)
    with connect(url, **options) as ws:
        assert receive()['type'] == 'session.ready'
        ws.send(json.dumps({'type': 'world.subscribe', 'payload': {}}))
        until(lambda m: m['type'] == 'world.snapshot')
        assert state['stage'] == 'running' and state['last_input_seq'] == 1
        assert len(state['buildings']) == 3

# Replay actual wire DTOs through the same GameClient/Runtime/WorldCache as the UI.
root = Path(__file__).resolve().parents[1]
subprocess.run(['node', str(root / 'client/tests/replay-wire.mjs')],
               input=json.dumps(trace), text=True, check=True, cwd=root)
print('PASS: Vite HTTP proxy, cookie auth, WebSocket, chat, chunks, all building types, resources, oxygen, movement, reconnect')
