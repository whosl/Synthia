"""Initial schema marker — delegates to init_db for sqlite."""

from __future__ import annotations

from edagent_vivado.repository.connection import get_backend


def apply(conn) -> None:
    if get_backend() == "postgres":
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS migration_history (
                name TEXT PRIMARY KEY,
                applied_at BIGINT NOT NULL
            )
            """
        )
        conn.commit()
        from edagent_vivado.repository import db as db_mod

        db_mod.init_db()
        return

    from edagent_vivado.repository import db as db_mod

    db_mod.init_db()
