"""FastAPI app — terminal-style chat frontend + EdAgent API."""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from edagent_vivado.web.auth import auth_enabled, ensure_token, is_public_path, require_token

_log = logging.getLogger(__name__)


class _TokenMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if not auth_enabled() or is_public_path(request.url.path):
            return await call_next(request)
        try:
            require_token(request)
        except HTTPException as exc:
            return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
        return await call_next(request)


def create_app() -> FastAPI:
    app = FastAPI(title="Synthia", version="0.3.0")
    _origins = os.environ.get(
        "SYNTHIA_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8484,http://127.0.0.1:8484",
    ).split(",")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in _origins if o.strip()],
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=False,
    )
    app.add_middleware(_TokenMiddleware)
    if auth_enabled():
        tok = ensure_token()
        _log.info("Synthia API token ready (len=%d). See ~/.synthia/token", len(tok))

    @app.on_event("startup")
    async def _recover_orphaned_agent_tasks() -> None:
        import asyncio
        import logging

        async def _delayed() -> None:
            await asyncio.sleep(3)
            try:
                from edagent_vivado.harness.task_resume import recover_all_orphaned_tasks

                recovered = await recover_all_orphaned_tasks()
                if recovered:
                    logging.getLogger(__name__).info("Recovered orphaned tasks: %s", recovered)
            except Exception:
                logging.getLogger(__name__).exception("orphan task recovery failed")

        asyncio.create_task(_delayed())

    # Phase 1 v1 API
    from edagent_vivado.web.api_v1 import router as api_v1_router
    from edagent_vivado.integrations.workbuddy import router as workbuddy_router

    app.include_router(api_v1_router)
    app.include_router(workbuddy_router, prefix="/api/v1")

    # React SPA — must come before legacy HTML routes
    from fastapi.responses import FileResponse as FR, HTMLResponse

    static_dir = Path(__file__).parent / "static"
    if static_dir.exists() and (static_dir / "index.html").exists():
        assets = static_dir / "assets"
        if assets.exists():
            app.mount("/assets", StaticFiles(directory=str(assets)), name="react_assets")

        # Explicit React SPA routes (override legacy HTML pages)
        @app.get("/")
        async def react_root():
            return HTMLResponse((static_dir / "index.html").read_text(encoding="utf-8"))

        @app.get("/term")
        async def react_term():
            return HTMLResponse((static_dir / "index.html").read_text(encoding="utf-8"))

        @app.get("/{full_path:path}")
        async def spa_fallback(full_path: str = ""):
            if full_path.startswith("api/"):
                raise HTTPException(404)
            if full_path:
                try:
                    fp = (static_dir / full_path).resolve()
                    fp.relative_to(static_dir.resolve())
                except ValueError:
                    raise HTTPException(404, detail="not found") from None
                if fp.is_file():
                    return FR(str(fp))
            return HTMLResponse((static_dir / "index.html").read_text(encoding="utf-8"))

    # Legacy API only — no HTML routes (React SPA handles those)
    from edagent_vivado.web.terminal import router as term_router
    app.include_router(term_router)

    from edagent_vivado.web.dashboard import router as dash_router
    app.include_router(dash_router)

    return app
