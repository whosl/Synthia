"""SE-PR6 API smoke: /evolution/eval/{sets,runs,run}."""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from edagent_vivado.evolution import eval_run_list
from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.store import project_create
from edagent_vivado.web.app import create_app


def _client() -> TestClient:
    init_db()
    return TestClient(create_app())


def _make_project() -> dict:
    return project_create(
        {
            "name": f"api-pr6-{uuid.uuid4().hex[:6]}",
            "status": "active",
            "root_path": ".",
            "manifest_path": "eda.yaml",
            "xpr_path": "",
            "part": "xc7a35t",
        }
    )


def test_eval_sets_list_returns_repo_fixtures():
    client = _client()
    resp = client.get("/api/v1/evolution/eval/sets")
    assert resp.status_code == 200
    body = resp.json()
    assert body["runner_implemented"] is False
    names = {s["name"] for s in body["sets"]}
    assert "smoke" in names
    assert "vivado_synth" in names


def test_eval_set_get_returns_cases():
    client = _client()
    resp = client.get("/api/v1/evolution/eval/sets/smoke")
    assert resp.status_code == 200
    body = resp.json()
    assert body["set"]["name"] == "smoke"
    assert body["set"]["case_count"] >= 2
    assert body["runner_implemented"] is False


def test_eval_set_get_404_unknown():
    client = _client()
    resp = client.get("/api/v1/evolution/eval/sets/nope")
    assert resp.status_code == 404


def test_eval_run_post_queues_placeholder_row():
    client = _client()
    pid = _make_project()
    resp = client.post(
        "/api/v1/evolution/eval/run",
        json={"eval_set": "smoke", "project_id": pid["id"], "note": "via-api"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["runner_implemented"] is False
    assert body["run"]["state"] == "placeholder"
    assert body["run"]["eval_set"] == "smoke"

    listed = client.get("/api/v1/evolution/eval/runs?eval_set=smoke").json()
    assert listed["count"] >= 1
    assert any(r["id"] == body["run"]["id"] for r in listed["runs"])


def test_eval_run_post_rejects_unknown_set():
    client = _client()
    resp = client.post(
        "/api/v1/evolution/eval/run",
        json={"eval_set": "definitely-nope"},
    )
    assert resp.status_code == 400


def test_eval_run_post_rejects_unknown_project():
    client = _client()
    resp = client.post(
        "/api/v1/evolution/eval/run",
        json={"eval_set": "smoke", "project_id": "missing"},
    )
    assert resp.status_code == 404


def test_eval_run_get_returns_decoded_metadata():
    client = _client()
    resp = client.post(
        "/api/v1/evolution/eval/run",
        json={"eval_set": "smoke", "note": "detail-check"},
    )
    rid = resp.json()["run"]["id"]
    detail = client.get(f"/api/v1/evolution/eval/runs/{rid}").json()
    assert detail["run"]["state"] == "placeholder"
    assert detail["run"]["metadata"]["note"] == "detail-check"
    assert detail["run"]["metadata"]["spec_section"] == "22.6B"
    assert detail["runner_implemented"] is False


def test_eval_run_get_404_unknown():
    client = _client()
    resp = client.get("/api/v1/evolution/eval/runs/nope")
    assert resp.status_code == 404


def test_protocol_includes_eval_events():
    client = _client()
    body = client.get("/api/v1/events/protocol").json()
    types = set(body.get("wire_event_types", []))
    assert "evolution.eval.queued" in types
    assert "evolution.eval.completed" in types
