"""Context builder injects parsed_report and connector environment blocks."""

import importlib

import pytest

from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


@pytest.fixture()
def ctx_env(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "ctx.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def test_build_includes_parsed_report_context(ctx_env, tmp_path, monkeypatch):
    monkeypatch.delenv("VIVADO_REMOTE_HOST", raising=False)
    p = ctx_env.project_create({
        "name": "ctx-proj",
        "root_path": str(tmp_path),
        "manifest_path": str(tmp_path / "eda.yaml"),
    })
    s = ctx_env.session_create(name="t", project_id=p["id"])
    run = ctx_env.run_create("task", "r1", session_id=s["id"])
    ctx_env.parsed_report_create(
        run["id"],
        "vivado",
        "timing_summary",
        "synth",
        {"wns": 0.1, "tns": 0},
    )
    from edagent_vivado.agent.context import AgentContextBuilder

    out = AgentContextBuilder().build(
        session_id=s["id"],
        task_id="",
        run_id=run["id"],
        question="timing?",
        persist=False,
    )
    types = [i.item_type for i in out.items if i.included]
    assert "parsed_report_context" in types
