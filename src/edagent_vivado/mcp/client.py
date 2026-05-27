"""HTTP client for Synthia API — Phase 9."""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class SynthiaError(Exception):
    def __init__(self, status: int, detail: str, *, needs_approval: bool = False):
        self.status = status
        self.detail = detail
        self.needs_approval = needs_approval
        super().__init__(f"Synthia {status}: {detail}")


class SynthiaClient:
    def __init__(self, base_url: str, token: str, *, timeout: float = 60.0):
        self._base = base_url.rstrip("/")
        self._token = token
        self._client = httpx.Client(
            timeout=timeout,
            headers={
                "Authorization": f"Bearer {token}",
                "User-Agent": "synthia-mcp/0.1",
            },
        )

    def close(self) -> None:
        self._client.close()

    def _get(self, path: str, params: dict | None = None) -> Any:
        return self._handle(self._client.get(self._base + path, params=params or {}))

    def _post(self, path: str, json_body: dict | None = None) -> Any:
        return self._handle(self._client.post(self._base + path, json=json_body or {}))

    def _handle(self, r: httpx.Response) -> Any:
        if r.status_code == 403:
            try:
                d = r.json()
            except Exception:
                d = {"detail": r.text}
            detail = d.get("detail") or d.get("error") or "forbidden"
            if isinstance(detail, list):
                detail = str(detail)
            raise SynthiaError(403, str(detail), needs_approval=True)
        if r.status_code >= 400:
            try:
                d = r.json()
            except Exception:
                d = {"detail": r.text}
            detail = d.get("detail") or d.get("error") or r.text
            if isinstance(detail, list):
                detail = str(detail)
            raise SynthiaError(r.status_code, str(detail))
        if r.headers.get("content-type", "").startswith("application/json"):
            return r.json()
        return {"raw": r.text}

    def _project_row(self, project_id: str) -> dict:
        data = self.get_project(project_id)
        return data.get("project", data) if isinstance(data, dict) else {}

    # ── projects ──────────────────────────────────────

    def list_projects(self) -> list[dict]:
        d = self._get("/api/v1/projects")
        return d.get("projects", d if isinstance(d, list) else [])

    def get_project(self, project_id: str) -> dict:
        return self._get(f"/api/v1/projects/{project_id}")

    def import_xpr(self, xpr_path: str, *, project_name: str = "", auto_register: bool = True) -> dict:
        body: dict[str, Any] = {"xpr_path": xpr_path, "auto_register": auto_register}
        if project_name:
            body["project_name"] = project_name
        return self._post("/api/v1/projects/import-xpr", body)

    def scan_project(self, project_id: str) -> dict:
        project = self._project_row(project_id)
        root = project.get("root_path") or ""
        if not root:
            raise SynthiaError(400, f"project {project_id} has no root_path")
        return self._post("/api/v1/projects/scan", {"root_path": root})

    def ensure_session(self, project_id: str, *, name: str = "MCP") -> str:
        data = self._get(f"/api/v1/projects/{project_id}/sessions")
        sessions = data.get("sessions", [])
        if sessions:
            return str(sessions[0]["id"])
        created = self._post(f"/api/v1/projects/{project_id}/sessions", {"name": name})
        return str(created.get("session", created).get("id", ""))

    # ── runs ──────────────────────────────────────────

    def create_run(
        self,
        project_id: str,
        flow_name: str,
        *,
        inputs: dict | None = None,
        session_id: str = "",
    ) -> dict:
        project = self._project_row(project_id)
        manifest = project.get("manifest_path") or ""
        if not manifest:
            raise SynthiaError(400, f"project {project_id} missing manifest_path")

        stages = ["synth", "impl"]
        if flow_name == "vivado_synth_only":
            stages = ["synth"]
        elif flow_name == "vivado_synth_impl":
            stages = ["synth", "impl"]
        elif flow_name == "vivado_full_flow":
            stages = ["synth", "impl", "bitstream"]

        inp = inputs or {}
        sid = session_id or self.ensure_session(project_id)
        body = {
            "manifest_path": manifest,
            "session_id": sid,
            "stages": stages,
            "strategy": inp.get("strategy", ""),
        }
        result = self._post("/api/v1/vivado/commands/flow", body)
        if isinstance(result, dict) and "run_id" in result:
            result.setdefault("session_id", sid)
        return result

    def get_run(self, run_id: str) -> dict:
        data = self._get(f"/api/v1/monitor/runs/{run_id}")
        run = data.get("run", data) if isinstance(data, dict) else {}
        try:
            steps = self.get_run_steps(run_id)
            if isinstance(run, dict):
                run["steps"] = steps
        except SynthiaError:
            pass
        return run

    def get_run_steps(self, run_id: str) -> list[dict]:
        d = self._get(f"/api/v1/runs/{run_id}/steps")
        return d.get("steps", [])

    def cancel_run(self, run_id: str) -> dict:
        return self._post(f"/api/v1/runs/{run_id}/stop", {})

    # ── reports & artifacts ──────────────────────────

    def get_reports(self, run_id: str, *, report_type: str = "") -> list[dict]:
        params: dict[str, str] = {}
        if report_type:
            params["report_type"] = report_type
        d = self._get(f"/api/v1/runs/{run_id}/reports", params)
        return d.get("reports", [])

    def get_artifacts(self, run_id: str) -> list[dict]:
        d = self._get(f"/api/v1/monitor/runs/{run_id}/artifacts")
        return d.get("artifacts", [])

    def get_summary_markdown(self, run_id: str) -> str:
        r = self._client.get(f"{self._base}/api/v1/runs/{run_id}/summary.md")
        if r.status_code >= 400:
            raise SynthiaError(r.status_code, r.text)
        return r.text

    def get_trend(self, project_id: str, *, limit: int = 10) -> dict:
        return self._get(f"/api/v1/projects/{project_id}/trend", {"limit": str(limit)})

    # ── patches ──────────────────────────────────────

    def propose_patch(
        self,
        *,
        session_id: str,
        title: str,
        rationale: str,
        changes: list[dict],
        task_id: str = "",
        run_id: str = "",
        project_id: str = "",
    ) -> dict:
        sid = session_id
        if not sid and project_id:
            sid = self.ensure_session(project_id)
        return self._post(
            "/api/v1/patches/propose",
            {
                "session_id": sid,
                "task_id": task_id,
                "run_id": run_id,
                "project_id": project_id,
                "title": title,
                "rationale": rationale,
                "changes": changes,
            },
        )

    def get_patch(self, patch_id: str) -> dict:
        return self._get(f"/api/v1/patches/{patch_id}")

    def approve_patch(self, patch_id: str, reason: str = "") -> dict:
        return self._post(
            f"/api/v1/patches/{patch_id}/approve",
            {"reason": reason, "reviewer_id": "mcp"},
        )

    def reject_patch(self, patch_id: str, reason: str = "") -> dict:
        return self._post(
            f"/api/v1/patches/{patch_id}/reject",
            {"reason": reason, "reviewer_id": "mcp"},
        )

    # ── diagnose ──────────────────────────────────────

    def diagnose_log(
        self,
        *,
        log_text: str = "",
        log_path: str = "",
        run_id: str = "",
    ) -> dict:
        return self._post(
            "/api/v1/diagnose/log",
            {"log_text": log_text, "log_path": log_path, "run_id": run_id},
        )
