"""Phase 6 — task planner (intent → run)."""

from __future__ import annotations

import importlib

import pytest

from edagent_vivado.agent.intent import classify_intent
from edagent_vivado.agent.task_planner import plan_from_intent
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.delenv("VIVADO_REMOTE_HOST", raising=False)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "p6_plan.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def test_plan_creates_run(store):
    proj = store.project_create({
        "name": "t6",
        "root_path": "/tmp",
        "manifest_path": "/tmp/eda.yaml",
    })
    sess = store.session_create("s6", project_id=proj["id"])

    intent = classify_intent(
        "跑综合",
        context={"manifest_path": "/tmp/eda.yaml", "session_id": sess["id"]},
    )
    plan = plan_from_intent(intent, session_id=sess["id"], project_id=proj["id"])

    assert plan["action"] == "create_run"
    assert plan["task_id"]
    assert plan["run_id"]
    assert plan["flow_name"] == "vivado_synth_only"


def test_plan_asks_missing(store):
    proj = store.project_create({
        "name": "t6b",
        "root_path": "/tmp",
        "manifest_path": "",
    })
    sess = store.session_create("s6b", project_id=proj["id"])

    intent = classify_intent("跑综合", context={})
    plan = plan_from_intent(intent, session_id=sess["id"])

    assert plan["action"] == "ask_missing_info"
    assert plan["missing_args"][0]["key"] == "manifest_path"


def test_plan_chat_default(store):
    proj = store.project_create({
        "name": "t6c",
        "root_path": "/tmp",
        "manifest_path": "",
    })
    store.session_create("s6c", project_id=proj["id"])

    intent = classify_intent("hello, what can you do?")
    plan = plan_from_intent(intent, session_id="unused")

    assert plan["action"] == "chat_reply"
