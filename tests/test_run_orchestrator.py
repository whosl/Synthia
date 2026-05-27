import importlib
import json

import pytest

from edagent_vivado.connectors import ensure_connectors
from edagent_vivado.connectors.base.registry import clear_registry
from edagent_vivado.connectors.vivado.connector import register as register_vivado
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod
from edagent_vivado.runs.orchestrator import create_run, start_run


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.delenv("VIVADO_REMOTE_HOST", raising=False)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "orch.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


@pytest.fixture(autouse=True)
def _connectors():
    clear_registry()
    register_vivado()
    ensure_connectors()
    yield
    clear_registry()


def test_create_run_returns_id(store):
    run_id = create_run(
        flow_name="vivado_synth_only",
        session_id="test_sess",
        inputs={"manifest_path": "examples/uart_demo/eda.yaml"},
    )
    assert isinstance(run_id, str)
    assert len(run_id) > 0
    row = store.run_get(run_id)
    assert row
    meta = json.loads(row.get("metadata_json") or "{}")
    assert meta.get("flow_name") == "vivado_synth_only"


def test_create_run_unknown_flow():
    with pytest.raises(KeyError):
        create_run(flow_name="not_a_flow")


def test_start_run_creates_steps(store, monkeypatch):
    monkeypatch.setenv("EDAGENT_VIVADO_AUTO_APPROVE", "1")
    from edagent_vivado.harness import execution_approval

    execution_approval.set_vivado_execution_approval(True)

    manifest = "examples/uart_demo/eda.yaml"
    if not __import__("pathlib").Path(manifest).is_file():
        pytest.skip("uart_demo manifest missing")

    run_id = create_run(
        flow_name="vivado_synth_only",
        session_id="orch_sess",
        inputs={"manifest_path": manifest},
    )
    result = start_run(
        run_id,
        flow_name="vivado_synth_only",
        inputs={"manifest_path": manifest},
        session_id="orch_sess",
    )
    assert result.run_id == run_id
    steps = store.run_step_list(run_id)
    assert len(steps) >= 2
    assert result.state in (
        "succeeded",
        "succeeded_with_warnings",
        "failed",
        "waiting_for_approval",
    )
