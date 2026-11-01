import json
from types import SimpleNamespace

from app import boss_agent
from test_server import client


def test_ollama_tool_uses_live_mcp_schema():
    tool = SimpleNamespace(name='admin_restart_world', description='Restart world',
                           inputSchema={'type': 'object', 'required': ['world_id']})
    assert boss_agent.ollama_tool(tool) == {'type': 'function', 'function': {
        'name': 'admin_restart_world', 'description': 'Restart world',
        'parameters': tool.inputSchema}}


def test_tool_arguments_and_results_are_json():
    assert boss_agent.arguments({'function': {'arguments': '{"world_id":"demo-world"}'}}) == {
        'world_id': 'demo-world'}
    response = SimpleNamespace(model_dump=lambda **kwargs: {
        'isError': False, 'structuredContent': {'ok': True, 'version': 4}})
    assert json.loads(boss_agent.tool_result(response))['structuredContent']['ok'] is True


def test_boss_executes_live_mcp_tool_without_keyword_match(client, monkeypatch):
    import asyncio
    import httpx
    from app import main
    from test_server import register, ORIGIN

    identity, _ = register(client, 'boss_loop')
    main.app.state.game.join(identity)
    world_id = identity['world_id']
    original_client = httpx.AsyncClient

    def local_client(**kwargs):
        return original_client(transport=httpx.ASGITransport(app=main.app),
                               base_url=ORIGIN, **kwargs)

    monkeypatch.setattr(boss_agent.httpx, 'AsyncClient', local_client)
    rounds = []

    def model(dialogue, **kwargs):
        rounds.append(list(dialogue))
        assert main.app.state.admin_key not in json.dumps(dialogue)
        if len(rounds) == 1:
            names = {tool['function']['name'] for tool in kwargs['tools']}
            assert 'admin_set_world' in names
            assert 'admin_set_player' in names
            assert 'admin_set_resources' in names
            return {'role': 'assistant', 'content': '', 'tool_calls': [
                {'function': {'name': 'admin_get_world', 'arguments': {'world_id': world_id}}}]}
        if len(rounds) == 2:
            assert dialogue[-1]['role'] == 'tool'
            assert not json.loads(dialogue[-1]['content'])['isError']
            return {'role': 'assistant', 'content': '', 'tool_calls': [
                {'function': {'name': 'admin_set_world', 'arguments': {
                    'world_id': world_id, 'edit': {'paused': True}}}}]}
        assert json.loads(dialogue[-3]['content'])['structuredContent']['ok']
        assert dialogue[-2]['tool_name'] == 'admin_get_world'
        return {'role': 'assistant', 'content': 'Мир приостановлен.'}

    monkeypatch.setattr(boss_agent, 'model_message', model)
    answer = asyncio.run(boss_agent.run([
        {'role': 'system', 'content': 'Ты Босс.'},
        {'role': 'user', 'content': 'Freeze the simulation'}],
        {'url': ORIGIN + '/mcp/admin/', 'admin_key': main.app.state.admin_key,
         'world_id': world_id}, .2))
    assert answer == 'Мир приостановлен.'
    assert main.app.state.game.runtime(identity).state.admin_paused
    assert len(rounds) == 3
