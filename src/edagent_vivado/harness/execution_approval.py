"""Runtime flags for Vivado execution auto-approval (separate from file patches)."""

from __future__ import annotations

_vivado_execution_auto_approve = False


def set_vivado_execution_approval(granted: bool) -> None:
    global _vivado_execution_auto_approve
    _vivado_execution_auto_approve = granted


def is_vivado_execution_approved() -> bool:
    return _vivado_execution_auto_approve
