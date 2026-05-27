"""Migration framework — Phase 11."""

from __future__ import annotations

import importlib
import logging
import pkgutil
import time

logger = logging.getLogger(__name__)


def list_migrations() -> list[str]:
    import edagent_vivado.repository.migrations as pkg

    mods = [info.name for info in pkgutil.iter_modules(pkg.__path__) if info.name.startswith("migration_")]
    return sorted(mods)


def applied_migrations(conn) -> set[str]:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS migration_history (
            name TEXT PRIMARY KEY,
            applied_at BIGINT NOT NULL
        )
        """
    )
    conn.commit()
    rows = conn.execute("SELECT name FROM migration_history").fetchall()
    return {r["name"] if isinstance(r, dict) else r[0] for r in rows}


def apply_pending(conn) -> list[str]:
    done = applied_migrations(conn)
    applied: list[str] = []
    for name in list_migrations():
        if name in done:
            continue
        logger.info("applying migration %s", name)
        mod = importlib.import_module(f"edagent_vivado.repository.migrations.{name}")
        if not hasattr(mod, "apply"):
            logger.warning("migration %s has no apply()", name)
            continue
        mod.apply(conn)
        conn.execute(
            "INSERT INTO migration_history (name, applied_at) VALUES (?, ?)",
            (name, int(time.time() * 1000)),
        )
        conn.commit()
        applied.append(name)
    return applied
