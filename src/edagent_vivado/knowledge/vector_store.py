"""Vector store abstraction backed by SQLite knowledge_embeddings."""

from __future__ import annotations

import json
import time
from typing import Any, Protocol

from edagent_vivado.knowledge.embedding import EmbeddingProvider, cosine_similarity, get_embedding_provider
from edagent_vivado.repository.db import get_db


class VectorHit:
    def __init__(self, chunk_id: str, score: float, vector_score: float) -> None:
        self.chunk_id = chunk_id
        self.score = score
        self.vector_score = vector_score


class VectorStore(Protocol):
    def upsert_chunks(self, chunk_ids: list[str], texts: list[str], provider: EmbeddingProvider) -> int: ...
    def search(self, query: str, top_k: int, provider: EmbeddingProvider) -> list[VectorHit]: ...


class SqliteVectorStore:
    """Stores vectors in knowledge_embeddings.vector_ref as JSON arrays."""

    def __init__(self, store_name: str = "sqlite-json") -> None:
        self.store_name = store_name

    def upsert_chunks(self, chunk_ids: list[str], texts: list[str], provider: EmbeddingProvider) -> int:
        if not chunk_ids:
            return 0
        vectors = provider.embed_documents(texts)
        db = get_db()
        now = int(time.time())
        count = 0
        for cid, vec in zip(chunk_ids, vectors):
            eid = f"emb-{cid}"
            db.execute("DELETE FROM knowledge_embeddings WHERE chunk_id=?", (cid,))
            db.execute(
                "INSERT INTO knowledge_embeddings(id,chunk_id,provider,model,dimension,vector_store,vector_ref,indexed_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    eid,
                    cid,
                    provider.provider,
                    provider.model,
                    len(vec),
                    self.store_name,
                    json.dumps(vec),
                    now,
                    "{}",
                ),
            )
            count += 1
        db.commit()
        return count

    def search(self, query: str, top_k: int, provider: EmbeddingProvider) -> list[VectorHit]:
        qvec = provider.embed_query(query)
        rows = get_db().execute(
            "SELECT chunk_id, vector_ref FROM knowledge_embeddings WHERE vector_store=?",
            (self.store_name,),
        ).fetchall()
        hits: list[VectorHit] = []
        for row in rows:
            try:
                vec = json.loads(row["vector_ref"])
            except (json.JSONDecodeError, TypeError):
                continue
            score = cosine_similarity(qvec, vec)
            if score > 0.05:
                hits.append(VectorHit(str(row["chunk_id"]), score, score))
        hits.sort(key=lambda h: h.score, reverse=True)
        return hits[:top_k]


def get_vector_store() -> VectorStore:
    return SqliteVectorStore()
