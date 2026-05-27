"""Patch proposal persistence + lifecycle — Phase 7."""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

from edagent_vivado.patches.applier import ApplyResult, PatchApplyError, apply_proposal, revert_proposal
from edagent_vivado.patches.diff_engine import populate_diff_for_change
from edagent_vivado.patches.proposal import (
    PatchChange,
    PatchProposal,
    PatchState,
    assert_patch_transition,
    compute_sha256,
)
from edagent_vivado.patches.risk_classifier import RiskAssessment, classify_file, classify_risk

logger = logging.getLogger(__name__)

V7_META_KEY = "v7"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _resolve_project_root(project_id: str = "", run_id: str = "") -> dict | None:
    from edagent_vivado.repository.store import project_get, run_get

    if project_id:
        p = project_get(project_id)
        if p:
            return p
    if run_id:
        run = run_get(run_id)
        if run and run.get("project_id"):
            return project_get(str(run["project_id"]))
    return None


def proposal_from_row(row: dict) -> PatchProposal:
    meta = {}
    try:
        meta = json.loads(row.get("metadata_json") or "{}")
    except json.JSONDecodeError:
        pass
    if V7_META_KEY in meta:
        d = meta[V7_META_KEY]
        p = PatchProposal(
            id=str(row["id"]),
            session_id=d.get("session_id", row.get("session_id") or ""),
            task_id=d.get("task_id", row.get("task_id") or ""),
            run_id=d.get("run_id", row.get("run_id") or ""),
            project_id=d.get("project_id", ""),
            title=d.get("title", row.get("reason") or "patch"),
            summary=d.get("summary", ""),
            rationale=d.get("rationale", row.get("reason") or ""),
            risk_level=d.get("risk_level", row.get("risk_level") or "medium"),
            state=d.get("state", _status_to_state(row.get("status", "pending"))),
            created_by=d.get("created_by", "agent"),
            created_at=d.get("created_at", row.get("created_at") or 0),
            updated_at=d.get("updated_at", row.get("created_at") or 0),
            applied_at=d.get("applied_at", row.get("applied_at")),
            reviewer_id=d.get("reviewer_id", ""),
            review_reason=d.get("review_reason", ""),
            superseded_by=d.get("superseded_by", ""),
            spawned_run_id=d.get("spawned_run_id", ""),
            approval_id=d.get("approval_id", row.get("approval_id") or ""),
        )
        p.changes = [PatchChange(**c) for c in d.get("changes", [])]
        return p

    # Legacy single-file row
    action = "modify"
    before = ""
    after = ""
    approval_payload: dict = {}
    if row.get("approval_id"):
        from edagent_vivado.repository.store import approval_get

        appr = approval_get(str(row["approval_id"]))
        if appr:
            approval_payload = appr.get("payload") or {}
            before = str(approval_payload.get("old_text") or "")
            after = str(approval_payload.get("new_text") or "")
    ch = PatchChange(
        path=str(row.get("target_file") or approval_payload.get("file_path") or ""),
        action=action,
        file_category=classify_file(str(row.get("target_file") or "")),
        before_text=before,
        after_text=after,
        diff_text=str(row.get("diff_text") or ""),
    )
    if ch.before_text and not ch.before_sha256:
        ch.before_sha256 = compute_sha256(ch.before_text)
    if ch.after_text and not ch.after_sha256:
        ch.after_sha256 = compute_sha256(ch.after_text)
    return PatchProposal(
        id=str(row["id"]),
        session_id=str(row.get("session_id") or ""),
        task_id=str(row.get("task_id") or ""),
        run_id=str(row.get("run_id") or ""),
        project_id="",
        title=str(row.get("reason") or "patch")[:120],
        summary="",
        rationale=str(row.get("reason") or ""),
        risk_level=str(row.get("risk_level") or "medium"),
        state=_status_to_state(str(row.get("status") or "pending")),
        changes=[ch],
        created_at=int(row.get("created_at") or 0),
        updated_at=int(row.get("created_at") or 0),
        applied_at=row.get("applied_at"),
        approval_id=str(row.get("approval_id") or ""),
    )


def _status_to_state(status: str) -> str:
    mapping = {
        "pending": PatchState.PROPOSED.value,
        "proposed": PatchState.PROPOSED.value,
        "approved": PatchState.APPROVED.value,
        "applied": PatchState.APPLIED.value,
        "rejected": PatchState.REJECTED.value,
        "reverted": PatchState.REVERTED.value,
        "superseded": PatchState.SUPERSEDED.value,
        "draft": PatchState.DRAFT.value,
    }
    return mapping.get(status, status)


def _state_to_status(state: str) -> str:
    if state == PatchState.DRAFT.value:
        return "pending"
    return state


def _persist_proposal(proposal: PatchProposal, risk: RiskAssessment) -> dict:
    from edagent_vivado.repository.store import patch_proposal_create, patch_proposal_update

    first = proposal.changes[0] if proposal.changes else None
    combined_diff = "\n\n".join(c.diff_text for c in proposal.changes if c.diff_text)[:16000]
    meta = {
        V7_META_KEY: proposal.to_dict(),
        "risk_assessment": risk.to_dict(),
    }
    row = patch_proposal_create(
        "vivado",
        first.path if first else "",
        first.file_category if first else "other",
        run_id=proposal.run_id,
        session_id=proposal.session_id,
        task_id=proposal.task_id,
        risk_level=proposal.risk_level,
        reason=proposal.rationale[:2000],
        diff_text=combined_diff,
        approval_id=proposal.approval_id,
        metadata=meta,
    )
    proposal.id = row["id"]
    meta = {
        V7_META_KEY: proposal.to_dict(),
        "risk_assessment": risk.to_dict(),
    }
    patch_proposal_update(
        row["id"],
        status=_state_to_status(proposal.state),
        metadata_json=json.dumps(meta, ensure_ascii=False),
    )
    return patch_proposal_get_row(row["id"]) or row


def patch_proposal_get_row(patch_id: str) -> dict | None:
    from edagent_vivado.repository.store import patch_proposal_get

    row = patch_proposal_get(patch_id)
    if not row:
        return None
    p = proposal_from_row(row)
    out = p.to_dict()
    out["risk_assessment"] = {}
    try:
        meta = json.loads(row.get("metadata_json") or "{}")
        out["risk_assessment"] = meta.get("risk_assessment", {})
    except json.JSONDecodeError:
        pass
    out["status"] = row.get("status")
    return out


def patch_audit_log(
    patch_id: str,
    action: str,
    *,
    actor_id: str = "",
    reason: str = "",
    metadata: dict | None = None,
) -> None:
    from edagent_vivado.repository.store import patch_audit_log as _log

    _log(patch_id, action, actor_id=actor_id, reason=reason, metadata=metadata)


def patch_audits_for(patch_id: str) -> list[dict]:
    from edagent_vivado.repository.store import patch_audits_for as _list

    return _list(patch_id)


def build_changes_from_dicts(raw: list[dict], project_root: Path | None = None) -> list[PatchChange]:
    changes: list[PatchChange] = []
    for c in raw:
        path = str(c.get("path", ""))
        action = str(c.get("action", "modify"))
        ch = PatchChange(
            path=path,
            action=action,
            file_category=str(c.get("file_category") or classify_file(path)),
            before_text=str(c.get("before_text", "")),
            after_text=str(c.get("after_text", "")),
            before_sha256=str(c.get("before_sha256", "")),
            after_sha256=str(c.get("after_sha256", "")),
            is_binary=bool(c.get("is_binary", False)),
        )
        if project_root and path and action in ("modify", "delete"):
            fp = project_root / path
            if fp.is_file() and not ch.before_text:
                ch.before_text = fp.read_text(encoding="utf-8", errors="replace")
        if ch.before_text and not ch.before_sha256:
            ch.before_sha256 = compute_sha256(ch.before_text)
        if ch.after_text and not ch.after_sha256:
            ch.after_sha256 = compute_sha256(ch.after_text)
        populate_diff_for_change(ch)
        changes.append(ch)
    return changes


def propose_patch(
    *,
    session_id: str,
    task_id: str = "",
    run_id: str = "",
    project_id: str = "",
    title: str,
    summary: str = "",
    rationale: str = "",
    changes: list[dict],
    created_by: str = "agent",
    link_approval: bool = True,
) -> dict[str, Any]:
    """Create a proposed patch; optionally auto-apply low-risk paths."""
    project = _resolve_project_root(project_id, run_id)
    root = Path(project["root_path"]).resolve() if project else None

    change_objs = build_changes_from_dicts(changes, root)
    risk = classify_risk(change_objs)
    if risk.denied:
        raise ValueError(f"patch denied: {'; '.join(risk.reasons)}")

    proposal = PatchProposal.new(
        session_id=session_id,
        task_id=task_id,
        run_id=run_id,
        project_id=project_id or (project["id"] if project else ""),
        title=title,
        summary=summary or rationale[:200],
        rationale=rationale,
        risk_level=risk.overall,
        changes=change_objs,
        created_by=created_by,
    )
    proposal.state = PatchState.PROPOSED.value

    if link_approval and session_id:
        from edagent_vivado.repository.store import approval_create

        first = change_objs[0] if change_objs else None
        approval = approval_create(
            "patch",
            {
                "title": title,
                "description": rationale,
                "file_path": first.path if first else "",
                "diff": "\n\n".join(c.diff_text for c in change_objs)[:8000],
                "old_text": (first.before_text[:4000] if first else ""),
                "new_text": (first.after_text[:4000] if first else ""),
                "changes": [c.to_dict() for c in change_objs],
                "risk_level": risk.overall,
                "requires_strong_approval": risk.requires_strong_approval,
            },
            session_id=session_id,
            task_id=task_id,
            run_id=run_id,
            connector_id="vivado",
            risk_level=risk.overall,
        )
        proposal.approval_id = approval["id"]

    row = _persist_proposal(proposal, risk)
    patch_audit_log(proposal.id, "propose", actor_id=session_id, reason=rationale, metadata={"risk": risk.to_dict()})

    _emit_patch_event(session_id, "patch.proposed", {
        "patch_id": proposal.id,
        "approval_id": proposal.approval_id,
        "risk_level": risk.overall,
        "auto_apply": risk.auto_apply,
        "title": title,
        "changes": [c.to_dict() for c in change_objs],
    }, task_id=task_id, run_id=run_id)

    result = {"patch": patch_proposal_get_row(proposal.id), "risk_assessment": risk.to_dict()}

    if risk.auto_apply and not risk.requires_strong_approval and project:
        apply_result = approve_and_apply(
            proposal.id,
            reviewer_id="system",
            reason="auto-apply low-risk",
            skip_approval_transition=True,
        )
        result["apply_result"] = apply_result.get("apply_result")
        result["spawned_run_id"] = apply_result.get("spawned_run_id", "")
        result["patch"] = apply_result.get("patch") or patch_proposal_get_row(proposal.id)

    return result


def approve_and_apply(
    patch_id: str,
    *,
    reviewer_id: str = "",
    reason: str = "",
    skip_approval_transition: bool = False,
) -> dict[str, Any]:
    from edagent_vivado.repository.store import patch_proposal_get, patch_proposal_update

    row = patch_proposal_get(patch_id)
    if not row:
        raise ValueError("patch not found")
    proposal = proposal_from_row(row)
    risk = {}
    try:
        risk = json.loads(row.get("metadata_json") or "{}").get("risk_assessment", {})
    except json.JSONDecodeError:
        pass

    if risk.get("requires_strong_approval") and not reason.strip() and reviewer_id != "system":
        raise ValueError("strong approval requires a non-empty reason")

    if not skip_approval_transition:
        assert_patch_transition(proposal.state, PatchState.APPROVED.value)
    proposal.state = PatchState.APPROVED.value
    proposal.reviewer_id = reviewer_id
    proposal.review_reason = reason
    proposal.updated_at = _now_ms()

    patch_proposal_update(
        patch_id,
        status="approved",
        metadata_json=json.dumps({V7_META_KEY: proposal.to_dict(), "risk_assessment": risk}, ensure_ascii=False),
    )
    patch_audit_log(patch_id, "approve", actor_id=reviewer_id, reason=reason)

    project = _resolve_project_root(proposal.project_id, proposal.run_id)
    if not project:
        raise ValueError("no project root resolvable")

    apply_res = apply_proposal(proposal, project["root_path"])
    if not apply_res.success:
        patch_proposal_update(patch_id, status="rejected")
        patch_audit_log(patch_id, "reject", actor_id="system", reason=f"apply failed: {apply_res.error}")
        raise PatchApplyError(apply_res.error)

    now = int(time.time())
    proposal.state = PatchState.APPLIED.value
    proposal.applied_at = now * 1000
    patch_proposal_update(
        patch_id,
        status="applied",
        applied_at=now,
        metadata_json=json.dumps({V7_META_KEY: proposal.to_dict(), "risk_assessment": risk}, ensure_ascii=False),
    )
    patch_audit_log(patch_id, "apply", actor_id=reviewer_id, metadata={"applied_paths": apply_res.applied_paths})

    if proposal.approval_id:
        from edagent_vivado.repository.store import approval_update

        approval_update(proposal.approval_id, status="approved", decided_at=now, decided_by=reviewer_id)

    _emit_patch_event(
        proposal.session_id,
        "patch.proposal.applied",
        {"patch_id": patch_id, "applied_paths": apply_res.applied_paths},
        task_id=proposal.task_id,
        run_id=proposal.run_id,
    )

    spawned = maybe_spawn_rerun(proposal_from_row(patch_proposal_get(patch_id) or row), project)

    return {
        "patch": patch_proposal_get_row(patch_id),
        "apply_result": {"success": True, "applied_paths": apply_res.applied_paths},
        "spawned_run_id": spawned,
    }


def reject_patch(patch_id: str, *, reviewer_id: str = "", reason: str = "") -> dict:
    from edagent_vivado.repository.store import patch_proposal_get, patch_proposal_update

    row = patch_proposal_get(patch_id)
    if not row:
        raise ValueError("patch not found")
    proposal = proposal_from_row(row)
    assert_patch_transition(proposal.state, PatchState.REJECTED.value)
    proposal.state = PatchState.REJECTED.value
    patch_proposal_update(
        patch_id,
        status="rejected",
        metadata_json=json.dumps({V7_META_KEY: proposal.to_dict()}, ensure_ascii=False),
    )
    patch_audit_log(patch_id, "reject", actor_id=reviewer_id, reason=reason)
    if proposal.approval_id:
        from edagent_vivado.repository.store import approval_update

        approval_update(proposal.approval_id, status="rejected", decided_at=int(time.time()), decided_by=reviewer_id)
    _emit_patch_event(
        proposal.session_id,
        "patch.proposal.rejected",
        {"patch_id": patch_id, "reason": reason},
        task_id=proposal.task_id,
        run_id=proposal.run_id,
    )
    return {"patch": patch_proposal_get_row(patch_id)}


def revert_patch(patch_id: str) -> dict:
    from edagent_vivado.repository.store import patch_proposal_get, patch_proposal_update

    row = patch_proposal_get(patch_id)
    if not row:
        raise ValueError("patch not found")
    proposal = proposal_from_row(row)
    if proposal.state != PatchState.APPLIED.value:
        raise ValueError(f"cannot revert from state {proposal.state}")

    project = _resolve_project_root(proposal.project_id, proposal.run_id)
    if not project:
        raise ValueError("no project root")

    result = revert_proposal(proposal, project["root_path"])
    if not result.success:
        raise ValueError(result.error)

    proposal.state = PatchState.REVERTED.value
    patch_proposal_update(
        patch_id,
        status="reverted",
        metadata_json=json.dumps({V7_META_KEY: proposal.to_dict()}, ensure_ascii=False),
    )
    patch_audit_log(patch_id, "revert", metadata={"restored": result.restored_paths})
    return {"patch": patch_proposal_get_row(patch_id), "restored": result.restored_paths}


def maybe_spawn_rerun(patch_row: dict, project: dict) -> str:
    """After RTL/XDC apply, spawn a background orchestrator rerun."""
    proposal = proposal_from_row(patch_row) if isinstance(patch_row, dict) else patch_row
    if not proposal.run_id:
        return ""
    if not any(c.file_category in ("rtl", "xdc") for c in proposal.changes):
        return ""

    from edagent_vivado.repository.store import patch_proposal_update, run_get
    from edagent_vivado.runs.orchestrator import create_run, start_run_serial

    src_run = run_get(proposal.run_id)
    if not src_run:
        return ""
    try:
        meta = json.loads(src_run.get("metadata_json") or "{}")
    except json.JSONDecodeError:
        meta = {}
    flow_name = str(meta.get("flow_name") or src_run.get("run_type") or "vivado_synth_only")
    inputs = dict(meta.get("inputs") or {})

    new_run_id = create_run(
        flow_name=flow_name,
        session_id=proposal.session_id,
        task_id=proposal.task_id,
        inputs=inputs,
    )
    proposal.spawned_run_id = new_run_id
    patch_proposal_update(
        proposal.id,
        metadata_json=json.dumps({V7_META_KEY: proposal.to_dict()}, ensure_ascii=False),
    )

    def _bg() -> None:
        try:
            start_run_serial(
                new_run_id,
                flow_name=flow_name,
                inputs=inputs,
                session_id=proposal.session_id,
                task_id=proposal.task_id,
                background=False,
            )
        except Exception:
            logger.exception("spawned rerun failed for %s", new_run_id)

    threading.Thread(target=_bg, daemon=True, name=f"patch-rerun-{new_run_id[:8]}").start()
    return new_run_id


def _emit_patch_event(session_id: str, event_type: str, payload: dict, **kwargs: Any) -> None:
    if not session_id:
        return
    try:
        from edagent_vivado.web.api_shared import event_create

        event_create(session_id, event_type, payload, **kwargs)
    except Exception:
        logger.exception("patch event %s failed", event_type)
