"""Phase 2 summary model interface and deterministic fallback summarizer."""

from __future__ import annotations

import re
from dataclasses import dataclass


def estimate_tokens(text: str) -> int:
    """Cheap token estimate used for context budgeting/auditing."""
    if not text:
        return 0
    # Good enough for budgeting without binding to a tokenizer provider.
    return max(1, len(text) // 4)


def compact_text(text: str, max_chars: int = 1200) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


@dataclass
class SummaryResult:
    summary: str
    model: str = "heuristic"
    input_tokens: int = 0
    output_tokens: int = 0


class SummaryModel:
    """Abstract summary interface.

    Future implementations can call a smaller/cheaper LLM. The default
    implementation is deterministic so Phase 2 works without new credentials.
    """

    async def summarize_session(self, previous_summary: str, recent_messages: list[dict], tool_summaries: list[str] | None = None) -> SummaryResult:
        chunks: list[str] = []
        if previous_summary:
            chunks.append(f"Previous memory: {compact_text(previous_summary, 900)}")
        if recent_messages:
            lines = []
            for m in recent_messages[-12:]:
                role = m.get("role", "message")
                content = compact_text(m.get("content") or m.get("text") or "", 280)
                if content:
                    lines.append(f"- {role}: {content}")
            if lines:
                chunks.append("Recent conversation:\n" + "\n".join(lines))
        if tool_summaries:
            chunks.append("Recent tool results:\n" + "\n".join(f"- {compact_text(x, 220)}" for x in tool_summaries[-8:]))

        summary = "\n\n".join(chunks).strip()
        summary = compact_text(summary, 2400) or "No durable session memory yet."
        return SummaryResult(summary=summary, input_tokens=estimate_tokens(str(recent_messages)), output_tokens=estimate_tokens(summary))

    async def summarize_tool_result(self, tool_name: str, result: str) -> SummaryResult:
        summary = f"{tool_name}: {compact_text(result, 1000)}"
        return SummaryResult(summary=summary, input_tokens=estimate_tokens(result), output_tokens=estimate_tokens(summary))

    async def summarize_reasoning(self, reasoning: str) -> SummaryResult:
        summary = compact_text(reasoning, 1000)
        return SummaryResult(summary=summary, input_tokens=estimate_tokens(reasoning), output_tokens=estimate_tokens(summary))


def get_summary_model() -> SummaryModel:
    return SummaryModel()
