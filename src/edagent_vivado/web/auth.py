"""API authentication — Phase 8 RBAC-aware."""

from __future__ import annotations

import logging
import os
import secrets
from collections.abc import Awaitable, Callable
from pathlib import Path

from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

from edagent_vivado.auth.identity import Identity, User, load_identity

logger = logging.getLogger(__name__)

_TOKEN: str | None = None
_TOKEN_FILE = Path.home() / ".synthia" / "token"

_PUBLIC_PREFIXES = ("/health", "/static", "/assets", "/favicon")
_PUBLIC_EXACT = {"/", "/manifest.json"}


def _truthy(val: str | None) -> bool:
    return (val or "").strip().lower() in ("1", "true", "yes", "on")


def auth_enabled() -> bool:
    if _truthy(os.environ.get("EDAGENT_DISABLE_API_AUTH")):
        return False
    if _truthy(os.environ.get("SYNTHIA_AUTH_TEST_MODE")):
        return False
    return True


def reset_token_cache() -> None:
    global _TOKEN
    _TOKEN = None


def ensure_token() -> str:
    """Legacy single-token file (kept for dev bootstrap / migration)."""
    global _TOKEN
    if _TOKEN:
        return _TOKEN
    env_tok = os.environ.get("SYNTHIA_API_TOKEN", "").strip()
    if env_tok:
        _TOKEN = env_tok
        return _TOKEN
    if _TOKEN_FILE.exists():
        _TOKEN = _TOKEN_FILE.read_text(encoding="utf-8").strip()
        if _TOKEN:
            return _TOKEN
    _TOKEN = secrets.token_urlsafe(32)
    _TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    _TOKEN_FILE.write_text(_TOKEN, encoding="utf-8")
    try:
        os.chmod(_TOKEN_FILE, 0o600)
    except OSError:
        pass
    return _TOKEN


def legacy_token_matches(token: str) -> bool:
    if not token:
        return False
    try:
        expected = ensure_token()
        return secrets.compare_digest(token, expected)
    except Exception:
        return False


def is_public_path(path: str) -> bool:
    if path in _PUBLIC_EXACT:
        return True
    if path in ("/api/health", "/health"):
        return True
    for prefix in _PUBLIC_PREFIXES:
        if path.startswith(prefix):
            return True
    if path.startswith("/assets/") or not path.startswith("/api/"):
        return True
    return False


def extract_token(request: Request) -> str:
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.query_params.get("token", "")


def anonymous_admin_identity() -> Identity:
    return Identity(
        user=User(id="anonymous", username="anonymous", global_role="admin"),
        project_roles={},
    )


class IdentityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        if is_public_path(request.url.path):
            return await call_next(request)

        if not auth_enabled():
            request.state.identity = anonymous_admin_identity()
            return await call_next(request)

        token = extract_token(request)
        if not token:
            return JSONResponse({"detail": "auth: token required"}, status_code=401)

        identity = load_identity(token)
        if identity is None:
            return JSONResponse({"detail": "auth: invalid token"}, status_code=401)
        if not identity.user.is_active:
            return JSONResponse({"detail": "auth: user inactive"}, status_code=403)

        request.state.identity = identity
        return await call_next(request)


def require_token(request: Request) -> None:
    """Backward-compatible helper for code still calling require_token."""
    if not auth_enabled() or is_public_path(request.url.path):
        return
    token = extract_token(request)
    if load_identity(token) is None:
        raise HTTPException(status_code=401, detail="invalid or missing token")
