"""MCP tools: patches."""

from __future__ import annotations

from typing import Any

from edagent_vivado.mcp.client import SynthiaClient, SynthiaError


def register(mcp, client: SynthiaClient) -> None:
    @mcp.tool()
    async def synthia_request_patch(
        session_id: str,
        title: str,
        rationale: str,
        changes: list[dict[str, Any]],
        run_id: str = "",
        project_id: str = "",
    ) -> dict[str, Any]:
        """Propose a code patch (XDC/RTL/manifest/Tcl)."""
        try:
            return client.propose_patch(
                session_id=session_id,
                title=title,
                rationale=rationale,
                changes=changes,
                run_id=run_id,
                project_id=project_id,
            )
        except SynthiaError as e:
            if "denied" in e.detail.lower():
                return {
                    "denied": True,
                    "error": e.detail,
                    "hint": "patch was rejected by risk policy",
                }
            raise

    @mcp.tool()
    async def synthia_get_patch(patch_id: str) -> dict[str, Any]:
        """Get patch proposal status + full diff."""
        return client.get_patch(patch_id)

    @mcp.tool()
    async def synthia_approve_patch(
        patch_id: str,
        reason: str = "",
    ) -> dict[str, Any]:
        """Approve a patch proposal."""
        try:
            return client.approve_patch(patch_id, reason=reason)
        except SynthiaError as e:
            if e.needs_approval or e.status == 403:
                return {
                    "needs_human": True,
                    "error": e.detail,
                    "hint": "high-risk patch requires a human reviewer in Synthia UI",
                }
            raise

    @mcp.tool()
    async def synthia_reject_patch(
        patch_id: str,
        reason: str = "",
    ) -> dict[str, Any]:
        """Reject a patch proposal."""
        return client.reject_patch(patch_id, reason=reason)
