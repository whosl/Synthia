"""DB connection abstraction — Phase 11 (sqlite default, optional postgres)."""

from __future__ import annotations

import logging
import os
import re
import sqlite3
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_local = threading.local()
_engine = None
_sqlite_path: str | None = None


def get_backend() -> str:
    backend = os.environ.get("SYNTHIA_DB_BACKEND", "").lower()
    if backend in ("sqlite", "postgres"):
        return backend
    if os.environ.get("SYNTHIA_DB_URL", "").startswith("postgresql"):
        return "postgres"
    return "sqlite"


def _sqlite_db_path() -> str:
    global _sqlite_path
    if _sqlite_path:
        return _sqlite_path
    explicit = os.environ.get("EDAGENT_DB_PATH", "")
    if explicit:
        _sqlite_path = explicit
    else:
        runtime = Path(os.environ.get("EDAGENT_RUNTIME_DIR", ".edagent"))
        runtime.mkdir(exist_ok=True)
        _sqlite_path = str(runtime / "edagent.db")
    Path(_sqlite_path).parent.mkdir(parents=True, exist_ok=True)
    return _sqlite_path


def _build_postgres_engine():
    global _engine
    if _engine is not None:
        return _engine
    from sqlalchemy import create_engine

    url = os.environ.get(
        "SYNTHIA_DB_URL",
        "postgresql+psycopg://synthia:synthia@localhost:5432/synthia",
    )
    _engine = create_engine(
        url,
        pool_size=int(os.environ.get("SYNTHIA_DB_POOL_SIZE", "10")),
        max_overflow=int(os.environ.get("SYNTHIA_DB_POOL_OVERFLOW", "5")),
        pool_pre_ping=True,
        future=True,
    )
    return _engine


class _SqliteCursor:
    def __init__(self, cur: sqlite3.Cursor):
        self._cur = cur

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    @property
    def rowcount(self) -> int:
        return self._cur.rowcount

    @property
    def lastrowid(self) -> int | None:
        return self._cur.lastrowid


class _RowDict(dict):
    def __init__(self, mapping: dict):
        super().__init__(mapping)
        self._values = list(mapping.values())

    def __getitem__(self, k):  # type: ignore[override]
        if isinstance(k, int):
            return self._values[k]
        return super().__getitem__(k)


class _PgCursor:
    def __init__(self, result):
        self._result = result

    def fetchone(self):
        row = self._result.fetchone()
        return _RowDict(dict(row._mapping)) if row else None

    def fetchall(self):
        return [_RowDict(dict(r._mapping)) for r in self._result.fetchall()]

    @property
    def rowcount(self) -> int:
        return self._result.rowcount

    @property
    def lastrowid(self) -> None:
        return None


class ConnectionWrapper:
    """Unified execute/commit surface for sqlite and postgres."""

    def __init__(self) -> None:
        self._backend = get_backend()
        if self._backend == "postgres":
            from sqlalchemy import text

            self._sql_text = text
            self._engine = _build_postgres_engine()
            self._conn = self._engine.connect()
        else:
            path = _sqlite_db_path()
            self._conn = sqlite3.connect(path, check_same_thread=False, timeout=30.0)
            self._conn.row_factory = sqlite3.Row
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.execute("PRAGMA journal_mode=WAL")

    def execute(self, sql: str, params: tuple | list | dict | None = None) -> _SqliteCursor | _PgCursor:
        if self._backend == "postgres":
            from sqlalchemy import text

            named_params: dict[str, Any] = {}
            i = 0

            def _repl(_m: re.Match[str]) -> str:
                nonlocal i
                key = f"p_{i}"
                i += 1
                return f":{key}"

            sql2 = re.sub(r"\?", _repl, sql)
            if isinstance(params, (tuple, list)):
                named_params = {f"p_{j}": v for j, v in enumerate(params)}
            elif isinstance(params, dict):
                named_params = params
            result = self._conn.execute(text(sql2), named_params or {})
            return _PgCursor(result)
        cur = self._conn.execute(sql, params or ())
        return _SqliteCursor(cur)

    def commit(self) -> None:
        if self._backend == "postgres":
            self._conn.commit()

    def executescript(self, script: str) -> None:
        """Run a multi-statement SQL script (init_db / migrations)."""
        from edagent_vivado.repository.sql_dialect import split_sql_script, translate_sqlite_to_postgres

        for stmt in split_sql_script(script):
            sql = translate_sqlite_to_postgres(stmt) if self._backend == "postgres" else stmt
            self.execute(sql)
        if self._backend == "postgres":
            self.commit()

    def close(self) -> None:
        if self._backend == "postgres":
            self._conn.close()


def get_connection() -> ConnectionWrapper | sqlite3.Connection:
    """Return active DB connection (wrapper for postgres, raw sqlite for default)."""
    if get_backend() == "postgres":
        if not hasattr(_local, "conn") or _local.conn is None:
            _local.conn = ConnectionWrapper()
        return _local.conn

    if not hasattr(_local, "conn") or _local.conn is None:
        path = _sqlite_db_path()
        _local.conn = sqlite3.connect(path, check_same_thread=False, timeout=30.0)
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute("PRAGMA foreign_keys=ON")
        _local.conn.execute("PRAGMA journal_mode=WAL")
    return _local.conn


def close_connection() -> None:
    if hasattr(_local, "conn") and _local.conn is not None:
        try:
            _local.conn.close()
        except Exception:
            pass
        _local.conn = None
