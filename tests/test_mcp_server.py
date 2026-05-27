"""Phase 9 — MCP server tool registry tests."""

from __future__ import annotations

import pytest

pytest.importorskip("mcp")

EXPECTED_TOOLS = {
    "synthia_list_projects",
    "synthia_get_project",
    "synthia_import_xpr",
    "synthia_scan_project",
    "synthia_run_synthesis",
    "synthia_run_implementation",
    "synthia_generate_bitstream",
    "synthia_get_run",
    "synthia_cancel_run",
    "synthia_get_reports",
    "synthia_get_artifacts",
    "synthia_get_run_summary",
    "synthia_get_project_trend",
    "synthia_request_patch",
    "synthia_get_patch",
    "synthia_approve_patch",
    "synthia_reject_patch",
    "synthia_diagnose_log",
    "synthia_create_benchmark_suite",
    "synthia_run_benchmark_suite",
    "synthia_get_benchmark_suite",
    "synthia_export_benchmark_markdown",
}


def _tool_names(mcp) -> set[str]:
    tm = getattr(mcp, "_tool_manager", None)
    if tm is not None and hasattr(tm, "_tools"):
        return set(tm._tools.keys())
    if hasattr(mcp, "_tools"):
        return set(mcp._tools.keys())
    return set()


def test_all_tools_registered(monkeypatch):
    monkeypatch.setenv("SYNTHIA_MCP_TOKEN", "fake-token")
    from edagent_vivado.mcp.config import McpConfig
    from edagent_vivado.mcp.server import build_server

    cfg = McpConfig.from_env()
    mcp = build_server(cfg)
    tool_names = _tool_names(mcp)
    missing = EXPECTED_TOOLS - tool_names
    assert not missing, f"missing tools: {missing} (have {tool_names})"


def test_config_requires_token(monkeypatch):
    monkeypatch.delenv("SYNTHIA_MCP_TOKEN", raising=False)
    monkeypatch.delenv("SYNTHIA_API_TOKEN", raising=False)
    from edagent_vivado.mcp.config import McpConfig

    with pytest.raises(RuntimeError, match="TOKEN"):
        McpConfig.from_env()
