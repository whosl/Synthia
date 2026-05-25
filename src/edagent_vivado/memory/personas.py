"""L3 project persona — synthesize persona.md from scenarios and atoms."""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from edagent_vivado.repository.store import (
    atom_count,
    atom_list,
    persona_create,
    persona_latest,
    persona_next_version,
    project_get,
    settings_get,
    settings_set,
)
from edagent_vivado.memory.scenarios import list_scenarios_for_project, read_scenario_md


def _runtime_root() -> Path:
    return Path(os.environ.get("EDAGENT_RUNTIME_DIR", ".edagent"))


def _persona_rel_path(project_id: str) -> str:
    return f"projects/{project_id}/memory/persona.md"


def _persona_path(project_id: str) -> Path:
    p = _runtime_root() / _persona_rel_path(project_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _project_state_key(project_id: str) -> str:
    return f"memory_project:{project_id}"


def _load_project_state(project_id: str) -> dict[str, Any]:
    state = settings_get(_project_state_key(project_id), default=None)
    return state if isinstance(state, dict) else {"last_persona_atom_count": 0, "persona_dirty": False}


def _save_project_state(project_id: str, state: dict[str, Any]) -> None:
    settings_set(_project_state_key(project_id), state)


def mark_project_persona_dirty(project_id: str) -> None:
    """Mark persona stale (e.g. after evolution config atom) without immediate rebuild."""
    if not project_id:
        return
    state = _load_project_state(project_id)
    state["persona_dirty"] = True
    _save_project_state(project_id, state)


def rebuild_persona_if_dirty(project_id: str) -> dict | None:
    """Force-rebuild persona once when marked dirty; clears the dirty flag."""
    if not project_id:
        return None
    state = _load_project_state(project_id)
    if not state.get("persona_dirty"):
        return None
    row = build_project_persona(project_id, force=True)
    state = _load_project_state(project_id)
    state["persona_dirty"] = False
    _save_project_state(project_id, state)
    return row


def _render_persona_md(
    project_id: str,
    *,
    project_name: str,
    facts: list[dict],
    preferences: list[dict],
    events: list[dict],
    configs: list[dict],
    scenarios: list[dict],
) -> str:
    lines = [f"# Project Persona: {project_name or project_id}", ""]

    lines.append("## 工程指纹")
    fingerprint = [a for a in facts if a.get("subject") in ("part", "top_module", "board_part", "project", "clock")]
    if fingerprint:
        for a in fingerprint:
            pred = a.get("predicate") or ""
            lines.append(f"- **{a.get('subject')}** {pred}: {a.get('object')}")
    else:
        lines.append("- _(暂无结构化工程指纹)_")
    lines.append("")

    lines.append("## 常见失败模式")
    failures = [a for a in events if a.get("predicate") == "failed"]
    failure_scenarios = [s for s in scenarios if "Vivado" in (s.get("title") or "")]
    if failures or failure_scenarios:
        for a in failures[:8]:
            lines.append(f"- {a.get('subject')}: {a.get('object')}")
        for s in failure_scenarios[:5]:
            lines.append(f"- {s.get('title')}")
    else:
        lines.append("- _(暂无记录)_")
    lines.append("")

    lines.append("## 用户偏好")
    if preferences:
        for a in preferences[:10]:
            lines.append(f"- {a.get('object')}")
    else:
        lines.append("- _(暂无记录)_")
    lines.append("")

    lines.append("## 优胜配置")
    if configs:
        for a in configs[:12]:
            surface = a.get("subject") or "config"
            pred = a.get("predicate") or ""
            lines.append(f"- **{surface}** ({pred}): {a.get('object')}")
    else:
        lines.append("- _(暂无进化优胜配置)_")
    lines.append("")

    lines.append("## 场景摘要")
    if scenarios:
        for s in scenarios[:6]:
            title = s.get("title") or "Scenario"
            md = s.get("markdown") or read_scenario_md(s)
            excerpt = md.splitlines()[2:5] if md else []
            lines.append(f"### {title}")
            lines.extend(excerpt or ["- _(empty)_"])
            lines.append("")
    else:
        lines.append("- _(暂无 L2 场景块)_")
    lines.append("")

    lines.append(f"_Built at {time.strftime('%Y-%m-%d %H:%M:%S')} · project_id={project_id}_")
    return "\n".join(lines)


def build_project_persona(
    project_id: str,
    *,
    force: bool = False,
    trigger_every_n_atoms: int | None = None,
) -> dict | None:
    if not project_id:
        return None

    trigger_n = trigger_every_n_atoms or int(os.environ.get("EDAGENT_MEMORY_PERSONA_EVERY_N", "50"))
    atoms = atom_list(project_id, limit=500)
    atoms_total = len(atoms)
    state = _load_project_state(project_id)
    last_build_count = int(state.get("last_persona_atom_count") or 0)

    if not force and atoms_total - last_build_count < trigger_n and persona_latest(project_id):
        return persona_latest(project_id)

    project = project_get(project_id) or {}
    scenarios = list_scenarios_for_project(project_id, limit=30)
    facts = [a for a in atoms if a.get("atom_type") == "fact"]
    preferences = [a for a in atoms if a.get("atom_type") == "preference"]
    events = [a for a in atoms if a.get("atom_type") == "event"]
    configs = [a for a in atoms if a.get("atom_type") == "config"]

    md = _render_persona_md(
        project_id,
        project_name=str(project.get("name") or project_id),
        facts=facts,
        preferences=preferences,
        events=events,
        configs=configs,
        scenarios=scenarios,
    )

    rel_path = _persona_rel_path(project_id)
    _persona_path(project_id).write_text(md, encoding="utf-8")

    version = persona_next_version(project_id)
    row = persona_create(
        scope="project",
        project_id=project_id,
        persona_md_path=rel_path,
        version=version,
        atom_count_at_build=atoms_total,
        scenario_count_at_build=len(scenarios),
        metadata={"force": force},
    )

    state["last_persona_atom_count"] = atoms_total
    state["last_persona_at"] = int(time.time())
    _save_project_state(project_id, state)
    return row


def load_project_persona_text(project_id: str, *, max_chars: int = 2400) -> str:
    if not project_id:
        return ""
    latest = persona_latest(project_id)
    if latest:
        path = latest.get("persona_md_path") or _persona_rel_path(project_id)
        p = Path(path)
        if not p.is_absolute():
            p = _runtime_root() / path
        if p.is_file():
            text = p.read_text(encoding="utf-8", errors="replace")
            return text if len(text) <= max_chars else text[: max_chars - 1].rstrip() + "…"
    fallback = _persona_path(project_id)
    if fallback.is_file():
        text = fallback.read_text(encoding="utf-8", errors="replace")
        return text if len(text) <= max_chars else text[: max_chars - 1].rstrip() + "…"
    return ""


def ensure_project_persona_for_session(project_id: str) -> dict | None:
    """D3: load or build the latest project persona when a session starts."""
    if not project_id:
        return None

    if load_project_persona_text(project_id, max_chars=64):
        rebuild_persona_if_dirty(project_id)
        return persona_latest(project_id)

    latest = persona_latest(project_id)
    if latest:
        row = build_project_persona(project_id, force=True)
        rebuild_persona_if_dirty(project_id)
        return row

    if atom_count(project_id) > 0:
        row = build_project_persona(project_id, force=True)
        rebuild_persona_if_dirty(project_id)
        return row

    return rebuild_persona_if_dirty(project_id)


def get_project_persona(project_id: str) -> dict[str, Any]:
    latest = persona_latest(project_id)
    md = load_project_persona_text(project_id, max_chars=100_000)
    return {
        "project_id": project_id,
        "md": md,
        "version": (latest or {}).get("version") or 0,
        "built_at": (latest or {}).get("built_at"),
        "atom_count": (latest or {}).get("atom_count_at_build") or 0,
        "scenario_count": (latest or {}).get("scenario_count_at_build") or 0,
        "persona_id": (latest or {}).get("id"),
    }
