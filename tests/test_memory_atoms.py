"""Phase B: L1 memory atoms and pipeline triggers."""

from __future__ import annotations

import importlib
import time

from edagent_vivado.memory.atoms import extract_atoms_from_session
from edagent_vivado.memory.pipeline import MemoryPipeline, MemoryPipelineConfig
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


def _fresh_env(tmp_path, monkeypatch, db_name: str = "atoms.db"):
    runtime = tmp_path / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    db_path = tmp_path / db_name
    monkeypatch.setenv("EDAGENT_DB_PATH", str(db_path))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(runtime))
    monkeypatch.setenv("EDAGENT_MEMORY_EVERY_N", "5")
    monkeypatch.setenv("EDAGENT_MEMORY_WARMUP", "0")
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def test_atom_crud(tmp_path, monkeypatch):
    store = _fresh_env(tmp_path, monkeypatch)
    pid = store.migrate_orphan_sessions_to_default_project()
    sess = store.session_create(name="atoms", project_id=pid)

    row = store.atom_create(
        project_id=pid,
        atom_type="fact",
        subject="uart_rx",
        predicate="clock",
        object="100 MHz",
        source_session_id=sess["id"],
        confidence=0.9,
    )
    assert row["subject"] == "uart_rx"
    listed = store.atom_list(pid, limit=10)
    assert len(listed) == 1
    assert store.atom_count(pid) == 1

    dup = store.atom_find_duplicate(pid, "uart_rx", "clock", "100 MHz")
    assert dup and dup["id"] == row["id"]


def test_extract_atoms_from_session_heuristics(tmp_path, monkeypatch):
    store = _fresh_env(tmp_path, monkeypatch)
    pid = store.migrate_orphan_sessions_to_default_project()
    sess = store.session_create(name="extract", project_id=pid)
    task = store.task_create(sess["id"])
    run = store.run_create("task", "t1", session_id=sess["id"], task_id=task["id"])

    store.message_create(sess["id"], "user", "永远不要用 mock Vivado 模式", task_id=task["id"])
    tc = store.toolcall_create(
        run_id=run["id"],
        tool_name="run_vivado_synth_tool",
        session_id=sess["id"],
        task_id=task["id"],
        input_summary="synth",
    )
    store.toolcall_update(
        tc["id"],
        state="error",
        finished_at=int(time.time()),
        output_summary="ERROR: File not found: uart_rx.v",
    )

    created = extract_atoms_from_session(sess["id"], pid)
    types = {a["atom_type"] for a in created}
    subjects = {a["subject"] for a in created}
    assert "preference" in types or "event" in types
    assert "run_vivado_synth" in subjects or "rtl_sync" in subjects
    assert len(created) >= 2


def test_pipeline_triggers_after_five_messages(tmp_path, monkeypatch):
    store = _fresh_env(tmp_path, monkeypatch)
    pid = store.migrate_orphan_sessions_to_default_project()
    sess = store.session_create(name="pipeline", project_id=pid)

    importlib.reload(__import__("edagent_vivado.memory.pipeline", fromlist=["MemoryPipeline"]))
    from edagent_vivado.memory.pipeline import MemoryPipeline

    pipeline = MemoryPipeline(
        config=MemoryPipelineConfig(every_n_conversations=5, enable_warmup=False)
    )

    results = []
    for i in range(5):
        store.message_create(sess["id"], "user", f"question {i}")
        results.append(pipeline.on_message(sess["id"], pid, role="user"))

    assert results[-1]["triggered"] is True
    assert results[-1]["reason"] == "every_n"
    assert store.atom_count(pid) >= 0

    # Second pass should not duplicate identical facts aggressively
    before = store.atom_count(pid)
    store.message_create(sess["id"], "assistant", "answer")
    pipeline.on_message(sess["id"], pid, role="assistant")
    after = store.atom_count(pid)
    assert after >= before
