"""Phase 6 — intent classification."""

from __future__ import annotations

import json

from edagent_vivado.agent.intent import classify_intent


def test_run_full_flow_chinese():
    r = classify_intent("帮我跑综合实现并生成码流", context={"manifest_path": "/x/eda.yaml"})
    assert r.intent_id == "run_full_flow"
    assert r.task_type == "vivado_run"
    assert r.required_args.get("stages") == ["synth", "impl", "bitstream"]
    assert not r.needs_clarification()


def test_run_synth_only_english():
    r = classify_intent("run synthesis on the design", context={"manifest_path": "/x/eda.yaml"})
    assert r.intent_id == "run_synthesis"
    assert r.required_args["stages"] == ["synth"]


def test_missing_manifest():
    r = classify_intent("跑综合", context={})
    assert r.intent_id == "run_synthesis"
    assert r.needs_clarification()
    assert r.missing_args[0].key == "manifest_path"


def test_diagnose_intent():
    r = classify_intent("帮我看下这个日志为什么失败")
    assert r.intent_id == "diagnose_log"
    assert r.task_type == "diagnose"
    assert any(m.key == "log_path" for m in r.missing_args)


def test_import_xpr():
    r = classify_intent("import this xpr")
    assert r.intent_id == "import_xpr"
    assert any(m.key == "xpr_path" for m in r.missing_args)


def test_default_chat():
    r = classify_intent("hello, what can you do?")
    assert r.intent_id == "chat"
    assert r.task_type == "chat_only"


def test_strategy_extraction():
    r = classify_intent(
        "run synth strategy=Flow_PerfOptimized_high",
        context={"manifest_path": "/x/eda.yaml"},
    )
    assert r.required_args.get("strategy") == "Flow_PerfOptimized_high"


def test_to_dict_serializable():
    r = classify_intent("跑综合", context={})
    json.dumps(r.to_dict())
