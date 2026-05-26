"""Vivado/Tcl approval enqueue."""

import importlib
import json

import pytest

from edagent_vivado.harness.vivado_approval_queue import enqueue_tcl_approval
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "va.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def test_enqueue_tcl_approval(store, tmp_path):
    proj = store.project_create({
        "name": "test",
        "root_path": str(tmp_path),
        "manifest_path": str(tmp_path / "eda.yaml"),
    })
    sess = store.session_create("test", project_id=proj["id"])
    out = enqueue_tcl_approval("read_xdc foo.xdc", session_id=sess["id"])
    assert out["approval_id"]
    assert out["interaction_id"]
    row = store.approval_get(out["approval_id"])
    assert row["approval_type"] == "tcl_execution"
    payload = row.get("payload") or json.loads(row.get("payload_json") or "{}")
    assert payload.get("tcl_command") == "read_xdc foo.xdc"
