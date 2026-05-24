"""SE-PR2 API smoke: /feedback, /metrics/summary, /metrics/series."""

from __future__ import annotations

import json
import time
import uuid

from fastapi.testclient import TestClient

from edagent_vivado.evolution import collect_task_metrics
from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.store import (
    project_create,
    run_create,
    session_create,
    task_create,
    task_update,
    toolcall_create,
    toolcall_update,
)
from edagent_vivado.web.app import create_app


def _client() -> TestClient:
    init_db()
    return TestClient(create_app())


def _seed_project_session_task():
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
    t = task_create(s["id"], user_message_id=None)
    task_update(t["id"], state="running", started_at=int(time.time()) - 10)
    return pid, s, t


def test_feedback_post_persists_and_emits_event():
    client = _client()
    _, s, t = _seed_project_session_task()
    resp = client.post(
        "/api/v1/feedback",
        json={
            "session_id": s["id"],
            "task_id": t["id"],
            "user_thumb": 1,
            "comment": "great",
            "tags": ["timing"],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["feedback"]["user_thumb"] == 1

    listed = client.get(f"/api/v1/sessions/{s['id']}/feedback").json()
    assert any(row["id"] == body["feedback"]["id"] for row in listed["feedback"])

    events = client.get(f"/api/v1/sessions/{s['id']}/events?after_seq=0").json()
    assert any(e["event_type"] == "evolution.feedback.created" for e in events["events"])


def test_feedback_rejects_bad_thumb():
    client = _client()
    _, s, _ = _seed_project_session_task()
    resp = client.post(
        "/api/v1/feedback",
        json={"session_id": s["id"], "user_thumb": 99},
    )
    assert resp.status_code == 400


def test_feedback_rejects_unknown_session():
    client = _client()
    resp = client.post(
        "/api/v1/feedback",
        json={"session_id": "does-not-exist", "user_thumb": 1},
    )
    assert resp.status_code == 404


def test_metrics_summary_returns_null_with_no_data():
    client = _client()
    pid, _, _ = _seed_project_session_task()
    resp = client.get(f"/api/v1/metrics/summary?project_id={pid['id']}&window=rolling_10")
    assert resp.status_code == 200
    body = resp.json()
    assert body["snapshot"] is None
    assert body["project_id"] == pid["id"]
    assert body["window"] == "rolling_10"


def test_metrics_series_returns_after_collect():
    client = _client()
    pid, s, t = _seed_project_session_task()
    run = run_create("task", f"task:{t['id']}", session_id=s["id"], task_id=t["id"])
    tc = toolcall_create(run_id=run["id"], tool_name="run_vivado_synth_tool",
                         session_id=s["id"], task_id=t["id"], input_summary="{}")
    toolcall_update(
        tc["id"],
        state="completed",
        finished_at=int(time.time()),
        elapsed_ms=42,
        output_summary=json.dumps({
            "edagent_outcome": "execution_succeeded",
            "summary": "ok", "ran": True, "success": True,
        }),
    )
    task_update(t["id"], state="done", finished_at=int(time.time()))
    snap = collect_task_metrics(session_id=s["id"], task_id=t["id"], run_id=run["id"])
    assert snap is not None

    resp = client.get(f"/api/v1/metrics/series?project_id={pid['id']}&scope=task&window=single&limit=5")
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] >= 1
    assert body["series"][-1]["composite_score"] is not None
