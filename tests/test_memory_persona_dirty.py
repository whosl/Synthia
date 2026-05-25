"""Persona dirty-flag deferral after evolution config atoms."""

from __future__ import annotations

import importlib
import uuid

from edagent_vivado.evolution import approve_candidate, candidate_create
from edagent_vivado.memory.personas import mark_project_persona_dirty, rebuild_persona_if_dirty
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod
from edagent_vivado.repository.store import persona_latest, settings_get


def _fresh_env(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    db_path = tmp_path / "dirty.db"
    monkeypatch.setenv("EDAGENT_DB_PATH", str(db_path))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(runtime))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def _make_project(store):
    return store.project_create(
        {
            "name": f"dirty-{uuid.uuid4().hex[:6]}",
            "status": "active",
            "root_path": ".",
            "manifest_path": "eda.yaml",
            "xpr_path": "",
            "part": "xc7a35t",
        }
    )


def test_evolution_config_marks_persona_dirty_without_immediate_rebuild(tmp_path, monkeypatch):
    store = _fresh_env(tmp_path, monkeypatch)
    proj = _make_project(store)
    pid = proj["id"]
    sess = store.session_create(name="dirty", project_id=pid)

    assert persona_latest(pid) is None

    cand = candidate_create(
        surface="prompt",
        title="prompt cfg",
        rationale="test",
        project_id=pid,
        session_id=sess["id"],
        signal_source={"signal": "recurrence", "signal_key": "k"},
        created_by="test",
    )
    approve_candidate(cand["id"], force_active=True)

    assert store.atom_list(pid, atom_type="config")
    state = settings_get(f"memory_project:{pid}", default={})
    assert state.get("persona_dirty") is True
    assert persona_latest(pid) is None

    row = rebuild_persona_if_dirty(pid)
    assert row is not None
    assert persona_latest(pid) is not None


def test_rebuild_persona_if_dirty_rebuilds_once(tmp_path, monkeypatch):
    store = _fresh_env(tmp_path, monkeypatch)
    pid = store.migrate_orphan_sessions_to_default_project()
    mark_project_persona_dirty(pid)

    row1 = rebuild_persona_if_dirty(pid)
    row2 = rebuild_persona_if_dirty(pid)
    assert row1 is not None
    assert row2 is None

    state = settings_get(f"memory_project:{pid}", default={})
    assert state.get("persona_dirty") is False
