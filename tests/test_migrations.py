"""Phase 11 — migration framework."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _reset_db_conn():
    yield
    from edagent_vivado.repository import connection as conn_mod
    from edagent_vivado.repository import db as db_mod

    db_mod.close_db()
    conn_mod.close_connection()


def test_migrations_apply(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "m.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))

    from edagent_vivado.repository import db as db_mod
    from edagent_vivado.repository.migrations import apply_pending, list_migrations

    db_mod.close_db()
    db_mod.init_db()
    conn = db_mod.get_db()
    applied = apply_pending(conn)
    assert "migration_001_initial" in applied or "migration_001_initial" in list_migrations()
