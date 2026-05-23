"""Shared text utilities for knowledge indexing and retrieval."""

from __future__ import annotations

import re


def tokenize(text: str) -> set[str]:
    return {t.lower() for t in re.findall(r"[a-zA-Z0-9_./-]{2,}", text or "")}
