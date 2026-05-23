"""Tests for keyword semantic KB."""

from edagent_vivado.knowledge.semantic_kb import reindex_global, search_semantic_kb


def test_reindex_and_search():
    stats = reindex_global()
    assert stats["indexed_sources"] >= 1
    assert stats["chunks"] >= 1
    text, hits = search_semantic_kb("Context Builder token budget", top_k=3)
    assert hits
    assert "Context" in text or any("context" in h["excerpt"].lower() for h in hits)
