"""tool_run_requests table."""

import importlib

import pytest

from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "tr.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def test_tool_run_request_create(store):
    run = store.run_create("task", "test", session_id="s1")
    row = store.tool_run_request_create(
        run["id"],
        "vivado",
        "run_synthesis",
        step_id="step1",
        executable="vivado",
        args=["-mode", "batch"],
        cwd="/tmp",
        allowed_paths=["/tmp"],
    )
    listed = store.tool_run_request_list(run_id=run["id"])
    assert len(listed) == 1
    assert listed[0]["capability_id"] == "run_synthesis"
