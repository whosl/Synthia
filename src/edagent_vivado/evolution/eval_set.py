"""Eval-set discovery + structural validation (SPEC §22.6B, SE-PR6 stub).

Loads YAML eval sets from ``tests/eval_set/`` (or a directory of the caller's
choice) and validates structure. **Does not execute any case** — the runner
that actually drives cases through the agent loop lands in a later PR.

The loader is intentionally permissive about extra fields; the runner will
read them once it ships. We only enforce:

- file name maps to ``name`` field
- ``cases`` is a non-empty list
- each case has a unique ``id`` plus a non-empty ``question``
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


class EvalSetError(ValueError):
    """Raised when an eval-set YAML is malformed."""


@dataclass
class EvalCase:
    id: str
    question: str
    project_id: str | None = None
    expected: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "question": self.question,
            "project_id": self.project_id,
            "expected": self.expected,
            "metadata": self.metadata,
        }


@dataclass
class EvalSet:
    name: str
    path: Path
    description: str = ""
    cases: list[EvalCase] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "path": str(self.path),
            "description": self.description,
            "case_count": len(self.cases),
            "cases": [c.to_dict() for c in self.cases],
        }


def default_eval_set_dir() -> Path:
    """Resolve ``tests/eval_set/`` relative to the repository root."""
    override = os.environ.get("EDAGENT_EVAL_SET_DIR")
    if override:
        return Path(override).expanduser().resolve()
    # ``src/edagent_vivado/evolution/eval_set.py`` → repo root is parents[3].
    return Path(__file__).resolve().parents[3] / "tests" / "eval_set"


def _ensure_name(name: str, where: str) -> str:
    if not isinstance(name, str) or not name.strip():
        raise EvalSetError(f"{where}: name must be a non-empty string")
    cleaned = name.strip()
    if not _NAME_PATTERN.match(cleaned):
        raise EvalSetError(
            f"{where}: name {cleaned!r} must match [a-z0-9][a-z0-9_-]*"
        )
    return cleaned


def _parse_case(raw: dict, where: str) -> EvalCase:
    if not isinstance(raw, dict):
        raise EvalSetError(f"{where}: case must be a mapping")
    cid = raw.get("id")
    if not isinstance(cid, str) or not cid.strip():
        raise EvalSetError(f"{where}: case requires non-empty `id`")
    question = raw.get("question")
    if not isinstance(question, str) or not question.strip():
        raise EvalSetError(f"{where}: case {cid!r} requires non-empty `question`")
    expected = raw.get("expected") or {}
    if expected and not isinstance(expected, dict):
        raise EvalSetError(f"{where}: case {cid!r} `expected` must be a mapping")
    metadata = raw.get("metadata") or {}
    if metadata and not isinstance(metadata, dict):
        raise EvalSetError(f"{where}: case {cid!r} `metadata` must be a mapping")
    project_id = raw.get("project_id")
    if project_id is not None and not isinstance(project_id, str):
        raise EvalSetError(f"{where}: case {cid!r} `project_id` must be a string")
    return EvalCase(
        id=cid.strip(),
        question=question.strip(),
        project_id=project_id.strip() if isinstance(project_id, str) and project_id.strip() else None,
        expected=dict(expected),
        metadata=dict(metadata),
    )


def load_eval_set(path: str | Path) -> EvalSet:
    """Load + validate one YAML file. Raises ``EvalSetError`` on any issue."""
    try:
        import yaml  # type: ignore
    except ImportError as exc:  # pragma: no cover - yaml is part of base deps
        raise EvalSetError(f"PyYAML not available: {exc}") from exc

    p = Path(path).expanduser().resolve()
    if not p.is_file():
        raise EvalSetError(f"eval set not found: {p}")

    try:
        data = yaml.safe_load(p.read_text(encoding="utf-8"))
    except Exception as exc:
        raise EvalSetError(f"{p}: YAML parse failed: {exc}") from exc
    if not isinstance(data, dict):
        raise EvalSetError(f"{p}: top-level must be a mapping")

    declared = data.get("name")
    if not isinstance(declared, str) or not declared.strip():
        raise EvalSetError(f"{p}: `name` field required")
    name = _ensure_name(declared, str(p))

    expected_name = _ensure_name(p.stem, str(p))
    if name != expected_name:
        raise EvalSetError(
            f"{p}: `name` ({name!r}) must match filename stem ({expected_name!r})"
        )

    cases_raw = data.get("cases") or []
    if not isinstance(cases_raw, list) or not cases_raw:
        raise EvalSetError(f"{p}: `cases` must be a non-empty list")

    seen: set[str] = set()
    cases: list[EvalCase] = []
    for entry in cases_raw:
        case = _parse_case(entry, str(p))
        if case.id in seen:
            raise EvalSetError(f"{p}: duplicate case id {case.id!r}")
        seen.add(case.id)
        cases.append(case)

    desc = str(data.get("description") or "").strip()
    return EvalSet(name=name, path=p, description=desc, cases=cases)


def discover_eval_sets(root: str | Path | None = None) -> list[EvalSet]:
    """Discover every ``*.yaml`` file in the eval-set directory.

    Invalid files are logged at WARNING level and skipped so the CLI / API can
    still surface the valid ones.
    """
    root_path = Path(root) if root else default_eval_set_dir()
    if not root_path.is_dir():
        return []
    out: list[EvalSet] = []
    for candidate in sorted(root_path.iterdir()):
        if not candidate.is_file() or candidate.suffix.lower() not in (".yaml", ".yml"):
            continue
        try:
            out.append(load_eval_set(candidate))
        except EvalSetError as exc:
            logger.warning("eval set skipped: %s", exc)
    return out


def get_eval_set(name: str, root: str | Path | None = None) -> EvalSet:
    """Load one eval set by its declared name."""
    root_path = Path(root) if root else default_eval_set_dir()
    cleaned = _ensure_name(name, "get_eval_set")
    for ext in (".yaml", ".yml"):
        candidate = root_path / f"{cleaned}{ext}"
        if candidate.is_file():
            return load_eval_set(candidate)
    raise EvalSetError(f"eval set {cleaned!r} not found under {root_path}")
