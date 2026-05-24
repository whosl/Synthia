"""Migrate legacy single-layer sessions into project-scoped sessions (SPEC §3.5)."""

from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path
from typing import Any

from edagent_vivado.projects.snapshot import parse_snapshot
from edagent_vivado.repository.db import get_db


def _norm_path(p: str) -> str:
    if not p or not str(p).strip():
        return ""
    try:
        return str(Path(str(p).strip()).expanduser().resolve())
    except Exception:
        return str(p).strip()


def _parse_meta(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def _cluster_key(root: str, manifest: str, xpr: str) -> tuple[str, str, str]:
    return (_norm_path(root), _norm_path(manifest), _norm_path(xpr))


def _hints_from_session(row: dict, db) -> list[dict[str, str]]:
    hints: list[dict[str, str]] = []
    meta = _parse_meta(row.get("metadata_json"))
    snap = _parse_meta(row.get("project_snapshot_json"))
    for src in (meta, snap):
        root = str(src.get("root_path") or "").strip()
        manifest = str(src.get("manifest_path") or src.get("legacy_manifest_path") or "").strip()
        xpr = str(src.get("xpr_path") or "").strip()
        if manifest or root:
            if manifest and not root:
                try:
                    root = str(Path(manifest).resolve().parent)
                except Exception:
                    pass
            hints.append({"root_path": root, "manifest_path": manifest, "xpr_path": xpr})

    sid = row["id"]
    for tbl, col in (
        ("tasks", "metadata_json"),
        ("context_packages", "metadata_json"),
    ):
        try:
            rows = db.execute(
                f"SELECT {col} AS m FROM {tbl} WHERE session_id=? AND {col} IS NOT NULL ORDER BY rowid DESC LIMIT 8",
                (sid,),
            ).fetchall()
        except Exception:
            continue
        for r in rows:
            m = _parse_meta(r["m"])
            mp = str(m.get("manifest_path") or "").strip()
            if mp:
                hints.append(
                    {
                        "root_path": str(m.get("root_path") or Path(mp).parent),
                        "manifest_path": mp,
                        "xpr_path": str(m.get("xpr_path") or ""),
                    }
                )

    # Last user messages may mention eda.yaml paths
    try:
        msgs = db.execute(
            "SELECT content FROM messages WHERE session_id=? AND role='user' ORDER BY created_at DESC LIMIT 5",
            (sid,),
        ).fetchall()
        for m in msgs:
            for match in re.findall(r"[\w./\\:-]+(?:eda\.yaml|\.xpr)", str(m["content"] or ""), flags=re.I):
                p = Path(match)
                if match.lower().endswith(".xpr"):
                    hints.append(
                        {
                            "root_path": str(p.parent),
                            "manifest_path": "",
                            "xpr_path": match,
                        }
                    )
                elif match.lower().endswith(".yaml"):
                    hints.append(
                        {
                            "root_path": str(p.parent),
                            "manifest_path": match,
                            "xpr_path": "",
                        }
                    )
    except Exception:
        pass

    return hints


def _project_matches_key(project: dict, key: tuple[str, str, str]) -> bool:
    pk = _cluster_key(
        project.get("root_path") or "",
        project.get("manifest_path") or "",
        project.get("xpr_path") or "",
    )
    root, manifest, xpr = key
    if manifest and pk[1] == manifest:
        return True
    if root and pk[0] == root and (not manifest or pk[1] == manifest):
        return True
    if xpr and pk[2] == xpr:
        return True
    return False


def _find_matching_projects(projects: list[dict], key: tuple[str, str, str]) -> list[dict]:
    if not any(key):
        return []
    matches = [p for p in projects if _project_matches_key(p, key)]
    if matches:
        return matches
    root, manifest, _xpr = key
    if manifest:
        for p in projects:
            if _norm_path(p.get("manifest_path") or "") == manifest:
                matches.append(p)
    if not matches and root:
        for p in projects:
            if _norm_path(p.get("root_path") or "") == root:
                matches.append(p)
    return matches


def _create_project_from_hint(hint: dict[str, str], db) -> dict | None:
    root = hint.get("root_path") or ""
    manifest = hint.get("manifest_path") or ""
    if not manifest and not root:
        return None
    if manifest and not root:
        root = str(Path(manifest).parent)
    name = Path(root).name if root else Path(manifest).stem
    pid = uuid.uuid4().hex[:12]
    now = int(time.time())
    part = "unknown"
    top_module = None
    try:
        from edagent_vivado.projects.validate import validate_project_paths

        validated = validate_project_paths(
            root_path=root,
            manifest_path=manifest,
            xpr_path=hint.get("xpr_path") or "",
        )
        root = validated["root_path"]
        manifest = validated["manifest_path"]
        part = validated.get("part") or part
        top_module = validated.get("top_module")
        meta = {"auto_migration": True, "flow": validated.get("flow")}
    except Exception as exc:
        meta = {"auto_migration": True, "validation_error": str(exc)}

    db.execute(
        """INSERT INTO projects(
          id,name,status,root_path,manifest_path,xpr_path,part,top_module,
          created_at,updated_at,metadata_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (
            pid,
            name,
            "active",
            root or ".",
            manifest or "eda.yaml",
            hint.get("xpr_path") or "",
            part,
            top_module,
            now,
            now,
            json.dumps(meta),
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    return dict(row) if row else None


def _snapshot_for_project(project: dict) -> dict:
    return {
        "project_id": project["id"],
        "name": project.get("name"),
        "root_path": project.get("root_path"),
        "manifest_path": project.get("manifest_path"),
        "xpr_path": project.get("xpr_path"),
        "part": project.get("part"),
        "board_part": project.get("board_part"),
        "top_module": project.get("top_module"),
        "default_vivado_target_id": project.get("default_vivado_target_id"),
        "migration_resolved_at": int(time.time()),
    }


def migrate_sessions_to_projects(*, force_legacy: bool = False) -> dict[str, int]:
    """Cluster orphan/legacy sessions into projects. Returns stats."""
    db = get_db()
    stats = {"scanned": 0, "assigned": 0, "conflicts": 0, "legacy": 0, "created_projects": 0}

    projects = [dict(r) for r in db.execute("SELECT * FROM projects WHERE deleted_at IS NULL").fetchall()]
    legacy_ids = {
        p["id"]
        for p in projects
        if "legacy_migration" in (p.get("metadata_json") or "")
    }

    rows = db.execute(
        """SELECT * FROM sessions WHERE deleted_at IS NULL AND archived_at IS NULL
           AND (project_id IS NULL OR project_id = '' OR project_id IN (
             SELECT id FROM projects WHERE metadata_json LIKE '%legacy_migration%'
           ) OR metadata_json LIKE '%migration_conflict%')"""
    ).fetchall()
    if force_legacy:
        rows = db.execute("SELECT * FROM sessions WHERE deleted_at IS NULL").fetchall()

    for row in rows:
        stats["scanned"] += 1
        session = dict(row)
        meta = _parse_meta(session.get("metadata_json"))
        if meta.get("migration_resolved"):
            continue
        if meta.get("migration_conflict") and not force_legacy:
            stats["conflicts"] += 1
            continue

        hints = _hints_from_session(session, db)
        if not hints:
            stats["legacy"] += 1
            continue

        hint = hints[0]
        key = _cluster_key(
            hint.get("root_path") or "",
            hint.get("manifest_path") or "",
            hint.get("xpr_path") or "",
        )
        if not any(key):
            stats["legacy"] += 1
            continue

        matches = _find_matching_projects(projects, key)
        if len(matches) > 1:
            meta["migration_conflict"] = True
            meta["migration_candidates"] = [m["id"] for m in matches]
            db.execute(
                "UPDATE sessions SET metadata_json=? WHERE id=?",
                (json.dumps(meta), session["id"]),
            )
            stats["conflicts"] += 1
            continue

        if len(matches) == 1:
            project = matches[0]
        else:
            project = _create_project_from_hint(hint, db)
            if not project:
                stats["legacy"] += 1
                continue
            projects.append(project)
            stats["created_projects"] += 1

        snap = _snapshot_for_project(project)
        clean_meta = {k: v for k, v in meta.items() if k not in ("migration_conflict", "migration_candidates")}
        clean_meta["migration_resolved"] = True
        db.execute(
            "UPDATE sessions SET project_id=?, project_snapshot_json=?, metadata_json=? WHERE id=?",
            (project["id"], json.dumps(snap), json.dumps(clean_meta), session["id"]),
        )
        stats["assigned"] += 1

    db.commit()

    # Remaining orphans → legacy bucket
    from edagent_vivado.repository.db import _migrate_orphan_sessions

    orphan = db.execute(
        "SELECT COUNT(*) FROM sessions WHERE deleted_at IS NULL AND (project_id IS NULL OR project_id = '')"
    ).fetchone()[0]
    if orphan:
        _migrate_orphan_sessions(db)
        stats["legacy"] += int(orphan)

    for pid in {p["id"] for p in projects}:
        _refresh_counts(db, pid)
    db.commit()
    return stats


def _refresh_counts(db, pid: str) -> None:
    row = db.execute(
        "SELECT COUNT(*) AS c, MAX(updated_at) AS last FROM sessions WHERE project_id=? AND deleted_at IS NULL AND archived_at IS NULL",
        (pid,),
    ).fetchone()
    db.execute(
        "UPDATE projects SET session_count=?, last_active_at=?, updated_at=? WHERE id=?",
        (row["c"], row["last"], int(time.time()), pid),
    )


def list_migration_conflicts(limit: int = 100) -> list[dict]:
    db = get_db()
    rows = db.execute(
        "SELECT * FROM sessions WHERE deleted_at IS NULL AND metadata_json LIKE '%migration_conflict%true%' ORDER BY updated_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    out = []
    for row in rows:
        s = dict(row)
        meta = _parse_meta(s.get("metadata_json"))
        candidates = meta.get("migration_candidates") or []
        projects = []
        if candidates:
            placeholders = ",".join("?" * len(candidates))
            prows = db.execute(f"SELECT id,name,root_path,manifest_path FROM projects WHERE id IN ({placeholders})", candidates).fetchall()
            projects = [dict(p) for p in prows]
        s["migration_candidates"] = projects
        s["migration_hint"] = parse_snapshot(s)
        out.append(s)
    return out


def resolve_migration_conflict(session_id: str, project_id: str) -> dict:
    from edagent_vivado.repository.store import project_get, session_get

    session = session_get(session_id)
    if not session:
        raise ValueError("session not found")
    project = project_get(project_id)
    if not project:
        raise ValueError("project not found")
    meta = _parse_meta(session.get("metadata_json"))
    meta.pop("migration_conflict", None)
    meta.pop("migration_candidates", None)
    meta["migration_resolved"] = True
    snap = _snapshot_for_project(project)
    db = get_db()
    db.execute(
        "UPDATE sessions SET project_id=?, project_snapshot_json=?, metadata_json=? WHERE id=?",
        (project_id, json.dumps(snap), json.dumps(meta), session_id),
    )
    db.commit()
    _refresh_counts(db, project_id)
    db.commit()
    updated = session_get(session_id)
    assert updated is not None
    return updated
