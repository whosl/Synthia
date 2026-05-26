"""Phase 6E — capability planner."""

from edagent_vivado.agent.planner import plan_task_rule_based


def test_plan_synth_keywords():
    steps = plan_task_rule_based("run vivado synthesis on my design", manifest_path="eda.yaml")
    assert any(s.capability == "run_synthesis" for s in steps)


def test_plan_verilator_lint():
    steps = plan_task_rule_based("verilator lint the rtl")
    assert any(s.connector == "verilator" for s in steps)
