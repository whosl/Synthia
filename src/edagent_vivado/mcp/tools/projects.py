"""MCP tools: projects."""

from __future__ import annotations

from typing import Any

from edagent_vivado.mcp.client import SynthiaClient, SynthiaError


def register(mcp, client: SynthiaClient) -> None:
    @mcp.tool()
    async def synthia_list_projects() -> list[dict[str, Any]]:
        """List all Synthia projects accessible to the service account."""
        return client.list_projects()

    @mcp.tool()
    async def synthia_get_project(project_id: str) -> dict[str, Any]:
        """Get detailed info for a Synthia project."""
        return client.get_project(project_id)

    @mcp.tool()
    async def synthia_import_xpr(
        xpr_path: str,
        project_name: str = "",
    ) -> dict[str, Any]:
        """Import a Vivado .xpr project into Synthia."""
        try:
            return client.import_xpr(xpr_path, project_name=project_name)
        except SynthiaError as e:
            if e.needs_approval:
                return {"needs_approval": True, "error": str(e)}
            raise

    @mcp.tool()
    async def synthia_scan_project(project_id: str) -> dict[str, Any]:
        """Re-scan a project directory; detect new RTL/XDC files."""
        return client.scan_project(project_id)
