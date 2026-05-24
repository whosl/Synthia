"""SE-PR4 unit tests: approve / reject (with suppression) / merge / rollback / retire."""

from __future__ import annotations

import json
import time
import uuid

import pytest

from edagent_vivado.evolution import (
    active_overlay,
    approve_candidate,
    candidate_create,
    candidate_get,
    gen_recurrence,
    merge_candidate,
    overlay_get,
    overlay_list,
    overlay_retire_active_for,
    reject_candidate,
    resolve_flow_template,
    resolve_prompt,
    resolve_routing,
    retire_overlay,
    rollback_candidate,
)
from edagent_vivado.evolution.generators import RECURRENCE_MIN_SESSIONS
from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.store import (
    problem_create,
    project_create,
    session_create,
)


def _make_project() -> dict:
    init_db()
    return project_create(
        {
            "name": f"se-pr4-{uuid.uuid4().hex[:6]}",
            "status": "active",
            "root_path": ".",
            "manifest_path": "eda.yaml",
            "xpr_path": "",
            "part": "xc7a35t",
        }
    )


def _make_prompt_candidate(pid: str, *, signal: str = "repeated_failure") -> dict:
    return candidate_create(
        surface="prompt",
        title=f"prompt-{signal}",
        rationale="r",
        project_id=pid,
        signal_source={
            "signal": signal,
            "signal_key": f"{signal}:rolling_10",
            "first_run_success": 0.2,
            "sample_size": 6,
        },
        created_by="test",
    )


def _make_kb_candidate(pid: str, signature: str = "synth-8-439:echo") -> dict:
    return candidate_create(
        surface="kb",
        title=f"kb:{signature}",
        rationale="recurring",
        project_id=pid,
        signal_source={
            "signal": "recurrence",
            "signal_key": f"recurrence:{signature}",
            "normalized_signature": signature,
            "sample_message": "ERROR: [Synth 8-439]",
            "sample_category": "vivado",
        },
        created_by="test",
    )


# ── approve --------------------------------------------------------------


def test_approve_creates_active_overlay_for_prompt():
    pid = _make_project()
    cand = _make_prompt_candidate(pid["id"])

    updated = approve_candidate(cand["id"])
    assert updated["status"] == "approved"
    overlay_id = updated["applied_overlay_id"]
    assert overlay_id

    overlay = overlay_get(overlay_id)
    assert overlay["surface"] == "prompt"
    assert overlay["state"] == "active"
    assert overlay["source_candidate_id"] == cand["id"]
    payload = overlay["payload"]
    assert payload["mode"] == "append"
    assert "first-run success" in payload["text"]

    # Resolver picks it up automatically.
    merged_prompt = resolve_prompt("BASE", project_id=pid["id"])
    assert merged_prompt.startswith("BASE")
    assert payload["text"][:30] in merged_prompt


def test_approve_with_payload_override_uses_explicit_text():
    pid = _make_project()
    cand = _make_prompt_candidate(pid["id"])

    approve_candidate(
        cand["id"],
        payload_override={"mode": "prepend", "text": "Custom override"},
    )
    out = resolve_prompt("BASE", project_id=pid["id"])
    assert out.startswith("Custom override")


def test_approve_kb_candidate_creates_kb_case_and_overlay():
    pid = _make_project()
    cand = _make_kb_candidate(pid["id"], "synth-8-439:uart")
    updated = approve_candidate(cand["id"])
    assert updated["status"] == "approved"

    overlay = overlay_get(updated["applied_overlay_id"])
    assert overlay["surface"] == "kb"
    assert overlay["state"] == "active"
    kb_case_id = overlay["payload"].get("kb_case_id")
    assert kb_case_id

    # kb_cases row exists with the same pattern as the candidate's signature.
    row = get_db().execute("SELECT * FROM kb_cases WHERE id=?", (kb_case_id,)).fetchone()
    assert row is not None
    assert row["pattern"] == "synth-8-439:uart"


def test_approve_retires_previous_active_overlay_and_links_parent():
    pid = _make_project()
    first = _make_prompt_candidate(pid["id"], signal="repeated_failure")
    approve_candidate(first["id"])
    first_overlay_id = candidate_get(first["id"])["applied_overlay_id"]

    second = _make_prompt_candidate(pid["id"], signal="approval_drop")
    approve_candidate(second["id"])

    overlays = overlay_list(project_id=pid["id"], surface="prompt")
    by_state = {o["id"]: o["state"] for o in overlays}
    assert by_state[first_overlay_id] == "retired"

    new_overlay_id = candidate_get(second["id"])["applied_overlay_id"]
    assert by_state[new_overlay_id] == "active"
    new_overlay = overlay_get(new_overlay_id)
    assert new_overlay["parent_overlay_id"] == first_overlay_id


def test_approve_session_scope_candidate_is_rejected():
    pid = _make_project()
    s = session_create(name="m", project_id=pid["id"])
    get_db().execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s["id"]))
    get_db().commit()
    cand = candidate_create(
        surface="prompt",
        title="session-only",
        scope="session",
        session_id=s["id"],
        rationale="r",
        signal_source={"signal": "negative_feedback", "signal_key": "x"},
        created_by="test",
    )
    with pytest.raises(ValueError):
        approve_candidate(cand["id"])


def test_approve_non_pending_fails():
    pid = _make_project()
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    with pytest.raises(ValueError):
        approve_candidate(cand["id"])


# ── reject + suppression -------------------------------------------------


def test_reject_changes_status_only():
    pid = _make_project()
    cand = _make_prompt_candidate(pid["id"])
    out = reject_candidate(cand["id"], reason="not useful")
    assert out["status"] == "rejected"
    meta = json.loads(out.get("metadata_json") or "{}")
    assert meta.get("reject_reason") == "not useful"
    assert "suppressed_until" not in meta


def test_reject_with_suppression_blocks_regeneration():
    pid = _make_project()
    # Seed 3 sessions with the same signature so recurrence would fire.
    for _ in range(RECURRENCE_MIN_SESSIONS):
        s = session_create(name="m", project_id=pid["id"])
        get_db().execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s["id"]))
        get_db().commit()
        problem_create(
            s["id"], "ERROR: combo", source="harness",
            normalized_signature="suppress-key",
            category="vivado", severity="error",
        )

    out = gen_recurrence(project_id=pid["id"])
    assert len(out) == 1
    candidate_id = out[0]["id"]

    reject_candidate(candidate_id, suppress_days=7)

    again = gen_recurrence(project_id=pid["id"])
    # Suppressed → blocks regeneration; the existing rejected row comes back.
    assert len(again) == 1
    assert again[0]["id"] == candidate_id
    assert again[0]["status"] == "rejected"


def test_reject_without_suppression_allows_regeneration():
    pid = _make_project()
    for _ in range(RECURRENCE_MIN_SESSIONS):
        s = session_create(name="m", project_id=pid["id"])
        get_db().execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s["id"]))
        get_db().commit()
        problem_create(
            s["id"], "ERROR", source="harness",
            normalized_signature="no-suppress-key",
            category="vivado", severity="error",
        )
    first = gen_recurrence(project_id=pid["id"])
    reject_candidate(first[0]["id"], suppress_days=0)
    again = gen_recurrence(project_id=pid["id"])
    # No suppression → a brand new pending candidate.
    assert len(again) == 1
    assert again[0]["id"] != first[0]["id"]
    assert again[0]["status"] == "pending"


def test_reject_expired_suppression_is_unblocked():
    pid = _make_project()
    cand = _make_kb_candidate(pid["id"], "expire-key")
    # Reject + set already-expired suppression
    reject_candidate(cand["id"], suppress_days=1)
    get_db().execute(
        "UPDATE evolution_candidates SET metadata_json=? WHERE id=?",
        (json.dumps({"suppressed_until": int(time.time()) - 10}), cand["id"]),
    )
    get_db().commit()

    # Trigger recurrence again via 3 sessions with the same signature.
    for _ in range(RECURRENCE_MIN_SESSIONS):
        s = session_create(name="m", project_id=pid["id"])
        get_db().execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s["id"]))
        get_db().commit()
        problem_create(
            s["id"], "ERROR", source="harness",
            normalized_signature="expire-key",
            category="vivado", severity="error",
        )
    out = gen_recurrence(project_id=pid["id"])
    assert len(out) == 1
    assert out[0]["id"] != cand["id"]


# ── merge ----------------------------------------------------------------


def test_merge_promotes_project_to_global_pending():
    pid = _make_project()
    cand = _make_prompt_candidate(pid["id"])
    merge_candidate(cand["id"])

    merged = candidate_get(cand["id"])
    assert merged["status"] == "merged"

    # A global-scope sibling exists in pending state with promoted_from metadata.
    rows = get_db().execute(
        """SELECT * FROM evolution_candidates
             WHERE status='pending' AND scope='global'
                AND json_extract(metadata_json, '$.promoted_from')=?""",
        (cand["id"],),
    ).fetchall()
    assert len(rows) == 1


def test_merge_session_candidate_yields_project_pending():
    pid = _make_project()
    s = session_create(name="m", project_id=pid["id"])
    get_db().execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s["id"]))
    get_db().commit()
    cand = candidate_create(
        surface="prompt",
        title="session-promote",
        scope="session",
        project_id=pid["id"],
        session_id=s["id"],
        rationale="r",
        signal_source={"signal": "negative_feedback", "signal_key": "x"},
        created_by="test",
    )
    merge_candidate(cand["id"])
    promoted = get_db().execute(
        """SELECT * FROM evolution_candidates
             WHERE status='pending' AND scope='project'
                AND json_extract(metadata_json, '$.promoted_from')=?""",
        (cand["id"],),
    ).fetchall()
    assert len(promoted) == 1


def test_merge_global_fails():
    pid = _make_project()
    cand = candidate_create(
        surface="prompt",
        title="already-global",
        scope="global",
        rationale="r",
        signal_source={"signal": "x", "signal_key": "x"},
        created_by="test",
    )
    with pytest.raises(ValueError):
        merge_candidate(cand["id"])


# ── rollback -------------------------------------------------------------


def test_rollback_restores_parent_overlay():
    pid = _make_project()
    first = _make_prompt_candidate(pid["id"], signal="repeated_failure")
    approve_candidate(first["id"])
    first_overlay_id = candidate_get(first["id"])["applied_overlay_id"]

    second = _make_prompt_candidate(pid["id"], signal="approval_drop")
    approve_candidate(second["id"])
    second_overlay_id = candidate_get(second["id"])["applied_overlay_id"]

    # Rolling back the second candidate must re-activate the first overlay.
    rollback_candidate(second["id"])

    assert overlay_get(second_overlay_id)["state"] == "retired"
    assert overlay_get(first_overlay_id)["state"] == "active"
    cand = candidate_get(second["id"])
    assert cand["status"] == "rolled_back"

    # Resolver returns the restored overlay's payload (from the first candidate).
    out = resolve_prompt("BASE", project_id=pid["id"])
    assert "first-run success" in out.lower() or "First-run" in out


def test_rollback_without_parent_just_retires():
    pid = _make_project()
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    overlay_id = candidate_get(cand["id"])["applied_overlay_id"]

    rollback_candidate(cand["id"], reason="reverted")
    assert overlay_get(overlay_id)["state"] == "retired"
    after = candidate_get(cand["id"])
    meta = json.loads(after.get("metadata_json") or "{}")
    assert meta.get("rollback_reason") == "reverted"
    # No active overlay remains.
    assert active_overlay("prompt", pid["id"]) is None


def test_rollback_non_approved_fails():
    pid = _make_project()
    cand = _make_prompt_candidate(pid["id"])
    with pytest.raises(ValueError):
        rollback_candidate(cand["id"])


# ── manual retire --------------------------------------------------------


def test_retire_overlay_directly():
    pid = _make_project()
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    overlay_id = candidate_get(cand["id"])["applied_overlay_id"]
    retire_overlay(overlay_id)
    assert overlay_get(overlay_id)["state"] == "retired"
    # Candidate row is left at status=approved; manual retire is operator action.
    assert candidate_get(cand["id"])["status"] == "approved"


def test_overlay_retire_active_for_returns_row():
    pid = _make_project()
    cand = _make_prompt_candidate(pid["id"])
    approve_candidate(cand["id"])
    retired = overlay_retire_active_for(surface="prompt", project_id=pid["id"])
    assert retired and retired["state"] == "retired"
    # Idempotent: a second call returns None.
    assert overlay_retire_active_for(surface="prompt", project_id=pid["id"]) is None


# ── resolver smoke -------------------------------------------------------


def test_resolve_flow_template_returns_none_with_default_payload():
    pid = _make_project()
    cand = candidate_create(
        surface="flow_template",
        title="flow",
        rationale="r",
        project_id=pid["id"],
        signal_source={"signal": "x", "signal_key": "x"},
        created_by="test",
    )
    approve_candidate(cand["id"])
    # Default flow_template payload has empty templates → None.
    assert resolve_flow_template("synth", project_id=pid["id"]) is None
    # With explicit body it appears.
    cand2 = candidate_create(
        surface="flow_template",
        title="flow2",
        rationale="r",
        project_id=pid["id"],
        signal_source={"signal": "y", "signal_key": "y"},
        created_by="test",
    )
    approve_candidate(
        cand2["id"],
        payload_override={"templates": {"synth": "# custom synth\nsynth_design -top ${top}\n"}},
    )
    body = resolve_flow_template("synth", project_id=pid["id"])
    assert body is not None
    assert "custom synth" in body


def test_resolve_routing_returns_none_for_empty_default():
    pid = _make_project()
    cand = candidate_create(
        surface="routing",
        title="route",
        rationale="r",
        project_id=pid["id"],
        signal_source={"signal": "x", "signal_key": "x"},
        created_by="test",
    )
    approve_candidate(cand["id"])
    # Default routing payload has empty rules / weights → resolver collapses to None.
    assert resolve_routing(project_id=pid["id"]) is None


# ── event emission -------------------------------------------------------


def test_approve_emits_candidate_approved_and_overlay_applied():
    pid = _make_project()
    s = session_create(name="m", project_id=pid["id"])
    get_db().execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s["id"]))
    get_db().commit()
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
        events.append({"type": event_type, "session_id": session_id, **kwargs})

    approve_candidate(cand["id"], event_sink=sink)
    types = [e["type"] for e in events]
    assert "evolution.candidate.approved" in types
    assert "evolution.overlay.applied" in types
