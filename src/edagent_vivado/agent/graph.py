"""Agent graph  create the LangChain agent with tools."""

from __future__ import annotations

import logging
import os as _os
import sqlite3
from typing import Any, Iterator

from langchain.agents import create_agent as langchain_create_agent
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver

from edagent_vivado.agent.model import get_llm
from edagent_vivado.agent.prompts import SYSTEM_PROMPT
from edagent_vivado.tools.file_tools import read_file_tool, grep_tool
from edagent_vivado.tools.patch_tools import create_file_tool, propose_patch_tool
from edagent_vivado.tools.report_tools import (
    match_error_cases_tool,
    parse_timing_tool,
    parse_utilization_tool,
    parse_vivado_log_tool,
)
from edagent_vivado.tools.vivado_tools import (
    run_vivado_flow_tool,
    run_vivado_impl_tool,
    run_vivado_script_tool,
    run_vivado_synth_tool,
    run_vivado_tcl_tool,
)
from edagent_vivado.tools.knowledge_tools import search_knowledge_tool, reindex_knowledge_tool

logger = logging.getLogger(__name__)

_TOOLS = [
    read_file_tool,
    grep_tool,
    parse_vivado_log_tool,
    parse_timing_tool,
    parse_utilization_tool,
    match_error_cases_tool,
    run_vivado_synth_tool,
    run_vivado_impl_tool,
    run_vivado_tcl_tool,
    run_vivado_script_tool,
    run_vivado_flow_tool,
    search_knowledge_tool,
    reindex_knowledge_tool,
    propose_patch_tool,
    create_file_tool,
]

_checkpointer = MemorySaver()


def _default_checkpointer():
    """Return a persistent LangGraph checkpointer when the optional package exists.

    The current environment may not include ``langgraph-checkpoint-sqlite``.
    When it is installed, this automatically upgrades Phase 2 memory from
    in-process ``MemorySaver`` to SQLite-backed thread state. Product-level
    messages/context packages are always persisted separately.
    """
    if _os.environ.get("EDAGENT_DISABLE_SQLITE_CHECKPOINTER", "").lower() in ("1", "true", "yes"):
        return _checkpointer
    try:
        from langgraph.checkpoint.sqlite import SqliteSaver  # type: ignore
        from edagent_vivado.repository.db import _db_path  # local import avoids cycles

        conn = sqlite3.connect(_db_path(), check_same_thread=False)
        return SqliteSaver(conn)
    except Exception:
        return _checkpointer


def create_agent(checkpointer=None, *, project_id: str | None = None) -> Any:
    """Create and return a configured LangChain agent graph.

    Uses ``langchain.agents.create_agent`` (the current recommended approach
    in LangChain 1.3+). Returns a compiled LangGraph that accepts
    ``{"messages": [...]}`` input.

    Args:
        checkpointer: Optional LangGraph checkpointer. Defaults to an in-memory
                      MemorySaver (lost on process exit). Pass a SqliteSaver for
                      durable persistence.
        project_id:   Optional project id used to look up active evolution
                      overlays (SPEC §22). When None or no overlay is active,
                      the baseline prompt and tool set are used unchanged.
    """
    llm = get_llm()
    chk = checkpointer or _default_checkpointer()

    # Evolution surfaces: resolvers degrade to baseline when no overlay exists.
    try:
        from edagent_vivado.evolution import resolve_prompt, resolve_tools

        system_prompt = resolve_prompt(SYSTEM_PROMPT, project_id=project_id)
        tools = resolve_tools(_TOOLS, project_id=project_id)
    except Exception as exc:  # pragma: no cover - resolver must never break agent boot
        logger.debug("evolution resolvers unavailable: %s", exc)
        system_prompt = SYSTEM_PROMPT
        tools = _TOOLS

    agent = langchain_create_agent(
        model=llm,
        tools=tools,
        system_prompt=system_prompt,
        name="vivado_debug_agent",
        checkpointer=chk,
    )
    return agent


def invoke_agent(agent: Any, question: str, thread_id: str = "default") -> str:
    """Invoke the agent with a question and return the text response.

    Args:
        agent: Compiled agent graph from ``create_agent()``.
        question: The user's question.
        thread_id: Session identifier for conversation continuity.
    """
    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 1000}
    result = agent.invoke(
        {"messages": [HumanMessage(content=question)]},
        config=config,
    )
    messages = result.get("messages", [])
    if messages:
        return messages[-1].content if hasattr(messages[-1], "content") else str(messages[-1])
    return str(result)


def stream_agent(agent: Any, question: str, thread_id: str = "default") -> Iterator[str]:
    """Stream the agent response token-by-token.

    Yields str chunks. Suitable for real-time console output.

    Args:
        agent: Compiled agent graph from ``create_agent()``.
        question: The user's question.
        thread_id: Session identifier for conversation continuity.

    Yields:
        String tokens as the agent generates its response.
    """
    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 1000}
    for chunk in agent.stream(
        {"messages": [HumanMessage(content=question)]},
        config=config,
        stream_mode="messages",
    ):
        if isinstance(chunk, tuple):
            msg_chunk = chunk[0]
        else:
            msg_chunk = chunk
        if hasattr(msg_chunk, "content") and msg_chunk.content:
            yield msg_chunk.content


def get_conversation_history(agent: Any, thread_id: str = "default") -> list[dict]:
    """Retrieve the message history for a conversation thread.

    Args:
        agent: Compiled agent graph.
        thread_id: Session identifier.

    Returns:
        List of message dicts with 'role' and 'content' keys.
    """
    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 1000}
    state = agent.get_state(config)
    messages: list[dict] = []
    if state and state.values:
        for msg in state.values.get("messages", []):
            role = "assistant" if hasattr(msg, "type") and msg.type == "ai" else "user"
            content = msg.content if hasattr(msg, "content") else str(msg)
            if isinstance(content, list):
                content = " ".join(str(c) for c in content)
            messages.append({"role": role, "content": str(content)})
    return messages
