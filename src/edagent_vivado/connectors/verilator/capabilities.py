"""Verilator connector capabilities (Phase 6F)."""

from __future__ import annotations

from edagent_vivado.connectors.base.types import ToolCapability

VERILATOR_CAPABILITIES: list[ToolCapability] = [
    ToolCapability(
        connector_id="verilator",
        capability_id="lint_design",
        display_name="Verilator Lint",
        stage="lint",
        input_schema={"top_module": "string", "rtl_files": "array"},
        outputs=["lint_log"],
        risk_level="low",
        requires_approval=False,
        produces_reports=True,
    ),
    ToolCapability(
        connector_id="verilator",
        capability_id="compile_sim",
        display_name="Verilator Compile",
        stage="sim_build",
        input_schema={"top_module": "string"},
        outputs=["sim_binary"],
        risk_level="low",
        requires_approval=False,
    ),
    ToolCapability(
        connector_id="verilator",
        capability_id="run_simulation",
        display_name="Verilator Simulation",
        stage="sim_run",
        input_schema={"binary": "string"},
        outputs=["sim_log"],
        risk_level="low",
        requires_approval=False,
        produces_reports=True,
    ),
]
