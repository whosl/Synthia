"""Industrial Tool Connector Layer — SPEC §9B."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)
_registered = False


def register_builtin_connectors() -> None:
    """Register built-in connectors (idempotent)."""
    global _registered
    from edagent_vivado.connectors.base.registry import get_connector

    if _registered and get_connector("vivado"):
        return
    _registered = True
    try:
        from edagent_vivado.connectors.vivado.connector import register as _vivado_register

        _vivado_register()
    except Exception as exc:
        logger.warning("Vivado connector registration failed: %s", exc)
    try:
        from edagent_vivado.connectors.verilator.connector import register as _verilator_register

        _verilator_register()
    except Exception as exc:
        logger.warning("Verilator connector registration failed: %s", exc)


def ensure_connectors() -> None:
    register_builtin_connectors()
