# EdAgent → Synthia Upgrade Plan v0.1

> 文档状态：Draft  
> 日期：2026-05-26  
> 目标：把当前 `whosl/edagent` 从 EdAgent-Vivado 原型升级为 Synthia FPGA/EDA Agent Workbench。  
> 核心策略：**不推倒重写；保留 EdAgent 内核，新增 Synthia 产品层；前端一步到位切换 Next.js + AI SDK + shadcn/ui；执行主链路统一走 Connector。**

---

## 0. 总体判断

当前 `edagent` 仓库已经具备 Synthia 的后端雏形：

- 受控执行层。
- Manifest。
- Workspace。
- Vivado Runner。
- Tcl 模板。
- Parser。
- Error KB。
- LangChain/LangGraph Agent。
- Context Builder。
- FastAPI API。
- SSE event stream。
- SQLite repository。
- Connector 抽象。
- Vivado/Verilator Connector 雏形。
- Patch/Approval 表。
- Vite React 前端原型。

因此升级路线不是“另起炉灶”，而是：

```text
EdAgent Core 保留
Vivado Connector 扶正
API 产品化拆分
前端替换为 Synthia Workbench
MCP 作为外部协议新增
Runner/Artifact/Approval/RBAC 完整打通
```

最终定位：

```text
edagent = 内核 / harness / connector / agent core
synthia = 产品化工作台 / web app / user-facing brand
vivado connector = 第一个工业软件连接器
```

---

## 1. 当前资产盘点

### 1.1 必须保留

#### `src/edagent_vivado/harness/command_runner.py`

保留为 Controlled Execution Layer。

原因：

- 已有 allowlist。
- 已有危险命令拦截。
- 符合企业级 Agent 安全要求。

升级方向：

- 加入 RBAC policy。
- 加入 per-project path allowlist。
- 加入 capability risk policy。
- 加入 execution audit。
- 加入 remote worker 支持。

#### `src/edagent_vivado/harness/workspace.py`

保留为 Run Workspace 基础。

升级方向：

- 从 timestamp task dir 升级为 `{run_id}` 目录。
- 与 `runs` / `artifacts` 表绑定。
- 支持 input snapshot。
- 支持 artifact hash。
- 支持 path mapping。

#### `src/edagent_vivado/harness/vivado_runner.py`

保留，但下沉为 Vivado Connector 的 runtime adapter。

不要再让 Agent Tool / API 直接调用 VivadoRunner。

目标调用链：

```text
API / Agent / MCP
  ↓
RunOrchestrator
  ↓
VivadoConnector
  ↓
VivadoRunner
  ↓
CommandRunner
```

#### `src/edagent_vivado/harness/tcl_templates.py`

保留为 Tcl/script 模板系统。

升级方向：

- 使用 Jinja2 或现有模板体系标准化。
- 增加 project mode Tcl。
- 增加 generate bitstream Tcl。
- 增加 report-only Tcl。
- 增加 hardware manager Tcl，v1.1。

#### `src/edagent_vivado/parsers/*`

保留。

优先补齐：

- DRC parser。
- Methodology parser。
- bitstream detector。
- implementation log parser。
- xpr parser。
- IP/BD scanner。

#### `src/edagent_vivado/knowledge/*` / `error_cases.yaml`

保留。

升级方向：

- 区分 global KB / project KB / team KB。
- 从 Problem 自动生成 KB candidate。
- 加审批合并机制。

#### `src/edagent_vivado/agent/context.py`

保留为 Context Builder。

升级方向：

- 输入 Project/Run/Connector/Report/Approval 状态。
- 输出可审计 prompt package。
- 支持 token budget。
- 支持不同 Agent 类型 context profile。

#### `src/edagent_vivado/connectors/base/types.py`

必须保留并升级为 Connector SDK 的稳定协议。

这是整个 Synthia 工业软件扩展层的核心。

#### `src/edagent_vivado/connectors/vivado/*`

保留，升级为第一优先级。

需要新增项目管理能力：

- import_xpr。
- parse_xpr。
- create_project。
- scan_project。
- generate_manifest。
- sync_xpr_manifest。
- generate_bitstream。
- collect_bitstream。

#### `src/edagent_vivado/repository/db.py`

保留 schema 设计思想。

当前表已经非常接近目标：

- projects。
- sessions。
- tasks。
- runs。
- run_steps。
- artifacts。
- parsed_reports。
- patch_proposals。
- approvals。
- connectors。
- connector_capabilities。
- vivado_targets。
- knowledge_sources。
- problems。
- kb_cases。
- kb_candidates。

升级方向：

- 从手写 SQLite 迁移路线到 SQLAlchemy/Alembic/PostgreSQL。
- v1.0 可以先兼容 SQLite。
- 先补 repository CRUD 和业务事务。

#### 现有 Vite `frontend/`

保留为原型参考，不作为最终主前端长期承载。

可复用：

- API 调用思路。
- Chat 原型。
- Markdown/Mermaid 渲染。
- Zustand/Query 状态管理经验。
- Terminal/log UI 组件思路。

不建议继续堆复杂功能。

---

### 1.2 应该替换或降级

#### 当前 HTML dashboard

保留为 debug dashboard。

不要继续作为主产品前端。

#### 当前 CLI-first 用户体验

CLI 保留给开发者和自动化，但不能作为 Synthia 主入口。

需要从：

```text
edagent run-synth examples/uart_demo/eda.yaml
```

升级为：

```text
Synthia Web → Project → Agent → Run
```

CLI 后续命名可为：

```text
synthia project import-xpr
synthia run bitstream
synthia connector health
```

#### 用户显式 `eda.yaml`

在 Synthia 中，`eda.yaml` 对普通用户透明。

保留内部 manifest，但用户看到 `.xpr`。

---

## 2. 技术选型定稿

### 2.1 前端一步到位

选择：

```text
Next.js
React
TypeScript
Vercel AI SDK
shadcn/ui
Tailwind CSS
Radix UI
TanStack Query
Zustand 或 Jotai
Monaco Editor / Diff Viewer
Recharts / ECharts
```

理由：

- 更适合 Cursor-like 工作台。
- LLM/Claude Code/Cursor 对这套栈最擅长。
- Vercel AI SDK 原生支持 chat streaming / tool call UI。
- shadcn/ui 适合快速搭建高级、克制、可定制 UI。
- Next.js 更适合后续 Auth/RBAC/route/data loading。

迁移策略：

```text
不要在当前 frontend 上继续重构到很复杂；
新增 apps/web；
旧 frontend 保留到新 web 可用后再废弃。
```

### 2.2 后端继续 Python

选择：

```text
Python 3.11/3.12
FastAPI
Pydantic v2
SQLAlchemy 2.0
Alembic
LangGraph
PostgreSQL
Redis
```

理由：

- 当前后端已经是 Python/FastAPI。
- EDA 工具链、parser、Tcl、文件系统、benchmark 更适合 Python。
- LangGraph/Context Builder 已有基础。
- 高并发瓶颈在 Vivado worker/license，不在 API 语言。

### 2.3 Connector 策略

选择：

```text
内部：Python Connector Interface
外部：MCP Server
```

不要：

```text
内部也完全 MCP 化
```

理由：

- 内部需要事务、权限、审批、artifact、run step 状态。
- MCP 更适合给 Cursor/opencode/Claude Code/WorkBuddy 外部调用。

### 2.4 opencode 策略

不把 opencode 魔改成主产品。

复用方式：

1. 参考 agent mode / permission 设计。
2. 未来做 opencode plugin 或 MCP client。
3. 让 opencode 调用 Synthia MCP，而不是 Synthia 建在 opencode 上。

### 2.5 数据库策略

v1.0 开发可保留 SQLite 兼容，但架构按 PostgreSQL 设计。

建议：

```text
Phase A: 保留 repository/db.py，补 CRUD，跑通业务
Phase B: 引入 SQLAlchemy models，与旧表对齐
Phase C: Alembic migration
Phase D: PostgreSQL default，SQLite test/local only
```

### 2.6 队列策略

v1.0 可本地 async/task runner。

但设计上必须预留：

```text
Redis
RQ / Dramatiq / Celery
worker pool
license-aware scheduler
remote runner
```

---

## 3. 目标目录结构

建议逐步迁移到：

```text
edagent/
  apps/
    web/                         # 新 Synthia 前端
      app/
      components/
      features/
        chat/
        projects/
        agents/
        runs/
        reports/
        artifacts/
        approvals/
        connectors/
        admin/
      lib/
      package.json

    mcp/                         # Synthia MCP Server
      server.py
      tools.py

  src/
    edagent_vivado/
      agent/
      approvals/
      artifacts/
      benchmarks/
      connectors/
        base/
        vivado/
        verilator/
      events/
      harness/
      knowledge/
      mcp/
      projects/
        xpr_importer.py
        scanner.py
        manifest_sync.py
        wizard.py
      repository/
      runs/
        orchestrator.py
        state_machine.py
        scheduler.py
      security/
        rbac.py
        policy.py
        audit.py
      web/
        main.py
        routes/
          projects.py
          agents.py
          sessions.py
          tasks.py
          runs.py
          reports.py
          artifacts.py
          approvals.py
          connectors.py
          admin.py
          streams.py
```

---

## 4. 分阶段升级计划

## Phase 0：基线冻结与设计决策

目标：避免边做边乱。

### 任务

1. 开分支：

```bash
git checkout -b product/synthia-workbench
```

2. 增加文档：

```text
docs/synthia/spec.md
docs/synthia/update.md
docs/adr/
```

3. 写 ADR：

```text
0001-xpr-first-user-experience.md
0002-internal-manifest-transparent-to-user.md
0003-nextjs-ai-sdk-frontend.md
0004-internal-python-connector-external-mcp.md
0005-auto-mode-approval-policy.md
0006-postgresql-redis-target.md
```

4. 标记当前旧前端为 legacy。

### 验收

- 文档入库。
- README 增加 Synthia roadmap 入口。
- 不改业务代码。

---

## Phase 1：新前端骨架

目标：一步到位建立 Synthia Web Workbench 基础。

### 新建

```text
apps/web/
```

### 技术

```text
Next.js
TypeScript
Tailwind
shadcn/ui
Vercel AI SDK
TanStack Query
Monaco
```

### 页面

1. Workbench shell。
2. 左侧 Project Sidebar。
3. New Project 按钮。
4. Project tree。
5. Agent list。
6. Chat panel。
7. Run panel placeholder。
8. Connector status placeholder。

### 要保留

旧 `frontend/` 暂时不删。

### 不做

- 复杂权限。
- 完整报告。
- MCP。
- Benchmark UI。

### 验收

- 新前端能启动。
- 能调用现有 API 列出 projects/sessions。
- 能显示 Chat UI placeholder。
- UI 结构接近 Cursor-like。

---

## Phase 2：API 产品化拆分

目标：把当前 `api_v1.py` 从大文件拆成产品 API。

### 新增

```text
src/edagent_vivado/web/routes/
```

拆分：

```text
projects.py
agents.py
sessions.py
tasks.py
runs.py
reports.py
artifacts.py
approvals.py
connectors.py
admin.py
streams.py
```

### 保持兼容

旧 `/api/v1` 路径保持不变。

### 任务

1. 抽出 router。
2. 保留 SSE `_publish` 能力。
3. 为新前端补 endpoint。
4. 给每个 endpoint 加 Pydantic request/response schema。
5. 增加 OpenAPI tag。

### 验收

- 旧前端/旧 API 不坏。
- 新 web 可调用 project/session/task/run。
- pytest 通过。

---

## Phase 3：xpr-first Project Layer

目标：用户以 `.xpr` 为主，系统内部自动生成 manifest。

### 新增模块

```text
projects/xpr_importer.py
projects/scanner.py
projects/manifest_sync.py
projects/wizard.py
```

### API

```http
POST /api/v1/projects/import-xpr
POST /api/v1/projects/scan
POST /api/v1/projects/from-wizard
POST /api/v1/projects/{project_id}/sync-xpr
GET  /api/v1/projects/{project_id}/health
```

### 任务

1. 导入 `.xpr`。
2. 扫描目录。
3. 提取 RTL/XDC/IP/BD。
4. 生成内部 `.synthia/eda.yaml`。
5. Project 表保存 `xpr_path`。
6. UI 隐藏 manifest。
7. 检测 `.xpr` 修改 fingerprint。
8. 冲突时提示 sync。

### 需要注意

- Vivado `.xpr` 是 XML，路径可能相对。
- IP/BD 不要随便丢。
- Windows/Linux 路径要标准化。
- remote runner 需要 path mapping。

### 验收

- 可从一个已有 `.xpr` 创建 Project。
- 可从目录扫描创建 Project。
- UI 显示 `.xpr` 与工程摘要。
- 内部 manifest 生成但默认不暴露给用户。

---

## Phase 4：Vivado Connector 扶正

目标：所有 Vivado 执行必须经过 Connector。

### 当前问题

现有代码里可能同时存在：

```text
Agent Tool → VivadoRunner
CLI → VivadoRunner
API → LangGraph Tool
Connector → VivadoRunner
```

需要统一成：

```text
API / Agent / CLI / MCP
  ↓
RunOrchestrator
  ↓
VivadoConnector
  ↓
VivadoRunner
```

### 任务

1. 扩展 `connectors/base/types.py`：

新增：

```text
ProjectImportRequest
ProjectImportResult
ConnectorHealth
BitstreamArtifact
HardwareTarget
CapabilityPlan
```

2. 扩展 Vivado capabilities：

```text
import_xpr
scan_project
create_vivado_project
sync_xpr_manifest
run_full_flow
generate_bitstream
collect_bitstream
download_bitstream
```

3. 改造现有 tools：

- 旧 `run_vivado_synth` 改为调用 Connector。
- 旧 `run_impl` 改为调用 Connector。
- CLI 命令也调用 Connector。

4. 增加 capability risk policy。

### 验收

- grep 不应再出现业务层直接调用 VivadoRunner 执行 flow。
- synth/impl/bitstream 都经过 Connector。
- capabilities 可从 API 列出。
- Connector health 可展示。

---

## Phase 5：Run Orchestrator

目标：形成稳定的执行状态机。

### 新增

```text
runs/orchestrator.py
runs/state_machine.py
runs/events.py
runs/scheduler.py
```

### 任务

1. 创建 Run。
2. 创建 RunStep。
3. 逐步调用 Connector capability。
4. 写入 ToolRunRequest。
5. Step 状态落库。
6. Artifact 入库。
7. ParsedReport 入库。
8. Problem 入库。
9. SSE event 流式推送。
10. 支持 stop。
11. 支持 rerun。
12. 支持 benchmark continue-on-failure。

### 标准 Full Flow

```text
validate_project
prepare_workspace
snapshot_project
open_or_create_project
run_synthesis
collect_synth_artifacts
parse_synth_reports
run_implementation
collect_impl_artifacts
parse_impl_reports
generate_bitstream
collect_bitstream
diagnose
summarize
```

### 验收

- 前端 Run panel 能实时显示 step。
- 断线后刷新仍能看到 step。
- artifacts 与 run 关联。
- reports 与 run 关联。
- 失败能进入 diagnose。

---

## Phase 6：Chat UI 与 Agent Task 打通

目标：完整 Chat UI 不只是消息，而是触发任务与 Run。

### 前端

1. 使用 AI SDK 或自定义 transport 接后端 SSE。
2. 支持 message streaming。
3. 支持 tool call cards。
4. 支持 missing-info form。
5. 支持 approval card。
6. 支持 artifact card。
7. 支持 run card。
8. 支持 reconnect/resume。

### 后端

1. Chat task 创建。
2. Intent → TaskType。
3. 缺失参数识别。
4. 创建 RunPlan。
5. 调用 RunOrchestrator。
6. Agent summary 绑定 Run 状态。

### 注意

不要让 Chat UI 自己判断成功。  
成功必须来自 Run/Step/Report 状态。

### 验收

用户输入：

```text
帮我跑综合实现并生成码流
```

系统：

1. 弹出确认表单。
2. 创建 Task。
3. 创建 Run。
4. Chat 中展示 tool call。
5. Run panel 展示进度。
6. Artifact panel 出现 `.bit`。

---

## Phase 7：Report / Artifact 面板

目标：把 Vivado 输出产品化。

### 后端补齐

1. DRC parser。
2. Methodology parser。
3. bitstream detector。
4. implementation log parser。
5. report trends。

### 前端页面

1. Timing card。
2. Utilization card。
3. DRC card。
4. Log summary。
5. Artifact list。
6. Download buttons。
7. Export buttons。

### v1.0 导出

```text
Markdown
CSV
JSON
Artifacts zip
```

### 验收

- run 结束后可看到结构化报告。
- `.bit` 可下载。
- artifact zip 可下载。
- report parser 失败时 UI 显示“未解析”，但不崩溃。

---

## Phase 8：PatchProposal + Approval 状态机

目标：让 Agent 可以建议修改，但不能越权修改。

### 当前资产

已有：

```text
patch_proposals
approvals
patch_tools
file_patch_policy
execution_approval
```

### 任务

1. 标准化 PatchProposal schema。
2. XDC / RTL patch 必须进入 approval。
3. 前端 Diff Viewer。
4. Approve / Reject API。
5. Apply Patch。
6. Applied 后创建 rerun。
7. 记录审计。

### 风险规则

| 操作 | 策略 |
|---|---|
| internal manifest | 自动但记录 diff |
| generated Tcl | 自动 |
| XDC | approval |
| RTL | strong approval |
| delete file | denied 默认 |
| overwrite xpr | approval |
| program device | v1.1 strong approval |

### 验收

- 故意制造 XDC 缺失问题。
- Agent 生成 XDC patch。
- 前端显示 diff。
- 用户 approve。
- 系统应用 patch。
- rerun。
- run 结果对比。

---

## Phase 9：RBAC 与 Audit

目标：符合芯片开发企业使用边界。

### 任务

1. User/Role/Permission 表。
2. Project-level role。
3. API dependency 检查权限。
4. 审批权限。
5. bitstream 下载权限。
6. connector 管理权限。
7. audit log 表。
8. 管理页面初版。

### 最小角色

```text
Admin
Project Owner
FPGA Engineer
Reviewer
Viewer
Tool Admin
```

### 验收

- Viewer 不能创建 run。
- Viewer 不能下载 bitstream。
- FPGA Engineer 不能审批自己无权限的 RTL patch。
- Tool Admin 可管理 Vivado target。
- Admin 可查看 audit。

---

## Phase 10：MCP Server 初版

目标：让 Cursor / opencode / Claude Code / WorkBuddy 调用 Synthia。

### 新增

```text
apps/mcp/
src/edagent_vivado/mcp/
```

### MCP Tools

```text
synthia_list_projects
synthia_import_xpr
synthia_scan_project
synthia_run_synthesis
synthia_run_implementation
synthia_generate_bitstream
synthia_get_run
synthia_get_reports
synthia_get_artifacts
synthia_request_patch
synthia_approve_patch
synthia_reject_patch
```

### 原则

MCP tool 不直接执行 Vivado。  
MCP 调 Synthia API / RunOrchestrator。

### 验收

- Claude Code / Cursor 可 list projects。
- 可触发 synth run。
- 可查询 run 状态。
- 高风险操作返回 needs_approval。

---

## Phase 11：Benchmark Flow v1

目标：支持工程执行 + 研发分析的第二主线。

### 任务

1. BenchmarkSuite 数据结构。
2. BenchmarkCase。
3. 批量 run。
4. continue-on-failure。
5. 指标采集。
6. CSV/Markdown/JSON 导出。
7. UI 表格展示。

### v1 指标

```text
success
runtime
LUT
FF
BRAM
DSP
WNS
TNS
bitstream_exists
error_category
```

### 验收

- 跑 3 个 case。
- 其中 1 个失败不影响整体。
- 最终导出 CSV。
- UI 显示 success/failure 分布。

---

## Phase 12：部署与高并发

目标：从单机开发迈向企业可部署。

### 任务

1. PostgreSQL。
2. Redis。
3. Worker queue。
4. license-aware scheduler 初版。
5. remote SSH runner 整理。
6. tool target 管理。
7. artifact retention。
8. Docker compose。
9. health checks。
10. backup/restore。

### 高并发重点

不是 API QPS，而是：

- Vivado run 排队。
- license 资源。
- CPU/RAM。
- remote worker。
- 长任务断线恢复。
- artifact 同步。

### 验收

- 多用户同时提交 run。
- 系统按 target concurrency 排队。
- 前端显示 queued/running。
- worker 重启后 run 状态不丢。

---

## Phase 13：v1.1 硬件烧录

目标：生成 bitstream 后进入受控硬件闭环。

### 任务

1. HardwareTarget 表。
2. detect hardware target。
3. program_device capability。
4. strong approval。
5. bitstream hash 确认。
6. program log artifact。
7. hardware session。

### 验收

- 用户选择 `.bit`。
- 系统显示 hash。
- 用户确认烧录。
- Vivado Hardware Manager 执行。
- 记录结果。

---

## 5. 当前文件级改造建议

### 5.1 `pyproject.toml`

当前包名可先保留：

```text
edagent-vivado
```

新增 extras：

```toml
[project.optional-dependencies]
web = [...]
mcp = [...]
db = [...]
worker = [...]
all = [...]
```

后续可新增 script：

```text
synthia-api
synthia-worker
synthia-mcp
```

### 5.2 `frontend/`

标记为 legacy：

```text
frontend/README.md:
This is the legacy Vite frontend prototype.
The new Synthia workbench lives in apps/web.
```

### 5.3 `src/edagent_vivado/web/api_v1.py`

拆成 routes。

短期可保留 re-export router，避免破坏旧路径。

### 5.4 `connectors/base/types.py`

升级为稳定协议。  
避免业务里随便传 dict，尽量强类型。

### 5.5 `connectors/vivado/capabilities.py`

加入新增 capabilities：

```text
import_xpr
scan_project
create_project
sync_xpr_manifest
run_full_flow
generate_bitstream
collect_bitstream
download_bitstream
```

调整 risk：

- run_synthesis / run_implementation 在 Auto Mode 可自动。
- 不是所有 execution 都默认 requires_approval=True。
- 但要受 Mode 和 RBAC 控制。

### 5.6 `repository/db.py`

短期保留。  
新增 migrations 或至少 schema version。

建议先新增：

```text
users
roles
permissions
user_roles
project_members
audit_logs
benchmark_suites
benchmark_cases
hardware_targets
```

### 5.7 `tools/*`

逐步让 tool 只做薄封装：

```text
tool function
  ↓
RunOrchestrator / Connector
```

不要让 tool 自己调用 runner。

---

## 6. 要保留什么、选择什么、放弃什么

### 6.1 保留

```text
Python 后端
FastAPI
Pydantic v2
LangGraph / LangChain
Context Builder
Command Runner
Workspace
Vivado Runner
Tcl 模板
Parser
Error KB
Repository schema
Connector SDK
Vivado Connector
Verilator Connector 雏形
SSE event idea
Patch/Approval 现有机制
Mock Vivado
Remote SSH Vivado 思路
```

### 6.2 选择

```text
Next.js + AI SDK + shadcn/ui 作为新前端
xpr-first 用户体验
manifest internal
Internal Python Connector
External MCP Server
Run Orchestrator
PostgreSQL + Redis 作为目标企业部署
RBAC from v1
Auto Mode default
Markdown/CSV/JSON/zip v1 export
```

### 6.3 放弃或降级

```text
Vite frontend 作为长期主前端
HTML dashboard 作为主产品
CLI-first 用户体验
用户显式编辑 eda.yaml
Agent 直接调用 VivadoRunner
MCP 作为内部唯一抽象
opencode 魔改成主产品
LibreChat/Open WebUI 魔改成主产品
无审批自动修改 RTL/XDC
```

---

## 7. 容易忽略的未对齐项

### 7.1 `.xpr` 是用户主数据，但内部 manifest 是执行主数据

这件事最容易混乱。

必须写 ADR：

```text
用户看到 xpr
系统执行看 manifest
每次 run 前做 sync check
冲突显式提示
```

### 7.2 Project Mode / Non-project Mode 双轨

Vivado 工程师习惯 Project Mode。  
自动化 benchmark 更适合 Non-project Mode。  
Synthia 必须兼容，并统一结果模型。

### 7.3 IP/BD 不可简单当文件列表

真实 Vivado 工程里 IP/BD 会引入大量生成物。  
v1.0 最少要求：

- 识别。
- 保留。
- 不破坏。
- 报告不支持时明确提示。

### 7.4 Vivado 版本锁定

同一 `.xpr` 在不同 Vivado 版本表现不同。  
每个 Run 必须记录：

```text
Vivado version
path
host
OS
license status
part
board
strategy
```

### 7.5 Path Mapping

本地前端、Windows 工程、Linux Vivado server 三者路径不同。  
必须尽早把 path mapping 作为一等对象。

### 7.6 长任务日志

不要只依赖内存 SSE queue。  
event 必须落库，否则刷新页面就丢状态。

### 7.7 Artifact 权限

bitstream、DCP、RTL patch 都是敏感资产。  
不能所有人都能下载。

### 7.8 LLM 上下文泄露

必须定义：

- 哪些 artifact 可以进入 prompt。
- RTL 是否允许外发。
- 默认是否脱敏。
- 本地模型/外部模型策略。

### 7.9 Approval 与 Rerun 关系

Patch approve 后应该产生新 Run，而不是覆盖旧 Run。  
旧 Run、Patch、Approval、新 Run 要有关联。

### 7.10 Testing Fixtures

需要准备几类 fixture：

```text
valid_xpr_project
missing_rtl_project
missing_xdc_project
timing_violation_project
drc_error_project
ip_project
bd_project
bitstream_success_project
benchmark_mixed_success_fail
```

---

## 8. 推荐里程碑排期

### Milestone 1：Synthia Shell

交付：

- apps/web。
- Cursor-like layout。
- Project list。
- Agent list。
- Chat placeholder。
- Connector health placeholder。

### Milestone 2：xpr Project

交付：

- import `.xpr`。
- scan project。
- internal manifest。
- project summary。
- sync check。

### Milestone 3：Full Flow Run

交付：

- synth。
- impl。
- bitstream。
- run steps。
- artifacts。
- report parser。
- download bitstream。

### Milestone 4：Chat-driven Run

交付：

- 完整 Chat UI。
- missing info form。
- tool call cards。
- run card。
- stream/reconnect。

### Milestone 5：Patch Approval

交付：

- PatchProposal。
- Diff viewer。
- Approval。
- Apply patch。
- Rerun。

### Milestone 6：MCP

交付：

- Synthia MCP server。
- Cursor/opencode/Claude Code 可调用。
- 风险动作返回 needs_approval。

### Milestone 7：Benchmark

交付：

- suite/case。
- batch run。
- continue on failure。
- export CSV/Markdown/JSON。

### Milestone 8：Enterprise Hardening

交付：

- PostgreSQL。
- Redis。
- Worker queue。
- RBAC。
- Audit。
- deployment。

---

## 9. Definition of Done

### 9.1 v1.0 Demo DoD

1. 用户登录。
2. 新建或导入 `.xpr`。
3. Project 出现在左侧。
4. Project 下有 Agent。
5. 用户在 Chat 输入 full flow 请求。
6. 系统弹出参数确认。
7. 创建 Run。
8. Run step 实时更新。
9. 生成 `.bit`。
10. Artifact 可下载。
11. Reports 可视化。
12. 错误时能诊断。
13. 能生成 PatchProposal。
14. XDC/RTL 修改需要审批。
15. 能导出 Markdown/CSV/JSON/zip。
16. MCP 可触发 run 和查询结果。

### 9.2 工程 DoD

1. 关键模块有单元测试。
2. Parser 有 fixture。
3. Connector 有 mock tests。
4. API 有 integration tests。
5. 前端有基础 e2e。
6. Command policy 有安全测试。
7. Approval flow 有测试。
8. xpr import 有测试。
9. Stream reconnect 有测试。
10. 关键数据表有 migration/version。

---

## 10. 开发注意事项

### 10.1 不要先做大而全权限 UI

先做 RBAC 后端与关键权限检查，UI 可以逐步补。

### 10.2 不要先做硬件烧录

v1.0 只生成和下载 `.bit`。  
烧录放 v1.1，避免安全风险拖慢主线。

### 10.3 不要把 benchmark 提前复杂化

v1 只要批量跑 + 基础指标 + 导出。  
baseline/method/geomean 第二版。

### 10.4 不要为了 MCP 牺牲内部架构

MCP 是外部接口，不是内部核心。

### 10.5 不要让 Chat 成为状态来源

状态来源永远是 DB / Run / Step / Report / Artifact。  
Chat 只负责解释和操作入口。

---

## 11. 最后建议

当前最正确的第一步不是继续加 Vivado 功能，而是做这三个“扶正”：

```text
1. 新建 Synthia Web：Next.js + AI SDK + shadcn/ui
2. xpr-first Project Layer：导入 .xpr → 内部 manifest
3. Run Orchestrator：所有执行统一 Connector + RunStep
```

只要这三个打通，Synthia 就从 EdAgent-Vivado 原型变成真正的产品底座。
