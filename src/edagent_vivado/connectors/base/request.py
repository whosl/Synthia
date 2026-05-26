"""ToolRunRequest construction helpers."""

from __future__ import annotations

import uuid
from typing import Any

from edagent_vivado.connectors.base.types import ToolRunRequest


def new_run_request(
    *,
    run_id: str,
    step_id: str,
    connector_id: str,
    capability_id: str,
    inputs: dict[str, Any] | None = None,
    manifest_path: str = "",
    target_id: str = "",
    auto_approved: bool = False,
    request_id: str | None = None,
) -> ToolRunRequest:
    return ToolRunRequest(
        request_id=request_id or uuid.uuid4().hex[:12],
        run_id=run_id,
        step_id=step_id,
        connector_id=connector_id,
        capability_id=capability_id,
        inputs=dict(inputs or {}),
        manifest_path=manifest_path,
        target_id=target_id,
        auto_approved=auto_approved,
    )
