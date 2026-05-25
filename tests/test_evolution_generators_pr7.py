"""SE-PR7 tests: routing_drift + flow_template_reuse generators."""

from __future__ import annotations

import json
import time
import uuid

from edagent_vivado.evolution import (
    approve_candidate,
    candidate_list,
    gen_flow_template_reuse,
    gen_routing_drift,
    resolve_flow_template,
    resolve_routing,
    run_generators,
)
from edagent_vivado.evolution.generators import (
    FLOW_TEMPLATE_MIN_OCCURRENCES,
    ROUTING_LOOKBACK_TASKS,
    ROUTING_MIN_MISMATCHES,
)
from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.store import (
    message_create,
    project_create,
    session_create,
    task_create,
    task_update,
    toolcall_create,
    toolcall_update,
)


# ── helpers ───────────────────────────────────────────────


def _project_with_session() -> tuple[dict, dict]:
    init_db()
    pid = project_create(
        {
            "name": f"se-pr7-{uuid.uuid4().hex[:6]}",
            "status": "active",
            "root_path": ".",
            "manifest_path": "eda.yaml",
            "xpr_path": "",
            "part": "xc7a35t",
        }
    )
    s = session_create(name="m", project_id=pid["id"])
    get_db().execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s["id"]))
    get_db().commit()
    return pid, s


def _seed_user_task(
    sid: str,
    user_text: str,
    tools_used: list[str],
) -> dict:
    t = task_create(sid, user_message_id=None)
    task_update(t["id"], state="running", started_at=int(time.time()) - 10)
    msg = message_create(sid, "user", user_text, task_id=t["id"])
    task_update(t["id"], user_message_id=msg["id"])
    for tool_name in tools_used:
        tc = toolcall_create(
            run_id=f"r-{t['id']}",
            tool_name=tool_name,
            session_id=sid,
            task_id=t["id"],
            input_summary="{}",
        )
        toolcall_update(
            tc["id"],
            state="completed",
            finished_at=int(time.time()),
            elapsed_ms=10,
            output_summary=json.dumps({
                "edagent_outcome": "execution_succeeded",
                "summary": "ok",
                "ran": True,
                "success": True,
            }),
        )
    task_update(t["id"], state="done", finished_at=int(time.time()))
    return t


def _seed_script_toolcall(
    sid: str,
    script: str,
    *,
    success: bool = True,
) -> dict:
    t = task_create(sid, user_message_id=None)
    task_update(t["id"], state="running", started_at=int(time.time()) - 5)
    tc = toolcall_create(
        run_id=f"r-{t['id']}",
        tool_name="run_vivado_script_tool",
        session_id=sid,
        task_id=t["id"],
        input_summary=json.dumps({"script": script}),
    )
    toolcall_update(
        tc["id"],
        state="completed",
        finished_at=int(time.time()),
        elapsed_ms=12,
        output_summary=json.dumps({
            "edagent_outcome": "execution_succeeded" if success else "execution_failed",
            "summary": "ok",
            "ran": True,
            "success": success,
        }),
    )
    task_update(t["id"], state="done", finished_at=int(time.time()))
    return tc


# ── routing_drift ─────────────────────────────────────────


def test_routing_drift_silent_with_no_data():
    pid, _ = _project_with_session()
    assert gen_routing_drift(project_id=pid["id"]) == []


def test_routing_drift_silent_when_tools_match_keywords():
    pid, s = _project_with_session()
    for _ in range(ROUTING_MIN_MISMATCHES + 1):
        _seed_user_task(
            s["id"],
            "I see WNS=-1.2ns slack on synth — please check timing.",
            tools_used=["parse_timing_tool"],
        )
    out = gen_routing_drift(project_id=pid["id"])
    assert out == []


def test_routing_drift_fires_when_keywords_have_no_tool_evidence():
    pid, s = _project_with_session()
    for _ in range(ROUTING_MIN_MISMATCHES + 1):
        _seed_user_task(
            s["id"],
            "We have a clock period setup violation around WNS, what next?",
            # Note: NOT calling parse_timing_tool, so this is the drift signal.
            tools_used=["read_file_tool"],
        )
    out = gen_routing_drift(project_id=pid["id"])
    assert len(out) == 1
    cand = out[0]
    assert cand["surface"] == "routing"
    signal = json.loads(cand["signal_source_json"])
    assert signal["specialist"] == "timing"
    assert signal["mismatches"] >= ROUTING_MIN_MISMATCHES
    assert signal["suggested_payload"]["rules"][0]["route_to"] == "timing"


def test_routing_drift_dedups_across_runs():
    pid, s = _project_with_session()
    for _ in range(ROUTING_MIN_MISMATCHES + 1):
        _seed_user_task(s["id"], "WNS slack violation", ["read_file_tool"])
    a = gen_routing_drift(project_id=pid["id"])
    b = gen_routing_drift(project_id=pid["id"])
    assert a and b and a[0]["id"] == b[0]["id"]
    assert len(candidate_list(status="pending", surface="routing", project_id=pid["id"])) == 1


def test_routing_drift_emits_signal_event():
    pid, s = _project_with_session()
    for _ in range(ROUTING_MIN_MISMATCHES + 1):
        _seed_user_task(s["id"], "WNS slack issue", ["read_file_tool"])
    events: list[dict] = []
    gen_routing_drift(
        project_id=pid["id"], session_id=s["id"],
        event_sink=lambda sid, et, payload, **kw: events.append({"type": et, "payload": payload}),
    )
    types = [e["type"] for e in events]
    assert "evolution.signal.fired" in types
    assert "evolution.candidate.created" in types


def test_routing_drift_approve_writes_real_routing_overlay():
    pid, s = _project_with_session()
    for _ in range(ROUTING_MIN_MISMATCHES + 1):
        _seed_user_task(s["id"], "WNS slack violation, what next?", ["read_file_tool"])
    out = gen_routing_drift(project_id=pid["id"])
    assert out
    approve_candidate(out[0]["id"])
    overlay_body = resolve_routing(project_id=pid["id"])
    assert overlay_body is not None
    assert overlay_body["rules"]
    assert overlay_body["rules"][0]["route_to"] == "timing"


# ── flow_template_reuse ───────────────────────────────────


_SYNTH_SCRIPT = """\
# Auto-generated by edagent-vivado
read_verilog {rtl/top.v}
read_xdc {constrs/top.xdc}
synth_design -top top -part xc7a35t
write_checkpoint -force {checkpoints/post_synth.dcp}
report_timing_summary -file {reports/post_synth_timing_summary.rpt}
report_utilization -file {reports/post_synth_utilization.rpt}
report_drc -file {reports/post_synth_drc.rpt}
exit
"""


def test_flow_template_silent_below_threshold():
    pid, s = _project_with_session()
    for _ in range(FLOW_TEMPLATE_MIN_OCCURRENCES - 1):
        _seed_script_toolcall(s["id"], _SYNTH_SCRIPT)
    assert gen_flow_template_reuse(project_id=pid["id"]) == []


def test_flow_template_fires_at_threshold():
    pid, s = _project_with_session()
    for _ in range(FLOW_TEMPLATE_MIN_OCCURRENCES):
        _seed_script_toolcall(s["id"], _SYNTH_SCRIPT)
    out = gen_flow_template_reuse(project_id=pid["id"])
    assert len(out) == 1
    cand = out[0]
    assert cand["surface"] == "flow_template"
    signal = json.loads(cand["signal_source_json"])
    assert signal["flow_name"] == "synth"
    assert signal["occurrences"] >= FLOW_TEMPLATE_MIN_OCCURRENCES
    body = signal["suggested_payload"]["templates"]["synth"]
    # Comments stripped, synth_design preserved.
    assert "synth_design" in body
    assert "# Auto-generated by edagent-vivado" not in body


def test_flow_template_normalises_whitespace_so_irrelevant_diffs_match():
    pid, s = _project_with_session()
    # Same logical script with cosmetic differences (extra blanks + comments).
    variants = [
        _SYNTH_SCRIPT,
        _SYNTH_SCRIPT + "\n\n\n",
        "# different comment\n" + _SYNTH_SCRIPT,
    ]
    for v in variants:
        _seed_script_toolcall(s["id"], v)
    out = gen_flow_template_reuse(project_id=pid["id"])
    assert out


def test_flow_template_ignores_failed_scripts():
    pid, s = _project_with_session()
    for _ in range(FLOW_TEMPLATE_MIN_OCCURRENCES):
        _seed_script_toolcall(s["id"], _SYNTH_SCRIPT, success=False)
    out = gen_flow_template_reuse(project_id=pid["id"])
    assert out == []


def test_flow_template_dedups():
    pid, s = _project_with_session()
    for _ in range(FLOW_TEMPLATE_MIN_OCCURRENCES + 1):
        _seed_script_toolcall(s["id"], _SYNTH_SCRIPT)
    a = gen_flow_template_reuse(project_id=pid["id"])
    b = gen_flow_template_reuse(project_id=pid["id"])
    assert a and b and a[0]["id"] == b[0]["id"]


def test_flow_template_approve_writes_real_template_payload():
    pid, s = _project_with_session()
    for _ in range(FLOW_TEMPLATE_MIN_OCCURRENCES):
        _seed_script_toolcall(s["id"], _SYNTH_SCRIPT)
    out = gen_flow_template_reuse(project_id=pid["id"])
    assert out
    approve_candidate(out[0]["id"])
    body = resolve_flow_template("synth", project_id=pid["id"])
    assert body is not None
    assert "synth_design" in body


# ── dispatcher integration ────────────────────────────────


def test_run_generators_includes_new_generators_in_only_filter():
    pid, s = _project_with_session()
    for _ in range(ROUTING_MIN_MISMATCHES + 1):
        _seed_user_task(s["id"], "clock setup violation around WNS", ["read_file_tool"])
    out = run_generators(
        project_id=pid["id"], session_id=s["id"], only=["routing_drift"],
    )
    assert any(c["generator"] == "routing_drift" for c in out["created"])
