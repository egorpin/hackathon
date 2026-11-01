"""Set the local review player's stock; run only with the preview server stopped."""
import json
import sqlite3
from pathlib import Path

path = Path('client/test-results/preview-data/mars.sqlite3')
with sqlite3.connect(path) as connection:
    with sqlite3.connect(path.with_name('mars.before-resource-grant.sqlite3')) as backup:
        connection.backup(backup)
    user_id = connection.execute('SELECT id FROM users WHERE username=?',('visual_review',)).fetchone()[0]
    stock = dict.fromkeys(('ore','water','iron','sulfur','oxygen'),10)
    for world_id, raw in connection.execute('SELECT world_id,state FROM game_states').fetchall():
        state = json.loads(raw)
        if user_id not in state['players']: continue
        state['players'][user_id]['inventory'] = stock
        state['revision'] += 1
        connection.execute('UPDATE game_states SET state=? WHERE world_id=?',(json.dumps(state),world_id))
    connection.execute('UPDATE players SET inventory=? WHERE user_id=?',(json.dumps(stock),user_id))
    print(json.dumps(stock))
