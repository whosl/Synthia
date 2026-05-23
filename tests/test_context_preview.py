"""Context preview must not persist packages or audits."""

from edagent_vivado.agent.context import AgentContextBuilder
from edagent_vivado.repository.db import get_db, init_db


def _count_table(table: str) -> int:
    row = get_db().execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()
    return int(row["n"]) if row else 0


def test_context_preview_does_not_write_db(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "preview.db"))
    init_db()

    pkg_before = _count_table("context_packages")
    audit_before = _count_table("retrieval_audits")

    ctx = AgentContextBuilder().build(
        "preview-session",
        "preview-task",
        "preview-run",
        "timing WNS slack",
        persist=False,
    )

    assert ctx.context_package.get("id") == "preview-package"
    assert ctx.context_package.get("preview") is True
    assert ctx.retrieval_audit and ctx.retrieval_audit.get("preview") is True
    assert ctx.prompt
    assert _count_table("context_packages") == pkg_before
    assert _count_table("retrieval_audits") == audit_before
