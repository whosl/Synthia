"""MCP tools: benchmarks — Phase 10."""

from __future__ import annotations

from typing import Any

from edagent_vivado.mcp.client import SynthiaClient


def register(mcp, client: SynthiaClient) -> None:
    @mcp.tool()
    async def synthia_create_benchmark_suite(
        name: str,
        project_id: str,
        cases: list[dict[str, Any]],
        description: str = "",
        continue_on_failure: bool = True,
        timeout_per_case_s: int = 7200,
    ) -> dict[str, Any]:
        """Create a benchmark suite for a project."""
        return client._post(
            "/api/v1/benchmarks",
            {
                "name": name,
                "description": description,
                "project_id": project_id,
                "cases": cases,
                "config": {
                    "continue_on_failure": continue_on_failure,
                    "timeout_per_case_s": timeout_per_case_s,
                },
            },
        )

    @mcp.tool()
    async def synthia_run_benchmark_suite(suite_id: str) -> dict[str, Any]:
        """Start executing a benchmark suite (async)."""
        return client._post(f"/api/v1/benchmarks/{suite_id}/run", {})

    @mcp.tool()
    async def synthia_get_benchmark_suite(suite_id: str) -> dict[str, Any]:
        """Get benchmark suite state and case metrics."""
        return client._get(f"/api/v1/benchmarks/{suite_id}")

    @mcp.tool()
    async def synthia_export_benchmark_markdown(suite_id: str) -> str:
        """Get markdown summary of a benchmark suite."""
        r = client._client.get(f"{client._base}/api/v1/benchmarks/{suite_id}/export/markdown")
        if r.status_code >= 400:
            from edagent_vivado.mcp.client import SynthiaError

            raise SynthiaError(r.status_code, r.text)
        return r.text
