"""Phase 11 — SQL dialect translation for Postgres backend."""

from __future__ import annotations

from edagent_vivado.repository.sql_dialect import split_sql_script, translate_sqlite_to_postgres


def test_split_sql_script_ignores_semicolons_in_strings():
    script = "CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('a;b');"
    parts = split_sql_script(script)
    assert len(parts) == 2
    assert "CREATE TABLE" in parts[0]
    assert "a;b" in parts[1]


def test_translate_autoincrement():
    sql = "CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT);"
    out = translate_sqlite_to_postgres(sql)
    assert "BIGSERIAL" in out
    assert "AUTOINCREMENT" not in out
