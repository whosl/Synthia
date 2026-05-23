"""scope=both should not double-write retrieval audits."""

from edagent_vivado.knowledge.semantic_kb import reindex_global, search_semantic_kb
from edagent_vivado.repository.db import get_db, init_db


def test_both_scope_single_audit(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "sem.db"))
    init_db()
    reindex_global()

    before = get_db().execute("SELECT COUNT(*) AS n FROM retrieval_audits").fetchone()["n"]
    _text, _hits = search_semantic_kb(
        "Vivado synthesis context",
        scope="both",
        project_id="uart_demo",
        session_id="s-audit",
        task_id="t-audit",
        run_id="r-audit",
        persist_audit=True,
    )
    after = get_db().execute("SELECT COUNT(*) AS n FROM retrieval_audits").fetchone()["n"]
    assert after - before == 1
