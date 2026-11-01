import json
from types import SimpleNamespace

from app import boss_agent


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
