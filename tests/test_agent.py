"""Agent logic without a running LLM: argument parsing, guards, and the tool loop with a scripted fake model."""
import pytest
import agent as ag


def test_budget_parsing():
    assert ag._num("€400M") == 400
    assert ag._num("1.2 billion") == 1200
    assert ag._num("350") == 350
    assert ag._num(None, 7) == 7


def test_formation_matching():
    forms = ["4-3-3", "4-4-2", "4-4-2 (wingers)", "3-5-2"]
    assert ag._formation("4-4-2 (wingers)", forms) == "4-4-2 (wingers)"
    assert ag._formation("4-4-2 wingers", forms) == "4-4-2 (wingers)"
    assert ag._formation("433", forms) == "4-3-3"
    assert ag._formation("tiki taka", forms) is None


def test_budget_guard():
    u = lambda t: [{"role": "user", "content": t}]
    assert not ag.budget_given(u("attacking team with Mbappe"), None)
    assert ag.budget_given(u("€300M, Messi must play"), None)
    assert ag.budget_given(u("half a billion"), None)
    assert ag.budget_given(u("make it younger"), {"budget_m": 300})


def test_text_tool_call_fallback():
    msg = {"content": 'ok <tool_call>{"name": "build_squad", "arguments": {"budget_m": 100, "formation": "4-3-3"}}</tool_call>'}
    assert ag.tool_calls(msg) == [("build_squad", {"budget_m": 100, "formation": "4-3-3"})]
    assert ag.strip_think("<think>hmm</think>Hello") == "Hello"


@pytest.fixture()
def tools(app_module):
    def build(params):
        payload, err = app_module.solve(app_module.parse_params(params))
        if err:
            raise ValueError(err[0])
        return payload
    import squad_engine as se
    return ag.Tools(search=app_module.search_players, build=build, formations=list(se.FORMATIONS))


def drain(gen):
    events = []
    try:
        while True:
            events.append(next(gen))
    except StopIteration as stop:
        return events, stop.value


def test_run_build_resolves_names_and_starts_player(tools):
    events, reply = drain(ag.run_build({"budget_m": 150, "formation": "4-2-3-1", "must_start": ["Messi"], "exclude": ["Ronaldo"]}, tools))
    kinds = [e["type"] for e in events]
    assert kinds == ["resolved", "resolved", "solving", "squad"]
    assert reply["ok"] and reply["required_players"][0].startswith("L. Messi: starts at")
    assert "Cristiano Ronaldo" in reply["excluded_players"]


def test_run_build_errors(tools):
    assert drain(ag.run_build({"formation": "4-3-3"}, tools))[1]["ok"] is False                       # no budget
    assert drain(ag.run_build({"budget_m": 100, "formation": "1-1-1"}, tools))[1]["ok"] is False      # bad formation
    assert "No player" in drain(ag.run_build({"budget_m": 100, "formation": "4-3-3", "must_start": ["Zzzzqx"]}, tools))[1]["error"]
    assert drain(ag.run_build({"budget_m": 100, "formation": "4-3-3"}, tools, budget_ok=False))[1]["ok"] is False


def test_agent_loop_with_scripted_model(tools, monkeypatch):
    script = [
        {"content": "", "tool_calls": [{"function": {"name": "build_squad", "arguments": {"budget_m": 150, "formation": "4-4-2", "must_start": ["Messi"]}}}]},
        {"content": "Here is your 4-4-2 with L. Messi starting."},
    ]
    seen = []
    monkeypatch.setattr(ag, "status", lambda: {"ok": True, "model": "fake"})
    monkeypatch.setattr(ag, "chat", lambda messages, think=False: (seen.append(messages[-1]), script.pop(0))[1])
    events = list(ag.run([{"role": "user", "content": "€150M counter attack, Messi must play"}], None, tools))
    kinds = [e["type"] for e in events]
    assert kinds[-2:] == ["message", "done"] and "squad" in kinds
    assert seen[-1]["role"] == "tool" and '"ok": true' in seen[-1]["content"]


def test_agent_blocks_repeated_failing_call(tools, monkeypatch):
    bad = {"content": "", "tool_calls": [{"function": {"name": "build_squad", "arguments": {"budget_m": 2, "formation": "4-3-3"}}}]}
    script = [bad, bad, {"content": "That budget is too small."}]
    monkeypatch.setattr(ag, "status", lambda: {"ok": True, "model": "fake"})
    monkeypatch.setattr(ag, "chat", lambda messages, think=False: script.pop(0))
    events = list(ag.run([{"role": "user", "content": "€2M team"}], None, tools))
    assert sum(e["type"] == "solving" for e in events) == 1      # the identical retry is not executed
    assert events[-2]["type"] == "message"


def test_agent_reports_missing_ollama(tools, monkeypatch):
    monkeypatch.setattr(ag, "status", lambda: {"ok": False, "model": "x", "error": "Ollama is not running"})
    events = list(ag.run([{"role": "user", "content": "hi"}], None, tools))
    assert events[0]["type"] == "error" and events[-1]["type"] == "done"
