"""Supervisor agent — multi-agent orchestration for Vivado debugging.

Routes user questions to specialist agents: synthesis, timing, constraint.
Each specialist is a full LangChain agent with tool-calling loop.
"""

from __future__ import annotations

import logging
from typing import Any

from langchain.agents import create_agent as langchain_create_agent
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph
from langgraph.graph.state import CompiledStateGraph
from typing_extensions import TypedDict

from edagent_vivado.agent.model import get_llm
from edagent_vivado.agent.specialists import (
    CONSTRAINT_SPECIALIST_PROMPT,
    SYNTHESIS_SPECIALIST_PROMPT,
    TIMING_SPECIALIST_PROMPT,
    constraint_tools,
    synthesis_tools,
    timing_tools,
)
from edagent_vivado.tools.file_tools import grep_tool, read_file_tool
from edagent_vivado.tools.report_tools import (
    match_error_cases_tool, parse_timing_tool,
    parse_utilization_tool, parse_vivado_log_tool,
)
from edagent_vivado.tools.vivado_tools import run_vivado_synth_tool

logger = logging.getLogger(__name__)

_SHARED_TOOLS = [read_file_tool, grep_tool, parse_vivado_log_tool, match_error_cases_tool]

ROUTING_PROMPT = """You are a supervisor agent for FPGA/Vivado debugging. Your job is to route
the user's question to the most appropriate specialist.

Specialists available:
- **synthesis** — synthesis errors, elaboration issues, RTL compilation, missing modules,
  black boxes, read_verilog/read_vhdl problems.
- **timing** — WNS/TNS violations, clock constraints, timing closure, false paths,
  multicycle paths, clock domain crossing.
- **constraint** — XDC issues, pin assignments, I/O standards, Pblock, DRC violations,
  physical constraints.

Read the user's question and reply with EXACTLY ONE WORD: synthesis, timing, or constraint.
If the question is general or spans multiple areas, choose the most urgent one.
"""


class TeamState(TypedDict):
    messages: list
    next_agent: str
    specialist_output: str


# ── specialist agent caches ──────────────────────────────────

_specialist_cache: dict[str, Any] = {}

_ckpt = MemorySaver()


def _get_specialist(name: str) -> Any:
    """Create or retrieve a cached specialist agent with full tool-calling loop."""
    if name in _specialist_cache:
        return _specialist_cache[name]

    llm = get_llm()
    configs = {
        "synthesis": (SYNTHESIS_SPECIALIST_PROMPT, _SHARED_TOOLS + [run_vivado_synth_tool] + synthesis_tools),
        "timing": (TIMING_SPECIALIST_PROMPT, _SHARED_TOOLS + [parse_timing_tool] + timing_tools),
        "constraint": (CONSTRAINT_SPECIALIST_PROMPT, _SHARED_TOOLS + [parse_utilization_tool] + constraint_tools),
    }
    prompt, tools = configs.get(name, configs["synthesis"])
    agent = langchain_create_agent(model=llm, tools=tools, system_prompt=prompt, name=f"{name}_specialist", checkpointer=_ckpt)
    _specialist_cache[name] = agent
    return agent


# ── routing ──────────────────────────────────────────────────


def _route_question(question: str) -> str:
    llm = get_llm()
    response = llm.invoke([SystemMessage(content=ROUTING_PROMPT), HumanMessage(content=question)])
    choice = (response.content or "").strip().lower()
    if "timing" in choice:
        return "timing"
    if "constraint" in choice:
        return "constraint"
    return "synthesis"


# ── specialist nodes (full agent invocation) ─────────────────


def _synthesis_node(state: TeamState) -> dict:
    agent = _get_specialist("synthesis")
    question = _extract_question(state["messages"])
    result = agent.invoke({"messages": [HumanMessage(content=question)]}, config={"configurable": {"thread_id": "synth"}, "recursion_limit": 100})
    return _extract_response(result)


def _timing_node(state: TeamState) -> dict:
    agent = _get_specialist("timing")
    question = _extract_question(state["messages"])
    result = agent.invoke({"messages": [HumanMessage(content=question)]}, config={"configurable": {"thread_id": "timing"}, "recursion_limit": 100})
    return _extract_response(result)


def _constraint_node(state: TeamState) -> dict:
    agent = _get_specialist("constraint")
    question = _extract_question(state["messages"])
    result = agent.invoke({"messages": [HumanMessage(content=question)]}, config={"configurable": {"thread_id": "constraint"}, "recursion_limit": 100})
    return _extract_response(result)


def _extract_question(messages: list) -> str:
    for m in messages:
        content = m.content if hasattr(m, "content") else str(m)
        if isinstance(content, str):
            return content
        if isinstance(content, list) and content:
            first = content[0]
            return first.get("text", str(first)) if isinstance(first, dict) else str(first)
    return ""


def _extract_response(result: dict) -> dict:
    msgs = result.get("messages", [])
    output = ""
    for m in reversed(msgs):
        content = m.content if hasattr(m, "content") else ""
        if isinstance(content, str) and content:
            output = content
            break
        if isinstance(content, list):
            for block in reversed(content):
                if isinstance(block, dict) and block.get("type") == "text":
                    output = block.get("text", "")
                    break
            if output:
                break
    return {"messages": msgs, "specialist_output": output}


# ── graph ────────────────────────────────────────────────────


def _supervisor_router(state: TeamState) -> dict:
    question = _extract_question(state.get("messages", []))
    choice = _route_question(question)
    logger.info("Supervisor routing to: %s", choice)
    return {"next_agent": choice}


def create_supervisor_agent(checkpointer=None) -> CompiledStateGraph:
    """Build a supervisor + specialist multi-agent graph with tool-calling loop."""
    builder = StateGraph(TeamState)
    builder.add_node("supervisor", _supervisor_router)
    builder.add_node("synthesis_specialist", _synthesis_node)
    builder.add_node("timing_specialist", _timing_node)
    builder.add_node("constraint_specialist", _constraint_node)
    builder.set_entry_point("supervisor")
    builder.add_conditional_edges(
        "supervisor",
        lambda s: s.get("next_agent", "synthesis"),
        {"synthesis": "synthesis_specialist", "timing": "timing_specialist", "constraint": "constraint_specialist"},
    )
    builder.add_edge("synthesis_specialist", END)
    builder.add_edge("timing_specialist", END)
    builder.add_edge("constraint_specialist", END)
    return builder.compile(checkpointer=checkpointer or _ckpt)


def invoke_supervisor(agent: CompiledStateGraph, question: str, thread_id: str = "default") -> str:
    """Invoke the multi-agent supervisor. Returns the specialist's final text response."""
    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 100}
    result = agent.invoke(
        {"messages": [HumanMessage(content=question)], "next_agent": "", "specialist_output": ""},
        config=config,
    )
    return result.get("specialist_output", "") or str(result)
