"""User intent classification — Phase 6.

Maps user free-text into structured Intent + missing arg slots.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class MissingArg:
    key: str
    prompt: str
    type: str = "string"
    enum_values: list[str] = field(default_factory=list)
    default: Any = None


@dataclass
class IntentResult:
    intent_id: str
    task_type: str
    required_args: dict[str, Any] = field(default_factory=dict)
    missing_args: list[MissingArg] = field(default_factory=list)
    confidence: float = 1.0
    raw_text: str = ""

    def needs_clarification(self) -> bool:
        return bool(self.missing_args)

    def to_dict(self) -> dict[str, Any]:
        return {
            "intent_id": self.intent_id,
            "task_type": self.task_type,
            "required_args": self.required_args,
            "missing_args": [
                {
                    "key": m.key,
                    "prompt": m.prompt,
                    "type": m.type,
                    "enum_values": m.enum_values,
                    "default": m.default,
                }
                for m in self.missing_args
            ],
            "confidence": self.confidence,
        }


_KW_SYNTH = re.compile(r"综合|synth|synthesis|sythesize", re.IGNORECASE)
_KW_IMPL = re.compile(r"实现|impl|implementation|place\s*&?\s*route|p&r", re.IGNORECASE)
_KW_BIT = re.compile(r"码流|bit\s?stream|generate[_\s]bit|生成.*bit", re.IGNORECASE)
_KW_FULL = re.compile(r"完整|full\s*flow|端到端|从头到尾|all\s*stages", re.IGNORECASE)
_KW_DIAG = re.compile(r"诊断|分析.*错误|看.*日志|为什么.*失败|diagnose", re.IGNORECASE)
_KW_IMPORT_XPR = re.compile(r"导入.*xpr|import.*xpr|打开工程|open\s*project", re.IGNORECASE)
_KW_REPORT = re.compile(r"查看报告|show\s*report|时序报告|timing\s*report|utilization", re.IGNORECASE)


def classify_intent(text: str, *, context: dict | None = None) -> IntentResult:
    """Classify a user message into an intent.

    ``context`` may contain ``session_id``, ``project_id``, ``manifest_path``,
    ``recent_run_id`` used to fill defaults.
    """
    context = context or {}
    text_strip = (text or "").strip()

    if not text_strip:
        return IntentResult(intent_id="chat", task_type="chat_only", raw_text=text or "")

    has_full = bool(_KW_FULL.search(text_strip))
    has_synth = bool(_KW_SYNTH.search(text_strip))
    has_impl = bool(_KW_IMPL.search(text_strip))
    has_bit = bool(_KW_BIT.search(text_strip))

    if has_full or (has_synth and has_impl and has_bit):
        return _build_run_intent(
            "run_full_flow", text_strip, context, stages=["synth", "impl", "bitstream"]
        )
    if has_synth and has_impl:
        return _build_run_intent("run_synth_impl", text_strip, context, stages=["synth", "impl"])
    if has_impl:
        return _build_run_intent("run_implementation", text_strip, context, stages=["impl"])
    if has_synth:
        return _build_run_intent("run_synthesis", text_strip, context, stages=["synth"])
    if has_bit:
        return _build_run_intent("generate_bitstream", text_strip, context, stages=["bitstream"])

    if _KW_DIAG.search(text_strip):
        missing: list[MissingArg] = []
        if not context.get("log_path") and not context.get("run_id"):
            missing.append(
                MissingArg(
                    key="log_path",
                    prompt="请提供 Vivado 日志路径或 run_id",
                    type="path",
                )
            )
        return IntentResult(
            intent_id="diagnose_log",
            task_type="diagnose",
            raw_text=text_strip,
            missing_args=missing,
            required_args={
                k: v
                for k, v in context.items()
                if k in ("log_path", "run_id") and v
            },
        )

    if _KW_IMPORT_XPR.search(text_strip):
        return IntentResult(
            intent_id="import_xpr",
            task_type="vivado_admin",
            raw_text=text_strip,
            missing_args=[
                MissingArg(
                    key="xpr_path",
                    prompt="请提供 .xpr 文件路径",
                    type="path",
                )
            ],
        )

    if _KW_REPORT.search(text_strip):
        return IntentResult(
            intent_id="show_report",
            task_type="report_query",
            raw_text=text_strip,
            required_args={
                k: v for k, v in context.items() if k in ("run_id", "report_type") and v
            },
        )

    return IntentResult(
        intent_id="chat",
        task_type="chat_only",
        raw_text=text_strip,
        confidence=0.4,
    )


def _build_run_intent(
    intent_id: str,
    text: str,
    context: dict,
    *,
    stages: list[str],
) -> IntentResult:
    required: dict[str, Any] = {"stages": stages}
    missing: list[MissingArg] = []

    manifest = context.get("manifest_path", "")
    project_id = context.get("project_id", "")

    if manifest:
        required["manifest_path"] = manifest
    elif project_id:
        required["project_id"] = project_id
    else:
        missing.append(
            MissingArg(
                key="manifest_path",
                prompt="哪个工程？请选择项目或 manifest 路径",
                type="path",
            )
        )

    if context.get("session_id"):
        required["session_id"] = context["session_id"]

    strategy_re = re.search(
        r"strateg(?:y|ies)?\s*[:=]\s*(\w+)|策略\s*[:：]\s*(\S+)",
        text,
        re.IGNORECASE,
    )
    if strategy_re:
        required["strategy"] = strategy_re.group(1) or strategy_re.group(2)

    return IntentResult(
        intent_id=intent_id,
        task_type="vivado_run",
        required_args=required,
        missing_args=missing,
        raw_text=text,
        confidence=0.9,
    )
