"""Trusted Boss loop: Ollama tool calling through the administrative MCP contract."""
import asyncio
import json
import re
import uuid

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from .agent import model_message

MAX_ROUNDS = 8
MAX_RESULT_CHARS = 50000


def ollama_tool(tool):
    return {'type': 'function', 'function': {
        'name': tool.name,
        'description': tool.description or '',
        'parameters': tool.inputSchema,
    }}


def tool_result(result):
    value = result.model_dump(by_alias=True, exclude_none=True)
    raw = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if len(raw) <= MAX_RESULT_CHARS:
        return raw
    return json.dumps({'truncated': True, 'prefix': raw[:MAX_RESULT_CHARS]}, ensure_ascii=False)


def arguments(call):
    value = call.get('function', {}).get('arguments', {})
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict):
        raise ValueError('Tool arguments must be an object')
    return value


READ_TOOLS = {'admin_get_overview', 'admin_get_world', 'admin_get_cells'}


def select_tools(query, available):
    """Expose the live contract independently of wording and conversation history."""
    return list(available.values())


def successful_mutation(name, result):
    if name in READ_TOOLS:
        return False
    value = result.model_dump(by_alias=True, exclude_none=True)
    return not value.get('isError') and value.get('structuredContent', {}).get('ok') is True


async def final_answer(dialogue, temperature, fallback):
    dialogue.append({'role': 'system', 'content':
                     'Заверши ответ без новых инструментов. Кратко сообщи только подтверждённый результат. '
                     'Если изменение не выполнено, прямо скажи об этом и назови причину из результатов.'})
    message = await asyncio.to_thread(model_message, dialogue, num_predict=256, temperature=temperature)
    return str(message.get('content') or '').strip() or fallback


async def run(messages, config, temperature):
    headers = {'Authorization': f"Bearer {config['admin_key']}"}
    system = {'role': 'system', 'content': (
        f"Работай только с текущим миром world_id={config['world_id']}. "
        'Для административных действий используй MCP-инструменты. Сначала прочитай мир, '
        'не выдумывай ID и после изменения проверь результат чтением. Не сообщай об успехе '
        'без успешного результата инструмента. Удаление учётных записей и выполнение кода недоступны.')}
    dialogue = [messages[0], system, *messages[1:]]
    async with httpx.AsyncClient(headers=headers, timeout=180) as http:
        async with streamable_http_client(config['url'], http_client=http) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                listed = await session.list_tools()
                available = {tool.name: tool for tool in listed.tools}
                query = next((str(item.get('content', '')) for item in reversed(messages)
                              if item.get('role') == 'user'), '')
                tools = [ollama_tool(tool) for tool in select_tools(query, available)]
                seen = set()
                for _ in range(MAX_ROUNDS):
                    message = await asyncio.to_thread(
                        model_message, dialogue, tools=tools, num_predict=768,
                        temperature=temperature)
                    calls = message.get('tool_calls') or []
                    content = str(message.get('content') or '').strip()
                    if not calls:
                        if content:
                            return content
                        raise ValueError('Boss returned an empty response')
                    dialogue.append(message)
                    for call in calls:
                        name = call.get('function', {}).get('name')
                        if name not in available:
                            result = json.dumps({'isError': True, 'error': 'UNKNOWN_TOOL'}, ensure_ascii=False)
                        else:
                            try:
                                values = arguments(call)
                                if name != 'admin_get_overview':
                                    values['world_id'] = config['world_id']
                                if name not in READ_TOOLS and not re.fullmatch(
                                        r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
                                        str(values.get('request_id', ''))):
                                    values['request_id'] = str(uuid.uuid4())
                                signature = (name, json.dumps(values, sort_keys=True, ensure_ascii=False))
                                if signature in seen:
                                    result = json.dumps({'isError': True, 'error': 'REPEATED_CALL'}, ensure_ascii=False)
                                    dialogue.append({'role': 'tool', 'tool_name': name, 'content': result})
                                    continue
                                seen.add(signature)
                                response = await session.call_tool(name, values)
                                result = tool_result(response)
                                if successful_mutation(name, response):
                                    dialogue.append({'role': 'tool', 'tool_name': name, 'content': result})
                                    verified = await session.call_tool(
                                        'admin_get_world', {'world_id': config['world_id']})
                                    dialogue.append({'role': 'tool', 'tool_name': 'admin_get_world',
                                                     'content': tool_result(verified)})
                                    return await final_answer(
                                        dialogue, temperature,
                                        f'Действие {name} выполнено и подтверждено сервером.')
                            except (ValueError, json.JSONDecodeError) as error:
                                result = json.dumps({'isError': True, 'error': str(error)}, ensure_ascii=False)
                        dialogue.append({'role': 'tool', 'tool_name': name or 'unknown', 'content': result})
                return await final_answer(dialogue, temperature,
                                          'Изменение не выполнено: модель не выбрала допустимое действие.')


def complete(messages, config, temperature=.2):
    try:
        return asyncio.run(run(messages, config, temperature))
    except BaseExceptionGroup as error:
        raise OSError('Boss MCP unavailable') from error


def stream(messages, config, temperature=.2):
    answer = complete(messages, config, temperature)
    for offset in range(0, len(answer), 24):
        yield answer[offset:offset + 24]
