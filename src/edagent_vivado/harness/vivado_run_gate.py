"""Block Vivado agent tools until the user approves or rejects in the UI."""

from __future__ import annotations

import threading
from typing import Dict

_lock = threading.Lock()
# gate_key (task_id:operation) -> (state: pending|approved|rejected, event)
_gates: Dict[str, tuple[str, threading.Event]] = {}


def _gate_key(task_id: str, operation: str) -> str:
    return f"{task_id}:{operation}"


def begin_vivado_gate(task_id: str, operation: str) -> None:
    with _lock:
        _gates[_gate_key(task_id, operation)] = ("pending", threading.Event())


def resolve_vivado_gate(task_id: str, operation: str, approved: bool) -> None:
    with _lock:
        key = _gate_key(task_id, operation)
        entry = _gates.get(key)
        if not entry:
            return
        _, ev = entry
        _gates[key] = ("approved" if approved else "rejected", ev)
        ev.set()


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
    key = _gate_key(task_id, operation)
    with _lock:
        entry = _gates.get(key)
    if not entry:
        return True
    state, ev = entry
    if state != "pending":
        allowed = state == "approved"
        with _lock:
            _gates.pop(key, None)
        return allowed
    ev.wait(timeout)
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
