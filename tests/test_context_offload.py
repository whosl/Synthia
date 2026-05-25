"""Phase E: context offload ratios in AgentContextBuilder."""

from __future__ import annotations

from edagent_vivado.agent.context import (
    AgentContextBuilder,
    ContextItem,
    OFFLOAD_KEEP_AGGRESSIVE,
    OFFLOAD_KEEP_MILD,
    _fit_context_item,
    _offload_keep_ratios,
)


def test_offload_keep_ratios_modes():
    assert _offload_keep_ratios("off") == [1.0]
    assert _offload_keep_ratios("mild") == [1.0, OFFLOAD_KEEP_MILD]
    assert _offload_keep_ratios("aggressive") == [1.0, OFFLOAD_KEEP_MILD, OFFLOAD_KEEP_AGGRESSIVE]
    assert _offload_keep_ratios("auto") == [1.0, OFFLOAD_KEEP_MILD, OFFLOAD_KEEP_AGGRESSIVE]


def test_fit_context_item_mild_offload():
    item = ContextItem("semantic_kb", "KB", "word " * 80, priority=8)
    fitted, tokens = _fit_context_item(
        item,
        running_tokens=50,
        budget=120,
        keep_ratios=[1.0, OFFLOAD_KEEP_MILD],
    )
    assert fitted is True
    assert tokens > 0
    assert item.truncation_reason == "offload_mild"
    assert len(item.content) < len("word " * 80)


def test_fit_context_item_aggressive_offload():
    item = ContextItem("semantic_kb", "KB", "chunk " * 120, priority=8)
    fitted, tokens = _fit_context_item(
        item,
        running_tokens=20,
        budget=80,
        keep_ratios=[1.0, OFFLOAD_KEEP_MILD, OFFLOAD_KEEP_AGGRESSIVE],
    )
    assert fitted is True
    assert item.truncation_reason == "offload_aggressive"
    assert tokens <= 80


def test_builder_offload_includes_low_priority_item(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "offload.db"))
    monkeypatch.setenv("EDAGENT_CONTEXT_OFFLOAD", "auto")

    from edagent_vivado.repository.db import init_db
    from edagent_vivado.repository.store import session_create, migrate_orphan_sessions_to_default_project

    init_db()
    pid = migrate_orphan_sessions_to_default_project()
    sess = session_create(name="offload", project_id=pid)

    builder = AgentContextBuilder(max_context_tokens=180, offload_mode="auto")
    ctx = builder.build(
        sess["id"],
        "task-1",
        "run-1",
        "hello",
        persist=False,
    )

    included = [i for i in ctx.items if i.included]
    offloaded = [i for i in ctx.items if i.truncation_reason.startswith("offload_")]
    assert included
    assert offloaded or any(i.truncation_reason == "max_context_tokens" for i in ctx.items)
