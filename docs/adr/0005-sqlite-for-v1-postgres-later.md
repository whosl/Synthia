# ADR-0005: SQLite for v1.0, PostgreSQL target later

- **Status:** Accepted
- **Date:** 2026-05-26

## Context

The repository uses hand-written SQLite in `repository/db.py` with a rich schema (projects, runs, events, evolution, etc.). Enterprise deploys need PostgreSQL, Redis, and workers, but migration should not block product milestones.

## Decision

- **v1.0:** keep SQLite as default dev/single-user store; complete CRUD and migrations informally via schema version in code.
- **v1.1+:** introduce SQLAlchemy 2.0 models + Alembic; dual-write or migrate scripts.
- **v1.2+:** PostgreSQL default for production; SQLite for tests/local only.
- Design new tables with `organization_id` / RBAC columns even if unused in v1.0 UI.

## Consequences

### Positive

- No big-bang DB migration during Phase 0–5.
- Existing tests and web API keep working.

### Negative

- Concurrent writers and multi-process workers need care until PG lands (`futureWork.md` §2.1).

### Follow-ups

- Phase 12 deployment handbook.
- Alembic baseline from current `db.py` DDL.

## References

- `repository/db.py`, `repository/store.py`
- `SynthiaUpdate/update.md` Phase 12
