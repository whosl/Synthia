"""Smoke test for the LangChain agent — requires ANTHROPIC_API_KEY."""

import os
from pathlib import Path

import pytest

from edagent_vivado.agent.graph import create_agent, invoke_agent
from edagent_vivado.agent.model import get_llm
from edagent_vivado.tools.report_tools import parse_vivado_log_tool

EXAMPLE_DIR = Path(__file__).parent.parent / "examples" / "uart_demo"


# ── skip if no API key ───────────────────────────────────────

requires_api_key = pytest.mark.skipif(
    not os.environ.get("ANTHROPIC_API_KEY"),
    reason="ANTHROPIC_API_KEY not set",
)


def test_get_llm_no_key_warns():
    """Without API key, get_llm still returns a ChatAnthropic object (will fail at invoke)."""
    llm = get_llm()
    assert llm is not None


def test_parse_log_tool():
    """The parse_vivado_log_tool should work without an API key."""
    log_path = str(EXAMPLE_DIR / "logs" / "sample_vivado_error.log")
    result = parse_vivado_log_tool.invoke({"log_path": log_path})
    assert "error_count" in result
    assert "Synth 8-439" in result


def test_parse_log_tool_not_found():
    result = parse_vivado_log_tool.invoke({"log_path": "/nonexistent.log"})
    assert "ERROR" in result


@requires_api_key
def test_agent_creation():
    """Agent can be created."""
    agent = create_agent()
    assert agent is not None


@requires_api_key
def test_agent_simple_diagnose():
    """Agent can diagnose a known error log."""
    log_path = str(EXAMPLE_DIR / "logs" / "sample_vivado_error.log")
    agent = create_agent()
    result = invoke_agent(
        agent,
        f"Parse the Vivado log at {log_path} and tell me what errors you find."
    )
    assert result
    # should mention Synth 8-439
    assert "Synth 8-439" in result or "8-439" in result
