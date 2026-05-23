"""Agent tools for semantic knowledge search and reindex — Phase 2A."""

from __future__ import annotations

from langchain_core.tools import tool

from edagent_vivado.harness.run_context import get_agent_run_context


@tool
def search_knowledge_tool(query: str, top_k: int = 6) -> str:
    """Search indexed project documentation and SPEC for relevant context."""
    from edagent_vivado.knowledge.semantic_kb import search_semantic_kb

    ctx = get_agent_run_context()
    text, _hits = search_semantic_kb(
        query,
        top_k=top_k,
        session_id=ctx.get("session_id", ""),
        task_id=ctx.get("task_id", ""),
        run_id=ctx.get("run_id", ""),
    )
    return text or "No relevant knowledge found."


@tool
def reindex_knowledge_tool(project_id: str = "uart_demo") -> str:
    """Reindex global and project knowledge sources (admin)."""
    from edagent_vivado.knowledge.semantic_kb import reindex_all

    stats = reindex_all(project_id=project_id or "uart_demo")
    return f"Reindexed: global={stats['global']}, project={stats['project']}"
