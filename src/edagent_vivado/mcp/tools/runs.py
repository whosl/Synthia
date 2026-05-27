"""MCP tools: runs."""

from __future__ import annotations

import time
from typing import Any

from edagent_vivado.mcp.client import SynthiaClient, SynthiaError


def _poll_until_done(client: SynthiaClient, run_id: str, max_wait_s: int) -> dict[str, Any]:
    deadline = time.time() + max_wait_s
    while time.time() < deadline:
        run = client.get_run(run_id)
        state = run.get("state", "")
        if state in ("succeeded", "succeeded_with_warnings", "failed", "cancelled", "policy_denied"):
            return run
        if state == "waiting_for_approval":
            run["needs_approval"] = True
            return run
        time.sleep(min(3.0, max(1.0, (deadline - time.time()) / 10)))
    run = client.get_run(run_id)
    run["timeout"] = True
    return run


def register(mcp, client: SynthiaClient) -> None:
    @mcp.tool()
    async def synthia_run_synthesis(
        project_id: str,
        strategy: str = "",
        wait_seconds: int = 0,
    ) -> dict[str, Any]:
        """Start a synthesis run for a project."""
        inputs: dict[str, Any] = {}
        if strategy:
            inputs["strategy"] = strategy
        try:
            res = client.create_run(project_id, "vivado_synth_only", inputs=inputs)
        except SynthiaError as e:
            if e.needs_approval:
                return {
                    "needs_approval": True,
                    "error": str(e),
                    "hint": "user must approve in Synthia UI",
                }
            raise
        run_id = res.get("run_id", "")
        if wait_seconds > 0 and run_id:
            return _poll_until_done(client, run_id, wait_seconds)
        return res

    @mcp.tool()
    async def synthia_run_implementation(
        project_id: str,
        strategy: str = "",
        wait_seconds: int = 0,
    ) -> dict[str, Any]:
        """Start synth + implementation."""
        inputs = {"strategy": strategy} if strategy else {}
        res = client.create_run(project_id, "vivado_synth_impl", inputs=inputs)
        run_id = res.get("run_id", "")
        if wait_seconds > 0 and run_id:
            return _poll_until_done(client, run_id, wait_seconds)
        return res

    @mcp.tool()
    async def synthia_generate_bitstream(
        project_id: str,
        wait_seconds: int = 0,
    ) -> dict[str, Any]:
        """Run full flow (synth + impl + bitstream)."""
        res = client.create_run(project_id, "vivado_full_flow", inputs={})
        run_id = res.get("run_id", "")
        if wait_seconds > 0 and run_id:
            return _poll_until_done(client, run_id, wait_seconds)
        return res

    @mcp.tool()
    async def synthia_get_run(run_id: str) -> dict[str, Any]:
        """Get current state of a Run including steps."""
        return client.get_run(run_id)

    @mcp.tool()
    async def synthia_cancel_run(run_id: str) -> dict[str, Any]:
        """Cancel a running or queued run."""
        return client.cancel_run(run_id)
