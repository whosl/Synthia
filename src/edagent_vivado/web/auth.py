"""API token authentication — Synthia (Phase 0 → Phase 5.5 hardened).

Phase 5.5 changes:
- Drop the implicit ``PYTEST_CURRENT_TEST`` test-mode bypass that hid auth
  bugs from CI and from local pytest runs.
- Replace it with an explicit, opt-in ``SYNTHIA_AUTH_TEST_MODE`` env switch
  driven by ``tests/conftest.py``; the production server can no longer be
  put into "no-auth" mode by accident.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

from fastapi import HTTPException, Request

_TOKEN: str | None = None
_TOKEN_FILE = Path.home() / ".synthia" / "token"


def _truthy(val: str | None) -> bool:
    return (val or "").strip().lower() in ("1", "true", "yes", "on")


def auth_enabled() -> bool:
    """Return False only when an *explicit* opt-out env var is set.

    - ``EDAGENT_DISABLE_API_AUTH=1``    : long-lived production opt-out.
    - ``SYNTHIA_AUTH_TEST_MODE=1``      : pytest-only short-lived opt-out
      (set autouse from ``tests/conftest.py``).

    The legacy ``PYTEST_CURRENT_TEST`` heuristic was removed — accidentally
    importing pytest at runtime no longer disables auth.
    """
    if _truthy(os.environ.get("EDAGENT_DISABLE_API_AUTH")):
        return False
    if _truthy(os.environ.get("SYNTHIA_AUTH_TEST_MODE")):
        return False
    return True


def reset_token_cache() -> None:
    """Drop the module-level token cache. Test-only helper."""
    global _TOKEN
    _TOKEN = None


def ensure_token() -> str:
    """Load token from env, then from ~/.synthia/token; generate if missing."""
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


def require_token(request: Request) -> None:
    """Validate Authorization header or ?token= query param."""
    expected = ensure_token()
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        provided = auth[7:].strip()
    else:
        provided = request.query_params.get("token", "")
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="invalid or missing token")


def is_public_path(path: str) -> bool:
    """Paths that bypass token check."""
    if path in ("/api/health", "/health"):
        return True
    if path.startswith("/assets/") or not path.startswith("/api/"):
        return True
    return False
