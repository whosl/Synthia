"""FastAPI app — terminal-style chat frontend + EdAgent API."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse


def create_app() -> FastAPI:
    app = FastAPI(title="EdAgent-Vivado Terminal", version="0.2.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    from edagent_vivado.web.terminal import router as term_router
    app.include_router(term_router)

    from edagent_vivado.web.dashboard import router as dash_router
    app.include_router(dash_router)

    @app.get("/")
    async def root():
        return RedirectResponse("/term")

    return app
