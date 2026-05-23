"""Cooperative task cancellation — stop flag + tracked subprocesses."""

from __future__ import annotations

import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Sequence

_lock = threading.Lock()
_active: dict[str, set[subprocess.Popen]] = {}


class TaskStoppedError(Exception):
    """Raised when execution aborts because the user requested task stop."""


def is_task_stop_requested(task_id: str | None) -> bool:
    if not task_id:
        return False
    from edagent_vivado.repository.store import task_get

    row = task_get(task_id)
    return bool(row and row.get("stop_requested"))


def _register(task_id: str, proc: subprocess.Popen) -> None:
    with _lock:
        _active.setdefault(task_id, set()).add(proc)


def _unregister(task_id: str, proc: subprocess.Popen) -> None:
    with _lock:
        procs = _active.get(task_id)
        if procs:
            procs.discard(proc)
            if not procs:
                _active.pop(task_id, None)


def cancel_task_processes(task_id: str) -> int:
    """Terminate/kill tracked subprocesses for a task."""
    with _lock:
        procs = list(_active.get(task_id, set()))
    killed = 0
    for proc in procs:
        if proc.poll() is None:
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                killed += 1
            except OSError:
                pass
    with _lock:
        _active.pop(task_id, None)
    return killed


def cancel_task_execution(task_id: str) -> dict[str, int]:
    """Stop subprocesses and release pending Vivado approval gates."""
    from edagent_vivado.harness.vivado_run_gate import cancel_vivado_gates_for_task

    procs = cancel_task_processes(task_id)
    gates = cancel_vivado_gates_for_task(task_id)
    return {"processes_killed": procs, "gates_released": gates}


@dataclass
class CancellableResult:
    returncode: int
    stdout: str
    stderr: str
    stopped: bool = False
    timed_out: bool = False


def run_cancellable(
    args: Sequence[str],
    *,
    task_id: str | None = None,
    timeout: float | None = None,
    text: bool = True,
    input: str | None = None,
) -> CancellableResult:
    """Run subprocess with periodic stop checks."""
    if task_id and is_task_stop_requested(task_id):
        return CancellableResult(0, "", "Task stopped by user", stopped=True)

    proc = subprocess.Popen(
        list(args),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=text,
        stdin=subprocess.PIPE if input is not None else None,
    )
    if task_id:
        _register(task_id, proc)

    deadline = (time.time() + timeout) if timeout else None
    stopped = False
    timed_out = False
    stdout = ""
    stderr = ""
    try:
        while True:
            if task_id and is_task_stop_requested(task_id):
                stopped = True
                if proc.poll() is None:
                    proc.kill()
                try:
                    stdout, stderr = proc.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    stdout, stderr = proc.communicate(timeout=2)
                break
            if deadline and time.time() > deadline:
                timed_out = True
                if proc.poll() is None:
                    proc.kill()
                try:
                    stdout, stderr = proc.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    stdout, stderr = "", "Timeout"
                break
            try:
                stdout, stderr = proc.communicate(timeout=0.4)
                break
            except subprocess.TimeoutExpired:
                continue

        if stopped:
            return CancellableResult(-1, stdout, stderr or "Task stopped by user", stopped=True)
        if timed_out:
            return CancellableResult(124, stdout, stderr or "Timeout", timed_out=True)
        return CancellableResult(proc.returncode or 0, stdout, stderr)
    finally:
        if task_id:
            _unregister(task_id, proc)
