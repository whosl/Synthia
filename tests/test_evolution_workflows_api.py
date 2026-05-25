"""SE-PR4 API smoke: approve / reject / merge / rollback + overlays endpoints."""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from edagent_vivado.evolution import (
    candidate_create,
    candidate_get,
    resolve_prompt,
)
from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.store import project_create, session_create
from edagent_vivado.web.app import create_app


def _client() -> TestClient:
    init_db()
    return TestClient(create_app())


def _seed_project_with_pending_candidate() -> tuple[dict, dict, dict]:
    pid = project_create(
        {
            "name": f"api-pr4-{uuid.uuid4().hex[:6]}",
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
    cand = candidate_create(
        surface="prompt",
        title="api candidate",
        rationale="r",
        project_id=pid["id"],
        session_id=s["id"],
        signal_source={
            "signal": "repeated_failure",
            "signal_key": "repeated_failure:rolling_10",
            "first_run_success": 0.15,
            "sample_size": 6,
        },
        created_by="test",
    )
    return pid, s, cand


def test_preview_via_api_shows_prompt_text_before_approve():
    client = _client()
    _, _, cand = _seed_project_with_pending_candidate()

    resp = client.get(f"/api/v1/evolution/candidates/{cand['id']}/preview")
    assert resp.status_code == 200, resp.text
    preview = resp.json()["preview"]
    assert preview["surface"] == "prompt"
    assert preview["prompt_mode"] == "append"
    assert "15%" in preview["prompt_text"]
    assert "parse_vivado_log_tool" in preview["prompt_text"]


def test_get_candidate_includes_apply_preview():
    client = _client()
    _, _, cand = _seed_project_with_pending_candidate()

    resp = client.get(f"/api/v1/evolution/candidates/{cand['id']}")
    assert resp.status_code == 200, resp.text
    body = resp.json()["candidate"]
    assert body.get("apply_preview")
    assert body["apply_preview"]["prompt_text"]


def test_approve_via_api_creates_active_overlay_and_emits_events():
    client = _client()
    pid, s, cand = _seed_project_with_pending_candidate()

    resp = client.post(
        f"/api/v1/evolution/candidates/{cand['id']}/approve",
        json={"reviewed_by": "tester"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["candidate"]["status"] == "approved"
    overlay_id = body["overlay_id"]
    assert overlay_id

    overlays = client.get(f"/api/v1/evolution/overlays?project_id={pid['id']}").json()
    assert overlays["count"] == 1
    assert overlays["overlays"][0]["state"] == "active"

    events = client.get(f"/api/v1/sessions/{s['id']}/events?after_seq=0").json()["events"]
    types = {e["event_type"] for e in events}
    assert "evolution.candidate.approved" in types
    assert "evolution.overlay.applied" in types

    # Resolver returns the prompt overlay text now.
    out = resolve_prompt("BASE", project_id=pid["id"])
    assert out.startswith("BASE")
    assert "first-run success" in out.lower()


def test_approve_with_payload_override_via_api():
    client = _client()
    pid, _, cand = _seed_project_with_pending_candidate()
    resp = client.post(
        f"/api/v1/evolution/candidates/{cand['id']}/approve",
        json={"payload": {"mode": "replace", "text": "OVERRIDDEN"}},
    )
    assert resp.status_code == 200
    out = resolve_prompt("BASE", project_id=pid["id"])
    assert out == "OVERRIDDEN"


def test_reject_with_suppression_via_api():
    client = _client()
    _, _, cand = _seed_project_with_pending_candidate()
    resp = client.post(
        f"/api/v1/evolution/candidates/{cand['id']}/reject",
        json={"suppress_days": 14, "reason": "noisy"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["candidate"]["status"] == "rejected"
    assert body["candidate"]["metadata"]["suppressed_until"]
    assert body["candidate"]["metadata"]["reject_reason"] == "noisy"


def test_reject_validates_suppress_days_bounds():
    client = _client()
    _, _, cand = _seed_project_with_pending_candidate()
    resp = client.post(
        f"/api/v1/evolution/candidates/{cand['id']}/reject",
        json={"suppress_days": -1},
    )
    assert resp.status_code == 400
    resp = client.post(
        f"/api/v1/evolution/candidates/{cand['id']}/reject",
        json={"suppress_days": 9999},
    )
    assert resp.status_code == 400


def test_merge_via_api_creates_promoted_pending():
    client = _client()
    _, _, cand = _seed_project_with_pending_candidate()
    resp = client.post(f"/api/v1/evolution/candidates/{cand['id']}/merge", json={})
    assert resp.status_code == 200
    body = resp.json()
    assert body["candidate"]["status"] == "merged"

    # Confirm one new global-scope pending candidate exists.
    listed = client.get("/api/v1/evolution/candidates?status=pending").json()
    promoted = [
        c for c in listed["candidates"]
        if c.get("metadata", {}).get("promoted_from") == cand["id"]
    ]
    assert len(promoted) == 1
    assert promoted[0]["scope"] == "global"


def test_rollback_via_api_retires_overlay_and_restores_parent():
    client = _client()
    pid, _, first = _seed_project_with_pending_candidate()
    client.post(f"/api/v1/evolution/candidates/{first['id']}/approve", json={})

    # second prompt candidate -> approve so it stacks on top
    second = candidate_create(
        surface="prompt",
        title="api candidate 2",
        rationale="r",
        project_id=pid["id"],
        signal_source={
            "signal": "approval_drop",
            "signal_key": "approval_drop:rolling_10",
            "approval_pass_rate": 0.2,
            "sample_size": 7,
        },
        created_by="test",
    )
    client.post(f"/api/v1/evolution/candidates/{second['id']}/approve", json={})

    resp = client.post(
        f"/api/v1/evolution/candidates/{second['id']}/rollback",
        json={"reason": "user said no"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["candidate"]["status"] == "rolled_back"

    # First overlay back as the active one.
    overlays = client.get(
        f"/api/v1/evolution/overlays?project_id={pid['id']}&state=active"
    ).json()
    assert overlays["count"] == 1
    assert overlays["overlays"][0]["source_candidate_id"] == first["id"]


def test_retire_overlay_endpoint():
    client = _client()
    pid, _, cand = _seed_project_with_pending_candidate()
    client.post(f"/api/v1/evolution/candidates/{cand['id']}/approve", json={})
    overlay_id = candidate_get(cand["id"])["applied_overlay_id"]

    resp = client.post(f"/api/v1/evolution/overlays/{overlay_id}/retire")
    assert resp.status_code == 200
    assert resp.json()["overlay"]["state"] == "retired"


def test_unknown_candidate_returns_404():
    client = _client()
    resp = client.post("/api/v1/evolution/candidates/nope/approve", json={})
    assert resp.status_code == 404


def test_double_approve_returns_400():
    client = _client()
    _, _, cand = _seed_project_with_pending_candidate()
    client.post(f"/api/v1/evolution/candidates/{cand['id']}/approve", json={})
    resp = client.post(f"/api/v1/evolution/candidates/{cand['id']}/approve", json={})
    assert resp.status_code == 400
