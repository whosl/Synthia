"""Capability planner — rule-based + optional LLM (Phase 6E)."""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import asdict, dataclass, field

from edagent_vivado.connectors import ensure_connectors
from edagent_vivado.connectors.base.registry import find_capability, get_connector, list_connectors

logger = logging.getLogger(__name__)


@dataclass
class PlanStep:
    step: str
    connector: str
    capability: str
    inputs: dict = field(default_factory=dict)
    requires_approval: bool = False
    display_name: str = ""


def _add_step(
    steps: list[PlanStep],
    step: str,
    connector: str,
    capability: str,
    **inputs: str,
) -> None:
    cap = find_capability(connector, capability)
    steps.append(
        PlanStep(
            step=step,
            connector=connector,
            capability=capability,
            inputs=dict(inputs),
            requires_approval=bool(cap.requires_approval) if cap else False,
            display_name=cap.display_name if cap else capability,
        )
    )


def plan_task_rule_based(
    question: str,
    *,
    project_id: str = "",
    session_id: str = "",
    manifest_path: str = "",
) -> list[PlanStep]:
    """Keyword heuristic plan."""
    ensure_connectors()
    q = (question or "").lower()
    steps: list[PlanStep] = []

    if manifest_path or "eda.yaml" in q or "manifest" in q:
        _add_step(steps, "validate", "vivado", "validate_project", manifest_path=manifest_path)

    if any(x in q for x in ("simulate", "simulation", "xsim", "testbench", "tb")):
        _add_step(steps, "sim", "vivado", "run_simulation", manifest_path=manifest_path)
    elif any(x in q for x in ("implement", "place", "route", "impl", "pnr")):
        _add_step(steps, "impl", "vivado", "run_implementation", manifest_path=manifest_path)
    elif any(x in q for x in ("synth", "synthesis", "综合")):
        _add_step(steps, "synth", "vivado", "run_synthesis", manifest_path=manifest_path)
    elif any(x in q for x in ("timing", "wns", "tns", "slack")):
        _add_step(steps, "report", "vivado", "report_timing_summary")
    elif any(x in q for x in ("utilization", "lut", "ff", "resource")):
        _add_step(steps, "report", "vivado", "report_utilization")
    elif any(x in q for x in ("drc", "violation")):
        _add_step(steps, "report", "vivado", "report_drc")
    elif any(x in q for x in ("lint", "verilator")):
        _add_step(steps, "lint", "verilator", "lint_design", manifest_path=manifest_path)
    elif any(x in q for x in ("vivado", "fpga", "xilinx")):
        _add_step(steps, "synth", "vivado", "run_synthesis", manifest_path=manifest_path)

    if not steps and manifest_path:
        _add_step(steps, "validate", "vivado", "validate_project", manifest_path=manifest_path)

    return steps


def _capability_catalog() -> str:
    lines: list[str] = []
    for conn in list_connectors():
        for cap in conn.list_capabilities():
            lines.append(
                f"- {conn.connector_id}.{cap.capability_id} ({cap.display_name}, stage={cap.stage}, approval={cap.requires_approval})"
            )
    return "\n".join(lines[:40])


def _parse_llm_plan(text: str, manifest_path: str) -> list[PlanStep]:
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict) and "steps" in data:
        data = data["steps"]
    if not isinstance(data, list):
        return []
    steps: list[PlanStep] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        connector = str(item.get("connector") or item.get("connector_id") or "vivado")
        capability = str(item.get("capability") or item.get("capability_id") or "")
        if not capability:
            continue
        inputs = item.get("inputs") if isinstance(item.get("inputs"), dict) else {}
        if manifest_path and "manifest_path" not in inputs:
            inputs = {**inputs, "manifest_path": manifest_path}
        cap = find_capability(connector, capability)
        steps.append(
            PlanStep(
                step=str(item.get("step") or capability),
                connector=connector,
                capability=capability,
                inputs={k: str(v) for k, v in inputs.items()},
                requires_approval=bool(item.get("requires_approval", cap.requires_approval if cap else False)),
                display_name=str(item.get("display_name") or (cap.display_name if cap else capability)),
            )
        )
    return steps


def plan_task_llm(
    question: str,
    *,
    project_id: str = "",
    session_id: str = "",
    manifest_path: str = "",
) -> list[PlanStep] | None:
    """LLM-assisted plan; None when unavailable or parse fails."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    if os.environ.get("EDAGENT_LLM_PLANNER", "1").lower() in ("0", "false", "no"):
        return None
    try:
        from langchain_core.messages import HumanMessage, SystemMessage

        from edagent_vivado.agent.model import get_llm

        ensure_connectors()
        llm = get_llm()
        system = (
            "You are an FPGA debug planner. Output ONLY a JSON array of plan steps. "
            "Each step: {\"step\",\"connector\",\"capability\",\"inputs\":{}}. "
            "Use only capabilities from the catalog."
        )
        user = (
            f"Question: {question}\n"
            f"project_id: {project_id}\n"
            f"manifest_path: {manifest_path}\n\n"
            f"Capability catalog:\n{_capability_catalog()}"
        )
        resp = llm.invoke([SystemMessage(content=system), HumanMessage(content=user)])
        content = getattr(resp, "content", "") or ""
        if isinstance(content, list):
            content = "".join(
                block.get("text", "") if isinstance(block, dict) else str(block)
                for block in content
            )
        steps = _parse_llm_plan(str(content), manifest_path)
        return steps or None
    except Exception as exc:
        logger.debug("LLM planner failed, using rules: %s", exc)
        return None


def plan_task(
    question: str,
    *,
    project_id: str = "",
    session_id: str = "",
    manifest_path: str = "",
    prefer_llm: bool = True,
) -> list[PlanStep]:
    """Plan capability steps: LLM when enabled, else rule-based fallback."""
    if prefer_llm:
        llm_steps = plan_task_llm(
            question,
            project_id=project_id,
            session_id=session_id,
            manifest_path=manifest_path,
        )
        if llm_steps:
            return llm_steps
    return plan_task_rule_based(
        question,
        project_id=project_id,
        session_id=session_id,
        manifest_path=manifest_path,
    )


def plan_to_json(steps: list[PlanStep]) -> str:
    return json.dumps([asdict(s) for s in steps], ensure_ascii=False)


def summarize_plan(steps: list[PlanStep]) -> str:
    if not steps:
        return "No capability plan generated."
    lines = [
        f"- {s.step}: {s.connector}.{s.capability}" + (" (approval)" if s.requires_approval else "")
        for s in steps
    ]
    return "Planned steps:\n" + "\n".join(lines)
