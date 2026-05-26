"""Standard Vivado flow step definitions for RunOrchestrator."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FlowStep:
    key: str
    capability_id: str
    display_name: str
    required: bool = True
    requires_approval: bool = False


VIVADO_FULL_FLOW: list[FlowStep] = [
    FlowStep("validate_project", "validate_project", "Validate Project"),
    FlowStep("detect_env", "detect_environment", "Detect Vivado", required=False),
    FlowStep("synth", "run_synthesis", "Synthesis", requires_approval=True),
    FlowStep("impl", "run_implementation", "Implementation", requires_approval=True),
    FlowStep("bitstream", "generate_bitstream", "Generate Bitstream", required=False, requires_approval=True),
    FlowStep("collect_bitstream", "collect_bitstream", "Collect Bitstream", required=False),
]

VIVADO_SYNTH_ONLY: list[FlowStep] = [
    FlowStep("validate_project", "validate_project", "Validate Project"),
    FlowStep("detect_env", "detect_environment", "Detect Vivado", required=False),
    FlowStep("synth", "run_synthesis", "Synthesis", requires_approval=True),
]

FLOW_REGISTRY: dict[str, list[FlowStep]] = {
    "vivado_full_flow": VIVADO_FULL_FLOW,
    "vivado_synth_only": VIVADO_SYNTH_ONLY,
}


def get_flow(name: str) -> list[FlowStep]:
    flow = FLOW_REGISTRY.get(name)
    if not flow:
        raise KeyError(f"unknown flow: {name}")
    return list(flow)


def flow_steps_for_stages(flow_name: str, stages: list[str] | None) -> list[FlowStep]:
    """Return flow steps filtered by requested stages (synth / impl / bitstream)."""
    steps = get_flow(flow_name)
    if flow_name != "vivado_full_flow" or not stages:
        return steps
    norm = {str(s).lower() for s in stages}
    out: list[FlowStep] = []
    for step in steps:
        if step.key in ("validate_project", "detect_env"):
            out.append(step)
            continue
        if step.key == "synth" and ("synth" in norm or "synthesis" in norm):
            out.append(step)
        elif step.key == "impl" and ("impl" in norm or "implementation" in norm):
            out.append(step)
        elif step.key in ("bitstream", "collect_bitstream") and "bitstream" in norm:
            out.append(step)
    if not any(s.key in ("synth", "impl") for s in out):
        out.extend(s for s in steps if s.key in ("synth", "impl"))
    return out or steps
