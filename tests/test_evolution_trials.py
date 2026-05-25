"""SE-PR5 unit tests: trial config, arm split, decision, abort/force."""

from __future__ import annotations

import json
import uuid

import pytest

from edagent_vivado.evolution import (
    abort_trial,
    active_overlay,
    active_trial_for,
    approve_candidate,
    assign_arms_for_task,
    candidate_create,
    candidate_get,
    clear_task_arms,
    DECISION_MARGIN,
    force_decision,
    is_trial_enabled,
    maybe_decide_trial,
    MIN_SAMPLES_PER_ARM,
    overlay_get,
    project_trial_config,
    record_trial_snapshot,
    reset_task_arms,
    resolve_prompt,
    set_task_arms,
    set_trial_enabled,
    start_trial,
    trial_get,
)
from edagent_vivado.evolution.trials import _split_arm
from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.store import project_create, session_create


def _make_project() -> dict:
    init_db()
    return project_create(
        {
            "name": f"se-pr5-{uuid.uuid4().hex[:6]}",
            "status": "active",
            "root_path": ".",
            "manifest_path": "eda.yaml",
            "xpr_path": "",
            "part": "xc7a35t",
        }
    )


def _make_prompt_candidate(pid: str, signal: str = "repeated_failure") -> dict:
    return candidate_create(
        surface="prompt",
        title=f"prompt-{signal}",
        rationale="r",
        project_id=pid,
        signal_source={
            "signal": signal,
            "signal_key": f"{signal}:rolling_10",
            "first_run_success": 0.18,
            "sample_size": 6,
        },
        created_by="test",
    )


# ── trial_config ----------------------------------------------------------


def test_trial_disabled_by_default():
    pid = _make_project()
    cfg = project_trial_config(pid["id"])
    assert cfg["prompt"] is False
    assert cfg["tool"] is False  # never enabled
    assert is_trial_enabled(pid["id"], "prompt") is False


def test_set_trial_enabled_persists():
    pid = _make_project()
    set_trial_enabled(pid["id"], "prompt", True)
    assert is_trial_enabled(pid["id"], "prompt") is True
    set_trial_enabled(pid["id"], "prompt", False)
    assert is_trial_enabled(pid["id"], "prompt") is False


def test_set_trial_refuses_tool_surface():
    pid = _make_project()
    with pytest.raises(ValueError):
        set_trial_enabled(pid["id"], "tool", True)


def test_set_trial_refuses_unknown_surface():
    pid = _make_project()
    with pytest.raises(ValueError):
        set_trial_enabled(pid["id"], "nope", True)


# ── arm assignment + resolver routing ------------------------------------


def test_split_arm_deterministic():
    a = _split_arm("task-A", "trial-X")
    b = _split_arm("task-A", "trial-X")
    assert a == b
    assert a in ("baseline", "variant")


def test_split_arm_roughly_balanced_over_1000_tasks():
    counts = {"baseline": 0, "variant": 0}
    for i in range(1000):
        arm = _split_arm(f"task-{i}", "trial-fixed")
        counts[arm] += 1
    # Hash distribution is uniform — accept 30/70 in the worst case.
    assert min(counts.values()) > 300
    assert max(counts.values()) < 700


def test_assign_arms_for_task_returns_empty_when_no_trial():
    pid = _make_project()
    assert assign_arms_for_task(project_id=pid["id"], task_id="t") == {}


def test_assign_arms_for_task_yields_overlay_id_for_each_arm():
    pid = _make_project()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    trial = active_trial_for(project_id=pid["id"], surface="prompt")
    assert trial is not None

    arms = assign_arms_for_task(project_id=pid["id"], task_id="task-A")
    assert "prompt" in arms
    arm, overlay_id, trial_id = arms["prompt"]
    assert arm in ("baseline", "variant")
    assert trial_id == trial["id"]
    if arm == "variant":
        assert overlay_id == trial["variant_overlay_id"]
    # baseline can be None when no prior overlay existed (which is the case here).


def test_resolver_picks_variant_overlay_when_arm_assigned():
    pid = _make_project()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    trial = active_trial_for(project_id=pid["id"], surface="prompt")
    assert trial is not None

    # Force the variant arm.
    token = set_task_arms({"prompt": ("variant", trial["variant_overlay_id"], trial["id"])})
    try:
        out = resolve_prompt("BASE", project_id=pid["id"])
        assert out.startswith("BASE")
        # variant overlay carries the synthesized prompt text.
        assert "first-run" in out.lower()
    finally:
        reset_task_arms(token)


def test_resolver_baseline_arm_with_no_prior_overlay_falls_through():
    pid = _make_project()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    trial = active_trial_for(project_id=pid["id"], surface="prompt")
    assert trial is not None

    # arm=baseline with no overlay_id: resolver should fall through to baseline.
    token = set_task_arms({"prompt": ("baseline", None, trial["id"])})
    try:
        out = resolve_prompt("BASE", project_id=pid["id"])
        assert out == "BASE"
    finally:
        reset_task_arms(token)
    clear_task_arms()


# ── approve with trial ---------------------------------------------------


def test_approve_with_trial_enabled_starts_a_trial_not_active_overlay():
    pid = _make_project()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = _make_prompt_candidate(pid["id"])
    out = approve_candidate(cand["id"])

    # Candidate moves to trialing, NOT approved.
    assert out["status"] == "trialing"

    trial = active_trial_for(project_id=pid["id"], surface="prompt")
    assert trial is not None
    assert trial["candidate_id"] == cand["id"]
    assert trial["state"] == "running"

    # The variant overlay is in 'shadow' state, not 'active'.
    variant = overlay_get(trial["variant_overlay_id"])
    assert variant["state"] == "shadow"

    # Without any arm assignment, the resolver still returns no active overlay
    # for the (project, surface) pair.
    clear_task_arms()
    assert active_overlay("prompt", pid["id"]) is None


def test_approve_with_force_active_bypasses_trial():
    pid = _make_project()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"], force_active=True)
    updated = candidate_get(cand["id"])
    assert updated["status"] == "approved"
    overlay = overlay_get(updated["applied_overlay_id"])
    assert overlay["state"] == "active"
    assert (overlay.get("metadata") or {}).get("force_active") is True


def test_approve_tool_surface_does_not_start_trial_even_when_enabled():
    # tool surface is forbidden from A/B by SPEC §22.2; set_trial_enabled refuses,
    # so an approval on a tool surface ALWAYS uses the Level-0 path. SE-PR8 also
    # requires confirm_source_reviewed for any tool-surface approve.
    pid = _make_project()
    with pytest.raises(ValueError):
        set_trial_enabled(pid["id"], "tool", True)
    cand = candidate_create(
        surface="tool",
        title="tool",
        rationale="r",
        project_id=pid["id"],
        signal_source={"signal": "x", "signal_key": "x"},
        created_by="test",
    )
    out = approve_candidate(cand["id"], confirm_source_reviewed=True)
    assert out["status"] == "approved"


# ── snapshot recording --------------------------------------------------


def test_record_snapshot_updates_counts_and_means():
    pid = _make_project()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    trial = active_trial_for(project_id=pid["id"], surface="prompt")
    record_trial_snapshot(trial["id"], "baseline", 0.4)
    record_trial_snapshot(trial["id"], "baseline", 0.6)
    record_trial_snapshot(trial["id"], "variant", 0.8)

    refreshed = trial_get(trial["id"])
    assert refreshed["n_baseline"] == 2
    assert refreshed["n_variant"] == 1
    baseline = json.loads(refreshed["metric_baseline_json"])
    variant = json.loads(refreshed["metric_variant_json"])
    assert pytest.approx(baseline["mean"], abs=1e-3) == 0.5
    assert pytest.approx(variant["mean"], abs=1e-3) == 0.8


def test_record_snapshot_ignored_when_trial_closed():
    pid = _make_project()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    trial = active_trial_for(project_id=pid["id"], surface="prompt")
    abort_trial(trial["id"])
    record_trial_snapshot(trial["id"], "baseline", 0.9)
    refreshed = trial_get(trial["id"])
    assert refreshed["n_baseline"] == 0


# ── decision ------------------------------------------------------------


def _fill_arm(trial_id: str, arm: str, n: int, score: float):
    for _ in range(n):
        record_trial_snapshot(trial_id, arm, score)


def test_maybe_decide_returns_none_when_not_enough_samples():
    pid = _make_project()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    trial = active_trial_for(project_id=pid["id"], surface="prompt")
    _fill_arm(trial["id"], "baseline", MIN_SAMPLES_PER_ARM - 1, 0.5)
    _fill_arm(trial["id"], "variant", MIN_SAMPLES_PER_ARM, 0.9)
    assert maybe_decide_trial(trial["id"]) is None


def test_maybe_decide_variant_wins_promotes_shadow_to_active():
    pid = _make_project()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    trial = active_trial_for(project_id=pid["id"], surface="prompt")
    _fill_arm(trial["id"], "baseline", MIN_SAMPLES_PER_ARM, 0.5)
    _fill_arm(trial["id"], "variant", MIN_SAMPLES_PER_ARM, 0.5 + DECISION_MARGIN + 0.05)

    decision = maybe_decide_trial(trial["id"])
    assert decision is not None
    assert decision["decision"] == "variant_wins"
    assert decision["state"] == "completed"

    # candidate promoted, variant overlay active.
    refreshed_cand = candidate_get(cand["id"])
    assert refreshed_cand["status"] == "approved"
    variant = overlay_get(trial["variant_overlay_id"])
    assert variant["state"] == "active"


def test_maybe_decide_baseline_wins_rejects_candidate_and_retires_variant():
    pid = _make_project()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    trial = active_trial_for(project_id=pid["id"], surface="prompt")
    _fill_arm(trial["id"], "baseline", MIN_SAMPLES_PER_ARM, 0.9)
    _fill_arm(trial["id"], "variant", MIN_SAMPLES_PER_ARM, 0.9 - DECISION_MARGIN - 0.05)

    decision = maybe_decide_trial(trial["id"])
    assert decision is not None
    assert decision["decision"] == "baseline_wins"

    refreshed_cand = candidate_get(cand["id"])
    assert refreshed_cand["status"] == "rejected"
    meta = json.loads(refreshed_cand.get("metadata_json") or "{}")
    assert meta.get("ab_decision") == "baseline_wins"
    variant = overlay_get(trial["variant_overlay_id"])
    assert variant["state"] == "retired"


def test_maybe_decide_tie_rejects_candidate():
    pid = _make_project()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    trial = active_trial_for(project_id=pid["id"], surface="prompt")
    _fill_arm(trial["id"], "baseline", MIN_SAMPLES_PER_ARM, 0.5)
    _fill_arm(trial["id"], "variant", MIN_SAMPLES_PER_ARM, 0.5 + DECISION_MARGIN / 2)

    decision = maybe_decide_trial(trial["id"])
    assert decision is not None
    assert decision["decision"] == "tie"
    assert candidate_get(cand["id"])["status"] == "rejected"


# ── abort / force ------------------------------------------------------


def test_abort_trial_reverts_candidate_to_pending():
    pid = _make_project()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    trial = active_trial_for(project_id=pid["id"], surface="prompt")
    abort_trial(trial["id"], reason="changed_my_mind")
    refreshed = trial_get(trial["id"])
    assert refreshed["state"] == "reverted"
    assert candidate_get(cand["id"])["status"] == "pending"
    variant = overlay_get(trial["variant_overlay_id"])
    assert variant["state"] == "retired"


def test_force_decision_overrides_sample_requirement():
    pid = _make_project()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    trial = active_trial_for(project_id=pid["id"], surface="prompt")
    out = force_decision(trial["id"], "variant_wins")
    assert out["state"] == "completed"
    assert out["decision"] == "variant_wins"
    assert candidate_get(cand["id"])["status"] == "approved"


def test_force_decision_rejects_unknown_value():
    pid = _make_project()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    trial = active_trial_for(project_id=pid["id"], surface="prompt")
    with pytest.raises(ValueError):
        force_decision(trial["id"], "nonsense")


# ── event emission ----------------------------------------------------


def test_approve_with_trial_emits_trial_started_event():
    pid = _make_project()
    s = session_create(name="m", project_id=pid["id"])
    get_db().execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s["id"]))
    get_db().commit()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = candidate_create(
        surface="prompt",
        title="t",
        rationale="r",
        project_id=pid["id"],
        session_id=s["id"],
        signal_source={"signal": "repeated_failure", "signal_key": "k"},
        created_by="test",
    )
    events: list[dict] = []
    def sink(session_id, event_type, payload, **kwargs):
        events.append({"type": event_type})

    approve_candidate(cand["id"], event_sink=sink)
    types = [e["type"] for e in events]
    assert "evolution.trial.started" in types
    assert "evolution.candidate.approved" not in types
    assert "evolution.overlay.applied" not in types


def test_decision_emits_trial_completed_event():
    pid = _make_project()
    s = session_create(name="m", project_id=pid["id"])
    get_db().execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s["id"]))
    get_db().commit()
    set_trial_enabled(pid["id"], "prompt", True)
    cand = candidate_create(
        surface="prompt",
        title="t",
        rationale="r",
        project_id=pid["id"],
        session_id=s["id"],
        signal_source={"signal": "repeated_failure", "signal_key": "k"},
        created_by="test",
    )
    approve_candidate(cand["id"])
    trial = active_trial_for(project_id=pid["id"], surface="prompt")

    events: list[dict] = []
    def sink(session_id, event_type, payload, **kwargs):
        events.append({"type": event_type, "decision": payload.get("decision")})

    force_decision(trial["id"], "variant_wins", event_sink=sink)
    types = [e["type"] for e in events]
    assert "evolution.trial.completed" in types
    assert any(e.get("decision") == "variant_wins" for e in events)
