"""KB candidate approve should merge into searchable kb_cases."""

import json

from edagent_vivado.kb.error_case_loader import load_effective_cases
from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.store import kb_candidate_approve, kb_candidate_create


def test_approve_merges_into_effective_cases(tmp_path, monkeypatch):
    db_path = tmp_path / "kb.db"
    monkeypatch.setenv("EDAGENT_DB_PATH", str(db_path))
    init_db()

    pattern = r"ERROR: \[Synth 99-999\] test merge pattern"
    cand = kb_candidate_create(
        pattern=pattern,
        likely_causes=["test cause"],
        suggested_actions=["test action"],
        category="test_category",
    )
    merged = kb_candidate_approve(cand["id"])
    assert merged is not None
    assert merged.get("status") == "merged"
    assert merged.get("merged_into_case_id")

    effective = load_effective_cases()
    assert any(c.pattern == pattern for c in effective)

    row = get_db().execute(
        "SELECT * FROM kb_cases WHERE id=?",
        (merged["merged_into_case_id"],),
    ).fetchone()
    assert row is not None
    causes = json.loads(row["likely_causes_json"])
    assert "test cause" in causes
