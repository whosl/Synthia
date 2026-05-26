# Synthia Phase 1 开发手册：API 拆分 + Pydantic Schema 化

> **前置条件：** Phase 0 已完成（测试绿、token 鉴权就位）  
> **目标：** 把 `web/api_v1.py`（3244 行）拆成 12 个职责分明的 router，每个端点带 Pydantic schema  
> **预估工期：** 全职 8–10 天；vibe coding 2 周  
> **关键约束：** 旧 `/api/v1/...` URL **必须保持兼容**，旧前端不能坏

---

## 目录

- [0. 准备](#0-准备)
- [1. 路由清单（按子域分组）](#1-路由清单按子域分组)
- [2. 新目录结构](#2-新目录结构)
- [3. 共享依赖文件](#3-共享依赖文件)
- [4. 拆分顺序与策略](#4-拆分顺序与策略)
- [5. 子任务 1：projects 路由](#5-子任务-1projects-路由)
- [6. 子任务 2：sessions / messages / tasks 路由](#6-子任务-2sessions--messages--tasks-路由)
- [7. 子任务 3：streams 路由（含事件持久化骨架）](#7-子任务-3streams-路由含事件持久化骨架)
- [8. 子任务 4：runs / reports / artifacts 路由](#8-子任务-4runs--reports--artifacts-路由)
- [9. 子任务 5：approvals / patches / interactions 路由](#9-子任务-5approvals--patches--interactions-路由)
- [10. 子任务 6：connectors / vivado 路由](#10-子任务-6connectors--vivado-路由)
- [11. 子任务 7：monitor / metrics 路由](#11-子任务-7monitor--metrics-路由)
- [12. 子任务 8：knowledge / memory / kb 路由](#12-子任务-8knowledge--memory--kb-路由)
- [13. 子任务 9：evolution 路由](#13-子任务-9evolution-路由)
- [14. 子任务 10：admin / settings / migration 路由](#14-子任务-10admin--settings--migration-路由)
- [15. 子任务 11：Pydantic schemas 集中目录](#15-子任务-11pydantic-schemas-集中目录)
- [16. 子任务 12：清理旧 api_v1.py](#16-子任务-12清理旧-api_v1py)
- [17. 收尾验证](#17-收尾验证)

---

## 0. 准备

### 0.1 确认前置

```bash
cd E:/dev/edagent-vivado
git checkout product/synthia-workbench
git status                      # 应该 clean，否则先提交 P0 的改动
python -m pytest -k "not agent_smoke" -q --tb=no
```

期望：`0 failed`。

### 0.2 记一份 baseline 路由清单

后面拆完要对比，确保没漏：

```bash
grep -E "@router\.(get|post|patch|delete|put)" src/edagent_vivado/web/api_v1.py | wc -l
```

预期 ≈ 130（含重复装饰器）。把数字记下来。

### 0.3 备份原文件

不真的删除，作为参考：

```bash
cp src/edagent_vivado/web/api_v1.py src/edagent_vivado/web/api_v1.py.backup
echo "*.backup" >> .gitignore
```

---

## 1. 路由清单（按子域分组）

我把 `api_v1.py` 里所有路由按业务域归类如下。**这是 Phase 1 的拆分蓝图**：

### 1.1 projects（10 个）

```
GET    /projects
POST   /projects
GET    /projects/{project_id}
PATCH  /projects/{project_id}
DELETE /projects/{project_id}
GET    /projects/{project_id}/summary
POST   /projects/{project_id}/reindex
GET    /projects/{project_id}/sessions
POST   /projects/{project_id}/sessions
```

### 1.2 sessions（6 个）

```
GET    /sessions
POST   /sessions
GET    /sessions/{session_id}
PATCH  /sessions/{session_id}
DELETE /sessions/{session_id}
GET    /sessions/{session_id}/messages
```

### 1.3 tasks（5 个）

```
POST   /sessions/{session_id}/tasks
GET    /tasks/{task_id}
GET    /sessions/{session_id}/active-task
POST   /tasks/{task_id}/stop
POST   /sessions/{session_id}/stop
GET    /tasks/{task_id}/plan
```

### 1.4 streams（3 个，与 events 共用）

```
GET    /events/protocol
GET    /sessions/{session_id}/events
GET    /sessions/{session_id}/stream      # SSE
```

### 1.5 runs（6 个）

```
GET    /runs
GET    /runs/{run_id}/steps
GET    /runs/{run_id}/workspace
GET    /runs/{run_id}/tool-requests
POST   /runs/{run_id}/rerun
```

### 1.6 reports（3 个）

```
GET    /reports/trends
GET    /runs/{run_id}/reports
GET    /runs/{run_id}/reports/{report_id}
```

### 1.7 approvals + patches（6 个）

```
GET    /approvals
GET    /approvals/{approval_id}
POST   /approvals/{approval_id}/approve
POST   /approvals/{approval_id}/reject
GET    /runs/{run_id}/patches
POST   /patches/{patch_id}/apply
```

### 1.8 interactions（2 个）

```
GET    /interactions/{interaction_id}
POST   /interactions/{interaction_id}/respond
```

### 1.9 connectors + vivado（11 个）

```
GET    /connectors
GET    /connectors/{connector_id}
GET    /connectors/{connector_id}/capabilities
POST   /connectors/{connector_id}/health-check
GET    /health/vivado
GET    /vivado/targets
GET    /vivado/commands
POST   /vivado/commands/flow
GET    /vivado/devices
POST   /vivado/commands/tcl
POST   /vivado/commands/script
```

### 1.10 monitor + metrics（13 个）

```
GET    /monitor/runs
GET    /monitor/runs/{run_id}
GET    /monitor/runs/{run_id}/toolcalls
GET    /monitor/runs/{run_id}/usage
GET    /monitor/runs/{run_id}/events
GET    /monitor/runs/{run_id}/artifacts
GET    /monitor/runs/{run_id}/problems
GET    /monitor/runs/{run_id}/context
GET    /monitor/sessions/{session_id}/runs
GET    /monitor/sessions/{session_id}/usage
GET    /monitor/overview
POST   /monitor/cleanup
GET    /metrics/summary
GET    /metrics/series
```

### 1.11 knowledge + memory + kb（13 个）

```
POST   /knowledge/reindex
GET    /knowledge/sources
POST   /knowledge/search
POST   /knowledge/context-preview
GET    /sessions/{session_id}/memory
GET    /sessions/{session_id}/context
GET    /context-packages/{context_package_id}
GET    /retrieval-audits/{audit_id}
GET    /memory/canvas/active
GET    /memory/canvas/history
GET    /memory/refs/{node_id}
GET    /memory/atoms
GET    /memory/persona
GET    /memory/scenarios
POST   /memory/rebuild
GET    /kb/cases
GET    /kb/candidates
GET    /kb/candidates/{candidate_id}
POST   /kb/candidates/{candidate_id}/approve
POST   /kb/candidates/{candidate_id}/reject
POST   /kb/candidates/{candidate_id}/merge
```

### 1.12 evolution（19 个）

```
GET    /evolution/candidates
GET    /evolution/candidates/{candidate_id}
GET    /evolution/candidates/{candidate_id}/preview
POST   /evolution/candidates/{candidate_id}/approve
POST   /evolution/candidates/{candidate_id}/reject
POST   /evolution/candidates/{candidate_id}/merge
POST   /evolution/candidates/{candidate_id}/rollback
POST   /evolution/tools/validate
GET    /evolution/overlays
GET    /evolution/overlays/{overlay_id}
POST   /evolution/overlays/{overlay_id}/retire
GET    /evolution/config
POST   /evolution/config
GET    /evolution/trials
GET    /evolution/trials/{trial_id}
POST   /evolution/trials/{trial_id}/decide
POST   /evolution/trials/{trial_id}/abort
GET    /evolution/eval/sets
GET    /evolution/eval/sets/{name}
GET    /evolution/eval/runs
GET    /evolution/eval/runs/{run_id}
POST   /evolution/eval/run
POST   /evolution/generators/run
```

### 1.13 admin + settings + migration + feedback（10 个）

```
GET    /migration/conflicts
POST   /migration/sessions/{session_id}/resolve
POST   /migration/run
GET    /settings/approvals
GET    /settings/patch-approval
POST   /settings/patch-approval
GET    /settings/vivado-approval
POST   /settings/vivado-approval
POST   /feedback
GET    /sessions/{session_id}/feedback
```

**总计 = 约 105 个路由**（部分有 alias 装饰器，物理路由更少）。

---

## 2. 新目录结构

```text
src/edagent_vivado/web/
├── api_v1.py              # 收敛为 router 聚合器，只 include_router
├── api_v1.py.backup       # P1 期间保留备份
├── app.py                 # 不动
├── auth.py                # P0 加的 middleware
├── dashboard.py           # 不动（legacy）
├── terminal.py            # 不动（legacy）
├── routes/                # ← 新增
│   ├── __init__.py
│   ├── _common.py         # 共享依赖、错误处理
│   ├── projects.py
│   ├── sessions.py
│   ├── tasks.py
│   ├── streams.py
│   ├── runs.py
│   ├── reports.py
│   ├── approvals.py
│   ├── interactions.py
│   ├── connectors.py
│   ├── vivado.py
│   ├── monitor.py
│   ├── knowledge.py
│   ├── memory.py
│   ├── kb.py
│   ├── evolution.py
│   ├── admin.py
│   └── feedback.py
└── schemas/               # ← 新增（集中存放 Pydantic）
    ├── __init__.py
    ├── common.py
    ├── projects.py
    ├── sessions.py
    ├── tasks.py
    ├── runs.py
    ├── reports.py
    ├── approvals.py
    ├── connectors.py
    ├── vivado.py
    ├── monitor.py
    ├── evolution.py
    └── memory.py
```

新建：

```bash
cd src/edagent_vivado/web
mkdir -p routes schemas
touch routes/__init__.py schemas/__init__.py
```

---

## 3. 共享依赖文件

### 3.1 `routes/_common.py`

很多路由会复用同一套依赖（取 store、token 校验、错误处理）。集中放这里。

**新建** `src/edagent_vivado/web/routes/_common.py`：

```python
"""Shared helpers for split route modules."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException

logger = logging.getLogger(__name__)


def not_found(detail: str = "resource not found") -> HTTPException:
    return HTTPException(status_code=404, detail=detail)


def bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


def server_error(exc: Exception, scope: str = "") -> HTTPException:
    logger.exception("server_error in %s", scope)
    return HTTPException(status_code=500, detail=f"{scope}: {exc}")


def ok(data: Any) -> dict:
    """Wrap a payload in a stable response shape (optional convention)."""
    return {"data": data}
```

> **不强制每个路由都用 `ok()`**。约定：旧路由保持原响应形状，新增的可考虑统一。**Phase 1 优先不动响应格式**。

### 3.2 `schemas/common.py`

**新建** `src/edagent_vivado/web/schemas/common.py`：

```python
"""Common Pydantic types shared across routes."""

from __future__ import annotations

from typing import Any, Generic, TypeVar
from pydantic import BaseModel, Field, ConfigDict

T = TypeVar("T")


class TimestampMixin(BaseModel):
    created_at: int | None = None
    updated_at: int | None = None


class PaginationMeta(BaseModel):
    total: int = 0
    limit: int = 100
    offset: int = 0


class ErrorResponse(BaseModel):
    error: str
    detail: str | None = None
    scope: str | None = None


class IdResponse(BaseModel):
    id: str


# 旧代码大量直接返回 dict，新 schema 不强制全切换；先做核心 entity。
```

---

## 4. 拆分顺序与策略

### 4.1 关键原则

1. **一次拆一个子域**，每次拆完跑全测试，确保不破坏。
2. **每个 router 文件用同名前缀 mount**：在 `api_v1.py` 里 `app.include_router(projects_router, prefix="/api/v1")`。URL 完全不变。
3. **共享 module-level 状态（如 `_stream_queues`、`_blocked_tool_runs`）暂留 `api_v1.py`**，通过 import 共享。Phase 4 才会重构这些。
4. **import-time side effect 留 `api_v1.py`** —— 比如 router 创建语句、`ensure_connectors()` 等。
5. **不改路由签名**：函数名、参数、装饰器路径全部保持原状，只搬家。

### 4.2 推荐拆分顺序（按依赖关系）

```
1. projects          ← 独立，先做
2. sessions          ← 依赖 projects
3. tasks             ← 依赖 sessions
4. streams           ← 独立，含 SSE 关键代码
5. runs              ← 依赖 tasks
6. reports           ← 依赖 runs
7. approvals + patches + interactions
8. connectors + vivado
9. monitor + metrics
10. knowledge + memory + kb
11. evolution
12. admin + settings + migration + feedback
```

### 4.3 单步流程

每次拆一个：

```bash
# 步骤 1: 新建 routes/<name>.py，定义 router = APIRouter(tags=["<name>"])
# 步骤 2: 从 api_v1.py 里 cut 对应函数 + 改 @router 装饰器到新 router 上
# 步骤 3: 在 api_v1.py 顶部加 from edagent_vivado.web.routes import <name> as _<name>_module
# 步骤 4: 在 api_v1.py 主 router include_router 上注册（看下面具体例子）
# 步骤 5: 跑测试 + 浏览器/curl smoke
# 步骤 6: git commit "Phase 1: extract <name> routes"
```

---

## 5. 子任务 1：projects 路由

### 5.1 准备 schemas

**新建** `src/edagent_vivado/web/schemas/projects.py`：

```python
"""Pydantic schemas for projects routes."""

from __future__ import annotations

from typing import Any
from pydantic import BaseModel, Field, ConfigDict


class CreateProjectReq(BaseModel):
    """POST /projects body."""
    model_config = ConfigDict(extra="ignore")

    name: str = Field(..., min_length=1, max_length=128)
    root_path: str = Field(..., description="Filesystem root of the project")
    manifest_path: str = Field("", description="Path to eda.yaml")
    xpr_path: str = Field("", description="Optional .xpr path (Phase 3)")
    part: str = ""
    board_part: str = ""
    top_module: str = ""
    workspace_id: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


class UpdateProjectReq(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str | None = None
    manifest_path: str | None = None
    xpr_path: str | None = None
    part: str | None = None
    board_part: str | None = None
    top_module: str | None = None
    status: str | None = None
    metadata: dict[str, Any] | None = None


class ProjectSummaryItem(BaseModel):
    """Used in /projects list responses."""
    id: str
    name: str
    status: str = ""
    root_path: str = ""
    manifest_path: str = ""
    xpr_path: str = ""
    part: str = ""
    top_module: str = ""
    last_active_at: int | None = None


class ProjectDetail(ProjectSummaryItem):
    """GET /projects/{id} response."""
    board_part: str = ""
    workspace_id: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: int | None = None
    updated_at: int | None = None
```

### 5.2 提取路由

**新建** `src/edagent_vivado/web/routes/projects.py`：

```python
"""Project CRUD routes — extracted from api_v1.py in Phase 1."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from edagent_vivado.web.schemas.projects import (
    CreateProjectReq,
    UpdateProjectReq,
)
from edagent_vivado.web.schemas.sessions import CreateSessionReq  # 复用

router = APIRouter(prefix="/api/v1", tags=["projects"])


# ────────────────────────────────────────────────────────────────
# 从 api_v1.py 搬过来 — 函数体不变，只把 @router 改成本文件的 router
# ────────────────────────────────────────────────────────────────


@router.get("/projects")
async def api_projects(
    status: str | None = None,
    limit: int = 100,
    include_archived: bool = False,
):
    # ← 把 api_v1.py:180-224 这段函数体复制过来
    ...


@router.post("/projects")
async def api_projects_create(req: CreateProjectReq):
    # ← api_v1.py:185-... 函数体
    ...


@router.get("/projects/{project_id}")
async def api_project_get(project_id: str):
    ...


@router.patch("/projects/{project_id}")
async def api_project_update(project_id: str, req: UpdateProjectReq):
    ...


@router.delete("/projects/{project_id}")
async def api_project_delete(project_id: str, hard: bool = False, confirm: str = ""):
    ...


@router.get("/projects/{project_id}/summary")
async def api_project_summary(project_id: str):
    ...


@router.post("/projects/{project_id}/reindex")
async def api_project_reindex(project_id: str):
    ...


@router.get("/projects/{project_id}/sessions")
async def api_project_sessions(project_id: str, limit: int = 100, status: str | None = None):
    ...


@router.post("/projects/{project_id}/sessions")
async def api_project_sessions_create(project_id: str, req: CreateSessionReq):
    ...
```

### 5.3 具体搬运操作

打开 `src/edagent_vivado/web/api_v1.py`，找到 `@router.get("/projects")` 装饰器（约第 180 行）。

把这一行到 `api_project_sessions_create` 函数最后一行（约第 365 行附近）的整段，**剪切**到 `routes/projects.py` 里替换上面的 `...` 占位。

**关键：** 这段代码用到的 import（`from edagent_vivado.repository.store import ...`、`from edagent_vivado.projects.validate import ...` 等）也要复制到新文件顶部。

### 5.4 在 api_v1.py 注册新 router

`api_v1.py` 文件顶部加：

```python
# Phase 1: split routes
from edagent_vivado.web.routes import projects as _projects_routes
```

然后在 `app.py` 的 `create_app()` 里，把 `app.include_router(api_v1_router)` 之后**追加**：

```python
from edagent_vivado.web.routes.projects import router as projects_router
app.include_router(projects_router)
```

> **注意：** `projects_router` 已经在自己的 `APIRouter(prefix="/api/v1")` 里带了前缀，include 时**不要再加 prefix**。

### 5.5 验证

```bash
python -m pytest tests/ -k "project" -v
```

期望全绿。

手动 smoke：

```bash
edagent web --port 8484 &
curl -s -H "Authorization: Bearer test123" http://127.0.0.1:8484/api/v1/projects | head
# 期望返回 JSON 列表（可能为空数组）
```

### 5.6 commit

```bash
git add -A
git commit -m "Phase 1.1: extract projects routes from api_v1.py"
```

### 5.7 常见坑

- **函数共享的 module-level helper**：如 `_validate_project_input()`、`_resolve_project_id()`。直接 import 即可：
  ```python
  from edagent_vivado.web.api_v1 import _validate_project_input
  ```
  Phase 2 之后再把这些 helper 也搬出来。
- **测试 mock 路径**：旧测试可能 patch `edagent_vivado.web.api_v1.something`，新路由后 patch 路径变了。**对策：** Phase 1 不改测试，让旧路径仍可 import（拆出去后在 api_v1.py 里加 `from .routes.projects import api_projects` 重新暴露）。

---

## 6. 子任务 2：sessions / messages / tasks 路由

### 6.1 sessions schemas

**新建** `src/edagent_vivado/web/schemas/sessions.py`：

```python
from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field, ConfigDict


class CreateSessionReq(BaseModel):
    model_config = ConfigDict(extra="ignore")

    project_id: str = ""
    agent_id: str = ""
    name: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


class UpdateSessionReq(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str | None = None
    status: str | None = None
    metadata: dict[str, Any] | None = None


class ResolveMigrationReq(BaseModel):
    decision: str = Field(..., description="keep | overwrite | merge")
    target_project_id: str = ""


class SessionListItem(BaseModel):
    id: str
    project_id: str
    agent_id: str = ""
    name: str = ""
    status: str = ""
    last_message_preview: str = ""
    created_at: int | None = None
    updated_at: int | None = None
```

### 6.2 tasks schemas

**新建** `src/edagent_vivado/web/schemas/tasks.py`：

```python
from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field, ConfigDict


class StartTaskReq(BaseModel):
    model_config = ConfigDict(extra="ignore")

    message: str = Field(..., min_length=1, description="User's input message")
    task_type: str = "chat"
    project_id: str = ""
    agent_id: str = ""
    manifest_path: str = ""
    plan_inputs: dict[str, Any] = Field(default_factory=dict)


class TaskDetail(BaseModel):
    id: str
    session_id: str
    project_id: str = ""
    agent_id: str = ""
    task_type: str = ""
    state: str = ""
    started_at: int | None = None
    finished_at: int | None = None
    error: str | None = None
    active_run_id: str = ""
```

### 6.3 创建 routes/sessions.py

```python
"""Sessions + messages routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from edagent_vivado.web.schemas.sessions import (
    CreateSessionReq,
    UpdateSessionReq,
)

router = APIRouter(prefix="/api/v1", tags=["sessions"])


@router.get("/sessions")
async def api_sessions(...): ...
@router.post("/sessions")
async def api_sessions_create(req: CreateSessionReq): ...
@router.get("/sessions/{session_id}")
async def api_session_get(session_id: str): ...
@router.patch("/sessions/{session_id}")
async def api_session_update(session_id: str, req: UpdateSessionReq): ...
@router.delete("/sessions/{session_id}")
async def api_session_delete(session_id: str, hard: bool = False): ...
@router.get("/sessions/{session_id}/messages")
async def api_messages(session_id: str, before: int | None = None, limit: int = 100): ...
```

从 `api_v1.py:396-499` 搬过来。

### 6.4 创建 routes/tasks.py

```python
"""Tasks routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from edagent_vivado.web.schemas.tasks import StartTaskReq

router = APIRouter(prefix="/api/v1", tags=["tasks"])


@router.post("/sessions/{session_id}/tasks")
async def api_task_start(session_id: str, req: StartTaskReq): ...
@router.get("/tasks/{task_id}")
async def api_task_get(task_id: str): ...
@router.get("/sessions/{session_id}/active-task")
async def api_active_task(session_id: str): ...
@router.post("/tasks/{task_id}/stop")
@router.post("/sessions/{session_id}/stop")
async def api_task_stop(task_id: str = "", session_id: str = ""): ...
@router.get("/tasks/{task_id}/plan")
async def api_task_plan(task_id: str): ...
```

`api_v1.py:501-1248`、`1616-1627`。

> **注意：** `api_task_start` 函数体很长（约 700 行 ← 主要是 agent 调度逻辑），搬运时直接 cut/paste 整段。**不要重构内部代码**，Phase 4 才动。

### 6.5 在 app.py 注册

```python
from edagent_vivado.web.routes.sessions import router as sessions_router
from edagent_vivado.web.routes.tasks import router as tasks_router

app.include_router(sessions_router)
app.include_router(tasks_router)
```

### 6.6 验证

```bash
python -m pytest tests/ -k "session or task" -v
```

---

## 7. 子任务 3：streams 路由（含事件持久化骨架）

### 7.1 为什么单独拎出来

streams 是 SSE 核心，触及内存 `_stream_queues`。Phase 4 会重构成 DB events + replay。**Phase 1 阶段只搬家，不动逻辑**，但**预留一个 hook 点**给 Phase 4。

### 7.2 提取代码

**新建** `src/edagent_vivado/web/routes/streams.py`：

```python
"""Event stream routes — SSE.

NOTE: 此模块仍使用 module-level `_stream_queues`（在 api_v1.py 里）。
Phase 4 会替换为 DB events + replay-from-seq。
"""

from __future__ import annotations

from fastapi import APIRouter

# 从 api_v1.py import 共享状态（Phase 4 会迁移）
from edagent_vivado.web.api_v1 import _stream_queues  # noqa: F401

router = APIRouter(prefix="/api/v1", tags=["streams"])


@router.get("/events/protocol")
async def api_events_protocol(): ...


@router.get("/sessions/{session_id}/events")
async def api_events(session_id: str, after_seq: int = 0, limit: int = 500, recent: bool = False): ...


@router.get("/sessions/{session_id}/stream")
async def api_stream(session_id: str, after_seq: int = 0): ...
```

从 `api_v1.py:1281-1329` 搬过来。

### 7.3 给 Phase 4 留 hook（事件 envelope 函数）

在 `routes/streams.py` 顶部加：

```python
# Phase 4 hook —— 未来把 _publish 替换为 DB persist + fan-out
def _persist_event_for_replay(session_id: str, event_type: str, payload: dict) -> int:
    """Reserved for Phase 4: persist event to DB, return new seq.

    现阶段仍由 _publish 走内存队列。
    """
    return 0
```

### 7.4 注册

```python
from edagent_vivado.web.routes.streams import router as streams_router
app.include_router(streams_router)
```

### 7.5 验证

```bash
edagent web --port 8484 &
curl -N -H "Authorization: Bearer test123" \
  "http://127.0.0.1:8484/api/v1/sessions/test/stream"
# 期望: SSE 流（保持连接，看到 keepalive）
```

---

## 8. 子任务 4：runs / reports / artifacts 路由

### 8.1 schemas

**新建** `src/edagent_vivado/web/schemas/runs.py`：

```python
from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field, ConfigDict


class RerunReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    auto_start: bool = True
    inherit_inputs: bool = True


class RunListItem(BaseModel):
    id: str
    project_id: str = ""
    session_id: str = ""
    task_id: str = ""
    run_type: str = ""
    state: str = ""
    started_at: int | None = None
    finished_at: int | None = None
    elapsed_ms: int = 0


class RunStepDetail(BaseModel):
    id: str
    run_id: str
    step_index: int = 0
    step_key: str = ""
    stage: str = ""
    name: str = ""
    state: str = ""
    connector_id: str = ""
    capability_id: str = ""
    started_at: int | None = None
    finished_at: int | None = None
    elapsed_ms: int = 0
    error: str | None = None
```

**新建** `src/edagent_vivado/web/schemas/reports.py`：

```python
from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field


class ReportDetail(BaseModel):
    id: str
    run_id: str
    artifact_id: str = ""
    report_type: str = ""
    tool: str = ""
    stage: str = ""
    data: dict[str, Any] = Field(default_factory=dict)
    created_at: int | None = None
```

### 8.2 路由

**新建** `src/edagent_vivado/web/routes/runs.py`：

```python
"""Runs + RunSteps routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from edagent_vivado.web.schemas.runs import RerunReq

router = APIRouter(prefix="/api/v1", tags=["runs"])


@router.get("/runs")
async def api_runs_list(...): ...
@router.get("/runs/{run_id}/steps")
async def api_run_steps(run_id: str): ...
@router.get("/runs/{run_id}/workspace")
async def api_run_workspace(run_id: str): ...
@router.get("/runs/{run_id}/tool-requests")
async def api_run_tool_requests(run_id: str): ...
@router.post("/runs/{run_id}/rerun")
async def api_run_rerun(run_id: str, auto_start: bool = True): ...
```

**新建** `src/edagent_vivado/web/routes/reports.py`：

```python
"""Reports routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/v1", tags=["reports"])


@router.get("/reports/trends")
async def api_reports_trends(...): ...
@router.get("/runs/{run_id}/reports")
async def api_run_reports(run_id: str, report_type: str = ""): ...
@router.get("/runs/{run_id}/reports/{report_id}")
async def api_run_report_detail(run_id: str, report_id: str): ...
```

> **artifacts**：目前 api_v1.py 没有独立的 `/artifacts` 路由，artifact 信息通过 `/runs/{id}/artifacts`（Phase 3/4 会单独建）。**Phase 1 不创建 artifacts.py**。

### 8.3 注册 + 验证

```python
from edagent_vivado.web.routes.runs import router as runs_router
from edagent_vivado.web.routes.reports import router as reports_router
app.include_router(runs_router)
app.include_router(reports_router)
```

```bash
python -m pytest tests/ -k "run or report" -v
```

---

## 9. 子任务 5：approvals / patches / interactions 路由

### 9.1 schemas

**新建** `src/edagent_vivado/web/schemas/approvals.py`：

```python
from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field, ConfigDict


class ApprovalDecisionReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    reason: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


class InteractionRespondReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    response: str = Field(..., description="approve | reject | text response")
    payload: dict[str, Any] = Field(default_factory=dict)


class ApprovalListItem(BaseModel):
    id: str
    project_id: str = ""
    run_id: str = ""
    patch_id: str = ""
    approval_type: str = ""
    risk_level: str = ""
    state: str = ""
    requested_at: int | None = None
    reviewed_at: int | None = None
```

### 9.2 路由

**新建** `src/edagent_vivado/web/routes/approvals.py`：

```python
"""Approvals + patches + interactions routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from edagent_vivado.web.schemas.approvals import (
    ApprovalDecisionReq,
    InteractionRespondReq,
)

router = APIRouter(prefix="/api/v1", tags=["approvals"])


@router.get("/approvals")
async def api_approvals_list(...): ...
@router.get("/approvals/{approval_id}")
async def api_approval_get(approval_id: str): ...
@router.post("/approvals/{approval_id}/approve")
async def api_approval_approve(approval_id: str, req: ApprovalDecisionReq): ...
@router.post("/approvals/{approval_id}/reject")
async def api_approval_reject(approval_id: str, req: ApprovalDecisionReq): ...
@router.get("/runs/{run_id}/patches")
async def api_run_patches(run_id: str): ...
@router.post("/patches/{patch_id}/apply")
async def api_patch_apply(patch_id: str): ...
@router.get("/interactions/{interaction_id}")
async def api_interaction_get(interaction_id: str): ...
@router.post("/interactions/{interaction_id}/respond")
async def api_interaction_respond(interaction_id: str, req: InteractionRespondReq): ...
```

`api_v1.py:1628-1830` + `2719-2760`。

---

## 10. 子任务 6：connectors / vivado 路由

### 10.1 schemas

**新建** `src/edagent_vivado/web/schemas/connectors.py`：

```python
from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field


class ConnectorHealth(BaseModel):
    connector_id: str
    reachable: bool = False
    version: str = ""
    license_ok: bool = True
    detected_at: int | None = None
    detail: dict[str, Any] = Field(default_factory=dict)
```

**新建** `src/edagent_vivado/web/schemas/vivado.py`：

```python
from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field, ConfigDict


class VivadoTclReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    command: str = Field(..., min_length=1)
    manifest_path: str = ""
    session_id: str = ""
    # 不再接受 client 传 auto_approved，服务端从 settings 取
    metadata: dict[str, Any] = Field(default_factory=dict)


class VivadoScriptReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    script: str = Field(..., min_length=1)
    manifest_path: str = ""
    session_id: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


class VivadoFlowReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    manifest_path: str = Field(..., min_length=1)
    stages: list[str] = Field(default_factory=lambda: ["synth", "impl", "bitstream"])
    strategy: str = ""
    session_id: str = ""
```

### 10.2 路由

**新建** `src/edagent_vivado/web/routes/connectors.py`：

```python
"""Connectors generic routes."""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api/v1", tags=["connectors"])


@router.get("/connectors")
async def api_connectors_list(): ...
@router.get("/connectors/{connector_id}")
async def api_connector_get(connector_id: str): ...
@router.get("/connectors/{connector_id}/capabilities")
async def api_connector_capabilities(connector_id: str): ...
@router.post("/connectors/{connector_id}/health-check")
async def api_connector_health_check(connector_id: str, session_id: str = ""): ...
```

**新建** `src/edagent_vivado/web/routes/vivado.py`：

```python
"""Vivado-specific routes (health, targets, commands)."""

from __future__ import annotations

from fastapi import APIRouter

from edagent_vivado.web.schemas.vivado import VivadoTclReq, VivadoScriptReq, VivadoFlowReq

router = APIRouter(prefix="/api/v1", tags=["vivado"])


@router.get("/health/vivado")
async def api_health_vivado(): ...
@router.get("/vivado/targets")
async def api_vivado_targets(): ...
@router.get("/vivado/commands")
async def api_vivado_commands(): ...
@router.post("/vivado/commands/flow")
async def api_vivado_flow(req: VivadoFlowReq): ...
@router.get("/vivado/devices")
async def api_vivado_devices(): ...
@router.post("/vivado/commands/tcl")
async def api_vivado_tcl(req: VivadoTclReq): ...
@router.post("/vivado/commands/script")
async def api_vivado_script(req: VivadoScriptReq): ...
```

### 10.3 验证 Vivado 路由

Phase 0 已经修了 `auto_approved` 客户端旁路。Phase 1 用 Pydantic schema 后**字段层面禁绝**了这个字段：客户端传 `auto_approved=true` 会被忽略（因为 `model_config = ConfigDict(extra="ignore")`）。

测试：

```bash
curl -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer test123" \
  -d '{"command":"puts hi","auto_approved":true,"session_id":"s1"}' \
  http://127.0.0.1:8484/api/v1/vivado/commands/tcl
# 期望: 返回正常进入审批队列，且后端日志显示 auto_approved 被忽略
```

---

## 11. 子任务 7：monitor / metrics 路由

### 11.1 schemas

**新建** `src/edagent_vivado/web/schemas/monitor.py`：

```python
from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field, ConfigDict


class MonitorCleanupReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    dry_run: bool = True
    retention_days: int = 30
    delete_artifacts: bool = False


class MonitorOverview(BaseModel):
    runs_running: int = 0
    runs_failed_24h: int = 0
    artifacts_total: int = 0
    token_input_24h: int = 0
    token_output_24h: int = 0
    storage_bytes: int = 0
```

### 11.2 路由

**新建** `src/edagent_vivado/web/routes/monitor.py`：

```python
"""Monitor + metrics routes."""

from __future__ import annotations

from fastapi import APIRouter, Query

from edagent_vivado.web.schemas.monitor import MonitorCleanupReq

router = APIRouter(prefix="/api/v1", tags=["monitor"])


@router.get("/monitor/runs")
async def api_monitor_runs(...): ...
@router.get("/monitor/runs/{run_id}")
async def api_monitor_run(run_id: str): ...
@router.get("/monitor/runs/{run_id}/toolcalls")
async def api_monitor_run_toolcalls(run_id: str): ...
@router.get("/monitor/runs/{run_id}/usage")
async def api_monitor_run_usage(run_id: str): ...
@router.get("/monitor/runs/{run_id}/events")
async def api_monitor_run_events(run_id: str): ...
@router.get("/monitor/runs/{run_id}/artifacts")
async def api_monitor_run_artifacts(run_id: str): ...
@router.get("/monitor/runs/{run_id}/problems")
async def api_monitor_run_problems(run_id: str): ...
@router.get("/monitor/runs/{run_id}/context")
async def api_monitor_run_context(run_id: str): ...
@router.get("/monitor/sessions/{session_id}/runs")
async def api_monitor_session_runs(session_id: str): ...
@router.get("/monitor/sessions/{session_id}/usage")
async def api_monitor_session_usage(session_id: str): ...
@router.get("/monitor/overview")
async def api_monitor_overview(): ...
@router.post("/monitor/cleanup")
async def api_monitor_cleanup(req: MonitorCleanupReq): ...
@router.get("/metrics/summary")
async def api_metrics_summary(...): ...
@router.get("/metrics/series")
async def api_metrics_series(...): ...
```

### 11.3 高危防护：cleanup endpoint

`POST /monitor/cleanup` 是删数据的接口。Phase 1 加额外校验：

```python
@router.post("/monitor/cleanup")
async def api_monitor_cleanup(req: MonitorCleanupReq):
    if not req.dry_run and req.delete_artifacts:
        # 强制 require 一个 confirm header（先弱版本，Phase 8 RBAC 上线后改）
        from fastapi import Header, HTTPException
        # 简单做法：环境变量 EDAGENT_ALLOW_DESTRUCTIVE=1 才能跑
        import os
        if os.environ.get("EDAGENT_ALLOW_DESTRUCTIVE") != "1":
            raise HTTPException(403, "destructive cleanup requires EDAGENT_ALLOW_DESTRUCTIVE=1")
    # ... 原有逻辑
```

---

## 12. 子任务 8：knowledge / memory / kb 路由

### 12.1 schemas

**新建** `src/edagent_vivado/web/schemas/memory.py`：

```python
from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field, ConfigDict


class KnowledgeSearchReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    query: str = Field(..., min_length=1)
    project_id: str = ""
    scope: str = "both"   # both | global | project
    top_k: int = 10


class KnowledgeReindexReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    project_id: str = ""
    extra_paths: list[str] = Field(default_factory=list)


class ContextPreviewReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    question: str = Field(..., min_length=1)
    session_id: str = ""
    project_id: str = ""
    manifest_path: str = ""


class MemoryRebuildReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str = ""
    project_id: str = ""
    scope: str = "all"


class KbCandidateDecisionReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    reason: str = ""
    apply_to_global: bool = False
```

### 12.2 拆三个文件

**新建** `src/edagent_vivado/web/routes/knowledge.py`：

```python
"""Knowledge base routes (semantic search + reindex)."""

from __future__ import annotations
from fastapi import APIRouter
from edagent_vivado.web.schemas.memory import (
    KnowledgeSearchReq,
    KnowledgeReindexReq,
    ContextPreviewReq,
)

router = APIRouter(prefix="/api/v1", tags=["knowledge"])


@router.post("/knowledge/reindex")
async def api_knowledge_reindex(req: KnowledgeReindexReq | None = None): ...
@router.get("/knowledge/sources")
async def api_knowledge_sources(): ...
@router.post("/knowledge/search")
async def api_knowledge_search(req: KnowledgeSearchReq): ...
@router.post("/knowledge/context-preview")
async def api_knowledge_context_preview(req: ContextPreviewReq): ...
```

**新建** `src/edagent_vivado/web/routes/memory.py`：

```python
"""Memory canvas + retrieval audit routes."""

from __future__ import annotations
from fastapi import APIRouter
from edagent_vivado.web.schemas.memory import MemoryRebuildReq

router = APIRouter(prefix="/api/v1", tags=["memory"])


@router.get("/sessions/{session_id}/memory")
async def api_session_memory(session_id: str): ...
@router.get("/sessions/{session_id}/context")
async def api_session_context(session_id: str): ...
@router.get("/context-packages/{context_package_id}")
async def api_context_package(context_package_id: str): ...
@router.get("/retrieval-audits/{audit_id}")
async def api_retrieval_audit(audit_id: str): ...
@router.get("/memory/canvas/active")
async def api_memory_canvas_active(): ...
@router.get("/memory/canvas/history")
async def api_memory_canvas_history(): ...
@router.get("/memory/refs/{node_id}")
async def api_memory_refs(node_id: str): ...
@router.get("/memory/atoms")
async def api_memory_atoms(): ...
@router.get("/memory/persona")
async def api_memory_persona(): ...
@router.get("/memory/scenarios")
async def api_memory_scenarios(): ...
@router.post("/memory/rebuild")
async def api_memory_rebuild(req: MemoryRebuildReq): ...
```

**新建** `src/edagent_vivado/web/routes/kb.py`：

```python
"""KB cases + candidates routes."""

from __future__ import annotations
from fastapi import APIRouter
from edagent_vivado.web.schemas.memory import KbCandidateDecisionReq

router = APIRouter(prefix="/api/v1", tags=["kb"])


@router.get("/kb/cases")
async def api_kb_cases(...): ...
@router.get("/kb/candidates")
async def api_kb_candidates(...): ...
@router.get("/kb/candidates/{candidate_id}")
async def api_kb_candidate_get(candidate_id: str): ...
@router.post("/kb/candidates/{candidate_id}/approve")
async def api_kb_candidate_approve(candidate_id: str, req: KbCandidateDecisionReq): ...
@router.post("/kb/candidates/{candidate_id}/reject")
async def api_kb_candidate_reject(candidate_id: str, req: KbCandidateDecisionReq): ...
@router.post("/kb/candidates/{candidate_id}/merge")
async def api_kb_candidate_merge(candidate_id: str, req: KbCandidateDecisionReq): ...
```

---

## 13. 子任务 9：evolution 路由

### 13.1 schemas

**新建** `src/edagent_vivado/web/schemas/evolution.py`：

```python
from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field, ConfigDict


class EvolutionDecisionReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    reason: str = ""
    apply_immediately: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class EvolutionConfigReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    enabled: bool | None = None
    candidate_quota: int | None = None
    trial_concurrency: int | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class TrialDecideReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    decision: str = Field(..., description="accept | reject | abort")
    reason: str = ""


class EvalRunReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    set_name: str = Field(..., min_length=1)
    model_profile: str = ""
    overlay_id: str = ""
    sample_size: int = 0


class GeneratorRunReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    generator_id: str = Field(..., min_length=1)
    inputs: dict[str, Any] = Field(default_factory=dict)


class ToolsValidateReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    tool_spec: dict[str, Any] = Field(default_factory=dict)
```

### 13.2 路由

**新建** `src/edagent_vivado/web/routes/evolution.py`：

```python
"""Evolution candidates + overlays + trials + eval routes."""

from __future__ import annotations
from fastapi import APIRouter
from edagent_vivado.web.schemas.evolution import (
    EvolutionDecisionReq, EvolutionConfigReq, TrialDecideReq,
    EvalRunReq, GeneratorRunReq, ToolsValidateReq,
)

router = APIRouter(prefix="/api/v1", tags=["evolution"])


# 候选 (8 个端点)
@router.get("/evolution/candidates")
async def api_evol_candidates(...): ...
@router.get("/evolution/candidates/{candidate_id}")
async def api_evol_candidate_get(candidate_id: str): ...
@router.get("/evolution/candidates/{candidate_id}/preview")
async def api_evol_candidate_preview(candidate_id: str): ...
@router.post("/evolution/candidates/{candidate_id}/approve")
async def api_evol_candidate_approve(candidate_id: str, req: EvolutionDecisionReq): ...
@router.post("/evolution/candidates/{candidate_id}/reject")
async def api_evol_candidate_reject(candidate_id: str, req: EvolutionDecisionReq): ...
@router.post("/evolution/candidates/{candidate_id}/merge")
async def api_evol_candidate_merge(candidate_id: str, req: EvolutionDecisionReq): ...
@router.post("/evolution/candidates/{candidate_id}/rollback")
async def api_evol_candidate_rollback(candidate_id: str, req: EvolutionDecisionReq): ...
@router.post("/evolution/tools/validate")
async def api_evol_tools_validate(req: ToolsValidateReq): ...


# Overlays
@router.get("/evolution/overlays")
async def api_evol_overlays(): ...
@router.get("/evolution/overlays/{overlay_id}")
async def api_evol_overlay_get(overlay_id: str): ...
@router.post("/evolution/overlays/{overlay_id}/retire")
async def api_evol_overlay_retire(overlay_id: str): ...


# Config
@router.get("/evolution/config")
async def api_evol_config_get(): ...
@router.post("/evolution/config")
async def api_evol_config_update(req: EvolutionConfigReq): ...


# Trials
@router.get("/evolution/trials")
async def api_evol_trials(...): ...
@router.get("/evolution/trials/{trial_id}")
async def api_evol_trial_get(trial_id: str): ...
@router.post("/evolution/trials/{trial_id}/decide")
async def api_evol_trial_decide(trial_id: str, req: TrialDecideReq): ...
@router.post("/evolution/trials/{trial_id}/abort")
async def api_evol_trial_abort(trial_id: str): ...


# Eval
@router.get("/evolution/eval/sets")
async def api_evol_eval_sets(): ...
@router.get("/evolution/eval/sets/{name}")
async def api_evol_eval_set_get(name: str): ...
@router.get("/evolution/eval/runs")
async def api_evol_eval_runs(...): ...
@router.get("/evolution/eval/runs/{run_id}")
async def api_evol_eval_run_get(run_id: str): ...
@router.post("/evolution/eval/run")
async def api_evol_eval_run_start(req: EvalRunReq): ...


# Generators
@router.post("/evolution/generators/run")
async def api_evol_generator_run(req: GeneratorRunReq): ...
```

`api_v1.py:2076-2600`。

---

## 14. 子任务 10：admin / settings / migration 路由

### 14.1 schemas

**新建** `src/edagent_vivado/web/schemas/admin.py`：

```python
from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field, ConfigDict


class SettingsApprovalReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    enabled: bool


class MigrationResolveReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    decision: str = Field(..., description="keep | overwrite | merge")
    target_project_id: str = ""


class FeedbackReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str = ""
    task_id: str = ""
    rating: int = 0
    comment: str = ""
    tags: list[str] = Field(default_factory=list)
```

### 14.2 路由

**新建** `src/edagent_vivado/web/routes/admin.py`：

```python
"""Admin + settings + migration routes."""

from __future__ import annotations
from fastapi import APIRouter
from edagent_vivado.web.schemas.admin import (
    SettingsApprovalReq, MigrationResolveReq, FeedbackReq,
)

router = APIRouter(prefix="/api/v1", tags=["admin"])


# Migration
@router.get("/migration/conflicts")
async def api_migration_conflicts(limit: int = 100): ...
@router.post("/migration/sessions/{session_id}/resolve")
async def api_migration_resolve(session_id: str, req: MigrationResolveReq): ...
@router.post("/migration/run")
async def api_migration_run(): ...


# Settings
@router.get("/settings/approvals")
async def api_settings_approvals(): ...
@router.get("/settings/patch-approval")
async def api_settings_patch_approval_get(): ...
@router.post("/settings/patch-approval")
async def api_settings_patch_approval_set(req: SettingsApprovalReq): ...
@router.get("/settings/vivado-approval")
async def api_settings_vivado_approval_get(): ...
@router.post("/settings/vivado-approval")
async def api_settings_vivado_approval_set(req: SettingsApprovalReq): ...


# Feedback
@router.post("/feedback")
async def api_feedback_create(req: FeedbackReq): ...
@router.get("/sessions/{session_id}/feedback")
async def api_session_feedback(session_id: str): ...
```

---

## 15. 子任务 11：Pydantic schemas 集中目录

到这一步所有路由都拆完，schemas 也都新建了。最后检查：

```bash
ls src/edagent_vivado/web/schemas/
# 期望:
#   __init__.py
#   common.py
#   projects.py
#   sessions.py
#   tasks.py
#   runs.py
#   reports.py
#   approvals.py
#   connectors.py
#   vivado.py
#   monitor.py
#   memory.py
#   evolution.py
#   admin.py
```

**填写 `__init__.py` 做 re-export**（方便 import）：

```python
"""Pydantic schemas for the Synthia REST API."""

from edagent_vivado.web.schemas.projects import *  # noqa: F401, F403
from edagent_vivado.web.schemas.sessions import *  # noqa
from edagent_vivado.web.schemas.tasks import *
from edagent_vivado.web.schemas.runs import *
from edagent_vivado.web.schemas.reports import *
from edagent_vivado.web.schemas.approvals import *
from edagent_vivado.web.schemas.connectors import *
from edagent_vivado.web.schemas.vivado import *
from edagent_vivado.web.schemas.monitor import *
from edagent_vivado.web.schemas.memory import *
from edagent_vivado.web.schemas.evolution import *
from edagent_vivado.web.schemas.admin import *
```

---

## 16. 子任务 12：清理旧 api_v1.py

### 16.1 现在 api_v1.py 应该是什么样

所有路由都搬出去后，`api_v1.py` 只剩：

```python
"""Legacy api_v1.py — Phase 1 reduced to compatibility shim.

All routes moved to edagent_vivado/web/routes/*.
This file retains:
- module-level state still used by streams (Phase 4 will migrate)
- backwards-compat re-exports
"""

from __future__ import annotations

from fastapi import APIRouter

# Module-level state still shared by streams (Phase 4 will migrate to DB)
_stream_queues: dict[str, ...] = {}
_blocked_tool_runs: dict[str, ...] = {}

# Empty placeholder router (kept for backwards-compat imports)
router = APIRouter(prefix="/api/v1")


# Re-export for old test patch paths (DEPRECATED, remove in Phase 4)
from edagent_vivado.web.routes.projects import (  # noqa: F401, E402
    api_projects, api_projects_create, api_project_get, api_project_update,
    api_project_delete, api_project_summary, api_project_reindex,
    api_project_sessions, api_project_sessions_create,
)
# ... 类似 re-export 其它路由（仅为兼容旧测试 patch 路径）
```

`api_v1.py` 行数：从 3244 行降到 ~80 行。

### 16.2 在 app.py 注册所有 router

打开 `src/edagent_vivado/web/app.py`，把现有的：

```python
from edagent_vivado.web.api_v1 import router as api_v1_router
app.include_router(api_v1_router)
```

替换为：

```python
# Phase 1: split routes
from edagent_vivado.web.routes import (
    projects, sessions, tasks, streams, runs, reports,
    approvals, connectors, vivado, monitor,
    knowledge, memory, kb, evolution, admin,
)

# legacy compat (empty router but tests may still import)
from edagent_vivado.web.api_v1 import router as _api_v1_router
app.include_router(_api_v1_router)

for mod in (
    projects, sessions, tasks, streams, runs, reports,
    approvals, connectors, vivado, monitor,
    knowledge, memory, kb, evolution, admin,
):
    app.include_router(mod.router)
```

### 16.3 验证

```bash
python -m pytest -k "not agent_smoke" -q --tb=line
# 期望: 0 failed
```

行数确认：

```bash
wc -l src/edagent_vivado/web/api_v1.py
# 期望: ~80 行
wc -l src/edagent_vivado/web/routes/*.py
# 总和大约 = 3244 - 80 = 3164 行
```

OpenAPI 检查：

```bash
edagent web --port 8484 &
curl -s -H "Authorization: Bearer test123" http://127.0.0.1:8484/openapi.json | python -c "
import sys, json
spec = json.load(sys.stdin)
tags = sorted(set(t for path in spec['paths'].values() for op in path.values() for t in op.get('tags', [])))
print('Tags:', tags)
print('Total paths:', len(spec['paths']))
"
```

期望看到 `projects, sessions, tasks, streams, runs, reports, approvals, connectors, vivado, monitor, knowledge, memory, kb, evolution, admin` 全部出现在 tags 里。

---

## 17. 收尾验证

### 17.1 测试全绿

```bash
python -m pytest -k "not agent_smoke" -q
```

### 17.2 旧前端 smoke

```bash
cd frontend
npm run dev
# 浏览器打开 http://127.0.0.1:5173，逐页点击：
# - Projects 列表能加载
# - 进入某个 session 能看到消息
# - Runs 列表能加载
# - Approvals 列表能加载
```

### 17.3 文档生成

```bash
edagent web --port 8484 &
open http://127.0.0.1:8484/docs   # Linux/Mac
start http://127.0.0.1:8484/docs  # Windows
```

应看到所有 tag 分组清晰展示。

### 17.4 commit

```bash
git add -A
git commit -m "Phase 1: split api_v1.py into 15 domain routers + Pydantic schemas

- routes/projects.py: 9 endpoints
- routes/sessions.py: 6 endpoints
- routes/tasks.py: 5 endpoints
- routes/streams.py: 3 SSE endpoints (with Phase 4 hook)
- routes/runs.py: 5 endpoints
- routes/reports.py: 3 endpoints
- routes/approvals.py: 8 endpoints
- routes/connectors.py: 4 endpoints
- routes/vivado.py: 7 endpoints
- routes/monitor.py: 14 endpoints
- routes/knowledge.py: 4 endpoints
- routes/memory.py: 11 endpoints
- routes/kb.py: 6 endpoints
- routes/evolution.py: 23 endpoints
- routes/admin.py: 10 endpoints

schemas/* — 14 modules of Pydantic request/response models
api_v1.py reduced from 3244 to ~80 lines (compat shim)
"
```

### 17.5 完成标志

- [ ] `wc -l src/edagent_vivado/web/api_v1.py` ≤ 100
- [ ] `ls src/edagent_vivado/web/routes/` 有 15 个 .py 文件
- [ ] `ls src/edagent_vivado/web/schemas/` 有 14 个 .py 文件
- [ ] `pytest` 全绿
- [ ] `/docs` 显示所有 tag
- [ ] 旧前端无报错

---

## 附录 A：常见坑

### A.1 循环 import

`routes/streams.py` 从 `api_v1` import `_stream_queues`，`api_v1` 又 re-export `streams`。Python 能处理，但要小心导入顺序。

**对策：** `api_v1.py` 里的 re-export 用**延迟 import**，放在函数体内：

```python
def _lazy_reexport():
    from edagent_vivado.web.routes.projects import api_projects  # noqa
```

或者干脆**不做 re-export**，让旧测试改 patch 路径（Phase 4 必做）。

### A.2 SSE 函数定义里 `yield` 不能被 Pydantic schema 包

`api_stream` 是 async generator。不要给它加 `response_model=...`，会破坏 SSE。

### A.3 测试 mock 路径变化

之前 `mocker.patch('edagent_vivado.web.api_v1.task_create')`，现在 `task_create` 在 `routes/tasks.py` 里。

**对策 1：** 改测试 patch 路径。  
**对策 2：** 在 `api_v1.py` 顶部加 `from .routes.tasks import task_create as task_create  # backwards-compat`。

### A.4 OpenAPI 重复 path 警告

如果两个路由有相同 path 不同 method（正常），FastAPI 自动合并。  
如果两个路由完全相同 path + method（错误，比如搬运时漏删一个），FastAPI 启动会警告，**第二个会覆盖第一个**。

**对策：** 启动后看日志有没有 `Duplicate operation` 警告。

### A.5 Windows 路径里的反斜杠在 JSON 响应

旧代码可能直接返回 `Path(...)` 对象，FastAPI 会序列化成路径字符串，Windows 上是 `\\`。**Phase 1 不修这个**，但在 schema 里把所有 `path` 字段约定为字符串（`str`），并在生成时 `str(p).replace('\\', '/')`（Phase 3 xpr 那块再统一）。

---

## 附录 B：耗时估算（vibe coding）

| 子任务 | 估时 |
|--------|------|
| 1. projects | 0.5d |
| 2. sessions + tasks | 1d（tasks 函数大） |
| 3. streams | 0.5d |
| 4. runs + reports | 0.5d |
| 5. approvals + interactions | 0.5d |
| 6. connectors + vivado | 0.5d |
| 7. monitor | 0.5d |
| 8. knowledge + memory + kb | 1d |
| 9. evolution | 1d |
| 10. admin + settings + migration | 0.5d |
| 11. schemas 整理 | 0.5d |
| 12. 旧文件清理 | 0.5d |
| 13. 验证 | 0.5d |

**总计：** 全职 7-8 天；vibe coding 2 周。

---

## 附录 C：与 Phase 2 衔接

Phase 1 完成后，`routes/vivado.py` 和 `routes/connectors.py` 是 **Phase 2 的主战场** —— Phase 2 会把三套 Vivado 执行路径收敛到 connector 单一入口，届时这两个 router 内部实现要重写。

但路由层面**不变**：URL、Schema、HTTP method 都保持兼容，只换内部 dispatch 目标。
