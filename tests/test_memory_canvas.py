"""Phase A: task canvas CRUD and update_task_canvas."""

from __future__ import annotations

import importlib

from edagent_vivado.memory.canvas import (
    archive_active_canvas_for_task,
    build_canvas_for_prompt,
    get_active_canvas,
    list_canvas_history,
    update_task_canvas,
)
from edagent_vivado.memory.refs import read_ref, write_ref
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


def _fresh_env(tmp_path, monkeypatch, db_name: str = "mem.db"):
    runtime = tmp_path / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    db_path = tmp_path / db_name
    monkeypatch.setenv("EDAGENT_DB_PATH", str(db_path))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(runtime))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod, runtime


def test_canvas_crud(tmp_path, monkeypatch):
    store, _runtime = _fresh_env(tmp_path, monkeypatch)
    pid = store.migrate_orphan_sessions_to_default_project()
    sess = store.session_create(name="mem", project_id=pid)
    task = store.task_create(sess["id"])

    art = store.artifact_create(
        "task_canvas",
        "projects/x/memory/canvases/t1_v1.mmd",
        session_id=sess["id"],
        task_id=task["id"],
    )
    canvas = store.canvas_create(task["id"], sess["id"], art["id"], node_count=0, version=1)
    assert canvas["state"] == "active"
    assert store.canvas_get_active_for_task(task["id"])["id"] == canvas["id"]

    store.canvas_node_ref_create(canvas["id"], "a1b2c3d4", "tool_call", "tc001", label="grep ✓")
    refs = store.canvas_node_ref_list(canvas["id"])
    assert len(refs) == 1
    assert refs[0]["node_id"] == "a1b2c3d4"
    assert store.canvas_node_ref_get_by_node_id("a1b2c3d4")["ref_id"] == "tc001"

    store.canvas_update(canvas["id"], node_count=1, state="archived")
    assert store.canvas_get_active_for_task(task["id"]) is None
    history = store.canvas_list_for_session(sess["id"], limit=3, state="archived")
    assert len(history) == 1


def test_update_task_canvas_appends_nodes(tmp_path, monkeypatch):
    store, _runtime = _fresh_env(tmp_path, monkeypatch)
    pid = store.migrate_orphan_sessions_to_default_project()
    sess = store.session_create(name="mem2", project_id=pid)
    task = store.task_create(sess["id"])

    update_task_canvas(
        task["id"],
        sess["id"],
        event="tool_call_completed",
        payload={
            "toolcall_id": "abcd1234efgh",
            "tool_name": "grep_tool",
            "state": "completed",
            "output": "found 3 matches",
        },
    )
    update_task_canvas(
        task["id"],
        sess["id"],
        event="tool_call_completed",
        payload={
            "toolcall_id": "efgh5678ijkl",
            "tool_name": "run_vivado_synth",
            "state": "error",
            "output": "synth failed",
        },
    )

    data = get_active_canvas(task["id"])
    assert data is not None
    assert data["canvas"]["node_count"] == 2
    assert "grep_tool" in data["mermaid"]
    assert "run_vivado_synth" in data["mermaid"]
    assert "✓" in data["mermaid"]
    assert "✗" in data["mermaid"]
    assert "-->" in data["mermaid"]

    node_id = data["nodes"][0]["node_id"]
    ref_text = read_ref(node_id, session_id=sess["id"], project_id=pid)
    assert ref_text is not None
    assert "found 3 matches" in ref_text

    prompt_block = build_canvas_for_prompt(task["id"], max_tokens=800)
    assert "graph TD" in prompt_block


def test_archive_active_canvas_on_task_done(tmp_path, monkeypatch):
    store, _runtime = _fresh_env(tmp_path, monkeypatch)
    pid = store.migrate_orphan_sessions_to_default_project()
    sess = store.session_create(name="archive", project_id=pid)
    task = store.task_create(sess["id"])

    update_task_canvas(
        task["id"],
        sess["id"],
        event="tool_call_completed",
        payload={
            "toolcall_id": "abcd1234efgh",
            "tool_name": "grep_tool",
            "state": "completed",
            "output": "done",
        },
    )
    assert get_active_canvas(task["id"]) is not None

    archived = archive_active_canvas_for_task(task["id"])
    assert archived is not None
    assert archived["state"] == "archived"
    assert get_active_canvas(task["id"]) is None

    history = list_canvas_history(sess["id"], limit=3)
    assert len(history) == 1
    assert history[0]["state"] == "archived"
    assert "grep_tool" in history[0]["mermaid"]


def test_refs_write_read(tmp_path, monkeypatch):
    _store, _runtime = _fresh_env(tmp_path, monkeypatch)
    path = write_ref(
        "node1234",
        "output body",
        session_id="s1",
        project_id="proj1",
        tool_name="t",
        state="completed",
    )
    assert path.is_file()
    assert read_ref("node1234", project_id="proj1") == path.read_text(encoding="utf-8")
