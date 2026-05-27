# Synthia Phase 8 开发手册：RBAC + Audit

> **前置条件：** Phase 0-7 + 5.5 完成  
> **目标：** 引入用户 / 角色 / 权限 / 项目级权限 / 审计日志，符合芯片开发企业使用边界  
> **预估工期：** 全职 9 天；vibe coding 2-3 周  
> **关键约束：** 不破坏单机 dev 体验；默认安装应该一行命令仍能跑（auto-create admin user）

---

## 0. 风险与权限模型

### 0.1 角色

| 角色 | 能干什么 | 不能干什么 |
|------|----------|------------|
| **Admin** | 任意操作；用户/角色管理；audit 查看 | — |
| **Project Owner** | 完全控制其拥有的 project；邀请/移除成员 | 其他 project；管理用户表 |
| **FPGA Engineer** | 创建/启动 run；提 patch；查看 report；下载 bitstream | 审批高风险 patch；删 project；管理 connector target |
| **Reviewer** | 审批 patch（包括 strong approval）；查看 audit | 启动 run；下载 bitstream（除非也是 engineer） |
| **Viewer** | 只读：看 run / report / artifact metadata | 创建任何东西；下载 bitstream |
| **Tool Admin** | 管理 connector target（remote SSH / Vivado path）；管理 license pool | project 业务；审批 patch |

### 0.2 权限矩阵（关键端点）

```text
endpoint                            Admin  Owner  Eng   Rev   View  ToolAdm
POST /projects                        ✓     ✓     —     —     —     —
POST /projects/{id}/runs              ✓     ✓     ✓     —     —     —
POST /runs/{id}/cancel                ✓     ✓     ✓     —     —     —
GET  /runs/{id}                       ✓     ✓     ✓     ✓     ✓     —
POST /patches/{id}/approve (low)      ✓     ✓     ✓     ✓     —     —
POST /patches/{id}/approve (strong)   ✓     —     —     ✓     —     —
POST /patches/{id}/reject             ✓     ✓     ✓     ✓     —     —
GET  /artifacts/{id}/download (.bit)  ✓     ✓     ✓     —     —     —
GET  /artifacts/{id}/download (.log)  ✓     ✓     ✓     ✓     ✓     —
POST /admin/users                     ✓     —     —     —     —     —
POST /admin/connector-targets         ✓     —     —     —     —     ✓
GET  /admin/audit                     ✓     —     —     ✓     —     —
```

### 0.3 设计原则

- **Project-level role override**：一个用户在 project A 是 Owner，在 project B 是 Viewer
- **Global role fallback**：没有 project-level role 时按 global 角色判断
- **API token 仍可用**：服务账号场景（CI / MCP server）通过 token 绑定到「service user」
- **审计无死角**：所有 mutate 端点（POST/PUT/DELETE/PATCH）写 audit log

---

## 1. 任务清单

| 步骤 | 文件 | 类型 |
|------|------|------|
| 1 | DB schema：users / roles / project_members / audit_logs | 迁移 |
| 2 | `auth/identity.py` | 新建：User dataclass + token→user 解析 |
| 3 | `auth/permissions.py` | 新建：permission 表 + check_permission |
| 4 | `auth/middleware.py` | 改写：从 ApiTokenMiddleware 演进 |
| 5 | `auth/audit.py` | 新建：audit log helper |
| 6 | `web/dependencies.py` | 新建：FastAPI depend require_role / require_perm |
| 7 | 给每个 route 加权限 dependency | 大改 |
| 8 | `web/routes/admin.py` | 加 users / roles 管理 |
| 9 | `web/routes/audit.py` | 新建：audit 查询 |
| 10 | CLI: `edagent admin user/role` | 新建 |
| 11 | 前端 LoginPage / 用户切换 | 新建 |
| 12 | 前端按 role 隐藏按钮 | 改 |
| 13 | 测试 | — |

---

## 2. 步骤 1：DB schema

### 2.1 schema 设计

打开 `src/edagent_vivado/repository/db.py`，加：

```sql
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT DEFAULT '',
    email TEXT DEFAULT '',
    password_hash TEXT DEFAULT '',     -- bcrypt or argon2; '' for token-only users
    api_token TEXT UNIQUE,             -- nullable
    is_service_account INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    global_role TEXT DEFAULT 'viewer', -- admin/viewer/...
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_token ON users(api_token);

CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,         -- admin | project_owner | fpga_engineer | reviewer | viewer | tool_admin
    description TEXT DEFAULT '',
    permissions_json TEXT DEFAULT '[]', -- list of permission strings
    is_builtin INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_name TEXT NOT NULL,
    added_by TEXT DEFAULT '',
    added_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_proj_mem_user ON project_members(user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id TEXT DEFAULT '',
    actor_kind TEXT DEFAULT 'user',    -- user | system | service
    action TEXT NOT NULL,               -- e.g. project.create, patch.approve
    resource_type TEXT DEFAULT '',     -- project | run | patch | user | ...
    resource_id TEXT DEFAULT '',
    project_id TEXT DEFAULT '',
    session_id TEXT DEFAULT '',
    ip_address TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    details_json TEXT DEFAULT '',
    success INTEGER DEFAULT 1,
    error_message TEXT DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at DESC);
```

### 2.2 内置 roles 初始化

加 `_seed_builtin_roles(db)`：

```python
_BUILTIN_ROLES = [
    ("admin", "Full system access", [
        "*",   # wildcard
    ]),
    ("project_owner", "Owns project, can manage members", [
        "project.read", "project.update", "project.delete",
        "project.member.add", "project.member.remove",
        "run.create", "run.cancel", "run.read",
        "patch.propose", "patch.approve", "patch.reject", "patch.revert",
        "report.read", "artifact.read", "artifact.download.bitstream",
        "knowledge.read", "knowledge.write",
    ]),
    ("fpga_engineer", "Create runs, propose patches", [
        "project.read",
        "run.create", "run.cancel", "run.read",
        "patch.propose", "patch.approve.low", "patch.reject",
        "report.read", "artifact.read", "artifact.download.bitstream",
        "knowledge.read",
    ]),
    ("reviewer", "Reviews patches, full audit access", [
        "project.read",
        "run.read",
        "patch.read", "patch.approve", "patch.reject",
        "report.read", "artifact.read",
        "knowledge.read",
        "audit.read",
    ]),
    ("viewer", "Read-only access", [
        "project.read",
        "run.read",
        "report.read", "artifact.read",
        "knowledge.read",
    ]),
    ("tool_admin", "Manage connectors and licenses", [
        "connector.read", "connector.write",
        "license.read", "license.write",
        "tool_target.read", "tool_target.write",
    ]),
]

def _seed_builtin_roles(db) -> None:
    import json, time, uuid
    cur = db.execute("SELECT name FROM roles")
    existing = {r[0] for r in cur.fetchall()}
    now = int(time.time() * 1000)
    for name, desc, perms in _BUILTIN_ROLES:
        if name in existing:
            # Update permissions (in case we added new perms)
            db.execute(
                "UPDATE roles SET permissions_json=?, description=? WHERE name=?",
                (json.dumps(perms), desc, name),
            )
        else:
            db.execute(
                "INSERT INTO roles (id, name, description, permissions_json, is_builtin, created_at) "
                "VALUES (?,?,?,?,1,?)",
                (str(uuid.uuid4()), name, desc, json.dumps(perms), now),
            )
    db.commit()
```

### 2.3 Bootstrap admin

加 `_bootstrap_admin(db)`，在 db init 末尾调用：

```python
def _bootstrap_admin(db) -> None:
    """Create a default admin user if no users exist."""
    import json, time, uuid, secrets
    
    row = db.execute("SELECT COUNT(*) FROM users").fetchone()
    if row[0] > 0:
        return
    
    admin_id = str(uuid.uuid4())
    admin_token = secrets.token_urlsafe(32)
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO users (id, username, display_name, api_token, global_role, is_active, created_at) "
        "VALUES (?,?,?,?,?,1,?)",
        (admin_id, "admin", "Administrator", admin_token, "admin", now),
    )
    db.commit()
    
    # Write token to ~/.synthia/admin_token for first-time onboarding
    from pathlib import Path
    token_path = Path.home() / ".synthia" / "admin_token"
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(admin_token, encoding="utf-8")
    try:
        token_path.chmod(0o600)
    except Exception:
        pass
    
    import logging
    logging.getLogger(__name__).warning(
        "Bootstrap admin created. Token written to %s (read & delete after first use)",
        token_path,
    )
```

---

## 3. 步骤 2-3：Identity + Permissions

### 3.1 `auth/identity.py`

```bash
mkdir -p src/edagent_vivado/auth
touch src/edagent_vivado/auth/__init__.py
```

**新建** `src/edagent_vivado/auth/identity.py`：

```python
"""User identity resolution — Phase 8."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Optional

from edagent_vivado.repository.db import get_db


@dataclass
class User:
    id: str
    username: str
    display_name: str = ""
    global_role: str = "viewer"
    is_active: bool = True
    is_service_account: bool = False
    
    @property
    def is_admin(self) -> bool:
        return self.global_role == "admin"


@dataclass
class Identity:
    user: User
    project_roles: dict[str, str] = field(default_factory=dict)  # project_id → role
    
    def role_for_project(self, project_id: str) -> str:
        if not project_id:
            return self.user.global_role
        # Admin overrides everything
        if self.user.global_role == "admin":
            return "admin"
        # Project-level role takes precedence
        if project_id in self.project_roles:
            return self.project_roles[project_id]
        # Fallback to global
        return self.user.global_role


def get_user_by_token(token: str) -> Optional[User]:
    if not token:
        return None
    db = get_db()
    row = db.execute(
        "SELECT id, username, display_name, global_role, is_active, is_service_account "
        "FROM users WHERE api_token = ? AND is_active = 1",
        (token,),
    ).fetchone()
    if not row:
        return None
    return User(
        id=row["id"], username=row["username"], display_name=row["display_name"],
        global_role=row["global_role"], is_active=bool(row["is_active"]),
        is_service_account=bool(row["is_service_account"]),
    )


def get_user_by_id(user_id: str) -> Optional[User]:
    if not user_id:
        return None
    db = get_db()
    row = db.execute(
        "SELECT id, username, display_name, global_role, is_active, is_service_account "
        "FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    if not row:
        return None
    return User(
        id=row["id"], username=row["username"], display_name=row["display_name"],
        global_role=row["global_role"], is_active=bool(row["is_active"]),
        is_service_account=bool(row["is_service_account"]),
    )


def load_identity(token: str) -> Optional[Identity]:
    user = get_user_by_token(token)
    if not user:
        return None
    db = get_db()
    rows = db.execute(
        "SELECT project_id, role_name FROM project_members WHERE user_id = ?",
        (user.id,),
    ).fetchall()
    project_roles = {r["project_id"]: r["role_name"] for r in rows}
    
    # Update last_login_at (best-effort)
    try:
        db.execute("UPDATE users SET last_login_at = ? WHERE id = ?",
                   (int(time.time() * 1000), user.id))
        db.commit()
    except Exception:
        pass
    
    return Identity(user=user, project_roles=project_roles)


def list_users() -> list[dict]:
    db = get_db()
    rows = db.execute(
        "SELECT id, username, display_name, email, global_role, is_active, "
        "is_service_account, created_at, last_login_at FROM users"
    ).fetchall()
    return [dict(r) for r in rows]


def create_user(
    *, username: str, display_name: str = "", email: str = "",
    global_role: str = "viewer", is_service_account: bool = False,
) -> dict:
    import secrets, time, uuid
    user_id = str(uuid.uuid4())
    api_token = secrets.token_urlsafe(32)
    now = int(time.time() * 1000)
    db = get_db()
    db.execute(
        "INSERT INTO users (id, username, display_name, email, api_token, "
        "global_role, is_service_account, is_active, created_at) VALUES (?,?,?,?,?,?,?,1,?)",
        (user_id, username, display_name, email, api_token,
         global_role, 1 if is_service_account else 0, now),
    )
    db.commit()
    return {"id": user_id, "username": username, "api_token": api_token,
            "global_role": global_role, "is_service_account": is_service_account}


def add_project_member(project_id: str, user_id: str, role_name: str,
                       *, added_by: str = "") -> None:
    import time
    db = get_db()
    db.execute(
        "INSERT OR REPLACE INTO project_members (project_id, user_id, role_name, added_by, added_at) "
        "VALUES (?,?,?,?,?)",
        (project_id, user_id, role_name, added_by, int(time.time() * 1000)),
    )
    db.commit()
```

### 3.2 `auth/permissions.py`

**新建** `src/edagent_vivado/auth/permissions.py`：

```python
"""Permission check — Phase 8."""

from __future__ import annotations

import fnmatch
import json
from typing import Iterable

from edagent_vivado.repository.db import get_db


_ROLE_PERMS_CACHE: dict[str, list[str]] = {}


def _load_role_perms(role_name: str) -> list[str]:
    if role_name in _ROLE_PERMS_CACHE:
        return _ROLE_PERMS_CACHE[role_name]
    db = get_db()
    row = db.execute("SELECT permissions_json FROM roles WHERE name = ?", (role_name,)).fetchone()
    if not row:
        return []
    perms = json.loads(row["permissions_json"] or "[]")
    _ROLE_PERMS_CACHE[role_name] = perms
    return perms


def invalidate_perm_cache(role_name: str = "") -> None:
    if role_name:
        _ROLE_PERMS_CACHE.pop(role_name, None)
    else:
        _ROLE_PERMS_CACHE.clear()


def check_permission(role_name: str, permission: str) -> bool:
    """Check whether a role grants the given permission.
    
    Supports wildcards: '*' matches everything; 'patch.*' matches patch.approve, patch.reject, etc.
    """
    perms = _load_role_perms(role_name)
    for p in perms:
        if p == "*":
            return True
        if fnmatch.fnmatchcase(permission, p):
            return True
    return False


def check_any(role_name: str, permissions: Iterable[str]) -> bool:
    return any(check_permission(role_name, p) for p in permissions)


def check_all(role_name: str, permissions: Iterable[str]) -> bool:
    return all(check_permission(role_name, p) for p in permissions)


class PermissionError(Exception):
    """Raised when a permission check fails (caught by middleware → 403)."""
    
    def __init__(self, perm: str, role: str):
        self.perm = perm
        self.role = role
        super().__init__(f"role '{role}' lacks permission '{perm}'")
```

### 3.3 测试

**新建** `tests/test_permissions.py`：

```python
def test_admin_has_all(monkeypatch):
    from edagent_vivado.auth.permissions import check_permission, invalidate_perm_cache
    invalidate_perm_cache()
    assert check_permission("admin", "anything.we.want")
    assert check_permission("admin", "patch.approve")


def test_viewer_read_only():
    from edagent_vivado.auth.permissions import check_permission, invalidate_perm_cache
    invalidate_perm_cache()
    assert check_permission("viewer", "project.read")
    assert not check_permission("viewer", "run.create")
    assert not check_permission("viewer", "patch.approve")


def test_engineer_can_create_run():
    from edagent_vivado.auth.permissions import check_permission, invalidate_perm_cache
    invalidate_perm_cache()
    assert check_permission("fpga_engineer", "run.create")
    assert check_permission("fpga_engineer", "patch.propose")
    assert check_permission("fpga_engineer", "patch.approve.low")
    assert not check_permission("fpga_engineer", "patch.approve.high")


def test_reviewer_can_audit():
    from edagent_vivado.auth.permissions import check_permission, invalidate_perm_cache
    invalidate_perm_cache()
    assert check_permission("reviewer", "audit.read")
    assert check_permission("reviewer", "patch.approve")
    assert not check_permission("reviewer", "run.create")


def test_wildcard():
    from edagent_vivado.auth.permissions import check_permission, invalidate_perm_cache
    invalidate_perm_cache()
    assert check_permission("project_owner", "project.member.add")
```

---

## 4. 步骤 4-6：Middleware + Audit + Dependencies

### 4.1 `auth/audit.py`

**新建** `src/edagent_vivado/auth/audit.py`：

```python
"""Audit log helper — Phase 8."""

from __future__ import annotations

import json
import logging
import time

from edagent_vivado.repository.db import get_db

logger = logging.getLogger(__name__)


def log_audit(
    *,
    actor_user_id: str = "",
    actor_kind: str = "user",
    action: str,
    resource_type: str = "",
    resource_id: str = "",
    project_id: str = "",
    session_id: str = "",
    ip_address: str = "",
    user_agent: str = "",
    details: dict | None = None,
    success: bool = True,
    error_message: str = "",
) -> None:
    """Write an audit log entry. Never raises."""
    try:
        db = get_db()
        db.execute(
            "INSERT INTO audit_logs "
            "(actor_user_id, actor_kind, action, resource_type, resource_id, "
            "project_id, session_id, ip_address, user_agent, details_json, "
            "success, error_message, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (actor_user_id, actor_kind, action, resource_type, resource_id,
             project_id, session_id, ip_address, user_agent,
             json.dumps(details or {}, ensure_ascii=False),
             1 if success else 0, error_message,
             int(time.time() * 1000)),
        )
        db.commit()
    except Exception:
        logger.exception("audit log failed (action=%s, resource=%s)", action, resource_id)


def list_audits(
    *,
    actor_user_id: str = "",
    action: str = "",
    resource_type: str = "",
    resource_id: str = "",
    project_id: str = "",
    since_ms: int = 0,
    until_ms: int = 0,
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    where = []
    params: list = []
    if actor_user_id:
        where.append("actor_user_id = ?"); params.append(actor_user_id)
    if action:
        where.append("action = ?"); params.append(action)
    if resource_type:
        where.append("resource_type = ?"); params.append(resource_type)
    if resource_id:
        where.append("resource_id = ?"); params.append(resource_id)
    if project_id:
        where.append("project_id = ?"); params.append(project_id)
    if since_ms:
        where.append("created_at >= ?"); params.append(since_ms)
    if until_ms:
        where.append("created_at <= ?"); params.append(until_ms)
    
    sql = "SELECT * FROM audit_logs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    
    db = get_db()
    rows = db.execute(sql, params).fetchall()
    return [dict(r) for r in rows]
```

### 4.2 `web/auth.py` 改写 middleware

打开 `src/edagent_vivado/web/auth.py`，改造为：

```python
"""API authentication middleware — Phase 8 RBAC-aware."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from edagent_vivado.auth.identity import Identity, load_identity

logger = logging.getLogger(__name__)

_PUBLIC_PREFIXES = ("/health", "/static", "/assets", "/favicon")
_PUBLIC_EXACT = {"/", "/manifest.json", "/api/v1/auth/login"}


def auth_enabled() -> bool:
    if os.environ.get("EDAGENT_DISABLE_API_AUTH", "").lower() in ("1", "true", "yes"):
        return False
    if os.environ.get("SYNTHIA_AUTH_TEST_MODE", "").lower() in ("1", "true", "yes"):
        return False
    return True


def is_public_path(path: str) -> bool:
    if path in _PUBLIC_EXACT:
        return True
    for p in _PUBLIC_PREFIXES:
        if path.startswith(p):
            return True
    return False


def extract_token(request: Request) -> str:
    h = request.headers.get("Authorization", "")
    if h.lower().startswith("bearer "):
        return h[7:].strip()
    return request.query_params.get("token", "")


class IdentityMiddleware(BaseHTTPMiddleware):
    """Resolve identity from token; attach to request.state.identity.
    
    Does NOT enforce — that's done by per-route Depends(require_perm(...)).
    Skipping auth (test mode) still attaches a default 'anonymous' Identity.
    """
    
    async def dispatch(self, request: Request, call_next: Callable[[Request], Awaitable]) -> JSONResponse:
        if is_public_path(request.url.path):
            return await call_next(request)
        
        if not auth_enabled():
            request.state.identity = _anonymous_admin_identity()
            return await call_next(request)
        
        token = extract_token(request)
        if not token:
            return JSONResponse({"error": "auth: token required"}, status_code=401)
        
        identity = load_identity(token)
        if identity is None:
            return JSONResponse({"error": "auth: invalid token"}, status_code=401)
        if not identity.user.is_active:
            return JSONResponse({"error": "auth: user inactive"}, status_code=403)
        
        request.state.identity = identity
        return await call_next(request)


def _anonymous_admin_identity() -> Identity:
    """Used in test mode or when auth disabled — pretends to be admin."""
    from edagent_vivado.auth.identity import User
    return Identity(
        user=User(id="anonymous", username="anonymous", global_role="admin"),
        project_roles={},
    )
```

> 注：保留旧的 `ensure_token` / `_TOKEN` 全局变量逻辑作为 fallback，但主路径用 user-token。

### 4.3 `web/dependencies.py`

**新建** `src/edagent_vivado/web/dependencies.py`：

```python
"""FastAPI dependencies for auth/permission — Phase 8."""

from __future__ import annotations

from fastapi import Request, HTTPException

from edagent_vivado.auth.identity import Identity
from edagent_vivado.auth.permissions import check_permission
from edagent_vivado.auth.audit import log_audit


def get_identity(request: Request) -> Identity:
    """Always returns an Identity (test mode injects anonymous-admin)."""
    identity = getattr(request.state, "identity", None)
    if identity is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    return identity


def require_perm(permission: str, *, project_id_param: str = "project_id"):
    """FastAPI dependency factory: check permission, audit failure.
    
    Usage:
        @router.post("/foo", dependencies=[Depends(require_perm("foo.write"))])
        async def foo(...): ...
    
    If permission is project-scoped, the dependency reads `project_id_param` from
    path / query / body to compute project role.
    """
    
    async def _checker(request: Request) -> Identity:
        identity = get_identity(request)
        
        # Resolve project_id (path → query → no body access for simplicity)
        proj_id = ""
        if project_id_param:
            proj_id = (
                request.path_params.get(project_id_param) or
                request.query_params.get(project_id_param) or
                ""
            )
        role = identity.role_for_project(proj_id)
        
        if not check_permission(role, permission):
            log_audit(
                actor_user_id=identity.user.id,
                action="auth.denied",
                resource_type="permission",
                resource_id=permission,
                project_id=proj_id,
                ip_address=request.client.host if request.client else "",
                user_agent=request.headers.get("User-Agent", ""),
                details={"role": role, "method": request.method, "path": request.url.path},
                success=False,
                error_message=f"role={role} lacks={permission}",
            )
            raise HTTPException(status_code=403, detail=f"forbidden: requires {permission}")
        return identity
    
    return _checker


def require_role(*role_names: str):
    """Simpler check: identity must have one of these global or project roles."""
    
    async def _checker(request: Request) -> Identity:
        identity = get_identity(request)
        proj_id = request.path_params.get("project_id", "")
        role = identity.role_for_project(proj_id)
        if role not in role_names and identity.user.global_role not in role_names:
            log_audit(
                actor_user_id=identity.user.id,
                action="auth.denied",
                details={"required_roles": list(role_names), "role": role},
                success=False,
            )
            raise HTTPException(status_code=403, detail=f"forbidden: requires {role_names}")
        return identity
    
    return _checker
```

---

## 5. 步骤 7：给路由加权限

> 这是「累活」环节。每个 mutate 路由都要加 `dependencies=[Depends(require_perm(...))]`。

### 5.1 例子：projects.py

```python
from fastapi import Depends
from edagent_vivado.web.dependencies import require_perm, get_identity


@router.post("/projects", dependencies=[Depends(require_perm("project.create"))])
async def api_create_project(req: ProjectCreateReq, identity = Depends(get_identity)):
    project = project_create(...)
    # Owner of new project = creator (unless admin creates for someone else)
    if not identity.user.is_admin:
        add_project_member(project["id"], identity.user.id, "project_owner",
                           added_by=identity.user.id)
    log_audit(
        actor_user_id=identity.user.id, action="project.create",
        resource_type="project", resource_id=project["id"],
        details={"name": req.name},
    )
    return project


@router.get("/projects/{project_id}", dependencies=[Depends(require_perm("project.read"))])
async def api_get_project(project_id: str):
    ...


@router.delete("/projects/{project_id}", dependencies=[Depends(require_perm("project.delete"))])
async def api_delete_project(project_id: str, identity = Depends(get_identity)):
    project_delete(project_id)
    log_audit(
        actor_user_id=identity.user.id, action="project.delete",
        resource_type="project", resource_id=project_id,
    )
    return {"ok": True}
```

### 5.2 例子：runs.py

```python
@router.post("/projects/{project_id}/runs",
             dependencies=[Depends(require_perm("run.create"))])
async def api_create_run(project_id: str, req: CreateRunReq, identity = Depends(get_identity)):
    ...
    log_audit(
        actor_user_id=identity.user.id, action="run.create",
        resource_type="run", resource_id=run_id, project_id=project_id,
        details={"flow_name": req.flow_name},
    )


@router.post("/runs/{run_id}/cancel",
             dependencies=[Depends(require_perm("run.cancel"))])
async def api_cancel_run(run_id: str, identity = Depends(get_identity)):
    cancel_run(run_id)
    log_audit(
        actor_user_id=identity.user.id, action="run.cancel",
        resource_type="run", resource_id=run_id,
    )
```

### 5.3 关键：patch.approve 区分 low/high

打开 `routes/patches.py::api_patch_approve`：

```python
@router.post("/patches/{patch_id}/approve")
async def api_patch_approve(
    patch_id: str, req: PatchDecisionReq,
    request: Request,
    identity = Depends(get_identity),
):
    p = patch_proposal_get(patch_id)
    if not p:
        raise HTTPException(404, "patch not found")
    
    risk = p.get("risk_assessment", {}) or {}
    requires_strong = risk.get("requires_strong_approval", False)
    overall = risk.get("overall", p.get("risk_level", "medium"))
    
    # Permission check based on risk
    proj_id = p.get("project_id", "")
    role = identity.role_for_project(proj_id)
    
    if requires_strong:
        if not check_permission(role, "patch.approve"):  # full approve
            log_audit(
                actor_user_id=identity.user.id, action="patch.approve.denied",
                resource_type="patch", resource_id=patch_id, project_id=proj_id,
                details={"role": role, "risk": overall, "requires_strong": True},
                success=False,
            )
            raise HTTPException(403, "this patch requires a reviewer to approve")
    else:
        if not check_permission(role, "patch.approve.low") and \
           not check_permission(role, "patch.approve"):
            raise HTTPException(403, "lacks patch.approve permission")
    
    # ... rest of existing implementation, plus audit at end ...
```

### 5.4 artifact 下载区分

```python
@router.get("/artifacts/{artifact_id}/download")
async def api_artifact_download(
    artifact_id: str, request: Request, identity = Depends(get_identity),
):
    art = artifact_get(artifact_id)
    if not art:
        raise HTTPException(404)
    
    proj_id = art.get("project_id", "")
    role = identity.role_for_project(proj_id)
    
    # .bit / .ltx require artifact.download.bitstream
    name = (art.get("path") or "").lower()
    is_bitstream = name.endswith(".bit") or name.endswith(".ltx") or name.endswith(".bin")
    
    perm = "artifact.download.bitstream" if is_bitstream else "artifact.read"
    if not check_permission(role, perm):
        log_audit(
            actor_user_id=identity.user.id, action="artifact.download.denied",
            resource_type="artifact", resource_id=artifact_id, project_id=proj_id,
            details={"perm_required": perm, "role": role, "filename": art.get("path", "")},
            success=False,
        )
        raise HTTPException(403)
    
    log_audit(
        actor_user_id=identity.user.id, action="artifact.download",
        resource_type="artifact", resource_id=artifact_id, project_id=proj_id,
        details={"filename": art.get("path", ""), "is_bitstream": is_bitstream},
    )
    return FileResponse(art["path"])
```

---

## 6. 步骤 8-9：Admin + Audit Routes

### 6.1 `web/routes/admin.py`

```python
"""Admin endpoints — Phase 8."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from edagent_vivado.auth.identity import (
    list_users, create_user, add_project_member, get_user_by_id,
)
from edagent_vivado.auth.permissions import invalidate_perm_cache
from edagent_vivado.auth.audit import log_audit
from edagent_vivado.repository.db import get_db
from edagent_vivado.web.dependencies import require_role, get_identity

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


class CreateUserReq(BaseModel):
    username: str
    display_name: str = ""
    email: str = ""
    global_role: str = "viewer"
    is_service_account: bool = False


class AddMemberReq(BaseModel):
    user_id: str
    role_name: str


@router.get("/users", dependencies=[Depends(require_role("admin"))])
async def api_list_users():
    return {"users": list_users()}


@router.post("/users", dependencies=[Depends(require_role("admin"))])
async def api_create_user(req: CreateUserReq, identity = Depends(get_identity)):
    user = create_user(
        username=req.username, display_name=req.display_name, email=req.email,
        global_role=req.global_role, is_service_account=req.is_service_account,
    )
    log_audit(
        actor_user_id=identity.user.id, action="user.create",
        resource_type="user", resource_id=user["id"],
        details={"username": req.username, "role": req.global_role},
    )
    return user


@router.post("/users/{user_id}/deactivate", dependencies=[Depends(require_role("admin"))])
async def api_deactivate_user(user_id: str, identity = Depends(get_identity)):
    db = get_db()
    db.execute("UPDATE users SET is_active=0 WHERE id=?", (user_id,))
    db.commit()
    log_audit(actor_user_id=identity.user.id, action="user.deactivate",
              resource_type="user", resource_id=user_id)
    return {"ok": True}


@router.post("/users/{user_id}/rotate-token", dependencies=[Depends(require_role("admin"))])
async def api_rotate_token(user_id: str, identity = Depends(get_identity)):
    import secrets
    new_token = secrets.token_urlsafe(32)
    db = get_db()
    db.execute("UPDATE users SET api_token=? WHERE id=?", (new_token, user_id))
    db.commit()
    log_audit(actor_user_id=identity.user.id, action="user.rotate_token",
              resource_type="user", resource_id=user_id)
    return {"user_id": user_id, "api_token": new_token}


@router.post("/projects/{project_id}/members",
             dependencies=[Depends(require_role("admin", "project_owner"))])
async def api_add_member(project_id: str, req: AddMemberReq, identity = Depends(get_identity)):
    if not get_user_by_id(req.user_id):
        raise HTTPException(404, "user not found")
    add_project_member(project_id, req.user_id, req.role_name, added_by=identity.user.id)
    log_audit(actor_user_id=identity.user.id, action="project.member.add",
              resource_type="project", resource_id=project_id,
              details={"user_id": req.user_id, "role": req.role_name})
    return {"ok": True}


@router.delete("/projects/{project_id}/members/{user_id}",
               dependencies=[Depends(require_role("admin", "project_owner"))])
async def api_remove_member(project_id: str, user_id: str, identity = Depends(get_identity)):
    db = get_db()
    db.execute("DELETE FROM project_members WHERE project_id=? AND user_id=?",
               (project_id, user_id))
    db.commit()
    log_audit(actor_user_id=identity.user.id, action="project.member.remove",
              resource_type="project", resource_id=project_id,
              details={"user_id": user_id})
    return {"ok": True}


@router.post("/cache/invalidate-permissions",
             dependencies=[Depends(require_role("admin"))])
async def api_invalidate_perms():
    invalidate_perm_cache()
    return {"ok": True}
```

### 6.2 `web/routes/audit.py`

```python
"""Audit log query — Phase 8."""

from fastapi import APIRouter, Depends, Query

from edagent_vivado.auth.audit import list_audits
from edagent_vivado.web.dependencies import require_perm

router = APIRouter(prefix="/api/v1/audit", tags=["audit"])


@router.get("/logs", dependencies=[Depends(require_perm("audit.read"))])
async def api_audit_logs(
    actor_user_id: str = Query(""),
    action: str = Query(""),
    resource_type: str = Query(""),
    resource_id: str = Query(""),
    project_id: str = Query(""),
    since_ms: int = Query(0),
    until_ms: int = Query(0),
    limit: int = Query(200, le=1000),
    offset: int = Query(0),
):
    rows = list_audits(
        actor_user_id=actor_user_id, action=action,
        resource_type=resource_type, resource_id=resource_id,
        project_id=project_id, since_ms=since_ms, until_ms=until_ms,
        limit=limit, offset=offset,
    )
    return {"logs": rows, "count": len(rows)}
```

---

## 7. 步骤 10：CLI admin commands

打开 `src/edagent_vivado/cli.py`，加：

```python
admin_app = typer.Typer(help="Admin commands")
app.add_typer(admin_app, name="admin")


@admin_app.command("create-user")
def cli_create_user(
    username: str,
    role: str = typer.Option("viewer", "--role", "-r"),
    display: str = typer.Option("", "--display-name"),
    service: bool = typer.Option(False, "--service-account"),
):
    """Create a user; prints API token (only shown once)."""
    from edagent_vivado.auth.identity import create_user
    u = create_user(username=username, display_name=display,
                    global_role=role, is_service_account=service)
    typer.echo(f"Created user {username}")
    typer.echo(f"API token: {u['api_token']}")
    typer.echo("Save this token now; it cannot be retrieved later.")


@admin_app.command("list-users")
def cli_list_users():
    from edagent_vivado.auth.identity import list_users
    for u in list_users():
        active = "✓" if u["is_active"] else "✗"
        typer.echo(f"  {active} {u['username']:20s} {u['global_role']:15s} {u['display_name']}")


@admin_app.command("rotate-token")
def cli_rotate_token(user_id: str):
    import secrets
    from edagent_vivado.repository.db import get_db
    db = get_db()
    new_tok = secrets.token_urlsafe(32)
    db.execute("UPDATE users SET api_token=? WHERE id=?", (new_tok, user_id))
    db.commit()
    typer.echo(f"new token: {new_tok}")


@admin_app.command("add-member")
def cli_add_member(project_id: str, user_id: str, role_name: str):
    from edagent_vivado.auth.identity import add_project_member
    add_project_member(project_id, user_id, role_name)
    typer.echo(f"added {user_id} as {role_name} to {project_id}")
```

---

## 8. 步骤 11-12：前端

### 8.1 LoginPage

**新建** `frontend/src/pages/LoginPage.tsx`：

```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import './LoginPage.css'

export function LoginPage() {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  
  const submit = async () => {
    if (!token.trim()) return
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/v1/me', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) throw new Error(`Invalid token (HTTP ${r.status})`)
      const me = await r.json()
      localStorage.setItem('synthia_token', token)
      localStorage.setItem('synthia_user', JSON.stringify(me))
      navigate('/chat')
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }
  
  return (
    <div className="syn-login">
      <div className="syn-login__card">
        <h1 className="syn-login__title">Synthia</h1>
        <p className="syn-login__sub">AI-powered Vivado workbench</p>
        <input
          type="password"
          className="syn-login__input"
          placeholder="API token"
          value={token}
          onChange={e => setToken(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
        />
        {error && <div className="syn-login__error">{error}</div>}
        <button
          className="syn-button syn-button--primary syn-login__btn"
          disabled={busy || !token.trim()}
          onClick={submit}
        >
          {busy ? 'Verifying...' : 'Sign in'}
        </button>
        <p className="syn-login__hint">
          Don't have a token? Run <code>edagent admin create-user &lt;username&gt;</code> as admin.
        </p>
      </div>
    </div>
  )
}
```

### 8.2 `/api/v1/me` 端点

打开（或新建）`web/routes/me.py`：

```python
from fastapi import APIRouter, Depends
from edagent_vivado.web.dependencies import get_identity

router = APIRouter(prefix="/api/v1", tags=["me"])


@router.get("/me")
async def api_me(identity = Depends(get_identity)):
    return {
        "user": {
            "id": identity.user.id,
            "username": identity.user.username,
            "display_name": identity.user.display_name,
            "global_role": identity.user.global_role,
            "is_admin": identity.user.is_admin,
        },
        "project_roles": identity.project_roles,
    }
```

### 8.3 前端按 role 隐藏按钮

加 `frontend/src/hooks/usePermissions.ts`：

```ts
import { useEffect, useState } from 'react'

export interface Me {
  user: { id: string; username: string; global_role: string; is_admin: boolean }
  project_roles: Record<string, string>
}

let _me: Me | null = null

export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(_me)
  useEffect(() => {
    if (_me) return
    const tok = localStorage.getItem('synthia_token') || ''
    if (!tok) return
    fetch('/api/v1/me', { headers: { Authorization: `Bearer ${tok}` } })
      .then(r => r.json())
      .then(d => { _me = d; setMe(d) })
      .catch(() => {})
  }, [])
  return me
}

const ROLE_PERMS: Record<string, string[]> = {
  admin: ['*'],
  project_owner: [
    'project.read', 'project.update', 'project.delete',
    'run.create', 'run.cancel', 'patch.approve', 'patch.reject',
    'artifact.download.bitstream', 'audit.read',
  ],
  fpga_engineer: [
    'project.read', 'run.create', 'run.cancel', 'patch.propose',
    'patch.approve.low', 'artifact.download.bitstream',
  ],
  reviewer: ['project.read', 'run.read', 'patch.approve', 'patch.reject', 'audit.read'],
  viewer: ['project.read', 'run.read'],
  tool_admin: ['connector.write', 'tool_target.write'],
}

export function canUserDo(me: Me | null, permission: string, projectId?: string): boolean {
  if (!me) return false
  if (me.user.is_admin) return true
  const role = (projectId && me.project_roles[projectId]) || me.user.global_role
  const perms = ROLE_PERMS[role] || []
  if (perms.includes('*')) return true
  return perms.some(p =>
    p === permission ||
    (p.endsWith('.*') && permission.startsWith(p.slice(0, -1)))
  )
}
```

在 ComposerBar、ApprovalCard 等处使用：

```tsx
const me = useMe()
const canCreateRun = canUserDo(me, 'run.create', projectId)
const canDownloadBit = canUserDo(me, 'artifact.download.bitstream', projectId)
{canDownloadBit && <button>Download .bit</button>}
```

### 8.4 路由守卫

`frontend/src/App.tsx`:

```tsx
const ProtectedRoute = ({ children }: { children: ReactNode }) => {
  const token = localStorage.getItem('synthia_token')
  if (!token) return <Navigate to="/login" />
  return <>{children}</>
}

<Routes>
  <Route path="/login" element={<LoginPage />} />
  <Route path="/*" element={<ProtectedRoute><AppShell>...</AppShell></ProtectedRoute>} />
</Routes>
```

---

## 9. 测试

### 9.1 关键 cases

```python
# tests/test_rbac.py
import pytest


@pytest.fixture
def fresh_db(tmp_path, monkeypatch):
    from edagent_vivado.repository import db as _db
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "test.db"))
    _db._instance = None  # reset connection
    yield


def _make_user(role: str):
    from edagent_vivado.auth.identity import create_user
    return create_user(username=f"u_{role}", global_role=role)


def test_viewer_cannot_create_run(fresh_db, enable_auth):
    """Viewer hits 403 on POST /projects/{id}/runs."""
    u = _make_user("viewer")
    client = enable_auth["client"]
    
    # First create a project as admin
    admin_tok = enable_auth["token"]
    p = client.post("/api/v1/projects",
                    headers={"Authorization": f"Bearer {admin_tok}"},
                    json={"name": "t", "root_path": "/tmp"}).json()
    
    r = client.post(
        f"/api/v1/projects/{p['id']}/runs",
        headers={"Authorization": f"Bearer {u['api_token']}"},
        json={"flow_name": "vivado_synth_only", "inputs": {}},
    )
    assert r.status_code == 403


def test_engineer_can_create_run(fresh_db, enable_auth):
    u = _make_user("fpga_engineer")
    client = enable_auth["client"]
    admin_tok = enable_auth["token"]
    
    p = client.post("/api/v1/projects",
                    headers={"Authorization": f"Bearer {admin_tok}"},
                    json={"name": "t2", "root_path": "/tmp"}).json()
    
    r = client.post(
        f"/api/v1/projects/{p['id']}/runs",
        headers={"Authorization": f"Bearer {u['api_token']}"},
        json={"flow_name": "vivado_synth_only", "inputs": {}},
    )
    # 200 or 422; not 403
    assert r.status_code != 403


def test_engineer_cannot_approve_high_risk_patch(fresh_db, enable_auth):
    """Engineer creates run → high-risk patch → approve denied for engineer."""
    # ... setup patch in 'proposed' state with risk='high'
    # ... call POST /patches/{id}/approve as engineer
    # ... expect 403


def test_admin_can_do_anything(fresh_db, enable_auth):
    admin_tok = enable_auth["token"]
    client = enable_auth["client"]
    r = client.get("/api/v1/admin/users", headers={"Authorization": f"Bearer {admin_tok}"})
    assert r.status_code == 200


def test_audit_log_written(fresh_db, enable_auth):
    admin_tok = enable_auth["token"]
    client = enable_auth["client"]
    
    client.post("/api/v1/projects",
                headers={"Authorization": f"Bearer {admin_tok}"},
                json={"name": "tx", "root_path": "/tmp"})
    
    from edagent_vivado.auth.audit import list_audits
    logs = list_audits(action="project.create", limit=10)
    assert any(l["resource_type"] == "project" for l in logs)


def test_audit_denied_recorded(fresh_db, enable_auth):
    u = _make_user("viewer")
    client = enable_auth["client"]
    
    client.post("/api/v1/admin/users",
                headers={"Authorization": f"Bearer {u['api_token']}"},
                json={"username": "evil"})
    
    from edagent_vivado.auth.audit import list_audits
    denies = list_audits(action="auth.denied", limit=10)
    assert len(denies) > 0
```

### 9.2 跑

```bash
python -m pytest tests/test_permissions.py tests/test_rbac.py -v
```

### 9.3 commit

```bash
git add -A
git commit -m "Phase 8: RBAC + audit logging

Backend:
- DB: users / roles / project_members / audit_logs tables
- auth/identity.py: User, Identity, load_identity from token
- auth/permissions.py: check_permission with wildcard support + cache
- auth/audit.py: log_audit + list_audits
- web/auth.py: IdentityMiddleware replaces ApiTokenMiddleware
- web/dependencies.py: require_perm / require_role / get_identity
- routes/admin.py: user/member management
- routes/audit.py: log query
- routes/me.py: GET /me returns identity
- routes/patches.py: strong-approval gated by reviewer role
- routes/runs.py / projects.py / artifacts.py: require_perm on all mutating endpoints
- CLI: 'edagent admin create-user/list-users/rotate-token/add-member'

Frontend:
- pages/LoginPage.tsx: token entry
- hooks/usePermissions.ts: canUserDo() for client-side gating
- AppShell hides buttons based on role

Tests:
- test_permissions.py: 5 role-perm cases
- test_rbac.py: 6 e2e cases (viewer denied, engineer allowed, audit recorded)

Bootstrap:
- First-run auto-creates 'admin' user, writes token to ~/.synthia/admin_token
"
```

---

## 10. 附录

### 10.1 常见坑

**A. Bootstrap admin token 暴露**：first run 会写明文 token 到 `~/.synthia/admin_token`。文档要强调「read it, save to a password manager, then `chmod 000` or delete」。

**B. Permission cache 失效**：修改 role permissions 后必须 `invalidate_perm_cache()`，否则进程内仍用旧权限。`POST /admin/cache/invalidate-permissions` 提供手动入口。

**C. 大量 audit row**：高频 endpoint 一天能产生几万条日志。加 retention：`scripts/audit_cleanup.py --keep-days 90`。Phase 11 上 Postgres 后做分区。

**D. project_id 提取**：`require_perm("foo", project_id_param="project_id")` 只看 path/query，不读 body。如果 project_id 在 body 里（很少），手动 check：

```python
@router.post("/foo")
async def foo(req: FooReq, identity = Depends(get_identity)):
    if not check_permission(identity.role_for_project(req.project_id), "foo.write"):
        raise HTTPException(403)
```

**E. service account / MCP**：CI / MCP server 通过 `is_service_account=True` 创建。这类 user 没法用 LoginPage 登录（无 password），只能用 token。Phase 9 MCP 直接使用此 token。

**F. permission name 演进**：以后加新 perm 别破坏现有 role。在 `_seed_builtin_roles` 时 `UPDATE roles SET permissions_json=...` 让现有 role 自动获得新权限（已实现）。

**G. anonymous-admin in test mode**：测试默认带 `SYNTHIA_AUTH_TEST_MODE=1`，identity 是 admin。这没问题，因为权限路径仍执行（admin role 通过）。但要写一些 fixture 模拟 viewer 才能验证 403 路径。

### 10.2 耗时

| 步骤 | 估时 |
|------|------|
| 1 DB schema + seed | 1d |
| 2-3 identity/permissions | 1d |
| 4-6 middleware + audit + dependencies | 1d |
| 7 给所有路由加权限 | 2d |
| 8-9 admin / audit routes | 1d |
| 10 CLI | 0.5d |
| 11-12 前端登录 + 按 role 隐藏 | 1.5d |
| 测试 + smoke | 1d |

**总计：** 全职 9 天；vibe coding 2-3 周。

### 10.3 Phase 9 衔接

Phase 8 留下 `is_service_account=True` 的 user 类型，正是 MCP server 在 Phase 9 要用的身份。Phase 9 的所有 MCP tool 都是用一个 service account token 调 Synthia API，权限由 admin 在创建 service account 时分配。

Phase 8 完工后用户应该能：
- ✅ 多用户登录（admin 创建用户）
- ✅ Viewer 看不到下载按钮、点不到 approve
- ✅ Project Owner 邀请成员到 project
- ✅ 所有 mutate 操作落 audit log
- ✅ Reviewer 在 Audit 页面查询历史
