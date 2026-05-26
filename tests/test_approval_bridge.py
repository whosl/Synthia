"""Approval ↔ interaction bridge."""

import importlib

import pytest

from edagent_vivado.harness.approval_bridge import (
    get_unified_approval_detail,
    list_pending_approvals_unified,
    mirror_interaction_to_approval,
    sync_approval_on_interaction_resolved,
)
from edagent_vivado.repository.store import event_create
from edagent_vivado.harness.interaction import (
    FileItem,
    Interaction,
    InteractionStatus,
    InteractionType,
)
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "bridge.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def test_mirror_and_resolve_interaction(store):
    interaction = Interaction(
        id="abc123",
        interaction_type=InteractionType.APPROVAL,
        session_id="s1",
        task_id="t1",
        title="Approve files",
        files=[FileItem(path="top.v", content="x", action="modify")],
    )
    row = mirror_interaction_to_approval(interaction, run_id="r1")
    assert row["interaction_id"] == "abc123"
    assert row["approval_type"] == "file_changes"


def test_vivado_execution_approval_type(store):
    interaction = Interaction(
        id="viv1",
        interaction_type=InteractionType.APPROVAL,
        session_id="s3",
        task_id="t3",
        title="Run synthesis",
        reason='{"action":"Synthesis","manifest_path":"eda.yaml","reason":"user requested"}',
    )
    row = mirror_interaction_to_approval(interaction, run_id="r3")
    assert row["approval_type"] == "vivado_execution"

    interaction.status = InteractionStatus.APPROVED
    updated = sync_approval_on_interaction_resolved(interaction)
    assert updated["status"] == "approved"


def test_unified_list_from_event_without_mirror(store):
    interaction = Interaction(
        id="evt99",
        interaction_type=InteractionType.APPROVAL,
        session_id="s2",
        task_id="t2",
        title="Pending only in events",
        files=[FileItem(path="a.v", content="1", action="modify")],
    )
    event_create("s2", "interaction.requested", interaction.to_dict(), task_id="t2")
    rows = list_pending_approvals_unified(limit=20)
    ids = [r["id"] for r in rows]
    assert "interaction:evt99" in ids
    detail = get_unified_approval_detail("interaction:evt99", "evt99")
    assert detail is not None
    assert detail["interaction_id"] == "evt99"
