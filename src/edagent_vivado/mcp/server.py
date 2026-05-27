"""Synthia MCP Server — Phase 9."""

from __future__ import annotations

import logging
import sys

from edagent_vivado.mcp.config import McpConfig

logger = logging.getLogger("synthia.mcp")


def build_server(config: McpConfig):
    from mcp.server.fastmcp import FastMCP

    from edagent_vivado.mcp.client import SynthiaClient
    from edagent_vivado.mcp.tools import (
        benchmarks,
        diagnose,
        hardware,
        patches,
        projects,
        reports,
        runs,
    )

    mcp = FastMCP(config.server_name)
    client = SynthiaClient(config.base_url, config.token, timeout=config.timeout)
    projects.register(mcp, client)
    runs.register(mcp, client)
    reports.register(mcp, client)
    patches.register(mcp, client)
    diagnose.register(mcp, client)
    benchmarks.register(mcp, client)
    hardware.register(mcp, client)
    return mcp


def run_main() -> None:
    """Entry point: `synthia-mcp`."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )

    try:
        config = McpConfig.from_env()
    except Exception as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        sys.exit(1)

    logger.info("synthia-mcp starting (base_url=%s, transport=%s)", config.base_url, config.transport)
    mcp = build_server(config)

    if config.transport == "http":
        import uvicorn

        app = mcp.streamable_http_app()
        uvicorn.run(app, host=config.http_host, port=config.http_port, log_config=None)
    else:
        mcp.run(transport="stdio")
