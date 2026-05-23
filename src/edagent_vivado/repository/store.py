"""Session, Task, Message, Event, Run, ToolCall CRUD for Phase 1."""

from __future__ import annotations
import json, time, uuid as _uuid
from edagent_vivado.repository.db import get_db, init_db

# ensure tables exist on first import
init_db()

def _now() -> int: return int(time.time())
def _uid() -> str: return _uuid.uuid4().hex[:12]

# ── Sessions ─────────────────────────────────────────────────

def session_list(status: str | None = None, limit: int = 50) -> list[dict]:
    db = get_db()
    q = "SELECT * FROM sessions WHERE deleted_at IS NULL"
    params = []
    if status:
        q += " AND status=?"
        params.append(status)
    q += " AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in db.execute(q, params)]

def session_get(sid: str) -> dict | None:
    row = get_db().execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
    return dict(row) if row else None

def session_create(name: str = "", manifest_path: str = "", metadata: dict | None = None) -> dict:
    sid = _uid(); now = _now(); name = name or f"Chat {time.strftime('%m-%d %H:%M')}"
    db = get_db()
    db.execute("INSERT INTO sessions(id,name,status,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?)",
               (sid, name, "idle", now, now, json.dumps(metadata or {})))
    db.commit()
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
    if hard:
        db.execute("DELETE FROM sessions WHERE id=?", (sid,))
        db.execute("DELETE FROM messages WHERE session_id=?", (sid,))
        db.execute("DELETE FROM events WHERE session_id=?", (sid,))
        db.execute("DELETE FROM tasks WHERE session_id=?", (sid,))
        db.execute("DELETE FROM runs WHERE session_id=?", (sid,))
        db.execute("DELETE FROM tool_calls WHERE session_id=?", (sid,))
    else:
        db.execute("UPDATE sessions SET archived_at=? WHERE id=?", (_now(), sid))
    db.commit()
    return True

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
    db.execute("INSERT INTO messages(id,session_id,task_id,agent_id,role,content,stopped,partial,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
               (mid, session_id, task_id or None, agent_id or None, role, content, int(stopped), int(partial), now))
    db.execute("UPDATE sessions SET updated_at=?, message_count=message_count+1 WHERE id=?", (now, session_id))
    db.commit()
    return dict(db.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone())

# ── Tasks ────────────────────────────────────────────────────

def task_create(session_id: str, user_message_id: str = "") -> dict:
    tid = _uid(); now = _now()
    db = get_db()
    db.execute("INSERT INTO tasks(id,session_id,user_message_id,state,started_at,updated_at) VALUES(?,?,?,?,?,?)",
               (tid, session_id, user_message_id or None, "created", now, now))
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
    db.execute("INSERT INTO events(id,session_id,task_id,run_id,parent_run_id,agent_id,seq,event_type,created_at,payload_json,artifact_id,visibility) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
               (eid, session_id, task_id or None, run_id or None, parent_run_id or None, agent_id or None,
                seq, event_type, now, json.dumps(payload, ensure_ascii=False), artifact_id or None, visibility))
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

# ── Runs ─────────────────────────────────────────────────────

def run_create(run_type: str, name: str, session_id: str = "", task_id: str = "",
               parent_run_id: str = "", agent_id: str = "") -> dict:
    rid = _uid(); now = _now()
    db = get_db()
    db.execute("INSERT INTO runs(id,session_id,task_id,parent_run_id,agent_id,run_type,name,state,started_at) VALUES(?,?,?,?,?,?,?,?,?)",
               (rid, session_id or None, task_id or None, parent_run_id or None, agent_id or None, run_type, name, "started", now))
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
    db.execute("INSERT INTO tool_calls(id,run_id,session_id,task_id,agent_id,tool_name,state,started_at,input_summary) VALUES(?,?,?,?,?,?,?,?,?)",
               (cid, run_id, session_id or None, task_id or None, agent_id or None, tool_name, "started", now, input_summary))
    db.execute("UPDATE sessions SET tool_call_count=tool_call_count+1 WHERE id=?", (session_id,))
    db.commit()
    return dict(db.execute("SELECT * FROM tool_calls WHERE id=?", (cid,)).fetchone())

def toolcall_update(cid: str, **fields) -> dict | None:
    if not fields: return toolcall_get(cid)
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [cid]
    get_db().execute(f"UPDATE tool_calls SET {sets} WHERE id=?", vals)
    get_db().commit()
    return toolcall_get(cid)

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
    db.execute("INSERT INTO llm_usage(id,run_id,session_id,task_id,agent_id,provider,model,model_role,input_tokens,output_tokens,total_tokens,usage_source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
               (uid, run_id, session_id or None, task_id or None, agent_id or None, provider, model,
                model_role, input_tokens, output_tokens, total_tokens, usage_source, now))
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
    db.execute(
        "INSERT INTO memory_snapshots(id,session_id,task_id,summary,summary_model,source_message_until,source_event_until_seq,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)",
        (mid, session_id, task_id or None, summary, summary_model, source_message_until or None,
         source_event_until_seq, now, json.dumps(metadata or {}, ensure_ascii=False)),
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
    db.execute(
        "INSERT INTO retrieval_audits(id,session_id,task_id,run_id,agent_id,query,rewritten_query,intent_json,filters_json,candidate_count,selected_count,rejected_count,token_budget,token_used,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (rid, session_id or None, task_id or None, run_id or None, agent_id or None, query, rewritten_query or None,
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
    db.execute(
        "INSERT INTO context_packages(id,session_id,task_id,run_id,agent_id,model,max_context_tokens,total_tokens,system_tokens,question_tokens,memory_tokens,recent_message_tokens,project_context_tokens,error_kb_tokens,semantic_kb_tokens,tool_summary_tokens,problem_summary_tokens,truncated,created_at,artifact_id,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (cid, session_id, task_id or None, run_id or None, agent_id or None, model or None, max_context_tokens,
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
    pid = _uid(); now = _now(); db = get_db()
    db.execute(
        "INSERT INTO problems(id,session_id,task_id,run_id,source,severity,category,signature,normalized_signature,message,detected_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (pid, session_id or None, task_id or None, run_id or None, source, severity, category,
         signature, normalized_signature, message, now, json.dumps(metadata or {}, ensure_ascii=False)),
    )
    if session_id:
        db.execute("UPDATE sessions SET problem_count=problem_count+1 WHERE id=?", (session_id,))
    db.commit()
    return dict(db.execute("SELECT * FROM problems WHERE id=?", (pid,)).fetchone())

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
    db.execute(
        "INSERT INTO artifacts(id,session_id,task_id,run_id,artifact_type,path,mime_type,size_bytes,sha256,summary,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (aid, session_id or None, task_id or None, run_id or None, artifact_type, path,
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
    now = _now()
    get_db().execute(
        "UPDATE kb_candidates SET status='approved', reviewed_at=?, reviewed_by=? WHERE id=?",
        (now, reviewed_by, cand_id))
    get_db().commit()
    return kb_candidate_get(cand_id)

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
