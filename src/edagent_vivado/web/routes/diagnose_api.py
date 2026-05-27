"""Log diagnosis API — Phase 9 (MCP + external agents)."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from edagent_vivado.web.dependencies import require_perm

router = APIRouter(tags=["diagnose"])


class DiagnoseLogReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    log_text: str = ""
    log_path: str = ""
    run_id: str = ""


@router.post("/diagnose/log", dependencies=[Depends(require_perm("project.read", project_id_param=""))])
async def api_diagnose_log(req: DiagnoseLogReq):
    from edagent_vivado.kb.error_case_loader import load_cases, match_cases
    from edagent_vivado.parsers.vivado_log_parser import parse_vivado_log
    from edagent_vivado.repository.store import run_get

    text = req.log_text.strip()
    if req.run_id and not text:
        run = run_get(req.run_id)
        if not run:
            raise HTTPException(404, "run not found")
        meta = {}
        try:
            import json

            meta = json.loads(run.get("metadata_json") or "{}")
        except json.JSONDecodeError:
            meta = {}
        log_path = str(meta.get("log_path") or meta.get("vivado_log") or "")
        if log_path:
            text = Path(log_path).read_text(encoding="utf-8", errors="replace")
    if req.log_path and not text:
        p = Path(req.log_path)
        if not p.is_file():
            raise HTTPException(404, f"log file not found: {req.log_path}")
        text = p.read_text(encoding="utf-8", errors="replace")
    if not text:
        raise HTTPException(400, "provide log_text, log_path, or run_id")

    summary = parse_vivado_log(text)
    cases = load_cases()
    matches = match_cases(summary.top_error_signatures, cases)
    return {
        "error_count": summary.error_count,
        "critical_warning_count": summary.critical_warning_count,
        "warning_count": summary.warning_count,
        "top_error_signatures": summary.top_error_signatures[:10],
        "matches": [
            {
                "category": case.category,
                "signature": sig,
                "likely_causes": case.likely_causes,
                "suggested_actions": case.suggested_actions,
            }
            for case, sig in matches[:5]
        ],
        "summary": (
            f"{matches[0][0].category}: {matches[0][1]}"
            if matches
            else "No KB match; review top error signatures manually."
        ),
    }
