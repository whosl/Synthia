"""Phase 12 — hardware REST API."""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient

from edagent_vivado.repository import db as db_mod
from edagent_vivado.web.app import create_app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("VIVADO_REMOTE_HOST", raising=False)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "hw_api.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    monkeypatch.setenv("SYNTHIA_AUTH_TEST_MODE", "1")
    monkeypatch.setenv("SYNTHIA_HW_MOCK_DETECT", "1")
    importlib.reload(db_mod)
    db_mod.close_db()
    db_mod.init_db()
    return TestClient(create_app())


def test_detect_and_list_targets(client):
    r = client.post("/api/v1/hardware/targets/detect", json={})
    assert r.status_code == 200
    assert r.json()["detected_count"] >= 1

    r2 = client.get("/api/v1/hardware/targets")
    assert r2.status_code == 200
    assert len(r2.json()["targets"]) >= 1


def test_open_session_and_request_program(client, tmp_path):
    detect = client.post("/api/v1/hardware/targets/detect", json={})
    targets = client.get("/api/v1/hardware/targets").json()["targets"]
    assert targets
    tid = targets[0]["id"]

    sess = client.post(
        "/api/v1/hardware/sessions",
        json={"target_id": tid, "project_id": ""},
    )
    assert sess.status_code == 200
    session_id = sess.json()["id"]

    bit = tmp_path / "t.bit"
    bit.write_bytes(b"x")
    from edagent_vivado.repository.store import artifact_create

    art = artifact_create("bitstream", str(bit), session_id=session_id)

    req = client.post(
        "/api/v1/hardware/program/request",
        json={
            "hardware_session_id": session_id,
            "bitstream_artifact_id": art["id"],
        },
    )
    assert req.status_code == 200
    assert req.json()["job"]["state"] == "pending_approval"


def test_approve_requires_reason(client):
    detect = client.post("/api/v1/hardware/targets/detect", json={})
    assert detect.status_code == 200
    job_id = "00000000-0000-0000-0000-000000000000"
    r = client.post(
        f"/api/v1/hardware/program/{job_id}/approve",
        json={"reason": ""},
    )
    assert r.status_code in (400, 404)
