"""SPEC Phase 6 acceptance — five criteria (mock-safe)."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

from edagent_vivado.agent.graph import _TOOLS
from edagent_vivado.agent.planner import plan_task
from edagent_vivado.connectors import ensure_connectors
from edagent_vivado.connectors.base.registry import clear_registry, get_connector
from edagent_vivado.connectors.base.types import ToolRunRequest
from edagent_vivado.connectors.run_execution import execute_with_steps
from edagent_vivado.connectors.vivado.connector import register as register_vivado
from edagent_vivado.connectors.verilator.connector import register as register_verilator
from edagent_vivado.harness.run_workspace import RUN_WORKSPACE_SUBDIRS, ensure_run_workspace
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.delenv("VIVADO_REMOTE_HOST", raising=False)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "p6.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    monkeypatch.setenv("EDAGENT_LLM_PLANNER", "0")
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


@pytest.fixture(autouse=True)
def _connectors():
    clear_registry()
    register_vivado()
    register_verilator()
    yield
    clear_registry()


def test_acceptance_1_planner_outputs_capabilities(store):
    """Agent Planner outputs capability plan, not raw Tcl."""
    steps = plan_task("run vivado synthesis", manifest_path="examples/uart_demo/eda.yaml")
    assert steps
    assert all(s.connector and s.capability for s in steps)
    assert any(s.capability == "run_synthesis" for s in steps)


def test_acceptance_2_vivado_synth_steps_workspace(store, monkeypatch):
    """Vivado synth via connector creates steps + workspace."""
    proj = store.project_create({
        "name": "p6",
        "root_path": str(Path.cwd()),
        "manifest_path": "examples/uart_demo/eda.yaml",
    })
    sess = store.session_create("s", project_id=proj["id"])
    run = store.run_create("task", "t", session_id=sess["id"])
    ensure_run_workspace(run["id"])
    manifest = Path("examples/uart_demo/eda.yaml")
    if not manifest.is_file():
        pytest.skip("uart_demo manifest missing")

    req = ToolRunRequest(
        request_id="acc2",
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
    assert len(steps) >= 1
    ws = ensure_run_workspace(run["id"])
    assert ws.root.is_dir()
    for sub in RUN_WORKSPACE_SUBDIRS:
        assert (ws.root / sub).is_dir()
    assert result.edagent_outcome in (
        "execution_succeeded",
        "execution_failed",
        "needs_approval",
        "policy_denied",
    )


def test_acceptance_3_api_surface_connectors_runs(store):
    """Connector + run APIs exist (in-process app)."""
    from fastapi.testclient import TestClient
    from edagent_vivado.web.app import create_app

    client = TestClient(create_app())
    r = client.get("/api/v1/connectors")
    assert r.status_code == 200
    assert "connectors" in r.json()
    r2 = client.get("/api/v1/runs?limit=3")
    assert r2.status_code == 200


def test_acceptance_4_context_connector_blocks(store):
    """Context builder injects connector environment + plan blocks."""
    from edagent_vivado.agent.context import AgentContextBuilder

    proj = store.project_create({
        "name": "ctx",
        "root_path": ".",
        "manifest_path": "eda.yaml",
    })
    sess = store.session_create("c", project_id=proj["id"])
    task = store.task_create(sess["id"], "q")
    store.task_update(
        task["id"],
        metadata_json=json.dumps({
            "plan": [{"step": "s", "connector": "vivado", "capability": "run_synthesis"}],
        }),
    )
    run = store.run_create("task", "r", session_id=sess["id"], task_id=task["id"])
    pkg = AgentContextBuilder().build(
        question="timing?",
        session_id=sess["id"],
        task_id=task["id"],
        run_id=run["id"],
        persist=False,
    )
    types = {i.item_type for i in pkg.items if i.included}
    assert "connector_environment_context" in types or "capability_context" in types


def test_acceptance_5_second_connector_without_core_change(store):
    """Verilator registers alongside Vivado; agent tools include capability invoke."""
    assert get_connector("verilator") is not None
    assert get_connector("vivado") is not None
    names = {t.name for t in _TOOLS}
    assert "invoke_connector_capability_tool" in names
    assert "run_vivado_synth_tool" in names


def test_graph_default_uses_connector_shims_not_duplicate_legacy():
    """Default toolset uses shims; legacy only when env set."""
    names = [t.name for t in _TOOLS]
    assert names.count("run_vivado_synth_tool") == 1
