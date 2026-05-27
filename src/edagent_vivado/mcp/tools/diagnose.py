"""MCP tools: diagnose."""

from __future__ import annotations

from typing import Any

from edagent_vivado.mcp.client import SynthiaClient


def register(mcp, client: SynthiaClient) -> None:
    @mcp.tool()
    async def synthia_diagnose_log(
        log_text: str = "",
        log_path: str = "",
        run_id: str = "",
    ) -> dict[str, Any]:
        """Analyze a Vivado log and return structured diagnosis."""
        if not (log_text or log_path or run_id):
            return {"error": "must provide log_text, log_path, or run_id"}
        return client.diagnose_log(log_text=log_text, log_path=log_path, run_id=run_id)
