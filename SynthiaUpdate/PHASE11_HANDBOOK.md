# Synthia Phase 11 开发手册：部署与高并发 (PostgreSQL / Redis / Worker Queue)

> **前置条件：** Phase 0-10 + 5.5 完成  
> **目标：** 从单机 SQLite 单进程，迈向多用户、多 worker、license-aware 排队的企业可部署形态  
> **预估工期：** 全职 12 天；vibe coding 4-5 周  
> **关键约束：** 单机 SQLite 模式必须仍能跑（dev / 小团队）；切换 Postgres 应该是配置改 + 一次 migration，不重写代码

---

## 0. 为什么 Phase 11 不是「QPS 高并发」而是「Vivado run 排队」

Synthia 的并发压力不在 API（一个 PM 工程师一天点不了几次 button）；压力在**长任务的资源调度**：

- Vivado license 数有限（团队可能 2-4 个并发 license）
- 大设计 1 小时 + 一跑，CPU/RAM 占满
- Remote SSH worker 数有限（可能 2 台 Linux 机 + 1 台 Win 跑 Vivado）
- 任务跑一半服务重启 → 必须能 resume 或至少标 orphan
- 多用户 + 多 project 同时提 run → 公平队列 + 优先级

Phase 11 落地：
1. **PostgreSQL 替换 SQLite** —— 支持多进程并发读写，行级锁
2. **Redis 做队列 + 锁 + Pub/Sub** —— worker 通信 + 跨进程 lock
3. **Worker pool** —— `synthia-worker` 进程独立跑，从队列拉任务
4. **License-aware scheduler** —— task ↔ license pool 绑定，超额排队
5. **Docker compose** —— synthia-web + worker + postgres + redis 一键起
6. **健康检查 + 备份/恢复** —— 工程运维基础

---

## 1. 任务清单

| 步骤 | 文件 | 类型 |
|------|------|------|
| 1 | `pyproject.toml` | 加 `postgres` / `redis` / `worker` extras |
| 2 | `repository/db.py` | 抽象 backend (sqlite / postgres) |
| 3 | `repository/migrations/` | 新建：迁移脚本 |
| 4 | `infra/redis_client.py` | 新建：Redis 连接管理 |
| 5 | `infra/queue.py` | 新建：task queue (Redis stream) |
| 6 | `infra/distributed_lock.py` | 新建：Redis-backed lock |
| 7 | `scheduler/license_pool.py` | 新建：license-aware semaphore |
| 8 | `scheduler/scheduler.py` | 新建：主调度器 |
| 9 | `workers/worker.py` | 新建：worker 主进程 |
| 10 | `runs/orchestrator.py` | 改：从直接执行 → enqueue |
| 11 | CLI: `edagent worker / db migrate / db backup` | 新增 |
| 12 | `docker/Dockerfile.web` + `Dockerfile.worker` | 新建 |
| 13 | `docker-compose.yml` | 新建 |
| 14 | `infra/health.py` | 新建：health endpoints |
| 15 | docs/DEPLOYMENT.md | 文档 |
| 16 | 测试 | — |

---

## 2. 步骤 1：依赖

打开 `pyproject.toml`：

```toml
[project.optional-dependencies]
postgres = [
    "psycopg[binary]>=3.1",
    "sqlalchemy>=2.0",
    "alembic>=1.13",
]
redis = [
    "redis>=5.0",
]
worker = [
    "psycopg[binary]>=3.1",
    "redis>=5.0",
]

[project.scripts]
edagent = "edagent_vivado.cli:app"
synthia = "edagent_vivado.cli:app"
synthia-mcp = "edagent_vivado.mcp.server:run_main"
synthia-worker = "edagent_vivado.workers.worker:main"
```

```bash
pip install -e ".[postgres,redis,worker]"
```

---

## 3. 步骤 2-3：DB Backend Abstraction + Migrations

### 3.1 关键决策：用 SQLAlchemy Core，不用 ORM

理由：当前代码全是 raw SQL；不要重写。SQLAlchemy Core 只是给我们 connection pool + dialect 抽象，SQL 仍然写 string，但用 `text()` 包裹支持参数化。

### 3.2 改 `repository/db.py`

```python
"""DB connection — Phase 11 multi-backend support."""

from __future__ import annotations

import logging
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Detect backend
_BACKEND = os.environ.get("SYNTHIA_DB_BACKEND", "").lower()
if not _BACKEND:
    if os.environ.get("SYNTHIA_DB_URL", "").startswith("postgresql"):
        _BACKEND = "postgres"
    else:
        _BACKEND = "sqlite"

_engine = None       # postgres SQLAlchemy engine
_sqlite_conn = None  # sqlite connection (kept open)


def get_backend() -> str:
    return _BACKEND


def _build_postgres_engine():
    global _engine
    if _engine is not None:
        return _engine
    from sqlalchemy import create_engine
    url = os.environ.get("SYNTHIA_DB_URL",
                          "postgresql+psycopg://synthia:synthia@localhost:5432/synthia")
    _engine = create_engine(
        url,
        pool_size=int(os.environ.get("SYNTHIA_DB_POOL_SIZE", "10")),
        max_overflow=int(os.environ.get("SYNTHIA_DB_POOL_OVERFLOW", "5")),
        pool_pre_ping=True,
        future=True,
    )
    return _engine


def _build_sqlite_conn():
    global _sqlite_conn
    if _sqlite_conn is not None:
        return _sqlite_conn
    db_path = os.environ.get("EDAGENT_DB_PATH") or str(Path.home() / ".synthia" / "synthia.db")
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    _sqlite_conn = sqlite3.connect(db_path, check_same_thread=False,
                                    isolation_level=None,  # autocommit
                                    timeout=30.0)
    _sqlite_conn.row_factory = sqlite3.Row
    _sqlite_conn.execute("PRAGMA foreign_keys=ON")
    _sqlite_conn.execute("PRAGMA journal_mode=WAL")
    return _sqlite_conn


class _ConnectionWrapper:
    """Unify .execute() / .fetchone() / .fetchall() / .commit() across backends.
    
    Postgres: uses SQLAlchemy connection.execute(text(...), params).
    SQLite: passes through.
    
    To unify SQL syntax, all queries should use named parameters (:param) and we'll
    translate ? to :p_0, :p_1 ... for postgres path.
    """
    
    def __init__(self):
        if _BACKEND == "postgres":
            from sqlalchemy import text
            self._engine = _build_postgres_engine()
            self._sql_text = text
            self._conn = self._engine.connect()
        else:
            self._conn = _build_sqlite_conn()
    
    def execute(self, sql: str, params: tuple | list | dict | None = None) -> "_CursorWrapper":
        if _BACKEND == "postgres":
            # translate ? → :p_0, :p_1, ...
            named_params = {}
            i = 0
            def _repl(m):
                nonlocal i
                key = f"p_{i}"; i += 1
                return f":{key}"
            import re
            sql2 = re.sub(r"\?", _repl, sql)
            if isinstance(params, (tuple, list)):
                named_params = {f"p_{j}": v for j, v in enumerate(params)}
            elif isinstance(params, dict):
                named_params = params
            result = self._conn.execute(self._sql_text(sql2), named_params or {})
            return _PgCursor(result)
        else:
            return _SqliteCursor(self._conn.execute(sql, params or ()))
    
    def commit(self) -> None:
        if _BACKEND == "postgres":
            self._conn.commit()
        # sqlite is autocommit; no-op
    
    def close(self) -> None:
        if _BACKEND == "postgres":
            self._conn.close()


class _SqliteCursor:
    def __init__(self, cur):
        self._cur = cur
    
    def fetchone(self):
        return self._cur.fetchone()
    
    def fetchall(self):
        return self._cur.fetchall()
    
    @property
    def rowcount(self):
        return self._cur.rowcount
    
    @property
    def lastrowid(self):
        return self._cur.lastrowid


class _PgCursor:
    """Wrap SQLAlchemy Result to look like sqlite cursor."""
    
    def __init__(self, result):
        self._result = result
        self._all = None
    
    def fetchone(self):
        row = self._result.fetchone()
        return _RowDict(row) if row else None
    
    def fetchall(self):
        return [_RowDict(r) for r in self._result.fetchall()]
    
    @property
    def rowcount(self):
        return self._result.rowcount
    
    @property
    def lastrowid(self):
        # postgres doesn't have implicit lastrowid; tables should use RETURNING
        return None


class _RowDict(dict):
    """SQLite Row-like (supports row[0] and row['name'] and dict(row))."""
    
    def __init__(self, sa_row):
        super().__init__(sa_row._mapping)
        self._values = list(sa_row._mapping.values())
    
    def __getitem__(self, k):
        if isinstance(k, int):
            return self._values[k]
        return super().__getitem__(k)


_local_conn = None


def get_db():
    global _local_conn
    if _local_conn is None:
        _local_conn = _ConnectionWrapper()
        _init_db(_local_conn)
    return _local_conn


def _init_db(conn) -> None:
    """Apply schema based on backend."""
    if _BACKEND == "postgres":
        _apply_postgres_schema(conn)
    else:
        _apply_sqlite_schema(conn)
    
    # Common: seed roles
    from edagent_vivado.repository._seed import seed_builtin_roles, bootstrap_admin
    try:
        seed_builtin_roles(conn)
        bootstrap_admin(conn)
    except Exception:
        logger.exception("seed failed (non-fatal)")
```

### 3.3 SQL 兼容层：把 SQLite-isms 抹平

Phase 11 之前 SQL 大量用 SQLite 专属：

| SQLite | Portable | 备注 |
|--------|----------|------|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGSERIAL PRIMARY KEY` / SQLite 保留 | 用 dialect-specific schema |
| `INTEGER` for timestamps | `BIGINT` for ms epoch | 改用 BIGINT |
| `TEXT` everywhere | `TEXT` 都接受 | OK |
| `INSERT OR REPLACE` | `INSERT ... ON CONFLICT ... DO UPDATE` | 提供 helper |
| `?` placeholder | `?` (我们翻译) | OK |
| PRAGMA | 删除 / 用 SET | postgres 无 PRAGMA |
| `lastrowid` | `RETURNING id` | 提供 helper |

把 schema 写成两份（`schema_sqlite.sql` / `schema_postgres.sql`），用 Alembic 或自己写 migration_v1.py 让两边对齐。

### 3.4 migration framework

```bash
mkdir -p src/edagent_vivado/repository/migrations
```

**新建** `src/edagent_vivado/repository/migrations/__init__.py`：

```python
"""Migration framework — Phase 11."""

from __future__ import annotations

import importlib
import logging
import pkgutil
from pathlib import Path

logger = logging.getLogger(__name__)


def list_migrations() -> list:
    """Discover migration_NNN modules in this package."""
    import edagent_vivado.repository.migrations as pkg
    mods = []
    for info in pkgutil.iter_modules(pkg.__path__):
        if info.name.startswith("migration_"):
            mods.append(info.name)
    mods.sort()
    return mods


def applied_migrations(conn) -> set:
    """Return set of migration names already applied."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS migration_history (
            name TEXT PRIMARY KEY,
            applied_at BIGINT NOT NULL
        )
    """)
    conn.commit()
    rows = conn.execute("SELECT name FROM migration_history").fetchall()
    return {r["name"] for r in rows}


def apply_pending(conn) -> list[str]:
    """Apply all migrations not yet applied. Returns list of applied names."""
    import time
    done = applied_migrations(conn)
    applied = []
    for name in list_migrations():
        if name in done:
            continue
        logger.info("applying migration %s", name)
        mod = importlib.import_module(f"edagent_vivado.repository.migrations.{name}")
        if not hasattr(mod, "apply"):
            logger.warning("migration %s has no apply()", name)
            continue
        mod.apply(conn)
        conn.execute("INSERT INTO migration_history (name, applied_at) VALUES (?, ?)",
                      (name, int(time.time() * 1000)))
        conn.commit()
        applied.append(name)
    return applied
```

**新建** `src/edagent_vivado/repository/migrations/migration_001_base.py`：

```python
"""Base schema — Phase 11 unified."""

from edagent_vivado.repository.db import get_backend


_PG_SCHEMA = [
    """CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        manifest_path TEXT DEFAULT '',
        xpr_path TEXT DEFAULT '',
        xpr_fingerprint TEXT DEFAULT '',
        last_xpr_sync_at BIGINT,
        imported_from_xpr INTEGER DEFAULT 0,
        state TEXT DEFAULT 'active',
        metadata_json TEXT DEFAULT '{}',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        agent_id TEXT DEFAULT '',
        user_id TEXT DEFAULT '',
        state TEXT DEFAULT 'active',
        seq BIGINT DEFAULT 0,
        created_at BIGINT NOT NULL,
        last_activity_at BIGINT
    )""",
    """CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT DEFAULT '',
        project_id TEXT DEFAULT '',
        task_id TEXT DEFAULT '',
        flow_name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'created',
        xpr_fingerprint_at_start TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}',
        error_message TEXT DEFAULT '',
        created_at BIGINT NOT NULL,
        started_at BIGINT,
        completed_at BIGINT
    )""",
    "CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id)",
    "CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state)",
    "CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id)",
    
    """CREATE TABLE IF NOT EXISTS events (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT DEFAULT '',
        run_id TEXT DEFAULT '',
        seq BIGINT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT DEFAULT '{}',
        created_at BIGINT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq)",
    "CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id)",
    
    # ... other tables: users, roles, project_members, audit_logs, patch_proposals, ...
]


_SQLITE_SCHEMA = [
    sql.replace("BIGSERIAL PRIMARY KEY", "INTEGER PRIMARY KEY AUTOINCREMENT")
       .replace("BIGINT", "INTEGER")
    for sql in _PG_SCHEMA
]


def apply(conn):
    stmts = _PG_SCHEMA if get_backend() == "postgres" else _SQLITE_SCHEMA
    for stmt in stmts:
        conn.execute(stmt)
    conn.commit()
```

后续 migrations 命名：`migration_002_benchmarks.py`, `migration_003_patches.py`, ...

### 3.5 CLI: `synthia db`

```python
db_app = typer.Typer(help="Database admin")
app.add_typer(db_app, name="db")


@db_app.command("migrate")
def cli_db_migrate():
    """Apply pending migrations."""
    from edagent_vivado.repository.db import get_db
    from edagent_vivado.repository.migrations import apply_pending
    conn = get_db()
    applied = apply_pending(conn)
    if applied:
        typer.echo(f"Applied: {applied}")
    else:
        typer.echo("Database up to date.")


@db_app.command("status")
def cli_db_status():
    from edagent_vivado.repository.db import get_db, get_backend
    from edagent_vivado.repository.migrations import list_migrations, applied_migrations
    conn = get_db()
    typer.echo(f"Backend: {get_backend()}")
    all_m = set(list_migrations())
    applied = applied_migrations(conn)
    for m in sorted(all_m):
        mark = "✓" if m in applied else "·"
        typer.echo(f"  {mark} {m}")


@db_app.command("backup")
def cli_db_backup(output: Path):
    """Backup the DB."""
    from edagent_vivado.repository.db import get_backend
    import shutil, os
    if get_backend() == "sqlite":
        src = os.environ.get("EDAGENT_DB_PATH") or str(Path.home() / ".synthia" / "synthia.db")
        shutil.copy(src, output)
        typer.echo(f"backed up to {output}")
    else:
        typer.echo("Use pg_dump for postgres backend:")
        typer.echo("  pg_dump $SYNTHIA_DB_URL > backup.sql")
```

---

## 4. 步骤 4-6：Redis Infrastructure

### 4.1 `infra/redis_client.py`

```python
"""Singleton Redis client — Phase 11."""

from __future__ import annotations

import logging
import os
from typing import Optional

import redis

logger = logging.getLogger(__name__)

_client: Optional[redis.Redis] = None


def get_redis() -> redis.Redis:
    global _client
    if _client is None:
        url = os.environ.get("SYNTHIA_REDIS_URL", "redis://localhost:6379/0")
        _client = redis.Redis.from_url(url, decode_responses=True,
                                         socket_timeout=5.0)
        try:
            _client.ping()
        except Exception:
            logger.exception("Redis connection failed (url=%s)", url)
            raise
    return _client


def redis_available() -> bool:
    try:
        get_redis()
        return True
    except Exception:
        return False
```

### 4.2 `infra/queue.py` — Redis Stream-based Task Queue

```python
"""Task queue on Redis streams — Phase 11."""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, Optional

from edagent_vivado.infra.redis_client import get_redis

logger = logging.getLogger(__name__)


# stream key: synthia:queue:{pool}
# consumer group: synthia-workers
# pending list TTL for idempotency: 24h


def enqueue(
    pool: str,
    payload: dict[str, Any],
    *,
    priority: int = 5,
    task_id: str = "",
) -> str:
    """Enqueue a task onto a named pool.
    
    Args:
        pool: which worker pool to target ('default' | 'vivado' | 'bitstream')
        payload: arbitrary JSON-serializable
        priority: 1 (high) .. 9 (low). v1 uses 5 single stream; v1.2 per-priority stream.
        task_id: optional client-supplied id for idempotency
    
    Returns the stream entry id.
    """
    r = get_redis()
    tid = task_id or str(uuid.uuid4())
    key = f"synthia:queue:{pool}"
    fields = {
        "task_id": tid,
        "payload": json.dumps(payload, ensure_ascii=False),
        "priority": str(priority),
        "enqueued_at": str(int(time.time() * 1000)),
    }
    entry_id = r.xadd(key, fields, maxlen=10000, approximate=True)
    logger.info("enqueued task %s on %s (entry=%s)", tid, pool, entry_id)
    return entry_id


def dequeue(
    pool: str,
    *,
    consumer_name: str,
    group: str = "synthia-workers",
    block_ms: int = 5000,
    count: int = 1,
) -> list[tuple[str, dict[str, Any]]]:
    """Read up to `count` tasks for this consumer in the group.
    
    Returns list of (entry_id, payload_dict).
    """
    r = get_redis()
    key = f"synthia:queue:{pool}"
    
    # Ensure group exists
    try:
        r.xgroup_create(key, group, id="0", mkstream=True)
    except redis.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise
    
    results = r.xreadgroup(group, consumer_name, {key: ">"}, count=count, block=block_ms)
    out: list[tuple[str, dict[str, Any]]] = []
    if not results:
        return out
    for stream_key, entries in results:
        for entry_id, fields in entries:
            try:
                payload = json.loads(fields.get("payload", "{}"))
            except Exception:
                payload = {}
            payload["__entry_id"] = entry_id
            payload["__task_id"] = fields.get("task_id", "")
            out.append((entry_id, payload))
    return out


def ack(pool: str, entry_id: str, *, group: str = "synthia-workers") -> None:
    r = get_redis()
    r.xack(f"synthia:queue:{pool}", group, entry_id)


def pending_count(pool: str, *, group: str = "synthia-workers") -> int:
    r = get_redis()
    try:
        info = r.xpending(f"synthia:queue:{pool}", group)
        return info.get("pending", 0) if isinstance(info, dict) else 0
    except Exception:
        return 0


def queue_depth(pool: str) -> int:
    r = get_redis()
    try:
        return r.xlen(f"synthia:queue:{pool}")
    except Exception:
        return 0


import redis as _redis
```

### 4.3 `infra/distributed_lock.py`

```python
"""Redis-backed distributed lock — Phase 11."""

from __future__ import annotations

import logging
import time
import uuid
from contextlib import contextmanager

from edagent_vivado.infra.redis_client import get_redis

logger = logging.getLogger(__name__)

# Lua script: atomic release only if value matches (prevents releasing someone else's lock)
_RELEASE_LUA = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
"""


class LockNotAcquired(Exception):
    pass


@contextmanager
def acquire_lock(key: str, *, timeout_ms: int = 30000, wait_ms: int = 5000):
    """Acquire a Redis lock for `key` with `timeout_ms` expiration.
    
    Yields on success; raises LockNotAcquired on failure.
    """
    r = get_redis()
    token = str(uuid.uuid4())
    deadline = time.time() + wait_ms / 1000
    full_key = f"synthia:lock:{key}"
    
    while time.time() < deadline:
        ok = r.set(full_key, token, nx=True, px=timeout_ms)
        if ok:
            try:
                yield
            finally:
                try:
                    r.eval(_RELEASE_LUA, 1, full_key, token)
                except Exception:
                    logger.exception("lock release failed for %s", key)
            return
        time.sleep(0.05)
    
    raise LockNotAcquired(f"could not acquire lock '{key}' within {wait_ms}ms")
```

---

## 5. 步骤 7-8：License Pool + Scheduler

### 5.1 `scheduler/license_pool.py`

```python
"""License pool — limit concurrent Vivado runs using a Redis semaphore."""

from __future__ import annotations

import logging
import os
import time
import uuid

from edagent_vivado.infra.redis_client import get_redis

logger = logging.getLogger(__name__)


def _pool_key(name: str) -> str:
    return f"synthia:license:{name}"


def configured_pools() -> dict[str, int]:
    """Read pool config from env: SYNTHIA_LICENSE_POOLS=vivado:4,impl:2.
    
    Default: vivado:1 (safe single-machine).
    """
    raw = os.environ.get("SYNTHIA_LICENSE_POOLS", "vivado:1")
    out: dict[str, int] = {}
    for chunk in raw.split(","):
        if ":" not in chunk:
            continue
        name, n = chunk.split(":", 1)
        out[name.strip()] = int(n)
    return out


def init_pool(name: str, capacity: int) -> None:
    """Set/update pool capacity (idempotent)."""
    r = get_redis()
    r.set(f"synthia:license:cap:{name}", capacity)


def acquire_license(name: str, *, holder: str = "", wait_s: int = 0) -> str | None:
    """Try to acquire a slot from pool. Returns a token if granted; None otherwise.
    
    If wait_s > 0, polls until success or timeout.
    """
    r = get_redis()
    cap_key = f"synthia:license:cap:{name}"
    cap = int(r.get(cap_key) or configured_pools().get(name, 1))
    init_pool(name, cap)  # ensure cap exists
    
    holder = holder or str(uuid.uuid4())
    deadline = time.time() + max(0, wait_s)
    
    while True:
        used_key = f"synthia:license:used:{name}"
        # atomic check-and-incr
        with r.pipeline() as pipe:
            try:
                pipe.watch(used_key)
                current = int(pipe.get(used_key) or 0)
                if current >= cap:
                    pipe.unwatch()
                    if time.time() >= deadline:
                        return None
                    time.sleep(1.0)
                    continue
                pipe.multi()
                pipe.incr(used_key, 1)
                pipe.zadd(f"synthia:license:holders:{name}",
                           {holder: int(time.time() * 1000)})
                pipe.execute()
                logger.info("license acquired pool=%s holder=%s (%d/%d)",
                              name, holder, current + 1, cap)
                return holder
            except Exception:
                # retry
                continue


def release_license(name: str, holder: str) -> None:
    r = get_redis()
    score = r.zscore(f"synthia:license:holders:{name}", holder)
    if score is None:
        # already released or never acquired
        return
    with r.pipeline() as pipe:
        pipe.decr(f"synthia:license:used:{name}")
        pipe.zrem(f"synthia:license:holders:{name}", holder)
        pipe.execute()
    logger.info("license released pool=%s holder=%s", name, holder)


def cleanup_stale(name: str, *, max_age_s: int = 7200) -> int:
    """Release licenses held for too long (worker crash recovery)."""
    r = get_redis()
    cutoff = int((time.time() - max_age_s) * 1000)
    holders = r.zrangebyscore(f"synthia:license:holders:{name}", 0, cutoff)
    for h in holders:
        release_license(name, h)
    return len(holders)


def pool_status(name: str) -> dict:
    r = get_redis()
    cap = int(r.get(f"synthia:license:cap:{name}") or 0)
    used = int(r.get(f"synthia:license:used:{name}") or 0)
    return {"name": name, "capacity": cap, "used": used, "available": max(0, cap - used)}
```

### 5.2 `scheduler/scheduler.py`

```python
"""Run scheduler — dispatch enqueued runs to workers — Phase 11."""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from edagent_vivado.infra.queue import enqueue, queue_depth
from edagent_vivado.repository.store import run_update

logger = logging.getLogger(__name__)


# Map flow_name → worker pool + license pool
_FLOW_ROUTING = {
    "vivado_synth_only": {"worker_pool": "vivado", "license_pool": "vivado"},
    "vivado_synth_impl": {"worker_pool": "vivado", "license_pool": "vivado"},
    "vivado_full_flow":  {"worker_pool": "vivado", "license_pool": "vivado"},
    "diagnose_log":      {"worker_pool": "default", "license_pool": ""},
    "import_xpr":        {"worker_pool": "default", "license_pool": ""},
}


def submit_run(
    run_id: str, flow_name: str, inputs: dict[str, Any],
    *, session_id: str = "", task_id: str = "",
    priority: int = 5,
) -> str:
    """Enqueue a run to be executed by a worker."""
    routing = _FLOW_ROUTING.get(flow_name, {"worker_pool": "default", "license_pool": ""})
    
    payload = {
        "kind": "run",
        "run_id": run_id,
        "flow_name": flow_name,
        "inputs": inputs,
        "session_id": session_id,
        "task_id": task_id,
        "license_pool": routing.get("license_pool", ""),
    }
    
    run_update(run_id, state="queued",
                metadata_json=json.dumps({
                    "flow_name": flow_name,
                    "inputs": inputs,
                    "worker_pool": routing["worker_pool"],
                    "license_pool": routing.get("license_pool", ""),
                }))
    
    entry_id = enqueue(routing["worker_pool"], payload, priority=priority, task_id=run_id)
    logger.info("submitted run %s to pool=%s (entry=%s)",
                  run_id, routing["worker_pool"], entry_id)
    return entry_id


def get_pool_status() -> dict[str, Any]:
    from edagent_vivado.scheduler.license_pool import pool_status, configured_pools
    pools = configured_pools()
    return {
        "license_pools": {name: pool_status(name) for name in pools},
        "queue_depth": {
            "vivado": queue_depth("vivado"),
            "default": queue_depth("default"),
        },
    }
```

---

## 6. 步骤 9-10：Worker + Orchestrator 重接线

### 6.1 `workers/worker.py`

```python
"""Synthia worker process — Phase 11.

Pulls tasks from Redis queue and executes them. License-aware.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import socket
import sys
import threading
import time

from edagent_vivado.infra.queue import dequeue, ack
from edagent_vivado.infra.redis_client import get_redis
from edagent_vivado.scheduler.license_pool import (
    acquire_license, release_license, cleanup_stale,
)
from edagent_vivado.runs.orchestrator import start_run
from edagent_vivado.repository.store import run_update

logger = logging.getLogger("synthia.worker")


_shutdown = threading.Event()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="synthia-worker")
    parser.add_argument("--pool", default=os.environ.get("SYNTHIA_WORKER_POOL", "vivado"),
                         help="Queue pool name")
    parser.add_argument("--name", default=os.environ.get("SYNTHIA_WORKER_NAME",
                                                            f"{socket.gethostname()}-{os.getpid()}"),
                         help="Worker consumer name")
    parser.add_argument("--license-wait-s", type=int, default=3600,
                         help="Max seconds to wait for a license slot before requeue")
    args = parser.parse_args(argv)
    
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    logger.info("worker starting pool=%s name=%s", args.pool, args.name)
    
    # Install signal handlers
    signal.signal(signal.SIGTERM, _signal_shutdown)
    signal.signal(signal.SIGINT, _signal_shutdown)
    
    # Periodic license cleanup
    _start_janitor(args.pool)
    
    while not _shutdown.is_set():
        try:
            tasks = dequeue(args.pool, consumer_name=args.name, block_ms=5000, count=1)
        except Exception:
            logger.exception("dequeue failed; sleeping 5s")
            time.sleep(5)
            continue
        
        for entry_id, payload in tasks:
            if _shutdown.is_set():
                break
            try:
                _execute_task(payload, args)
            except Exception:
                logger.exception("task %s failed", payload.get("__task_id"))
                run_id = payload.get("run_id", "")
                if run_id:
                    try:
                        run_update(run_id, state="failed",
                                    error_message="worker exception (see logs)")
                    except Exception:
                        pass
            finally:
                ack(args.pool, entry_id)
    
    logger.info("worker shutting down")
    return 0


def _execute_task(payload: dict, args) -> None:
    if payload.get("kind") != "run":
        logger.warning("unknown task kind=%s", payload.get("kind"))
        return
    
    run_id = payload["run_id"]
    flow_name = payload["flow_name"]
    inputs = payload.get("inputs", {})
    session_id = payload.get("session_id", "")
    task_id = payload.get("task_id", "")
    license_pool = payload.get("license_pool", "")
    
    # Acquire license (if pool specified)
    holder = None
    if license_pool:
        run_update(run_id, state="queued",
                    error_message=f"waiting for {license_pool} license")
        holder = acquire_license(license_pool, holder=run_id,
                                   wait_s=args.license_wait_s)
        if holder is None:
            logger.warning("run %s could not acquire %s license; requeueing", run_id, license_pool)
            from edagent_vivado.infra.queue import enqueue
            enqueue(args.pool, payload, task_id=run_id)
            return
    
    try:
        logger.info("worker running %s (flow=%s)", run_id, flow_name)
        start_run(
            run_id, flow_name=flow_name, inputs=inputs,
            session_id=session_id, task_id=task_id,
        )
    finally:
        if license_pool and holder:
            release_license(license_pool, holder)


def _signal_shutdown(signum, frame):
    logger.info("received signal %s; finishing current task", signum)
    _shutdown.set()


def _start_janitor(pool: str) -> None:
    def _loop():
        while not _shutdown.is_set():
            try:
                # Try cleanup multiple license pools
                from edagent_vivado.scheduler.license_pool import configured_pools
                for pname in configured_pools().keys():
                    n = cleanup_stale(pname, max_age_s=7200)
                    if n:
                        logger.warning("janitor released %d stale licenses on %s", n, pname)
            except Exception:
                logger.exception("janitor failed (non-fatal)")
            _shutdown.wait(300)  # every 5 min
    
    t = threading.Thread(target=_loop, daemon=True, name="janitor")
    t.start()
```

### 6.2 `runs/orchestrator.py` 改：路由

打开 `runs/orchestrator.py`，找到 `start_run_serial`（P5.5 加的）。增加 Redis 模式分支：

```python
def start_run_serial(
    run_id: str, *, flow_name: str, inputs: dict, session_id: str = "",
    task_id: str = "", stages: list[str] | None = None, background: bool = False,
) -> StartRunResult | None:
    # Phase 11: if worker queue enabled, enqueue instead of executing inline
    from edagent_vivado.infra.redis_client import redis_available
    
    if redis_available() and os.environ.get("SYNTHIA_USE_WORKER_QUEUE", "").lower() in ("1", "true"):
        from edagent_vivado.scheduler.scheduler import submit_run
        submit_run(run_id, flow_name, inputs, session_id=session_id, task_id=task_id)
        return None  # async; caller polls via /runs/{id}
    
    # Legacy path: in-process per-session lock
    from edagent_vivado.runs.scheduler import run_in_session, start_run_async
    
    def _do():
        return start_run(run_id, flow_name=flow_name, inputs=inputs,
                          session_id=session_id, task_id=task_id, stages=stages)
    
    if background:
        start_run_async(session_id, _do)
        return None
    return run_in_session(session_id, _do)
```

---

## 7. 步骤 11：CLI

```python
worker_app = typer.Typer(help="Worker commands")
app.add_typer(worker_app, name="worker")


@worker_app.command("run")
def cli_worker_run(
    pool: str = typer.Option("vivado", "--pool", "-p"),
    name: str = typer.Option("", "--name", "-n"),
):
    """Run a worker process."""
    from edagent_vivado.workers.worker import main
    args = ["--pool", pool]
    if name:
        args.extend(["--name", name])
    sys.exit(main(args))


@worker_app.command("status")
def cli_worker_status():
    """Show queue depth + license pool status."""
    from edagent_vivado.scheduler.scheduler import get_pool_status
    import json
    typer.echo(json.dumps(get_pool_status(), indent=2))
```

---

## 8. 步骤 12-13：Docker + Compose

### 8.1 `docker/Dockerfile.web`

```dockerfile
FROM python:3.11-slim AS base
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
COPY frontend/dist ./src/edagent_vivado/web/static

RUN pip install -e ".[postgres,redis,worker,mcp]"

ENV SYNTHIA_AUTH_TEST_MODE=0
ENV SYNTHIA_USE_WORKER_QUEUE=1
ENV EDAGENT_DISABLE_API_AUTH=0

EXPOSE 8484

CMD ["edagent", "web", "--host", "0.0.0.0", "--port", "8484"]
```

### 8.2 `docker/Dockerfile.worker`

```dockerfile
FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src

RUN pip install -e ".[postgres,redis,worker]"

ENV SYNTHIA_WORKER_POOL=vivado

CMD ["synthia-worker", "--pool", "vivado"]
```

> **重要**：这个镜像 **不包含 Vivado**。Worker 需要能 SSH 到一台真有 Vivado 的 Win/Linux 机器，或者 mount 一个本地 Vivado 安装。

### 8.3 `docker-compose.yml`

```yaml
version: "3.9"

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: synthia
      POSTGRES_PASSWORD: synthia
      POSTGRES_DB: synthia
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U synthia"]
      interval: 5s
      timeout: 3s
      retries: 5
    ports: ["5432:5432"]
  
  redis:
    image: redis:7
    command: redis-server --appendonly yes
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    ports: ["6379:6379"]
  
  web:
    build:
      context: .
      dockerfile: docker/Dockerfile.web
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      SYNTHIA_DB_URL: postgresql+psycopg://synthia:synthia@postgres:5432/synthia
      SYNTHIA_REDIS_URL: redis://redis:6379/0
      SYNTHIA_USE_WORKER_QUEUE: "1"
      SYNTHIA_LICENSE_POOLS: "vivado:2"
    ports: ["8484:8484"]
    volumes:
      - syndata:/root/.synthia
  
  worker-vivado:
    build:
      context: .
      dockerfile: docker/Dockerfile.worker
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      SYNTHIA_DB_URL: postgresql+psycopg://synthia:synthia@postgres:5432/synthia
      SYNTHIA_REDIS_URL: redis://redis:6379/0
      SYNTHIA_WORKER_POOL: vivado
      VIVADO_REMOTE_HOST: ${VIVADO_REMOTE_HOST:-}
      VIVADO_REMOTE_USER: ${VIVADO_REMOTE_USER:-}
    deploy:
      replicas: 2     # spawn 2 worker processes
    volumes:
      - syndata:/root/.synthia
      - ./ssh-keys:/root/.ssh:ro
  
  worker-default:
    build:
      context: .
      dockerfile: docker/Dockerfile.worker
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      SYNTHIA_DB_URL: postgresql+psycopg://synthia:synthia@postgres:5432/synthia
      SYNTHIA_REDIS_URL: redis://redis:6379/0
      SYNTHIA_WORKER_POOL: default

volumes:
  pgdata:
  redisdata:
  syndata:
```

### 8.4 启动

```bash
# Build images
docker compose build

# Start
docker compose up -d

# Apply migrations (first run only)
docker compose exec web edagent db migrate

# Check health
curl http://localhost:8484/health
```

---

## 9. 步骤 14：Health endpoints

**新建** `src/edagent_vivado/web/routes/health.py`：

```python
"""Health endpoints — Phase 11."""

from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
async def health():
    return {"ok": True}


@router.get("/health/full")
async def health_full():
    out = {"ok": True, "checks": {}}
    
    # DB
    try:
        from edagent_vivado.repository.db import get_db, get_backend
        conn = get_db()
        conn.execute("SELECT 1").fetchone()
        out["checks"]["db"] = {"ok": True, "backend": get_backend()}
    except Exception as e:
        out["ok"] = False
        out["checks"]["db"] = {"ok": False, "error": str(e)}
    
    # Redis
    try:
        from edagent_vivado.infra.redis_client import get_redis
        get_redis().ping()
        out["checks"]["redis"] = {"ok": True}
    except Exception as e:
        out["checks"]["redis"] = {"ok": False, "error": str(e)}
    
    # Worker queue depth
    try:
        from edagent_vivado.scheduler.scheduler import get_pool_status
        out["checks"]["pools"] = get_pool_status()
    except Exception as e:
        out["checks"]["pools"] = {"error": str(e)}
    
    return out


@router.get("/health/readiness")
async def readiness():
    """For k8s readiness probe — requires DB ready."""
    try:
        from edagent_vivado.repository.db import get_db
        get_db().execute("SELECT 1").fetchone()
        return {"ready": True}
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(503, str(e))
```

---

## 10. 步骤 15：docs/DEPLOYMENT.md

```markdown
# Synthia Deployment

## Modes

| Mode | Backend | Use case |
|------|---------|----------|
| **single-machine dev** | SQLite + in-process | One developer, no Docker |
| **single-machine prod** | PostgreSQL + Redis + 1 worker | Small team |
| **multi-machine** | Postgres + Redis + N workers | Production |

## Quick start (Docker)

```bash
git clone <repo>
cd edagent-vivado
docker compose up -d
docker compose exec web edagent db migrate
docker compose exec web edagent admin create-user alice --role project_owner
# copy printed token, paste into Synthia /login
```

## Configuration matrix

| Env var | Default | Purpose |
|---------|---------|---------|
| SYNTHIA_DB_BACKEND | sqlite | 'sqlite' or 'postgres' |
| SYNTHIA_DB_URL | sqlite path | postgresql+psycopg://user:pass@host/db |
| SYNTHIA_REDIS_URL | — (disabled) | redis://host:6379/0 |
| SYNTHIA_USE_WORKER_QUEUE | 0 | 1 to enable worker mode |
| SYNTHIA_LICENSE_POOLS | vivado:1 | "vivado:N,impl:M" |
| SYNTHIA_WORKER_POOL | vivado | worker's pool name |

## Backup

SQLite: `edagent db backup /path/to/backup.db`
Postgres: `pg_dump $SYNTHIA_DB_URL > backup.sql`

## Restore

SQLite: replace file.
Postgres: `psql $SYNTHIA_DB_URL < backup.sql`

## Migrating SQLite → Postgres

```bash
# 1. spin up postgres
docker compose up -d postgres

# 2. point Synthia at postgres
export SYNTHIA_DB_URL=postgresql+psycopg://synthia:synthia@localhost:5432/synthia

# 3. apply schema
edagent db migrate

# 4. dump SQLite data (manual ETL or pgloader recommended)
sqlite3 ~/.synthia/synthia.db .dump > /tmp/sqlite_dump.sql
# edit dump to remove AUTOINCREMENT etc, then:
psql $SYNTHIA_DB_URL < /tmp/sqlite_dump.sql
```

(For production, use a proper ETL like pgloader to handle type differences.)

## Scaling workers

```bash
docker compose up -d --scale worker-vivado=4
```

Synthia routes vivado runs into a license-aware queue; if `SYNTHIA_LICENSE_POOLS=vivado:2`,
at most 2 workers run synth at once even with 4 worker processes.

## Health probes (k8s)

- Liveness: `GET /health`  (200 = process alive)
- Readiness: `GET /health/readiness`  (200 only when DB connected)
- Full: `GET /health/full`  (DB + Redis + pool stats)

## Observability TODO

- structured JSON logs (Phase 11.5)
- Prometheus metrics endpoint (deferred)
- OpenTelemetry traces (deferred)
```

---

## 11. 测试

### 11.1 关键 cases

```python
# tests/test_queue.py
import pytest


pytestmark = pytest.mark.skipif(
    not __import__("os").environ.get("SYNTHIA_TEST_REDIS"),
    reason="set SYNTHIA_TEST_REDIS=1 to run (needs redis)",
)


def test_enqueue_dequeue_ack():
    from edagent_vivado.infra.queue import enqueue, dequeue, ack
    
    eid = enqueue("test_pool", {"foo": "bar"})
    assert eid
    
    tasks = dequeue("test_pool", consumer_name="t1", block_ms=1000)
    assert len(tasks) == 1
    e2, payload = tasks[0]
    assert payload["foo"] == "bar"
    
    ack("test_pool", e2)


def test_license_pool():
    from edagent_vivado.scheduler.license_pool import (
        init_pool, acquire_license, release_license, pool_status,
    )
    
    init_pool("test_lic", 2)
    
    h1 = acquire_license("test_lic")
    h2 = acquire_license("test_lic")
    h3 = acquire_license("test_lic", wait_s=0)
    
    assert h1 and h2
    assert h3 is None  # capacity reached
    
    st = pool_status("test_lic")
    assert st["used"] == 2 and st["capacity"] == 2
    
    release_license("test_lic", h1)
    h4 = acquire_license("test_lic")
    assert h4
    
    release_license("test_lic", h2)
    release_license("test_lic", h4)


def test_distributed_lock():
    import threading
    from edagent_vivado.infra.distributed_lock import acquire_lock, LockNotAcquired
    
    inside = []
    
    def t1():
        with acquire_lock("test_lock", timeout_ms=2000, wait_ms=500):
            inside.append("t1")
            import time; time.sleep(0.3)
    
    def t2():
        try:
            with acquire_lock("test_lock", timeout_ms=2000, wait_ms=100):
                inside.append("t2_got_lock")
        except LockNotAcquired:
            inside.append("t2_no_lock")
    
    threads = [threading.Thread(target=t1)]
    threads[0].start()
    import time; time.sleep(0.05)
    threads.append(threading.Thread(target=t2))
    threads[1].start()
    for t in threads: t.join()
    
    assert "t1" in inside
    # t2 either gets denied (no_lock) or eventually acquires (got_lock) — both legal
```

```python
# tests/test_db_abstraction.py
def test_sqlite_backward_compat(tmp_path, monkeypatch):
    monkeypatch.delenv("SYNTHIA_DB_BACKEND", raising=False)
    monkeypatch.delenv("SYNTHIA_DB_URL", raising=False)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "t.db"))
    
    from edagent_vivado.repository import db as _db
    _db._sqlite_conn = None
    _db._local_conn = None
    
    conn = _db.get_db()
    conn.execute("CREATE TABLE IF NOT EXISTS t (id TEXT)")
    conn.execute("INSERT INTO t (id) VALUES (?)", ("hello",))
    row = conn.execute("SELECT id FROM t WHERE id = ?", ("hello",)).fetchone()
    assert row["id"] == "hello"
```

### 11.2 commit

```bash
git add -A
git commit -m "Phase 11: PostgreSQL + Redis + worker queue + Docker

DB:
- repository/db.py: sqlite + postgres backends, ? → :p_N translation
- repository/migrations/: framework + migration_001_base + history table
- CLI: edagent db migrate/status/backup

Redis infrastructure:
- infra/redis_client.py: singleton + availability check
- infra/queue.py: Redis stream task queue (enqueue/dequeue/ack)
- infra/distributed_lock.py: NX SET + Lua release

Scheduler:
- scheduler/license_pool.py: Redis-backed semaphore with stale-cleanup
- scheduler/scheduler.py: flow→pool routing, submit_run

Worker:
- workers/worker.py: dequeue loop, license acquire, SIGTERM graceful shutdown
- CLI: edagent worker run/status

Orchestrator:
- runs/orchestrator.start_run_serial: routes through worker queue when SYNTHIA_USE_WORKER_QUEUE=1

Web:
- web/routes/health.py: /health (liveness) + /health/readiness + /health/full

Docker:
- docker/Dockerfile.web + Dockerfile.worker
- docker-compose.yml: web + workers + postgres + redis

Docs:
- docs/DEPLOYMENT.md: modes, env matrix, scaling, sqlite→postgres migration

Tests (gated on SYNTHIA_TEST_REDIS env):
- test_queue.py: enqueue/dequeue/ack + license pool + distributed lock
- test_db_abstraction.py: sqlite backward compat
"
```

---

## 12. 附录

### 12.1 常见坑

**A. SQLite → Postgres SQL 差异**
- `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY` + 拿 `RETURNING id`
- `INSERT OR REPLACE` → `INSERT ... ON CONFLICT DO UPDATE`
- `?` 占位符 → 已经在 wrapper 翻译
- `IS NULL` / `= NULL` 行为相同；但 `''` vs `NULL` 不同（注意默认值）
- 时间戳：SQLite 用 INTEGER，Postgres 也用 BIGINT，没问题。**不要** 用 `TIMESTAMP`，搞乱时区

**B. Worker 与 Web 共享代码 = 共享 bug**
两者都加载 `edagent_vivado` 同一份代码。Web 改了某个共享函数（如 `run_update`），worker 行为也跟着变。pytest 必须覆盖两边视角。

**C. Redis pub/sub vs streams**
v1 用 streams（持久 + consumer group）。SSE 实时推送可以再用 pub/sub 做跨进程 fanout —— `web` 进程发 event 到 Redis pub/sub，所有 `web` instance subscribe。但 SSE 流量小，先用现有 DB-backed 方案。

**D. License pool race**
`acquire_license` 用 `WATCH/MULTI` 乐观锁。极端情况两 worker 同时 check `current<cap` 都通过，第二个 EXEC 会失败重试。压力测下要监控 retry rate。

**E. Worker 不重启 = bug 不修**
Docker worker 改代码需要 `docker compose up -d --build worker-vivado`。生产建议加 watchtower 自动重启，但要避免长 run 期间 worker 被 kill。Phase 11.5 加 "graceful drain" 模式：worker 收 SIGTERM 后处理完当前任务再退。

**F. Postgres connection pool 撑爆**
默认 pool_size=10，max_overflow=5 → 15 conn 上限。如果 worker 多 + web 多，可能撑爆。监控 `pg_stat_activity`，必要时调大 `SYNTHIA_DB_POOL_SIZE`。

**G. 数据迁移工具**
SQLite → Postgres 不能简单 `pg_restore < sqlite_dump.sql`：
- AUTOINCREMENT 不识别
- 数据类型映射不完美
- 推荐 `pgloader sqlite:///path/to/synthia.db postgresql://...` 一键迁移

**H. ssh-keys 挂进 worker**
Worker 需 SSH 到 Vivado 机器。`./ssh-keys:/root/.ssh:ro` mount 是简化做法；生产用 secret manager 或 k8s secret。

**I. WAL 持久化 vs Redis 数据丢失**
`appendonly yes` + `appendfsync everysec` 在 crash 时可能丢最近 1s 的 queue。对长任务 OK（worker 重启重新 dequeue），但用户体验差 1 秒延迟也无所谓。

**J. Health endpoint 不应该需要 auth**
`/health` 是 k8s probe / load balancer 用的；必须放进 `_PUBLIC_EXACT`（已经在 Phase 8 auth 配好）。

### 12.2 耗时

| 步骤 | 估时 |
|------|------|
| 1 依赖 | 0.25d |
| 2-3 DB abstraction + migrations | 3d |
| 4-6 Redis infra (queue/lock) | 2d |
| 7-8 license + scheduler | 1.5d |
| 9-10 worker + orchestrator | 1.5d |
| 11 CLI | 0.5d |
| 12-13 Docker + compose | 1d |
| 14 health | 0.25d |
| 15 docs | 0.5d |
| 16 测试 | 1.5d |

**总计：** 全职 12 天；vibe coding 4-5 周。

### 12.3 Phase 12 衔接

Phase 11 提供「可部署的多 worker 集群」。Phase 12（硬件烧录）会增加一种新 worker pool `hardware-burner`：物理连接 FPGA 板子的机器跑 Hardware Manager。pool config 加 `SYNTHIA_LICENSE_POOLS=vivado:2,hardware:1`，调度器自动路由。

Phase 11 完工后用户应该能：
- ✅ `docker compose up` 一键起整个栈
- ✅ 切到 Postgres 后多 web 进程跨进程共享状态
- ✅ N 个 worker 并发跑，但 license 受 pool 限制
- ✅ worker 重启后 inflight task 自动 requeue（XPENDING 处理）
- ✅ k8s 部署有合理的 liveness / readiness probe
- ✅ SQLite 模式 (dev) 完全兼容
