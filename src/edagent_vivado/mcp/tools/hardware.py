"""MCP tools: hardware programming — Phase 12."""

from __future__ import annotations

from typing import Any

from edagent_vivado.mcp.client import SynthiaClient, SynthiaError


def register(mcp, client: SynthiaClient) -> None:
    @mcp.tool()
    async def synthia_list_hardware_targets() -> list[dict[str, Any]]:
        """List connected FPGA targets known to Synthia."""
        d = client._get("/api/v1/hardware/targets")
        return d.get("targets", [])

    @mcp.tool()
    async def synthia_detect_hardware_targets(host: str = "") -> dict[str, Any]:
        """Trigger Synthia to detect physically connected FPGA boards."""
        body = {"host": host} if host else {}
        return client._post("/api/v1/hardware/targets/detect", body)

    @mcp.tool()
    async def synthia_open_hardware_session(
        target_id: str, project_id: str = "",
    ) -> dict[str, Any]:
        """Open a hardware session on a target (reserves it)."""
        return client._post(
            "/api/v1/hardware/sessions",
            {"target_id": target_id, "project_id": project_id},
        )

    @mcp.tool()
    async def synthia_request_program(
        hardware_session_id: str,
        bitstream_artifact_id: str,
    ) -> dict[str, Any]:
        """Request to program a bitstream to a target (requires human approval)."""
        try:
            return client._post(
                "/api/v1/hardware/program/request",
                {
                    "hardware_session_id": hardware_session_id,
                    "bitstream_artifact_id": bitstream_artifact_id,
                },
            )
        except SynthiaError as e:
            if e.status == 403:
                return {"denied": True, "error": e.detail}
            raise

    @mcp.tool()
    async def synthia_get_program_job(job_id: str) -> dict[str, Any]:
        """Get current state of a ProgramJob."""
        return client._get(f"/api/v1/hardware/program/{job_id}")
