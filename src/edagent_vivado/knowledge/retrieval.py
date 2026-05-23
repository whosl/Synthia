"""Unified knowledge retrieval with audit records — Phase 2A."""

from __future__ import annotations

import json
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


def hybrid_search(
    query: str,
    *,
    scope: str = "global",
    project_id: str = "",
    top_k: int = 8,
    min_score: float = 0.15,
    session_id: str = "",
    task_id: str = "",
    run_id: str = "",
    persist_audit: bool = True,
) -> dict[str, Any]:
    """Keyword + vector hybrid search with retrieval audit."""
    from edagent_vivado.repository.db import get_db

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

    scored: list[dict[str, Any]] = []
    for row in rows:
        r = dict(row)
        cid = r["id"]
        content = r.get("content") or ""
        title = r.get("title") or ""
        c_tokens = tokenize(content + " " + title)
        kw = len(q_tokens & c_tokens) / max(len(q_tokens), 1) if q_tokens else 0
        vec = vector_hits.get(cid, 0.0)
        authority = float(r.get("authority_score") or 0.7)
        trust = float(r.get("trust_score") or 0.7)
        final = 0.45 * kw + 0.45 * vec + 0.1 * authority
        if final < min_score:
            continue
        scored.append({
            "chunk_id": cid,
            "source_id": r.get("source_id", ""),
            "source_type": r.get("source_type", "doc"),
            "title": f"{r.get('source_title', '')} — {title}",
            "excerpt": content[:320].replace("\n", " "),
            "vector_score": round(vec, 3),
            "keyword_score": round(kw, 3),
            "final_score": round(final, 3),
            "authority_score": authority,
            "trust_score": trust,
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
            metadata={"phase": "2a", "vector_backend": "sqlite-json", "embedding": provider.model},
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
