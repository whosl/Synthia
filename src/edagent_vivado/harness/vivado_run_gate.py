"""Block run_vivado_synth_tool until the user approves or rejects in the UI."""

from __future__ import annotations

import threading
from typing import Dict

_lock = threading.Lock()
# task_id -> (state: pending|approved|rejected, event)
_gates: Dict[str, tuple[str, threading.Event]] = {}


def begin_vivado_run_gate(task_id: str) -> None:
    with _lock:
        _gates[task_id] = ("pending", threading.Event())


def resolve_vivado_run_gate(task_id: str, approved: bool) -> None:
    with _lock:
        entry = _gates.get(task_id)
        if not entry:
            return
        _, ev = entry
        _gates[task_id] = ("approved" if approved else "rejected", ev)
        ev.set()


def wait_vivado_run_allowed(task_id: str | None, timeout: float = 7200.0) -> bool:
    """Called inside run_vivado_synth_tool — blocks until UI approval resolves."""
    if not task_id:
        return True
    with _lock:
        entry = _gates.get(task_id)
    if not entry:
        return True
    state, ev = entry
    if state != "pending":
        allowed = state == "approved"
        with _lock:
            _gates.pop(task_id, None)
        return allowed
    ev.wait(timeout)
    with _lock:
        entry = _gates.pop(task_id, ("rejected", threading.Event()))
    return entry[0] == "approved"
