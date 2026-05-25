"""Unified knowledge retrieval with audit records — Phase 2A / Phase E RRF."""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

from edagent_vivado.knowledge.embedding import get_embedding_provider
from edagent_vivado.knowledge.text import tokenize
from edagent_vivado.knowledge.vector_store import get_vector_store
from edagent_vivado.repository.store import (
    retrieval_audit_create,
    retrieval_audit_item_create,
)

DEFAULT_RRF_K = 60
RRF_AUTHORITY_MIN = 0.85
RRF_AUTHORITY_WEIGHT = 0.5


def rrf_default_min_score(k: int | None = None) -> float:
    """Scale floor with K so filtering stays meaningful when K changes."""
    rrf_k = k if k is not None else _rrf_k()
    return 0.5 / (rrf_k + 10)


def rewrite_query(query: str) -> str:
    """Light query rewrite — expand EDA terms."""
    q = query.strip()
    extras: list[str] = []
    lower = q.lower()
    if "timing" in lower or "wns" in lower:
        extras.append("timing slack WNS TNS")
    if "vivado" in lower or "synth" in lower:
        extras.append("Vivado synthesis implementation")
    if "xdc" in lower or "constraint" in lower:
        extras.append("constraints XDC pin assignment")
    if extras:
        return f"{q} {' '.join(extras)}"
    return q


def extract_entities(query: str) -> dict[str, Any]:
    return {
        "files": re.findall(r"[\w./\\:-]+\.(?:v|sv|vhd|xdc|tcl|yaml|md)", query, flags=re.I),
        "modules": re.findall(r"\b([A-Za-z_]\w*_(?:top|rx|tx))\b", query),
    }


def _rrf_k() -> int:
    try:
        return max(1, int(os.environ.get("EDAGENT_RRF_K", str(DEFAULT_RRF_K))))
    except ValueError:
        return DEFAULT_RRF_K


def _rank_by_score(scores: dict[str, float]) -> dict[str, int]:
    """Map chunk_id → 1-based rank (higher score = lower rank number)."""
    ordered = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    return {chunk_id: idx + 1 for idx, (chunk_id, _) in enumerate(ordered)}


def fuse_rrf(
    chunk_ids: set[str],
    *,
    keyword_scores: dict[str, float],
    vector_scores: dict[str, float],
    authority_scores: dict[str, float] | None = None,
    k: int | None = None,
) -> dict[str, float]:
    """Reciprocal Rank Fusion across keyword, vector, and authority rank lists."""
    rrf_k = k if k is not None else _rrf_k()
    kw_ranks = _rank_by_score({cid: keyword_scores.get(cid, 0.0) for cid in chunk_ids})
    vec_ranks = _rank_by_score({cid: vector_scores.get(cid, 0.0) for cid in chunk_ids})
    auth = authority_scores or {}
    auth_ranks = _rank_by_score({cid: auth.get(cid, 0.0) for cid in chunk_ids}) if auth else {}

    fused: dict[str, float] = {}
    for cid in chunk_ids:
        score = 0.0
        if cid in kw_ranks and keyword_scores.get(cid, 0.0) > 0:
            score += 1.0 / (rrf_k + kw_ranks[cid])
        if cid in vec_ranks and vector_scores.get(cid, 0.0) > 0:
            score += 1.0 / (rrf_k + vec_ranks[cid])
        authority = float(auth.get(cid, 0.0) or 0.0)
        if auth_ranks and authority >= RRF_AUTHORITY_MIN:
            score += RRF_AUTHORITY_WEIGHT / (rrf_k + auth_ranks[cid])
        fused[cid] = score
    return fused


def hybrid_search(
    query: str,
    *,
    scope: str = "global",
    project_id: str = "",
    top_k: int = 8,
    min_score: float | None = None,
    session_id: str = "",
    task_id: str = "",
    run_id: str = "",
    persist_audit: bool = True,
) -> dict[str, Any]:
    """Keyword + vector hybrid search with RRF fusion and retrieval audit."""
    from edagent_vivado.repository.db import get_db

    score_floor = rrf_default_min_score() if min_score is None else min_score
    rewritten = rewrite_query(query)
    db = get_db()
    n = db.execute("SELECT COUNT(*) AS n FROM knowledge_chunks").fetchone()
    if not n or n["n"] == 0:
        from edagent_vivado.knowledge.semantic_kb import reindex_global

        reindex_global()

    provider = get_embedding_provider()
    vstore = get_vector_store()
    q_tokens = tokenize(rewritten)

    scope_clause = "c.scope='global'"
    params: list[Any] = []
    if scope == "project" and project_id:
        scope_clause = "(c.scope='global' OR (c.scope='project' AND c.project_id=?))"
        params.append(project_id)

    rows = db.execute(
        f"""SELECT c.id, c.source_id, c.title, c.content, c.authority_score, c.trust_score,
                   c.scope, c.project_id, s.title AS source_title, s.source_type
            FROM knowledge_chunks c
            JOIN knowledge_sources s ON c.source_id=s.id
            WHERE {scope_clause}""",
        params,
    ).fetchall()

    vector_hits = {h.chunk_id: h.vector_score for h in vstore.search(rewritten, top_k=top_k * 2, provider=provider)}

    keyword_scores: dict[str, float] = {}
    vector_scores: dict[str, float] = {}
    authority_scores: dict[str, float] = {}
    row_by_id: dict[str, dict[str, Any]] = {}

    for row in rows:
        r = dict(row)
        cid = r["id"]
        content = r.get("content") or ""
        title = r.get("title") or ""
        c_tokens = tokenize(content + " " + title)
        kw = len(q_tokens & c_tokens) / max(len(q_tokens), 1) if q_tokens else 0.0
        vec = float(vector_hits.get(cid, 0.0))
        authority = float(r.get("authority_score") or 0.7)
        keyword_scores[cid] = kw
        vector_scores[cid] = vec
        authority_scores[cid] = authority
        row_by_id[cid] = r

    candidate_ids = {
        cid
        for cid in row_by_id
        if keyword_scores.get(cid, 0.0) > 0 or vector_scores.get(cid, 0.0) > 0
    }
    fused = fuse_rrf(
        candidate_ids,
        keyword_scores=keyword_scores,
        vector_scores=vector_scores,
        authority_scores=authority_scores,
    )

    scored: list[dict[str, Any]] = []
    for cid, final in fused.items():
        if final < score_floor:
            continue
        r = row_by_id[cid]
        content = r.get("content") or ""
        title = r.get("title") or ""
        kw = keyword_scores[cid]
        vec = vector_scores[cid]
        authority = authority_scores[cid]
        scored.append({
            "chunk_id": cid,
            "source_id": r.get("source_id", ""),
            "source_type": r.get("source_type", "doc"),
            "title": f"{r.get('source_title', '')} — {title}",
            "excerpt": content[:320].replace("\n", " "),
            "vector_score": round(vec, 3),
            "keyword_score": round(kw, 3),
            "final_score": round(final, 4),
            "authority_score": authority,
            "trust_score": float(r.get("trust_score") or 0.7),
            "scope": r.get("scope", "global"),
        })

    scored.sort(key=lambda x: x["final_score"], reverse=True)
    results = scored[:top_k]

    audit_id: str | None = None
    if persist_audit:
        audit = retrieval_audit_create(
            session_id=session_id,
            task_id=task_id,
            run_id=run_id,
            query=query,
            rewritten_query=rewritten,
            intent={"entities": extract_entities(query), "scope": scope},
            filters={"scope": scope, "project_id": project_id or None},
            candidate_count=len(scored),
            selected_count=len(results),
            rejected_count=max(0, len(scored) - len(results)),
            token_budget=0,
            token_used=0,
            metadata={"phase": "2e", "vector_backend": "sqlite-json", "embedding": provider.model, "retrieval": "rrf", "rrf_k": _rrf_k()},
        )
        audit_id = audit["id"]
        for hit in results:
            retrieval_audit_item_create(
                audit_id,
                hit["source_type"],
                title=hit["title"],
                excerpt=hit["excerpt"],
                selected=True,
                source_id=hit["source_id"],
                chunk_id=hit["chunk_id"],
                vector_score=hit["vector_score"],
                final_score=hit["final_score"],
                authority_score=hit["authority_score"],
                trust_score=hit["trust_score"],
            )

    formatted = "\n".join(
        f"- {h['title']} (score={h['final_score']}): {h['excerpt']}" for h in results
    )
    return {
        "audit_id": audit_id,
        "results": results,
        "formatted": formatted,
        "rewritten_query": rewritten,
    }
