"""Run workspace layout."""

import importlib

import pytest

from edagent_vivado.harness.run_workspace import RUN_WORKSPACE_SUBDIRS, RunWorkspace, ensure_run_workspace
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "ws.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def test_ensure_run_workspace_creates_layout(store, tmp_path):
    run = store.run_create("task", "test", session_id="s1")
    ws = ensure_run_workspace(run["id"])
    assert ws.root.is_dir()
    for sub in RUN_WORKSPACE_SUBDIRS:
        assert (ws.root / sub).is_dir()
    updated = store.run_get(run["id"])
    meta = __import__("json").loads(updated["metadata_json"])
    assert meta["workspace_root"] == str(ws.root)
