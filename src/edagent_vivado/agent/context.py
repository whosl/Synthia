"""Phase 2 Context Builder.

Builds an auditable prompt package before every model call. This provides
durable session memory even when LangGraph's in-process checkpointer is lost.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from edagent_vivado.agent.summary import compact_text, estimate_tokens
from edagent_vivado.kb.error_case_loader import load_effective_cases, match_cases
from edagent_vivado.projects.snapshot import parse_snapshot, snapshot_context_lines, snapshot_manifest_path
from edagent_vivado.repository.store import (
    context_package_create,
    context_package_item_create,
    memory_latest,
    message_list,
    parsed_report_list,
    retrieval_audit_create,
    retrieval_audit_item_create,
    run_step_list,
    session_get,
    toolcall_list,
)


@dataclass
class ContextItem:
    item_type: str
    title: str
    content: str
    priority: int
    source_id: str = ""
    source_type: str = ""
    authority_score: float | None = None
    trust_score: float | None = None
    relevance_score: float | None = None
    included: bool = True
    truncation_reason: str = ""
    original_content: str = ""
    offload_keep_ratio: float | None = None

    @property
    def token_count(self) -> int:
        return estimate_tokens(self.content)


@dataclass
class AgentContext:
    prompt: str
    context_package: dict
    retrieval_audit: dict | None
    items: list[ContextItem] = field(default_factory=list)
    token_counts: dict[str, int] = field(default_factory=dict)


def _classify_intent(question: str) -> dict[str, Any]:
    q = question.lower()
    return {
        "timing": any(x in q for x in ("timing", "wns", "tns", "slack", "clock")),
        "vivado": any(x in q for x in ("vivado", "synth", "impl", "route", "place", "xdc")),
        "rtl": any(x in q for x in ("rtl", "verilog", "vhdl", "module", "always")),
        "error": any(x in q for x in ("error", "critical warning", "failed", "violation")),
    }


def _extract_entities(question: str) -> dict[str, Any]:
    return {
        "message_ids": re.findall(r"\[[A-Z]+(?: [A-Za-z0-9_-]+)?-\d+\]", question),
        "files": re.findall(r"[\w./\\:-]+\.(?:v|sv|vhd|xdc|tcl|log|rpt|xpr)", question, flags=re.I),
    }


def _project_context(manifest_path: str) -> str:
    if not manifest_path:
        return ""
    p = Path(manifest_path)
    if not p.exists():
        return f"Manifest path provided but not found: {manifest_path}"
    try:
        from edagent_vivado.harness.manifest import Manifest

        m = Manifest.load(p)
        return (
            f"Project: {m.name()}\n"
            f"Top: {m.top()}\n"
            f"Part: {m.part()}\n"
            f"RTL: {m.sources.rtl}\n"
            f"Constraints: {getattr(m.sources, 'xdc', [])}"
        )
    except Exception as exc:
        return f"Manifest: {manifest_path}\nCould not parse manifest: {exc}"


def _error_kb_context(question: str) -> tuple[str, list[dict]]:
    signatures = [question]
    matches = match_cases(signatures, load_effective_cases())
    records: list[dict] = []
    lines: list[str] = []
    for case, sig in matches[:5]:
        record = {
            "pattern": case.pattern,
            "category": case.category,
            "matched_signature": sig,
            "likely_causes": case.likely_causes[:3],
            "suggested_actions": case.suggested_actions[:3],
        }
        records.append(record)
        lines.append(
            f"- [{case.category}] pattern={case.pattern}\n"
            f"  likely causes: {', '.join(case.likely_causes[:3])}\n"
            f"  suggested actions: {', '.join(case.suggested_actions[:3])}"
        )
    return "\n".join(lines), records


def _semantic_kb_context(
    question: str,
    *,
    project_id: str = "",
    session_id: str = "",
    task_id: str = "",
    run_id: str = "",
    persist_audit: bool = True,
) -> tuple[str, list[dict]]:
    """Retrieve from indexed repo docs (Phase 2A hybrid search)."""
    if not question.strip():
        return "", []
    try:
        from edagent_vivado.knowledge.semantic_kb import search_semantic_kb

        return search_semantic_kb(
            question,
            top_k=6,
            scope="both" if project_id else "global",
            project_id=project_id or "",
            session_id=session_id,
            task_id=task_id,
            run_id=run_id,
            persist_audit=persist_audit,
        )
    except Exception:
        return "", []


def _load_project_persona(project_id: str) -> str:
    if not project_id:
        return ""
    try:
        from edagent_vivado.memory.personas import load_project_persona_text

        return load_project_persona_text(project_id)
    except Exception:
        return ""


def _summarize_reports(reports: list[dict], *, max_chars: int = 600) -> str:
    lines: list[str] = []
    for r in reports[:6]:
        data = r.get("data") or {}
        if r.get("report_type") == "timing_summary":
            lines.append(
                f"timing({r.get('stage')}): WNS={data.get('wns')} TNS={data.get('tns')}"
            )
        elif r.get("report_type") == "utilization":
            lines.append(
                f"util({r.get('stage')}): LUT={data.get('lut')} FF={data.get('ff')}"
            )
        elif r.get("report_type") == "drc":
            err_n = len(data.get("errors") or [])
            lines.append(f"drc({r.get('stage')}): {err_n} errors, clean={data.get('clean')}")
        else:
            lines.append(f"{r.get('report_type')}({r.get('stage')})")
    text = "\n".join(lines)
    return compact_text(text, max_chars)


def _connector_environment_block() -> str:
    try:
        from edagent_vivado.connectors import ensure_connectors
        from edagent_vivado.connectors.base.registry import get_connector

        ensure_connectors()
        conn = get_connector("vivado")
        if not conn:
            return ""
        env = conn.detect_environment()
        return (
            f"{env.tool_name} {env.version or 'unknown'} via {env.target_type}"
            f" (target={env.target_id or 'default'}, reachable={env.reachable})"
        )
    except Exception:
        return ""


def _tool_error_summary_block(run_id: str) -> str:
    if not run_id:
        return ""
    steps = run_step_list(run_id)
    failed = [s for s in steps if s.get("state") == "failed" and s.get("error")]
    if not failed:
        return ""
    last = failed[-1]
    return (
        f"[error] {last.get('stage')}: {last.get('name')}\n"
        f"message: {compact_text(str(last.get('error') or ''), 400)}"
    )


def _load_task_canvas(task_id: str) -> str:
    if not task_id:
        return ""
    try:
        from edagent_vivado.memory.canvas import build_canvas_for_prompt

        return build_canvas_for_prompt(task_id)
    except Exception:
        return ""


# Phase E — context offload keep-ratios (1 - offload_ratio)
OFFLOAD_KEEP_MILD = 0.5          # offload 50%
OFFLOAD_KEEP_AGGRESSIVE = 0.15   # offload 85%


def _offload_keep_ratios(mode: str) -> list[float]:
    """Return keep-ratio phases tried in order when fitting context items."""
    mode = (mode or "auto").lower()
    if mode == "off":
        return [1.0]
    if mode == "mild":
        return [1.0, OFFLOAD_KEEP_MILD]
    if mode == "aggressive":
        return [1.0, OFFLOAD_KEEP_MILD, OFFLOAD_KEEP_AGGRESSIVE]
    # auto: try full → mild → aggressive before excluding
    return [1.0, OFFLOAD_KEEP_MILD, OFFLOAD_KEEP_AGGRESSIVE]


def _fit_context_item(
    item: ContextItem,
    *,
    running_tokens: int,
    budget: int,
    keep_ratios: list[float],
) -> tuple[bool, int]:
    """Try to include item at full or offloaded size within token budget."""
    for ratio in keep_ratios:
        if ratio >= 1.0:
            content = item.content
            reason = ""
        else:
            max_chars = max(48, int(len(item.content) * ratio))
            content = compact_text(item.content, max_chars)
            if ratio <= OFFLOAD_KEEP_AGGRESSIVE + 1e-9:
                reason = "offload_aggressive"
            else:
                reason = "offload_mild"

        tokens = estimate_tokens(content)
        if running_tokens + tokens > budget:
            continue

        if ratio < 1.0:
            item.original_content = item.content
            item.content = content
            item.truncation_reason = reason
            item.offload_keep_ratio = ratio
        return True, tokens

    return False, 0


class AgentContextBuilder:
    def __init__(
        self,
        max_context_tokens: int | None = None,
        recent_message_limit: int | None = None,
        offload_mode: str | None = None,
    ):
        self.max_context_tokens = max_context_tokens or int(os.environ.get("EDAGENT_MAX_CONTEXT_TOKENS", "64000"))
        self.recent_message_limit = recent_message_limit or int(os.environ.get("EDAGENT_RECENT_MESSAGE_LIMIT", "20"))
        self.offload_mode = offload_mode or os.environ.get("EDAGENT_CONTEXT_OFFLOAD", "auto")
        self._offload_keep_ratios = _offload_keep_ratios(self.offload_mode)

    def build(
        self,
        session_id: str,
        task_id: str,
        run_id: str,
        question: str,
        manifest_path: str = "",
        agent_id: str = "",
        model: str = "",
        *,
        persist: bool = True,
    ) -> AgentContext:
        items: list[ContextItem] = []
        token_counts: dict[str, int] = {}

        session_row = session_get(session_id) if session_id and session_id not in ("preview", "") else None
        snapshot = parse_snapshot(session_row) if session_row else {}
        resolved_manifest = snapshot_manifest_path(session_row, manifest_path)

        project_parts: list[str] = []
        snap_lines = snapshot_context_lines(snapshot)
        if snap_lines:
            project_parts.append(snap_lines)
        manifest_block = _project_context(resolved_manifest)
        if manifest_block:
            project_parts.append(manifest_block)
        project = "\n\n".join(project_parts).strip()
        if project:
            items.append(
                ContextItem(
                    "project_context",
                    "Project / Manifest Context",
                    project,
                    priority=3,
                    source_id=str(snapshot.get("project_id") or ""),
                    source_type="project_snapshot",
                    trust_score=0.8,
                )
            )

        kb_project_id = str(snapshot.get("project_id") or (session_row or {}).get("project_id") or "")
        persona_block = _load_project_persona(kb_project_id)
        if persona_block:
            items.append(
                ContextItem(
                    "project_persona",
                    "Project Memory (Persona)",
                    persona_block,
                    priority=2,
                    source_id=kb_project_id,
                    source_type="memory_persona",
                    trust_score=0.85,
                )
            )

        canvas_block = _load_task_canvas(task_id)
        if canvas_block:
            items.append(
                ContextItem(
                    "task_canvas",
                    "Task Canvas",
                    canvas_block,
                    priority=1,
                    source_id=task_id,
                    source_type="task_canvas",
                    trust_score=0.9,
                )
            )

        mem = memory_latest(session_id)
        if mem and mem.get("summary"):
            items.append(ContextItem("memory", "Session Memory Summary", mem["summary"], priority=4, source_id=mem["id"], source_type="memory_snapshot", trust_score=0.75))

        msgs = message_list(session_id, limit=self.recent_message_limit)
        recent_lines = []
        for msg in msgs[-self.recent_message_limit:]:
            role = msg.get("role", "message")
            content = compact_text(msg.get("content", ""), 1000)
            if content:
                recent_lines.append(f"{role}: {content}")
        if recent_lines:
            items.append(ContextItem("recent_messages", "Recent Conversation", "\n".join(recent_lines), priority=5, trust_score=0.85))

        error_kb, error_records = _error_kb_context(question)
        if error_kb:
            items.append(ContextItem("error_kb", "Matched Error KB", error_kb, priority=6, source_type="error_kb", authority_score=0.82, trust_score=0.82, relevance_score=0.8))

        toolcalls = toolcall_list(session_id=session_id, limit=12)
        tool_lines = []
        for tc in toolcalls[-8:]:
            summary = tc.get("output_summary") or tc.get("input_summary") or tc.get("tool_name")
            tool_lines.append(f"- {tc.get('tool_name')}: {compact_text(str(summary), 350)}")
        if tool_lines:
            items.append(ContextItem("tool_summary", "Relevant Tool Summaries", "\n".join(tool_lines), priority=7, trust_score=0.72))

        semantic_text, semantic_hits = _semantic_kb_context(
            question,
            project_id=kb_project_id,
            session_id=session_id,
            task_id=task_id,
            run_id=run_id,
            persist_audit=persist,
        )
        if semantic_text:
            items.append(ContextItem("semantic_kb", "Retrieved Semantic Knowledge", semantic_text, priority=8, source_type="semantic_kb", authority_score=0.7, trust_score=0.65, relevance_score=0.6))

        parsed = parsed_report_list(run_id=run_id) if run_id else []
        if parsed:
            summary = _summarize_reports(parsed)
            items.append(
                ContextItem(
                    "parsed_report_context",
                    "Latest Run Parsed Reports",
                    summary,
                    priority=4,
                    source_type="parsed_report",
                    trust_score=0.9,
                )
            )

        env_block = _connector_environment_block()
        if env_block:
            items.append(
                ContextItem(
                    "connector_environment_context",
                    "Tool Environment",
                    env_block,
                    priority=2,
                    source_type="connector",
                    trust_score=0.9,
                )
            )

        if task_id:
            try:
                from edagent_vivado.repository.store import task_get
                import json as _json

                trow = task_get(task_id) or {}
                meta = _json.loads(trow.get("metadata_json") or "{}")
                plan = meta.get("plan") or []
                if plan:
                    plan_lines = [
                        f"- {s.get('step')}: {s.get('connector')}.{s.get('capability')}"
                        for s in plan[:8]
                        if isinstance(s, dict)
                    ]
                    items.append(
                        ContextItem(
                            "capability_context",
                            "Task Capability Plan",
                            "Planned steps:\n" + "\n".join(plan_lines),
                            priority=3,
                            source_id=task_id,
                            source_type="task_plan",
                            trust_score=0.88,
                        )
                    )
            except Exception:
                pass

        if run_id:
            from edagent_vivado.repository.store import artifact_list

            arts = artifact_list(run_id=run_id, limit=12)
            if arts:
                art_lines = [
                    f"- {a.get('artifact_type') or 'file'}: {a.get('path', '')}"
                    for a in arts[:10]
                ]
                items.append(
                    ContextItem(
                        "artifact_index_context",
                        "Run Artifacts",
                        "\n".join(art_lines),
                        priority=5,
                        source_type="artifact",
                        trust_score=0.85,
                    )
                )

        err_block = _tool_error_summary_block(run_id)
        if err_block:
            items.append(
                ContextItem(
                    "tool_error_summary_context",
                    "Tool Error Summary",
                    err_block,
                    priority=1,
                    source_type="run_step",
                    trust_score=0.9,
                )
            )

        # Token budget selection: priority order; offload before hard exclusion (Phase E).
        selected: list[ContextItem] = []
        running_tokens = estimate_tokens(question)
        for item in sorted(items, key=lambda x: x.priority):
            fitted, tokens = _fit_context_item(
                item,
                running_tokens=running_tokens,
                budget=self.max_context_tokens,
                keep_ratios=self._offload_keep_ratios,
            )
            if fitted:
                selected.append(item)
                running_tokens += tokens
            else:
                item.included = False
                item.truncation_reason = "max_context_tokens"
                selected.append(item)

        for item in selected:
            token_counts[item.item_type] = token_counts.get(item.item_type, 0) + (item.token_count if item.included else 0)
        token_counts["question"] = estimate_tokens(question)
        token_counts["total"] = sum(token_counts.values())

        audit: dict | None
        if persist:
            audit = retrieval_audit_create(
                session_id=session_id,
                task_id=task_id,
                run_id=run_id,
                agent_id=agent_id,
                query=question,
                rewritten_query=question,
                intent={**_classify_intent(question), "entities": _extract_entities(question)},
                filters={"scope": "global+project"},
                candidate_count=len(error_records) + len(semantic_hits),
                selected_count=len(error_records) + len(semantic_hits),
                rejected_count=0,
                token_budget=self.max_context_tokens,
                token_used=token_counts["total"],
                metadata={"phase": "2e", "vector_backend": "sqlite-json", "retrieval": "rrf", "offload_mode": self.offload_mode},
            )
            for hit in semantic_hits:
                retrieval_audit_item_create(
                    audit["id"],
                    hit.get("source_type", "doc"),
                    title=hit.get("title", ""),
                    excerpt=hit.get("excerpt", ""),
                    selected=True,
                    source_id=hit.get("source_id", ""),
                    chunk_id=hit.get("chunk_id", ""),
                    final_score=hit.get("final_score", hit.get("score", 0)),
                    vector_score=hit.get("vector_score"),
                    authority_score=hit.get("authority_score", 0.7),
                    trust_score=hit.get("trust_score", 0.65),
                    token_count=estimate_tokens(hit.get("excerpt", "")),
                )
            for rec in error_records:
                retrieval_audit_item_create(
                    audit["id"],
                    "error_kb",
                    title=rec["category"],
                    excerpt=json.dumps(rec, ensure_ascii=False),
                    selected=True,
                    source_id=rec["pattern"],
                    final_score=0.82,
                    authority_score=0.82,
                    trust_score=0.82,
                    token_count=estimate_tokens(str(rec)),
                )
        else:
            audit = {
                "id": "preview-audit",
                "session_id": session_id,
                "preview": True,
            }

        truncated = any(not i.included for i in selected)
        if persist:
            package = context_package_create(
                session_id=session_id,
                task_id=task_id,
                run_id=run_id,
                agent_id=agent_id,
                model=model or os.environ.get("EDAGENT_MODEL", ""),
                max_context_tokens=self.max_context_tokens,
                token_counts=token_counts,
                truncated=truncated,
                metadata={"retrieval_audit_id": audit["id"], "phase": "2e", "offload_mode": self.offload_mode},
            )
            for item in selected:
                item_metadata = None
                if item.offload_keep_ratio is not None and item.original_content:
                    item_metadata = {
                        "offload_keep_ratio": item.offload_keep_ratio,
                        "original_chars": len(item.original_content),
                        "kept_chars": len(item.content),
                    }
                context_package_item_create(
                    package["id"],
                    item.item_type,
                    item.title,
                    compact_text(item.content, 1200),
                    priority=item.priority,
                    included=item.included,
                    source_id=item.source_id,
                    source_type=item.source_type,
                    token_count=item.token_count,
                    truncation_reason=item.truncation_reason,
                    authority_score=item.authority_score,
                    trust_score=item.trust_score,
                    relevance_score=item.relevance_score,
                    metadata=item_metadata,
                )
        else:
            package = {
                "id": "preview-package",
                "session_id": session_id,
                "preview": True,
                "truncated": truncated,
                "metadata_json": json.dumps({"retrieval_audit_id": audit["id"], "preview": True}),
            }

        sections = []
        for item in selected:
            if item.included:
                sections.append(f"## {item.title}\n{item.content}")
        sections.append(f"## Current User Question\n{question}")
        prompt = "\n\n".join(sections)
        return AgentContext(prompt=prompt, context_package=package, retrieval_audit=audit, items=selected, token_counts=token_counts)


def build_agent_context(*args, **kwargs) -> AgentContext:
    return AgentContextBuilder().build(*args, **kwargs)
