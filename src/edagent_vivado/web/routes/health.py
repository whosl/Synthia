"""Health endpoints — Phase 11."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

router = APIRouter(tags=["health"])


@router.get("/health")
async def health():
    return {"ok": True}


@router.get("/health/full")
async def health_full():
    out: dict = {"ok": True, "checks": {}}
    try:
        from edagent_vivado.repository.db import get_backend, get_db

        conn = get_db()
        conn.execute("SELECT 1").fetchone()
        out["checks"]["db"] = {"ok": True, "backend": get_backend()}
    except Exception as exc:
        out["ok"] = False
        out["checks"]["db"] = {"ok": False, "error": str(exc)}

    try:
        from edagent_vivado.infra.redis_client import redis_available

        if redis_available():
            from edagent_vivado.infra.redis_client import get_redis

            get_redis().ping()
            out["checks"]["redis"] = {"ok": True}
        else:
            out["checks"]["redis"] = {"ok": False, "error": "not configured"}
    except Exception as exc:
        out["checks"]["redis"] = {"ok": False, "error": str(exc)}

    try:
        from edagent_vivado.scheduler.scheduler import get_pool_status

        out["checks"]["pools"] = get_pool_status()
    except Exception as exc:
        out["checks"]["pools"] = {"error": str(exc)}

    return out


@router.get("/health/readiness")
async def readiness():
    try:
        from edagent_vivado.repository.db import get_db

        get_db().execute("SELECT 1").fetchone()
        return {"ready": True}
    except Exception as exc:
        raise HTTPException(503, str(exc)) from exc
