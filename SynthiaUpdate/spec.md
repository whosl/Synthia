# Synthia Business & Technical Spec v0.1

> 文档状态：Draft  
> 日期：2026-05-26  
> 目标读者：产品负责人、后端/前端/Agent 工程师、FPGA/EDA 工程师、企业信息化/安全负责人  
> 来源：基于当前 `whosl/edagent` 仓库现状与本轮需求讨论整理  
> 核心判断：**EdAgent 是内核，Synthia 是产品化工作台；Vivado Connector 是第一个工业软件连接器。**

---

## 0. Executive Summary

Synthia 是面向 FPGA 开发工程师的 **Cursor-like FPGA/EDA Agent Workbench**。它不是普通聊天机器人，也不是单纯的 Vivado 命令封装，而是一个以工程项目为中心、以 Agent 对话为入口、以受控工业软件连接器为执行层、以 Run/Artifact/Approval 为闭环的企业级 EDA Agent 控制台。

第一阶段聚焦 Vivado：

```text
用户视角：.xpr / Vivado Project first
系统内部：manifest / eda.yaml normalized project model
执行层：Vivado Connector + Controlled Runner
Agent 层：LangGraph + Context Builder + Tool Capability Selector
前端：Next.js + AI SDK + shadcn/ui 的 Cursor-like Chat Workbench
```

Synthia 的核心价值：

1. 让 FPGA 工程师以原生 Vivado 习惯管理工程，但获得 Agent 自动化能力。
2. 支持综合、实现、码流生成、码流下载、报告解析、错误诊断、Patch 建议、审批复跑。
3. 通过 Connector 抽象，把 Vivado 扩展为未来可接入 ISE、VCS、DC、Yosys、Verilator、MATLAB、ADS、Virtuoso、自研工具等的工业软件平台。
4. 对企业场景保留 RBAC、审批、安全执行、产物归档、历史追溯、知识沉淀。
5. 前端一步到位采用现代 Chat UI / Agent UI 体系，但业务内核不照搬通用 Chat 平台。

---

## 1. 产品定位

### 1.1 一句话定位

**Synthia 是面向 FPGA 开发工程师的 Agentic EDA 工作台，通过统一 Connector 管理 Vivado 等工业软件项目，实现工程执行、报告分析、错误诊断、码流产物管理、批量实验、受控修复和企业级审计。**

### 1.2 不是什么

Synthia 不是：

- 一个简单的 Vivado Chatbot。
- 一个只会调用 `vivado -mode batch` 的 MCP server。
- 一个替代 Vivado GUI 的完整 IDE。
- 一个无审批自动修改 RTL/XDC 的黑箱 Agent。
- 一个通用 ChatGPT/LibreChat/Open WebUI 替代品。
- 一个只服务个人 demo 的脚本集合。

### 1.3 是什么

Synthia 是：

- **EDA Agent Control Plane**：管理项目、Agent、任务、运行、报告、产物、审批。
- **Vivado Project Workbench**：让用户按照 `.xpr` / Vivado 工程习惯工作。
- **Industrial Tool Connector Platform**：把 Vivado 作为第一个工业软件连接器。
- **企业级可审计 Agent 系统**：每次命令、日志、报告、Patch、审批都可追踪。
- **研发实验平台**：后续支持 benchmark suite、批量实验、baseline 对比、报告导出。

---

## 2. 用户与使用场景

### 2.1 第一批用户

第一批用户聚焦：

```text
FPGA 开发工程师
```

他们关注：

- Vivado 工程是否能快速跑起来。
- 综合/实现失败的原因是什么。
- Timing violation 的关键路径和可能优化方向。
- DRC / Methodology warning 是否危险。
- bitstream 是否生成成功，能否下载。
- 多次 Run 之间资源、时序、runtime 是否变好。
- Agent 改了什么，是否可审批、可回滚。
- 批量 benchmark 能不能稳定执行并导出指标。

### 2.2 第二批用户

后续扩展到：

- EDA 工具算法工程师。
- FPGA 抗辐射/可靠性算法研发人员。
- ASIC/数字后端工程师。
- 验证工程师。
- 企业项目负责人。
- 工具链管理员/IT/安全人员。

---

## 3. 产品原则

### 3.1 Project-first，不是 Chat-first

Chat 是入口，但 Synthia 的主对象是 Project。

```text
Project → Agent → Session → Task → Run → Step → Artifact/Report/Approval
```

用户打开系统看到的是项目工作台，而不是空白聊天框。

### 3.2 xpr-first 用户体验，manifest-first 系统实现

用户习惯以 Vivado `.xpr` 为主。`eda.yaml` 对用户透明。

```text
用户看到：
- Vivado Project
- .xpr
- RTL / XDC / IP / BD
- Run / Report / Bitstream

系统内部维护：
- .synthia/eda.yaml 或 .edagent/eda.yaml
- normalized ToolManifest
- project snapshot
- path mapping
- connector metadata
```

### 3.3 Connector 是工业软件边界

Agent Core 不直接理解 Vivado Tcl，不直接拼命令，不直接裸执行 shell。所有工业软件能力必须经过 Connector。

```text
Agent Core
  ↓
Tool Capability Selector
  ↓
Internal Python Connector
  ↓
Controlled Runner
  ↓
Vivado / 其他工业软件
```

对外可以暴露 MCP，但内部主链路不以 MCP 作为唯一抽象。

### 3.4 默认 Auto Mode，但高风险动作必须审批

默认模式为 Auto Mode：

- 低风险动作自动执行。
- 中风险动作可自动执行但记录审计。
- 高风险动作生成 PatchProposal，必须人工审批。
- Critical 动作默认禁止。

### 3.5 每次运行都必须可追溯

一次 Run 必须能回答：

- 谁发起？
- 在哪个 Project？
- 用哪个 Connector？
- 用哪个 Vivado 版本/路径/目标机？
- 输入工程快照是什么？
- 执行了哪些 Step？
- 生成了哪些 Tcl/script？
- 产生了哪些 log/report/artifact？
- Agent 做了哪些判断？
- 是否生成 Patch？
- 谁审批？
- 是否复跑？
- 与上一轮结果差异是什么？

---

## 4. 版本范围

### 4.1 v1.0 范围

v1.0 目标：**完成 Synthia 作为 Vivado Agent Workbench 的主闭环。**

必须支持：

1. Cursor-like Web Workbench。
2. 左侧 Project 列表 + New Project。
3. 每个 Project 下有多个智能体。
4. 完整 Chat UI。
5. 原生 Vivado-like 创建项目体验。
6. 导入已有 `.xpr`。
7. 自动扫盘并生成内部 manifest。
8. `.xpr` 对用户为主，`eda.yaml` 对用户透明。
9. Vivado Connector 环境检测。
10. synth / impl / bitstream 运行。
11. `.bit` 码流下载。
12. Vivado log / report / artifact 展示。
13. Run Step 状态机。
14. 失败后诊断并生成 PatchProposal。
15. XDC / RTL 等高风险修改必须审批。
16. benchmark 任务失败后继续后续 case。
17. Markdown / CSV / JSON / artifacts zip 导出。
18. 企业级 RBAC 数据模型与基础实现。
19. 内部 Python Connector 作为主链路。
20. 对外 MCP Server 初版，供 Cursor / opencode / Claude Code / WorkBuddy 调用。

### 4.2 v1.1 范围

v1.1 目标：**硬件烧录与更强项目工程化。**

支持：

1. Vivado Hardware Manager 基础调用。
2. FPGA board/device 检测。
3. 受控烧录 bitstream。
4. 烧录前二次确认。
5. bitstream hash 校验。
6. 硬件 session 记录。
7. 更完整的 DRC / Methodology parser。
8. remote worker / SSH target 更稳定。
9. license-aware run queue 初版。

### 4.3 v2.0 范围

v2.0 目标：**从 Vivado Workbench 扩展为工业软件 Agent 平台。**

支持：

1. ILA / VIO 在线调试 session。
2. Benchmark suite / baseline / method 对比。
3. Verilator / XSim / ISE / Yosys / VCS / DC Connector。
4. 多项目 workspace/program。
5. 企业部署：PostgreSQL + Redis + Worker Pool。
6. 组织级 RBAC / 审计导出。
7. 知识库自动沉淀。
8. 远程 runner 池与资源调度。
9. 更多 Agent 模式与团队协作。

---

## 5. 核心对象模型

### 5.1 Organization

企业或团队租户。v1.0 可先单租户，但数据模型保留 organization_id。

字段：

```text
id
name
status
created_at
updated_at
metadata
```

### 5.2 User

用户。

字段：

```text
id
name
email
status
auth_provider
created_at
last_login_at
metadata
```

### 5.3 Role / Permission

第一版即按企业级 RBAC 预留。

角色建议：

```text
Admin
Project Owner
FPGA Engineer
Reviewer
Viewer
Tool Admin
```

关键权限：

```text
read_project
create_project
import_project
delete_project
create_run
stop_run
download_artifact
download_bitstream
approve_patch
modify_xdc
modify_rtl
program_device
manage_connector
manage_users
manage_roles
view_audit_log
```

### 5.4 Workspace

工作区，包含多个 Project。v1.0 可弱化，但建议保留。

```text
id
name
root_path
owner_id
created_at
metadata
```

### 5.5 Project

一个 Synthia Project 在 v1.0 中与一个 Vivado Project / `.xpr` 基本一一对应。

字段：

```text
id
workspace_id
name
status
root_path
xpr_path
internal_manifest_path
part
board_part
top_module
target_language
source_globs
constraint_globs
ip_globs
bd_globs
tcl_globs
default_connector_id
default_target_id
created_at
updated_at
last_active_at
metadata
```

关键原则：

- 用户可见 `.xpr_path`。
- `internal_manifest_path` 对用户默认隐藏。
- Project 必须能从 `.xpr` 导入。
- Project 必须能从目录扫描创建。
- Project 必须能从内部 manifest 生成 Vivado project。

### 5.6 Agent

Project 下挂多个智能体。Agent 是任务入口与领域职责，而不是完全独立的进程。

v1.0 建议内置：

```text
Project Agent
Synthesis Agent
Implementation Agent
Timing Agent
DRC/Methodology Agent
Constraint Agent
Bitstream Agent
Benchmark Agent
Knowledge Agent
```

v1.1/v2.0 增加：

```text
Hardware Agent
ILA/VIO Debug Agent
Verilator Agent
ISE Agent
DC Agent
VCS Agent
Yosys Agent
```

字段：

```text
id
project_id
name
agent_type
description
default_mode
enabled_capabilities
model_profile
system_prompt_template
created_at
metadata
```

### 5.7 Session

会话，属于 Project 和 Agent。

```text
id
project_id
agent_id
name
status
created_at
updated_at
last_message_preview
metadata
```

### 5.8 Message

Chat 消息。

```text
id
session_id
task_id
agent_id
role
content
content_summary
created_at
token_input
token_output
metadata
```

### 5.9 Task

用户请求形成的任务。

```text
id
project_id
session_id
agent_id
user_message_id
task_type
state
started_at
finished_at
active_run_id
error
metadata
```

常见 task_type：

```text
create_project
import_xpr
scan_project
run_synthesis
run_implementation
generate_bitstream
diagnose_failure
timing_analysis
propose_patch
benchmark_run
export_report
program_device
```

### 5.10 Run

一次可执行流程。

```text
id
project_id
session_id
task_id
agent_id
connector_id
target_id
run_type
name
state
mode
started_at
finished_at
elapsed_ms
input_summary
output_summary
artifact_id
metadata
```

Run 状态：

```text
created
queued
running
waiting_for_approval
succeeded
succeeded_with_warnings
failed
cancelled
policy_denied
needs_review
```

### 5.11 RunStep

Run 的步骤状态机。

```text
id
run_id
step_index
step_key
stage
name
state
connector_id
capability_id
started_at
finished_at
elapsed_ms
error
metadata
```

标准 Vivado full flow steps：

```text
validate_project
prepare_workspace
sync_or_snapshot_project
create_or_open_vivado_project
run_synthesis
parse_synth_reports
run_implementation
parse_impl_reports
generate_bitstream
collect_artifacts
diagnose
summarize
```

### 5.12 ToolConnector

工业软件连接器。

```text
connector_id
tool_name
supported_versions
capabilities
environment
health
metadata
```

v1.0 connector：

```text
vivado
```

v2.0 connector：

```text
verilator
xsim
ise
yosys
vcs
design_compiler
primetime
custom_tmr_tool
```

### 5.13 ToolCapability

工具能力。

```text
connector_id
capability_id
display_name
stage
input_schema
outputs
risk_level
requires_approval
supports_stop
supports_mock
produces_reports
produces_patch
metadata
```

### 5.14 ToolTarget

执行目标。

```text
id
connector_id
name
target_type        # local / remote_ssh / mock / worker
host
ssh_user
tool_path
settings_path
work_root
tool_version
license_status
enabled
metadata
```

### 5.15 Artifact

产物。

```text
id
project_id
session_id
task_id
run_id
artifact_type
path
mime_type
size_bytes
sha256
summary
created_at
metadata
```

常见 artifact_type：

```text
vivado_log
vivado_jou
tcl_script
timing_report
utilization_report
drc_report
methodology_report
checkpoint_dcp
bitstream
parsed_json
summary_markdown
benchmark_csv
artifact_zip
patch_diff
```

### 5.16 ParsedReport

结构化报告。

```text
id
run_id
artifact_id
report_type
tool
stage
data_json
created_at
metadata
```

report_type：

```text
timing_summary
utilization
drc
methodology
power
simulation
log_summary
bitstream_summary
```

### 5.17 Problem

从 log/report 中提取的问题。

```text
id
project_id
session_id
task_id
run_id
source
severity
category
signature
normalized_signature
message
raw_excerpt_artifact_id
detected_at
resolved
resolution_summary
metadata
```

### 5.18 PatchProposal

Agent 提出的修改建议。

```text
id
project_id
run_id
target_file
patch_type
risk_level
reason
diff
status
created_at
metadata
```

status：

```text
pending_approval
approved
rejected
applied
superseded
```

### 5.19 Approval

审批记录。

```text
id
project_id
run_id
patch_id
approval_type
risk_level
state
requested_by
reviewed_by
requested_at
reviewed_at
decision_reason
metadata
```

approval_type：

```text
patch_apply
vivado_execution
program_device
delete_file
overwrite_project
modify_rtl
modify_xdc
```

### 5.20 BenchmarkSuite / BenchmarkCase

v1.0 保留，简化支持。

```text
BenchmarkSuite:
  id
  project_id
  name
  cases
  baseline_config
  metrics_config

BenchmarkCase:
  id
  suite_id
  name
  root_path
  xpr_path
  manifest_path
  top_module
  part
  expected_outputs
  metadata
```

---

## 6. 主业务流程

### 6.1 打开首页

目标：Cursor-like 工作台。

布局：

```text
┌─────────────────────────────────────────────────────────────┐
│ Top Bar: Synthia / Workspace / User / Connector Health       │
├───────────────┬─────────────────────────┬───────────────────┤
│ Left Sidebar  │ Main Chat / Task Console │ Right/Bottom Panel│
│ Projects      │ Agent conversation       │ Run / Reports     │
│ + New Project │ Tool call stream         │ Artifacts         │
│ Project Tree  │ Missing info dialog      │ Approvals         │
│ Agents        │                          │ Logs              │
└───────────────┴─────────────────────────┴───────────────────┘
```

左侧 Project 结构：

```text
+ New Project

uart_demo
  Agents
    Project Agent
    Synthesis Agent
    Implementation Agent
    Timing Agent
    Constraint Agent
    Bitstream Agent
  Runs
  Artifacts
  Approvals

benchmark_suite
  Agents
    Benchmark Agent
    Report Agent
```

### 6.2 新建项目：Vivado-like Wizard

用户体验接近 Vivado：

步骤：

1. Project Name / Location。
2. 选择 RTL Project / Post-synthesis / Empty Project。
3. 添加 RTL / Include / IP / BD。
4. 添加 XDC。
5. 选择 Part / Board。
6. 选择 top module。
7. Review。
8. Create。

系统动作：

1. 生成内部 manifest。
2. 创建 `.synthia/` 或 `.edagent/` 项目元数据目录。
3. 调用 Vivado Connector 创建/生成 `.xpr`。
4. 建立 Project 记录。
5. 自动创建默认 Agent 列表。
6. 生成初始 Project Health Check task。

### 6.3 导入已有 `.xpr`

用户选择 `.xpr`。

系统动作：

1. 解析 `.xpr`。
2. 提取 project root、part、board_part、sources、constraints、IP、BD、top。
3. 生成内部 manifest。
4. 做路径合法性检查。
5. 显示导入摘要。
6. 用户确认。
7. 创建 Project。
8. 第一次运行 Project Health Check。

必须处理：

- `.xpr` 文件相对路径。
- Windows path / Linux path 差异。
- remote target path mapping。
- IP repo 路径。
- block design。
- out-of-context IP。
- Vivado version mismatch。
- 文件缺失。

### 6.4 自动扫盘导入

用户选择目录。

系统扫描：

```text
*.xpr
*.v / *.sv / *.vhd
*.xdc
*.xci
*.bd
*.tcl
*.mem / *.coe
```

系统输出：

```text
Detected:
- 1 Vivado project
- 34 RTL files
- 2 XDC files
- 5 IP files
- possible top modules: top, uart_top
- possible parts: from xpr or xdc
```

若信息不足，弹出补充框：

```text
请选择 top module
请选择 part / board
请选择 flow: synth only / full flow / bitstream
```

### 6.5 Chat 发起任务

用户输入：

```text
帮我跑一遍综合实现并生成码流
```

系统不自动猜全部参数，而是：

1. Agent 解析 intent。
2. 检查缺失信息。
3. 弹出确认框：

```text
运行目标：
[x] Synthesis
[x] Implementation
[x] Bitstream
[ ] Program Device

策略：
[x] Vivado Default
[ ] Performance Explore
[ ] Area Optimized

失败处理：
[x] 自动诊断
[x] 生成 PatchProposal
[ ] 自动尝试低风险修复并复跑

导出：
[x] Artifacts zip
[x] Summary Markdown
```

4. 用户确认。
5. 创建 Task + Run。
6. Run Orchestrator 执行。

### 6.6 Full Flow Run

流程：

```text
validate_project
prepare_run_workspace
snapshot_project
open_or_create_vivado_project
run_synthesis
collect_synth_artifacts
parse_synth_reports
run_implementation
collect_impl_artifacts
parse_impl_reports
generate_bitstream
collect_bitstream
diagnose_problems
generate_summary
export_artifacts
```

失败策略：

- 非 benchmark：失败后停止当前 flow，进入 diagnose + PatchProposal。
- benchmark：当前 case 失败，记录状态，继续下一个 case。

### 6.7 失败诊断与 Patch

当失败：

1. 收集 log/report。
2. Parser 提取 Problem。
3. KB 匹配已知 error pattern。
4. Agent 生成诊断。
5. 如可修复，生成 PatchProposal。
6. 前端展示 diff。
7. 用户审批。
8. 应用 patch。
9. 创建 rerun。

默认审批规则：

| 操作 | v1.0 策略 |
|---|---|
| 生成 Tcl | 自动 |
| 生成 manifest | 自动，但可查看 diff |
| 修改内部 manifest | 自动，记录 diff |
| 修改 XDC | 审批 |
| 修改 RTL | 强审批 |
| 覆盖 `.xpr` | 审批 |
| 删除文件 | 禁止或强审批 |
| 烧录 FPGA | v1.1 强审批 |

### 6.8 Timing 调优

v1.0 支持：

1. 解释 timing report。
2. 定位 worst path。
3. 给出人工优化建议。
4. 自动尝试 Vivado strategy。
5. 简化 DSE：多 strategy 运行，对比 WNS/TNS/LUT/FF/runtime。

不在 v1.0 自动做：

- 自动修改 XDC false path/multicycle。
- 自动修改 RTL pipeline。
- 自动重构时钟结构。

v2.0 支持审批式高级优化。

### 6.9 Benchmark Flow

v1.0 最小闭环：

1. 定义 benchmark cases。
2. 统一 flow 配置。
3. 批量执行 synth/impl/bitstream 可选。
4. 失败 case 继续。
5. 采集基础指标：

```text
success/fail
runtime
LUT
FF
BRAM
DSP
WNS
TNS
bitstream generated
error category
```

6. 导出 CSV / Markdown / JSON / artifacts zip。

v2.0 扩展：

- baseline vs method。
- 多算法版本。
- 多 Vivado strategy。
- 多器件 part。
- geomean/median/improvement。
- 自动论文/项目报告表格。
- failed cases 分类与重试。

### 6.10 Bitstream 下载

v1.0 支持：

1. 生成 `.bit`。
2. 记录 sha256。
3. 作为 Artifact 展示。
4. 支持下载。
5. 支持打包进 artifact zip。

v1.1 支持烧录：

1. detect hardware target。
2. 用户确认。
3. program device。
4. 记录 device id、bitstream hash、烧录日志。
5. 失败诊断。

---

## 7. Agent 体系

### 7.1 Agent 列表

#### Project Agent

职责：

- 工程导入。
- 工程健康检查。
- 文件缺失诊断。
- manifest/xpr 同步检查。
- 总体项目摘要。

#### Synthesis Agent

职责：

- synth run。
- synth failure diagnosis。
- synthesis warning 分类。
- 资源初步分析。

#### Implementation Agent

职责：

- opt/place/route。
- implementation failure diagnosis。
- post-impl report 解析。
- DCP/bitstream 相关产物管理。

#### Timing Agent

职责：

- timing report 解释。
- worst path 分析。
- strategy/DSE 建议。
- 多 run timing trend。

#### Constraint Agent

职责：

- XDC 缺失检查。
- DRC NSTD/UCIO 等约束问题诊断。
- 生成 XDC patch proposal。
- 不自动应用高风险 patch。

#### Bitstream Agent

职责：

- bitstream 生成。
- bitstream artifact 管理。
- v1.1 负责 program device 前置确认。

#### Benchmark Agent

职责：

- 批量执行。
- 失败不中断整体实验。
- 指标汇总。
- 报告导出。

#### Knowledge Agent

职责：

- 检索内部 error KB。
- 生成新 KB candidate。
- 帮助复盘已解决问题。

### 7.2 Agent Mode

#### Safe Mode

只读分析：

- 不改文件。
- 不执行高风险命令。
- 不烧录。
- 适合审查工程和未知项目。

#### Assist Mode

生成建议：

- 可运行低风险工具。
- Patch 必须审批。
- 适合日常辅助。

#### Auto Mode

默认模式：

- 低风险自动执行。
- 中风险记录审计。
- 高风险等待审批。
- benchmark 可以自动继续。

#### Research Mode

批量实验：

- 自动批量运行。
- 不主动修改源工程。
- 失败不中断。
- 强调导出和统计。

#### Hardware Mode

硬件操作：

- v1.1+。
- 连接板卡、烧录、在线调试。
- 所有硬件动作强审批。

---

## 8. 前端 Spec

### 8.1 技术选择

前端一步到位采用：

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

参考但不直接照搬：

- Vercel Chatbot：Chat UI、AI SDK、shadcn、Next.js 结构。
- LangChain Agent Chat UI：LangGraph chat 通信方式。
- opencode：Agent mode / permission / multi-session 交互设计。
- 不建议魔改 LibreChat / Open WebUI 作为主产品。
- 不建议把 opencode 改成 Synthia 主前端；更适合作为外部 MCP client 或设计参考。

### 8.2 页面结构

#### `/`

Workbench 首页。

- Project list。
- New Project。
- 最近 Run。
- Connector health。
- 当前用户/组织。

#### `/projects/:projectId`

Project 总览。

- 工程摘要。
- `.xpr` 信息。
- part / board / top。
- 最近任务。
- 最近问题。
- Artifact 快捷入口。

#### `/projects/:projectId/agents/:agentId`

Agent 工作区。

- Chat。
- Tool call stream。
- Task plan。
- Run panel。
- Approval panel。
- Artifact panel。

#### `/projects/:projectId/runs/:runId`

Run 详情页。

- Step timeline。
- log stream。
- reports。
- artifacts。
- problems。
- related patch proposals。

#### `/projects/:projectId/reports`

报告页。

- Timing。
- Utilization。
- DRC。
- Methodology。
- Trend。

#### `/projects/:projectId/artifacts`

产物页。

- `.log`。
- `.rpt`。
- `.dcp`。
- `.bit`。
- `.json`。
- `.zip`。

#### `/projects/:projectId/approvals`

审批页。

- pending approval。
- approved/rejected。
- diff viewer。
- risk explanation。

#### `/connectors`

Connector 状态页。

v1.0 支持：

- Vivado detected。
- version。
- executable path。
- license status。
- local/remote/mock target。
- supported capabilities。

v2.0 支持多 connector。

#### `/admin`

企业管理页。

- Users。
- Roles。
- Permissions。
- Audit logs。
- Tool targets。

### 8.3 主布局

左侧：

```text
Workspace
Projects
+ New Project
Project tree
  Agents
  Runs
  Artifacts
  Approvals
Connectors
Admin
```

中间：

```text
Chat messages
Tool call cards
Missing-info form
Agent plan
```

右侧/底部：

```text
Run steps
Logs
Reports
Artifacts
Approvals
```

### 8.4 Chat UI 要求

必须支持：

- Streaming assistant response。
- Tool call card。
- Tool call state：queued/running/succeeded/failed/needs_approval。
- Missing information dialog。
- Approval dialog。
- File/artifact link。
- Markdown / code / table。
- Long-running task reconnect。
- Stop task。
- Resume stream。
- Session history。
- Project-aware context。

### 8.5 Chat 不应该承担的内容

不应该把以下内容只塞在聊天消息中：

- 长 log。
- 完整 report。
- 大 diff。
- Artifact list。
- Run history。
- 审批状态。
- Benchmark 汇总表。

这些必须进入结构化面板。

---

## 9. 后端架构

### 9.1 推荐技术栈

```text
Python 3.11/3.12
FastAPI
Pydantic v2
SQLAlchemy 2.0
Alembic
PostgreSQL
Redis
LangGraph
LangChain tools
Jinja2
SSE / WebSocket
Celery / Dramatiq / RQ
```

v1.0 可以继续兼容 SQLite，但目标架构以 PostgreSQL + Redis 为准。

### 9.2 分层

```text
Synthia Web
  ↓
Synthia API
  ↓
Agent Core
  ↓
Run Orchestrator
  ↓
Connector Core
  ↓
Vivado Connector
  ↓
Controlled Runner
  ↓
Vivado
```

### 9.3 API 模块

建议拆分：

```text
web/routes/projects.py
web/routes/sessions.py
web/routes/messages.py
web/routes/tasks.py
web/routes/runs.py
web/routes/run_steps.py
web/routes/connectors.py
web/routes/artifacts.py
web/routes/reports.py
web/routes/approvals.py
web/routes/benchmarks.py
web/routes/admin.py
web/routes/chat.py
web/routes/streams.py
```

### 9.4 关键 API

#### Project

```http
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/{project_id}
PATCH  /api/v1/projects/{project_id}
DELETE /api/v1/projects/{project_id}

POST   /api/v1/projects/import-xpr
POST   /api/v1/projects/scan
POST   /api/v1/projects/from-manifest
POST   /api/v1/projects/{project_id}/sync-xpr
GET    /api/v1/projects/{project_id}/health
```

#### Agents

```http
GET    /api/v1/projects/{project_id}/agents
POST   /api/v1/projects/{project_id}/agents
GET    /api/v1/agents/{agent_id}
PATCH  /api/v1/agents/{agent_id}
```

#### Chat / Task

```http
POST   /api/v1/sessions
GET    /api/v1/sessions/{session_id}
POST   /api/v1/sessions/{session_id}/tasks
GET    /api/v1/tasks/{task_id}
POST   /api/v1/tasks/{task_id}/stop
GET    /api/v1/sessions/{session_id}/stream
```

#### Run

```http
POST   /api/v1/projects/{project_id}/runs
GET    /api/v1/runs/{run_id}
POST   /api/v1/runs/{run_id}/stop
POST   /api/v1/runs/{run_id}/rerun
GET    /api/v1/runs/{run_id}/steps
GET    /api/v1/runs/{run_id}/events
GET    /api/v1/runs/{run_id}/reports
GET    /api/v1/runs/{run_id}/artifacts
```

#### Connector

```http
GET    /api/v1/connectors
GET    /api/v1/connectors/{connector_id}
GET    /api/v1/connectors/{connector_id}/capabilities
POST   /api/v1/connectors/{connector_id}/detect
GET    /api/v1/tool-targets
POST   /api/v1/tool-targets
```

#### Approval

```http
GET    /api/v1/approvals
GET    /api/v1/approvals/{approval_id}
POST   /api/v1/approvals/{approval_id}/approve
POST   /api/v1/approvals/{approval_id}/reject
```

#### Artifact

```http
GET    /api/v1/artifacts/{artifact_id}
GET    /api/v1/artifacts/{artifact_id}/download
GET    /api/v1/runs/{run_id}/artifact-zip
```

---

## 10. Connector Spec

### 10.1 内部 Connector

内部使用 Python Connector Interface。

要求：

```python
class ToolConnector(Protocol):
    connector_id: str
    tool_name: str
    supported_versions: list[str]

    def detect_environment(self) -> ToolEnvironment: ...
    def list_capabilities(self) -> list[ToolCapability]: ...
    def validate_manifest(self, manifest: ToolManifest) -> ValidationResult: ...
    def prepare_run(self, request: ToolRunRequest) -> PreparedRun: ...
    def execute(self, prepared: PreparedRun) -> ToolRunResult: ...
    def collect_artifacts(self, result: ToolRunResult) -> list[Artifact]: ...
    def parse_artifacts(self, result: ToolRunResult) -> ParsedReportBundle: ...
    def classify_error(self, result: ToolRunResult) -> ToolErrorSummary | None: ...
```

### 10.2 外部 MCP Server

对外提供 MCP，不替代内部 Connector。

用途：

- Cursor 调用。
- Claude Code 调用。
- opencode 调用。
- WorkBuddy 调用。
- 第三方 Agent 调用。

MCP tool 列表：

```text
synthia_list_projects
synthia_import_xpr
synthia_scan_project
synthia_create_vivado_project
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

### 10.3 Vivado Connector

v1.0 Vivado Connector 是项目管理层，不只是命令适配器。

职责：

- detect Vivado。
- detect license。
- parse `.xpr`。
- create `.xpr` from wizard。
- scan directory。
- generate internal manifest。
- sync `.xpr` ↔ manifest。
- generate Tcl/script。
- execute synth。
- execute impl。
- generate bitstream。
- collect reports/logs/DCP/bit。
- parse timing/utilization/DRC/log。
- classify error。
- expose capabilities。
- enforce risk policy。

### 10.4 Capability 风险等级

| Capability | Risk | Approval |
|---|---:|---|
| detect_environment | low | no |
| parse_xpr | low | no |
| scan_project | low | no |
| validate_project | low | no |
| create_internal_manifest | low | no |
| create_vivado_project | medium | optional |
| run_synthesis | medium | auto in Auto Mode |
| run_implementation | medium | auto in Auto Mode |
| generate_bitstream | medium | auto in Auto Mode |
| download_bitstream | low | no |
| modify_manifest | medium | no, log diff |
| modify_xdc | high | yes |
| modify_rtl | high | yes |
| overwrite_xpr | high | yes |
| delete_file | critical | denied by default |
| program_device | high | yes, v1.1+ |

---

## 11. Run Orchestrator

### 11.1 作用

Run Orchestrator 是 Synthia 的执行状态机，连接 Agent、Connector、Runner、DB、SSE。

职责：

1. 创建 Run。
2. 创建 RunStep。
3. 调用 Connector capability。
4. 写入 step 状态。
5. 写入 tool run request。
6. 采集 artifacts。
7. 解析 reports。
8. 记录 problems。
9. 创建 patch proposals。
10. 发出 streaming events。
11. 处理 stop/rerun。
12. 处理 approval resume。

### 11.2 Event Protocol

事件类型：

```text
task_created
agent_message_delta
agent_message_done
missing_info_required
run_created
run_queued
run_started
run_step_started
run_step_log_delta
run_step_succeeded
run_step_failed
run_waiting_for_approval
artifact_created
report_parsed
problem_detected
patch_proposal_created
approval_requested
approval_resolved
run_succeeded
run_failed
run_cancelled
```

必须支持断线重连：

- 每个 event 有 seq。
- 前端可从 last_event_id 续订。
- events 持久化入库。

---

## 12. Artifact 与 Report

### 12.1 Artifact Store

Artifact 可以先本地文件系统，企业版可接对象存储。

目录建议：

```text
workspace/
  projects/
    {project_id}/
      .synthia/
        eda.yaml
        project_index.json

  runs/
    {run_id}/
      input_snapshot/
      generated_scripts/
      logs/
      reports/
      checkpoints/
      bitstreams/
      artifacts/
      parsed/
      patches/
      exports/
```

### 12.2 Report 展示

v1.0 report 页面必须支持：

- Timing summary。
- Utilization。
- DRC。
- Vivado log summary。
- run-to-run comparison。
- bitstream summary。

### 12.3 导出

v1.0 支持：

```text
Markdown
CSV
JSON
Artifacts zip
```

v2.0 支持：

```text
PDF
Excel
PPT/report template
```

---

## 13. 安全、权限与审批

### 13.1 RBAC

v1.0 即按企业级 RBAC 建模，不一定一次做完整 UI。

角色与权限见第 5.3。

### 13.2 审批

必须审批：

- RTL 修改。
- XDC 修改。
- 覆盖 `.xpr`。
- 删除文件。
- v1.1 的烧录。
- 任何 critical risk capability。

审批页面必须展示：

- 操作类型。
- 风险等级。
- 影响文件。
- diff。
- Agent 解释。
- 相关 log/report。
- Approve / Reject / Ask Agent to revise。

### 13.3 审计

必须记录：

- 用户输入。
- Agent plan。
- 模型输出。
- tool request。
- command/script。
- stdout/stderr/log。
- artifacts。
- patch diff。
- approval decision。
- rerun result。
- downloaded artifact。
- hardware programming action。

---

## 14. 技术栈决策

### 14.1 选择

#### Frontend

```text
Next.js + React + TypeScript + Vercel AI SDK + shadcn/ui
```

#### Backend

```text
Python + FastAPI + Pydantic v2 + SQLAlchemy + LangGraph
```

#### Queue / Storage

```text
PostgreSQL + Redis + Worker Queue
```

#### Connector

```text
Internal Python Connector + External MCP Server
```

#### Runner

```text
Controlled subprocess / SSH runner / future worker pool
```

### 14.2 不选

#### 不把 opencode 作为 Synthia 主产品

理由：

- opencode 是 coding agent，不是 EDA workflow system。
- 它适合参考 agent mode 和 permission，也适合作为 MCP client。
- 魔改 opencode 会把产品绑到代码编辑任务模型上。

#### 不把 LibreChat/Open WebUI 作为主前端

理由：

- 它们是通用 Chat 平台。
- Synthia 需要 Project/Run/Artifact/Approval 深度业务对象。
- 直接魔改会被原平台架构绑架。

#### 不把 MCP 作为内部唯一主链路

理由：

- 内部需要事务、权限、审批、artifact、run step 状态机。
- Python Connector 更适合作为核心业务接口。
- MCP 适合作为外部协议层。

---

## 15. 容易忽略但必须对齐的问题

### 15.1 `.xpr` 与内部 manifest 的同步语义

必须定义：

- 谁是用户主数据？
- 谁是系统主数据？
- 什么时候同步？
- 冲突怎么处理？
- 用户在 Vivado GUI 改了工程，Synthia 如何发现？

建议：

```text
用户主数据：.xpr
系统规范化主数据：internal manifest
同步策略：每次打开/运行前做 xpr fingerprint 检查
冲突策略：提示用户选择 sync from xpr / keep manifest / merge
```

### 15.2 Vivado Project Mode 与 Non-project Mode

现有 EdAgent 多偏 manifest + batch flow。Synthia 用户习惯 `.xpr`。必须同时支持：

- Project mode：打开/生成 `.xpr`。
- Non-project mode：适合 benchmark 和自动化。
- 两种模式产物目录要统一。

### 15.3 IP / BD / XCI 复杂度

v1.0 若只处理 RTL/XDC，真实 Vivado 项目会很快撞到：

- `.xci` IP。
- block design `.bd`。
- IP repository。
- out-of-context synthesis。
- generated output products。
- simulation filesets。
- constraints sets。

建议 v1.0 至少能识别并保留，不能随便丢弃。

### 15.4 远程路径映射

很多企业 Vivado 在 Linux 服务器上，本地前端在 Windows/macOS。

必须处理：

- local root。
- remote root。
- path mapping。
- rsync/scp。
- artifact pull back。
- Windows `\` 与 Linux `/`。

### 15.5 长任务与断线恢复

Vivado run 很长，前端断线很常见。

必须支持：

- run persist。
- event persist。
- reconnect。
- resume stream。
- stop/kill。
- timeout。
- orphan process recovery。

### 15.6 License-aware scheduling

并发瓶颈不是 FastAPI，而是 Vivado license、CPU、RAM。

企业版必须有：

- worker queue。
- tool target。
- license status。
- concurrency limit。
- run priority。
- user quota。

### 15.7 Bitstream 安全

`.bit` 是敏感产物。

必须支持：

- 下载权限。
- hash。
- 下载审计。
- artifact retention policy。
- export policy。

### 15.8 LLM 数据安全

必须定义：

- 哪些文件可进入 prompt？
- RTL 是否允许发外部模型？
- 内网模型/外部模型切换。
- 脱敏规则。
- prompt package 审计。
- 用户可见与不可见上下文边界。

### 15.9 Chat UI 与业务状态不能脱节

不要让 Chat 里说“已成功”，但 Run 状态仍 failed。所有自然语言总结必须引用结构化 Run/Report 状态。

### 15.10 审批不是弹窗而是状态机

审批必须入库，支持：

- pending。
- approved。
- rejected。
- expired。
- superseded。
- applied。
- rerun linked。

### 15.11 模型选择与成本

需要 model profile：

- planning model。
- diagnosis model。
- summarization model。
- cheap parser/summarizer。
- local fallback。
- token/cost tracking。

### 15.12 测试策略

要同时测试：

- parser unit tests。
- connector mock tests。
- command policy tests。
- API integration tests。
- frontend e2e。
- long-running run reconnect tests。
- approval flow tests。
- xpr import fixtures。

---

## 16. 验收标准

### 16.1 v1.0 Product Demo 验收

必须能演示：

1. 登录 Synthia。
2. 左侧看到项目列表。
3. 新建 Vivado 工程。
4. 导入已有 `.xpr`。
5. 选择 Synthesis Agent。
6. Chat 输入“跑综合实现并生成码流”。
7. 系统弹出缺失参数确认框。
8. 用户确认。
9. Run 面板显示 step 进度。
10. log 流式展示。
11. timing/utilization/drc 报告结构化展示。
12. bitstream 产物可下载。
13. 故意制造错误后，系统给出诊断和 PatchProposal。
14. Patch 审批通过后复跑。
15. 导出 Markdown + CSV + JSON + artifacts zip。
16. Connector 页面显示 Vivado 环境状态。

### 16.2 技术验收

1. 所有 Vivado 执行经过 Connector。
2. 所有命令经过 Controlled Runner。
3. 所有 Run 有 run_steps。
4. 所有 artifacts 入库并有 sha256。
5. 所有 report parser 失败不影响系统崩溃。
6. 所有高风险 Patch 需要审批。
7. Chat streaming 可断线恢复。
8. RBAC 至少能限制下载 bitstream、审批 patch、管理 connector。
9. MCP Server 能从外部触发 run 并查询结果。

---

## 17. 推荐目录结构

```text
edagent/
  apps/
    web/                       # 新 Next.js Synthia 前端
      app/
      components/
      features/
        chat/
        projects/
        runs/
        reports/
        artifacts/
        approvals/
        connectors/
      lib/
      package.json

    api/                       # FastAPI entrypoint，可保留原 src 入口
      main.py

    mcp/                       # Synthia MCP server
      server.py

  src/
    edagent_vivado/            # 现有内核，逐步产品化
      agent/
      connectors/
        base/
        vivado/
        verilator/
      harness/
      repository/
      web/
      projects/
      runs/
      approvals/
      artifacts/
      benchmarks/
      security/
      mcp/

  docs/
    spec.md
    update.md
    adr/
      0001-xpr-first-manifest-internal.md
      0002-nextjs-ai-sdk-frontend.md
      0003-internal-connector-external-mcp.md
      0004-rbac-and-approval.md
```

---

## 18. 参考依据

本 Spec 基于：

- 当前 `whosl/edagent` 仓库已有能力。
- 当前仓库已有 FastAPI / LangChain / LangGraph / Connector / Repository / 前端原型。
- Vercel Chatbot / AI SDK 的 Next.js Chat UI 方向。
- LangChain Agent Chat UI 的 LangGraph Chat 接入方式。
- opencode 的 agent mode / permission 设计参考。
- 本轮与用户确认的 Synthia 产品逻辑。
