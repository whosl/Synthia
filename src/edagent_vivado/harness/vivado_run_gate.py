"""Block Vivado agent tools until the user approves or rejects in the UI."""

from __future__ import annotations

import threading
import time
from typing import Dict

_lock = threading.Lock()
# gate_key (task_id:operation) -> (state: pending|approved|rejected, event)
_gates: Dict[str, tuple[str, threading.Event]] = {}
# Set on UI reject so tool threads see rejection even if gate was already popped
_rejected_keys: set[str] = set()


def _gate_key(task_id: str, operation: str) -> str:
    return f"{task_id}:{operation}"


def begin_vivado_gate(task_id: str, operation: str) -> None:
    with _lock:
        key = _gate_key(task_id, operation)
        _rejected_keys.discard(key)
        _gates[key] = ("pending", threading.Event())


def resolve_vivado_gate(task_id: str, operation: str, approved: bool) -> None:
    with _lock:
        key = _gate_key(task_id, operation)
        entry = _gates.get(key)
        if not entry:
            return
        _, ev = entry
        if not approved:
            _rejected_keys.add(key)
        else:
            _rejected_keys.discard(key)
        _gates[key] = ("approved" if approved else "rejected", ev)
        ev.set()


def is_vivado_gate_rejected(task_id: str | None, operation: str) -> bool:
    if not task_id:
        return False
    with _lock:
        return _gate_key(task_id, operation) in _rejected_keys


def _wait_gate_registered(task_id: str, operation: str, timeout: float = 120.0) -> bool:
    """Tool may start on a worker thread before the UI callback registers the gate."""
    key = _gate_key(task_id, operation)
    deadline = time.time() + timeout
    while time.time() < deadline:
        with _lock:
            if key in _gates:
                return True
        time.sleep(0.02)
    return False


def cancel_vivado_gates_for_task(task_id: str) -> int:
    """Reject all pending gates for a task (e.g. user pressed Stop)."""
    released = 0
    with _lock:
        keys = [k for k in list(_gates.keys()) if k.startswith(f"{task_id}:")]
    for key in keys:
        op = key.split(":", 1)[-1]
        resolve_vivado_gate(task_id, op, False)
        released += 1
    return released


def wait_vivado_gate_allowed(
    task_id: str | None,
    operation: str,
    timeout: float = 7200.0,
) -> bool:
    """Called inside Vivado agent tools — blocks until UI approval resolves."""
    if not task_id:
        with _lock:
            has_gate = any(k.endswith(f":{operation}") for k in _gates)
        if has_gate:
            return False
        return True
    from edagent_vivado.harness.task_cancel import is_task_stop_requested

    if is_task_stop_requested(task_id):
        cancel_vivado_gates_for_task(task_id)
        return False
    if is_vivado_gate_rejected(task_id, operation):
        with _lock:
            _rejected_keys.discard(_gate_key(task_id, operation))
        return False
    if not _wait_gate_registered(task_id, operation, timeout=min(timeout, 120.0)):
        with _lock:
            has_other = any(k.endswith(f":{operation}") for k in _gates)
        return not has_other
    key = _gate_key(task_id, operation)
    with _lock:
        entry = _gates.get(key)
    if not entry:
        with _lock:
            has_gate = any(k.endswith(f":{operation}") for k in _gates)
        return not has_gate
    state, ev = entry
    if state != "pending":
        allowed = state == "approved"
        with _lock:
            _gates.pop(key, None)
        return allowed
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_task_stop_requested(task_id):
            resolve_vivado_gate(task_id, operation, False)
            with _lock:
                _gates.pop(key, None)
            return False
        if ev.wait(timeout=min(0.4, max(0.05, deadline - time.time()))):
            break
    with _lock:
        entry = _gates.pop(key, ("rejected", threading.Event()))
    return entry[0] == "approved"


# Backward-compatible aliases (synthesis)
def begin_vivado_run_gate(task_id: str) -> None:
    begin_vivado_gate(task_id, "synth")


def resolve_vivado_run_gate(task_id: str, approved: bool) -> None:
    resolve_vivado_gate(task_id, "synth", approved)


def wait_vivado_run_allowed(task_id: str | None, timeout: float = 7200.0) -> bool:
    return wait_vivado_gate_allowed(task_id, "synth", timeout)
