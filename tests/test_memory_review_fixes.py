"""Review follow-ups: hooks, dedup, overlay lookup, project state merge."""

from __future__ import annotations

import importlib

from edagent_vivado.memory.hooks import on_toolcall_updated
from edagent_vivado.memory.project_state import load_project_memory_state, merge_project_memory_state
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod
from edagent_vivado.repository.store import atom_find_by_overlay_id, atom_find_similar


def _fresh_env(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    db_path = tmp_path / "review.db"
    monkeypatch.setenv("EDAGENT_DB_PATH", str(db_path))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(runtime))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def test_atom_find_by_overlay_id(tmp_path, monkeypatch):
    store = _fresh_env(tmp_path, monkeypatch)
    pid = store.migrate_orphan_sessions_to_default_project()
    store.atom_create(
        project_id=pid,
        atom_type="config",
        subject="prompt",
        object="summary",
        metadata={"overlay_id": "ov123"},
    )
    found = atom_find_by_overlay_id(pid, "ov123")
    assert found is not None
    assert atom_find_by_overlay_id(pid, "missing") is None


def test_atom_find_similar_event_prefix(tmp_path, monkeypatch):
    store = _fresh_env(tmp_path, monkeypatch)
    pid = store.migrate_orphan_sessions_to_default_project()
    store.atom_create(
        project_id=pid,
        atom_type="event",
        subject="run_vivado_synth",
        predicate="failed",
        object="synth error line 42 in top.v",
    )
    similar = atom_find_similar(
        pid,
        "event",
        "run_vivado_synth",
        "failed",
        "synth error line 42 in top.v extra detail",
    )
    assert similar is not None


def test_toolcall_hook_attaches_artifact_and_canvas(tmp_path, monkeypatch):
    store = _fresh_env(tmp_path, monkeypatch)
    pid = store.migrate_orphan_sessions_to_default_project()
    sess = store.session_create(name="hook", project_id=pid)
    task = store.task_create(sess["id"])
    run = store.run_create("task", "r1", session_id=sess["id"], task_id=task["id"])
    tc = store.toolcall_create(
        run_id=run["id"],
        tool_name="grep_tool",
        session_id=sess["id"],
        task_id=task["id"],
        input_summary="pattern",
    )
    row = store.toolcall_update(
        tc["id"],
        state="completed",
        finished_at=1,
        output_summary="found matches",
    )
    assert row["output_artifact_id"]
    from edagent_vivado.memory.canvas import get_active_canvas

    data = get_active_canvas(task["id"])
    assert data is not None
    assert data["canvas"]["node_count"] == 1


def test_merge_project_memory_state_preserves_fields(tmp_path, monkeypatch):
    _fresh_env(tmp_path, monkeypatch)
    pid = "proj-merge"
    merge_project_memory_state(pid, {"last_l2_at": 99, "persona_dirty": False})
    merge_project_memory_state(pid, {"persona_dirty": True})
    state = load_project_memory_state(pid)
    assert state["last_l2_at"] == 99
    assert state["persona_dirty"] is True


def test_on_toolcall_updated_skips_non_terminal(tmp_path, monkeypatch):
    store = _fresh_env(tmp_path, monkeypatch)
    pid = store.migrate_orphan_sessions_to_default_project()
    sess = store.session_create(name="skip", project_id=pid)
    task = store.task_create(sess["id"])
    run = store.run_create("task", "r2", session_id=sess["id"], task_id=task["id"])
    tc = store.toolcall_create(
        run_id=run["id"],
        tool_name="grep_tool",
        session_id=sess["id"],
        task_id=task["id"],
    )
    on_toolcall_updated(dict(tc), previous_state="started")
    from edagent_vivado.memory.canvas import get_active_canvas

    assert get_active_canvas(task["id"]) is None
