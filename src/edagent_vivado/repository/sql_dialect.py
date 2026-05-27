"""SQLite → PostgreSQL DDL/DML helpers for ConnectionWrapper (Phase 11)."""

from __future__ import annotations

import re


def split_sql_script(script: str) -> list[str]:
    """Split a SQL script into individual statements (semicolon outside quotes)."""
    parts: list[str] = []
    buf: list[str] = []
    in_single = False
    in_double = False
    i = 0
    while i < len(script):
        ch = script[i]
        if ch == "'" and not in_double:
            in_single = not in_single
            buf.append(ch)
        elif ch == '"' and not in_single:
            in_double = not in_double
            buf.append(ch)
        elif ch == ";" and not in_single and not in_double:
            stmt = "".join(buf).strip()
            if stmt:
                parts.append(stmt)
            buf = []
        else:
            buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        parts.append(tail)
    return parts


def translate_sqlite_to_postgres(sql: str) -> str:
    """Best-effort translation of SQLite DDL/DML for init_db migrations."""
    out = sql
    out = re.sub(
        r"\bid\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b",
        "id BIGSERIAL PRIMARY KEY",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(r"\bINTEGER\s+PRIMARY\s+KEY\b", "BIGINT PRIMARY KEY", out, flags=re.IGNORECASE)
    out = re.sub(r"\bREAL\b", "DOUBLE PRECISION", out, flags=re.IGNORECASE)
    out = re.sub(
        r"INSERT\s+OR\s+REPLACE\s+INTO",
        "INSERT INTO",
        out,
        flags=re.IGNORECASE,
    )
    # project_members upsert (composite PK)
    if re.search(r"INSERT\s+INTO\s+project_members\b", out, re.IGNORECASE) and "ON CONFLICT" not in out.upper():
        out = re.sub(
            r"(INSERT\s+INTO\s+project_members\s*\([^)]+\)\s*VALUES\s*\([^)]+\))\s*;?\s*$",
            r"\1 ON CONFLICT (project_id, user_id) DO UPDATE SET "
            r"role_name = EXCLUDED.role_name, added_by = EXCLUDED.added_by, added_at = EXCLUDED.added_at",
            out,
            flags=re.IGNORECASE | re.DOTALL,
        )
    return out
