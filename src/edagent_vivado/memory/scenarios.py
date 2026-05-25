"""L2 memory scenarios — cluster L1 atoms into scenario blocks."""

from __future__ import annotations

import json
import os
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

from edagent_vivado.memory.project_state import load_project_memory_state, merge_project_memory_state
from edagent_vivado.repository.store import (
    atom_list,
    scenario_create,
    scenario_find_by_title,
    scenario_list,
    scenario_update,
)


def _runtime_root() -> Path:
    return Path(os.environ.get("EDAGENT_RUNTIME_DIR", ".edagent"))


def _scenarios_dir(project_id: str) -> Path:
    d = _runtime_root() / "projects" / project_id / "memory" / "scenarios"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _load_project_state(project_id: str) -> dict[str, Any]:
    return load_project_memory_state(project_id)


def _save_project_state(project_id: str, state: dict[str, Any]) -> None:
    merge_project_memory_state(project_id, state)


def _scenario_title(subject: str, atom_type: str) -> str:
    if atom_type == "event" and ("vivado" in subject.lower() or subject.startswith("run_vivado")):
        return f"Vivado: {subject}"
    if atom_type == "preference":
        return "用户偏好"
    if atom_type == "fact":
        return f"工程事实: {subject}"
    return f"场景: {subject}"


def _render_scenario_md(title: str, atoms: list[dict]) -> str:
    lines = [f"# {title}", ""]
    for a in atoms:
        pred = a.get("predicate") or ""
        obj = a.get("object") or ""
        line = f"- **{a.get('subject')}**"
        if pred:
            line += f" `{pred}`"
        line += f": {obj}"
        conf = a.get("confidence")
        if conf is not None:
            line += f" _(conf={conf:.2f})_"
        lines.append(line)
    lines.append("")
    lines.append(f"_Updated: {time.strftime('%Y-%m-%d %H:%M:%S')}_")
    return "\n".join(lines)


def aggregate_scenarios(
    project_id: str,
    *,
    min_atoms: int = 3,
    min_interval_seconds: int = 900,
) -> list[dict]:
    """Group atoms by subject+type; write scenario markdown when cluster is large enough."""
    if not project_id:
        return []

    state = _load_project_state(project_id)
    now = int(time.time())
    last_l2 = int(state.get("last_l2_at") or 0)
    if last_l2 and now - last_l2 < min_interval_seconds:
        return scenario_list(project_id, limit=50)

    atoms = atom_list(project_id, limit=200)
    if not atoms:
        return []

    clusters: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for atom in atoms:
        key = (str(atom.get("atom_type") or "fact"), str(atom.get("subject") or "general"))
        clusters[key].append(atom)

    created_or_updated: list[dict] = []
    scen_dir = _scenarios_dir(project_id)

    for (atom_type, subject), group in clusters.items():
        if len(group) < min_atoms and not (atom_type == "event" and any(a.get("predicate") == "failed" for a in group)):
            continue

        title = _scenario_title(subject, atom_type)
        existing = scenario_find_by_title(project_id, title)
        md_body = _render_scenario_md(title, group)
        atom_ids = [str(a["id"]) for a in group]
        trigger = subject if atom_type == "event" else ""

        if existing:
            path = Path(existing["summary_md_path"])
            if not path.is_absolute():
                path = _runtime_root() / existing["summary_md_path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(md_body, encoding="utf-8")
            row = scenario_update(
                existing["id"],
                atom_ids=atom_ids,
                occurrence_count=int(existing.get("occurrence_count") or 1) + 1,
                last_seen_at=now,
                trigger_pattern=trigger or existing.get("trigger_pattern"),
            )
        else:
            rel_path = f"projects/{project_id}/memory/scenarios/{subject.replace('/', '_')}_{atom_type}.md"
            full_path = _runtime_root() / rel_path
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text(md_body, encoding="utf-8")
            row = scenario_create(
                project_id=project_id,
                title=title,
                summary_md_path=rel_path,
                atom_ids=atom_ids,
                trigger_pattern=trigger,
                metadata={"atom_type": atom_type, "subject": subject},
            )
        if row:
            created_or_updated.append(row)

    state["last_l2_at"] = now
    _save_project_state(project_id, state)
    return created_or_updated


def read_scenario_md(scenario: dict) -> str:
    path = scenario.get("summary_md_path") or ""
    if not path:
        return ""
    p = Path(path)
    if not p.is_absolute():
        p = _runtime_root() / path
    if not p.is_file():
        return ""
    return p.read_text(encoding="utf-8", errors="replace")


def list_scenarios_for_project(project_id: str, *, limit: int = 20) -> list[dict]:
    rows = scenario_list(project_id, limit=limit)
    out: list[dict] = []
    for row in rows:
        item = dict(row)
        try:
            item["atom_ids"] = json.loads(row.get("atom_ids_json") or "[]")
        except json.JSONDecodeError:
            item["atom_ids"] = []
        item["markdown"] = read_scenario_md(row)
        out.append(item)
    return out
