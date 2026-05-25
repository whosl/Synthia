"""Phase D: evolution trial wins → config atoms + persona 优胜配置."""

from __future__ import annotations

import importlib
import uuid

from edagent_vivado.agent.context import AgentContextBuilder
from edagent_vivado.evolution import (
    approve_candidate,
    candidate_create,
    force_decision,
    overlay_get,
    set_trial_enabled,
)
from edagent_vivado.evolution.trials import active_trial_for
from edagent_vivado.memory.personas import (
    build_project_persona,
    ensure_project_persona_for_session,
    load_project_persona_text,
    rebuild_persona_if_dirty,
)
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


def _fresh_env(tmp_path, monkeypatch, db_name: str = "evo_mem.db"):
    runtime = tmp_path / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    db_path = tmp_path / db_name
    monkeypatch.setenv("EDAGENT_DB_PATH", str(db_path))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(runtime))
    monkeypatch.setenv("EDAGENT_MEMORY_PERSONA_EVERY_N", "50")
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod, runtime


def _make_project(store) -> dict:
    return store.project_create(
        {
            "name": f"evo-{uuid.uuid4().hex[:6]}",
            "status": "active",
            "root_path": ".",
            "manifest_path": "eda.yaml",
            "xpr_path": "",
            "part": "xc7a35t",
        }
    )


def test_trial_variant_wins_creates_config_atom(tmp_path, monkeypatch):
    store, _runtime = _fresh_env(tmp_path, monkeypatch)
    proj = _make_project(store)
    pid = proj["id"]
    sess = store.session_create(name="trial", project_id=pid)

    set_trial_enabled(pid, "prompt", True)
    cand = candidate_create(
        surface="prompt",
        title="better prompt",
        rationale="test",
        project_id=pid,
        session_id=sess["id"],
        signal_source={"signal": "repeated_failure", "signal_key": "k"},
        created_by="test",
    )
    approve_candidate(cand["id"])
    trial = active_trial_for(project_id=pid, surface="prompt")
    assert trial is not None

    force_decision(trial["id"], "variant_wins")
    rebuild_persona_if_dirty(pid)

    configs = store.atom_list(pid, atom_type="config")
    assert len(configs) == 1
    cfg = configs[0]
    assert cfg["subject"] == "prompt"
    assert cfg["predicate"] == "winning_config"
    assert "prompt" in (cfg.get("object") or "").lower()

    md = load_project_persona_text(pid)
    assert "优胜配置" in md
    assert "prompt" in md.lower()


def test_direct_approval_creates_config_atom(tmp_path, monkeypatch):
    store, _runtime = _fresh_env(tmp_path, monkeypatch)
    proj = _make_project(store)
    pid = proj["id"]
    sess = store.session_create(name="direct", project_id=pid)

    cand = candidate_create(
        surface="prompt",
        title="direct prompt",
        rationale="test",
        project_id=pid,
        session_id=sess["id"],
        signal_source={"signal": "recurrence", "signal_key": "k2"},
        created_by="test",
    )
    updated = approve_candidate(cand["id"], force_active=True)
    assert updated["status"] == "approved"

    configs = store.atom_list(pid, atom_type="config")
    assert len(configs) == 1
    assert configs[0]["predicate"] == "active_config"

    overlay = overlay_get(updated.get("applied_overlay_id") or "")
    assert overlay is not None


def test_ensure_persona_on_session_start(tmp_path, monkeypatch):
    store, runtime = _fresh_env(tmp_path, monkeypatch)
    pid = store.migrate_orphan_sessions_to_default_project()
    old_sess = store.session_create(name="old", project_id=pid)

    store.atom_create(
        project_id=pid,
        atom_type="fact",
        subject="top_module",
        predicate="top_module",
        object="demo_top",
        source_session_id=old_sess["id"],
    )
    build_project_persona(pid, force=True)

    new_sess = store.session_create(name="new", project_id=pid)
    row = ensure_project_persona_for_session(pid)
    assert row is not None

    task = store.task_create(new_sess["id"])
    ctx = AgentContextBuilder().build(new_sess["id"], task["id"], "run-1", "hello", persist=False)
    persona_items = [i for i in ctx.items if i.item_type == "project_persona" and i.included]
    assert persona_items
    assert "demo_top" in persona_items[0].content or "Project Persona" in persona_items[0].content

    persona_path = runtime / "projects" / pid / "memory" / "persona.md"
    assert persona_path.is_file()
