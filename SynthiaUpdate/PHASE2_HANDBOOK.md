# Synthia Phase 2 开发手册：Connector 单一入口

> **前置：** Phase 0 + Phase 1 已完成（API 拆分完毕、token 鉴权就位、测试绿）  
> **目标：** 把当前 3 套 Vivado 执行路径收敛到一条：`API/Agent/CLI/MCP → RunOrchestrator → VivadoConnector → VivadoRuntimeAdapter`  
> **预估工期：** 全职 8-10 天；vibe coding 2 周  
> **核心改动：** 去除 `EDAGENT_LEGACY_VIVADO_TOOLS` 旁路；`specialists.py` / CLI / MCP / vivado_tools 全部改走 connector；Vivado capabilities 新增项目管理类（import_xpr / scan_project / create_project / generate_bitstream 等）

---

## 目录

- [0. 准备](#0-准备)
- [1. 现状盘点：3 套执行路径](#1-现状盘点3-套执行路径)
- [2. 目标架构](#2-目标架构)
- [3. 子任务 1：扩展 Vivado capabilities](#3-子任务-1扩展-vivado-capabilities)
- [4. 子任务 2：Connector 内部拆分](#4-子任务-2connector-内部拆分)
- [5. 子任务 3：Capability dispatch 完善](#5-子任务-3capability-dispatch-完善)
- [6. 子任务 4：废除 EDAGENT_LEGACY_VIVADO_TOOLS](#6-子任务-4废除-edagent_legacy_vivado_tools)
- [7. 子任务 5：specialists.py 改走 shims](#7-子任务-5specialistspy-改走-shims)
- [8. 子任务 6：CLI 走 connector](#8-子任务-6cli-走-connector)
- [9. 子任务 7：API route 走 connector](#9-子任务-7api-route-走-connector)
- [10. 子任务 8：Bridge.py 整理](#10-子任务-8bridgepy-整理)
- [11. 子任务 9：连通审批与 auto_approved](#11-子任务-9连通审批与-auto_approved)
- [12. 子任务 10：手动 smoke 与回归](#12-子任务-10手动-smoke-与回归)
- [13. 收尾](#13-收尾)

---

## 0. 准备

### 0.1 前置检查

```bash
cd E:/dev/edagent-vivado
git checkout product/synthia-workbench
git status   # clean
python -m pytest -k "not agent_smoke" -q --tb=no
# 期望: 0 failed
```

### 0.2 grep 一份基线表

记录当前所有"绕过 connector 直调 vivado_runner"的位置，Phase 2 收尾时这张表应该清空：

```bash
grep -rn "VivadoRunner\|run_vivado_synth_tool\|run_vivado_impl_tool\|_legacy_synth\|_legacy_impl\|_legacy_flow" \
    src/ --include="*.py" | grep -v "connector" > /tmp/legacy_calls.txt
wc -l /tmp/legacy_calls.txt
# 期望 (开始): ~15-25 行
# 期望 (Phase 2 结束): 0 行（或仅剩 connector 内部）
```

---

## 1. 现状盘点：3 套执行路径

### 1.1 路径 A：默认 graph

```
agent/graph.py
  → vivado_capability_shims.VIVADO_CAPABILITY_SHIM_TOOLS
    → run_connector_capability
      → execute_with_steps
        → VivadoConnector.execute
          → VivadoRuntimeAdapter
            → VivadoRunner
              → CommandRunner
```

这是 **正确路径**，保留。

### 1.2 路径 B：legacy tools（`EDAGENT_LEGACY_VIVADO_TOOLS=1`）

```
agent/graph.py
  → if env var: _TOOLS.extend([_legacy_synth, _legacy_impl, ...])
    → tools/vivado_tools.run_vivado_synth_tool
      → bridge.run_manifest_via_connector   # 仍走 connector，但 auto_approved=True 硬编码
      或者
      → VivadoRunner 直接调用（看具体函数）
```

**Phase 2 删除。**

### 1.3 路径 C：specialists

```
agent/supervisor.py + agent/specialists.py
  → 直接 import tools/vivado_tools.run_vivado_synth_tool
    → 同 B 路径
```

**Phase 2 改成走 shims（路径 A）。**

### 1.4 关键问题清单

| # | 问题 | 当前位置 | Phase 2 解法 |
|---|------|----------|-------------|
| 1 | `EDAGENT_LEGACY_VIVADO_TOOLS` 开关存在 | `agent/graph.py:45-54` | 删除分支 |
| 2 | `specialists.py` 直接 import vivado_tools | `agent/specialists.py:33` | 改 import shims |
| 3 | `bridge.run_manifest_via_connector` 硬编码 `auto_approved=True` | `connectors/vivado/bridge.py:100-106` | 改为读 settings |
| 4 | `tools/vivado_tools.run_vivado_*_tool` 各种 policy check 也是 `auto_approved=True` | `tools/vivado_tools.py:181-187` 等 | 统一删除这些直接 dispatch，改成 shims wrapper |
| 5 | CLI `run-synth` / `run-impl` 调 VivadoRunner | `cli.py:170-260` | 改调 `run_connector_capability` |
| 6 | API `/vivado/commands/flow` 走特殊 adapter | `routes/vivado.py`（Phase 1 拆出来的） | 改走 capability=`run_implementation` |
| 7 | Vivado capabilities 缺 project mgmt 类 | `connectors/vivado/capabilities.py` | 新增 5 个能力 |
| 8 | `run_simulation` 当前假成功（Phase 0 改成 not_implemented） | 同上 | 保持 not_implemented |

---

## 2. 目标架构

### 2.1 统一调用图

```text
┌─────────────────────────────────────────────────┐
│  入口层                                          │
│  ┌──────┐ ┌──────┐ ┌─────────┐ ┌──────┐         │
│  │ API  │ │ CLI  │ │ Agent   │ │ MCP  │         │
│  │route │ │      │ │ tools   │ │ tool │         │
│  └──┬───┘ └──┬───┘ └────┬────┘ └──┬───┘         │
│     │        │          │         │              │
│     └────────┴──────────┴─────────┘              │
│                  │                                │
│                  ▼                                │
│  ┌────────────────────────────────────┐          │
│  │  run_connector_capability()        │          │
│  │  (agent/run_capability.py)         │          │
│  └────────────────────────────────────┘          │
│                  │                                │
│                  ▼                                │
│  ┌────────────────────────────────────┐          │
│  │  execute_with_steps()              │          │
│  │  (connectors/run_execution.py)     │          │
│  │  - run_step_create                 │          │
│  │  - tool_run_request_create         │          │
│  │  - HITL gate check                 │          │
│  └────────────────────────────────────┘          │
│                  │                                │
│                  ▼                                │
│  ┌────────────────────────────────────┐          │
│  │  VivadoConnector.execute()         │          │
│  │  ├ executor.py (run synth/impl/bit)│ ← 拆分    │
│  │  ├ reports.py (parse reports)      │ ← 拆分    │
│  │  └ artifacts.py (discover output)  │ ← 拆分    │
│  └────────────────────────────────────┘          │
│                  │                                │
│                  ▼                                │
│  ┌────────────────────────────────────┐          │
│  │  VivadoRuntimeAdapter              │          │
│  │  (harness/vivado_adapter.py)       │          │
│  └────────────────────────────────────┘          │
│                  │                                │
│                  ▼                                │
│  ┌────────────────────────────────────┐          │
│  │  VivadoRunner / RemoteExecutor     │          │
│  └────────────────────────────────────┘          │
│                  │                                │
│                  ▼                                │
│  ┌────────────────────────────────────┐          │
│  │  CommandRunner (P0: shell=False)   │          │
│  └────────────────────────────────────┘          │
└─────────────────────────────────────────────────┘
```

### 2.2 关键不变量

1. **没有任何业务代码直接 `import VivadoRunner`** —— 只有 connector 内部能调
2. **所有 capability 调用都先创建 RunStep** —— 通过 `execute_with_steps`
3. **`auto_approved` 不被 API/Agent 显式传入** —— 由 `execute_with_steps` 内部从 server settings 读
4. **失败路径返回结构化 ToolRunResult** —— 不抛异常到 agent

---

## 3. 子任务 1：扩展 Vivado capabilities

### 3.1 在 capabilities.py 新增能力

打开 `src/edagent_vivado/connectors/vivado/capabilities.py`，在 `VIVADO_CAPABILITIES` 列表末尾追加：

```python
# ────────────────────────────────────────────────────────
# Phase 2 新增：项目管理类 capabilities
# ────────────────────────────────────────────────────────

ToolCapability(
    connector_id="vivado",
    capability_id="import_xpr",
    display_name="Import Vivado .xpr Project",
    stage="project",
    input_schema={"xpr_path": "string"},
    outputs=["project_summary", "internal_manifest"],
    risk_level="low",
    requires_approval=False,
    produces_reports=False,
    metadata={"phase": "2", "implementation": "stub", "real_in": "Phase 3"},
),

ToolCapability(
    connector_id="vivado",
    capability_id="scan_project",
    display_name="Scan Directory for FPGA Sources",
    stage="project",
    input_schema={"root_path": "string"},
    outputs=["project_summary"],
    risk_level="low",
    requires_approval=False,
    produces_reports=False,
    metadata={"phase": "2", "implementation": "stub", "real_in": "Phase 3"},
),

ToolCapability(
    connector_id="vivado",
    capability_id="create_vivado_project",
    display_name="Create Vivado .xpr from Manifest",
    stage="project",
    input_schema={"manifest_path": "string", "output_dir": "string"},
    outputs=["xpr_path"],
    risk_level="medium",
    requires_approval=False,
    produces_reports=False,
    metadata={"phase": "2", "implementation": "stub", "real_in": "Phase 3"},
),

ToolCapability(
    connector_id="vivado",
    capability_id="sync_xpr_manifest",
    display_name="Sync xpr ↔ Manifest Fingerprint",
    stage="project",
    input_schema={"project_id": "string"},
    outputs=["sync_result"],
    risk_level="low",
    requires_approval=False,
    metadata={"phase": "2", "implementation": "stub", "real_in": "Phase 3"},
),

ToolCapability(
    connector_id="vivado",
    capability_id="generate_bitstream",
    display_name="Generate Bitstream",
    stage="bitstream",
    input_schema={"manifest_path": "string", "from_dcp": "string"},
    outputs=["bitstream", "bitstream_log"],
    risk_level="medium",
    requires_approval=True,
    produces_reports=False,
    metadata={"phase": "2"},
),

ToolCapability(
    connector_id="vivado",
    capability_id="collect_bitstream",
    display_name="Collect Generated Bitstream Artifacts",
    stage="bitstream",
    input_schema={"run_id": "string"},
    outputs=["bitstream", "bitstream_log"],
    risk_level="low",
    requires_approval=False,
    metadata={"phase": "2"},
),

ToolCapability(
    connector_id="vivado",
    capability_id="run_full_flow",
    display_name="Synthesis + Implementation + Bitstream",
    stage="flow",
    input_schema={"manifest_path": "string", "stages": "array<string>"},
    outputs=["vivado_log", "timing_summary", "utilization", "drc", "bitstream"],
    risk_level="medium",
    requires_approval=True,
    produces_reports=True,
    metadata={"phase": "2"},
),
```

### 3.2 在 connector.py 增加 dispatch 分支

打开 `src/edagent_vivado/connectors/vivado/connector.py`，找到 `execute()` 方法（约第 140 行附近）。

在现有 `if cap == "run_synthesis"` 等分支之前**追加**：

```python
# ──── Phase 2: project management capabilities ────
if cap == "import_xpr":
    return self._capability_import_xpr(req)
if cap == "scan_project":
    return self._capability_scan_project(req)
if cap == "create_vivado_project":
    return self._capability_create_project(req)
if cap == "sync_xpr_manifest":
    return self._capability_sync_xpr_manifest(req)
if cap == "generate_bitstream":
    return self._capability_generate_bitstream(req)
if cap == "collect_bitstream":
    return self._capability_collect_bitstream(req)
if cap == "run_full_flow":
    return self._capability_run_full_flow(req)
```

### 3.3 添加 stub 实现

在 `VivadoConnector` 类末尾追加这些方法。**Phase 2 阶段它们是 stub，返回明确 not_implemented**，Phase 3 会填真实逻辑：

```python
def _capability_import_xpr(self, req: ToolRunRequest) -> ToolRunResult:
    """Stub: 真实实现见 Phase 3 (projects/xpr_importer.py)。"""
    return ToolRunResult(
        request_id=req.request_id,
        success=False,
        exit_code=1,
        error="import_xpr stub — implemented in Phase 3",
        edagent_outcome="execution_failed",
    )

def _capability_scan_project(self, req: ToolRunRequest) -> ToolRunResult:
    return ToolRunResult(
        request_id=req.request_id,
        success=False,
        exit_code=1,
        error="scan_project stub — implemented in Phase 3",
        edagent_outcome="execution_failed",
    )

def _capability_create_project(self, req: ToolRunRequest) -> ToolRunResult:
    return ToolRunResult(
        request_id=req.request_id,
        success=False,
        exit_code=1,
        error="create_vivado_project stub — implemented in Phase 3",
        edagent_outcome="execution_failed",
    )

def _capability_sync_xpr_manifest(self, req: ToolRunRequest) -> ToolRunResult:
    return ToolRunResult(
        request_id=req.request_id,
        success=False,
        exit_code=1,
        error="sync_xpr_manifest stub — implemented in Phase 3",
        edagent_outcome="execution_failed",
    )

def _capability_generate_bitstream(self, req: ToolRunRequest) -> ToolRunResult:
    """Bitstream generation — Phase 2 实现 mock，Phase 5 完整。"""
    from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter
    
    manifest_path = str(req.inputs.get("manifest_path") or "")
    if not manifest_path:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="manifest_path required",
            edagent_outcome="execution_failed",
        )
    
    adapter = VivadoRuntimeAdapter(self._target)
    raw = adapter.run_bitstream(
        manifest_path,
        session_id=str(req.inputs.get("session_id") or ""),
        task_id=str(req.inputs.get("task_id") or ""),
        run_id=req.run_id,
    )
    return self._result_from_raw(req.request_id, raw, stage="bitstream")

def _capability_collect_bitstream(self, req: ToolRunRequest) -> ToolRunResult:
    """从已完成的 run 收集 .bit 文件作为 Artifact。"""
    from pathlib import Path
    from edagent_vivado.connectors.base.types import Artifact
    import hashlib

    run_id = str(req.inputs.get("run_id") or req.run_id)
    if not run_id:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="run_id required",
            edagent_outcome="execution_failed",
        )
    
    from edagent_vivado.harness.run_workspace import ensure_run_workspace
    ws = ensure_run_workspace(run_id)
    bit_files = list(Path(ws.root).rglob("*.bit"))
    artifacts: list[Artifact] = []
    for bp in bit_files:
        try:
            data = bp.read_bytes()
            sha = hashlib.sha256(data).hexdigest()
            artifacts.append(Artifact(
                artifact_id=f"bit_{sha[:12]}",
                artifact_type="bitstream",
                path=str(bp),
                mime_type="application/octet-stream",
                size_bytes=len(data),
                sha256=sha,
            ))
        except Exception:
            continue
    
    return ToolRunResult(
        request_id=req.request_id,
        success=True,
        exit_code=0,
        artifacts=artifacts,
        edagent_outcome="execution_succeeded" if artifacts else "execution_failed",
        error="" if artifacts else "no .bit file found",
    )

def _capability_run_full_flow(self, req: ToolRunRequest) -> ToolRunResult:
    """Synth + Impl + Bitstream 串行。Phase 4 RunOrchestrator 会接管这种 multi-step。"""
    stages = req.inputs.get("stages") or ["synth", "impl", "bitstream"]
    if not isinstance(stages, list):
        stages = [str(stages)]
    
    # Phase 2 简单串行实现；Phase 4 改成 orchestrator
    if "synth" in stages or "impl" in stages:
        synth_first = "synth" in stages
        # 走现有 run_implementation 路径
        from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter
        adapter = VivadoRuntimeAdapter(self._target)
        raw = adapter.run_impl(
            str(req.inputs.get("manifest_path") or ""),
            session_id=str(req.inputs.get("session_id") or ""),
            task_id=str(req.inputs.get("task_id") or ""),
            run_id=req.run_id,
            run_synth_first=synth_first,
        )
        impl_result = self._result_from_raw(req.request_id, raw, stage="impl")
        if not impl_result.success:
            return impl_result
    
    if "bitstream" in stages:
        return self._capability_generate_bitstream(req)
    
    return ToolRunResult(
        request_id=req.request_id,
        success=True,
        exit_code=0,
        edagent_outcome="execution_succeeded",
        error="",
    )
```

### 3.4 在 VivadoRuntimeAdapter 加 `run_bitstream`

如果 `harness/vivado_adapter.py` 还没有 `run_bitstream` 方法：

```bash
grep -n "def run_bitstream\|def run_impl\|def run_synth" src/edagent_vivado/harness/vivado_adapter.py
```

如果没有，参考已有的 `run_impl` 写一个：

```python
def run_bitstream(
    self,
    manifest_path: str,
    *,
    session_id: str = "",
    task_id: str = "",
    run_id: str = "",
) -> "VivadoResult":
    """生成 bitstream — Phase 2 实现，可走 mock 或真实 Vivado。"""
    # 复用 run_impl 的脚本生成逻辑，只是 Tcl 末尾多一句 write_bitstream
    # 简化版：调用 run_impl 然后判断是否生成 .bit
    return self.run_impl(
        manifest_path,
        session_id=session_id,
        task_id=task_id,
        run_id=run_id,
        run_synth_first=False,   # 假设已经跑过 impl
        write_bitstream=True,    # 新增参数
    )
```

并在 Tcl template 里加 `write_bitstream` 分支。**完整实现移到 Phase 5**，Phase 2 阶段返回 stub 即可（如果 `write_bitstream` 还没接入 tcl，让它先 always-success 但 0 artifact）。

### 3.5 验证

```bash
python -m pytest tests/ -k "capabilit" -v
edagent web --port 8484 &
curl -H "Authorization: Bearer test123" \
  http://127.0.0.1:8484/api/v1/connectors/vivado/capabilities | python -m json.tool | grep capability_id
# 期望看到新增的 7 个 capability id
```

### 3.6 commit

```bash
git commit -am "Phase 2.1: extend Vivado capabilities (import_xpr, scan, create_project, bitstream, full_flow)"
```

---

## 4. 子任务 2：Connector 内部拆分

### 4.1 目标

`connectors/vivado/connector.py`（350 行）目前混合了：执行、报告解析、artifact 发现、错误分类、DB 同步。

拆成：

```
connectors/vivado/
├── connector.py       # 入口 + dispatch（保留，~120 行）
├── executor.py        # 新增：run_synth/impl/bitstream 调度（~100 行）
├── reports.py         # 新增：报告 capability 实现（~80 行）
├── artifacts.py       # 已存在或新增：artifact 发现
├── persist.py         # 已存在：DB capabilities sync
├── capabilities.py    # 已存在：能力清单
├── bridge.py          # 已存在：legacy 兼容（Phase 2 大幅简化）
└── parsers/           # 已存在
```

### 4.2 新建 executor.py

**新建** `src/edagent_vivado/connectors/vivado/executor.py`：

```python
"""Vivado execution dispatcher — extracted from connector.py in Phase 2."""

from __future__ import annotations

from typing import TYPE_CHECKING

from edagent_vivado.connectors.base.types import ToolRunRequest, ToolRunResult

if TYPE_CHECKING:
    from edagent_vivado.connectors.vivado.connector import VivadoConnector


def run_synth(connector: "VivadoConnector", req: ToolRunRequest) -> ToolRunResult:
    from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter

    manifest_path = str(req.inputs.get("manifest_path") or "")
    if not manifest_path:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="manifest_path required",
            edagent_outcome="execution_failed",
        )

    adapter = VivadoRuntimeAdapter(connector._target)
    raw = adapter.run_synth(
        manifest_path,
        session_id=str(req.inputs.get("session_id") or ""),
        task_id=str(req.inputs.get("task_id") or ""),
        run_id=req.run_id,
    )
    return connector._result_from_raw(req.request_id, raw, stage="synth")


def run_impl(connector: "VivadoConnector", req: ToolRunRequest) -> ToolRunResult:
    from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter

    manifest_path = str(req.inputs.get("manifest_path") or "")
    run_synth_first = bool(req.inputs.get("run_synth_first", False))

    adapter = VivadoRuntimeAdapter(connector._target)
    raw = adapter.run_impl(
        manifest_path,
        session_id=str(req.inputs.get("session_id") or ""),
        task_id=str(req.inputs.get("task_id") or ""),
        run_id=req.run_id,
        run_synth_first=run_synth_first,
    )
    return connector._result_from_raw(req.request_id, raw, stage="impl")


def classify_error_from_log(connector: "VivadoConnector", req: ToolRunRequest) -> ToolRunResult:
    from pathlib import Path
    from edagent_vivado.connectors.vivado.parsers.log_summary import parse_log_summary

    log_path = str(req.inputs.get("log_path") or "")
    if not log_path:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="log_path required",
            edagent_outcome="execution_failed",
        )

    text = Path(log_path).read_text(encoding="utf-8", errors="replace")
    summary = parse_log_summary(text)
    err_n = summary.data.get("error_count", 0)
    return ToolRunResult(
        request_id=req.request_id,
        success=True,
        exit_code=0,
        edagent_outcome="execution_succeeded",
        error=f"errors={err_n}",
    )
```

### 4.3 新建 reports.py

**新建** `src/edagent_vivado/connectors/vivado/reports.py`：

```python
"""Vivado report parsing capabilities — extracted from connector.py."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from edagent_vivado.connectors.base.types import ToolRunRequest, ToolRunResult

if TYPE_CHECKING:
    from edagent_vivado.connectors.vivado.connector import VivadoConnector


REPORT_CAPS = {
    "report_timing_summary",
    "report_utilization",
    "report_drc",
    "report_methodology",
    "parse_vivado_log",
}


def execute_report_capability(
    connector: "VivadoConnector",
    req: ToolRunRequest,
    cap: str,
) -> ToolRunResult:
    report_path = str(req.inputs.get("report_path") or req.inputs.get("path") or "")
    workspace = str(req.inputs.get("workspace") or "")
    if not report_path and not workspace:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="report_path or workspace required",
            edagent_outcome="execution_failed",
        )

    # Phase 2 简单实现：把现有 connector.py:_execute_report_capability 整段搬来
    # ↓ 这里写完整的 parser dispatch（参考原代码）
    ...
```

把 `connector.py` 里 `_execute_report_capability` 整段搬到这里。

### 4.4 改 connector.py 用新模块

打开 `src/edagent_vivado/connectors/vivado/connector.py`，把：

```python
if cap == "run_synthesis":
    # ...一大段代码...
    return self._result_from_raw(req.request_id, raw, stage="synth")
```

改成：

```python
if cap == "run_synthesis":
    from edagent_vivado.connectors.vivado.executor import run_synth
    return run_synth(self, req)
if cap == "run_implementation":
    from edagent_vivado.connectors.vivado.executor import run_impl
    return run_impl(self, req)
if cap == "classify_vivado_error":
    from edagent_vivado.connectors.vivado.executor import classify_error_from_log
    return classify_error_from_log(self, req)
if cap in REPORT_CAPS:
    from edagent_vivado.connectors.vivado.reports import execute_report_capability, REPORT_CAPS
    return execute_report_capability(self, req, cap)
```

`_execute_report_capability` 方法从 connector.py 里**删除**（已经搬到 reports.py）。

### 4.5 验证拆分

```bash
wc -l src/edagent_vivado/connectors/vivado/*.py
# 期望:
#   connector.py     ~200 行（从 350 减少）
#   executor.py      ~100 行
#   reports.py       ~80 行
#   其它不变

python -m pytest tests/ -k "vivado or connector" -v
# 期望: 全绿
```

---

## 5. 子任务 3：Capability dispatch 完善

### 5.1 在 capability_tools.py 注册新工具

打开 `src/edagent_vivado/agent/capability_tools.py`，确认它把 connector capabilities 暴露成 langchain tools。

应该有一个 `CAPABILITY_AGENT_TOOLS` 列表。新增 capability 后，**不需要手动加** —— 因为 capability_tools.py 通常是动态遍历 connector.list_capabilities() 生成的。

确认：

```bash
grep -n "list_capabilities\|CAPABILITY_AGENT_TOOLS" src/edagent_vivado/agent/capability_tools.py
```

如果是动态生成：✅ Phase 2 不用改。

如果是手写列表：在文件末尾加：

```python
# Phase 2: project mgmt capabilities (stubs until Phase 3)
for cap_id in ("import_xpr", "scan_project", "create_vivado_project", 
               "sync_xpr_manifest", "generate_bitstream", "collect_bitstream",
               "run_full_flow"):
    CAPABILITY_AGENT_TOOLS.append(
        _build_capability_tool("vivado", cap_id)
    )
```

### 5.2 在 vivado_capability_shims.py 注册新 shim

打开 `src/edagent_vivado/agent/vivado_capability_shims.py`。

应该有一个列表 `VIVADO_CAPABILITY_SHIM_TOOLS`，每个元素是 `@tool` 装饰的函数。

为每个新 capability 加一个 shim：

```python
@tool
def run_vivado_bitstream_tool(manifest_path: str) -> str:
    """Generate Vivado bitstream from a manifest.
    
    Args:
        manifest_path: Path to eda.yaml manifest.
    """
    from edagent_vivado.agent.run_capability import run_connector_capability
    return run_connector_capability(
        "vivado", "generate_bitstream",
        manifest_path=manifest_path,
        inputs={"manifest_path": manifest_path},
        gate_tool_name="run_vivado_bitstream_tool",
    )


@tool
def run_vivado_full_flow_tool(manifest_path: str, stages: str = "synth,impl,bitstream") -> str:
    """Run Vivado full flow (synth + impl + bitstream).
    
    Args:
        manifest_path: Path to eda.yaml.
        stages: Comma-separated stages. Default 'synth,impl,bitstream'.
    """
    from edagent_vivado.agent.run_capability import run_connector_capability
    return run_connector_capability(
        "vivado", "run_full_flow",
        manifest_path=manifest_path,
        inputs={
            "manifest_path": manifest_path,
            "stages": [s.strip() for s in stages.split(",") if s.strip()],
        },
        gate_tool_name="run_vivado_full_flow_tool",
    )


VIVADO_CAPABILITY_SHIM_TOOLS.extend([
    run_vivado_bitstream_tool,
    run_vivado_full_flow_tool,
    # ... project mgmt 类先不暴露给 agent，Phase 3 再加
])
```

### 5.3 注册 vivado_run_gate 白名单

打开 `src/edagent_vivado/harness/vivado_agent_registry.py`（或类似文件，存放 `vivado_tool_spec`）：

```bash
grep -rn "VIVADO_EXECUTION_TOOLS\|vivado_tool_spec" src/edagent_vivado/harness/
```

把新 shim 名字加入 execution tools 集合：

```python
VIVADO_EXECUTION_TOOLS = {
    "run_vivado_synth_tool",
    "run_vivado_impl_tool",
    "run_vivado_flow_tool",
    "run_vivado_bitstream_tool",        # Phase 2 新增
    "run_vivado_full_flow_tool",        # Phase 2 新增
}
```

### 5.4 验证

```bash
python -m pytest tests/ -k "capability or shim" -v
```

---

## 6. 子任务 4：废除 EDAGENT_LEGACY_VIVADO_TOOLS

### 6.1 删 graph.py 里的分支

打开 `src/edagent_vivado/agent/graph.py`。

找到：

```python
if _os.environ.get("EDAGENT_LEGACY_VIVADO_TOOLS", "").lower() in ("1", "true", "yes"):
    from edagent_vivado.tools.vivado_tools import (
        run_vivado_flow_tool as _legacy_flow,
        run_vivado_impl_tool as _legacy_impl,
        run_vivado_script_tool as _legacy_script,
        run_vivado_synth_tool as _legacy_synth,
        run_vivado_tcl_tool as _legacy_tcl,
    )
    _TOOLS.extend([_legacy_synth, _legacy_impl, _legacy_tcl, _legacy_script, _legacy_flow])
```

**整段删除**。

### 6.2 但保留 vivado_tools.py 部分函数（被审批 API 用）

`tools/vivado_tools.py` 里的 `run_vivado_tcl_tool` 和 `run_vivado_script_tool` 是审批 API 路由内部用的（`/vivado/commands/tcl` 和 `/script`），**保留这两个**，但它们的实现也要走 connector。

打开 `src/edagent_vivado/tools/vivado_tools.py`。

`run_vivado_tcl_tool` 的实现里有：

```python
policy = adapter.check_policy(command, auto_approved=True)
```

改成：

```python
from edagent_vivado.harness.execution_approval import is_vivado_execution_approved
auto_approved = is_vivado_execution_approved()
policy = adapter.check_policy(command, auto_approved=auto_approved)
```

`run_vivado_script_tool` 同理。

### 6.3 删 vivado_tools.py 不再使用的函数

`run_vivado_synth_tool`、`run_vivado_impl_tool`、`run_vivado_flow_tool` 这三个legacy 工具：检查它们是否还被 import：

```bash
grep -rn "run_vivado_synth_tool\|run_vivado_impl_tool\|run_vivado_flow_tool" src/ tests/
```

如果只有 `vivado_tools.py` 自己和测试在用，**保留函数但改实现**：让它们调 connector，不再直调 VivadoRunner。

`run_vivado_synth_tool` 改成：

```python
@tool
def run_vivado_synth_tool(manifest_path: str) -> str:
    """[DEPRECATED in Phase 2] Run Vivado synthesis. Use run_connector_capability instead."""
    from edagent_vivado.agent.run_capability import run_connector_capability
    return run_connector_capability(
        "vivado", "run_synthesis",
        manifest_path=manifest_path,
        inputs={"manifest_path": manifest_path},
        gate_tool_name="run_vivado_synth_tool",
    )
```

`run_vivado_impl_tool`、`run_vivado_flow_tool` 类似改。

### 6.4 验证

```bash
# 1. EDAGENT_LEGACY_VIVADO_TOOLS 已无效（设了也不生效）
EDAGENT_LEGACY_VIVADO_TOOLS=1 python -c "
from edagent_vivado.agent.graph import _TOOLS
names = [t.name for t in _TOOLS]
assert '_legacy_synth' not in [t.func.__name__ if hasattr(t, 'func') else t.name for t in _TOOLS]
print('legacy flag is no-op now ✓')
"

# 2. 测试不能挂
python -m pytest tests/ -k "vivado or tool" -v
```

### 6.5 commit

```bash
git commit -am "Phase 2.4: remove EDAGENT_LEGACY_VIVADO_TOOLS bypass; route all vivado tools via connector"
```

---

## 7. 子任务 5：specialists.py 改走 shims

### 7.1 改 import

打开 `src/edagent_vivado/agent/specialists.py`。

找到：

```python
from edagent_vivado.tools.vivado_tools import run_vivado_synth_tool
```

改成：

```python
from edagent_vivado.agent.vivado_capability_shims import (
    run_vivado_synth_tool,
    run_vivado_impl_tool,
    run_vivado_bitstream_tool,
)
```

（确认 `vivado_capability_shims.py` 里有这些 shim；如果没有，从 `tools/vivado_tools.py` 里搬一份，但用 `run_connector_capability` 实现。）

### 7.2 同样改 supervisor.py

```bash
grep -n "from edagent_vivado.tools.vivado_tools" src/edagent_vivado/agent/supervisor.py
```

如果有，改成 import shims。

### 7.3 验证

```bash
grep -rn "from edagent_vivado.tools.vivado_tools import" src/edagent_vivado/agent/
# 期望：空（specialists / supervisor 都改完了）

python -m pytest tests/ -k "specialist or supervisor" -v
```

---

## 8. 子任务 6：CLI 走 connector

### 8.1 找出 CLI 里直调 VivadoRunner 的命令

```bash
grep -n "VivadoRunner\|run_synth\|run_impl" src/edagent_vivado/cli.py
```

主要在 `run_synth`、`run_impl`、`run_sim` 三个命令。

### 8.2 改 run_synth 命令

打开 `src/edagent_vivado/cli.py`，找到 `def run_synth(`（约第 170 行）。

原本可能长这样：

```python
@app.command()
def run_synth(manifest: str, ...):
    runner = VivadoRunner(...)
    result = runner.run_synth(manifest)
    ...
```

改成：

```python
@app.command()
def run_synth(manifest: str, json_out: bool = False):
    """Run Vivado synthesis via connector."""
    _ensure_langsmith()
    from edagent_vivado.connectors import ensure_connectors
    from edagent_vivado.agent.run_capability import run_connector_capability
    import json as _json

    ensure_connectors()
    out = run_connector_capability(
        "vivado", "run_synthesis",
        manifest_path=manifest,
        inputs={"manifest_path": manifest},
    )
    if json_out:
        _safe_print(out)
    else:
        try:
            data = _json.loads(out)
            _safe_print(f"State: {data.get('edagent_outcome')}")
            if data.get("error"):
                _safe_print(f"Error: {data['error']}")
            if data.get("artifacts"):
                _safe_print(f"Artifacts: {len(data['artifacts'])}")
        except Exception:
            _safe_print(out)
```

`run_impl`、`run_sim` 类似改。

### 8.3 验证

```bash
edagent run-synth examples/uart_demo/eda.yaml --json-out
# 期望: 返回 JSON，包含 edagent_outcome 字段
```

---

## 9. 子任务 7：API route 走 connector

### 9.1 改 routes/vivado.py 的 flow endpoint

打开 `src/edagent_vivado/web/routes/vivado.py`，找到 `api_vivado_flow`：

```python
@router.post("/vivado/commands/flow")
async def api_vivado_flow(req: VivadoFlowReq):
    # 原来可能直调 adapter
    ...
```

改成：

```python
@router.post("/vivado/commands/flow")
async def api_vivado_flow(req: VivadoFlowReq):
    from edagent_vivado.connectors import ensure_connectors
    from edagent_vivado.agent.run_capability import run_connector_capability
    import json as _json

    ensure_connectors()
    out = run_connector_capability(
        "vivado", "run_full_flow",
        manifest_path=req.manifest_path,
        inputs={
            "manifest_path": req.manifest_path,
            "stages": req.stages,
            "strategy": req.strategy,
            "session_id": req.session_id,
        },
    )
    try:
        return _json.loads(out)
    except Exception:
        return {"raw": out}
```

### 9.2 `/vivado/commands/tcl` 和 `/script` 保留特殊路径

这两个是直接审批 Tcl/script，不走 capability —— 因为 capability 是有结构化输入的，而 Tcl 是字符串。

但 Phase 0 已经修了 `auto_approved` 客户端旁路。Phase 2 再加一层校验：

```python
@router.post("/vivado/commands/tcl")
async def api_vivado_tcl(req: VivadoTclReq):
    from edagent_vivado.tools.vivado_tools import run_vivado_tcl_tool
    # Note: tool internally checks server-side approval state (Phase 0 fix)
    return {"result": run_vivado_tcl_tool.invoke({"command": req.command, "manifest_path": req.manifest_path})}
```

### 9.3 验证

```bash
curl -X POST -H "Authorization: Bearer test123" \
  -H "Content-Type: application/json" \
  -d '{"manifest_path":"examples/uart_demo/eda.yaml","stages":["synth"]}' \
  http://127.0.0.1:8484/api/v1/vivado/commands/flow
# 期望: 返回 JSON 含 edagent_outcome
```

---

## 10. 子任务 8：Bridge.py 整理

### 10.1 当前 bridge.py 职责

打开 `src/edagent_vivado/connectors/vivado/bridge.py`：

```bash
wc -l src/edagent_vivado/connectors/vivado/bridge.py
```

它通常包含 `run_manifest_via_connector` 这种"给老 tools 用的桥接"。

### 10.2 改 auto_approved 硬编码

找到：

```python
return adapter.run_tcl(
    command,
    auto_approved=True,    # ← 硬编码
    ...
)
```

改成：

```python
from edagent_vivado.harness.execution_approval import is_vivado_execution_approved

return adapter.run_tcl(
    command,
    auto_approved=is_vivado_execution_approved(),
    ...
)
```

整个文件所有 `auto_approved=True` 都做同样修改。

### 10.3 标记 deprecated

文件顶部加：

```python
"""DEPRECATED: bridge.py exists only for legacy compat.
New code should use run_capability.run_connector_capability().
Will be removed in v1.1.
"""
```

### 10.4 验证

```bash
grep -n "auto_approved=True" src/edagent_vivado/
# 期望：仅在 connector.py 内部（执行已通过审批的运行时）出现，其他位置都不应该有
```

---

## 11. 子任务 9：连通审批与 auto_approved

### 11.1 在 execute_with_steps 里检查审批

打开 `src/edagent_vivado/connectors/run_execution.py`。

在调用 `conn.execute(prepared)` 之前加：

```python
# Phase 2: 服务端审批门控
if cap and cap.requires_approval and not request.auto_approved:
    from edagent_vivado.harness.execution_approval import is_vivado_execution_approved
    if not is_vivado_execution_approved():
        # 这里不直接拦截 —— 让 wait_vivado_gate_allowed 处理 HITL
        # 但确保 auto_approved 不会被绕过
        pass

# auto_approved 真值来源 = capability.requires_approval 反向 + 服务端 settings
effective_auto_approved = (not cap.requires_approval) if cap else False
if cap and cap.requires_approval:
    from edagent_vivado.harness.execution_approval import is_vivado_execution_approved
    effective_auto_approved = is_vivado_execution_approved()

request = ToolRunRequest(
    request_id=request.request_id,
    run_id=request.run_id,
    step_id=step_id,
    connector_id=request.connector_id,
    capability_id=request.capability_id,
    inputs=inputs,
    manifest_path=request.manifest_path,
    target_id=request.target_id,
    auto_approved=effective_auto_approved,
)
```

### 11.2 同时更新 run_capability.py

`src/edagent_vivado/agent/run_capability.py` 的：

```python
auto_approved=not cap.requires_approval,
```

改成：

```python
auto_approved=_resolve_auto_approved(cap),
```

并加 helper：

```python
def _resolve_auto_approved(cap) -> bool:
    """Server-side decides auto_approved, never client-supplied."""
    if not cap.requires_approval:
        return True
    try:
        from edagent_vivado.harness.execution_approval import is_vivado_execution_approved
        return is_vivado_execution_approved()
    except Exception:
        return False  # fail-closed
```

### 11.3 验证

写个新测试 `tests/test_capability_auto_approve.py`：

```python
import os
from edagent_vivado.agent.run_capability import _resolve_auto_approved


class FakeCap:
    def __init__(self, requires_approval):
        self.requires_approval = requires_approval


def test_low_risk_capability_auto_approves():
    cap = FakeCap(requires_approval=False)
    assert _resolve_auto_approved(cap) is True


def test_high_risk_capability_requires_server_state(monkeypatch):
    cap = FakeCap(requires_approval=True)

    # 服务端未开 auto-approve
    monkeypatch.setattr(
        "edagent_vivado.harness.execution_approval.is_vivado_execution_approved",
        lambda: False,
    )
    assert _resolve_auto_approved(cap) is False

    # 服务端开了
    monkeypatch.setattr(
        "edagent_vivado.harness.execution_approval.is_vivado_execution_approved",
        lambda: True,
    )
    assert _resolve_auto_approved(cap) is True
```

跑：

```bash
python -m pytest tests/test_capability_auto_approve.py -v
```

---

## 12. 子任务 10：手动 smoke 与回归

### 12.1 完整回归

```bash
python -m pytest -k "not agent_smoke" -q --tb=line
# 期望: 0 failed
```

### 12.2 手工 end-to-end smoke

启动 server：

```bash
EDAGENT_API_TOKEN=test123 edagent web --port 8484 &
```

调用 connector capability：

```bash
# 列出 capabilities
curl -s -H "Authorization: Bearer test123" \
  http://127.0.0.1:8484/api/v1/connectors/vivado/capabilities | python -m json.tool

# 期望看到新增的 import_xpr / scan_project / generate_bitstream 等
```

调用 full_flow（应该走 mock）：

```bash
curl -X POST -H "Authorization: Bearer test123" \
  -H "Content-Type: application/json" \
  -d '{"manifest_path":"examples/uart_demo/eda.yaml","stages":["synth"]}' \
  http://127.0.0.1:8484/api/v1/vivado/commands/flow
```

### 12.3 检查 legacy 调用为零

```bash
# 业务代码（非 connector 内部）直调 VivadoRunner 应该为零
grep -rn "VivadoRunner(" src/edagent_vivado/ --include="*.py" | \
  grep -v "connectors/vivado/\|harness/vivado_"
# 期望: 空输出
```

### 12.4 检查 EDAGENT_LEGACY 已无效

```bash
grep -rn "EDAGENT_LEGACY_VIVADO_TOOLS" src/
# 期望: 0 行
```

---

## 13. 收尾

### 13.1 文档更新

打开 `README.md`，把任何提到 `EDAGENT_LEGACY_VIVADO_TOOLS` 的地方删除。

`AGENTS.md` 里若有提及，更新为：

```markdown
**已废弃 (Phase 2):** `EDAGENT_LEGACY_VIVADO_TOOLS` 环境变量。所有 Vivado 执行统一经过 Connector。
```

### 13.2 在 futureWork.md 移除一条

打开 `futureWork.md` 第 7.2 节"三套 Vivado 执行路径"，标记为：

```markdown
### 7.2 ~~三套 Vivado 执行路径~~ ✓ Phase 2 完成
```

或直接删除。

### 13.3 commit

```bash
git add -A
git commit -m "Phase 2: collapse 3 Vivado execution paths into single connector pipeline

- Add 7 project mgmt capabilities (stubs for Phase 3 real impl)
- Split connector.py into executor.py + reports.py
- Remove EDAGENT_LEGACY_VIVADO_TOOLS bypass
- specialists.py / supervisor.py route via capability_shims
- CLI run-synth/impl uses run_connector_capability
- API /vivado/commands/flow uses run_full_flow capability
- auto_approved becomes server-side decision only
- bridge.py marked deprecated
- All vivado_tools wrappers delegate to capability layer
"
```

### 13.4 完成标志

- [ ] `grep VivadoRunner src/` 仅在 connector 内部出现
- [ ] `EDAGENT_LEGACY_VIVADO_TOOLS` 完全消失
- [ ] `bridge.py` 顶部有 DEPRECATED 注释
- [ ] 7 个新 capability 在 `/connectors/vivado/capabilities` 端点可见
- [ ] `pytest` 全绿
- [ ] CLI `run-synth` 仍可工作（mock 模式）
- [ ] API `/vivado/commands/flow` 接受 stages 参数

---

## 附录 A：执行链路 self-check 脚本

新建 `scripts/check_phase2_compliance.py`：

```python
"""Verify Phase 2 architecture compliance."""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent / "src" / "edagent_vivado"
violations: list[str] = []


def grep(pattern: str, exclude_dirs: list[str] = None) -> list[str]:
    exclude_args = []
    for d in exclude_dirs or []:
        exclude_args.extend(["--exclude-dir", d])
    result = subprocess.run(
        ["grep", "-rn", "--include=*.py"] + exclude_args + [pattern, str(ROOT)],
        capture_output=True, text=True
    )
    return [l for l in result.stdout.splitlines() if l.strip()]


def check_no_direct_runner_calls():
    """业务代码（非 connector 内部）不应直接构造 VivadoRunner。"""
    lines = grep("VivadoRunner(")
    bad = [l for l in lines if "/connectors/" not in l and "/harness/vivado_" not in l]
    if bad:
        violations.append("Direct VivadoRunner calls outside connector:")
        violations.extend("  " + l for l in bad)


def check_legacy_flag_removed():
    lines = grep("EDAGENT_LEGACY_VIVADO_TOOLS")
    if lines:
        violations.append("EDAGENT_LEGACY_VIVADO_TOOLS still referenced:")
        violations.extend("  " + l for l in lines)


def check_auto_approved_no_client():
    lines = grep('auto_approved = body.get')
    if lines:
        violations.append("auto_approved still read from request body:")
        violations.extend("  " + l for l in lines)


check_no_direct_runner_calls()
check_legacy_flag_removed()
check_auto_approved_no_client()

if violations:
    print("\n".join(violations))
    sys.exit(1)
print("Phase 2 compliance: OK")
```

跑：

```bash
python scripts/check_phase2_compliance.py
# 期望: "Phase 2 compliance: OK"
```

---

## 附录 B：耗时估算

| 子任务 | 估时 |
|--------|------|
| 1. 扩展 capabilities | 0.5d |
| 2. Connector 拆分 | 1d |
| 3. Capability dispatch | 0.5d |
| 4. 废 LEGACY 标志 | 1d |
| 5. specialists 改 shims | 0.5d |
| 6. CLI 改造 | 1d |
| 7. API route 改造 | 0.5d |
| 8. Bridge 整理 | 0.5d |
| 9. 审批连通 | 1d |
| 10. smoke + 回归 | 1d |
| 11. 文档与 cleanup | 0.5d |

**总计：** 全职 7-8 天；vibe coding 2 周。

---

## 附录 C：与 Phase 3 衔接

Phase 2 留了 4 个 capability stub：

- `import_xpr`
- `scan_project`
- `create_vivado_project`
- `sync_xpr_manifest`

Phase 3 的 `projects/xpr_importer.py` 等模块完成后，把 connector 里这些 stub 实现替换为真实调用即可。

Phase 4 会接管 `run_full_flow` 的多步骤执行：现在是 connector 内部串行，将来由 `RunOrchestrator` 创建多个 RunStep 分别 dispatch。
