"""LLM planner parsing (no API call)."""

from edagent_vivado.agent.planner import _parse_llm_plan, plan_task_rule_based


def test_parse_llm_plan_json():
    raw = '[{"step":"synth","connector":"vivado","capability":"run_synthesis","inputs":{}}]'
    steps = _parse_llm_plan(raw, "eda.yaml")
    assert len(steps) == 1
    assert steps[0].capability == "run_synthesis"
    assert steps[0].inputs.get("manifest_path") == "eda.yaml"


def test_rule_fallback_still_works():
    steps = plan_task_rule_based("run synthesis", manifest_path="eda.yaml")
    assert any(s.capability == "run_synthesis" for s in steps)
