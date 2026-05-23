"""Semantic KB indexing and search — Phase 2A hybrid retrieval."""

from __future__ import annotations

import hashlib
import re
import time
from pathlib import Path
from typing import Any

from edagent_vivado.knowledge.embedding import get_embedding_provider
from edagent_vivado.knowledge.retrieval import hybrid_search, rewrite_query
from edagent_vivado.knowledge.vector_store import get_vector_store
from edagent_vivado.repository.db import get_db

DEFAULT_DOC_GLOBS = ("SPEC.md", "VIVADO_COMMANDS.md", "README.md")
PROJECT_DOC_GLOBS = ("examples/*/eda.yaml", "examples/*/README.md")
CHUNK_MAX_CHARS = 900


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _chunk_markdown(text: str, source_id: str) -> list[tuple[str, str, int]]:
    parts = re.split(r"\n(?=#{1,3}\s)", text)
    chunks: list[tuple[str, str, int]] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        lines = part.splitlines()
        title = lines[0].lstrip("#").strip() if lines else source_id
        body = "\n".join(lines[1:]).strip() if len(lines) > 1 else part
        if len(body) > CHUNK_MAX_CHARS:
            for j in range(0, len(body), CHUNK_MAX_CHARS):
                sub = body[j : j + CHUNK_MAX_CHARS]
                chunks.append((f"{title} ({j // CHUNK_MAX_CHARS + 1})", sub, len(chunks)))
        else:
            chunks.append((title, body or part, len(chunks)))
    return chunks or [(source_id, text[:CHUNK_MAX_CHARS], 0)]


def _index_file(
    path: Path,
    *,
    scope: str,
    project_id: str = "",
    source_type: str = "repo_markdown",
    authority: float = 0.85,
    trust: float = 0.8,
) -> int:
    if not path.is_file():
        return 0
    root = _repo_root()
    try:
        rel = str(path.relative_to(root))
    except ValueError:
        rel = str(path)
    text = path.read_text(encoding="utf-8", errors="replace")
    sha = hashlib.sha256(text.encode()).hexdigest()[:16]
    sid = f"{scope}-{hashlib.md5(rel.encode()).hexdigest()[:10]}"
    db = get_db()
    now = int(time.time())

    existing = db.execute("SELECT id FROM knowledge_sources WHERE id=?", (sid,)).fetchone()
    if existing:
        db.execute(
            "UPDATE knowledge_sources SET title=?, path=?, sha256=?, scope=?, project_id=?, indexed_at=?, updated_at=?, source_type=? WHERE id=?",
            (path.name, str(path), sha, scope, project_id or None, now, now, source_type, sid),
        )
    else:
        db.execute(
            "INSERT INTO knowledge_sources(id,scope,project_id,source_type,title,path,authority_score,trust_score,sha256,indexed_at,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, scope, project_id or None, source_type, path.name, str(path), authority, trust, sha, now, now, now, "{}"),
        )

    db.execute("DELETE FROM knowledge_chunks WHERE source_id=?", (sid,))
    chunk_ids: list[str] = []
    texts: list[str] = []
    count = 0
    for title, content, idx in _chunk_markdown(text, rel):
        cid = f"{sid}-{idx}"
        db.execute(
            "INSERT INTO knowledge_chunks(id,source_id,scope,project_id,chunk_index,title,content,token_count,authority_score,trust_score,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (cid, sid, scope, project_id or None, idx, title, content, max(1, len(content) // 4), authority, trust, now, now, "{}"),
        )
        chunk_ids.append(cid)
        texts.append(f"{title}\n{content}")
        count += 1

    provider = get_embedding_provider()
    get_vector_store().upsert_chunks(chunk_ids, texts, provider)
    return count


def reindex_global(extra_paths: list[str] | None = None) -> dict[str, Any]:
    root = _repo_root()
    paths = list(DEFAULT_DOC_GLOBS) + (extra_paths or [])
    total_chunks = 0
    sources = 0
    for rel in paths:
        n = _index_file(root / rel, scope="global")
        if n:
            sources += 1
            total_chunks += n
    get_db().commit()
    return {"indexed_sources": sources, "chunks": total_chunks, "root": str(root), "scope": "global"}


def reindex_project(project_id: str = "uart_demo") -> dict[str, Any]:
    root = _repo_root() / "examples" / project_id
    if not root.is_dir():
        return {"indexed_sources": 0, "chunks": 0, "project_id": project_id}
    total = 0
    sources = 0
    for pattern in ("*.md", "eda.yaml", "constrs/*.xdc", "rtl/*.v"):
        for path in root.glob(pattern):
            n = _index_file(path, scope="project", project_id=project_id, source_type="project_doc", authority=0.75, trust=0.75)
            if n:
                sources += 1
                total += n
    get_db().commit()
    return {"indexed_sources": sources, "chunks": total, "project_id": project_id, "scope": "project"}


def reindex_all(project_id: str = "uart_demo") -> dict[str, Any]:
    g = reindex_global()
    p = reindex_project(project_id)
    return {"global": g, "project": p}


def search_semantic_kb(
    query: str,
    top_k: int = 6,
    min_score: float = 0.15,
    scope: str = "both",
    project_id: str = "uart_demo",
    session_id: str = "",
    task_id: str = "",
    run_id: str = "",
    persist_audit: bool = True,
) -> tuple[str, list[dict]]:
    """Hybrid search. scope=both uses one query (project scope includes global chunks)."""
    if scope == "both":
        if project_id:
            out = hybrid_search(
                query,
                scope="project",
                project_id=project_id,
                top_k=top_k,
                min_score=min_score,
                session_id=session_id,
                task_id=task_id,
                run_id=run_id,
                persist_audit=persist_audit,
            )
        else:
            out = hybrid_search(
                query,
                scope="global",
                top_k=top_k,
                min_score=min_score,
                session_id=session_id,
                task_id=task_id,
                run_id=run_id,
                persist_audit=persist_audit,
            )
        return out["formatted"], out["results"]

    sco = "project" if scope == "project" else "global"
    out = hybrid_search(
        query,
        scope=sco,
        project_id=project_id if sco == "project" else "",
        top_k=top_k,
        min_score=min_score,
        session_id=session_id,
        task_id=task_id,
        run_id=run_id,
        persist_audit=persist_audit,
    )
    return out["formatted"], out["results"]
