"""Controlled execution contract — SPEC §9B.8.

Thin documentation layer; Vivado execution remains in harness/vivado_adapter until Phase 6B.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from edagent_vivado.connectors.base.types import PreparedRun


@dataclass
class CommandRequest:
    """Structured argv execution request (no shell string)."""

    command_id: str
    run_id: str
    step_id: str
    connector_id: str
    capability_id: str
    executable: str
    args: list[str]
    cwd: str
    timeout_sec: int = 3600
    env_profile: str = ""
    allowed_paths: list[str] = field(default_factory=list)
    capture_stdout: bool = True
    capture_stderr: bool = True


def command_request_from_prepared(prepared: PreparedRun) -> CommandRequest:
    req = prepared.request
    argv = list(prepared.command)
    executable = argv[0] if argv else ""
    args = argv[1:] if len(argv) > 1 else []
    return CommandRequest(
        command_id=req.request_id,
        run_id=req.run_id,
        step_id=req.step_id,
        connector_id=req.connector_id,
        capability_id=req.capability_id,
        executable=executable,
        args=args,
        cwd=prepared.workspace_root,
        timeout_sec=prepared.timeout_sec,
        env_profile=prepared.env_profile,
        allowed_paths=list(prepared.allowed_paths),
    )
