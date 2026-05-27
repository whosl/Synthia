"""Run orchestration — state machine, flows, and multi-step execution."""

from edagent_vivado.runs.flow_definitions import FLOW_REGISTRY, get_flow
from edagent_vivado.runs.orchestrator import (
    StartRunResult,
    cancel_run,
    create_run,
    resume_run,
    start_run,
    start_run_serial,
)
from edagent_vivado.runs.scheduler import (
    SessionBusy,
    is_session_busy,
    run_in_session,
    start_run_async,
)
from edagent_vivado.runs.state_machine import (
    InvalidTransition,
    assert_transition,
    can_transition,
    is_terminal,
)
from edagent_vivado.runs.summary import render_run_summary, write_summary_md
from edagent_vivado.runs.trend import project_trend

__all__ = [
    "FLOW_REGISTRY",
    "StartRunResult",
    "InvalidTransition",
    "SessionBusy",
    "assert_transition",
    "can_transition",
    "cancel_run",
    "create_run",
    "get_flow",
    "is_session_busy",
    "is_terminal",
    "project_trend",
    "render_run_summary",
    "resume_run",
    "run_in_session",
    "start_run",
    "start_run_async",
    "start_run_serial",
    "write_summary_md",
]
