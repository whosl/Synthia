"""Agent graph — create the LangChain agent with tools."""

from __future__ import annotations

import logging
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
from edagent_vivado.tools.vivado_tools import run_vivado_synth_tool

logger = logging.getLogger(__name__)

_TOOLS = [
    read_file_tool,
    grep_tool,
    parse_vivado_log_tool,
    parse_timing_tool,
    parse_utilization_tool,
    match_error_cases_tool,
    run_vivado_synth_tool,
    propose_patch_tool,
    create_file_tool,
]

_checkpointer = MemorySaver()


def create_agent(checkpointer=None) -> Any:
    """Create and return a configured LangChain agent graph.

    Uses ``langchain.agents.create_agent`` (the current recommended approach
    in LangChain 1.3+). Returns a compiled LangGraph that accepts
    ``{"messages": [...]}`` input.

    Args:
        checkpointer: Optional LangGraph checkpointer. Defaults to an in-memory
                      MemorySaver (lost on process exit). Pass a SqliteSaver for
                      durable persistence.
    """
    llm = get_llm()
    chk = checkpointer or _checkpointer

    agent = langchain_create_agent(
        model=llm,
        tools=_TOOLS,
        system_prompt=SYSTEM_PROMPT,
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
    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 100}
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
    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 100}
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
    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 100}
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
