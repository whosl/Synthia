"""Phase 1 REST API — aggregates domain routers under /api/v1."""

from __future__ import annotations

from fastapi import APIRouter

from edagent_vivado.web.routes import (
    admin,
    approvals,
    connectors,
    evolution,
    feedback,
    interactions,
    kb,
    knowledge,
    memory,
    metrics,
    monitor,
    projects,
    reports,
    runs,
    sessions,
    settings,
    streams,
    tasks,
    vivado,
)

router = APIRouter(prefix="/api/v1")

for _mod in (
    projects,
    admin,
    sessions,
    tasks,
    streams,
    connectors,
    runs,
    reports,
    approvals,
    interactions,
    monitor,
    settings,
    feedback,
    metrics,
    evolution,
    kb,
    knowledge,
    vivado,
    memory,
):
    router.include_router(_mod.router)

# Backward-compatible re-exports (task_resume, workbuddy, tests)
from edagent_vivado.web.routes.approvals import api_approvals_list  # noqa: F401
from edagent_vivado.web.routes.reports import api_run_reports  # noqa: F401
from edagent_vivado.web.routes.tasks import api_task_start  # noqa: F401
from edagent_vivado.web.schemas.tasks import StartTaskReq  # noqa: F401
from edagent_vivado.web.api_shared import (  # noqa: F401
    _blocked_tool_runs,
    _early_blocked_tool_runs,
    _early_completed_toolcall_ids,
    _publish,
    _stream_queues,
    _vivado_reject_run_keys,
    event_create,
)
