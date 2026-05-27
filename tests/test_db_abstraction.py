"""Phase 11 — sqlite backward compatibility."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _reset_db_conn():
    yield
    from edagent_vivado.repository import connection as conn_mod
    from edagent_vivado.repository import db as db_mod

    db_mod.close_db()
    conn_mod.close_connection()


def test_sqlite_backward_compat(tmp_path, monkeypatch):
    monkeypatch.delenv("SYNTHIA_DB_BACKEND", raising=False)
    monkeypatch.delenv("SYNTHIA_DB_URL", raising=False)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))

    from edagent_vivado.repository import db as db_mod

    db_mod.close_db()
    conn = db_mod.get_db()
    conn.execute("CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY)")
    conn.execute("INSERT INTO t (id) VALUES (?)", ("hello",))
    conn.commit()
    row = conn.execute("SELECT id FROM t WHERE id = ?", ("hello",)).fetchone()
    assert row["id"] == "hello"
    assert db_mod.get_backend() == "sqlite"
