"""SE-PR5 API smoke: /evolution/config, /evolution/trials/*."""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from edagent_vivado.evolution import (
    approve_candidate,
    candidate_create,
    set_trial_enabled,
    trial_list,
)
from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.store import project_create, session_create
from edagent_vivado.web.app import create_app


def _client() -> TestClient:
    init_db()
    return TestClient(create_app())


def _seed_project_with_session() -> tuple[dict, dict]:
    pid = project_create(
        {
            "name": f"api-pr5-{uuid.uuid4().hex[:6]}",
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


def test_config_get_returns_defaults():
    client = _client()
    pid, _ = _seed_project_with_session()
    resp = client.get(f"/api/v1/evolution/config?project_id={pid['id']}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["project_id"] == pid["id"]
    assert body["trials"]["prompt"] is False
    assert body["trials"]["tool"] is False
    assert "tool" in body["forbidden_surfaces"]
    assert body["min_samples_per_arm"] > 0


def test_config_set_persists_and_refuses_tool():
    client = _client()
    pid, _ = _seed_project_with_session()

    resp = client.post(
        "/api/v1/evolution/config",
        json={"project_id": pid["id"], "surface": "prompt", "enabled": True},
    )
    assert resp.status_code == 200
    assert resp.json()["enabled"] is True

    cfg = client.get(f"/api/v1/evolution/config?project_id={pid['id']}").json()
    assert cfg["trials"]["prompt"] is True

    bad = client.post(
        "/api/v1/evolution/config",
        json={"project_id": pid["id"], "surface": "tool", "enabled": True},
    )
    assert bad.status_code == 400


def test_config_set_404_on_unknown_project():
    client = _client()
    resp = client.post(
        "/api/v1/evolution/config",
        json={"project_id": "nope", "surface": "prompt", "enabled": True},
    )
    assert resp.status_code == 404


def _seed_trial(pid: str, sid: str) -> str:
    set_trial_enabled(pid, "prompt", True)
    cand = candidate_create(
        surface="prompt",
        title="api trial",
        rationale="r",
        project_id=pid,
        session_id=sid,
        signal_source={"signal": "repeated_failure", "signal_key": "k"},
        created_by="test",
    )
    approve_candidate(cand["id"])
    trials = trial_list(project_id=pid, state="running")
    assert trials
    return trials[0]["id"]


def test_trials_list_returns_running_trial():
    client = _client()
    pid, s = _seed_project_with_session()
    tid = _seed_trial(pid["id"], s["id"])
    resp = client.get(f"/api/v1/evolution/trials?project_id={pid['id']}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 1
    assert body["trials"][0]["id"] == tid
    assert body["trials"][0]["state"] == "running"


def test_trial_get_decodes_metric_buckets():
    client = _client()
    pid, s = _seed_project_with_session()
    tid = _seed_trial(pid["id"], s["id"])
    resp = client.get(f"/api/v1/evolution/trials/{tid}")
    assert resp.status_code == 200
    body = resp.json()["trial"]
    assert body["metric_baseline"]["scores"] == []
    assert body["metric_variant"]["scores"] == []


def test_trial_decide_via_api():
    client = _client()
    pid, s = _seed_project_with_session()
    tid = _seed_trial(pid["id"], s["id"])
    resp = client.post(
        f"/api/v1/evolution/trials/{tid}/decide",
        json={"decision": "variant_wins"},
    )
    assert resp.status_code == 200
    body = resp.json()["trial"]
    assert body["state"] == "completed"
    assert body["decision"] == "variant_wins"


def test_trial_decide_rejects_unknown_value():
    client = _client()
    pid, s = _seed_project_with_session()
    tid = _seed_trial(pid["id"], s["id"])
    resp = client.post(
        f"/api/v1/evolution/trials/{tid}/decide",
        json={"decision": "bogus"},
    )
    assert resp.status_code == 400


def test_trial_decide_404_for_unknown_id():
    client = _client()
    resp = client.post(
        "/api/v1/evolution/trials/nope/decide",
        json={"decision": "variant_wins"},
    )
    assert resp.status_code == 404


def test_trial_abort_via_api():
    client = _client()
    pid, s = _seed_project_with_session()
    tid = _seed_trial(pid["id"], s["id"])
    resp = client.post(
        f"/api/v1/evolution/trials/{tid}/abort",
        json={"reason": "operator"},
    )
    assert resp.status_code == 200
    body = resp.json()["trial"]
    assert body["state"] == "reverted"
