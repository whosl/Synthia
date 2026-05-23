"""Load and match error cases from the YAML knowledge base."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import yaml


@dataclass
class ErrorCase:
    pattern: str
    category: str
    likely_causes: list[str] = field(default_factory=list)
    suggested_actions: list[str] = field(default_factory=list)


_CASE_CACHE: list[ErrorCase] | None = None


def _default_kb_path() -> Path:
    return Path(__file__).parent / "error_cases.yaml"


def _db_cases() -> list[ErrorCase]:
    """Approved KB cases persisted in SQLite (from merged candidates)."""
    import json

    from edagent_vivado.repository.store import kb_case_list

    out: list[ErrorCase] = []
    for row in kb_case_list(limit=500):
        try:
            likely = json.loads(row.get("likely_causes_json") or "[]")
        except json.JSONDecodeError:
            likely = []
        try:
            actions = json.loads(row.get("suggested_actions_json") or "[]")
        except json.JSONDecodeError:
            actions = []
        out.append(
            ErrorCase(
                pattern=str(row.get("pattern") or ""),
                category=str(row.get("category") or "unknown"),
                likely_causes=likely if isinstance(likely, list) else [],
                suggested_actions=actions if isinstance(actions, list) else [],
            )
        )
    return [c for c in out if c.pattern]


def load_effective_cases(kb_path: str | Path | None = None) -> list[ErrorCase]:
    """Builtin YAML cases plus approved DB cases (deduped by pattern)."""
    builtin = load_cases(kb_path)
    seen = {c.pattern for c in builtin}
    merged = list(builtin)
    for case in _db_cases():
        if case.pattern not in seen:
            merged.append(case)
            seen.add(case.pattern)
    return merged


def load_cases(kb_path: str | Path | None = None) -> list[ErrorCase]:
    """Load error cases from the YAML knowledge base."""
    global _CASE_CACHE
    if _CASE_CACHE is not None and kb_path is None:
        return _CASE_CACHE

    path = Path(kb_path) if kb_path else _default_kb_path()
    if not path.exists():
        _CASE_CACHE = []
        return _CASE_CACHE

    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or []

    cases = [ErrorCase(**item) for item in raw]
    if kb_path is None:
        _CASE_CACHE = cases
    return cases


def match_cases(
    error_signatures: list[str],
    cases: list[ErrorCase] | None = None,
) -> list[tuple[ErrorCase, str]]:
    """Match error signatures against the KB.

    Returns list of (ErrorCase, matched_signature) tuples.
    """
    if cases is None:
        cases = load_cases()

    matches: list[tuple[ErrorCase, str]] = []
    for sig in error_signatures:
        for case in cases:
            try:
                if re.search(case.pattern, sig):
                    matches.append((case, sig))
            except re.error:
                continue
    return matches
