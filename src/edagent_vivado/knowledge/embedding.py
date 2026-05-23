"""Embedding provider abstraction — Phase 2A (hash fallback, no extra deps)."""

from __future__ import annotations

import hashlib
import math
import os
import re
from abc import ABC, abstractmethod
from typing import Protocol


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-zA-Z0-9_./-]{2,}", (text or "").lower())


class EmbeddingProvider(Protocol):
    model: str
    provider: str
    dimension: int

    def embed_query(self, text: str) -> list[float]: ...
    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...


class HashEmbeddingProvider:
    """Deterministic bag-of-words hash embedding — works offline without API keys."""

    provider = "hash"
    model = "hash-bow-v1"

    def __init__(self, dimension: int | None = None) -> None:
        self.dimension = dimension or int(os.environ.get("EDAGENT_EMBEDDING_DIM", "384"))

    def _embed_one(self, text: str) -> list[float]:
        vec = [0.0] * self.dimension
        for tok in _tokenize(text):
            idx = int(hashlib.md5(tok.encode()).hexdigest(), 16) % self.dimension
            vec[idx] += 1.0
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [x / norm for x in vec]

    def embed_query(self, text: str) -> list[float]:
        return self._embed_one(text)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_one(t) for t in texts]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if len(a) != len(b) or not a:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    return max(0.0, min(1.0, dot))


def get_embedding_provider() -> EmbeddingProvider:
    """Factory — hash provider by default; extend for API models later."""
    return HashEmbeddingProvider()
