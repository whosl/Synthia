"""Phase E: RRF hybrid retrieval."""

from __future__ import annotations

from edagent_vivado.knowledge.retrieval import DEFAULT_RRF_K, fuse_rrf, hybrid_search, rrf_default_min_score
from edagent_vivado.knowledge.semantic_kb import reindex_global, search_semantic_kb
from edagent_vivado.repository.db import get_db, init_db


def test_rrf_prefers_dual_signal_over_single_signal_leader():
    keyword = {"kw_only": 0.8, "vec_only": 0.0, "both": 0.5}
    vector = {"kw_only": 0.0, "vec_only": 0.8, "both": 0.5}
    fused = fuse_rrf(
        set(keyword),
        keyword_scores=keyword,
        vector_scores=vector,
    )
    assert fused["both"] > fused["kw_only"]
    assert fused["both"] > fused["vec_only"]


def test_rrf_formula_matches_reciprocal_rank():
    scores = {"a": 0.9, "b": 0.4}
    fused = fuse_rrf({"a", "b"}, keyword_scores=scores, vector_scores=scores)
    expected = 2.0 / (DEFAULT_RRF_K + 1)
    assert abs(fused["a"] - expected) < 1e-9


def test_rrf_min_score_scales_with_k():
    assert rrf_default_min_score(60) < rrf_default_min_score(10)


def test_hybrid_search_returns_rrf_scores(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "rrf.db"))
    init_db()
    reindex_global()
    out = hybrid_search("Context Builder token budget", top_k=3)
    assert out["results"]
    assert all(h["final_score"] < 0.2 for h in out["results"])
    audit = get_db().execute("SELECT metadata_json FROM retrieval_audits ORDER BY created_at DESC LIMIT 1").fetchone()
    assert audit is not None
    assert "rrf" in (audit["metadata_json"] or "")


def test_semantic_kb_search_still_works_with_rrf():
    reindex_global()
    text, hits = search_semantic_kb("Context Builder token budget", top_k=3)
    assert hits
    assert "Context" in text or any("context" in h["excerpt"].lower() for h in hits)
