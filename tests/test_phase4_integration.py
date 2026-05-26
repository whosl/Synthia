"""Phase 4 API — orchestrated vivado flow and run stop."""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod
from edagent_vivado.web.app import create_app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("VIVADO_REMOTE_HOST", raising=False)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "p4.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    monkeypatch.setenv("EDAGENT_VIVADO_AUTO_APPROVE", "1")
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    from edagent_vivado.harness.execution_approval import set_vivado_execution_approval

    set_vivado_execution_approval(True)
    return TestClient(create_app())


def test_vivado_flow_orchestrator(client):
    manifest = Path("examples/uart_demo/eda.yaml")
    if not manifest.is_file():
        pytest.skip("uart_demo manifest missing")

    resp = client.post(
        "/api/v1/vivado/commands/flow",
        json={
            "manifest_path": str(manifest).replace("\\", "/"),
            "stages": ["synth"],
            "session_id": "p4_flow_sess",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "run_id" in data
    assert data.get("steps")

    steps_resp = client.get(f"/api/v1/runs/{data['run_id']}/steps")
    assert steps_resp.status_code == 200
    assert len(steps_resp.json().get("steps") or []) >= 1


def test_run_stop(client):
    run = store_mod.run_create("vivado_synth_only", name="stop-test", session_id="s1")
    store_mod.run_update(run["id"], state="running")
    resp = client.post(f"/api/v1/runs/{run['id']}/stop")
    assert resp.status_code == 200
    assert resp.json().get("state") == "cancelled"
