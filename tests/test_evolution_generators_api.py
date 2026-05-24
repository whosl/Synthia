"""SE-PR3 API: /evolution/candidates list+get and on-demand /generators/run."""

from __future__ import annotations

import time
import uuid

from fastapi.testclient import TestClient

from edagent_vivado.evolution.generators import (
    NEGATIVE_FEEDBACK_MIN_NEGATIVES,
    RECURRENCE_MIN_SESSIONS,
)
from edagent_vivado.evolution import feedback_create
from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.store import (
    problem_create,
    project_create,
    session_create,
)
from edagent_vivado.web.app import create_app


def _client() -> TestClient:
    init_db()
    return TestClient(create_app())


def _make_project_session():
    pid = project_create(
        {
            "name": f"api-{uuid.uuid4().hex[:6]}",
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


def test_candidates_list_returns_pending_only_by_default():
    client = _client()
    pid, _ = _make_project_session()
    # No candidates -> empty.
    resp = client.get(f"/api/v1/evolution/candidates?project_id={pid['id']}")
    assert resp.status_code == 200
    assert resp.json()["count"] == 0


def test_candidate_get_404_on_unknown_id():
    client = _client()
    resp = client.get("/api/v1/evolution/candidates/nope")
    assert resp.status_code == 404


def test_generators_run_recurrence_via_api():
    client = _client()
    pid, _ = _make_project_session()
    for _ in range(RECURRENCE_MIN_SESSIONS):
        s = session_create(name="m", project_id=pid["id"])
        get_db().execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s["id"]))
        get_db().commit()
        problem_create(
            s["id"], "ERROR: api-recurrence-test",
            source="harness", normalized_signature="api-recur-key",
            category="vivado", severity="error",
        )

    resp = client.post(
        "/api/v1/evolution/generators/run",
        json={"project_id": pid["id"], "only": ["recurrence"]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["created"]) == 1
    assert body["created"][0]["generator"] == "recurrence"
    assert body["errors"] == {}

    listed = client.get(
        f"/api/v1/evolution/candidates?project_id={pid['id']}&surface=kb"
    ).json()
    assert listed["count"] == 1
    cand = listed["candidates"][0]
    assert cand["signal_source"]["normalized_signature"] == "api-recur-key"


def test_generators_run_rejects_unknown_project():
    client = _client()
    resp = client.post(
        "/api/v1/evolution/generators/run",
        json={"project_id": "does-not-exist"},
    )
    assert resp.status_code == 404


def test_generators_run_emits_events_when_session_supplied():
    client = _client()
    pid, s = _make_project_session()
    for _ in range(NEGATIVE_FEEDBACK_MIN_NEGATIVES):
        feedback_create(session_id=s["id"], user_thumb=-1)

    resp = client.post(
        "/api/v1/evolution/generators/run",
        json={
            "project_id": pid["id"],
            "session_id": s["id"],
            "only": ["negative_feedback"],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert any(c["generator"] == "negative_feedback" for c in body["created"])

    events = client.get(f"/api/v1/sessions/{s['id']}/events?after_seq=0").json()["events"]
    types = {e["event_type"] for e in events}
    assert "evolution.signal.fired" in types
    assert "evolution.candidate.created" in types
