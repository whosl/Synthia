"""Session, Task, Message, Event, Run, ToolCall CRUD for Phase 1."""

from __future__ import annotations
import json, time, uuid as _uuid
from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.project_scope import project_id_for_session

# ensure tables exist on first import
init_db()


def _pid(session_id: str) -> str | None:
    if not session_id:
        return None
    return project_id_for_session(get_db(), session_id)

def _now() -> int: return int(time.time())
def _uid() -> str: return _uuid.uuid4().hex[:12]


def _parse_globs_field(project: dict, json_key: str) -> list:
    raw = project.get(json_key)
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


def _path_mappings_for_project(project_id: str) -> list[dict]:
    rows = get_db().execute(
        "SELECT id, target_id, local_root, remote_root FROM path_mappings WHERE project_id=?",
        (project_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def _project_snapshot_row(project: dict) -> dict:
    pid = project["id"]
    return {
        "project_id": pid,
        "name": project.get("name"),
        "root_path": project.get("root_path"),
        "manifest_path": project.get("manifest_path"),
        "xpr_path": project.get("xpr_path"),
        "part": project.get("part"),
        "board_part": project.get("board_part"),
        "top_module": project.get("top_module"),
        "target_language": project.get("target_language"),
        "simulator": project.get("simulator"),
        "source_globs": _parse_globs_field(project, "source_globs_json"),
        "constraint_globs": _parse_globs_field(project, "constraint_globs_json"),
        "tcl_globs": _parse_globs_field(project, "tcl_globs_json"),
        "default_vivado_target_id": project.get("default_vivado_target_id"),
        "default_path_mapping_id": project.get("default_path_mapping_id"),
        "path_mappings": _path_mappings_for_project(pid),
    }


# ── Projects ─────────────────────────────────────────────────

def project_list(status: str | None = None, limit: int = 100, include_archived: bool = False) -> list[dict]:
    db = get_db()
    q = "SELECT * FROM projects WHERE deleted_at IS NULL"
    params: list = []
    if status:
        q += " AND status=?"
        params.append(status)
    if not include_archived:
        q += " AND archived_at IS NULL"
    q += " ORDER BY COALESCE(last_active_at, updated_at) DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in db.execute(q, params)]


def project_get(pid: str) -> dict | None:
    row = get_db().execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    return dict(row) if row else None


def project_create(fields: dict) -> dict:
    pid = _uid()
    now = _now()
    db = get_db()
    db.execute(
        """INSERT INTO projects(
          id,name,status,root_path,manifest_path,xpr_path,part,board_part,top_module,
          target_language,simulator,source_globs_json,constraint_globs_json,tcl_globs_json,
          default_vivado_target_id,created_at,updated_at,metadata_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            pid,
            fields["name"],
            fields.get("status", "active"),
            fields["root_path"],
            fields["manifest_path"],
            fields.get("xpr_path", ""),
            fields.get("part"),
            fields.get("board_part"),
            fields.get("top_module"),
            fields.get("target_language"),
            fields.get("simulator"),
            json.dumps(fields.get("source_globs") or []),
            json.dumps(fields.get("constraint_globs") or []),
            json.dumps(fields.get("tcl_globs") or []),
            fields.get("default_vivado_target_id"),
            now,
            now,
            json.dumps(fields.get("metadata") or {}),
        ),
    )
    db.commit()
    return project_get(pid)


def project_is_archived(project: dict | None) -> bool:
    if not project:
        return False
    return bool(project.get("archived_at")) or str(project.get("status") or "").lower() == "archived"


def project_update(pid: str, **fields) -> dict | None:
    if not fields:
        return project_get(pid)
    allowed = {
        "name", "status", "root_path", "manifest_path", "xpr_path", "part", "board_part",
        "top_module", "target_language", "simulator", "default_vivado_target_id", "metadata_json",
        "archived_at", "deleted_at", "last_active_at", "session_count", "problem_count", "run_count",
        "source_globs_json", "constraint_globs_json", "tcl_globs_json",
    }
    updates = {k: v for k, v in fields.items() if k in allowed}
    if "metadata" in fields and "metadata_json" not in updates:
        updates["metadata_json"] = json.dumps(fields["metadata"])
    if updates.get("status") == "active":
        updates["archived_at"] = None
    if not updates:
        return project_get(pid)
    updates["updated_at"] = _now()
    sets = ", ".join(f"{k}=?" for k in updates)
    vals = list(updates.values()) + [pid]
    get_db().execute(f"UPDATE projects SET {sets} WHERE id=?", vals)
    get_db().commit()
    return project_get(pid)


def project_delete(pid: str, hard: bool = False) -> bool:
    if hard:
        from edagent_vivado.projects.lifecycle import project_hard_delete

        project_hard_delete(pid)
        return True
    db = get_db()
    db.execute("UPDATE projects SET archived_at=?, status=? WHERE id=?", (_now(), "archived", pid))
    db.commit()
    return True


def _refresh_project_session_count(pid: str) -> None:
    db = get_db()
    row = db.execute(
        "SELECT COUNT(*) AS c, MAX(updated_at) AS last FROM sessions WHERE project_id=? AND deleted_at IS NULL AND archived_at IS NULL",
        (pid,),
    ).fetchone()
    db.execute(
        "UPDATE projects SET session_count=?, last_active_at=?, updated_at=? WHERE id=?",
        (row["c"], row["last"], _now(), pid),
    )
    db.commit()


def migrate_orphan_sessions_to_default_project() -> str:
    db = get_db()
    existing = db.execute(
        "SELECT id FROM projects WHERE metadata_json LIKE '%legacy_migration%' LIMIT 1"
    ).fetchone()
    if existing:
        pid = existing["id"]
    else:
        pid = _uid()
        now = _now()
        db.execute(
            """INSERT INTO projects(
              id,name,status,root_path,manifest_path,xpr_path,part,created_at,updated_at,metadata_json
            ) VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (
                pid,
                "Legacy imports",
                "active",
                ".",
                "eda.yaml",
                "",
                "unknown",
                now,
                now,
                json.dumps({"legacy_migration": True}),
            ),
        )
    db.execute(
        "UPDATE sessions SET project_id=?, project_snapshot_json=? WHERE project_id IS NULL OR project_id = ''",
        (pid, json.dumps({"legacy_migration": True, "project_id": pid})),
    )
    db.commit()
    _refresh_project_session_count(pid)
    return pid


# ── Sessions ─────────────────────────────────────────────────

def session_list(
    status: str | None = None,
    limit: int = 50,
    project_id: str | None = None,
    include_archived: bool = False,
) -> list[dict]:
    db = get_db()
    q = "SELECT * FROM sessions WHERE deleted_at IS NULL"
    params: list = []
    if project_id:
        q += " AND project_id=?"
        params.append(project_id)
    if status:
        q += " AND status=?"
        params.append(status)
    if not include_archived:
        q += " AND archived_at IS NULL"
    q += " ORDER BY updated_at DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in db.execute(q, params)]

def session_get(sid: str) -> dict | None:
    row = get_db().execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
    return dict(row) if row else None

def session_create(
    name: str = "",
    *,
    project_id: str,
    metadata: dict | None = None,
    manifest_path: str = "",
) -> dict:
    project = project_get(project_id)
    if not project:
        raise ValueError(f"project not found: {project_id}")
    sid = _uid()
    now = _now()
    name = name or f"Chat {time.strftime('%m-%d %H:%M')}"
    snapshot = _project_snapshot_row(project)
    if manifest_path:
        snapshot["legacy_manifest_path"] = manifest_path
    meta = dict(metadata or {})
    db = get_db()
    db.execute(
        """INSERT INTO sessions(
          id,project_id,name,status,created_at,updated_at,project_snapshot_json,metadata_json
        ) VALUES(?,?,?,?,?,?,?,?)""",
        (sid, project_id, name, "idle", now, now, json.dumps(snapshot), json.dumps(meta)),
    )
    db.commit()
    _refresh_project_session_count(project_id)
    return session_get(sid)

def session_update(sid: str, **fields) -> dict | None:
    if not fields: return session_get(sid)
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [sid]
    get_db().execute(f"UPDATE sessions SET {sets} WHERE id=?", vals)
    get_db().commit()
    return session_get(sid)

def session_delete(sid: str, hard: bool = False) -> bool:
    db = get_db()
    row = session_get(sid)
    pid = row.get("project_id") if row else None
    if hard:
        from edagent_vivado.projects.lifecycle import _archive_session_artifacts_dir, _hard_delete_session

        _hard_delete_session(db, sid)
        _archive_session_artifacts_dir(sid)
        db.commit()
    else:
        db.execute("UPDATE sessions SET archived_at=?, status=? WHERE id=?", (_now(), "archived", sid))
        db.commit()
    if pid:
        _refresh_project_session_count(pid)
    return True


def session_rename(sid: str, name: str) -> dict | None:
    name = (name or "").strip()
    if not name:
        raise ValueError("name is required")
    return session_update(sid, name=name, updated_at=_now())

# ── Messages ─────────────────────────────────────────────────

def message_list(session_id: str, before: int | None = None, limit: int = 200) -> list[dict]:
    db = get_db()
    if before:
        q = "SELECT * FROM messages WHERE session_id=? AND created_at < ? ORDER BY created_at DESC LIMIT ?"
        rows = [dict(r) for r in db.execute(q, [session_id, before, limit])]
        rows.reverse()
        return rows
    q = "SELECT * FROM (SELECT * FROM messages WHERE session_id=? ORDER BY created_at DESC LIMIT ?) sub ORDER BY created_at ASC"
    return [dict(r) for r in db.execute(q, [session_id, limit])]

def message_create(session_id: str, role: str, content: str, task_id: str = "",
                   agent_id: str = "", stopped: bool = False, partial: bool = False) -> dict:
    mid = _uid(); now = _now()
    db = get_db()
    pid = _pid(session_id)
    db.execute(
        "INSERT INTO messages(id,session_id,project_id,task_id,agent_id,role,content,stopped,partial,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (mid, session_id, pid, task_id or None, agent_id or None, role, content, int(stopped), int(partial), now),
    )
    db.execute("UPDATE sessions SET updated_at=?, message_count=message_count+1 WHERE id=?", (now, session_id))
    db.commit()
    return dict(db.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone())

# ── Tasks ────────────────────────────────────────────────────

def task_create(session_id: str, user_message_id: str = "") -> dict:
    tid = _uid(); now = _now()
    db = get_db()
    pid = _pid(session_id)
    db.execute(
        "INSERT INTO tasks(id,session_id,project_id,user_message_id,state,started_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        (tid, session_id, pid, user_message_id or None, "created", now, now),
    )
    db.execute("UPDATE sessions SET status='running', task_count=task_count+1 WHERE id=?", (session_id,))
    db.commit()
    return dict(db.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone())

def task_update(tid: str, **fields) -> dict | None:
    if not fields: return task_get(tid)
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [tid]
    get_db().execute(f"UPDATE tasks SET {sets} WHERE id=?", vals)
    get_db().commit()
    return task_get(tid)

def task_get(tid: str) -> dict | None:
    row = get_db().execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
    return dict(row) if row else None

def task_active_for_session(session_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM tasks WHERE session_id=? AND state IN ('created','running','stopping') ORDER BY started_at DESC LIMIT 1",
                           (session_id,)).fetchone()
    return dict(row) if row else None

# ── Events ───────────────────────────────────────────────────

def event_create(session_id: str, event_type: str, payload: dict, task_id: str = "",
                 run_id: str = "", agent_id: str = "", parent_run_id: str = "",
                 artifact_id: str = "", visibility: str = "public") -> dict:
    db = get_db()
    seq = (db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE session_id=?", (session_id,)).fetchone()[0])
    eid = _uid(); now = _now()
    pid = _pid(session_id)
    db.execute(
        "INSERT INTO events(id,session_id,project_id,task_id,run_id,parent_run_id,agent_id,seq,event_type,created_at,payload_json,artifact_id,visibility) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            eid, session_id, pid, task_id or None, run_id or None, parent_run_id or None, agent_id or None,
            seq, event_type, now, json.dumps(payload, ensure_ascii=False), artifact_id or None, visibility,
        ),
    )
    db.commit()
    return dict(db.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone())

def event_list(session_id: str, after_seq: int = 0, limit: int = 500) -> list[dict]:
    return [dict(r) for r in get_db().execute(
        "SELECT * FROM events WHERE session_id=? AND seq>? ORDER BY seq ASC LIMIT ?",
        (session_id, after_seq, limit))]


def event_list_recent(session_id: str, limit: int = 5000) -> list[dict]:
    """Return the most recent events (chronological), for terminal UI rebuild."""
    rows = get_db().execute(
        "SELECT * FROM events WHERE session_id=? ORDER BY seq DESC LIMIT ?",
        (session_id, limit),
    ).fetchall()
    return [dict(r) for r in reversed(rows)]


def event_list_by_type(event_type: str, limit: int = 200) -> list[dict]:
    """Recent events of a type, chronological (for cross-session queues)."""
    rows = get_db().execute(
        "SELECT * FROM events WHERE event_type=? ORDER BY seq DESC LIMIT ?",
        (event_type, limit),
    ).fetchall()
    return [dict(r) for r in reversed(rows)]

# ── Runs ─────────────────────────────────────────────────────

def run_create(run_type: str, name: str, session_id: str = "", task_id: str = "",
               parent_run_id: str = "", agent_id: str = "") -> dict:
    rid = _uid(); now = _now()
    db = get_db()
    pid = _pid(session_id) if session_id else None
    db.execute(
        "INSERT INTO runs(id,session_id,project_id,task_id,parent_run_id,agent_id,run_type,name,state,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (rid, session_id or None, pid, task_id or None, parent_run_id or None, agent_id or None, run_type, name, "started", now),
    )
    db.commit()
    return dict(db.execute("SELECT * FROM runs WHERE id=?", (rid,)).fetchone())

def run_update(rid: str, **fields) -> dict | None:
    if not fields: return run_get(rid)
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [rid]
    get_db().execute(f"UPDATE runs SET {sets} WHERE id=?", vals)
    get_db().commit()
    return run_get(rid)

def run_get(rid: str) -> dict | None:
    row = get_db().execute("SELECT * FROM runs WHERE id=?", (rid,)).fetchone()
    return dict(row) if row else None

def run_list(session_id: str = "", run_type: str | None = None, limit: int = 50) -> list[dict]:
    q = "SELECT * FROM runs WHERE 1=1"
    params = []
    if session_id: q += " AND session_id=?"; params.append(session_id)
    if run_type: q += " AND run_type=?"; params.append(run_type)
    q += " ORDER BY started_at DESC LIMIT ?"; params.append(limit)
    return [dict(r) for r in get_db().execute(q, params)]

# ── Tool Calls ───────────────────────────────────────────────

def toolcall_create(run_id: str, tool_name: str, session_id: str = "", task_id: str = "",
                    agent_id: str = "", input_summary: str = "") -> dict:
    cid = _uid(); now = _now()
    db = get_db()
    pid = _pid(session_id) if session_id else None
    db.execute(
        "INSERT INTO tool_calls(id,run_id,session_id,project_id,task_id,agent_id,tool_name,state,started_at,input_summary) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (cid, run_id, session_id or None, pid, task_id or None, agent_id or None, tool_name, "started", now, input_summary),
    )
    db.execute("UPDATE sessions SET tool_call_count=tool_call_count+1 WHERE id=?", (session_id,))
    db.commit()
    return dict(db.execute("SELECT * FROM tool_calls WHERE id=?", (cid,)).fetchone())

def toolcall_update(cid: str, **fields) -> dict | None:
    if not fields:
        return toolcall_get(cid)
    prev = toolcall_get(cid)
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [cid]
    get_db().execute(f"UPDATE tool_calls SET {sets} WHERE id=?", vals)
    get_db().commit()
    row = toolcall_get(cid)
    try:
        from edagent_vivado.memory.hooks import on_toolcall_updated

        on_toolcall_updated(row, previous_state=(prev or {}).get("state"))
    except Exception:  # pragma: no cover
        pass
    return row

def toolcall_get(cid: str) -> dict | None:
    row = get_db().execute("SELECT * FROM tool_calls WHERE id=?", (cid,)).fetchone()
    return dict(row) if row else None

def toolcall_list(run_id: str = "", session_id: str = "", limit: int = 100) -> list[dict]:
    q = "SELECT * FROM tool_calls WHERE 1=1"
    params = []
    if run_id: q += " AND run_id=?"; params.append(run_id)
    if session_id: q += " AND session_id=?"; params.append(session_id)
    q += " ORDER BY started_at ASC LIMIT ?"; params.append(limit)
    return [dict(r) for r in get_db().execute(q, params)]

# ── LLM Usage ────────────────────────────────────────────────

def usage_create(run_id: str, model: str, provider: str = "", session_id: str = "",
                 task_id: str = "", agent_id: str = "", model_role: str = "primary",
                 input_tokens: int = 0, output_tokens: int = 0, total_tokens: int = 0,
                 usage_source: str = "unknown") -> dict:
    uid = _uid(); now = _now()
    db = get_db()
    pid = _pid(session_id) if session_id else None
    db.execute(
        "INSERT INTO llm_usage(id,run_id,session_id,project_id,task_id,agent_id,provider,model,model_role,input_tokens,output_tokens,total_tokens,usage_source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            uid, run_id, session_id or None, pid, task_id or None, agent_id or None, provider, model,
            model_role, input_tokens, output_tokens, total_tokens, usage_source, now,
        ),
    )
    db.execute("UPDATE sessions SET token_input=token_input+?, token_output=token_output+? WHERE id=?",
               (input_tokens, output_tokens, session_id))
    db.commit()
    return dict(db.execute("SELECT * FROM llm_usage WHERE id=?", (uid,)).fetchone())

def usage_list(session_id: str = "", run_id: str = "", limit: int = 50) -> list[dict]:
    q = "SELECT * FROM llm_usage WHERE 1=1"
    params = []
    if session_id: q += " AND session_id=?"; params.append(session_id)
    if run_id: q += " AND run_id=?"; params.append(run_id)
    q += " ORDER BY created_at DESC LIMIT ?"; params.append(limit)
    return [dict(r) for r in get_db().execute(q, params)]

# ── Phase 2: Memory, Context Packages, Retrieval Audit, Problems ─────────────

def memory_create(session_id: str, summary: str, task_id: str = "", summary_model: str = "heuristic",
                  source_message_until: str = "", source_event_until_seq: int | None = None,
                  metadata: dict | None = None) -> dict:
    mid = _uid(); now = _now()
    db = get_db()
    pid = _pid(session_id)
    db.execute(
        "INSERT INTO memory_snapshots(id,session_id,project_id,task_id,summary,summary_model,source_message_until,source_event_until_seq,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (
            mid, session_id, pid, task_id or None, summary, summary_model, source_message_until or None,
            source_event_until_seq, now, json.dumps(metadata or {}, ensure_ascii=False),
        ),
    )
    db.commit()
    return dict(db.execute("SELECT * FROM memory_snapshots WHERE id=?", (mid,)).fetchone())

def memory_latest(session_id: str) -> dict | None:
    row = get_db().execute(
        "SELECT * FROM memory_snapshots WHERE session_id=? ORDER BY created_at DESC LIMIT 1",
        (session_id,),
    ).fetchone()
    return dict(row) if row else None

def memory_list(session_id: str, limit: int = 20) -> list[dict]:
    return [dict(r) for r in get_db().execute(
        "SELECT * FROM memory_snapshots WHERE session_id=? ORDER BY created_at DESC LIMIT ?",
        (session_id, limit),
    )]

def retrieval_audit_create(session_id: str, query: str, task_id: str = "", run_id: str = "",
                           agent_id: str = "", rewritten_query: str = "", intent: dict | None = None,
                           filters: dict | None = None, candidate_count: int = 0, selected_count: int = 0,
                           rejected_count: int = 0, token_budget: int = 0, token_used: int = 0,
                           metadata: dict | None = None) -> dict:
    rid = _uid(); now = _now()
    db = get_db()
    pid = _pid(session_id) if session_id else None
    db.execute(
        "INSERT INTO retrieval_audits(id,session_id,project_id,task_id,run_id,agent_id,query,rewritten_query,intent_json,filters_json,candidate_count,selected_count,rejected_count,token_budget,token_used,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (rid, session_id or None, pid, task_id or None, run_id or None, agent_id or None, query, rewritten_query or None,
         json.dumps(intent or {}, ensure_ascii=False), json.dumps(filters or {}, ensure_ascii=False),
         candidate_count, selected_count, rejected_count, token_budget, token_used, now,
         json.dumps(metadata or {}, ensure_ascii=False)),
    )
    db.commit()
    return dict(db.execute("SELECT * FROM retrieval_audits WHERE id=?", (rid,)).fetchone())

def retrieval_audit_item_create(retrieval_audit_id: str, source_type: str, title: str = "",
                                excerpt: str = "", selected: bool = True, source_id: str = "",
                                final_score: float | None = None, authority_score: float | None = None,
                                trust_score: float | None = None, token_count: int = 0,
                                metadata: dict | None = None, **extra) -> dict:
    iid = _uid(); db = get_db()
    db.execute(
        "INSERT INTO retrieval_audit_items(id,retrieval_audit_id,source_type,source_id,chunk_id,kb_case_id,problem_id,artifact_id,title,excerpt,vector_score,rerank_score,authority_score,trust_score,final_score,selected,rejection_reason,token_count,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (iid, retrieval_audit_id, source_type, source_id or None, extra.get("chunk_id"), extra.get("kb_case_id"),
         extra.get("problem_id"), extra.get("artifact_id"), title, excerpt, extra.get("vector_score"),
         extra.get("rerank_score"), authority_score, trust_score, final_score, int(selected),
         extra.get("rejection_reason"), token_count, json.dumps(metadata or {}, ensure_ascii=False)),
    )
    db.commit()
    return dict(db.execute("SELECT * FROM retrieval_audit_items WHERE id=?", (iid,)).fetchone())

def retrieval_audit_get(audit_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM retrieval_audits WHERE id=?", (audit_id,)).fetchone()
    return dict(row) if row else None

def retrieval_audit_items(audit_id: str) -> list[dict]:
    return [dict(r) for r in get_db().execute(
        "SELECT * FROM retrieval_audit_items WHERE retrieval_audit_id=? ORDER BY selected DESC, final_score DESC",
        (audit_id,),
    )]

def retrieval_audits_for_run(run_id: str, limit: int = 20) -> list[dict]:
    return [dict(r) for r in get_db().execute(
        "SELECT * FROM retrieval_audits WHERE run_id=? ORDER BY created_at DESC LIMIT ?",
        (run_id, limit),
    )]

def context_package_create(session_id: str, task_id: str = "", run_id: str = "", agent_id: str = "",
                           model: str = "", max_context_tokens: int = 0,
                           token_counts: dict | None = None, truncated: bool = False,
                           artifact_id: str = "", metadata: dict | None = None) -> dict:
    cid = _uid(); now = _now(); counts = token_counts or {}
    db = get_db()
    pid = _pid(session_id)
    db.execute(
        "INSERT INTO context_packages(id,session_id,project_id,task_id,run_id,agent_id,model,max_context_tokens,total_tokens,system_tokens,question_tokens,memory_tokens,recent_message_tokens,project_context_tokens,error_kb_tokens,semantic_kb_tokens,tool_summary_tokens,problem_summary_tokens,truncated,created_at,artifact_id,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (cid, session_id, pid, task_id or None, run_id or None, agent_id or None, model or None, max_context_tokens,
         counts.get("total", 0), counts.get("system", 0), counts.get("question", 0), counts.get("memory", 0),
         counts.get("recent_messages", 0), counts.get("project_context", 0), counts.get("error_kb", 0),
         counts.get("semantic_kb", 0), counts.get("tool_summary", 0), counts.get("problem_summary", 0),
         int(truncated), now, artifact_id or None, json.dumps(metadata or {}, ensure_ascii=False)),
    )
    db.commit()
    return dict(db.execute("SELECT * FROM context_packages WHERE id=?", (cid,)).fetchone())

def context_package_item_create(context_package_id: str, item_type: str, title: str,
                                content_summary: str, priority: int, included: bool = True,
                                source_id: str = "", source_type: str = "", token_count: int = 0,
                                truncation_reason: str = "", authority_score: float | None = None,
                                trust_score: float | None = None, relevance_score: float | None = None,
                                metadata: dict | None = None) -> dict:
    iid = _uid(); db = get_db()
    db.execute(
        "INSERT INTO context_package_items(id,context_package_id,item_type,source_id,source_type,title,content_summary,token_count,priority,included,truncation_reason,authority_score,trust_score,relevance_score,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (iid, context_package_id, item_type, source_id or None, source_type or None, title, content_summary,
         token_count, priority, int(included), truncation_reason or None, authority_score, trust_score,
         relevance_score, json.dumps(metadata or {}, ensure_ascii=False)),
    )
    db.commit()
    return dict(db.execute("SELECT * FROM context_package_items WHERE id=?", (iid,)).fetchone())

def context_packages_for_run(run_id: str, limit: int = 10) -> list[dict]:
    return [dict(r) for r in get_db().execute(
        "SELECT * FROM context_packages WHERE run_id=? ORDER BY created_at DESC LIMIT ?",
        (run_id, limit),
    )]

def context_package_items(context_package_id: str) -> list[dict]:
    return [dict(r) for r in get_db().execute(
        "SELECT * FROM context_package_items WHERE context_package_id=? ORDER BY priority ASC, included DESC",
        (context_package_id,),
    )]

def context_package_get(context_package_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM context_packages WHERE id=?", (context_package_id,)).fetchone()
    return dict(row) if row else None

def context_packages_for_session(session_id: str, task_id: str = "", limit: int = 5) -> list[dict]:
    q = "SELECT * FROM context_packages WHERE session_id=?"
    params: list = [session_id]
    if task_id:
        q += " AND task_id=?"
        params.append(task_id)
    q += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in get_db().execute(q, params)]

def retrieval_audits_for_session(session_id: str, task_id: str = "", limit: int = 5) -> list[dict]:
    q = "SELECT * FROM retrieval_audits WHERE session_id=?"
    params: list = [session_id]
    if task_id:
        q += " AND task_id=?"
        params.append(task_id)
    q += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in get_db().execute(q, params)]

def problem_create(session_id: str, message: str, source: str = "harness", task_id: str = "",
                   run_id: str = "", severity: str = "warning", category: str = "",
                   signature: str = "", normalized_signature: str = "",
                   metadata: dict | None = None) -> dict:
    prob_id = _uid()
    now = _now()
    db = get_db()
    proj_id = _pid(session_id) if session_id else None
    db.execute(
        "INSERT INTO problems(id,session_id,project_id,task_id,run_id,source,severity,category,signature,normalized_signature,message,detected_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (prob_id, session_id or None, proj_id, task_id or None, run_id or None, source, severity, category,
         signature, normalized_signature, message, now, json.dumps(metadata or {}, ensure_ascii=False)),
    )
    if session_id:
        db.execute("UPDATE sessions SET problem_count=problem_count+1 WHERE id=?", (session_id,))
    db.commit()
    return dict(db.execute("SELECT * FROM problems WHERE id=?", (prob_id,)).fetchone())

def problem_list(session_id: str = "", run_id: str = "", limit: int = 100) -> list[dict]:
    q = "SELECT * FROM problems WHERE 1=1"; params = []
    if session_id: q += " AND session_id=?"; params.append(session_id)
    if run_id: q += " AND run_id=?"; params.append(run_id)
    q += " ORDER BY detected_at DESC LIMIT ?"; params.append(limit)
    return [dict(r) for r in get_db().execute(q, params)]

def artifact_list(session_id: str = "", run_id: str = "", limit: int = 100) -> list[dict]:
    q = "SELECT * FROM artifacts WHERE 1=1"; params = []
    if session_id: q += " AND session_id=?"; params.append(session_id)
    if run_id: q += " AND run_id=?"; params.append(run_id)
    q += " ORDER BY created_at DESC LIMIT ?"; params.append(limit)
    return [dict(r) for r in get_db().execute(q, params)]

def artifact_create(artifact_type: str, path: str, session_id: str = "", task_id: str = "",
                    run_id: str = "", mime_type: str = "", size_bytes: int | None = None,
                    sha256: str = "", summary: str = "", metadata: dict | None = None) -> dict:
    aid = _uid(); now = _now(); db = get_db()
    proj_id = _pid(session_id) if session_id else None
    db.execute(
        "INSERT INTO artifacts(id,session_id,project_id,task_id,run_id,artifact_type,path,mime_type,size_bytes,sha256,summary,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (aid, session_id or None, proj_id, task_id or None, run_id or None, artifact_type, path,
         mime_type or None, size_bytes, sha256 or None, summary or None, now,
         json.dumps(metadata or {}, ensure_ascii=False)))
    db.commit()
    return dict(db.execute("SELECT * FROM artifacts WHERE id=?", (aid,)).fetchone())

def artifact_get(aid: str) -> dict | None:
    row = get_db().execute("SELECT * FROM artifacts WHERE id=?", (aid,)).fetchone()
    return dict(row) if row else None

# ── KB Cases ──────────────────────────────────────────────────

def kb_case_list(category: str = "", limit: int = 200) -> list[dict]:
    q = "SELECT * FROM kb_cases WHERE 1=1"; params = []
    if category: q += " AND category=?"; params.append(category)
    q += " ORDER BY created_at DESC LIMIT ?"; params.append(limit)
    return [dict(r) for r in get_db().execute(q, params)]

def kb_case_get(case_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM kb_cases WHERE id=?", (case_id,)).fetchone()
    return dict(row) if row else None

def kb_case_create(pattern: str, category: str, likely_causes: list[str],
                   suggested_actions: list[str], normalized_signature: str = "",
                   repro_steps: str = "", vivado_version: str = "", fpga_part: str = "",
                   top_module: str = "", source_candidate_id: str = "",
                   metadata: dict | None = None) -> dict:
    cid = _uid(); now = _now(); db = get_db()
    db.execute(
        "INSERT INTO kb_cases(id,pattern,normalized_signature,category,likely_causes_json,suggested_actions_json,repro_steps,vivado_version,fpga_part,top_module,source_candidate_id,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (cid, pattern, normalized_signature or None, category,
         json.dumps(likely_causes, ensure_ascii=False), json.dumps(suggested_actions, ensure_ascii=False),
         repro_steps or None, vivado_version or None, fpga_part or None, top_module or None,
         source_candidate_id or None, now, now, json.dumps(metadata or {}, ensure_ascii=False)))
    db.commit()
    return dict(db.execute("SELECT * FROM kb_cases WHERE id=?", (cid,)).fetchone())

def kb_case_update(case_id: str, **fields) -> dict | None:
    if not fields: return kb_case_get(case_id)
    fields["updated_at"] = _now()
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [case_id]
    get_db().execute(f"UPDATE kb_cases SET {sets} WHERE id=?", vals)
    get_db().commit()
    return kb_case_get(case_id)

# ── KB Candidates ─────────────────────────────────────────────

def kb_candidate_list(status: str = "", limit: int = 100) -> list[dict]:
    q = "SELECT * FROM kb_candidates WHERE 1=1"; params = []
    if status: q += " AND status=?"; params.append(status)
    q += " ORDER BY created_at DESC LIMIT ?"; params.append(limit)
    return [dict(r) for r in get_db().execute(q, params)]

def kb_candidate_get(cand_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM kb_candidates WHERE id=?", (cand_id,)).fetchone()
    return dict(row) if row else None

def kb_candidate_create(pattern: str, likely_causes: list[str], suggested_actions: list[str],
                        source_run_id: str = "", source_session_id: str = "",
                        source_problem_id: str = "", category: str = "",
                        normalized_signature: str = "", confidence: float | None = None,
                        created_by: str = "harness", vivado_version: str = "",
                        fpga_part: str = "", top_module: str = "",
                        metadata: dict | None = None) -> dict:
    cid = _uid(); now = _now(); db = get_db()
    db.execute(
        "INSERT INTO kb_candidates(id,source_run_id,source_session_id,source_problem_id,pattern,normalized_signature,category,likely_causes_json,suggested_actions_json,confidence,status,created_by,vivado_version,fpga_part,top_module,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (cid, source_run_id or None, source_session_id or None, source_problem_id or None,
         pattern, normalized_signature or None, category or None,
         json.dumps(likely_causes, ensure_ascii=False), json.dumps(suggested_actions, ensure_ascii=False),
         confidence, "pending", created_by, vivado_version or None, fpga_part or None,
         top_module or None, now, json.dumps(metadata or {}, ensure_ascii=False)))
    db.commit()
    return dict(db.execute("SELECT * FROM kb_candidates WHERE id=?", (cid,)).fetchone())

def kb_candidate_update(cand_id: str, **fields) -> dict | None:
    if not fields: return kb_candidate_get(cand_id)
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [cand_id]
    get_db().execute(f"UPDATE kb_candidates SET {sets} WHERE id=?", vals)
    get_db().commit()
    return kb_candidate_get(cand_id)

def kb_candidate_approve(cand_id: str, reviewed_by: str = "user") -> dict | None:
    """Approve and merge into searchable kb_cases (approve ==入库)."""
    cand = kb_candidate_get(cand_id)
    if not cand:
        return None
    if cand.get("status") == "merged" and cand.get("merged_into_case_id"):
        return cand
    if cand.get("status") == "rejected":
        return cand
    return kb_candidate_merge(cand_id, reviewed_by=reviewed_by)

def kb_candidate_reject(cand_id: str, reviewed_by: str = "user") -> dict | None:
    now = _now()
    get_db().execute(
        "UPDATE kb_candidates SET status='rejected', reviewed_at=?, reviewed_by=? WHERE id=?",
        (now, reviewed_by, cand_id))
    get_db().commit()
    return kb_candidate_get(cand_id)

def kb_candidate_merge(cand_id: str, reviewed_by: str = "user") -> dict | None:
    cand = kb_candidate_get(cand_id)
    if not cand: return None
    case = kb_case_create(
        pattern=cand["pattern"],
        category=cand.get("category") or "unknown",
        likely_causes=json.loads(cand["likely_causes_json"]) if cand.get("likely_causes_json") else [],
        suggested_actions=json.loads(cand["suggested_actions_json"]) if cand.get("suggested_actions_json") else [],
        normalized_signature=cand.get("normalized_signature") or "",
        vivado_version=cand.get("vivado_version") or "",
        fpga_part=cand.get("fpga_part") or "",
        top_module=cand.get("top_module") or "",
        source_candidate_id=cand_id,
    )
    now = _now()
    get_db().execute(
        "UPDATE kb_candidates SET status='merged', reviewed_at=?, reviewed_by=?, merged_into_case_id=? WHERE id=?",
        (now, reviewed_by, case["id"], cand_id))
    get_db().commit()
    return kb_candidate_get(cand_id)

# ── Vivado Targets ────────────────────────────────────────────

def vivado_target_list(enabled_only: bool = True) -> list[dict]:
    q = "SELECT * FROM vivado_targets"
    if enabled_only: q += " WHERE enabled=1"
    q += " ORDER BY is_default DESC, created_at ASC"
    return [dict(r) for r in get_db().execute(q)]

def vivado_target_get(target_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM vivado_targets WHERE id=?", (target_id,)).fetchone()
    return dict(row) if row else None

def vivado_target_create(name: str, target_type: str, vivado_path: str,
                         host: str = "", ssh_key_path: str = "", settings_path: str = "",
                         remote_work_root: str = "", vivado_version: str = "",
                         is_default: bool = False, metadata: dict | None = None) -> dict:
    tid = _uid(); now = _now(); db = get_db()
    if is_default:
        db.execute("UPDATE vivado_targets SET is_default=0")
    db.execute(
        "INSERT INTO vivado_targets(id,name,target_type,host,ssh_key_path,vivado_path,settings_path,remote_work_root,vivado_version,is_default,enabled,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (tid, name, target_type, host or None, ssh_key_path or None, vivado_path,
         settings_path or None, remote_work_root or None, vivado_version or None,
         int(is_default), 1, now, now, json.dumps(metadata or {}, ensure_ascii=False)))
    db.commit()
    return dict(db.execute("SELECT * FROM vivado_targets WHERE id=?", (tid,)).fetchone())

def vivado_target_update(target_id: str, **fields) -> dict | None:
    if not fields: return vivado_target_get(target_id)
    fields["updated_at"] = _now()
    if fields.get("is_default"):
        get_db().execute("UPDATE vivado_targets SET is_default=0")
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [target_id]
    get_db().execute(f"UPDATE vivado_targets SET {sets} WHERE id=?", vals)
    get_db().commit()
    return vivado_target_get(target_id)

def vivado_target_delete(target_id: str) -> bool:
    get_db().execute("DELETE FROM vivado_targets WHERE id=?", (target_id,))
    get_db().commit()
    return True

def event_list_for_run(run_id: str, limit: int = 500) -> list[dict]:
    return [dict(r) for r in get_db().execute(
        "SELECT * FROM events WHERE run_id=? ORDER BY created_at ASC, seq ASC LIMIT ?",
        (run_id, limit),
    )]

# ── Knowledge sources ─────────────────────────────────────────

def knowledge_source_list(scope: str = "", project_id: str = "", limit: int = 100) -> list[dict]:
    q = "SELECT * FROM knowledge_sources WHERE 1=1"
    params: list = []
    if scope:
        q += " AND scope=?"
        params.append(scope)
    if project_id:
        q += " AND project_id=?"
        params.append(project_id)
    q += " ORDER BY indexed_at DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in get_db().execute(q, params)]

def usage_totals_for_session(session_id: str) -> dict:
    row = get_db().execute(
        "SELECT COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(total_tokens),0) AS total_tokens, COUNT(*) AS records FROM llm_usage WHERE session_id=?",
        (session_id,),
    ).fetchone()
    sess = session_get(session_id) or {}
    return {
        "session_id": session_id,
        "input_tokens": int(row["input_tokens"]) if row else 0,
        "output_tokens": int(row["output_tokens"]) if row else 0,
        "total_tokens": int(row["total_tokens"]) if row else 0,
        "usage_records": int(row["records"]) if row else 0,
        "session_token_input": int(sess.get("token_input") or 0),
        "session_token_output": int(sess.get("token_output") or 0),
    }


def monitor_overview(days: int = 14) -> dict:
    """Aggregate monitor metrics for dashboard charts (Phase 4)."""
    days = max(1, min(int(days), 90))
    now = _now()
    since = now - days * 86400
    db = get_db()

    runs_by_state: dict[str, int] = {}
    for row in db.execute(
        "SELECT state, COUNT(*) AS cnt FROM runs WHERE started_at >= ? GROUP BY state",
        (since,),
    ):
        runs_by_state[str(row["state"])] = int(row["cnt"])

    tool_row = db.execute(
        """SELECT COUNT(*) AS total,
                  SUM(CASE WHEN state IN ('error','failed') OR (error IS NOT NULL AND error != '') THEN 1 ELSE 0 END) AS errors
           FROM tool_calls WHERE started_at >= ?""",
        (since,),
    ).fetchone()
    tool_total = int(tool_row["total"]) if tool_row else 0
    tool_errors = int(tool_row["errors"] or 0) if tool_row else 0

    token_series = []
    for row in db.execute(
        """SELECT date(created_at, 'unixepoch') AS day,
                  COALESCE(SUM(input_tokens),0) AS input_tokens,
                  COALESCE(SUM(output_tokens),0) AS output_tokens,
                  COALESCE(SUM(total_tokens),0) AS total_tokens,
                  COALESCE(SUM(cost_total),0) AS cost_total,
                  COUNT(*) AS records
           FROM llm_usage WHERE created_at >= ?
           GROUP BY day ORDER BY day ASC""",
        (since,),
    ):
        token_series.append({
            "day": row["day"],
            "input_tokens": int(row["input_tokens"]),
            "output_tokens": int(row["output_tokens"]),
            "total_tokens": int(row["total_tokens"]),
            "cost_total": float(row["cost_total"] or 0),
            "records": int(row["records"]),
        })

    by_model = []
    for row in db.execute(
        """SELECT model,
                  COALESCE(SUM(input_tokens),0) AS input_tokens,
                  COALESCE(SUM(output_tokens),0) AS output_tokens,
                  COALESCE(SUM(total_tokens),0) AS total_tokens,
                  COUNT(*) AS records
           FROM llm_usage WHERE created_at >= ?
           GROUP BY model ORDER BY total_tokens DESC LIMIT 12""",
        (since,),
    ):
        by_model.append({
            "model": row["model"],
            "input_tokens": int(row["input_tokens"]),
            "output_tokens": int(row["output_tokens"]),
            "total_tokens": int(row["total_tokens"]),
            "records": int(row["records"]),
        })

    prob_row = db.execute(
        "SELECT COUNT(*) AS cnt FROM problems WHERE detected_at >= ?",
        (since,),
    ).fetchone()
    usage_row = db.execute(
        """SELECT COALESCE(SUM(input_tokens),0) AS input_tokens,
                  COALESCE(SUM(output_tokens),0) AS output_tokens,
                  COALESCE(SUM(cost_total),0) AS cost_total,
                  COUNT(*) AS records
           FROM llm_usage WHERE created_at >= ?""",
        (since,),
    ).fetchone()

    return {
        "days": days,
        "since": since,
        "until": now,
        "runs_by_state": runs_by_state,
        "run_count": sum(runs_by_state.values()),
        "tool_calls": {
            "total": tool_total,
            "errors": tool_errors,
            "error_rate": round(tool_errors / tool_total, 4) if tool_total else 0.0,
        },
        "problems": int(prob_row["cnt"]) if prob_row else 0,
        "usage_totals": {
            "input_tokens": int(usage_row["input_tokens"]) if usage_row else 0,
            "output_tokens": int(usage_row["output_tokens"]) if usage_row else 0,
            "cost_total": float(usage_row["cost_total"] or 0) if usage_row else 0.0,
            "records": int(usage_row["records"]) if usage_row else 0,
        },
        "token_series": token_series,
        "by_model": by_model,
    }


def monitor_retention_cleanup(retention_days: int = 90, dry_run: bool = False) -> dict:
    """Delete monitor telemetry older than retention window (Phase 4)."""
    retention_days = max(1, min(int(retention_days), 3650))
    cutoff = _now() - retention_days * 86400
    db = get_db()
    tables = (
        ("events", "created_at"),
        ("llm_usage", "created_at"),
        ("tool_calls", "started_at"),
        ("problems", "detected_at"),
    )
    deleted: dict[str, int] = {}
    for table, col in tables:
        row = db.execute(
            f"SELECT COUNT(*) AS cnt FROM {table} WHERE {col} < ?",
            (cutoff,),
        ).fetchone()
        count = int(row["cnt"]) if row else 0
        deleted[table] = count
        if not dry_run and count:
            db.execute(f"DELETE FROM {table} WHERE {col} < ?", (cutoff,))
    if not dry_run:
        db.commit()
    return {
        "retention_days": retention_days,
        "cutoff": cutoff,
        "dry_run": dry_run,
        "deleted": deleted,
    }

# ── Settings (key/value) ─────────────────────────────────────

def settings_get(key: str, default=None):
    row = get_db().execute("SELECT value_json FROM settings WHERE key=?", (key,)).fetchone()
    if not row:
        return default
    try:
        return json.loads(row["value_json"])
    except (json.JSONDecodeError, TypeError):
        return default


def settings_set(key: str, value) -> None:
    db = get_db()
    payload = json.dumps(value)
    now = _now()
    db.execute(
        """INSERT INTO settings(key, value_json, updated_at) VALUES(?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at""",
        (key, payload, now),
    )
    db.commit()


# ── Vivado commands ───────────────────────────────────────────

def vivado_command_create(
    target_id: str,
    command_text: str,
    command_type: str = "raw_tcl",
    *,
    session_id: str = "",
    task_id: str = "",
    run_id: str = "",
    vivado_session_id: str = "",
    project_id: str = "",
    work_dir: str = "",
    metadata: dict | None = None,
) -> dict:
    cid = _uid()
    now = _now()
    db = get_db()
    db.execute(
        "INSERT INTO vivado_commands(id,target_id,vivado_session_id,session_id,task_id,run_id,command_type,command_text,project_id,work_dir,state,started_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            cid,
            target_id,
            vivado_session_id or None,
            session_id or None,
            task_id or None,
            run_id or None,
            command_type,
            command_text[:4000],
            project_id or None,
            work_dir or None,
            "running",
            now,
            json.dumps(metadata or {}, ensure_ascii=False),
        ),
    )
    db.commit()
    return dict(db.execute("SELECT * FROM vivado_commands WHERE id=?", (cid,)).fetchone())

def vivado_command_finish(
    command_id: str,
    *,
    state: str = "completed",
    exit_code: int | None = None,
    elapsed_ms: int | None = None,
    error: str = "",
    parsed_summary: dict | None = None,
    problem_count: int = 0,
) -> dict | None:
    now = _now()
    get_db().execute(
        "UPDATE vivado_commands SET state=?, finished_at=?, elapsed_ms=?, exit_code=?, error=?, parsed_summary_json=?, problem_count=? WHERE id=?",
        (
            state,
            now,
            elapsed_ms,
            exit_code,
            error or None,
            json.dumps(parsed_summary or {}, ensure_ascii=False),
            problem_count,
            command_id,
        ),
    )
    get_db().commit()
    row = get_db().execute("SELECT * FROM vivado_commands WHERE id=?", (command_id,)).fetchone()
    return dict(row) if row else None

def vivado_command_list(
    session_id: str = "",
    target_id: str = "",
    limit: int = 50,
) -> list[dict]:
    q = "SELECT * FROM vivado_commands WHERE 1=1"
    params: list = []
    if session_id:
        q += " AND session_id=?"
        params.append(session_id)
    if target_id:
        q += " AND target_id=?"
        params.append(target_id)
    q += " ORDER BY started_at DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in get_db().execute(q, params)]

# ── Task canvases (Phase A memory) ───────────────────────────

def canvas_create(
    task_id: str,
    session_id: str,
    mermaid_artifact_id: str,
    *,
    node_count: int = 0,
    token_count: int | None = None,
    version: int = 1,
    state: str = "active",
    metadata: dict | None = None,
) -> dict:
    cid = _uid()
    now = _now()
    db = get_db()
    db.execute(
        """INSERT INTO task_canvases(
          id,task_id,session_id,mermaid_artifact_id,node_count,token_count,version,state,created_at,updated_at,metadata_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (
            cid,
            task_id,
            session_id,
            mermaid_artifact_id,
            node_count,
            token_count,
            version,
            state,
            now,
            now,
            json.dumps(metadata or {}, ensure_ascii=False),
        ),
    )
    db.commit()
    return dict(db.execute("SELECT * FROM task_canvases WHERE id=?", (cid,)).fetchone())


def canvas_update(canvas_id: str, **fields) -> dict | None:
    if not fields:
        return canvas_get(canvas_id)
    if "metadata" in fields and "metadata_json" not in fields:
        fields["metadata_json"] = json.dumps(fields.pop("metadata"), ensure_ascii=False)
    fields["updated_at"] = _now()
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [canvas_id]
    get_db().execute(f"UPDATE task_canvases SET {sets} WHERE id=?", vals)
    get_db().commit()
    return canvas_get(canvas_id)


def canvas_update_if_version(canvas_id: str, expected_version: int, **fields) -> dict | None:
    """Optimistic update; returns None when version mismatches (concurrent writer)."""
    if not fields:
        return canvas_get(canvas_id)
    if "metadata" in fields and "metadata_json" not in fields:
        fields["metadata_json"] = json.dumps(fields.pop("metadata"), ensure_ascii=False)
    fields = dict(fields)
    fields["updated_at"] = _now()
    if "version" not in fields:
        fields["version"] = int(expected_version) + 1
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [canvas_id, expected_version]
    cur = get_db().execute(
        f"UPDATE task_canvases SET {sets} WHERE id=? AND version=?",
        vals,
    )
    get_db().commit()
    if cur.rowcount == 0:
        return None
    return canvas_get(canvas_id)


def canvas_get(canvas_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM task_canvases WHERE id=?", (canvas_id,)).fetchone()
    return dict(row) if row else None


def canvas_get_active_for_task(task_id: str) -> dict | None:
    row = get_db().execute(
        "SELECT * FROM task_canvases WHERE task_id=? AND state='active' ORDER BY updated_at DESC LIMIT 1",
        (task_id,),
    ).fetchone()
    return dict(row) if row else None


def canvas_list_for_session(session_id: str, limit: int = 3, state: str = "archived") -> list[dict]:
    return [
        dict(r)
        for r in get_db().execute(
            "SELECT * FROM task_canvases WHERE session_id=? AND state=? ORDER BY updated_at DESC LIMIT ?",
            (session_id, state, limit),
        )
    ]


def canvas_node_ref_create(
    canvas_id: str,
    node_id: str,
    ref_type: str,
    ref_id: str,
    *,
    label: str = "",
) -> dict:
    rid = _uid()
    now = _now()
    db = get_db()
    db.execute(
        """INSERT INTO canvas_node_refs(id,canvas_id,node_id,ref_type,ref_id,label,created_at)
           VALUES(?,?,?,?,?,?,?)""",
        (rid, canvas_id, node_id, ref_type, ref_id, label or None, now),
    )
    db.commit()
    return dict(db.execute("SELECT * FROM canvas_node_refs WHERE id=?", (rid,)).fetchone())


def canvas_node_ref_list(canvas_id: str) -> list[dict]:
    return [
        dict(r)
        for r in get_db().execute(
            "SELECT * FROM canvas_node_refs WHERE canvas_id=? ORDER BY created_at ASC",
            (canvas_id,),
        )
    ]


def canvas_node_ref_get_by_node_id(node_id: str) -> dict | None:
    row = get_db().execute(
        "SELECT * FROM canvas_node_refs WHERE node_id=? ORDER BY created_at DESC LIMIT 1",
        (node_id,),
    ).fetchone()
    return dict(row) if row else None


# ── Memory atoms (Phase B — L1) ──────────────────────────────

def atom_create(
    *,
    scope: str = "project",
    project_id: str = "",
    atom_type: str,
    subject: str,
    object: str,
    predicate: str = "",
    confidence: float = 0.7,
    source_session_id: str = "",
    source_message_id: str = "",
    source_run_id: str = "",
    evidence_artifact_id: str = "",
    metadata: dict | None = None,
) -> dict:
    aid = _uid()
    now = _now()
    db = get_db()
    db.execute(
        """INSERT INTO memory_atoms(
          id,scope,project_id,atom_type,subject,predicate,object,confidence,
          source_session_id,source_message_id,source_run_id,evidence_artifact_id,
          created_at,updated_at,metadata_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            aid,
            scope,
            project_id or None,
            atom_type,
            subject,
            predicate or None,
            object,
            confidence,
            source_session_id or None,
            source_message_id or None,
            source_run_id or None,
            evidence_artifact_id or None,
            now,
            now,
            json.dumps(metadata or {}, ensure_ascii=False),
        ),
    )
    db.commit()
    return dict(db.execute("SELECT * FROM memory_atoms WHERE id=?", (aid,)).fetchone())


def atom_get(atom_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM memory_atoms WHERE id=?", (atom_id,)).fetchone()
    return dict(row) if row else None


def atom_list(
    project_id: str = "",
    *,
    scope: str = "",
    atom_type: str = "",
    session_id: str = "",
    limit: int = 50,
) -> list[dict]:
    q = "SELECT * FROM memory_atoms WHERE superseded_by IS NULL"
    params: list = []
    if project_id:
        q += " AND project_id=?"
        params.append(project_id)
    if scope:
        q += " AND scope=?"
        params.append(scope)
    if atom_type:
        q += " AND atom_type=?"
        params.append(atom_type)
    if session_id:
        q += " AND source_session_id=?"
        params.append(session_id)
    q += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in get_db().execute(q, params)]


def atom_count(project_id: str = "", *, atom_type: str = "") -> int:
    q = "SELECT COUNT(*) AS n FROM memory_atoms WHERE superseded_by IS NULL"
    params: list = []
    if project_id:
        q += " AND project_id=?"
        params.append(project_id)
    if atom_type:
        q += " AND atom_type=?"
        params.append(atom_type)
    row = get_db().execute(q, params).fetchone()
    return int(row["n"]) if row else 0


def atom_find_duplicate(
    project_id: str,
    subject: str,
    predicate: str,
    object: str,
) -> dict | None:
    row = get_db().execute(
        """SELECT * FROM memory_atoms
           WHERE project_id=? AND subject=? AND IFNULL(predicate,'')=IFNULL(?,'')
             AND object=? AND superseded_by IS NULL
           ORDER BY created_at DESC LIMIT 1""",
        (project_id, subject, predicate or "", object),
    ).fetchone()
    return dict(row) if row else None


def atom_find_by_overlay_id(project_id: str, overlay_id: str) -> dict | None:
    row = get_db().execute(
        """SELECT * FROM memory_atoms
           WHERE project_id=? AND atom_type='config' AND superseded_by IS NULL
             AND json_extract(metadata_json, '$.overlay_id')=?
           ORDER BY created_at DESC LIMIT 1""",
        (project_id, overlay_id),
    ).fetchone()
    return dict(row) if row else None


def atom_find_similar(
    project_id: str,
    atom_type: str,
    subject: str,
    predicate: str,
    object: str,
    *,
    prefix_len: int = 48,
) -> dict | None:
    """Prefix-level dedup for noisy event atoms with near-identical objects."""
    if not project_id or not object:
        return None
    prefix = object[:prefix_len]
    row = get_db().execute(
        """SELECT * FROM memory_atoms
           WHERE project_id=? AND atom_type=? AND subject=?
             AND IFNULL(predicate,'')=IFNULL(?,'')
             AND superseded_by IS NULL
             AND (object LIKE ? OR ? LIKE object || '%')
           ORDER BY created_at DESC LIMIT 1""",
        (project_id, atom_type, subject, predicate or "", f"{prefix}%", object),
    ).fetchone()
    return dict(row) if row else None


# ── Memory scenarios (Phase C — L2) ──────────────────────────

def scenario_create(
    *,
    project_id: str,
    title: str,
    summary_md_path: str,
    atom_ids: list[str],
    scope: str = "project",
    trigger_pattern: str = "",
    metadata: dict | None = None,
) -> dict:
    sid = _uid()
    now = _now()
    db = get_db()
    db.execute(
        """INSERT INTO memory_scenarios(
          id,scope,project_id,title,summary_md_path,atom_ids_json,trigger_pattern,
          occurrence_count,last_seen_at,created_at,updated_at,metadata_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            sid,
            scope,
            project_id or None,
            title,
            summary_md_path,
            json.dumps(atom_ids, ensure_ascii=False),
            trigger_pattern or None,
            1,
            now,
            now,
            now,
            json.dumps(metadata or {}, ensure_ascii=False),
        ),
    )
    db.commit()
    return dict(db.execute("SELECT * FROM memory_scenarios WHERE id=?", (sid,)).fetchone())


def scenario_update(scenario_id: str, **fields) -> dict | None:
    if not fields:
        return scenario_get(scenario_id)
    if "atom_ids" in fields:
        fields["atom_ids_json"] = json.dumps(fields.pop("atom_ids"), ensure_ascii=False)
    if "metadata" in fields:
        fields["metadata_json"] = json.dumps(fields.pop("metadata"), ensure_ascii=False)
    fields["updated_at"] = _now()
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [scenario_id]
    get_db().execute(f"UPDATE memory_scenarios SET {sets} WHERE id=?", vals)
    get_db().commit()
    return scenario_get(scenario_id)


def scenario_get(scenario_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM memory_scenarios WHERE id=?", (scenario_id,)).fetchone()
    return dict(row) if row else None


def scenario_find_by_title(project_id: str, title: str) -> dict | None:
    row = get_db().execute(
        "SELECT * FROM memory_scenarios WHERE project_id=? AND title=? ORDER BY updated_at DESC LIMIT 1",
        (project_id, title),
    ).fetchone()
    return dict(row) if row else None


def scenario_list(project_id: str = "", *, limit: int = 50) -> list[dict]:
    q = "SELECT * FROM memory_scenarios WHERE 1=1"
    params: list = []
    if project_id:
        q += " AND project_id=?"
        params.append(project_id)
    q += " ORDER BY updated_at DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in get_db().execute(q, params)]


# ── Memory personas (Phase C — L3) ───────────────────────────

def persona_create(
    *,
    scope: str,
    project_id: str,
    persona_md_path: str,
    version: int = 1,
    atom_count_at_build: int = 0,
    scenario_count_at_build: int = 0,
    metadata: dict | None = None,
) -> dict:
    pid = _uid()
    now = _now()
    db = get_db()
    db.execute(
        """INSERT INTO memory_personas(
          id,scope,project_id,persona_md_path,version,atom_count_at_build,
          scenario_count_at_build,built_at,metadata_json
        ) VALUES(?,?,?,?,?,?,?,?,?)""",
        (
            pid,
            scope,
            project_id or None,
            persona_md_path,
            version,
            atom_count_at_build,
            scenario_count_at_build,
            now,
            json.dumps(metadata or {}, ensure_ascii=False),
        ),
    )
    db.commit()
    return dict(db.execute("SELECT * FROM memory_personas WHERE id=?", (pid,)).fetchone())


def persona_latest(project_id: str, *, scope: str = "project") -> dict | None:
    row = get_db().execute(
        """SELECT * FROM memory_personas
           WHERE scope=? AND project_id=? AND superseded_by IS NULL
           ORDER BY version DESC LIMIT 1""",
        (scope, project_id),
    ).fetchone()
    return dict(row) if row else None


def persona_next_version(project_id: str, *, scope: str = "project") -> int:
    row = get_db().execute(
        "SELECT MAX(version) AS v FROM memory_personas WHERE scope=? AND project_id=?",
        (scope, project_id),
    ).fetchone()
    return int(row["v"] or 0) + 1 if row else 1


# ── Connectors (Phase 6A) ────────────────────────────────────

def connector_upsert(
    connector_id: str,
    tool_name: str,
    *,
    version: str = "",
    supported_versions: list[str] | None = None,
    status: str = "ready",
    last_health: dict | None = None,
    metadata: dict | None = None,
) -> dict:
    db = get_db()
    now = _now()
    row = db.execute("SELECT id FROM connectors WHERE connector_id=?", (connector_id,)).fetchone()
    health_json = json.dumps(last_health, ensure_ascii=False) if last_health else None
    meta_json = json.dumps(metadata or {}, ensure_ascii=False)
    versions_json = json.dumps(supported_versions or [], ensure_ascii=False)
    if row:
        db.execute(
            """UPDATE connectors SET tool_name=?, version=?, supported_versions_json=?,
               status=?, last_health_at=?, last_health_json=?, updated_at=?, metadata_json=?
               WHERE connector_id=?""",
            (
                tool_name, version or None, versions_json, status,
                now if last_health else None, health_json, now, meta_json, connector_id,
            ),
        )
        cid = row["id"]
    else:
        cid = _uid()
        db.execute(
            """INSERT INTO connectors(
              id,connector_id,tool_name,version,supported_versions_json,status,
              last_health_at,last_health_json,created_at,updated_at,metadata_json
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (
                cid, connector_id, tool_name, version or None, versions_json, status,
                now if last_health else None, health_json, now, now, meta_json,
            ),
        )
    db.commit()
    return connector_get(connector_id) or {}


def connector_get(connector_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM connectors WHERE connector_id=?", (connector_id,)).fetchone()
    return dict(row) if row else None


def connector_list() -> list[dict]:
    return [dict(r) for r in get_db().execute("SELECT * FROM connectors ORDER BY tool_name").fetchall()]


def capability_upsert(
    connector_id: str,
    capability_id: str,
    *,
    display_name: str = "",
    stage: str = "",
    risk_level: str = "low",
    requires_approval: bool = False,
    input_schema: dict | None = None,
    outputs: list[str] | None = None,
    supports_stop: bool = True,
    supports_mock: bool = True,
) -> dict:
    db = get_db()
    row = db.execute(
        "SELECT id FROM connector_capabilities WHERE connector_id=? AND capability_id=?",
        (connector_id, capability_id),
    ).fetchone()
    schema_json = json.dumps(input_schema or {}, ensure_ascii=False)
    outputs_json = json.dumps(outputs or [], ensure_ascii=False)
    if row:
        db.execute(
            """UPDATE connector_capabilities SET display_name=?, stage=?, risk_level=?,
               requires_approval=?, supports_stop=?, supports_mock=?,
               input_schema_json=?, outputs_json=? WHERE id=?""",
            (
                display_name, stage, risk_level, int(requires_approval),
                int(supports_stop), int(supports_mock), schema_json, outputs_json, row["id"],
            ),
        )
        cap_id = row["id"]
    else:
        cap_id = _uid()
        db.execute(
            """INSERT INTO connector_capabilities(
              id,connector_id,capability_id,display_name,stage,risk_level,
              requires_approval,supports_stop,supports_mock,input_schema_json,outputs_json
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (
                cap_id, connector_id, capability_id, display_name, stage, risk_level,
                int(requires_approval), int(supports_stop), int(supports_mock),
                schema_json, outputs_json,
            ),
        )
    db.commit()
    return dict(db.execute("SELECT * FROM connector_capabilities WHERE id=?", (cap_id,)).fetchone())


def capability_list(connector_id: str | None = None) -> list[dict]:
    if connector_id:
        q = "SELECT * FROM connector_capabilities WHERE connector_id=? ORDER BY stage, capability_id"
        return [dict(r) for r in get_db().execute(q, (connector_id,)).fetchall()]
    return [dict(r) for r in get_db().execute(
        "SELECT * FROM connector_capabilities ORDER BY connector_id, stage"
    ).fetchall()]


def run_step_create(
    run_id: str,
    *,
    session_id: str = "",
    task_id: str = "",
    connector_id: str = "",
    capability_id: str = "",
    stage: str,
    name: str,
    command_text: str = "",
) -> dict:
    sid = _uid()
    now = _now()
    get_db().execute(
        """INSERT INTO run_steps(
          id,run_id,session_id,task_id,connector_id,capability_id,stage,name,
          state,started_at,command_text
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (
            sid, run_id, session_id or None, task_id or None,
            connector_id or None, capability_id or None, stage, name,
            "pending", now, command_text or None,
        ),
    )
    get_db().commit()
    return run_step_get(sid) or {}


def run_step_get(step_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM run_steps WHERE id=?", (step_id,)).fetchone()
    return dict(row) if row else None


def run_step_update(step_id: str, **fields) -> dict | None:
    if not fields:
        return run_step_get(step_id)
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [step_id]
    get_db().execute(f"UPDATE run_steps SET {sets} WHERE id=?", vals)
    get_db().commit()
    return run_step_get(step_id)


def run_step_list(run_id: str) -> list[dict]:
    return [
        dict(r)
        for r in get_db().execute(
            "SELECT * FROM run_steps WHERE run_id=? ORDER BY started_at ASC, id ASC",
            (run_id,),
        ).fetchall()
    ]


def parsed_report_create(
    run_id: str,
    connector_id: str,
    report_type: str,
    stage: str,
    data: dict,
    *,
    step_id: str = "",
    source_artifact_id: str = "",
    metadata: dict | None = None,
) -> dict:
    rid = _uid()
    now = _now()
    get_db().execute(
        """INSERT INTO parsed_reports(
          id,run_id,step_id,connector_id,report_type,stage,
          source_artifact_id,data_json,created_at,metadata_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?)""",
        (
            rid, run_id, step_id or None, connector_id, report_type, stage,
            source_artifact_id or None,
            json.dumps(data, ensure_ascii=False), now,
            json.dumps(metadata or {}, ensure_ascii=False),
        ),
    )
    get_db().commit()
    return parsed_report_get(rid) or {}


def parsed_report_get(report_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM parsed_reports WHERE id=?", (report_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    if d.get("data_json"):
        try:
            d["data"] = json.loads(d["data_json"])
        except json.JSONDecodeError:
            d["data"] = {}
    return d


def parsed_report_trends(
    report_type: str = "timing_summary",
    *,
    session_id: str = "",
    metric: str = "wns",
    limit: int = 20,
) -> list[dict]:
    """Time-series points for a metric across recent runs (IA-F)."""
    q = """
        SELECT pr.id, pr.run_id, pr.report_type, pr.stage, pr.data_json, pr.created_at,
               r.session_id, r.name AS run_name, r.started_at
        FROM parsed_reports pr
        LEFT JOIN runs r ON r.id = pr.run_id
        WHERE pr.report_type = ?
    """
    params: list = [report_type]
    if session_id:
        q += " AND r.session_id = ?"
        params.append(session_id)
    q += " ORDER BY pr.created_at ASC LIMIT ?"
    params.append(limit)
    points: list[dict] = []
    for row in get_db().execute(q, params).fetchall():
        d = dict(row)
        data: dict = {}
        if d.get("data_json"):
            try:
                data = json.loads(d["data_json"])
            except json.JSONDecodeError:
                data = {}
        raw = data.get(metric)
        if raw is None:
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        label = (d.get("run_name") or d.get("run_id") or d.get("id") or "")[:12]
        points.append({
            "report_id": d.get("id"),
            "run_id": d.get("run_id"),
            "session_id": d.get("session_id"),
            "report_type": d.get("report_type"),
            "stage": d.get("stage"),
            "metric": metric,
            "value": value,
            "label": label,
            "created_at": d.get("created_at"),
        })
    return points


def parsed_report_list(run_id: str = "", step_id: str = "", report_type: str = "") -> list[dict]:
    q = "SELECT * FROM parsed_reports WHERE 1=1"
    params: list = []
    if run_id:
        q += " AND run_id=?"
        params.append(run_id)
    if step_id:
        q += " AND step_id=?"
        params.append(step_id)
    if report_type:
        q += " AND report_type=?"
        params.append(report_type)
    q += " ORDER BY created_at DESC"
    out = []
    for row in get_db().execute(q, params).fetchall():
        d = dict(row)
        if d.get("data_json"):
            try:
                d["data"] = json.loads(d["data_json"])
            except json.JSONDecodeError:
                d["data"] = {}
        out.append(d)
    return out


# ── Patch proposals & approvals (Phase 6D) ───────────────────


def patch_proposal_create(
    connector_id: str,
    target_file: str,
    patch_type: str,
    *,
    run_id: str = "",
    step_id: str = "",
    session_id: str = "",
    task_id: str = "",
    problem_id: str = "",
    capability_id: str = "",
    risk_level: str = "medium",
    reason: str = "",
    diff_text: str = "",
    approval_id: str = "",
    metadata: dict | None = None,
) -> dict:
    pid = _uid()
    now = _now()
    get_db().execute(
        """INSERT INTO patch_proposals(
          id,run_id,step_id,session_id,task_id,problem_id,connector_id,capability_id,
          target_file,patch_type,risk_level,reason,diff_text,status,approval_id,
          created_at,metadata_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            pid, run_id or None, step_id or None, session_id or None, task_id or None,
            problem_id or None, connector_id, capability_id or None,
            target_file, patch_type, risk_level, reason or None, diff_text or None,
            "pending", approval_id or None, now,
            json.dumps(metadata or {}, ensure_ascii=False),
        ),
    )
    get_db().commit()
    return patch_proposal_get(pid) or {}


def patch_proposal_get(patch_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM patch_proposals WHERE id=?", (patch_id,)).fetchone()
    return dict(row) if row else None


def patch_proposal_list(
    *,
    run_id: str = "",
    session_id: str = "",
    status: str = "",
    limit: int = 100,
) -> list[dict]:
    q = "SELECT * FROM patch_proposals WHERE 1=1"
    params: list = []
    if run_id:
        q += " AND run_id=?"
        params.append(run_id)
    if session_id:
        q += " AND session_id=?"
        params.append(session_id)
    if status:
        q += " AND status=?"
        params.append(status)
    q += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in get_db().execute(q, params).fetchall()]


def patch_proposal_update(patch_id: str, **fields) -> dict | None:
    if not fields:
        return patch_proposal_get(patch_id)
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [patch_id]
    get_db().execute(f"UPDATE patch_proposals SET {sets} WHERE id=?", vals)
    get_db().commit()
    return patch_proposal_get(patch_id)


def approval_create(
    approval_type: str,
    payload: dict,
    *,
    session_id: str = "",
    task_id: str = "",
    run_id: str = "",
    step_id: str = "",
    connector_id: str = "",
    capability_id: str = "",
    risk_level: str = "low",
    interaction_id: str = "",
    metadata: dict | None = None,
) -> dict:
    aid = _uid()
    now = _now()
    get_db().execute(
        """INSERT INTO approvals(
          id,session_id,task_id,run_id,step_id,connector_id,capability_id,
          approval_type,risk_level,payload_json,status,interaction_id,
          created_at,metadata_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            aid, session_id or None, task_id or None, run_id or None, step_id or None,
            connector_id or None, capability_id or None,
            approval_type, risk_level,
            json.dumps(payload, ensure_ascii=False), "pending",
            interaction_id or None, now,
            json.dumps(metadata or {}, ensure_ascii=False),
        ),
    )
    get_db().commit()
    return approval_get(aid) or {}


def approval_get(approval_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM approvals WHERE id=?", (approval_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    if d.get("payload_json"):
        try:
            d["payload"] = json.loads(d["payload_json"])
        except json.JSONDecodeError:
            d["payload"] = {}
    return d


def approval_list(
    *,
    status: str = "pending",
    session_id: str = "",
    connector_id: str = "",
    approval_type: str = "",
    limit: int = 100,
) -> list[dict]:
    q = "SELECT * FROM approvals WHERE 1=1"
    params: list = []
    if status:
        q += " AND status=?"
        params.append(status)
    if session_id:
        q += " AND session_id=?"
        params.append(session_id)
    if connector_id:
        q += " AND connector_id=?"
        params.append(connector_id)
    if approval_type:
        q += " AND approval_type=?"
        params.append(approval_type)
    q += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    out = []
    for row in get_db().execute(q, params).fetchall():
        d = dict(row)
        if d.get("payload_json"):
            try:
                d["payload"] = json.loads(d["payload_json"])
            except json.JSONDecodeError:
                d["payload"] = {}
        out.append(d)
    return out


def approval_update(approval_id: str, **fields) -> dict | None:
    if not fields:
        return approval_get(approval_id)
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [approval_id]
    get_db().execute(f"UPDATE approvals SET {sets} WHERE id=?", vals)
    get_db().commit()
    return approval_get(approval_id)


def approval_find_by_interaction(interaction_id: str) -> dict | None:
    row = get_db().execute(
        "SELECT * FROM approvals WHERE interaction_id=? ORDER BY created_at DESC LIMIT 1",
        (interaction_id,),
    ).fetchone()
    if not row:
        return None
    d = dict(row)
    if d.get("payload_json"):
        try:
            d["payload"] = json.loads(d["payload_json"])
        except json.JSONDecodeError:
            d["payload"] = {}
    return d


# ── Tool run requests (Phase 6 — Controlled Execution) ───────


def tool_run_request_create(
    run_id: str,
    connector_id: str,
    capability_id: str,
    *,
    step_id: str = "",
    command_id: str = "",
    executable: str = "",
    args: list | None = None,
    cwd: str = "",
    env_profile: str = "",
    allowed_paths: list | None = None,
    timeout_sec: int = 3600,
    state: str = "prepared",
    metadata: dict | None = None,
) -> dict:
    rid = _uid()
    now = _now()
    get_db().execute(
        """INSERT INTO tool_run_requests(
          id,run_id,step_id,connector_id,capability_id,command_id,
          executable,args_json,cwd,env_profile,allowed_paths_json,
          timeout_sec,state,created_at,metadata_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            rid, run_id, step_id or None, connector_id, capability_id,
            command_id or None, executable or None,
            json.dumps(args or [], ensure_ascii=False),
            cwd or None, env_profile or None,
            json.dumps(allowed_paths or [], ensure_ascii=False),
            timeout_sec, state, now,
            json.dumps(metadata or {}, ensure_ascii=False),
        ),
    )
    get_db().commit()
    return tool_run_request_get(rid) or {}


def tool_run_request_get(request_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM tool_run_requests WHERE id=?", (request_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    for key, col in (("args", "args_json"), ("allowed_paths", "allowed_paths_json")):
        if d.get(col):
            try:
                d[key] = json.loads(d[col])
            except json.JSONDecodeError:
                d[key] = []
    return d


def tool_run_request_list(run_id: str = "", step_id: str = "") -> list[dict]:
    q = "SELECT * FROM tool_run_requests WHERE 1=1"
    params: list = []
    if run_id:
        q += " AND run_id=?"
        params.append(run_id)
    if step_id:
        q += " AND step_id=?"
        params.append(step_id)
    q += " ORDER BY created_at ASC"
    out = []
    for row in get_db().execute(q, params).fetchall():
        d = dict(row)
        if d.get("args_json"):
            try:
                d["args"] = json.loads(d["args_json"])
            except json.JSONDecodeError:
                d["args"] = []
        out.append(d)
    return out
