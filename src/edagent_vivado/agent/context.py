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
from edagent_vivado.kb.error_case_loader import load_cases, match_cases
from edagent_vivado.repository.store import (
    context_package_create,
    context_package_item_create,
    memory_latest,
    message_list,
    retrieval_audit_create,
    retrieval_audit_item_create,
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
    matches = match_cases(signatures, load_cases())
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


def _semantic_kb_stub(question: str) -> tuple[str, list[dict]]:
    """Phase 2 retrieval audit stub.

    Phase 2A will replace this with vector search/rerank. For Phase 2 we still
    create auditable retrieval records so the UI/API contract is stable.
    """
    candidates = [
        {
            "source_type": "spec",
            "source_id": "SPEC.md",
            "title": "SPEC.md — Context Builder and Vivado Runtime",
            "excerpt": "Context Builder injects session memory, recent messages, Error KB, Semantic KB, tool summaries, and project context with token budgeting and audit records.",
            "score": 0.62,
        },
        {
            "source_type": "doc",
            "source_id": "VIVADO_COMMANDS.md",
            "title": "Vivado command support matrix",
            "excerpt": "Vivado commands are routed through the Runtime Adapter with TclPolicy, artifacts, monitor events, and parser/problem collection.",
            "score": 0.58,
        },
    ]
    if not question.strip():
        return "", []
    lines = [f"- {c['title']} (score={c['score']}): {c['excerpt']}" for c in candidates]
    return "\n".join(lines), candidates


class AgentContextBuilder:
    def __init__(self, max_context_tokens: int | None = None, recent_message_limit: int | None = None):
        self.max_context_tokens = max_context_tokens or int(os.environ.get("EDAGENT_MAX_CONTEXT_TOKENS", "64000"))
        self.recent_message_limit = recent_message_limit or int(os.environ.get("EDAGENT_RECENT_MESSAGE_LIMIT", "20"))

    def build(self, session_id: str, task_id: str, run_id: str, question: str,
              manifest_path: str = "", agent_id: str = "", model: str = "") -> AgentContext:
        items: list[ContextItem] = []
        token_counts: dict[str, int] = {}

        project = _project_context(manifest_path)
        if project:
            items.append(ContextItem("project_context", "Project / Manifest Context", project, priority=3, trust_score=0.8))

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

        semantic_text, semantic_hits = _semantic_kb_stub(question)
        if semantic_text:
            items.append(ContextItem("semantic_kb", "Retrieved Semantic Knowledge", semantic_text, priority=8, source_type="semantic_kb", authority_score=0.7, trust_score=0.65, relevance_score=0.6))

        # Token budget selection. Phase 2 uses priority ordering and truncates low-priority items first.
        selected: list[ContextItem] = []
        running_tokens = estimate_tokens(question)
        for item in sorted(items, key=lambda x: x.priority):
            if running_tokens + item.token_count <= self.max_context_tokens:
                selected.append(item)
                running_tokens += item.token_count
            else:
                item.included = False
                item.truncation_reason = "max_context_tokens"
                selected.append(item)

        for item in selected:
            token_counts[item.item_type] = token_counts.get(item.item_type, 0) + (item.token_count if item.included else 0)
        token_counts["question"] = estimate_tokens(question)
        token_counts["total"] = sum(token_counts.values())

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
            metadata={"phase": "2", "vector_backend": "stub"},
        )
        for hit in semantic_hits:
            retrieval_audit_item_create(
                audit["id"], hit["source_type"], title=hit["title"], excerpt=hit["excerpt"],
                selected=True, source_id=hit["source_id"], final_score=hit["score"],
                authority_score=0.7, trust_score=0.65, token_count=estimate_tokens(hit["excerpt"]),
            )
        for rec in error_records:
            retrieval_audit_item_create(
                audit["id"], "error_kb", title=rec["category"], excerpt=json.dumps(rec, ensure_ascii=False),
                selected=True, source_id=rec["pattern"], final_score=0.82,
                authority_score=0.82, trust_score=0.82, token_count=estimate_tokens(str(rec)),
            )

        package = context_package_create(
            session_id=session_id,
            task_id=task_id,
            run_id=run_id,
            agent_id=agent_id,
            model=model or os.environ.get("EDAGENT_MODEL", ""),
            max_context_tokens=self.max_context_tokens,
            token_counts=token_counts,
            truncated=any(not i.included for i in selected),
            metadata={"retrieval_audit_id": audit["id"], "phase": "2"},
        )
        for item in selected:
            context_package_item_create(
                package["id"], item.item_type, item.title, compact_text(item.content, 1200),
                priority=item.priority, included=item.included, source_id=item.source_id,
                source_type=item.source_type, token_count=item.token_count,
                truncation_reason=item.truncation_reason, authority_score=item.authority_score,
                trust_score=item.trust_score, relevance_score=item.relevance_score,
            )

        sections = []
        for item in selected:
            if item.included:
                sections.append(f"## {item.title}\n{item.content}")
        sections.append(f"## Current User Question\n{question}")
        prompt = "\n\n".join(sections)
        return AgentContext(prompt=prompt, context_package=package, retrieval_audit=audit, items=selected, token_counts=token_counts)


def build_agent_context(*args, **kwargs) -> AgentContext:
    return AgentContextBuilder().build(*args, **kwargs)
