"""Tests for durable interaction resolution and orphan task recovery."""

from __future__ import annotations

import json

import pytest

from edagent_vivado.harness.interaction import (
    InteractionStatus,
    InteractionType,
    create_interaction,
    sync_interaction_resolution_from_store,
)
from edagent_vivado.harness.task_resume import is_task_orphaned_after_approval
from edagent_vivado.repository.store import event_create, project_create, session_create, task_create


@pytest.mark.asyncio
async def test_sync_interaction_resolution_from_store(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("EDAGENT_DB_PATH", str(db_path))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / ".edagent"))
    from edagent_vivado.repository.db import init_db

    init_db()
    project = project_create(
        {
            "name": "test",
            "status": "active",
            "root_path": ".",
            "manifest_path": "eda.yaml",
            "xpr_path": "",
        }
    )

    sess = session_create("orphan-session", project_id=project["id"])
    task = task_create(sess["id"], "m1")
    interaction = create_interaction(
        InteractionType.APPROVAL,
        sess["id"],
        task["id"],
        title="Approve files",
        files=[],
    )
    event_create(
        sess["id"],
        "interaction.requested",
        interaction.to_dict(),
        task_id=task["id"],
    )
    event_create(
        sess["id"],
        "interaction.approved",
        {
            **interaction.to_dict(),
            "status": "approved",
            "response": {"approved": True, "approved_files": []},
        },
        task_id=task["id"],
    )

    synced = sync_interaction_resolution_from_store(interaction.id)
    assert synced is not None
    assert synced.status == InteractionStatus.APPROVED
    assert synced.response.get("approved") is True


def test_is_task_orphaned_after_approval(tmp_path, monkeypatch):
    db_path = tmp_path / "test2.db"
    monkeypatch.setenv("EDAGENT_DB_PATH", str(db_path))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / ".edagent"))
    from edagent_vivado.repository.db import init_db
    from edagent_vivado.repository.store import task_update

    init_db()
    project = project_create(
        {
            "name": "test2",
            "status": "active",
            "root_path": ".",
            "manifest_path": "eda.yaml",
            "xpr_path": "",
        }
    )
    sess = session_create("orphan-session-2", project_id=project["id"])
    task = task_create(sess["id"], "m1")
    task_update(task["id"], state="running")
    iid = "abc123"
    event_create(
        sess["id"],
        "interaction.approved",
        {"id": iid, "interaction_id": iid, "status": "approved", "response": {"approved": True}},
        task_id=task["id"],
    )
    assert is_task_orphaned_after_approval(sess["id"], task["id"]) is True
    event_create(sess["id"], "agent.continuation", {"reason": "approval_completed"}, task_id=task["id"])
    assert is_task_orphaned_after_approval(sess["id"], task["id"]) is False
