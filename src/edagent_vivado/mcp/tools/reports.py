"""MCP tools: reports & artifacts."""

from __future__ import annotations

from typing import Any

from edagent_vivado.mcp.client import SynthiaClient


def register(mcp, client: SynthiaClient) -> None:
    @mcp.tool()
    async def synthia_get_reports(
        run_id: str,
        report_type: str = "",
    ) -> list[dict[str, Any]]:
        """List parsed reports for a Run."""
        return client.get_reports(run_id, report_type=report_type)

    @mcp.tool()
    async def synthia_get_artifacts(run_id: str) -> list[dict[str, Any]]:
        """List artifacts produced by a Run."""
        return client.get_artifacts(run_id)

    @mcp.tool()
    async def synthia_get_run_summary(run_id: str) -> str:
        """Get a Markdown summary of a Run."""
        return client.get_summary_markdown(run_id)

    @mcp.tool()
    async def synthia_get_project_trend(project_id: str) -> dict[str, Any]:
        """Get trend metrics across recent runs of a project."""
        return client.get_trend(project_id)
