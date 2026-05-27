# Synthia Phase 9 开发手册：MCP Server 初版

> **前置条件：** Phase 0-8 + 5.5 完成  
> **目标：** 让 Cursor / Claude Code / opencode / WorkBuddy 等外部 Agent 通过 MCP 协议调用 Synthia 的能力（list projects / import xpr / run synth / get reports / propose-approve patch）  
> **预估工期：** 全职 8 天；vibe coding 2-3 周  
> **关键约束：** MCP server 不直接执行 Vivado，所有动作走 Synthia HTTP API；权限走 Phase 8 service account

---

## 0. 设计原则

1. **MCP server 是 thin client**：所有 tool 实现 = 一次或多次 Synthia HTTP API 调用
2. **认证一次绑定**：MCP server 启动时绑定到一个 service account token；后续 tool 调用都用这个身份
3. **危险操作 needs_approval**：MCP 调用触发 high-risk patch / strong approval / `.bit` 下载时，返回 `{"needs_approval": True, "approval_url": ...}`，让外部 agent 把人拉回来
4. **可独立部署**：MCP server 可以跑在与 Synthia 不同的机器上（通过 base_url 配置）
5. **协议选 stdio 优先 + HTTP/SSE 可选**：Cursor/Claude Code 默认 stdio；服务化场景用 streamable HTTP

---

## 1. 任务清单

| 步骤 | 文件 | 类型 |
|------|------|------|
| 1 | `pyproject.toml` | 加 `mcp` extra + script `synthia-mcp` |
| 2 | `mcp/client.py` | 新建：Synthia HTTP client wrapper |
| 3 | `mcp/server.py` | 新建：MCP server entry (stdio + http) |
| 4 | `mcp/tools/projects.py` | 新建 |
| 5 | `mcp/tools/runs.py` | 新建 |
| 6 | `mcp/tools/reports.py` | 新建 |
| 7 | `mcp/tools/patches.py` | 新建 |
| 8 | `mcp/tools/diagnose.py` | 新建 |
| 9 | `mcp/config.py` | 新建：配置加载 |
| 10 | `apps/mcp/` | 新建：standalone runner 入口 |
| 11 | docs/MCP_USAGE.md | 文档 |
| 12 | 测试 | — |

---

## 2. 步骤 1：依赖与脚本

### 2.1 pyproject.toml

打开 `pyproject.toml`：

```toml
[project.optional-dependencies]
mcp = [
    "mcp>=1.2.0",          # FastMCP / streamable HTTP
    "httpx>=0.27.0",
    "anyio>=4.0",
]

[project.scripts]
edagent = "edagent_vivado.cli:app"
synthia = "edagent_vivado.cli:app"
synthia-mcp = "edagent_vivado.mcp.server:run_main"
```

```bash
pip install -e ".[mcp]"
```

### 2.2 目录

```bash
mkdir -p src/edagent_vivado/mcp/tools
touch src/edagent_vivado/mcp/__init__.py
touch src/edagent_vivado/mcp/tools/__init__.py
```

---

## 3. 步骤 2：Synthia HTTP Client

### 3.1 设计

封装一个 thin client，所有 MCP tools 共用：

```python
class SynthiaClient:
    def __init__(self, base_url: str, token: str, *, timeout: float = 60.0):
        self._http = httpx.Client(...)
        self._token = token
        self._base = base_url.rstrip("/")
    
    def list_projects(self) -> list[dict]: ...
    def get_project(self, pid: str) -> dict: ...
    def import_xpr(self, xpr_path: str, ...) -> dict: ...
    def create_run(self, pid: str, flow: str, inputs: dict) -> dict: ...
    def get_run(self, run_id: str) -> dict: ...
    def get_run_steps(self, run_id: str) -> list[dict]: ...
    def get_reports(self, run_id: str, *, type: str = "") -> list[dict]: ...
    def get_artifacts(self, run_id: str) -> list[dict]: ...
    def propose_patch(self, ...) -> dict: ...
    def approve_patch(self, patch_id: str, reason: str) -> dict: ...
    def reject_patch(self, patch_id: str, reason: str) -> dict: ...
    def diagnose_log(self, log_text: str | None = None, run_id: str | None = None) -> dict: ...
```

### 3.2 实现

**新建** `src/edagent_vivado/mcp/client.py`：

```python
"""HTTP client for Synthia API — Phase 9.

This file is the SOLE place that talks HTTP. All MCP tools use this client.
"""

from __future__ import annotations

import json
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
            headers={"Authorization": f"Bearer {token}",
                     "User-Agent": "synthia-mcp/0.1"},
        )
    
    def close(self) -> None:
        self._client.close()
    
    # ── core HTTP wrappers ──────────────────────────────────
    
    def _get(self, path: str, params: dict | None = None) -> Any:
        r = self._client.get(self._base + path, params=params or {})
        return self._handle(r)
    
    def _post(self, path: str, json_body: dict | None = None) -> Any:
        r = self._client.post(self._base + path, json=json_body or {})
        return self._handle(r)
    
    def _delete(self, path: str) -> Any:
        r = self._client.delete(self._base + path)
        return self._handle(r)
    
    def _handle(self, r: httpx.Response) -> Any:
        if r.status_code == 403:
            try:
                d = r.json()
            except Exception:
                d = {"error": r.text}
            raise SynthiaError(403, d.get("error") or d.get("detail") or "forbidden",
                                needs_approval=True)
        if r.status_code >= 400:
            try:
                d = r.json()
            except Exception:
                d = {"error": r.text}
            raise SynthiaError(r.status_code, d.get("error") or d.get("detail") or r.text)
        if r.headers.get("Content-Type", "").startswith("application/json"):
            return r.json()
        return {"raw": r.text}
    
    # ── projects ──────────────────────────────────────
    
    def list_projects(self) -> list[dict]:
        d = self._get("/api/v1/projects")
        return d.get("projects", d if isinstance(d, list) else [])
    
    def get_project(self, project_id: str) -> dict:
        return self._get(f"/api/v1/projects/{project_id}")
    
    def import_xpr(self, xpr_path: str, *, project_name: str = "") -> dict:
        body = {"xpr_path": xpr_path}
        if project_name:
            body["project_name"] = project_name
        return self._post("/api/v1/projects/import-xpr", body)
    
    def scan_project(self, project_id: str) -> dict:
        return self._post(f"/api/v1/projects/{project_id}/scan", {})
    
    # ── runs ──────────────────────────────────────────
    
    def create_run(
        self, project_id: str, flow_name: str, *,
        inputs: dict | None = None, session_id: str = "",
        auto_start: bool = True,
    ) -> dict:
        return self._post(
            f"/api/v1/projects/{project_id}/runs",
            {"flow_name": flow_name, "inputs": inputs or {},
             "session_id": session_id, "auto_start": auto_start},
        )
    
    def get_run(self, run_id: str) -> dict:
        return self._get(f"/api/v1/runs/{run_id}")
    
    def get_run_steps(self, run_id: str) -> list[dict]:
        d = self._get(f"/api/v1/runs/{run_id}/steps")
        return d.get("steps", [])
    
    def cancel_run(self, run_id: str) -> dict:
        return self._post(f"/api/v1/runs/{run_id}/cancel", {})
    
    # ── reports & artifacts ──────────────────────────
    
    def get_reports(self, run_id: str, *, report_type: str = "") -> list[dict]:
        params = {"run_id": run_id}
        if report_type:
            params["report_type"] = report_type
        d = self._get("/api/v1/reports", params)
        return d.get("reports", [])
    
    def get_artifacts(self, run_id: str) -> list[dict]:
        d = self._get(f"/api/v1/runs/{run_id}/artifacts")
        return d.get("artifacts", [])
    
    def get_summary_markdown(self, run_id: str) -> str:
        r = self._client.get(f"{self._base}/api/v1/runs/{run_id}/summary.md")
        if r.status_code >= 400:
            raise SynthiaError(r.status_code, r.text)
        return r.text
    
    def get_trend(self, project_id: str) -> dict:
        return self._get(f"/api/v1/projects/{project_id}/trend")
    
    # ── patches ──────────────────────────────────────
    
    def propose_patch(
        self, *, session_id: str, title: str, rationale: str,
        changes: list[dict], task_id: str = "", run_id: str = "",
        project_id: str = "",
    ) -> dict:
        return self._post("/api/v1/patches/propose", {
            "session_id": session_id, "task_id": task_id,
            "run_id": run_id, "project_id": project_id,
            "title": title, "rationale": rationale, "changes": changes,
        })
    
    def get_patch(self, patch_id: str) -> dict:
        return self._get(f"/api/v1/patches/{patch_id}")
    
    def approve_patch(self, patch_id: str, reason: str = "") -> dict:
        return self._post(f"/api/v1/patches/{patch_id}/approve",
                          {"reason": reason, "reviewer_id": "mcp"})
    
    def reject_patch(self, patch_id: str, reason: str = "") -> dict:
        return self._post(f"/api/v1/patches/{patch_id}/reject",
                          {"reason": reason, "reviewer_id": "mcp"})
    
    # ── diagnose ──────────────────────────────────────
    
    def diagnose_log(self, *, log_text: str = "", log_path: str = "",
                     run_id: str = "") -> dict:
        return self._post("/api/v1/diagnose/log", {
            "log_text": log_text, "log_path": log_path, "run_id": run_id,
        })
```

---

## 4. 步骤 3：MCP Server Entry

### 4.1 config

**新建** `src/edagent_vivado/mcp/config.py`：

```python
"""MCP server config — Phase 9."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class McpConfig:
    base_url: str
    token: str
    transport: str          # 'stdio' or 'http'
    http_host: str = "127.0.0.1"
    http_port: int = 8485
    timeout: float = 90.0
    server_name: str = "synthia"
    
    @classmethod
    def from_env(cls) -> "McpConfig":
        base = os.environ.get("SYNTHIA_BASE_URL", "http://127.0.0.1:8484")
        token = os.environ.get("SYNTHIA_MCP_TOKEN") or os.environ.get("SYNTHIA_API_TOKEN") or ""
        if not token:
            raise RuntimeError(
                "SYNTHIA_MCP_TOKEN not set. Run 'edagent admin create-user --service-account synthia-mcp' "
                "and export the returned token."
            )
        transport = os.environ.get("SYNTHIA_MCP_TRANSPORT", "stdio").lower()
        return cls(
            base_url=base,
            token=token,
            transport=transport,
            http_host=os.environ.get("SYNTHIA_MCP_HOST", "127.0.0.1"),
            http_port=int(os.environ.get("SYNTHIA_MCP_PORT", "8485")),
            timeout=float(os.environ.get("SYNTHIA_MCP_TIMEOUT", "90.0")),
        )
```

### 4.2 server

**新建** `src/edagent_vivado/mcp/server.py`：

```python
"""Synthia MCP Server — Phase 9.

Exposes Synthia capabilities as MCP tools. Talks Synthia HTTP API.
"""

from __future__ import annotations

import logging
import sys

from mcp.server.fastmcp import FastMCP

from edagent_vivado.mcp.client import SynthiaClient, SynthiaError
from edagent_vivado.mcp.config import McpConfig

logger = logging.getLogger("synthia.mcp")


def build_server(config: McpConfig) -> FastMCP:
    mcp = FastMCP(config.server_name)
    client = SynthiaClient(config.base_url, config.token, timeout=config.timeout)
    
    # Register tools (each in its own module for clarity)
    from edagent_vivado.mcp.tools import projects, runs, reports, patches, diagnose
    projects.register(mcp, client)
    runs.register(mcp, client)
    reports.register(mcp, client)
    patches.register(mcp, client)
    diagnose.register(mcp, client)
    
    return mcp


def run_main() -> None:
    """Entry point: `synthia-mcp`."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,  # MUST be stderr — stdout is reserved for MCP frames
    )
    
    try:
        config = McpConfig.from_env()
    except Exception as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        sys.exit(1)
    
    logger.info("synthia-mcp starting (base_url=%s, transport=%s)",
                config.base_url, config.transport)
    
    mcp = build_server(config)
    
    if config.transport == "http":
        # Streamable HTTP
        import uvicorn
        app = mcp.streamable_http_app()
        uvicorn.run(app, host=config.http_host, port=config.http_port,
                    log_config=None)
    else:
        mcp.run(transport="stdio")
```

---

## 5. 步骤 4-8：MCP Tools

### 5.1 projects.py

**新建** `src/edagent_vivado/mcp/tools/projects.py`：

```python
"""MCP tools: projects."""

from __future__ import annotations

from typing import Any

from edagent_vivado.mcp.client import SynthiaClient, SynthiaError


def register(mcp, client: SynthiaClient) -> None:
    
    @mcp.tool()
    async def synthia_list_projects() -> list[dict[str, Any]]:
        """List all Synthia projects accessible to the service account.
        
        Returns a list of {id, name, root_path, manifest_path, imported_from_xpr, ...}.
        """
        return client.list_projects()
    
    
    @mcp.tool()
    async def synthia_get_project(project_id: str) -> dict[str, Any]:
        """Get detailed info for a Synthia project.
        
        Args:
            project_id: Project UUID returned by synthia_list_projects.
        """
        return client.get_project(project_id)
    
    
    @mcp.tool()
    async def synthia_import_xpr(
        xpr_path: str,
        project_name: str = "",
    ) -> dict[str, Any]:
        """Import a Vivado .xpr project into Synthia.
        
        Args:
            xpr_path: Absolute path to the .xpr file (must be readable by Synthia server).
            project_name: Optional override; default is filename stem.
        
        Returns project info including project_id.
        """
        try:
            return client.import_xpr(xpr_path, project_name=project_name)
        except SynthiaError as e:
            if e.needs_approval:
                return {"needs_approval": True, "error": str(e)}
            raise
    
    
    @mcp.tool()
    async def synthia_scan_project(project_id: str) -> dict[str, Any]:
        """Re-scan a project directory; detect new RTL/XDC files and update manifest.
        
        Useful when files have changed on disk since import.
        """
        return client.scan_project(project_id)
```

### 5.2 runs.py

**新建** `src/edagent_vivado/mcp/tools/runs.py`：

```python
"""MCP tools: runs."""

from __future__ import annotations

from typing import Any

from edagent_vivado.mcp.client import SynthiaClient, SynthiaError


def register(mcp, client: SynthiaClient) -> None:
    
    @mcp.tool()
    async def synthia_run_synthesis(
        project_id: str,
        strategy: str = "",
        wait_seconds: int = 0,
    ) -> dict[str, Any]:
        """Start a synthesis run for a project.
        
        Args:
            project_id: Project UUID.
            strategy: Optional Vivado synth strategy (e.g. 'Flow_PerfOptimized_high').
            wait_seconds: If > 0, wait up to this long for the run to complete and return final state.
                          If 0, return immediately with run_id (poll later via synthia_get_run).
        """
        inputs: dict[str, Any] = {}
        if strategy:
            inputs["strategy"] = strategy
        try:
            res = client.create_run(project_id, "vivado_synth_only", inputs=inputs)
        except SynthiaError as e:
            if e.needs_approval:
                return {"needs_approval": True, "error": str(e),
                        "hint": "user must approve in Synthia UI"}
            raise
        if wait_seconds > 0:
            return _poll_until_done(client, res["run_id"], wait_seconds)
        return res
    
    
    @mcp.tool()
    async def synthia_run_implementation(
        project_id: str,
        strategy: str = "",
        wait_seconds: int = 0,
    ) -> dict[str, Any]:
        """Start synth + implementation."""
        inputs = {"strategy": strategy} if strategy else {}
        res = client.create_run(project_id, "vivado_synth_impl", inputs=inputs)
        if wait_seconds > 0:
            return _poll_until_done(client, res["run_id"], wait_seconds)
        return res
    
    
    @mcp.tool()
    async def synthia_generate_bitstream(
        project_id: str,
        wait_seconds: int = 0,
    ) -> dict[str, Any]:
        """Run full flow (synth + impl + bitstream)."""
        res = client.create_run(project_id, "vivado_full_flow", inputs={})
        if wait_seconds > 0:
            return _poll_until_done(client, res["run_id"], wait_seconds)
        return res
    
    
    @mcp.tool()
    async def synthia_get_run(run_id: str) -> dict[str, Any]:
        """Get current state of a Run including steps.
        
        Returns:
            {state, flow_name, started_at, completed_at, steps: [{name, state, elapsed_ms}]}
        """
        run = client.get_run(run_id)
        steps = client.get_run_steps(run_id)
        run["steps"] = steps
        return run
    
    
    @mcp.tool()
    async def synthia_cancel_run(run_id: str) -> dict[str, Any]:
        """Cancel a running or queued run."""
        return client.cancel_run(run_id)
    
    
    # ── helper ─────────────────────────────────────────
    
    def _poll_until_done(client: SynthiaClient, run_id: str, max_wait_s: int) -> dict[str, Any]:
        import time
        deadline = time.time() + max_wait_s
        while time.time() < deadline:
            run = client.get_run(run_id)
            state = run.get("state", "")
            if state in ("succeeded", "succeeded_with_warnings", "failed",
                          "cancelled", "policy_denied"):
                run["steps"] = client.get_run_steps(run_id)
                return run
            if state == "waiting_for_approval":
                run["steps"] = client.get_run_steps(run_id)
                run["needs_approval"] = True
                return run
            time.sleep(min(3.0, max(1.0, (deadline - time.time()) / 10)))
        # Timeout
        run = client.get_run(run_id)
        run["timeout"] = True
        return run
```

### 5.3 reports.py

```python
"""MCP tools: reports & artifacts."""

from __future__ import annotations

from typing import Any

from edagent_vivado.mcp.client import SynthiaClient


def register(mcp, client: SynthiaClient) -> None:
    
    @mcp.tool()
    async def synthia_get_reports(
        run_id: str,
        report_type: str = "",
    ) -> list[dict[str, Any]]:
        """List parsed reports for a Run.
        
        Args:
            run_id: Run UUID.
            report_type: Optional filter: 'timing' | 'utilization' | 'drc' | 'methodology' | 'bitstream' | 'impl_summary'.
        """
        return client.get_reports(run_id, report_type=report_type)
    
    
    @mcp.tool()
    async def synthia_get_artifacts(run_id: str) -> list[dict[str, Any]]:
        """List artifacts produced by a Run.
        
        Returns:
            [{id, path, kind (rtl/log/dcp/bit/...), size_bytes, sha256}]
        """
        return client.get_artifacts(run_id)
    
    
    @mcp.tool()
    async def synthia_get_run_summary(run_id: str) -> str:
        """Get a Markdown summary of a Run (timing/util/drc rolled up).
        
        Returns the rendered markdown text directly.
        """
        return client.get_summary_markdown(run_id)
    
    
    @mcp.tool()
    async def synthia_get_project_trend(project_id: str) -> dict[str, Any]:
        """Get trend metrics across recent runs of a project.
        
        Returns:
            {runs: [...], metrics: {WNS, TNS, LUT_used, FF_used, ...}}
        """
        return client.get_trend(project_id)
```

### 5.4 patches.py

```python
"""MCP tools: patches (request / approve / reject)."""

from __future__ import annotations

from typing import Any

from edagent_vivado.mcp.client import SynthiaClient, SynthiaError


def register(mcp, client: SynthiaClient) -> None:
    
    @mcp.tool()
    async def synthia_request_patch(
        session_id: str,
        title: str,
        rationale: str,
        changes: list[dict[str, Any]],
        run_id: str = "",
        project_id: str = "",
    ) -> dict[str, Any]:
        """Propose a code patch (XDC/RTL/manifest/Tcl).
        
        Args:
            session_id: Synthia session this proposal is associated with.
            title: One-line summary (shown in UI).
            rationale: Explain WHY this change is needed.
            changes: List of {path, action ('create'/'modify'/'delete'),
                              before_text, after_text, file_category}.
            run_id: Optional; if provided, apply triggers a rerun of this run's flow.
            project_id: Required if not derivable from run_id.
        
        Returns:
            {patch: {id, state, risk_level, ...}, risk_assessment: {...}}
            
        If risk is high/strong-approval, the patch stays in 'proposed' state until a human approves in the Synthia UI.
        """
        try:
            return client.propose_patch(
                session_id=session_id, title=title, rationale=rationale,
                changes=changes, run_id=run_id, project_id=project_id,
            )
        except SynthiaError as e:
            if "denied" in e.detail.lower():
                return {"denied": True, "error": e.detail,
                        "hint": "patch was rejected by risk policy (e.g. delete RTL)"}
            raise
    
    
    @mcp.tool()
    async def synthia_get_patch(patch_id: str) -> dict[str, Any]:
        """Get patch proposal status + full diff."""
        return client.get_patch(patch_id)
    
    
    @mcp.tool()
    async def synthia_approve_patch(
        patch_id: str,
        reason: str = "",
    ) -> dict[str, Any]:
        """Approve a patch proposal (if the calling service-account has approval permission).
        
        Args:
            patch_id: Patch UUID.
            reason: Required if patch requires strong approval.
        
        Returns:
            {patch: {state: applied|rejected}, apply_result: {success, applied_paths}, spawned_run_id}
        
        Raises if the service-account lacks 'patch.approve' permission for high-risk patches.
        """
        try:
            return client.approve_patch(patch_id, reason=reason)
        except SynthiaError as e:
            if e.needs_approval or e.status == 403:
                return {"needs_human": True, "error": e.detail,
                        "hint": "high-risk patch requires a human reviewer in Synthia UI"}
            raise
    
    
    @mcp.tool()
    async def synthia_reject_patch(
        patch_id: str,
        reason: str = "",
    ) -> dict[str, Any]:
        """Reject a patch proposal."""
        return client.reject_patch(patch_id, reason=reason)
```

### 5.5 diagnose.py

```python
"""MCP tools: diagnose."""

from __future__ import annotations

from typing import Any

from edagent_vivado.mcp.client import SynthiaClient


def register(mcp, client: SynthiaClient) -> None:
    
    @mcp.tool()
    async def synthia_diagnose_log(
        log_text: str = "",
        log_path: str = "",
        run_id: str = "",
    ) -> dict[str, Any]:
        """Analyze a Vivado log and return structured diagnosis.
        
        Provide exactly ONE of: log_text (inline), log_path (file on Synthia server), run_id (latest log of run).
        
        Returns:
            {category: 'timing_violation'|'drc_error'|'cdc'|...,
             severity, summary, suggested_actions: [...]}
        """
        if not (log_text or log_path or run_id):
            return {"error": "must provide log_text, log_path, or run_id"}
        return client.diagnose_log(log_text=log_text, log_path=log_path, run_id=run_id)
```

---

## 6. 步骤 10：standalone runner

### 6.1 apps/mcp/

```bash
mkdir -p apps/mcp
```

**新建** `apps/mcp/run.sh`：

```bash
#!/usr/bin/env bash
# Launch Synthia MCP server (stdio mode).
# Usage: ./apps/mcp/run.sh
set -euo pipefail

if [[ -z "${SYNTHIA_MCP_TOKEN:-}" ]] && [[ -z "${SYNTHIA_API_TOKEN:-}" ]]; then
    echo "ERROR: SYNTHIA_MCP_TOKEN env var required" >&2
    exit 1
fi

export SYNTHIA_BASE_URL="${SYNTHIA_BASE_URL:-http://127.0.0.1:8484}"
exec synthia-mcp
```

**新建** `apps/mcp/cursor-config.json`（用户复制到 `~/.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "synthia": {
      "command": "synthia-mcp",
      "env": {
        "SYNTHIA_BASE_URL": "http://127.0.0.1:8484",
        "SYNTHIA_MCP_TOKEN": "REPLACE_WITH_TOKEN_FROM_edagent_admin_create-user"
      }
    }
  }
}
```

**新建** `apps/mcp/claude-code-config.json`：

```json
{
  "mcpServers": {
    "synthia": {
      "command": "synthia-mcp",
      "args": [],
      "env": {
        "SYNTHIA_BASE_URL": "http://127.0.0.1:8484",
        "SYNTHIA_MCP_TOKEN": "REPLACE_WITH_TOKEN"
      }
    }
  }
}
```

### 6.2 HTTP 模式（多用户场景）

```bash
SYNTHIA_MCP_TRANSPORT=http \
SYNTHIA_MCP_HOST=0.0.0.0 \
SYNTHIA_MCP_PORT=8485 \
synthia-mcp
```

---

## 7. 步骤 11：文档

**新建** `docs/MCP_USAGE.md`：

```markdown
# Synthia MCP Server

External agents (Cursor, Claude Code, opencode, custom bots) can drive Synthia via MCP.

## Setup

1. Create a service account on Synthia server:

```bash
edagent admin create-user synthia-mcp --service-account --role fpga_engineer
# copy the printed API token
```

2. Install Synthia with MCP extra (only on the machine that runs the MCP server):

```bash
pip install -e ".[mcp]"
```

3. Export env vars:

```bash
export SYNTHIA_BASE_URL=http://127.0.0.1:8484
export SYNTHIA_MCP_TOKEN=<token from step 1>
```

4. Test:

```bash
synthia-mcp   # blocks on stdio
```

## Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "synthia": {
      "command": "synthia-mcp",
      "env": { "SYNTHIA_BASE_URL": "...", "SYNTHIA_MCP_TOKEN": "..." }
    }
  }
}
```

Restart Cursor; tools appear under "synthia.*" in the agent palette.

## Available tools

- `synthia_list_projects`
- `synthia_get_project(project_id)`
- `synthia_import_xpr(xpr_path)`
- `synthia_scan_project(project_id)`
- `synthia_run_synthesis(project_id, strategy?, wait_seconds?)`
- `synthia_run_implementation(...)`
- `synthia_generate_bitstream(...)`
- `synthia_get_run(run_id)`
- `synthia_cancel_run(run_id)`
- `synthia_get_reports(run_id, report_type?)`
- `synthia_get_artifacts(run_id)`
- `synthia_get_run_summary(run_id)` → returns markdown
- `synthia_get_project_trend(project_id)`
- `synthia_request_patch(session_id, title, rationale, changes, ...)`
- `synthia_get_patch(patch_id)`
- `synthia_approve_patch(patch_id, reason?)`
- `synthia_reject_patch(patch_id, reason?)`
- `synthia_diagnose_log(log_text? | log_path? | run_id?)`

## Permissions

The MCP server inherits the permissions of the service-account user.
- fpga_engineer: can run synth/impl/bit, propose patches, approve low-risk
- reviewer: can approve high-risk patches (NOT recommended for unattended bots)
- viewer: read-only (recommended for analytics-only bots)

High-risk operations return `{needs_approval: true}` instead of executing —
your external agent should pause and ask the user to approve in the Synthia UI.

## Troubleshooting

- "SYNTHIA_MCP_TOKEN not set" → export the token before launching synthia-mcp.
- Tool returns `{denied: true}` → service account lacks required role; ask admin to update.
- All tools time out → Synthia server unreachable at SYNTHIA_BASE_URL.
- "Bearer token rejected" → token revoked or wrong; rotate via `edagent admin rotate-token`.
```

---

## 8. 步骤 12：测试

### 8.1 测试策略

MCP server 是 thin client；重点测：
1. `SynthiaClient` 各方法正确构造 HTTP 请求（用 httpx mock）
2. 错误转换：403 → SynthiaError(needs_approval=True)
3. tool 注册：所有 tool 名出现在 `mcp.list_tools()`

### 8.2 测试

**新建** `tests/test_mcp_client.py`：

```python
import pytest
import httpx
from unittest.mock import patch, MagicMock

from edagent_vivado.mcp.client import SynthiaClient, SynthiaError


def _make_client(responses):
    """Create a SynthiaClient with mocked transport."""
    def handler(request: httpx.Request) -> httpx.Response:
        for matcher, resp in responses:
            if matcher(request):
                return resp
        return httpx.Response(404, json={"error": "no mock matched"})
    
    transport = httpx.MockTransport(handler)
    client = SynthiaClient("http://localhost:8484", "tok", timeout=5)
    client._client = httpx.Client(transport=transport,
                                   headers={"Authorization": "Bearer tok"})
    return client


def test_list_projects():
    c = _make_client([
        (lambda r: r.url.path == "/api/v1/projects" and r.method == "GET",
         httpx.Response(200, json={"projects": [{"id": "p1"}]})),
    ])
    assert c.list_projects() == [{"id": "p1"}]


def test_create_run():
    c = _make_client([
        (lambda r: r.url.path == "/api/v1/projects/p1/runs" and r.method == "POST",
         httpx.Response(200, json={"run_id": "r1", "state": "queued"})),
    ])
    r = c.create_run("p1", "vivado_synth_only", inputs={"strategy": "default"})
    assert r["run_id"] == "r1"


def test_403_translates_to_needs_approval():
    c = _make_client([
        (lambda r: True,
         httpx.Response(403, json={"detail": "needs reviewer"})),
    ])
    with pytest.raises(SynthiaError) as exc_info:
        c.approve_patch("p1")
    assert exc_info.value.needs_approval


def test_500_no_needs_approval():
    c = _make_client([
        (lambda r: True, httpx.Response(500, json={"detail": "internal"})),
    ])
    with pytest.raises(SynthiaError) as exc_info:
        c.list_projects()
    assert not exc_info.value.needs_approval


def test_propose_patch_payload():
    captured = {}
    def handler(r):
        import json
        captured["body"] = json.loads(r.content)
        return httpx.Response(200, json={"patch": {"id": "px"}})
    
    c = _make_client([(lambda r: r.url.path == "/api/v1/patches/propose", httpx.Response(200, json={"patch": {"id": "px"}}))])
    # Simulate by overriding _client manually
    transport = httpx.MockTransport(handler)
    c._client = httpx.Client(transport=transport, headers={"Authorization": "Bearer tok"})
    
    c.propose_patch(
        session_id="s1", title="t", rationale="r",
        changes=[{"path": "x.xdc", "action": "modify",
                  "before_text": "a", "after_text": "b"}],
        project_id="p1",
    )
    assert captured["body"]["title"] == "t"
    assert captured["body"]["changes"][0]["path"] == "x.xdc"
```

### 8.3 测试 tool registry

**新建** `tests/test_mcp_server.py`：

```python
def test_all_tools_registered(monkeypatch):
    monkeypatch.setenv("SYNTHIA_MCP_TOKEN", "fake-token")
    from edagent_vivado.mcp.config import McpConfig
    from edagent_vivado.mcp.server import build_server
    
    cfg = McpConfig.from_env()
    mcp = build_server(cfg)
    
    # FastMCP exposes ._tools or .list_tools()
    tool_names = set()
    if hasattr(mcp, '_tools'):
        tool_names = set(mcp._tools.keys())
    elif hasattr(mcp, 'tools'):
        tool_names = set(t.name for t in mcp.tools)
    
    expected = {
        "synthia_list_projects",
        "synthia_get_project",
        "synthia_import_xpr",
        "synthia_scan_project",
        "synthia_run_synthesis",
        "synthia_run_implementation",
        "synthia_generate_bitstream",
        "synthia_get_run",
        "synthia_cancel_run",
        "synthia_get_reports",
        "synthia_get_artifacts",
        "synthia_get_run_summary",
        "synthia_get_project_trend",
        "synthia_request_patch",
        "synthia_get_patch",
        "synthia_approve_patch",
        "synthia_reject_patch",
        "synthia_diagnose_log",
    }
    missing = expected - tool_names
    assert not missing, f"missing tools: {missing}"


def test_config_requires_token(monkeypatch):
    monkeypatch.delenv("SYNTHIA_MCP_TOKEN", raising=False)
    monkeypatch.delenv("SYNTHIA_API_TOKEN", raising=False)
    from edagent_vivado.mcp.config import McpConfig
    
    import pytest
    with pytest.raises(RuntimeError, match="TOKEN"):
        McpConfig.from_env()
```

### 8.4 手动 smoke

```bash
# Terminal 1: Synthia server
edagent web --port 8484

# Terminal 2: create service account, get token
edagent admin create-user synthia-mcp-test --service-account --role fpga_engineer
# copy the token

# Terminal 3: start MCP server in HTTP mode for easy testing
SYNTHIA_MCP_TOKEN=<the-token> \
SYNTHIA_MCP_TRANSPORT=http \
SYNTHIA_MCP_PORT=8485 \
synthia-mcp

# Terminal 4: poke
curl -s http://127.0.0.1:8485/  # MCP welcome
```

Cursor 集成验证：
1. 把 `apps/mcp/cursor-config.json` 内容（替换 token）复制到 `~/.cursor/mcp.json`
2. Cursor restart
3. 在 Cursor agent 里输入：「Use synthia to list all projects」
4. 期望 agent 调 `synthia_list_projects` 并返回结果

### 8.5 commit

```bash
git add -A
git commit -m "Phase 9: MCP server (initial release)

- pyproject: add 'mcp' extra + synthia-mcp script
- mcp/client.py: SynthiaClient — single HTTP gateway to Synthia API
- mcp/config.py: McpConfig from env
- mcp/server.py: FastMCP entry, stdio + http transports
- mcp/tools/projects.py: list/get/import-xpr/scan
- mcp/tools/runs.py: run_synthesis/impl/bitstream + get/cancel + wait helper
- mcp/tools/reports.py: reports/artifacts/summary.md/trend
- mcp/tools/patches.py: propose/get/approve/reject with needs-approval graceful path
- mcp/tools/diagnose.py: log diagnosis
- apps/mcp/: run.sh + cursor/claude-code MCP configs
- docs/MCP_USAGE.md
- tests/test_mcp_client.py: 5 client cases
- tests/test_mcp_server.py: tool registry + config validation
"
```

---

## 9. 附录

### 9.1 常见坑

**A. stdout 污染 stdio transport**：MCP stdio 协议占用 stdout 帧。任何 `print()`、未配置的 `logging` 写 stdout 都会破坏帧。所以 `run_main` 显式把 logging stream 设为 stderr，并禁掉 uvicorn 默认 config。

**B. 长任务超时**：`synthia_run_synthesis(wait_seconds=600)` 同步等 10 分钟。Cursor agent 端可能 30 秒就 timeout 你的 tool call。建议默认 `wait_seconds=0` 立即返回 run_id，让 agent 后续轮询 `synthia_get_run`。

**C. token 落明文**：`mcp.json` 里 token 是明文。文档建议用 `pass` / `1Password CLI` 等机制注入 env 而非写死。

**D. service account 权限**：很多团队会图省事给 service account `admin` 角色。不要。最小权限：`fpga_engineer`。需要审批的留给人。

**E. project_id 解析**：tool 入参很多是 string；agent 可能传错（如传 project 名而非 UUID）。在 `import_xpr` / `list_projects` 返回里把 id 字段 highlight 出来；考虑在 client 加 fuzzy resolve（按 name 找 id）。

**F. needs_approval 半成品状态**：MCP 调 approve 时如果 service account 没权限，返回 `{needs_human: True}`，但 patch 还停在 `proposed` 状态。外部 agent 应该把 `approval_url` 拿到（v1.0 没返回 URL，v1.1 加）。

**G. 多个 MCP server 实例 + 同一 service account**：可以；每个 SynthiaClient 独立 httpx connection pool。但所有 audit log 的 actor 都是同一 user，难追到底哪个 client。Phase 9.5 加 `X-Synthia-Client-Id` 头部区分。

### 9.2 耗时

| 步骤 | 估时 |
|------|------|
| 1 依赖 + script | 0.25d |
| 2 client | 1.5d |
| 3 server entry + config | 0.5d |
| 4-8 tools × 5 module | 2d |
| 10 standalone runner + configs | 0.5d |
| 11 docs | 0.5d |
| 12 测试（client + tool registry + smoke） | 1.5d |
| Cursor / Claude Code 集成验证 | 1d |

**总计：** 全职 8 天；vibe coding 2-3 周。

### 9.3 Phase 10 衔接

Phase 9 让外部 agent 可以单点驱动 Synthia。Phase 10 (Benchmark Flow) 在此之上加批量能力 —— 一次提交几十个 case 让 Synthia 串行跑。MCP 加一个 `synthia_run_benchmark(suite_id, ...)` tool 即可对外暴露。

Phase 9 完工后用户应该能：
- ✅ Cursor 调 `synthia list projects` 直接看到 Synthia 项目
- ✅ Cursor agent 触发 synth → 看到 run_id → 轮询查状态
- ✅ Cursor agent 让 Synthia 诊断日志
- ✅ Cursor agent 提 patch，Synthia 在 UI 弹审批
- ✅ Cursor agent 拿到 timing summary markdown 写进 IDE 工作区
