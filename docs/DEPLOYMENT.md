# Synthia Deployment

## Modes

| Mode | Backend | Use case |
|------|---------|----------|
| **single-machine dev** | SQLite + in-process | One developer, no Docker |
| **single-machine prod** | PostgreSQL + Redis + workers | Small team |
| **multi-machine** | Postgres + Redis + N workers | Production |

## Quick start (Docker)

```bash
docker compose build
docker compose up -d
docker compose exec web edagent db migrate
docker compose exec web edagent admin create-user alice --role project_owner
```

Open http://localhost:8484 and sign in with the printed API token.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `SYNTHIA_DB_BACKEND` | sqlite | `sqlite` or `postgres` |
| `SYNTHIA_DB_URL` | — | `postgresql+psycopg://user:pass@host/db` |
| `SYNTHIA_REDIS_URL` | — | `redis://host:6379/0` |
| `SYNTHIA_USE_WORKER_QUEUE` | 0 | `1` to enqueue runs for workers |
| `SYNTHIA_QUEUE_BACKEND` | redis | `memory` for in-process queue (tests) |
| `SYNTHIA_LICENSE_POOLS` | vivado:1 | `vivado:N,impl:M` |
| `SYNTHIA_LICENSE_BACKEND` | redis | `local` for in-process license slots |
| `SYNTHIA_WORKER_POOL` | vivado | Worker's queue pool name |

## Worker queue (dev without Redis)

For unit tests or local queue experiments:

```bash
export SYNTHIA_USE_WORKER_QUEUE=1
export SYNTHIA_QUEUE_BACKEND=memory
export SYNTHIA_LICENSE_BACKEND=local
edagent worker run --pool vivado
```

## Health probes

- Liveness: `GET /health`
- Readiness: `GET /health/readiness`
- Full: `GET /health/full`

## Backup

```bash
edagent db backup ./backup.db    # SQLite only
pg_dump $SYNTHIA_DB_URL > backup.sql   # Postgres
```

## Scaling workers

```bash
docker compose up -d --scale worker-vivado=4
```

With `SYNTHIA_LICENSE_POOLS=vivado:2`, at most two concurrent Vivado runs execute even with four worker processes.
