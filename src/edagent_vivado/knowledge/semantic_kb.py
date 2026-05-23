"""Keyword-based semantic KB (Phase 2A skeleton). Indexes repo docs into knowledge_chunks."""

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any

from edagent_vivado.repository.db import get_db

DEFAULT_DOC_GLOBS = ("SPEC.md", "VIVADO_COMMANDS.md", "README.md", "arch.md")
CHUNK_MAX_CHARS = 900


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _tokenize(text: str) -> set[str]:
    return {t.lower() for t in re.findall(r"[a-zA-Z0-9_./-]{2,}", text)}


def _chunk_markdown(text: str, source_id: str) -> list[tuple[str, str, int]]:
    """Split markdown into (title, content, index) chunks."""
    parts = re.split(r"\n(?=#{1,3}\s)", text)
    chunks: list[tuple[str, str, int]] = []
    for i, part in enumerate(parts):
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


def reindex_global(extra_paths: list[str] | None = None) -> dict[str, Any]:
    """Index global markdown sources into knowledge_sources + knowledge_chunks."""
    root = _repo_root()
    paths = list(DEFAULT_DOC_GLOBS) + (extra_paths or [])
    db = get_db()
    now = int(time.time())
    indexed = 0
    chunk_count = 0

    db.execute("DELETE FROM knowledge_chunks WHERE scope='global'")
  # keep sources, refresh below
    for rel in paths:
        path = root / rel
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        sha = hashlib.sha256(text.encode()).hexdigest()[:16]
        sid = f"global-{rel.replace('/', '-')}"

        existing = db.execute("SELECT id FROM knowledge_sources WHERE id=?", (sid,)).fetchone()
        if existing:
            db.execute(
                "UPDATE knowledge_sources SET title=?, path=?, sha256=?, indexed_at=?, updated_at=? WHERE id=?",
                (rel, str(path), sha, now, now, sid),
            )
        else:
            db.execute(
                "INSERT INTO knowledge_sources(id,scope,source_type,title,path,authority_score,trust_score,sha256,indexed_at,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (sid, "global", "repo_markdown", rel, str(path), 0.85, 0.8, sha, now, now, now, "{}"),
            )

        db.execute("DELETE FROM knowledge_chunks WHERE source_id=?", (sid,))
        for title, content, idx in _chunk_markdown(text, rel):
            cid = f"{sid}-{idx}"
            db.execute(
                "INSERT INTO knowledge_chunks(id,source_id,scope,chunk_index,title,content,token_count,authority_score,trust_score,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (cid, sid, "global", idx, title, content, max(1, len(content) // 4), 0.85, 0.8, now, now, "{}"),
            )
            chunk_count += 1
        indexed += 1

    db.commit()
    return {"indexed_sources": indexed, "chunks": chunk_count, "root": str(root)}


def search_semantic_kb(query: str, top_k: int = 6, min_score: float = 0.12) -> tuple[str, list[dict]]:
    """Return (formatted_text, hit_records) for Context Builder / audit."""
    q_tokens = _tokenize(query)
    if not q_tokens:
        return "", []

    db = get_db()
    n = db.execute("SELECT COUNT(*) AS n FROM knowledge_chunks WHERE scope='global'").fetchone()
    if not n or n["n"] == 0:
        reindex_global()

    rows = db.execute(
        "SELECT c.id, c.source_id, c.title, c.content, c.authority_score, c.trust_score, s.title AS source_title "
        "FROM knowledge_chunks c JOIN knowledge_sources s ON c.source_id=s.id WHERE c.scope='global'"
    ).fetchall()

    hits: list[dict] = []
    for row in rows:
        r = dict(row)
        content = r.get("content") or ""
        title = r.get("title") or ""
        c_tokens = _tokenize(content + " " + title)
        if not c_tokens:
            continue
        overlap = len(q_tokens & c_tokens)
        score = overlap / max(len(q_tokens), 1)
        if title.lower() in query.lower():
            score += 0.15
        if score < min_score:
            continue
        excerpt = content[:320].replace("\n", " ")
        hits.append({
            "source_type": "semantic_kb",
            "source_id": r.get("source_id", ""),
            "chunk_id": r.get("id", ""),
            "title": f"{r.get('source_title', '')} — {title}",
            "excerpt": excerpt,
            "score": round(min(1.0, score), 3),
            "authority_score": float(r.get("authority_score") or 0.7),
            "trust_score": float(r.get("trust_score") or 0.7),
        })

    hits.sort(key=lambda h: h["score"], reverse=True)
    hits = hits[:top_k]
    if not hits:
        return "", []

    lines = [f"- {h['title']} (score={h['score']}): {h['excerpt']}" for h in hits]
    return "\n".join(lines), hits
