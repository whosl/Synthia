"""Tests for cooperative task cancellation."""

import subprocess
from unittest.mock import MagicMock, patch

from edagent_vivado.harness import task_cancel
from edagent_vivado.harness.task_cancel import (
    cancel_task_processes,
    is_task_stop_requested,
    run_cancellable,
)
from edagent_vivado.harness.vivado_run_gate import (
    begin_vivado_gate,
    cancel_vivado_gates_for_task,
    wait_vivado_gate_allowed,
)


def test_is_task_stop_requested_reads_db(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "t.db"))
    from edagent_vivado.repository.db import init_db
    from edagent_vivado.repository.store import session_create, task_create, task_update

    init_db()
    from edagent_vivado.repository.store import migrate_orphan_sessions_to_default_project
    pid = migrate_orphan_sessions_to_default_project()
    s = session_create("stop-test", project_id=pid)
    t = task_create(s["id"])
    assert not is_task_stop_requested(t["id"])
    task_update(t["id"], stop_requested=1)
    assert is_task_stop_requested(t["id"])


def test_run_cancellable_stops_before_start():
    with patch.object(task_cancel, "is_task_stop_requested", return_value=True):
        res = run_cancellable(["echo", "hi"], task_id="t1")
    assert res.stopped
    assert "stopped" in res.stderr.lower()


def test_cancel_task_processes_kills_active():
    proc = MagicMock()
    proc.poll.return_value = None
    proc.wait.return_value = 0
    task_cancel._active["task-x"] = {proc}
    n = cancel_task_processes("task-x")
    assert n == 1
    proc.terminate.assert_called_once()


def test_cancel_vivado_gates_unblocks_waiter():
    begin_vivado_gate("task-g", "synth")
    released = cancel_vivado_gates_for_task("task-g")
    assert released >= 1
    assert wait_vivado_gate_allowed("task-g", "synth", timeout=1.0) is False
