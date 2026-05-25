"""Runtime flag for Vivado execution auto-approval — persisted in the settings table."""

from __future__ import annotations

_KEY = "vivado_execution_auto_approve"
_cache: dict[str, bool] = {}


def _load() -> bool:
    if _KEY in _cache:
        return _cache[_KEY]
    try:
        from edagent_vivado.repository.store import settings_get

        val = bool(settings_get(_KEY, False))
    except Exception:
        val = False
    _cache[_KEY] = val
    return val


def set_vivado_execution_approval(granted: bool) -> None:
    _cache[_KEY] = bool(granted)
    try:
        from edagent_vivado.repository.store import settings_set

        settings_set(_KEY, bool(granted))
    except Exception:
        pass


def is_vivado_execution_approved() -> bool:
    return _load()
