"""Golden path: manifest → connector synth → run_steps (mock/local)."""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest

from edagent_vivado.connectors.base.registry import clear_registry
from edagent_vivado.connectors.base.types import ToolRunRequest
from edagent_vivado.connectors.run_execution import execute_with_steps
from edagent_vivado.connectors.vivado.connector import register
from edagent_vivado.harness.run_workspace import workspace_root_for_run
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.delenv("VIVADO_REMOTE_HOST", raising=False)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "gold.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    clear_registry()
    register()
    yield store_mod
    clear_registry()


def test_golden_path_synthesis_mock(store):
    manifest = Path("examples/uart_demo/eda.yaml").resolve()
    if not manifest.is_file():
        pytest.skip("examples/uart_demo/eda.yaml not found")

    proj = store.project_create({
        "name": "golden",
        "root_path": str(manifest.parent),
        "manifest_path": str(manifest),
    })
    sess = store.session_create("golden", project_id=proj["id"])
    run = store.run_create("task", "golden-synth", session_id=sess["id"])

    req = ToolRunRequest(
        request_id="g1",
        run_id=run["id"],
        step_id="",
        connector_id="vivado",
        capability_id="run_synthesis",
        inputs={
            "manifest_path": str(manifest),
            "session_id": sess["id"],
            "run_id": run["id"],
        },
        manifest_path=str(manifest),
        auto_approved=True,
    )
    result = execute_with_steps(req)
    steps = store.run_step_list(run["id"])
    requests = store.tool_run_request_list(run_id=run["id"])

    assert len(steps) == 1
    assert steps[0]["capability_id"] == "run_synthesis"
    assert len(requests) == 1
    root = workspace_root_for_run(run["id"])
    assert root and root.is_dir()

    if result.success:
        assert result.edagent_outcome == "execution_succeeded"
    else:
        assert result.edagent_outcome in ("execution_failed", "policy_denied")
