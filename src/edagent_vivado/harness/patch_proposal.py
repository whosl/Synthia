"""PatchProposal + Approval queue integration (Phase 6D)."""

from __future__ import annotations

from typing import Any, Callable

from edagent_vivado.harness.run_context import get_agent_run_context, get_agent_task_id
from edagent_vivado.repository.store import approval_create, patch_proposal_create, patch_proposal_update

EventSink = Callable[..., Any] | None


def record_patch_proposal(
    *,
    file_path: str,
    diff_text: str,
    description: str = "",
    patch_type: str = "rtl_patch",
    risk_level: str = "medium",
    old_text: str = "",
    new_text: str = "",
    event_sink: EventSink = None,
) -> dict | None:
    ctx = get_agent_run_context()
    run_id = ctx.get("run_id", "")
    session_id = ctx.get("session_id", "")
    task_id = ctx.get("task_id", "") or (get_agent_task_id() or "")
    if not run_id and not session_id:
        return None

    if session_id and old_text is not None and new_text is not None:
        try:
            from edagent_vivado.patches.service import propose_patch

            result = propose_patch(
                session_id=session_id,
                task_id=task_id,
                run_id=run_id,
                title=description or f"patch {file_path}",
                rationale=description,
                changes=[
                    {
                        "path": file_path,
                        "action": "modify",
                        "before_text": old_text,
                        "after_text": new_text,
                    }
                ],
            )
            if event_sink:
                patch = result.get("patch") or {}
                event_sink(
                    session_id,
                    "patch.proposed",
                    {
                        "patch_id": patch.get("id"),
                        "approval_id": patch.get("approval_id"),
                        "target_file": file_path,
                        "run_id": run_id,
                    },
                    task_id=task_id or None,
                    run_id=run_id,
                )
            return result
        except Exception:
            pass

    approval = approval_create(
        "patch",
        {
            "file_path": file_path,
            "description": description,
            "diff": diff_text[:8000],
            "old_text": old_text[:4000],
            "new_text": new_text[:4000],
        },
        session_id=session_id,
        task_id=task_id,
        run_id=run_id,
        connector_id="vivado",
        risk_level=risk_level,
    )
    patch = patch_proposal_create(
        "vivado",
        file_path,
        patch_type,
        run_id=run_id,
        session_id=session_id,
        task_id=task_id,
        risk_level=risk_level,
        reason=description,
        diff_text=diff_text[:16000],
        approval_id=approval["id"],
    )
    patch_proposal_update(patch["id"], approval_id=approval["id"])

    if event_sink and session_id:
        event_sink(
            session_id,
            "patch.proposal.created",
            {
                "patch_id": patch["id"],
                "approval_id": approval["id"],
                "target_file": file_path,
                "run_id": run_id,
            },
            task_id=task_id or None,
            run_id=run_id,
        )
    return {"patch": patch, "approval": approval}
