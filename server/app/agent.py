"""Local multi-agent runtime with retrieval and compressed private memory."""
import json
import math
import os
import re
from functools import lru_cache
from pathlib import Path
from urllib.request import Request, urlopen

DEFAULT_SYSTEM = """Ты — Марсик, ИИ-помощник экспедиции Mars Colony. Веди нормальный диалог по-русски
и давай уместные игровые подсказки. Сам формулируй ответ по вопросу пользователя. Не перечисляй
весь контекст без необходимости. Ты только советуешь и не управляешь игроком. Игровые факты бери
из текущего состояния и найденных справочных примеров. Если данных нет, честно скажи об этом.
Не принимай старые ответы ассистента за доказательство игровых механик.
По умолчанию отвечай кратко: 2–4 предложения и обычно не более 70 слов. Не пересказывай управление,
состояние мира и найденные ресурсы, если вопрос не о них. Развёрнутый структурированный ответ давай
только на сложный составной вопрос или явную просьбу объяснить подробно, составить план либо перечислить варианты."""
SYSTEM = DEFAULT_SYSTEM
RESPONSE_POLICY = """Правило длины ответа: на обычную реплику отвечай прямо и кратко — 2–4 предложения,
обычно до 70 слов. Не добавляй справку, которую не просили. Пиши подробно только если запрос явно
просит подробности, план, сравнение, несколько вариантов или сам содержит несколько связанных задач."""

def content_root():
    configured = os.environ.get('MARS_CONTENT_DIR')
    if configured:
        return Path(configured)
    for parent in Path(__file__).resolve().parents:
        if (parent / 'content').is_dir():
            return parent / 'content'
    return Path('/app/content')

@lru_cache(maxsize=16)
def profile(agent_id='expedition'):
    path = content_root() / 'agents' / f'{agent_id}.json'
    if not path.is_file():
        return {'id': agent_id, 'name': 'Марсик', 'system': DEFAULT_SYSTEM,
                'knowledge': 'expedition_examples.json'}
    value = json.loads(path.read_text(encoding='utf-8'))
    return {'id': agent_id, 'name': value.get('name', agent_id),
            'system': value.get('system', DEFAULT_SYSTEM),
            'knowledge': value.get('knowledge', 'expedition_examples.json')}

@lru_cache(maxsize=16)
def examples(filename):
    path = content_root() / 'knowledge' / filename
    if not path.is_file():
        return []
    value = json.loads(path.read_text(encoding='utf-8'))
    return value if isinstance(value, list) else value.get('examples', [])

def tokens(text):
    return set(re.findall(r'[a-zа-яё0-9]+', text.casefold()))

def trigrams(text):
    compact = ' '.join(re.findall(r'[a-zа-яё0-9]+', text.casefold()))
    return {compact[index:index + 3] for index in range(max(0, len(compact) - 2))}

def retrieve(question, filename, limit=6):
    """Small dependency-free fuzzy retrieval over the local JSON bank."""
    query_words, query_grams = tokens(question), trigrams(question)
    ranked = []
    for item in examples(filename):
        candidate = str(item.get('question', ''))
        words, grams = tokens(candidate), trigrams(candidate)
        word_score = len(query_words & words) / math.sqrt(max(1, len(query_words) * len(words)))
        gram_score = len(query_grams & grams) / max(1, len(query_grams | grams))
        score = word_score * .65 + gram_score * .35
        if score > .08:
            ranked.append((score, item))
    ranked.sort(key=lambda pair: pair[0], reverse=True)
    selected, seen = [], set()
    for score, item in ranked:
        key = item.get('answer')
        if key in seen:
            continue
        seen.add(key)
        selected.append({'question': item.get('question'), 'reference': key,
                         'tags': item.get('tags', []), 'similarity': round(score, 3)})
        if len(selected) == limit:
            break
    return selected

def model_request(messages, *, num_predict=512, temperature=.35):
    endpoint = os.environ.get('MARS_AI_URL', 'http://host.docker.internal:11435').rstrip('/')
    model = os.environ.get('MARS_AI_MODEL', 'qwen3.5:27b-q4_K_M')
    try:
        context_size = min(131072, max(4096, int(os.environ.get('MARS_AI_CONTEXT', '32768'))))
    except ValueError:
        context_size = 32768
    body = {'model': model, 'stream': False, 'think': False, 'keep_alive': '10m',
            'options': {'num_ctx': context_size, 'num_predict': num_predict,
                        'temperature': temperature}, 'messages': messages}
    request = Request(endpoint + '/api/chat', data=json.dumps(body).encode(),
                      headers={'Content-Type': 'application/json'})
    with urlopen(request, timeout=180) as response:
        answer = json.load(response)['message']['content'].strip()
    if not answer:
        raise ValueError('Empty model response')
    return answer

def model_stream(messages, *, num_predict=512, temperature=.35):
    """Yield Ollama chat tokens as soon as the local model produces them."""
    endpoint = os.environ.get('MARS_AI_URL', 'http://host.docker.internal:11435').rstrip('/')
    model = os.environ.get('MARS_AI_MODEL', 'qwen3.5:27b-q4_K_M')
    try:
        context_size = min(131072, max(4096, int(os.environ.get('MARS_AI_CONTEXT', '32768'))))
    except ValueError:
        context_size = 32768
    body = {'model': model, 'stream': True, 'think': False, 'keep_alive': '10m',
            'options': {'num_ctx': context_size, 'num_predict': num_predict,
                        'temperature': temperature}, 'messages': messages}
    request = Request(endpoint + '/api/chat', data=json.dumps(body).encode(),
                      headers={'Content-Type': 'application/json'})
    with urlopen(request, timeout=180) as response:
        for raw_line in response:
            if not raw_line.strip():
                continue
            value = json.loads(raw_line)
            chunk = value.get('message', {}).get('content', '')
            if chunk:
                yield chunk

def load_memory(db, identity, agent_id):
    with db.connect() as connection:
        row = connection.execute(
            'SELECT memory FROM agent_memory WHERE world_id=? AND user_id=? AND agent_id=?',
            (identity['world_id'], identity['user_id'], agent_id)).fetchone()
        total = connection.execute(
            'SELECT COUNT(*) AS count FROM agent_messages WHERE world_id=? AND user_id=? AND agent_id=?',
            (identity['world_id'], identity['user_id'], agent_id)).fetchone()['count']
    try:
        value = json.loads(row['memory']) if row else {}
    except (TypeError, ValueError):
        value = {}
    return {'summary': str(value.get('summary', ''))[:6000],
            'summarized_count': int(value.get('summarized_count', 0)), 'total': total}

def save_memory(db, identity, agent_id, memory):
    with db.connect() as connection:
        connection.execute(
            'INSERT INTO agent_memory(world_id,user_id,agent_id,memory) VALUES(?,?,?,?) '
            'ON CONFLICT(world_id,user_id,agent_id) DO UPDATE SET memory=excluded.memory',
            (identity['world_id'], identity['user_id'], agent_id,
             json.dumps(memory, ensure_ascii=False)))

def compress_memory(db, identity, agent_id, history_rows):
    memory = load_memory(db, identity, agent_id)
    if memory['total'] - memory['summarized_count'] < 8 or len(history_rows) <= 10:
        return memory['summary']
    older = history_rows[:-8]
    transcript = '\n'.join(f"{row['role']}: {row['text'][:1200]}" for row in older)
    prompt = """Сожми историю личного диалога в память до 900 слов. Сохрани имя и предпочтения
пользователя, нерешённые вопросы, принятые решения и важный игровой прогресс. Исправления пользователя
важнее старых утверждений. Не добавляй фактов. Верни только текст памяти."""
    summary = model_request([
        {'role': 'system', 'content': prompt},
        {'role': 'user', 'content': 'Предыдущая память:\n' + memory['summary'] +
         '\n\nНовые реплики:\n' + transcript}], num_predict=1100, temperature=.1)
    save_memory(db, identity, agent_id,
                {'summary': summary[:6000], 'summarized_count': memory['total'] - 8})
    return summary[:6000]

def prompt_messages(db, identity, text, context, agent_id='expedition', character=None, history_rows=None):
    current_profile = profile(agent_id)
    system = character.get('prompt', current_profile['system']) if character else current_profile['system']
    system = system.rstrip() + '\n\n' + RESPONSE_POLICY
    if agent_id == 'boss':
        # Capability boundary until the team's MCP execution adapter is merged.
        # Keep this independent of editable character prompts and old history.
        system += ('\nИнструменты управления Босса сейчас не подключены. '
                   'В этом запросе ты не можешь выполнить административные действия. '
                   'Не утверждай, что изменил мир; объясни эту доступность пользователю, '
                   'если он просит выполнить действие.')
    rows = history_rows if history_rows is not None else history(db, identity, agent_id, limit=32)
    memory = compress_memory(db, identity, agent_id, rows)
    references = retrieve(text, current_profile['knowledge'])
    messages = [{'role': 'system', 'content': system},
                {'role': 'system', 'content': 'Сжатая личная память: ' + (memory or 'пока пуста')},
                {'role': 'system', 'content': 'Текущее состояние игры: ' + json.dumps(context, ensure_ascii=False)},
                {'role': 'system', 'content': 'Похожие проверенные примеры из локальной базы: ' +
                 json.dumps(references, ensure_ascii=False) +
                 '\nИспользуй их как справку и сформулируй ответ заново. Не копируй неподходящий пример.'}]
    messages.extend({'role': row['role'], 'content': row['text'][:1600]} for row in rows[-8:])
    messages.append({'role': 'user', 'content': text})
    return messages

def complete(history_rows, text, context):
    context = dict(context)
    db = context.pop('_agent_db')
    identity = context.pop('_agent_identity')
    agent_id = context.pop('_agent_id', 'expedition')
    character = context.pop('_character', None)
    temperature = character.get('temperature', .35) if character else .35
    return model_request(prompt_messages(db, identity, text, context, agent_id, character, history_rows),
                         temperature=temperature)[:12000]

def stream_complete(history_rows, text, context):
    context = dict(context)
    db = context.pop('_agent_db')
    identity = context.pop('_agent_identity')
    agent_id = context.pop('_agent_id', 'expedition')
    character = context.pop('_character', None)
    temperature = character.get('temperature', .35) if character else .35
    total = 0
    for chunk in model_stream(prompt_messages(db, identity, text, context, agent_id, character, history_rows),
                              temperature=temperature):
        if total >= 12000:
            break
        chunk = chunk[:12000 - total]
        total += len(chunk)
        yield chunk

def available_profiles():
    result = []
    root = content_root() / 'agents'
    for path in sorted(root.glob('*.json')) if root.is_dir() else []:
        agent_id = path.stem
        if re.fullmatch(r'[a-z0-9_-]{1,40}', agent_id):
            current = profile(agent_id)
            result.append({'id': current['id'], 'name': current['name']})
    return result or [{'id': 'expedition', 'name': 'Марсик'}]

def history(db, identity, agent_id='expedition', limit=40):
    with db.connect() as connection:
        rows = connection.execute(
            'SELECT role,text FROM agent_messages WHERE world_id=? AND user_id=? AND agent_id=? '
            'ORDER BY rowid DESC LIMIT ?',
            (identity['world_id'], identity['user_id'], agent_id, limit)).fetchall()
    return [dict(row) for row in reversed(rows)]
