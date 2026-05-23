"""FastAPI app — terminal-style chat frontend + EdAgent API."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles


def create_app() -> FastAPI:
    app = FastAPI(title="Synthia", version="0.3.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    # Phase 1 v1 API
    from edagent_vivado.web.api_v1 import router as api_v1_router
    app.include_router(api_v1_router)

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
            fp = static_dir / full_path
            if full_path and fp.is_file():
                return FR(str(fp))
            return HTMLResponse((static_dir / "index.html").read_text(encoding="utf-8"))

    # Legacy API only — no HTML routes (React SPA handles those)
    from edagent_vivado.web.terminal import router as term_router
    app.include_router(term_router)

    from edagent_vivado.web.dashboard import router as dash_router
    app.include_router(dash_router)

    return app
