"""MCP server config — Phase 9."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class McpConfig:
    base_url: str
    token: str
    transport: str = "stdio"
    http_host: str = "127.0.0.1"
    http_port: int = 8485
    timeout: float = 90.0
    server_name: str = "synthia"

    @classmethod
    def from_env(cls) -> McpConfig:
        base = os.environ.get("SYNTHIA_BASE_URL", "http://127.0.0.1:8484")
        token = os.environ.get("SYNTHIA_MCP_TOKEN") or os.environ.get("SYNTHIA_API_TOKEN") or ""
        if not token:
            raise RuntimeError(
                "SYNTHIA_MCP_TOKEN not set. Run "
                "'edagent admin create-user <name> --service-account --role fpga_engineer' "
                "and export the returned token."
            )
        transport = os.environ.get("SYNTHIA_MCP_TRANSPORT", "stdio").lower()
        return cls(
            base_url=base,
            token=token,
            transport=transport,
            http_host=os.environ.get("SYNTHIA_MCP_HOST", "127.0.0.1"),
            http_port=int(os.environ.get("SYNTHIA_MCP_PORT", "8485")),
            timeout=float(os.environ.get("SYNTHIA_MCP_TIMEOUT", "90.0")),
        )
