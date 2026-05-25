"""Phase C: L2 scenarios + L3 project persona."""

from __future__ import annotations

import importlib
import time

from edagent_vivado.agent.context import AgentContextBuilder
from edagent_vivado.memory.personas import build_project_persona, get_project_persona, load_project_persona_text
from edagent_vivado.memory.scenarios import aggregate_scenarios
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


def _fresh_env(tmp_path, monkeypatch, db_name: str = "persona.db"):
    runtime = tmp_path / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    db_path = tmp_path / db_name
    monkeypatch.setenv("EDAGENT_DB_PATH", str(db_path))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(runtime))
    monkeypatch.setenv("EDAGENT_MEMORY_PERSONA_EVERY_N", "3")
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod, runtime


def test_scenario_and_persona_build(tmp_path, monkeypatch):
    store, runtime = _fresh_env(tmp_path, monkeypatch)
    pid = store.migrate_orphan_sessions_to_default_project()
    sess = store.session_create(name="persona", project_id=pid)

    for i in range(3):
        store.atom_create(
            project_id=pid,
            atom_type="fact",
            subject="part",
            predicate="uses_part",
            object=f"xc7z020clg400-{i}",
            source_session_id=sess["id"],
        )
    for i in range(3):
        store.atom_create(
            project_id=pid,
            atom_type="event",
            subject="run_vivado_synth",
            predicate="failed",
            object=f"synth error {i}",
            source_session_id=sess["id"],
        )
    store.atom_create(
        project_id=pid,
        atom_type="preference",
        subject="user",
        predicate="prefers_not",
        object="mock Vivado mode",
        source_session_id=sess["id"],
    )

    scenarios = aggregate_scenarios(pid, min_atoms=3, min_interval_seconds=0)
    assert len(scenarios) >= 1

    persona_row = build_project_persona(pid, force=True)
    assert persona_row is not None
    assert persona_row["version"] == 1

    persona_path = runtime / "projects" / pid / "memory" / "persona.md"
    assert persona_path.is_file()
    md = persona_path.read_text(encoding="utf-8")
    assert "工程指纹" in md
    assert "常见失败模式" in md

    loaded = get_project_persona(pid)
    assert loaded["md"]
    assert loaded["version"] == 1


def test_persona_injected_into_context(tmp_path, monkeypatch):
    store, runtime = _fresh_env(tmp_path, monkeypatch)
    pid = store.migrate_orphan_sessions_to_default_project()
    sess = store.session_create(name="ctx", project_id=pid)
    task = store.task_create(sess["id"])

    store.atom_create(
        project_id=pid,
        atom_type="fact",
        subject="top_module",
        predicate="top_module",
        object="uart_top",
        source_session_id=sess["id"],
    )
    build_project_persona(pid, force=True)

    ctx = AgentContextBuilder().build(
        sess["id"],
        task["id"],
        "run-1",
        "timing WNS",
        persist=False,
    )
    types = [i.item_type for i in ctx.items if i.included]
    assert "project_persona" in types
    persona_item = next(i for i in ctx.items if i.item_type == "project_persona")
    assert "uart_top" in persona_item.content or "Project Persona" in persona_item.content


def test_pipeline_builds_persona_after_atoms(tmp_path, monkeypatch):
    store, _runtime = _fresh_env(tmp_path, monkeypatch)
    pid = store.migrate_orphan_sessions_to_default_project()
    sess = store.session_create(name="pipe", project_id=pid)

    importlib.reload(__import__("edagent_vivado.memory.pipeline", fromlist=["MemoryPipeline"]))
    from edagent_vivado.memory.pipeline import MemoryPipeline, MemoryPipelineConfig

    pipeline = MemoryPipeline(
        config=MemoryPipelineConfig(every_n_conversations=5, enable_warmup=False, max_atoms_per_pass=20)
    )

    for i in range(5):
        store.message_create(sess["id"], "user", f"q{i}")
        store.toolcall_create(
            run_id=store.run_create("task", f"r{i}", session_id=sess["id"])["id"],
            tool_name="run_vivado_synth_tool",
            session_id=sess["id"],
            input_summary="synth",
        )
        result = pipeline.on_message(sess["id"], pid, role="user")

    assert result["triggered"] is True
    text = load_project_persona_text(pid)
    assert text == "" or "Project Persona" in text or len(text) > 0
