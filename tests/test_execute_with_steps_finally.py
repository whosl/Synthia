from unittest.mock import MagicMock, patch

import pytest

from edagent_vivado.connectors import ensure_connectors
from edagent_vivado.connectors.base.registry import clear_registry
from edagent_vivado.connectors.base.types import ToolCapability, ToolRunRequest
from edagent_vivado.connectors.run_execution import execute_with_steps
from edagent_vivado.connectors.vivado.connector import register as register_vivado
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


@pytest.fixture(autouse=True)
def _connectors():
    clear_registry()
    register_vivado()
    ensure_connectors()
    yield
    clear_registry()


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.delenv("VIVADO_REMOTE_HOST", raising=False)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "finally.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    import importlib

    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def test_step_finally_marks_failed_on_crash(store):
    run = store.run_create("test", name="finally-run")
    req = ToolRunRequest(
        request_id="test_req",
        run_id=run["id"],
        step_id="",
        connector_id="vivado",
        capability_id="run_synthesis",
        inputs={"session_id": "", "task_id": ""},
        manifest_path="examples/uart_demo/eda.yaml",
        auto_approved=True,
    )

    cap = ToolCapability(
        connector_id="vivado",
        capability_id="run_synthesis",
        display_name="Synth",
        stage="synth",
        input_schema={},
        outputs=[],
        risk_level="medium",
        requires_approval=False,
    )

    with patch("edagent_vivado.connectors.run_execution.get_connector") as gc:
        conn = MagicMock()
        conn.list_capabilities.return_value = [cap]
        conn.prepare_run.return_value = MagicMock()
        conn.execute.side_effect = RuntimeError("boom")
        gc.return_value = conn

        result = execute_with_steps(req)
        assert result.success is False
        assert "boom" in (result.error or "")

    steps = store.run_step_list(run["id"])
    assert len(steps) == 1
    assert steps[0]["state"] == "failed"
