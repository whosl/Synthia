"""Phase 3 Vivado HITL prerequisites."""

from edagent_vivado.harness.approval_outcomes import (
    SCOPE_VIVADO_IMPL,
    SCOPE_VIVADO_SYNTH,
    SCOPE_VIVADO_TCL,
    format_user_rejection,
    is_user_rejection,
    parse_tool_outcome,
)
from edagent_vivado.harness.vivado_agent_registry import (
    is_vivado_execution_tool,
    vivado_tool_spec,
)
from edagent_vivado.harness.vivado_run_gate import (
    begin_vivado_gate,
    resolve_vivado_gate,
    wait_vivado_gate_allowed,
)


def test_vivado_tool_registry():
    assert is_vivado_execution_tool("run_vivado_synth_tool")
    assert is_vivado_execution_tool("run_vivado_tcl_tool")
    assert not is_vivado_execution_tool("read_file_tool")
    spec = vivado_tool_spec("run_vivado_impl_tool")
    assert spec is not None
    assert spec.scope == SCOPE_VIVADO_IMPL
    assert spec.operation == "impl"


def test_vivado_gate_per_operation():
    begin_vivado_gate("task-1", "synth")
    begin_vivado_gate("task-1", "tcl")
    resolve_vivado_gate("task-1", "synth", True)
    resolve_vivado_gate("task-1", "tcl", False)
    assert wait_vivado_gate_allowed("task-1", "synth") is True
    assert wait_vivado_gate_allowed("task-1", "tcl") is False


def test_rejection_scopes_distinct():
    synth = format_user_rejection(SCOPE_VIVADO_SYNTH, tool_name="run_vivado_synth_tool")
    tcl = format_user_rejection(SCOPE_VIVADO_TCL, tool_name="run_vivado_tcl_tool")
    assert is_user_rejection(synth)
    assert is_user_rejection(tcl)
    assert parse_tool_outcome(synth)["scope"] == SCOPE_VIVADO_SYNTH
    assert parse_tool_outcome(tcl)["scope"] == SCOPE_VIVADO_TCL
    assert "Tcl" in parse_tool_outcome(tcl)["summary"]
