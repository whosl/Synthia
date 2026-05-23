"""Knowledge layer — semantic indexing and hybrid retrieval."""

from edagent_vivado.knowledge.semantic_kb import reindex_all, reindex_global, reindex_project, search_semantic_kb

__all__ = [
    "reindex_global",
    "reindex_project",
    "reindex_all",
    "search_semantic_kb",
]
