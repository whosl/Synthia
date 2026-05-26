# Synthia / EdAgent-Vivado Next Architecture Specification

> 本文档是 EdAgent-Vivado 后续开发的黄金参考（source of truth）。所有 session 记忆、后台任务、React 前端、SSE 实时通信、多 Agent 协作、监控观测、错误知识库沉淀等功能，应以本文档定义的长期架构为准。

配套维护文档：

- `VIVADO_COMMANDS.md`：按 Vivado Runtime Adapter 分层维护需要支持的 Vivado 命令矩阵、TclPolicy 分级、模板、parser/monitor 要求与实现优先级。

## 0. Synthia 工业软件 Agent 平台定位

### 0.1 一句话定位

Synthia 是面向芯片开发与工业软件流程的 **Agentic EDA Control Plane**：它复用现有 Agent Harness、Context Builder、SSE Timeline、审批、监控、知识库与审计底座，通过统一的 Industrial Tool Connector Layer 接入 Vivado 等 EDA/工业软件，实现受控执行、结构化解析、流程审计、人工审批和企业知识沉淀。

第一阶段的产品形态是 **Synthia + Vivado Connector**；长期形态是 **Synthia Industrial Tool Agent Platform**。Vivado 是第一个 connector，而不是 Agent Core 的硬编码依赖。

### 0.2 与现有 Synthia Harness 的关系

本规范不要求推倒重写现有系统。Synthia 当前已经具备的能力应继续作为平台底座：

- Project / Session / Task / Run / Event / Artifact 数据模型。
- LangGraph Agent Harness、Context Builder、Memory、KB、Semantic Retrieval。
- SSE 事件流、Timeline Chat、ToolCall 可视化和断线恢复。
- Approval / HITL、Stop、Monitor、Problem Collector、Token/Cost Collector。
- Vivado Runtime Adapter、remote/local/mock 执行、path mapping、file sync、artifact capture。

新的 Industrial Tool Connector Layer 是在这些能力之上补齐工业软件抽象边界：

```text
Synthia Web Console / CLI / WorkBuddy / VS Code
        ↓
Synthia API
        ↓
Synthia Agent Harness
        ↓
Tool Capability Selector
        ↓
Industrial Tool Connector Layer
        ↓
Vivado / Verilator / Yosys / ISE / VCS / DC / PrimeTime / 自研工具
        ↓
Controlled Execution + Artifact Capture + Structured Reports + Audit
```

### 0.3 核心架构判断

Synthia 的核心不是“LLM + Vivado 聊天机器人”，而是：

```text
LLM + Agent Harness + Industrial Tool Connector + Controlled Execution
    + Structured Reports + Human Approval + Knowledge / Monitor / Audit
```

因此：

1. **Agent Core 不直接依赖 Vivado**  
   Agent Core 只能看到 connector capability，例如 `run_synthesis`、`run_implementation`、`parse_timing_summary`、`propose_patch`。Vivado Tcl、batch command、remote SSH、report 文件布局等细节由 connector 封装。

2. **LLM 不裸生成工业软件脚本**  
   LLM 只能选择 capability 和参数；Connector 使用受控模板、参数 schema、policy guard 渲染 Tcl/script。任何绕过模板的 Tcl/script 注入都必须经过显式策略与审批。

3. **报告结构化优先于日志原文**  
   原始 log/rpt 是 artifact；供 Agent 和 UI 消费的权威数据应是 ParsedReport、Problem、ToolErrorSummary、RunMetrics、KnowledgeCase。

4. **聊天入口继续保留，但产品心智是控制台**  
   Terminal/Timeline Chat 是自然语言操作入口和审计时间线，不是普通 chatbot。Project、Run、Report、Patch Approval、Monitor 页面构成 Synthia Control Plane。

5. **Vivado Runtime Adapter 升级为 Vivado Connector 的执行内核**  
   现有 Vivado Runner、remote SSH、mock、path mapper、file sync、Tcl policy 不废弃；它们被 Vivado Connector 包装为标准 capability。

### 0.4 平台边界与扩展目标

Synthia 的长期 connector 目标包括但不限于：

- FPGA / EDA：Vivado、ISE、XSim、Verilator、Yosys、ABC。
- ASIC EDA：VCS、Design Compiler、PrimeTime、Formality、SpyGlass。
- 工业软件：MATLAB、ADS、Virtuoso、COMSOL、Ansys、自研加固/TMR 工具。

所有新工具必须通过统一 Connector SDK 接入，禁止在 Agent Core 中新增某个工具的特殊执行分支。

### 0.5 分层命名

后续文档和代码命名应优先使用以下平台层次：

- **Synthia Web Console**：React 控制台，包含 Project、Session、Run、Report、Approval、Monitor、Timeline Chat。
- **Synthia API**：FastAPI 层，对 Web、CLI、WorkBuddy、VS Code、外部系统提供统一接口。
- **Synthia Agent Harness**：Planner、Context Builder、LangGraph、Memory、Diagnosis、Patch Proposal、Approval Controller。
- **Synthia Connector SDK**：ToolConnector、Capability、Manifest、PreparedRun、ToolRunResult、Artifact、Parser、Policy。
- **Industrial Tool Connector**：Vivado Connector、VCS Connector、DC Connector 等具体实现。
- **Controlled Execution**：命令白名单、路径隔离、超时、stop、资源限制、日志捕获、artifact capture、audit。
- **Storage / Knowledge / Monitor**：Run、Step、ToolCall、Artifact、ParsedReport、Problem、KB、Usage、Trace。

---

## 1. 目标与原则

### 1.1 总目标

EdAgent-Vivado 应从“单 Agent 终端聊天 + Vivado 工具调用”演进为一个可持久运行、可追踪、可恢复、可扩展到多 Agent 协作的 EDA Agent 平台。

系统必须支持：

- project -> sessions 两层工作流：Project 是工程级容器，Session 是某个 Project 下的一次调试/问答/执行会话。
- session 内完整记忆管理，不丢上下文。
- 页面关闭、刷新、断线后，后台 agent/task 继续运行。
- 用户重新进入 session 后，可恢复完整聊天记录、reasoning、tool call、partial response、状态与执行轨迹。
- React/Vite/TypeScript 前端统一接管 terminal、monitor、KB 等页面。
- 用户可停止正在运行的任务，partial response 必须保存。
- 多 Agent 协作通过统一事件、文件 channel 和 SSE 通信扩展。
- 监控模块强制采集 run/tool/LLM/Vivado/problem/token/cost 数据，而不是依赖 LLM 自觉上报。
- 错误知识库支持从 run 中自动沉淀 candidate，经审核后进入用户 KB。
- 上下文构建必须通过 Context Builder、Error KB、语义知识库、向量检索、rerank、上下文审计共同保证，而不是依赖模型“自然记住”。
- Vivado 必须通过统一 Runtime Adapter 支持所有 Tcl/batch/project/non-project/interactive 命令能力，并纳入 stop、监控、问题收集、知识沉淀和 artifact 管理。

### 1.2 架构原则

1. **持久化优先**  
   所有影响用户体验、agent 上下文、可审计性的状态都必须持久化。

2. **事件驱动**  
   project、session、task、agent、tool、Vivado、KB candidate、monitor 都以统一事件流连接。

3. **强制观测**  
   harness/tool wrapper 层必须强制记录事实数据；LLM 只负责摘要、归纳和解释，不负责原始事实采集。

4. **SSE 统一实时通道**  
   单 Agent、多 Agent、terminal UI、monitor timeline 均以 SSE 为主要实时事件通道。

5. **UI 状态可重建**  
   前端 UI 不应依赖浏览器内存保存关键状态；刷新后应从数据库事件与消息重建。

6. **多 Agent 原生预留**  
   数据模型、事件协议、artifact、channel、monitor trace 均应从一开始支持 `agent_id`、`run_id`、`task_id`、`channel_id`。

7. **审核式知识沉淀**  
   自动发现问题和生成 KB candidate，但知识入库必须有 pending/approved/rejected/merged 工作流。

8. **可扩展 provider 与模型角色**  
   主模型、摘要模型、多 Agent 模型、未来 embedding/rerank 模型都应通过统一 provider adapter 管理 usage/cost。

9. **显式上下文注入**  
   每次 LLM 调用前必须生成可审计的 context package，记录注入了哪些 session memory、project context、Error KB、Semantic KB、tool summary、problem summary，以及每部分 token 占比、裁剪原因与可信度。

10. **Vivado 执行抽象**  
    Agent 不应直接拼接 SSH/Vivado 命令。所有 Vivado 操作必须通过 Vivado Runtime Adapter、FileSync、PathMapper、TclPolicy、ObservedToolRunner 统一执行。

11. **Project 上下文先行**  
    用户必须先创建 Project，确认项目根目录、Synthia YAML、Vivado `.xpr`、器件与 Vivado 创建项目所需配置；Session 创建时只填写 session 名称，并继承 Project 的路径、器件、KB、Vivado target、path mapping 与历史经验。

---

## 2. 核心概念模型

### 2.1 Project

Project 是用户可见的工程级长期容器，位于 Session 之上。

一个 Project 代表一个可由 Synthia 理解并可由 Vivado 执行的设计工程。Project 必须绑定：

- 项目根目录 `root_path`。
- Synthia 可读的项目 YAML / manifest 路径 `manifest_path`。
- Vivado `.xpr` 路径 `xpr_path`。
- Vivado 创建/打开项目所需的器件信息，例如 `part` 或 `board_part`。
- 顶层模块、目标语言、仿真器、RTL/XDC/Tcl 路径集合等项目配置。
- 默认 Vivado target、path mapping、file sync 策略。

约束：

- Project 必须先于 Session 创建。
- `root_path`、`manifest_path`、`xpr_path` 三者必须指向同一个工程边界；`manifest_path` 与 `xpr_path` 应位于 `root_path` 下，或可被 path mapping 证明属于同一工程。
- Project 创建时后端必须校验 `root_path`、`manifest_path`、`xpr_path` 的存在性与一致性；前端只负责收集路径和配置，不以浏览器状态作为权威。
- Project 可编辑路径和配置，但 Session 必须保存创建时的 project snapshot，避免历史会话因 Project 后续修改而语义漂移。
- Project 可归档/删除，并维护 session count、problem count、last active、默认 target health 等摘要。

Project 共享：

- Project KB 与 retrieval profile。
- 默认 Vivado target、path mapping、FileSync 记录。
- 历史 run/session summary。
- 项目级 artifacts、reports、Vivado command history。
- Project context 注入策略。

### 2.2 Session

Session 是某个 Project 下的长期会话容器。Session 不直接要求用户重新选择 manifest、器件、Vivado target 或路径信息；这些都从所属 Project 继承。

一个 session 包含：

- 所属 `project_id`。
- 创建时的 project snapshot，包括 root/manifest/xpr/part/top/target 等关键字段。
- 用户和 assistant 消息。
- 多次 task/run。
- 完整事件流。
- 长期记忆与摘要。
- artifacts。
- agent/channel 文件通信空间。
- monitor 统计。
- KB candidate 来源记录。

### 2.3 Task

Task 是一次由用户消息触发的后台 agent 执行。

约束：

- 同一 session 同一时间只能有一个 active task。
- 如果 session 已有 active task，新消息请求必须被拒绝，并返回当前 task 状态。
- task 可进入 `running`、`stopping`、`stopped`、`done`、`error` 状态。
- stop 后 partial assistant response 必须保存，标记 `stopped=true`。

### 2.4 Run

Run 是可观测执行单元，使用统一模型，通过 `run_type` 区分：

- `task`：一次用户消息触发的 agent 后台任务。
- `agent`：某个 agent 的一次执行。
- `llm`：一次模型调用。
- `tool`：一次 tool call。
- `eda`：一次 Vivado synth/impl/sim。
- `summary`：一次摘要模型调用。
- `kb_generation`：一次 KB candidate 生成。
- `multi_agent_handoff`：一次 agent handoff 或协作子任务。

Run 可以嵌套：

```text
project
  session
    task_run
      agent_run
        llm_run
        tool_run
          eda_run
        summary_run
```

### 2.5 Event

Event 是 UI、监控、重连和审计的统一事实流。

所有事件必须具备：

- `id`
- `project_id`
- `seq`
- `session_id`
- `task_id`
- `run_id`
- `event_type`
- `timestamp`
- `agent_id`
- `payload`

`seq` 在 session 内单调递增，用于 SSE reconnect：

```http
GET /api/sessions/{session_id}/events?after_seq=123
GET /api/sessions/{session_id}/stream?after_seq=123
```

### 2.6 Message

Message 是 LLM 上下文和用户可读聊天历史的核心数据。

消息类型：

- `user`
- `assistant`
- `system`
- `tool_summary`
- `memory_summary`
- `agent_handoff`

Reasoning 原文不默认进入 LLM 上下文；tool 原始输出不直接进入上下文。它们通过摘要或结构化 summary 进入上下文。

### 2.7 Artifact

Artifact 是大内容、文件、patch、报告、日志、tool 原始输入输出等实体。

数据库只保存 artifact 元数据、摘要、路径、hash、MIME/type。大内容保存到 artifact store。

### 2.8 Channel

Channel 是未来多 Agent 文件通信的基础抽象。

每个 session 可包含：

```text
channels/
  shared/
  agents/
    {agent_id}/
      inbox/
      outbox/
  handoffs/
  reports/
```

Channel 支持：

- Agent 写入消息。
- Agent 读取共享状态。
- Supervisor 进行 handoff。
- Monitor 记录谁写入了什么文件、何时写入、由哪个 run 触发。

### 2.9 Error KB 与 Semantic Knowledge Base

系统区分但统一检索：

- **Error KB**：结构化 Vivado/EDA 错误案例，包含 pattern、signature、category、likely causes、suggested actions、repro steps、fix patch、Vivado/FPGA/project metadata。
- **Semantic Knowledge Base**：向量化知识库，包含仓库文档、SPEC、README、Vivado 文档、本地 PDF、历史 run 总结、历史 session 总结、用户上传文档、RTL/约束/脚本源码、项目经验。

统一检索入口应同时返回：

- regex/signature 匹配结果。
- 向量相似度结果。
- rerank 后结果。
- 权威度/可信度评分。
- 来源信息。
- token budget 建议。

---

## 3. 持久化与存储设计

### 3.1 存储选择

长期目标采用 SQLite 作为核心元数据与事件存储。

同时保留文件 artifact store，用于：

- Vivado log/report。
- patch/diff。
- 大型 tool input/output。
- reasoning 原文快照。
- agent channel 文件。
- exported run bundle。

### 3.2 运行时目录

建议默认运行时目录：

```text
.edagent/
  edagent.db
  artifacts/
    projects/
      {project_id}/
        manifests/
        vivado/
        reports/
        logs/
        kb/
    sessions/
      {session_id}/
        tasks/
        runs/
        tool_calls/
        vivado/
        patches/
        reports/
        logs/
        reasoning/
        channels/
  archives/
    projects/
    sessions/
```

运行时目录可由环境变量配置：

```text
EDAGENT_RUNTIME_DIR
EDAGENT_DB_PATH
EDAGENT_ARTIFACT_ROOT
```

### 3.3 数据库表草案

#### projects

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  root_path TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  xpr_path TEXT NOT NULL,
  part TEXT,
  board_part TEXT,
  top_module TEXT,
  target_language TEXT,
  simulator TEXT,
  source_globs_json TEXT,
  constraint_globs_json TEXT,
  tcl_globs_json TEXT,
  default_vivado_target_id TEXT,
  default_path_mapping_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  deleted_at INTEGER,
  session_count INTEGER NOT NULL DEFAULT 0,
  run_count INTEGER NOT NULL DEFAULT 0,
  problem_count INTEGER NOT NULL DEFAULT 0,
  last_active_at INTEGER,
  metadata_json TEXT
);
```

Project 创建时必须进行后端校验：

- `root_path` 必须存在且为目录。
- `manifest_path` 必须存在且可被 Synthia 解析。
- `xpr_path` 必须存在且为 Vivado `.xpr` 文件。
- `manifest_path` 与 `xpr_path` 必须位于 `root_path` 下，或通过 path mapping / metadata 明确绑定到同一工程。
- `part` 或 `board_part` 至少提供一个；其余 Vivado 创建项目参数可选但应尽量结构化保存。

#### sessions

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  deleted_at INTEGER,
  last_message_preview TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  task_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  problem_count INTEGER NOT NULL DEFAULT 0,
  token_input INTEGER NOT NULL DEFAULT 0,
  token_output INTEGER NOT NULL DEFAULT 0,
  total_cost REAL,
  project_snapshot_json TEXT,
  metadata_json TEXT
);
```

`project_snapshot_json` 保存 session 创建时的 Project 关键配置快照，例如 `root_path`、`manifest_path`、`xpr_path`、`part`、`board_part`、`top_module`、`default_vivado_target_id`、path mapping 等。Project 后续修改不应改变历史 session 的语义。

#### tasks

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_message_id TEXT,
  state TEXT NOT NULL,
  stop_requested INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT,
  active_run_id TEXT,
  metadata_json TEXT
);
```

#### messages

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT NOT NULL,
  task_id TEXT,
  agent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  content_summary TEXT,
  stopped INTEGER NOT NULL DEFAULT 0,
  partial INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  token_input INTEGER,
  token_output INTEGER,
  metadata_json TEXT
);
```

#### events

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  parent_run_id TEXT,
  agent_id TEXT,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  artifact_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  UNIQUE(session_id, seq)
);
```

#### runs

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT,
  task_id TEXT,
  parent_run_id TEXT,
  agent_id TEXT,
  run_type TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  elapsed_ms INTEGER,
  error TEXT,
  input_summary TEXT,
  output_summary TEXT,
  artifact_id TEXT,
  metadata_json TEXT
);
```

#### tool_calls

```sql
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  run_id TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  tool_name TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  elapsed_ms INTEGER,
  input_summary TEXT,
  output_summary TEXT,
  input_artifact_id TEXT,
  output_artifact_id TEXT,
  error TEXT,
  metadata_json TEXT
);
```

#### llm_usage

```sql
CREATE TABLE llm_usage (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  run_id TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  provider TEXT,
  model TEXT NOT NULL,
  model_role TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  total_tokens INTEGER,
  cost_input REAL,
  cost_output REAL,
  cost_total REAL,
  usage_source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata_json TEXT
);
```

`model_role` 包括：

- `primary`
- `summary`
- `sub_agent`
- `kb_generation`
- `embedding`
- `rerank`

`usage_source` 包括：

- `provider`
- `estimated`
- `unknown`

#### artifacts

```sql
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT,
  task_id TEXT,
  run_id TEXT,
  artifact_type TEXT NOT NULL,
  path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  summary TEXT,
  created_at INTEGER NOT NULL,
  metadata_json TEXT
);
```

#### memory_snapshots

```sql
CREATE TABLE memory_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT NOT NULL,
  task_id TEXT,
  summary TEXT NOT NULL,
  summary_model TEXT,
  source_message_until TEXT,
  source_event_until_seq INTEGER,
  created_at INTEGER NOT NULL,
  metadata_json TEXT
);
```

#### problems

```sql
CREATE TABLE problems (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT,
  task_id TEXT,
  run_id TEXT,
  source TEXT NOT NULL,
  severity TEXT,
  category TEXT,
  signature TEXT,
  normalized_signature TEXT,
  message TEXT NOT NULL,
  raw_excerpt_artifact_id TEXT,
  detected_at INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolution_summary TEXT,
  metadata_json TEXT
);
```

#### kb_cases

用户扩展 KB：

```sql
CREATE TABLE kb_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  scope TEXT NOT NULL DEFAULT 'project',
  pattern TEXT NOT NULL,
  normalized_signature TEXT,
  category TEXT NOT NULL,
  likely_causes_json TEXT NOT NULL,
  suggested_actions_json TEXT NOT NULL,
  repro_steps TEXT,
  fix_patch_artifact_id TEXT,
  vivado_version TEXT,
  fpga_part TEXT,
  top_module TEXT,
  manifest_artifact_id TEXT,
  verified_resolution INTEGER NOT NULL DEFAULT 0,
  source_candidate_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT
);
```

#### kb_candidates

```sql
CREATE TABLE kb_candidates (
  id TEXT PRIMARY KEY,
  source_project_id TEXT,
  source_run_id TEXT,
  source_session_id TEXT,
  source_problem_id TEXT,
  pattern TEXT NOT NULL,
  normalized_signature TEXT,
  category TEXT,
  message_ids_json TEXT,
  raw_log_excerpt_artifact_id TEXT,
  likely_causes_json TEXT NOT NULL,
  suggested_actions_json TEXT NOT NULL,
  repro_steps TEXT,
  fix_patch_artifact_id TEXT,
  vivado_version TEXT,
  fpga_part TEXT,
  top_module TEXT,
  manifest_artifact_id TEXT,
  resolved INTEGER,
  resolution_summary TEXT,
  confidence REAL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT,
  merged_into_case_id TEXT,
  metadata_json TEXT
);
```

Candidate 状态：

- `pending`
- `approved`
- `rejected`
- `merged`

#### knowledge_sources

```sql
CREATE TABLE knowledge_sources (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  project_id TEXT,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  uri TEXT,
  path TEXT,
  authority_score REAL NOT NULL DEFAULT 0.5,
  trust_score REAL NOT NULL DEFAULT 0.5,
  version TEXT,
  sha256 TEXT,
  indexed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT
);
```

`scope`：

- `global`
- `project`

`source_type`：

- `repo_markdown`
- `spec`
- `vivado_doc`
- `pdf`
- `run_summary`
- `session_summary`
- `user_upload`
- `rtl`
- `constraint`
- `script`
- `kb_case`
- `artifact`

#### knowledge_chunks

```sql
CREATE TABLE knowledge_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  project_id TEXT,
  chunk_index INTEGER NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  content_summary TEXT,
  token_count INTEGER,
  start_offset INTEGER,
  end_offset INTEGER,
  sha256 TEXT,
  authority_score REAL NOT NULL DEFAULT 0.5,
  trust_score REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT
);
```

#### knowledge_embeddings

向量存储通过接口抽象，不绑定具体数据库。SQLite 仅保存 embedding 元数据与索引状态；实际向量可存储于 sqlite-vec/sqlite-vss、Chroma、Qdrant、LanceDB 或其他实现。

```sql
CREATE TABLE knowledge_embeddings (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER,
  vector_store TEXT NOT NULL,
  vector_ref TEXT NOT NULL,
  indexed_at INTEGER NOT NULL,
  metadata_json TEXT
);
```

#### retrieval_audits

```sql
CREATE TABLE retrieval_audits (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT,
  task_id TEXT,
  run_id TEXT,
  agent_id TEXT,
  query TEXT NOT NULL,
  rewritten_query TEXT,
  intent_json TEXT,
  filters_json TEXT,
  candidate_count INTEGER,
  selected_count INTEGER,
  rejected_count INTEGER,
  token_budget INTEGER,
  token_used INTEGER,
  created_at INTEGER NOT NULL,
  metadata_json TEXT
);
```

#### retrieval_audit_items

```sql
CREATE TABLE retrieval_audit_items (
  id TEXT PRIMARY KEY,
  retrieval_audit_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  chunk_id TEXT,
  kb_case_id TEXT,
  problem_id TEXT,
  artifact_id TEXT,
  title TEXT,
  excerpt TEXT,
  vector_score REAL,
  rerank_score REAL,
  authority_score REAL,
  trust_score REAL,
  final_score REAL,
  selected INTEGER NOT NULL,
  rejection_reason TEXT,
  token_count INTEGER,
  metadata_json TEXT
);
```

#### context_packages

每次 LLM 调用前必须持久化 context package，用于证明模型实际收到了哪些上下文。

```sql
CREATE TABLE context_packages (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  agent_id TEXT,
  model TEXT,
  max_context_tokens INTEGER,
  total_tokens INTEGER,
  system_tokens INTEGER,
  question_tokens INTEGER,
  memory_tokens INTEGER,
  recent_message_tokens INTEGER,
  project_context_tokens INTEGER,
  error_kb_tokens INTEGER,
  semantic_kb_tokens INTEGER,
  tool_summary_tokens INTEGER,
  problem_summary_tokens INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  artifact_id TEXT,
  metadata_json TEXT
);
```

#### context_package_items

```sql
CREATE TABLE context_package_items (
  id TEXT PRIMARY KEY,
  context_package_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  source_id TEXT,
  source_type TEXT,
  title TEXT,
  content_summary TEXT,
  token_count INTEGER,
  priority INTEGER NOT NULL,
  included INTEGER NOT NULL,
  truncation_reason TEXT,
  authority_score REAL,
  trust_score REAL,
  relevance_score REAL,
  metadata_json TEXT
);
```

#### channels

```sql
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata_json TEXT,
  UNIQUE(session_id, name)
);
```

#### channel_messages

```sql
CREATE TABLE channel_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  from_agent_id TEXT,
  to_agent_id TEXT,
  message_type TEXT NOT NULL,
  content TEXT,
  artifact_id TEXT,
  created_at INTEGER NOT NULL,
  metadata_json TEXT
);
```

#### vivado_targets

```sql
CREATE TABLE vivado_targets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_type TEXT NOT NULL,
  host TEXT,
  ssh_user TEXT,
  ssh_key_path TEXT,
  vivado_path TEXT NOT NULL,
  settings_path TEXT,
  remote_work_root TEXT,
  vivado_version TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT
);
```

`target_type`：

- `local`
- `remote_ssh`

#### vivado_sessions

Long-lived Vivado Tcl sessions:

```sql
CREATE TABLE vivado_sessions (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  task_id TEXT,
  run_id TEXT,
  state TEXT NOT NULL,
  mode TEXT NOT NULL,
  remote_pid INTEGER,
  local_pid INTEGER,
  started_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  idle_timeout_sec INTEGER,
  work_dir TEXT,
  log_artifact_id TEXT,
  error TEXT,
  metadata_json TEXT
);
```

`mode`：

- `batch`
- `tcl`
- `project`
- `non_project`

#### vivado_commands

```sql
CREATE TABLE vivado_commands (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  vivado_session_id TEXT,
  session_id TEXT,
  task_id TEXT,
  run_id TEXT,
  command_type TEXT NOT NULL,
  command_text TEXT,
  script_artifact_id TEXT,
  project_id TEXT,
  work_dir TEXT,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  elapsed_ms INTEGER,
  exit_code INTEGER,
  log_artifact_id TEXT,
  stdout_artifact_id TEXT,
  stderr_artifact_id TEXT,
  parsed_summary_json TEXT,
  problem_count INTEGER NOT NULL DEFAULT 0,
  stopped INTEGER NOT NULL DEFAULT 0,
  killed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  metadata_json TEXT
);
```

`command_type`：

- `raw_tcl`
- `script`
- `flow`
- `query`
- `project_open`
- `project_create`
- `interactive`

#### file_sync_records

```sql
CREATE TABLE file_sync_records (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  task_id TEXT,
  run_id TEXT,
  local_path TEXT,
  remote_path TEXT,
  direction TEXT NOT NULL,
  method TEXT NOT NULL,
  sha256 TEXT,
  size_bytes INTEGER,
  state TEXT NOT NULL,
  synced_at INTEGER NOT NULL,
  metadata_json TEXT
);
```

`direction`：

- `upload`
- `download`

`method`：

- `scp`
- `sftp`
- `rsync`
- `local_copy`

#### path_mappings

```sql
CREATE TABLE path_mappings (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  project_id TEXT,
  local_root TEXT NOT NULL,
  remote_root TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata_json TEXT
);
```

### 3.4 删除与归档

Project 删除语义：

- 默认归档 Project，不物理删除数据。
- Project 归档后，其下 Session 默认仍可只读查看；是否允许继续运行新 task 由 UI/API 明确禁止。
- Project hard delete 必须显式确认，并级联删除其 sessions、events、runs、artifacts、channels、project KB 绑定记录和 Vivado workspace 记录。

API：

```http
DELETE /api/projects/{project_id}
DELETE /api/projects/{project_id}?hard=true
```

Session 删除语义：

- 默认归档，不物理删除数据。
- 支持 hard delete。

API：

```http
DELETE /api/sessions/{session_id}
DELETE /api/sessions/{session_id}?hard=true
```

默认归档时：

- `sessions.archived_at` 写入时间。
- artifacts 可移动到 `.edagent/archives/sessions/{session_id}` 或保留原路径并标记 archived。

Hard delete 时：

- 删除数据库中该 session 关联记录。
- 删除 artifact 目录。
- 删除 channel 文件。

### 3.5 旧 Session 迁移到 Project

现有单层 Session 必须迁移到 Project -> Sessions 两层模型。迁移策略采用自动归并：

1. 优先从 session metadata、历史 task request、context package、manifest_path、Vivado xpr/path mapping 中提取项目路径信息。
2. 按规范化后的 `root_path`、`manifest_path`、`xpr_path` 聚类生成或匹配 Project。
3. 对每个可识别的历史 Session 写入 `project_id` 和 `project_snapshot_json`。
4. 如果同一 Session 可匹配多个 Project，标记为 `migration_conflict`，需要用户在 Project 管理 UI 中手动选择。
5. 长期不保留无 Project 的普通 Session；迁移完成后，新建 Session API 必须要求 project scope。

迁移过程不得丢失历史 events/messages/runs/artifacts；旧 `manifest_path` request 字段仅作为迁移兼容字段保留。

---

## 4. 记忆管理设计

### 4.1 记忆目标

Agent 在 session 内不得忘记上下文。服务重启后也应恢复可用上下文。

系统应保存：

- user 消息。
- assistant 消息，包括 stopped partial response。
- tool 调用摘要。
- 关键 Vivado/log/report 结果摘要。
- session memory summary。
- agent handoff summary。
- KB/problem summary。
- reasoning 原文事件与摘要。

### 4.2 上下文构造

每次 agent 执行前，构造模型输入：

```text
System Prompt
Session Memory Summary
Project / Manifest Context
Recent User/Assistant Messages
Matched Error KB
Retrieved Semantic Knowledge
Relevant Tool Summaries
Relevant Problems / KB Matches
Current User Question
```

Context Builder 是唯一负责构造 LLM 输入上下文的模块。任何 agent 调用模型前都必须通过 Context Builder 生成 context package，并写入 `context_packages` 与 `context_package_items`。

上下文注入优先级：

```text
1 current user question
2 system prompt
3 project context
4 session memory summary
5 recent conversation
6 active problem / matched Error KB
7 relevant tool summaries
8 semantic Knowledge Base snippets
```

当 token budget 不足时，应按优先级裁剪，并在 context audit 中记录被裁剪项与原因。

### 4.3 Reasoning 策略

Reasoning 原文：

- 保存为 event。
- 可保存到 artifact。
- 默认不直接注入 LLM 上下文。

Reasoning 摘要：

- 可由摘要模型生成。
- 可写入 memory snapshot。
- 可在 UI 默认折叠显示。

### 4.4 Tool 结果策略

Tool 原始输入输出：

- 保存 artifact。
- 记录裁剪后的 input/output summary。
- 超长内容必须截断、脱敏、落盘。

Tool 摘要：

- 进入消息上下文或 memory。
- 包含工具名、状态、关键发现、artifact 链接、问题签名。

### 4.5 摘要模型接口

需要预留次级模型摘要接口：

```python
class SummaryModel:
    async def summarize_session(...)
    async def summarize_tool_result(...)
    async def summarize_reasoning(...)
    async def generate_kb_candidate(...)
```

摘要模型应记录：

- provider
- model
- input/output token
- cost
- source run
- summary artifact/message

### 4.6 长上下文裁剪

上下文策略：

- 保留最近 N 轮完整消息。
- 保留关键 tool/EDA 摘要。
- 使用 session memory summary 压缩长期历史。
- 根据任务类型检索相关 KB/problem/artifact summary。
- 不将大 log、完整 tool output、完整 reasoning 直接塞入模型。

### 4.7 上下文审计

每次 LLM 调用必须记录：

- 注入了哪些 session memory。
- 注入了哪些 recent messages。
- 注入了哪些 project context。
- 注入了哪些 Error KB。
- 注入了哪些 Semantic KB snippets。
- 注入了哪些 tool summaries。
- 每部分 token 数。
- 每个知识片段的来源、相关度、权威度、可信度。
- 哪些候选被裁剪，裁剪原因。

Monitor run detail 和 Terminal debug panel 都应可查看 context audit。

---

## 5. 后台任务与 Stop 设计

### 5.1 Task 生命周期

状态机：

```text
created -> running -> done
                 \-> stopping -> stopped
                 \-> error
```

### 5.2 并发约束

同一 session 只能有一个 active task。

如果用户在 active task 期间发送新消息：

```json
{
  "error": "session_task_running",
  "session_id": "...",
  "task_id": "...",
  "state": "running"
}
```

### 5.3 Stop API

Session 级：

```http
POST /api/sessions/{session_id}/stop
```

Task 级：

```http
POST /api/tasks/{task_id}/stop
```

响应：

```json
{
  "ok": true,
  "session_id": "...",
  "task_id": "...",
  "state": "stopping"
}
```

### 5.4 Stop 语义

Stop 必须：

- 标记 `stop_requested=true`。
- 尽力取消 LLM/agent 后续执行。
- 当前已启动 tool 进入安全停止流程。
- 不丢弃已产生事件。
- 保存 partial assistant response，标记：

```json
{
  "role": "assistant",
  "partial": true,
  "stopped": true
}
```

Vivado/SSH/subprocess 强制终止能力应纳入 harness lifecycle 管理：

- 每个外部命令必须有 process handle 或 remote job handle。
- Stop 时触发 graceful stop。
- 超时后可 escalated kill。
- 所有 stop/kill 行为必须记录事件和 monitor run。

### 5.5 Vivado Job Stop

Vivado job stop 必须由 Vivado Runtime Adapter 执行：

1. 标记 command/session stop requested。
2. 对 interactive Tcl session 尝试发送 Ctrl-C/SIGINT。
3. 对 batch process 尝试 graceful terminate。
4. 超时后 kill 本地 PID 或远程 PID。
5. 远程 SSH target 必须能查询并 kill Vivado 进程。
6. Stop/kill/stdout/stderr/log tail 必须写入事件和 artifacts。

事件：

```text
vivado.stop_requested
vivado.interrupt_sent
vivado.terminate_sent
vivado.kill_sent
vivado.stopped
vivado.killed
vivado.stop_error
```

---

## 6. SSE 实时通信协议

### 6.1 统一使用 SSE

系统统一使用 SSE 承载：

- terminal 实时输出。
- session event reconnect。
- monitor timeline。
- 多 Agent 通信事件展示。
- channel/file communication viewer 更新。

### 6.2 事件读取 API

历史事件：

```http
GET /api/sessions/{session_id}/events?after_seq=0&limit=500
```

实时事件：

```http
GET /api/sessions/{session_id}/stream?after_seq=0
```

全局 monitor stream：

```http
GET /api/monitor/stream?after_event_id=...
```

Run stream：

```http
GET /api/monitor/runs/{run_id}/stream?after_seq=...
```

### 6.3 SSE 格式

```text
id: {session_id}:{seq}
event: {event_type}
data: {"id":"...","seq":123,"payload":{...}}
```

### 6.4 Reconnect

前端必须记录最后处理的 `seq`。断线后：

1. 调用 `/events?after_seq=last_seq` 补齐。
2. 重新连接 `/stream?after_seq=latest_seq`。
3. UI 根据事件 reducer 重建状态。

### 6.5 事件类型

核心事件：

```text
session.created
session.updated
session.archived

task.created
task.started
task.stopping
task.stopped
task.done
task.error

run.started
run.completed
run.error

message.user.created
message.assistant.delta
message.assistant.completed
message.assistant.stopped
message.assistant.snapshot

assistant.stream.opened
assistant.stream.completed

reasoning.delta
reasoning.summary

tool.started
tool.delta
tool.completed
tool.error

interaction.requested
interaction.approved
interaction.rejected
interaction.responded

agent.started
agent.completed
agent.message
agent.handoff
agent.continuation
channel.message.created

llm.started
llm.usage
llm.completed
llm.error

eda.started
eda.log
eda.problem_detected
eda.completed
eda.error

vivado.target.checked
vivado.session.started
vivado.session.ready
vivado.session.idle_timeout
vivado.session.closed
vivado.command.started
vivado.command.stdout
vivado.command.stderr
vivado.command.log
vivado.command.completed
vivado.command.error
vivado.command.stopped
vivado.file.uploaded
vivado.file.downloaded
vivado.path.mapped

vivado.stop_requested
vivado.interrupt_sent
vivado.terminate_sent
vivado.kill_sent
vivado.stopped
vivado.killed
vivado.stop_error

problem.detected
kb.candidate.created
kb.candidate.updated

context.package.created
memory.updated
artifact.created
```

事件载荷约定：

- `message.assistant.delta` 必须携带 `stream_id`，与同一 `assistant.stream.opened` 关联，便于在 tool call 之间分段渲染。
- `message.assistant.snapshot` 是每个 stream 段完成时写入的纯文本快照，确保断线后能从事件流端到端重建 UI（即使 `messages` 表里尚未落 `assistant` 行）。
- `agent.continuation` 由 harness 在 HITL approval 之后启动下一轮 LLM 时发出，载荷必须包含 `reason` 与裁剪后的 `approval_output`。
- `kb.candidate.updated` 用于审批/合并后通知前端刷新。
- 所有 `vivado.stop_*` 事件必须由 Vivado Runtime Adapter 按发生顺序发出，并写入 `vivado_commands.killed/stopped` 字段。

### 6.6 协议版本协商

后端在 `/api/v1/events/protocol` 暴露：

```json
{
  "protocol_version": 2,
  "wire_event_types": ["session.created", "..."]
}
```

前端在初始化时必须读取并据此校验事件 reducer 注册的事件集；遇到未知事件类型必须降级到 generic timeline，不得崩溃。每次新增/重命名事件类型，必须同时：

1. 更新 `src/edagent_vivado/events/catalog.py`。
2. 提升 `PROTOCOL_VERSION`。
3. 同步 `frontend/src/lib/events/catalog.ts`。

### 6.7 Interaction Protocol

HITL 交互是 chat/tool stream 的独立子通道。事件类型：

```text
interaction.requested
interaction.approved
interaction.rejected
interaction.responded
```

`interaction.requested.payload` 必须包含：

- `id`（interaction id，hex12 即可）
- `interaction_id`（同 id，向前兼容）
- `interaction_type`：`approval` 或 `input_request`
- `session_id`, `task_id`
- `title`, `message`, `reason`
- `status`：`pending|approved|rejected|responded`
- `created_at`
- `files?`：`[{path, content, description, action: create|modify|delete}]`
- `fields?`：`[{id, label, field_type: text|select|search_select, options?, placeholder, recommendations?, required}]`

约束：

- 同一 task 同一时刻最多保留一个 pending 的 approval interaction；多个 file 创建/修改请求必须由 harness 自动 batch 到同一 approval。
- agent 主动发起的 HITL 必须通过工具：`request_approval(title, message, files?, fields?)` 和 `request_user_input(title, message, fields)`。
- interaction 状态必须由 events 表重放可恢复；服务重启或前端刷新后，pending interaction 都能再次拉取（`GET /api/v1/sessions/{sid}/interactions` 必须能 rehydrate）。
- 用户拒绝后，工具返回值必须包含 `edagent_outcome=user_rejected`（见 §8.5）。

---

## 7. API Specification

### 7.1 Project API

```http
GET    /api/projects
POST   /api/projects
GET    /api/projects/{project_id}
PATCH  /api/projects/{project_id}
DELETE /api/projects/{project_id}
GET    /api/projects/{project_id}/sessions
```

Create project:

```json
{
  "name": "uart_full",
  "root_path": "examples/uart_full",
  "manifest_path": "examples/uart_full/eda.yaml",
  "xpr_path": "examples/uart_full/vivado/uart_full.xpr",
  "part": "xc7a35tcpg236-1",
  "board_part": null,
  "top_module": "uart_top",
  "target_language": "Verilog",
  "simulator": "xsim",
  "source_globs": ["rtl/**/*.v", "rtl/**/*.sv"],
  "constraint_globs": ["constraints/**/*.xdc"],
  "tcl_globs": ["scripts/**/*.tcl"],
  "default_vivado_target_id": "...",
  "metadata": {}
}
```

List response:

```json
{
  "projects": [
    {
      "id": "...",
      "name": "...",
      "status": "active|archived|error",
      "root_path": "...",
      "manifest_path": "...",
      "xpr_path": "...",
      "part": "...",
      "board_part": null,
      "top_module": "...",
      "created_at": 123,
      "updated_at": 456,
      "last_active_at": 456,
      "session_count": 12,
      "run_count": 33,
      "problem_count": 2,
      "default_vivado_target_id": "..."
    }
  ]
}
```

Project path validation:

- Backend validates `root_path` exists.
- Backend validates `manifest_path` exists and is parseable by Synthia.
- Backend validates `xpr_path` exists and is a Vivado project file.
- Backend validates `manifest_path` and `xpr_path` belong to the same `root_path`.
- Backend validates at least one of `part` or `board_part`.

### 7.2 Session API

Sessions are always created under a Project.

```http
POST   /api/projects/{project_id}/sessions
GET    /api/projects/{project_id}/sessions
GET    /api/sessions/{session_id}
PATCH  /api/sessions/{session_id}
DELETE /api/sessions/{session_id}
```

Create session:

```json
{
  "name": "Timing debug",
  "metadata": {}
}
```

Session creation copies the current Project configuration into `project_snapshot_json`. The user should not be asked for manifest, xpr, part, top module, Vivado target, or path mapping during normal session creation.

Global session listing may remain for search and migration support:

```http
GET /api/sessions?project_id=...&status=...
```

List response:

```json
{
  "sessions": [
    {
      "id": "...",
      "project_id": "...",
      "name": "...",
      "status": "idle|running|stopping|stopped|error|archived",
      "created_at": 123,
      "updated_at": 456,
      "message_count": 12,
      "tool_call_count": 8,
      "problem_count": 2,
      "token_input": 1000,
      "token_output": 500,
      "last_message_preview": "..."
    }
  ]
}
```

### 7.3 Message API

```http
GET /api/sessions/{session_id}/messages
```

Supports pagination:

```http
GET /api/sessions/{session_id}/messages?before=...&limit=100
```

### 7.4 Chat / Task API

Start task:

```http
POST /api/sessions/{session_id}/tasks
```

Request:

```json
{
  "question": "...",
  "agent_mode": "single|multi",
  "metadata": {}
}
```

Task execution uses the Session's `project_id` and `project_snapshot_json`; request-level `manifest_path` is **deprecated as of v1**. New clients must not send it. The server should:

- Silently ignore `manifest_path` when `project_snapshot_json` is non-empty.
- Log a `migration.manifest_path_used` event when an old client still sends it, so we can plan removal.
- Reject the field outright once the migration window closes (target: next minor release after the Phase 1F frontend refactor lands).

Vivado tools (`run_vivado_*_tool`) must not accept `manifest_path` as an LLM-controlled argument. The harness layer resolves manifest/top/part from `project_snapshot_json` before invoking the adapter; the tool signature only carries Vivado-specific parameters (e.g. `directive`, `target_id`).

Response:

```json
{
  "task_id": "...",
  "session_id": "...",
  "state": "running",
  "stream_url": "/api/sessions/{session_id}/stream?after_seq=..."
}
```

Task status:

```http
GET /api/tasks/{task_id}
GET /api/sessions/{session_id}/active-task
```

Stop:

```http
POST /api/tasks/{task_id}/stop
POST /api/sessions/{session_id}/stop
```

### 7.5 Event API

```http
GET /api/sessions/{session_id}/events
GET /api/sessions/{session_id}/stream
```

### 7.6 Approval API

Patch approval and Vivado-execution auto-approval are first-class settings:

```http
GET  /api/settings/approvals
GET  /api/settings/patch-approval
POST /api/settings/patch-approval
GET  /api/settings/vivado-approval
POST /api/settings/vivado-approval
```

Response:

```json
{ "approved": true }
```

Both flags must be **persisted** (SQLite `settings` table) so they survive process restart and are shared across uvicorn workers; in-memory module globals are not acceptable.

#### 7.6.A Approval-request schema (LLM contract)

Every Vivado / file-mutating tool must include a JSON-encoded `approval_request` argument so the UI can render an approval card. The body is a **JSON string** (no markdown fences). Schema:

```json
{
  "reason": "Why this operation is needed; what was already checked",
  "action": "One-line summary of what will happen",
  "manifest_path": "examples/.../eda.yaml",
  "tcl_command": "only for run_vivado_tcl_tool",
  "script": "only for run_vivado_script_tool",
  "target_id": "optional Vivado target id",
  "files": [
    { "path": "...", "action": "create|modify|delete", "description": "..." }
  ]
}
```

Rules:

- Empty fields must be omitted, not stringified as empty.
- The LLM must not put free-form prose in `details` / `message` / `说明` — executable content goes in `tcl_command`, `script`, `manifest_path`, or `files`.
- The frontend renders the dict as flat key/value rows in a fixed display order; unknown keys go to a generic section.

### 7.7 Monitor API

Phase 1 APIs:

```http
GET /api/monitor/runs
GET /api/monitor/runs/{run_id}
GET /api/monitor/runs/{run_id}/toolcalls
GET /api/monitor/runs/{run_id}/usage
GET /api/monitor/sessions/{session_id}/runs
```

Full monitor APIs:

```http
GET /api/monitor/runs/{run_id}/events
GET /api/monitor/runs/{run_id}/artifacts
GET /api/monitor/runs/{run_id}/problems
GET /api/monitor/runs/{run_id}/stream
GET /api/monitor/toolcalls
GET /api/monitor/usage
GET /api/monitor/problems
GET /api/monitor/agents
GET /api/monitor/channels
GET /api/monitor/stream
```

### 7.8 KB API

Read built-in and user KB:

```http
GET /api/kb/cases
GET /api/kb/cases/{case_id}
```

Candidate workflow:

```http
GET   /api/kb/candidates
POST  /api/kb/candidates
GET   /api/kb/candidates/{id}
PATCH /api/kb/candidates/{id}
POST  /api/kb/candidates/{id}/approve
POST  /api/kb/candidates/{id}/reject
POST  /api/kb/candidates/{id}/merge
```

Generate candidate from run/problem:

```http
POST /api/monitor/runs/{run_id}/kb-candidates
POST /api/monitor/problems/{problem_id}/kb-candidates
```

### 7.9 Semantic Knowledge Base API

知识库分为全局知识库和项目知识库：

```http
GET    /api/knowledge/sources
POST   /api/knowledge/sources
GET    /api/knowledge/sources/{source_id}
PATCH  /api/knowledge/sources/{source_id}
DELETE /api/knowledge/sources/{source_id}

POST   /api/knowledge/sources/{source_id}/reindex
POST   /api/knowledge/reindex

GET    /api/knowledge/chunks
GET    /api/knowledge/chunks/{chunk_id}

POST   /api/knowledge/search
POST   /api/knowledge/error-search
POST   /api/knowledge/context-preview

GET    /api/knowledge/retrieval-audits/{audit_id}
GET    /api/monitor/runs/{run_id}/context
```

Search request:

```json
{
  "query": "...",
  "scope": "global|project|both",
  "project_id": "...",
  "top_k": 12,
  "filters": {
    "source_type": ["vivado_doc", "run_summary", "rtl"],
    "fpga_part": "...",
    "tool": "vivado",
    "category": "timing"
  },
  "use_query_rewrite": true,
  "use_rerank": true,
  "min_score": 0.3
}
```

Search response:

```json
{
  "audit_id": "...",
  "results": [
    {
      "source_type": "doc|kb|run|session|artifact|rtl|constraint",
      "source_id": "...",
      "chunk_id": "...",
      "title": "...",
      "path": "...",
      "excerpt": "...",
      "vector_score": 0.82,
      "rerank_score": 0.76,
      "authority_score": 0.9,
      "trust_score": 0.85,
      "final_score": 0.8
    }
  ]
}
```

### 7.10 Artifact API

```http
GET /api/artifacts/{artifact_id}
GET /api/artifacts/{artifact_id}/download
GET /api/sessions/{session_id}/artifacts
```

### 7.11 Multi-Agent / Channel API

```http
GET  /api/sessions/{session_id}/agents
GET  /api/sessions/{session_id}/channels
POST /api/sessions/{session_id}/channels
GET  /api/channels/{channel_id}/messages
POST /api/channels/{channel_id}/messages
```

### 7.12 Vivado Runtime API

Targets:

```http
GET    /api/vivado/targets
POST   /api/vivado/targets
GET    /api/vivado/targets/{target_id}
PATCH  /api/vivado/targets/{target_id}
DELETE /api/vivado/targets/{target_id}
POST   /api/vivado/targets/{target_id}/health
GET    /api/health/vivado
```

Commands:

```http
POST /api/vivado/commands/tcl
POST /api/vivado/commands/script
POST /api/vivado/commands/flow
POST /api/vivado/commands/query
GET  /api/vivado/commands/{command_id}
POST /api/vivado/commands/{command_id}/stop
GET  /api/vivado/commands/{command_id}/log
GET  /api/vivado/commands/{command_id}/artifacts
```

Long-lived sessions:

```http
POST /api/vivado/sessions
GET  /api/vivado/sessions
GET  /api/vivado/sessions/{vivado_session_id}
POST /api/vivado/sessions/{vivado_session_id}/command
POST /api/vivado/sessions/{vivado_session_id}/stop
DELETE /api/vivado/sessions/{vivado_session_id}
```

File sync:

```http
POST /api/vivado/sync/upload
POST /api/vivado/sync/download
GET  /api/vivado/sync/records
```

Example Tcl request:

```json
{
  "target_id": "default-remote",
  "session_id": "...",
  "task_id": "...",
  "project_id": "uart_full",
  "mode": "batch|interactive",
  "command": "report_timing_summary -file timing.rpt",
  "approval_token": "..."
}
```

Example flow request:

```json
{
  "target_id": "default-remote",
  "project_id": "uart_full",
  "session_id": "...",
  "task_id": "...",
  "flow": "synth|impl|sim|bitstream|report|ip",
  "options": {
    "reports": ["timing", "utilization", "drc", "methodology"]
  }
}
```

Vivado flow requests resolve manifest/xpr/top/part from Project configuration or the Session project snapshot. Request-level manifest/top/part overrides should require explicit debug mode and be recorded in event metadata.

---

## 8. Agent 与 LangGraph 集成

### 8.1 Checkpointer

Agent graph 必须使用持久化 checkpointer。

目标：

- 服务重启后恢复 LangGraph thread state。
- 与产品级 `messages/events` 双轨保存。
- 允许根据 session/task/thread_id 查询状态。

### 8.2 Thread ID

Thread ID 应稳定映射到 session：

```text
thread_id = session:{session_id}
```

Multi-agent 可扩展：

```text
thread_id = session:{session_id}:agent:{agent_id}
```

### 8.3 Agent 输入

Agent 不应直接读取全部数据库事件。应通过 ContextBuilder 生成上下文：

```python
class AgentContextBuilder:
    async def build(session_id, task_id, question) -> AgentContext:
        ...
```

ContextBuilder 负责：

- 读取 memory summary。
- 读取 recent messages。
- 读取相关 tool summary。
- 读取 project/manifest context。
- 注入 relevant KB/problem。
- 调用 Error KB 与 Semantic Knowledge Base 统一检索。
- 执行 query rewrite、intent detection、entity extraction、rerank。
- 计算知识片段相关度、权威度、可信度。
- 控制 token budget。
- 写入 context package 与 retrieval audit。

### 8.3.1 Context Builder Pipeline

```text
User Question
  -> intent detection
  -> entity extraction
  -> query rewrite
  -> Error KB regex/signature search
  -> Semantic KB vector search
  -> metadata filtering
  -> rerank
  -> authority/trust scoring
  -> token budgeting
  -> context package assembly
  -> context audit persistence
  -> LLM call
```

语义识别必须覆盖：

- 向量相似度检索。
- query rewrite。
- rerank。
- intent detection。
- entity extraction。
- error code / Vivado message ID 识别。
- top module、FPGA part、文件路径、约束名、tool name 识别。

### 8.3.2 Knowledge Injection Tools

除 Context Builder 自动注入外，agent 和多 Agent 均可主动调用知识库工具：

```python
search_knowledge_base(query: str, filters: dict | None = None) -> str
search_error_kb(error_signature: str, context: dict | None = None) -> str
```

工具返回必须包含来源、相关度、权威度、可信度、artifact/source id。Agent 回答时应优先基于高可信来源。

### 8.5 Tool Outcome Envelope

Every tool that may surface in the chat timeline must return a JSON document with the following stable fields, so the agent (and the UI) can mechanically distinguish user rejection from execution failure from success:

```json
{
  "edagent_outcome": "user_rejected | execution_failed | execution_succeeded | approved | partially_approved | timeout | queued",
  "summary": "Human-readable one-line summary",
  "scope": "vivado_synth | vivado_impl | vivado_tcl | vivado_script | vivado_flow | file_changes | input_request",
  "ran": true,
  "success": true,
  "error": "optional structured error",
  "...": "extra scope-specific fields"
}
```

Required semantics:

| `edagent_outcome` | `ran` | `success` | Agent must |
|---|---|---|---|
| `user_rejected` | false | false | Treat as "step skipped". Never report this as a Vivado/synth/impl failure. Ask the user what to do next. |
| `execution_failed` | true | false | Diagnose from logs/reports — this is a real tool failure. |
| `execution_succeeded` | true | true | Use the result normally. |
| `approved` / `partially_approved` | true | true | Continue; applied paths are on disk. |
| `timeout` | true | false | Re-check whether the tool should be retried with longer timeout or alternative path. |
| `queued` | false | — | File change has been batched into a pending approval; user has not seen it yet. Do not surface as a final answer. |

`scope` values are open-set but must be drawn from the constants in `harness/approval_outcomes.py`. The system prompt must teach the agent to read `edagent_outcome` strictly; any natural-language interpretation of the tool body is forbidden when an `edagent_outcome` field is present.

### 8.4 Tool 包装器

所有 tool 必须通过统一 wrapper 运行：

```python
class ObservedToolRunner:
    async def run(tool_name, args, context):
        emit(tool.started)
        create_run(run_type="tool")
        try:
            result = await call_tool(...)
            collect_problem_if_any(...)
            summarize_result(...)
            emit(tool.completed)
        except Exception:
            emit(tool.error)
            record_problem(source="tool_exception")
            raise
```

---

## 9. Harness 强制观测模块

### 9.1 原则

Problem detection 必须在 harness/tool/parser 层强制采集，不依赖 LLM 自觉。

采集来源：

- Vivado log parser 解析 errors/critical warnings。
- tool call 异常。
- command_runner/subprocess 失败。
- remote_runner/SSH 失败。
- timing/utilization/parser 异常。
- patch apply/test 失败。
- 用户手动标记。
- agent/sub-agent 上报 problem event。
- 多 Agent handoff 失败或 channel 协议异常。

### 9.2 Harness Event Sink

所有 harness 模块应接受统一 context：

```python
@dataclass
class RunContext:
    session_id: str
    task_id: str
    run_id: str
    agent_id: str | None
    event_sink: EventSink
    artifact_store: ArtifactStore
    problem_collector: ProblemCollector
```

### 9.3 Problem Collector

ProblemCollector 负责：

- 从 log summary 提取问题。
- 生成 normalized signature。
- 做 KB match。
- 写入 `problems` 表。
- 触发 `problem.detected` event。
- 触发 KB candidate generation policy。

### 9.4 Token 与 Cost Collector

每次 LLM 调用必须记录 usage：

- provider 返回 usage 时采用 provider usage。
- provider 未返回时可标记 unknown。
- 支持 estimated usage。
- 支持多 provider adapter。

Cost 必须支持：

- 主模型。
- 摘要模型。
- sub-agent 模型。
- KB generation 模型。
- embedding/rerank 模型。

模型单价通过配置管理：

```yaml
models:
  deepseek-v4-flash:
    input_per_1m: 0.0
    output_per_1m: 0.0
  glm-5-turbo:
    input_per_1m: 0.0
    output_per_1m: 0.0
```

### 9.5 Trace / Span 模型

内部 run model 应兼容 trace/span：

- `run_id`
- `parent_run_id`
- `run_type`
- `started_at`
- `finished_at`
- `attributes`
- `events`
- `status`

未来可导出到 LangSmith 或 OpenTelemetry。

---

## 9A. Vivado Runtime Adapter

### 9A.1 目标

Vivado Runtime Adapter 是所有 Vivado 执行能力的唯一入口。它必须支持：

- 任意 Vivado Tcl 命令。
- 完整 Tcl script。
- batch 模式。
- interactive Tcl session。
- project mode。
- non-project mode。
- 常用高级 flow：synth、impl、sim、bitstream、report、IP。
- 本地 Vivado。
- 远程 SSH Vivado。
- 文件同步。
- 路径映射。
- Stop/kill。
- SSE 实时 log。
- harness 强制 problem collection。
- monitor/toolcall/run/usage/artifact 记录。

### 9A.2 默认远程 Target

当前默认远程 Vivado target：

```text
SSH: ssh -i E:/dev/id_192.168.31.150 root@192.168.31.150
Vivado: /home/xilinx/vivado/Vivado/2022.1/bin/vivado
Settings: /home/xilinx/vivado/Vivado/2022.1/settings64.sh
Remote work root: /tmp/edagent_remote
```

`.env`：

```text
VIVADO_REMOTE_HOST=root@192.168.31.150
VIVADO_REMOTE_KEY=E:/dev/id_192.168.31.150
VIVADO_REMOTE_PATH=/home/xilinx/vivado/Vivado/2022.1/bin/vivado
VIVADO_REMOTE_ENV=/home/xilinx/vivado/Vivado/2022.1/settings64.sh
VIVADO_REMOTE_WORK=/tmp/edagent_remote
```

Manual command equivalent:

```bash
ssh -i E:/dev/id_192.168.31.150 root@192.168.31.150
source /home/xilinx/vivado/Vivado/2022.1/settings64.sh
vivado -mode batch -source your_script
```

This target must be represented as a configurable `vivado_target`, not hard-coded.

### 9A.3 Execution Layers

Runtime Adapter exposes layered APIs:

```text
Raw Tcl Command
  -> Tcl Script Runner
  -> Vivado Batch Job
  -> High-level EDA Flow
  -> Long-lived Tcl Session
```

Agent tools may use any layer, but all layers must pass through:

- TclPolicy.
- Approval gate.
- ObservedToolRunner.
- EventSink.
- ArtifactStore.
- ProblemCollector.
- VivadoTarget.

### 9A.4 Local and Remote Executors

Executors:

```python
class VivadoExecutor:
    async def run_batch(script: VivadoScript, ctx: RunContext) -> VivadoResult: ...
    async def run_tcl(command: str, ctx: RunContext) -> VivadoResult: ...
    async def open_session(ctx: RunContext) -> VivadoSession: ...
```

Remote execution must be abstracted:

```python
class RemoteExecutor:
    async def run(command: str, cwd: str | None, env: dict) -> RemoteResult: ...
    async def upload(local: str, remote: str) -> None: ...
    async def download(remote: str, local: str) -> None: ...
    async def kill(pid: int) -> None: ...
```

Supported implementations:

- command-line ssh/scp.
- paramiko SSH/SFTP.
- local subprocess.

System must support local/remote auto selection based on target configuration.

### 9A.5 Remote Directory Layout

Remote work root:

```text
/tmp/edagent_remote/
  projects/
    {project_id}/
      sources/
      constraints/
      scripts/
      runs/
        {run_id}/
          run.tcl
          vivado.log
          reports/
          artifacts/
```

Each project has a stable remote workspace. Each run has an isolated run directory.

### 9A.6 FileSync

FileSync must support multiple strategies:

- scp.
- SFTP.
- rsync.
- hash-based incremental sync.
- local copy.

Interface:

```python
class FileSync:
    async def sync_project(manifest, target, project_id) -> SyncResult: ...
    async def upload(local_path, remote_path) -> SyncRecord: ...
    async def download(remote_path, local_path) -> SyncRecord: ...
```

Requirements:

- Use sha256/hash to avoid unnecessary uploads.
- Record all sync operations in `file_sync_records`.
- Emit SSE events for upload/download.
- Download logs/reports/patches into artifact store.

### 9A.7 PathMapper

PathMapper maps local Windows paths to remote Linux paths and back.

Requirements:

- Manifest paths must be normalized and mapped before Tcl generation.
- Tcl scripts must use remote paths.
- Tool output/log paths must be mapped back to local artifact references when displayed.
- Path mappings must be stored in `path_mappings`.

Example:

```text
Local:  E:\dev\edagent-vivado\examples\uart_full
Remote: /tmp/edagent_remote/projects/uart_full
```

### 9A.8 Tcl Policy and Approval

Supporting all Vivado commands does not mean blindly executing unsafe Tcl.

Policy must include:

- allowlist for known Vivado commands.
- denylist for dangerous Tcl/system commands.
- approval requirement for raw Tcl.
- approval requirement for dangerous file operations.
- script artifact saving before execution.

Dangerous patterns include:

```text
exec
file delete
file rename
open "|"
rm -rf
shutdown
```

Policy result:

```json
{
  "allowed": false,
  "requires_approval": true,
  "reason": "raw_tcl_contains_exec",
  "matched_rules": ["deny_exec"]
}
```

### 9A.9 Tcl Script Generation

Long-term strategy:

- Prefer templates for common flows.
- LLM fills parameters and explains intent.
- Raw Tcl requires approval.
- Every generated Tcl script is saved as artifact.
- Script text is included in monitor run detail.
- Script summary enters context memory/tool summary.

Templates must cover:

- synth.
- impl.
- sim.
- timing report.
- utilization report.
- power report.
- DRC report.
- methodology report.
- bitstream generation.
- IP generation.

### 9A.10 Project and Non-Project Mode

Both project and non-project mode must be supported.

Manifest decides default mode, but user/agent may request either mode.

Non-project example:

```tcl
read_verilog ...
read_xdc ...
synth_design -top ... -part ...
report_timing_summary -file ...
```

Project mode example:

```tcl
create_project ...
add_files ...
add_files -fileset constrs_1 ...
launch_runs synth_1
wait_on_run synth_1
open_run synth_1
report_timing_summary -file ...
```

### 9A.11 Long-lived Vivado Tcl Session

System must support long-lived Vivado Tcl sessions locally and remotely:

```bash
source /home/xilinx/vivado/Vivado/2022.1/settings64.sh
vivado -mode tcl
```

Requirements:

- Per project session recommended.
- Configurable idle timeout.
- Prompt detection.
- Command timeout.
- stdout/stderr/log capture.
- Stop/interruption.
- Session cleanup.
- State recorded in `vivado_sessions`.

### 9A.12 Command Output and Parsing

Every Vivado command must:

- Save full log as artifact.
- Stream selected stdout/log lines through SSE.
- Parse errors, critical warnings, warnings, message IDs.
- Feed parsed problems into ProblemCollector.
- Generate tool summary.
- Generate run summary.
- Optionally generate KB candidate on failure.

### 9A.13 Vivado Health Check

Health check must validate:

- SSH connectivity.
- SSH key readability.
- remote settings64.sh exists.
- remote vivado path exists.
- remote work directory writable.
- Vivado version.
- license availability if detectable.
- local Vivado availability for local targets.

APIs:

```http
GET /api/health/vivado
POST /api/vivado/targets/{target_id}/health
```

CLI:

```bash
edagent vivado health
```

### 9A.14 Multi-target and Multi-version

System must support:

- multiple remote hosts.
- multiple Vivado versions.
- local and remote targets.
- default target.
- session/project target selection.

Current `192.168.31.150` Vivado 2022.1 target is the default target, not the only target.

### 9A.15 Agent Tools

Agent-facing tools:

```python
vivado_run_tcl(command: str, target_id: str | None = None, mode: str = "batch")
vivado_run_script(script: str, target_id: str | None = None, mode: str = "batch")
vivado_run_flow(flow: str, options: dict, target_id: str | None = None)
vivado_open_project(project_path: str, target_id: str | None = None)
vivado_create_project(options: dict, target_id: str | None = None)
vivado_query(command: str, target_id: str | None = None)
```

All tools must return structured summaries with artifact references.

### 9A.16 CLI

CLI must include:

```bash
edagent vivado tcl
edagent vivado script
edagent vivado health
edagent vivado session
edagent vivado targets
```

Existing CLI flows should be implemented on top of Vivado Runtime Adapter:

```bash
edagent run-synth
edagent run-impl
edagent run-sim
```

### 9A.17 Vivado Context Injection

Vivado command summaries should enter session context:

- failed command summary.
- successful QoR/report summary.
- timing/utilization/power/drc/methodology summaries.
- command script summary.
- relevant artifacts.

Raw full logs stay as artifacts and are retrieved only when needed.

---

## 9B. Synthia Connector SDK 与 Industrial Tool Connector Layer

### 9B.1 目标

Industrial Tool Connector Layer 是 Synthia 从 Vivado 单点 Agent 升级为工业软件 Agent 平台的核心边界。它负责把 Agent Harness 的抽象意图转化为具体工业软件的受控执行，并把工业软件输出转化为结构化、可审计、可复用的数据。

Connector 必须承担：

- 工具环境探测、版本识别、license/可达性检查。
- 通用 manifest 与工具专用 manifest 扩展校验。
- capability 声明、参数 schema、风险等级、审批要求。
- Tcl/script/command 生成与策略校验。
- 调用 Controlled Execution 执行命令。
- stdout/stderr/log/rpt/checkpoint/bitstream/waveform 等 artifact 采集。
- Timing、Utilization、DRC、Methodology、Power、Area、Simulation 等报告解析。
- 错误分类、Problem 生成、KB candidate 生成信号。
- 为 Context Builder 提供结构化 tool environment、parsed report、artifact index 与 error summary。

### 9B.2 包结构

Connector SDK 在 Synthia 代码库内具有稳定边界，后续可独立发布为工具连接包。推荐结构：

```text
src/edagent_vivado/connectors/
  base/
    connector.py
    capability.py
    manifest.py
    request.py
    execution.py
    artifact.py
    parser.py
    policy.py
    registry.py

  vivado/
    connector.py
    manifest.py
    capabilities.py
    environment.py
    runner_adapter.py
    tcl_renderer.py
    artifact_collector.py
    parsers/
      timing_summary.py
      utilization.py
      drc.py
      methodology.py
      vivado_log.py
      xsim_log.py
    templates/
      synth.tcl.j2
      impl.tcl.j2
      bitstream.tcl.j2
      report_only.tcl.j2
    error_rules/
      synth_errors.yaml
      impl_errors.yaml
      timing_rules.yaml
      drc_rules.yaml

  verilator/
  yosys/
  ise/
  vcs/
  design_compiler/
  primetime/
```

代码可以保留 `edagent_vivado` 包名以兼容现有工程，但架构边界必须以 `connectors/base` 和具体 connector 子包为准。

### 9B.3 ToolConnector 基础接口

所有工业软件 connector 必须实现同一语义接口：

```python
class ToolConnector(Protocol):
    connector_id: str
    tool_name: str
    supported_versions: list[str]

    def detect_environment(self) -> ToolEnvironment: ...

    def list_capabilities(self) -> list[ToolCapability]: ...

    def validate_manifest(self, manifest: ToolManifest) -> ValidationResult: ...

    def prepare_run(self, request: ToolRunRequest) -> PreparedRun: ...

    def execute(self, prepared_run: PreparedRun) -> ToolRunResult: ...

    def collect_artifacts(self, result: ToolRunResult) -> list[Artifact]: ...

    def parse_artifacts(self, result: ToolRunResult) -> ParsedReportBundle: ...

    def classify_error(self, result: ToolRunResult) -> ToolErrorSummary: ...
```

接口约束：

- `prepare_run()` 只生成受控执行计划、脚本、参数与预期 artifact，不执行真实工具。
- `execute()` 必须通过 Controlled Execution / ObservedToolRunner，不得直接裸调 `subprocess`。
- `parse_artifacts()` 输出必须可落库、可版本化、可进入 Context Builder。
- `classify_error()` 必须输出 machine-readable signature、severity、stage、likely_causes、suggested_actions。

### 9B.4 ToolCapability 模型

Capability 是 Agent Core 可选择的最小工具能力单元。

```json
{
  "connector_id": "vivado",
  "capability_id": "run_synthesis",
  "display_name": "Vivado Synthesis",
  "stage": "synth",
  "input_schema": { "top": "string", "part": "string", "strategy": "string" },
  "outputs": ["vivado_log", "timing_summary", "utilization", "drc", "post_synth_dcp"],
  "risk_level": "low",
  "requires_approval": false,
  "supports_stop": true,
  "supports_mock": true,
  "produces_reports": true,
  "produces_patch": false
}
```

Capability 必须声明参数 schema、默认值、stage、run/step 映射、风险等级、审批要求、artifact 类型、parser 输出类型、stop/mock/remote 支持状态，以及是否允许 Agent 请求该 capability。

### 9B.5 Tool Manifest 抽象

Synthia Manifest 是跨工具通用工程描述，允许每个 connector 提供专用扩展字段。Agent prompt 不应持有分散的工程配置，Context Builder 应从 manifest、Project、Run 和 Connector Environment 生成权威上下文。

通用字段：

```yaml
project:
  name: uart_demo
  root: /workspace/projects/uart_demo
  type: fpga

tool:
  connector: vivado
  version: "2022.1"
  mode: batch

source:
  rtl:
    - rtl/uart_rx.v
    - rtl/uart_tx.v
    - rtl/uart_top.v
  constraints:
    - constrs/arty.xdc

design:
  top: uart_top
  part: xc7a35ticsg324-1L
  board_part: null

flow:
  stages:
    - synth
    - impl
    - report
```

Vivado 扩展字段：

```yaml
vivado:
  strategy:
    synth: Flow_PerfOptimized_high
    impl: Performance_Explore
  reports:
    timing_summary: true
    utilization: true
    drc: true
    methodology: true
  bitstream:
    enabled: false
  execution:
    target_id: remote_192_168_31_150
    max_threads: 8
```

ASIC 工具可添加独立扩展，例如 `design_compiler.target_library`、`design_compiler.link_library`、`design_compiler.sdc`。

### 9B.6 Vivado Connector 能力矩阵

Vivado Connector 是第一个标准 connector，必须以现有 Vivado Runtime Adapter 为执行内核，并向 Agent Harness 暴露统一 capability。

第一等级能力：

- `detect_environment`
- `validate_project`
- `run_synthesis`
- `run_implementation`
- `run_simulation`
- `report_timing_summary`
- `report_utilization`
- `report_drc`
- `report_methodology`
- `parse_vivado_log`
- `classify_vivado_error`

第二等级能力：

- `elaborate_design`
- `opt_design`
- `place_design`
- `route_design`
- `write_bitstream`
- `report_power`
- `report_clock_interaction`
- `report_cdc`
- `open_checkpoint_report_only`
- `compare_runs`

第三等级能力：

- `long_lived_tcl_session`
- `interactive_query`
- `incremental_compile`
- `strategy_sweep`
- `timing_fix_suggestion`
- `xdc_patch_proposal`
- `rtl_patch_proposal`

Vivado 标准 stage：

```text
validate -> elaborate -> synth -> opt -> place -> route -> bitstream -> report -> diagnose -> patch_proposal -> rerun
```

每个 stage 必须创建 Step 记录，并关联 command、artifact、parsed report、problem、usage 与 event。

### 9B.7 Tcl/script 模板与策略

LLM 不能直接生成任意 Tcl。Vivado Connector 使用 Jinja2 或等价模板系统渲染受控 Tcl。

模板允许参数：`top`、`part`、`board_part`、`rtl_files`、`xdc_files`、`tcl_files`、`work_dir`、`report_dir`、`checkpoint_dir`、`strategy`、`max_threads`、`reports`。

模板禁止任意 `exec`、任意 `source` 未审批脚本、访问 project root / run workspace 之外路径、删除或覆盖非 run workspace 文件、网络命令、权限命令、系统破坏命令。

TclPolicy 必须输出：

```json
{
  "policy_result": "allowed | needs_approval | denied",
  "risk_level": "low | medium | high | critical",
  "reasons": ["uses approved synth template", "writes only run checkpoint dir"],
  "blocked_tokens": []
}
```

### 9B.8 Controlled Execution 合同

所有 connector 执行都必须通过 Controlled Execution。执行请求使用结构化 argv，而不是 shell 字符串。

```json
{
  "command_id": "cmd_001",
  "run_id": "run_001",
  "step_id": "step_synth",
  "connector_id": "vivado",
  "capability_id": "run_synthesis",
  "executable": "vivado",
  "args": ["-mode", "batch", "-source", "generated_tcl/synth.tcl"],
  "cwd": "workspace/runs/run_001",
  "timeout_sec": 3600,
  "env_profile": "vivado_2022_1_remote",
  "allowed_paths": ["workspace/projects/uart_demo", "workspace/runs/run_001"],
  "capture_stdout": true,
  "capture_stderr": true
}
```

禁止 Agent 或 connector 绕过该合同直接执行 shell。对于 remote Vivado，SSH/SCP 也必须被建模为受控 executor 能力，并记录 host、key alias、remote workdir、path mapping、upload/download artifact。

### 9B.9 Run Workspace 与 Artifact Layout

每次 run 必须使用独立目录：

```text
workspace/
  projects/
    uart_demo/
      eda.yaml
      rtl/
      constrs/

  runs/
    run_20260526_001/
      input_snapshot/
      generated_tcl/
      logs/
      reports/
      checkpoints/
      bitstreams/
      artifacts/
      patches/
      parsed/
      audit/
```

原工程目录只读输入；所有生成物进入 run workspace。Patch 必须先生成 proposal 和 diff，经审批后才写回工程资产。

### 9B.10 ParsedReport 标准模型

Connector parser 输出统一 ParsedReportBundle。ParsedReport 必须可被 Report UI、Context Builder、Monitor、History Compare、KB candidate 和 Evolution signal 复用。

Timing Summary：

```json
{
  "type": "timing_summary",
  "tool": "vivado",
  "stage": "synth",
  "wns": -0.238,
  "tns": -12.431,
  "whs": 0.051,
  "ths": 0.0,
  "failing_endpoints": 17,
  "worst_paths": [
    {"slack": -0.238, "from": "u_core/reg_a", "to": "u_core/reg_b", "clock": "clk", "path_group": "clk"}
  ]
}
```

Utilization：

```json
{
  "type": "utilization",
  "tool": "vivado",
  "stage": "synth",
  "lut": 18231,
  "ff": 24990,
  "bram": 12,
  "dsp": 8,
  "io": 42,
  "lut_percent": 31.4,
  "ff_percent": 21.7
}
```

DRC：

```json
{
  "type": "drc",
  "tool": "vivado",
  "stage": "impl",
  "errors": [
    {"rule": "NSTD-1", "severity": "error", "message": "Unspecified I/O Standard", "objects": ["uart_tx", "uart_rx"], "suggested_action": "Add IOSTANDARD constraint in XDC"}
  ],
  "warnings": []
}
```

### 9B.11 Agent Harness 集成

Agent Planner 的输出必须从“直接工具调用”升级为 capability plan：

```json
{
  "task_id": "task_001",
  "plan": [
    {"step": "validate_manifest", "connector": "vivado", "capability": "validate_project"},
    {"step": "run_synthesis", "connector": "vivado", "capability": "run_synthesis"},
    {"step": "parse_reports", "connector": "vivado", "capability": "parse_artifacts"},
    {"step": "diagnose", "agent": "diagnosis_agent"}
  ]
}
```

Tool Capability Selector 负责根据 manifest、project target、tool availability、user task、policy、approval state 选择 connector/capability。Agent Core 不应知道 Vivado 命令行参数、Tcl 模板文件名、远程目录细节。

### 9B.12 Context Builder 集成

Context Builder 必须支持 connector-aware context blocks：

- `connector_environment_context`
- `capability_context`
- `manifest_context`
- `current_run_steps_context`
- `parsed_report_context`
- `artifact_index_context`
- `tool_error_summary_context`
- `policy_context`
- `similar_problem_context`
- `knowledge_context`

优先级：当前用户任务与当前 run 状态、当前失败 stage/ToolErrorSummary/Problem、Manifest 与 connector environment、ParsedReport 摘要、最近 run 对比、相似 KB/Semantic KB 案例、按需检索的原始日志片段。

### 9B.13 API 扩展

Connector API 必须提供给 Web、CLI、WorkBuddy、VS Code 使用：

```text
GET  /api/v1/connectors
GET  /api/v1/connectors/{connector_id}
GET  /api/v1/connectors/{connector_id}/capabilities
POST /api/v1/projects/{project_id}/tasks
GET  /api/v1/tasks/{task_id}/plan
GET  /api/v1/runs/{run_id}/steps
GET  /api/v1/runs/{run_id}/artifacts
GET  /api/v1/runs/{run_id}/reports
GET  /api/v1/runs/{run_id}/problems
POST /api/v1/runs/{run_id}/rerun
POST /api/v1/approvals/{approval_id}/approve
POST /api/v1/approvals/{approval_id}/reject
```

所有实时状态、日志片段、tool event、多 Agent event 继续通过 SSE 传输；不引入 WebSocket 作为主通道。

### 9B.14 前端控制台要求

Synthia Web Console 必须把聊天入口与控制台视图结合，而不是二选一。

核心页面：Projects、Run / Timeline、Reports、Patch Approval、History Compare、Connectors、Monitor。

Timeline Chat 继续作为自然语言入口：用户可以说“跑综合并分析失败原因”，系统生成 task、plan、run、steps，并把所有事件投射到 timeline。

### 9B.15 WorkBuddy / Skill 接入

WorkBuddy Skill 不直接访问 Vivado、不直接执行 SSH、不直接写工程文件。Skill 只做入口包装：识别用户意图、定位 Synthia Project / manifest、调用 Synthia API 创建 Task、订阅或轮询任务结果、汇总返回并提供打开 Synthia Run 页面的链接。

推荐 skill 能力：`synthia-run-synth`、`synthia-run-impl`、`synthia-debug-timing`、`synthia-debug-drc`、`synthia-export-report`、`synthia-review-patch`。

### 9B.16 多工具扩展流程

新增工业软件 connector 的标准流程：manifest 扩展 schema、`ToolConnector`、capabilities、script/templates、artifact collector、report/log parsers、error classifier、policy/approval、Context Builder、Report UI/Monitor/KB candidate。

Agent Core 不因新增工具而新增硬编码执行分支。

### 9B.17 Connector 级风险与审批

| 风险等级 | 示例 | 策略 |
| --- | --- | --- |
| Low | 读取 report、运行综合、解析日志 | 可按项目策略自动批准 |
| Medium | 修改 XDC、修改 Tcl 参数、切换策略 | 需要审批或项目策略授权 |
| High | 修改 RTL、覆盖工程文件、生成 bitstream | 必须审批 |
| Critical | 非白名单命令、工程外路径、危险系统命令 | 禁止 |

PatchProposal 必须关联 `run_id`、`step_id`、`problem_id`、`connector_id`、`capability_id`、`target_file`、`patch_type`、`risk_level`、`reason`、`diff`、`status`。

### 9B.18 实施序列

Connector 架构按以下长期目标分阶段落地：

- **Phase 6A：Connector SDK 基础边界**：建立 `connectors/base`、registry、capability schema、ToolRunRequest/Result、Artifact/ParsedReport 类型。
- **Phase 6B：Vivado Connector 包装现有 Runtime Adapter**：将现有 Vivado runner、remote/local/mock、file sync、path mapper、Tcl policy 包装为 `VivadoConnector` capabilities。
- **Phase 6C：Structured Report Pipeline**：Timing、Utilization、DRC、Methodology parser 输出 ParsedReportBundle，落库并接入 Report UI、Context Builder、Monitor。
- **Phase 6D：PatchProposal 与 Connector Policy 统一**：XDC/RTL/Tcl 修改统一通过 proposal、diff、approval、apply、rerun、compare。
- **Phase 6E：Connector API 与 WorkBuddy Skill**：暴露 connector/capability/run/report/approval API，WorkBuddy 只调用 Synthia API。
- **Phase 6F：第二个 Connector 样板**：以 Verilator/XSim/Yosys 之一作为第二 connector，验证 Agent Core 无 Vivado 硬依赖。

---

## 10. 错误知识库设计

### 10.1 KB 分层

KB 来源：

1. Built-in KB：源码内 YAML，例如当前 `error_cases.yaml`。
2. User KB：SQLite `kb_cases`。
3. Candidate KB：SQLite `kb_candidates`。

查询时合并 built-in + user KB。

### 10.2 Candidate 自动生成

当 run 失败或 Vivado/parser/tool 产生 problem 时：

- 自动生成 candidate。
- 状态为 `pending`。
- 不自动进入 approved KB。

成功 run 一般不生成 candidate，除非用户手动触发。

### 10.3 Candidate 字段

Candidate 必须支持：

- 来源 session/run/problem。
- pattern。
- normalized signature。
- category。
- message IDs。
- raw log excerpt artifact。
- likely causes。
- suggested actions。
- confidence。
- repro steps。
- fix patch/diff artifact。
- Vivado version。
- FPGA part。
- top module。
- manifest artifact。
- final resolved status。
- resolution summary。
- created_by：`parser|harness|agent|user|summary_model`。

### 10.4 去重与合并

去重策略：

1. normalized signature。
2. regex/pattern match。
3. embedding similarity。
4. agent/summary model assisted merge decision。

Agent-assisted merge 写入 spec，但实现时应作为审核辅助，不应自动覆盖用户 KB。

---

## 10A. Semantic Knowledge Base 与向量检索

### 10A.1 知识库范围

Semantic Knowledge Base 包含两层：

- Global KB：跨项目通用知识，例如 Vivado 文档、通用 EDA 经验、仓库 SPEC、README、架构文档、通用历史案例。
- Project KB：绑定某个 manifest/project 的知识，例如项目 README、RTL、XDC、Tcl、历史 run/session summary、项目特定 patch 和调试经验。

不设置独立 session KB。Session 内长期记忆进入 memory snapshots；当 session 经验需要沉淀时，应生成 project/global KB candidate。

### 10A.2 知识来源

必须支持：

- 仓库内 Markdown、README、arch.md、SPEC.md。
- Vivado 官方文档或本地 PDF。
- 历史 run 总结。
- 历史 session 总结。
- 用户手动上传文档。
- RTL 源码。
- XDC 约束。
- Tcl/Python/shell 脚本。
- Error KB approved case。
- 已验证 patch 和解决方案。

### 10A.3 向量库抽象

向量数据库必须通过接口抽象：

```python
class VectorStore:
    async def upsert(chunks: list[KnowledgeChunk]) -> None: ...
    async def delete(chunk_ids: list[str]) -> None: ...
    async def search(query_embedding, filters, top_k: int) -> list[VectorHit]: ...
```

可选后端：

- sqlite-vec/sqlite-vss。
- Chroma。
- Qdrant。
- LanceDB。
- 其他兼容实现。

Spec 不绑定具体后端。

### 10A.4 Embedding Provider

Embedding 模型通过 provider adapter 配置：

```python
class EmbeddingProvider:
    async def embed_documents(texts: list[str]) -> list[list[float]]: ...
    async def embed_query(text: str) -> list[float]: ...
```

要求：

- 支持 API embedding 模型。
- 支持本地 embedding 模型。
- 支持与当前 LLM provider 同源的 embedding。
- usage/cost 进入 `llm_usage` 或 embedding usage 记录。
- 必须存在一个**确定性 offline fallback**（例如 hash-bow embedding），用于无 API key 的开发/CI/单元测试环境；fallback 的 `provider` 字段必须显式标记为 `"hash"` 之类的非真实模型名，以便检索审计能识别"当前结果可信度低"。Fallback 只用于开发，不允许作为生产默认；后端必须在启动时记录当前 embedding provider，并在 monitor overview 暴露。

### 10A.5 Ingestion Pipeline

```text
source discovery
  -> hash change detection
  -> parsing
  -> chunking
  -> metadata extraction
  -> authority/trust score assignment
  -> embedding
  -> vector upsert
  -> index audit
```

文件变化策略：

- 通过 sha256/hash 识别变化。
- 支持增量 reindex。
- 支持 UI 手动 reindex。

### 10A.6 Retrieval Pipeline

```text
query
  -> intent detection
  -> entity extraction
  -> query rewrite
  -> metadata filters
  -> vector search
  -> Error KB match
  -> rerank
  -> min score threshold
  -> authority/trust scoring
  -> token budget selection
  -> retrieval audit
```

### 10A.7 可信度与权威度评分

每个知识片段必须具备：

- `vector_score`：语义相似度。
- `rerank_score`：重排得分。
- `authority_score`：来源权威度。
- `trust_score`：内容可信度。
- `final_score`：综合分。

权威度示例：

```text
Vivado official docs > verified user KB > approved KB case > project README > historical run summary > raw session summary > unreviewed candidate
```

可信度可由以下因素影响：

- 是否人工审核。
- 是否被成功 run 验证。
- 是否来自官方文档。
- 是否与当前 project/part/top/tool 匹配。
- 是否近期过期。
- 是否与其他来源一致。

### 10A.8 上下文污染防护

为防止语义检索污染上下文，必须使用：

- rerank。
- metadata filter。
- minimum score threshold。
- authority/trust score。
- retrieval audit。
- token budget limit。
- source attribution。

低分或低可信结果不得进入高优先级上下文区。

### 10A.9 写回策略

模型不得自动直接写入全局/项目知识库。

允许：

- 写入 session memory。
- 生成 project KB candidate。
- 生成 global KB candidate。
- 生成 Error KB candidate。

所有 KB candidate 必须审核后才能进入 approved KB。

---

## 11. 多 Agent 协作设计

### 11.1 Agent Identity

每个 agent 必须有：

- `agent_id`
- `agent_type`
- `name`
- `role`
- `model`
- `capabilities`

### 11.2 Agent Run

每个 agent 执行作为独立 run：

```text
run_type = agent
agent_id = synth_agent
parent_run_id = task_run
```

### 11.3 Agent 间通信

通信方式：

- 文件 channel。
- channel_messages 表。
- SSE event 广播。

事件类型：

```text
agent.message
agent.handoff
channel.message.created
artifact.created
```

### 11.4 文件通信规范

Artifact/channel 文件必须记录：

- writer agent。
- reader agent 或 target channel。
- run/task/session。
- content summary。
- artifact id/path/hash。

### 11.5 多 Agent 监控

Monitor 必须支持：

- 每个 agent 独立 token/tool/time。
- agent 间消息流图。
- 文件通信记录。
- SSE 消息记录。
- supervisor 分配任务与 handoff 记录。

### 11.6 多 Agent 知识库使用

多 Agent 共享 Global KB 和 Project KB，但每个 Agent 可以拥有自己的 retrieval profile。

示例：

- `synth_agent` 优先检索 synthesis、Vivado log、RTL 相关知识。
- `timing_agent` 优先检索 timing closure、XDC、clock、path analysis 相关知识。
- `patch_agent` 优先检索历史 patch、代码结构、已验证解决方案。
- `supervisor_agent` 可检索全局知识并把检索结果作为 handoff context。

Supervisor handoff 必须记录：

- 检索 query。
- 检索结果。
- 注入给目标 agent 的上下文。
- retrieval audit id。

---

## 12. React 前端规范

### 12.1 工程结构

采用独立 Vite + React + TypeScript 工程：

```text
frontend/
  package.json
  vite.config.ts
  tsconfig.json
  src/
    main.tsx
    app/
      App.tsx
      router.tsx
    pages/
      ProjectsPage.tsx
      ProjectDetailPage.tsx
      TerminalPage.tsx
      MonitorRunsPage.tsx
      MonitorRunDetailPage.tsx
      KnowledgeBasePage.tsx
    components/
      terminal/
      monitor/
      kb/
      markdown/
      layout/
    api/
      client.ts
      types.ts
      projects.ts
      sessions.ts
      tasks.ts
      events.ts
      monitor.ts
      kb.ts
      knowledge.ts
    stores/
      sessionStore.ts
      streamStore.ts
      terminalStore.ts
    styles/
```

构建产物可由 FastAPI 托管。

### 12.2 页面路由

React 接管：

```http
GET /
GET /projects/:projectId
GET /term?project={projectId}&session={sessionId}
GET /monitor
GET /monitor/runs/:runId
GET /kb
```

### 12.3 UI 风格

- Terminal 页面保持终端风暗色体验。
- Monitor 页面采用 dashboard 风格。
- KB 页面支持审核工作流。

### 12.4 状态管理

采用：

- TanStack Query：API cache、列表、详情、刷新。
- Zustand：实时 stream、active session/task、未提交输入、UI 展开折叠状态。

### 12.5 API Client

采用 OpenAPI 生成的类型化 API client。

要求：

- 所有 API 类型集中维护。
- 错误响应结构统一。
- SSE client 独立封装。

### 12.6 SSE Client

前端提供：

```ts
class SessionEventStream {
  connect(sessionId: string, afterSeq: number): void
  disconnect(): void
  onEvent(event: SessionEvent): void
}
```

能力：

- 自动 reconnect。
- 使用 `after_seq` 补齐事件。
- 防重复处理。
- backoff 重连。
- 页面隐藏/恢复后状态同步。

### 12.7 Terminal UI

必须支持：

- projects 首页，取代原单层 sessions 首页。
- Project 列表支持新建、重命名、删除、归档、搜索、排序。
- Project 创建表单必须收集并后端校验 root path、Synthia YAML、Vivado `.xpr`、part/board part、top module、target language、source/constraint/Tcl 路径集合、默认 Vivado target。
- Project 详情页展示该 Project 下的 sessions。
- Project 详情页内新建 Session 时只填写 session 名称。
- Project 下 session 列表支持新建、重命名、删除、归档、搜索、排序。
- 按 updated/created/name/status/project 排序。
- 显示 running/stopped/error 状态。
- 显示 token/toolcall/problem count 摘要。
- 聊天页返回按钮。
- Terminal header 必须显示所属 Project 与 Session，返回路径优先回到 `/projects/{projectId}`。
- approve patches 开关。
- Stop 按钮。
- 输入框旁 Stop。
- Stop 后按钮显示 `Stopping`，结束后显示 `Stopped`。
- 聊天视图与 timeline 视图切换。
- assistant turn 内展示 reasoning/tool/response 子块。

### 12.8 Reasoning UI

Reasoning：

- 默认折叠。
- 可配置显示/隐藏。
- 显示摘要和耗时。
- 可展开查看原文。
- 长 reasoning 使用虚拟列表或分段加载。

### 12.9 Tool Call UI

Tool block 必须显示：

- tool 名称。
- 状态。
- 耗时。
- 输入摘要。
- 输出摘要。
- artifact 链接。
- 错误/异常标红。
- 若该 tool/subagent 涉及 LLM，显示 token 和费用。

### 12.10 Response Markdown

使用：

- `react-markdown`
- `remark-gfm`

代码块增强：

- 代码高亮。
- 一键复制。
- diff 渲染。
- 文件路径/artifact 可点击。

### 12.11 Monitor UI

Phase 1：

- `/monitor/runs`
- run 列表。
- run detail。
- toolcall timeline。
- usage summary。

Phase 2：

- charts。
- token/cost 趋势。
- tool error rate。
- agent 对比。

Phase 3：

- multi-agent message graph。
- channel/file communication viewer。
- KB candidate workflow。

Monitor run detail must also show Vivado-specific details:

- target host/version。
- execution mode：batch/interactive/project/non-project。
- generated Tcl script。
- command timeline。
- stdout/stderr/log tail。
- reports/artifacts。
- parsed Vivado errors/warnings/message IDs。
- stop/interrupt/kill events。

### 12.11A Vivado UI

React UI should include Vivado management views:

- Vivado targets list。
- target health check。
- target version/license/workdir status。
- command history。
- long-lived Tcl session status。
- run Tcl/script/flow form。
- artifact/report browser。
- path mapping and file sync debug view。

### 12.12 KB UI

KB 页面必须覆盖：

- 查看 built-in YAML KB。
- 查看 user KB。
- 查看 pending candidates。
- approve/reject/merge。
- 从 run detail 一键生成 candidate。

### 12.13 Context / Retrieval Audit UI

Terminal debug panel 与 Monitor run detail 必须展示：

- 实际注入模型的 context package。
- session memory 注入项。
- recent messages 注入项。
- Error KB 注入项。
- Semantic KB 注入项。
- project context 注入项。
- tool/problem summary 注入项。
- 每项 token 数。
- 每项来源、路径、source id、artifact id。
- 相关度、权威度、可信度。
- 被裁剪项与裁剪原因。

### 12.14 Knowledge Base UI

Knowledge Base 页面必须支持：

- Global KB sources。
- Project KB sources。
- 文档上传。
- source reindex。
- 全量 reindex。
- semantic search 调试。
- retrieval audit 查看。
- candidate 审核入口。

### 12.15 Frontend Refactor Design

React 前端的长期目标是一个可扩展的 EDA Agent Engineering Console，而不是仅为当前 API 写死的页面集合。

设计方向：

```text
Terminal Core + Engineering Dashboard + Vivado Cockpit + Knowledge Console
```

要求：

- 保持 terminal 暗色工程感。
- Monitor/Vivado/KB 页面采用生产级 dashboard 信息架构。
- UI 质量目标为 production-grade，不以临时 demo 为目标。
- 所有页面、导航、事件处理、API client、面板都应通过模块化扩展，而不是在单个组件中硬编码。
- 不在前端写死 Vivado target、host、路径、模型、agent 名称、event type 全量集合或后端 feature 开关。

当前技术栈：

```text
React
Vite
TypeScript
React Router
TanStack Query
Zustand
SSE EventSource
CSS design tokens
```

允许新增的基础依赖：

```text
react-markdown
remark-gfm
lucide-react
clsx
```

### 12.16 Visual Design Gate

正式重构 UI 前应先形成视觉设计方案，再进入实现。

流程：

1. 产出 Terminal、Monitor、Vivado、KB 至少一组核心界面设计概念。
2. 从设计概念抽取 design tokens、布局密度、状态颜色、组件族、字体规则。
3. 实现时保持设计一致性。
4. 浏览器验证时检查 terminal、dashboard、responsive、交互状态。

设计系统必须包含：

- color tokens。
- typography tokens。
- spacing scale。
- radius/elevation。
- status colors：running/done/error/stopped/stopping/warning。
- terminal block variants。
- dashboard panel variants。
- table/timeline/card/form/button/badge primitives。

### 12.17 Extensible Frontend Module System

前端应按 feature module 扩展。

每个 feature module 可声明：

```ts
export interface FrontendModule {
  id: string
  routes: AppRoute[]
  navItems?: NavItem[]
  queryKeys?: Record<string, unknown>
  eventReducers?: EventReducer[]
  panels?: PanelContribution[]
  settingsSections?: SettingsSection[]
}
```

核心模块：

- `projects`
- `sessions`
- `terminal`
- `monitor`
- `vivado`
- `kb`
- `knowledge`
- `settings`

长期可新增：

- `multiAgent`
- `contextAudit`
- `artifacts`
- `reports`
- `admin`

模块化目标：

- 新增页面不需要改动根组件的大量 switch。
- 新增事件类型可以注册 reducer 或 timeline renderer。
- 新增 monitor panel 可以注册到 run detail。
- 新增 Vivado target/command 能力可以通过 API metadata 渲染。

### 12.18 Directory Architecture

推荐目录：

```text
frontend/src/
  app/
    App.tsx
    router.tsx
    providers.tsx
    modules.ts

  api/
    generated/
    client.ts
    types.ts
    projects.ts
    sessions.ts
    tasks.ts
    events.ts
    monitor.ts
    settings.ts
    vivado.ts
    kb.ts
    knowledge.ts

  lib/
    sse.ts
    eventReducer.ts
    markdown.ts
    time.ts
    format.ts
    errors.ts
    capability.ts

  stores/
    terminalStore.ts
    streamStore.ts
    uiStore.ts
    moduleStore.ts

  components/
    layout/
    terminal/
    monitor/
    vivado/
    kb/
    knowledge/
    common/

  pages/
    ProjectsPage.tsx
    ProjectDetailPage.tsx
    TerminalPage.tsx
    MonitorPage.tsx
    RunDetailPage.tsx
    VivadoPage.tsx
    KnowledgeBasePage.tsx
    SettingsPage.tsx

  styles/
    tokens.css
    global.css
    terminal.css
    monitor.css
    vivado.css
```

目录是推荐组织方式，不应成为限制。后续可以按功能增长拆分，只要保持 module boundary 清晰。

### 12.19 Routing and Navigation

长期路由：

```text
/                         projects
/projects/:projectId       project detail + sessions
/term?project={pid}&session={id}
/monitor                   run list
/monitor/runs/:runId       run detail
/vivado                    targets / health / commands
/kb                        error KB / candidates
/knowledge                 semantic knowledge
/settings                  settings
```

路由和导航必须数据驱动：

```ts
const routes = modules.flatMap(m => m.routes)
const navItems = modules.flatMap(m => m.navItems ?? [])
```

不应在多个页面中散落硬编码链接。

### 12.20 API Client Strategy

长期采用 OpenAPI 生成的类型化 client。

要求：

- 构建流程可生成 `frontend/src/api/generated`。
- feature API wrapper 只封装业务语义，不重复定义后端 schema。
- API base path 可配置。
- 新前端只依赖 `/api/v1` 长期接口，不兼容旧 `/api/terminal/*`。
- 错误结构统一包装为 `ApiError`。

API client 层级：

```text
generated OpenAPI client
  -> feature API wrappers
  -> TanStack Query hooks
  -> page/components
```

### 12.21 Data Fetching and State

使用 TanStack Query 管理 server state：

- session list/detail。
- messages。
- active task。
- monitor runs/detail。
- toolcalls/usage/events。
- Vivado health/targets/commands。
- KB cases/candidates。
- knowledge sources/search。
- patch approval。

使用 Zustand 管理 client/runtime UI state：

- active stream connection。
- last processed seq per session。
- terminal view mode。
- collapsed block ids。
- debug drawer state。
- selected timeline filters。
- local UI preferences。

浏览器不是权威状态来源。刷新后必须能通过 API + events 重建 UI。

### 12.22 SSE and Event Reducer

Terminal 的权威实时来源是 messages + events：

1. 拉取 messages。
2. 拉取 events。
3. 使用统一 reducer 合并为 turns/timeline/tool state。
4. 连接 SSE stream。
5. 断线后使用 `after_seq` 补齐。

SSE client 必须封装：

- connect/disconnect。
- heartbeat timeout。
- backoff reconnect。
- replay `after_seq`。
- duplicate event guard。
- unknown event fallback。

事件 reducer 必须可扩展：

```ts
export interface EventReducer {
  eventTypes: string[] | "*"
  reduce(state: TerminalRuntimeState, event: SessionEvent): TerminalRuntimeState
}
```

未知事件不得导致 UI 崩溃，应进入 generic timeline。

### 12.23 Terminal Experience

Terminal 页面采用：

- 左侧/可折叠 session-run 信息区。
- 中央聊天区。
- chat/timeline 视图切换。
- 右侧 debug drawer：context、events、toolcalls、retrieval audit。
- composer + Stop。

默认展示：

- user message。
- assistant turn。
- reasoning 折叠块。
- tool call block。
- response markdown。

Stop 行为：

- active task running/stopping 时启用。
- 点击后显示 `Stopping...`。
- 结束后显示 `Stopped`。
- partial response 保留。

### 12.24 Monitor Experience

Monitor Phase 1 UI 必须包含：

- run list。
- run detail。
- toolcall timeline。
- usage summary。
- event timeline。

Run detail 面板应通过 panel contribution 扩展：

- metadata。
- events。
- toolcalls。
- usage。
- artifacts。
- problems。
- context audit。
- Vivado command。
- agent handoff。

### 12.25 Vivado Experience

Vivado 页面必须以 capability-driven 方式渲染，不写死单一远程机器。

第一版包含：

- target list。
- default target。
- health panel。
- SSH/Vivado/settings/workdir/version/license 状态。
- command history 框架。
- Tcl/script/flow command runner 框架。

后续扩展：

- multi-target。
- command log viewer。
- artifact/report browser。
- long-lived Tcl session panel。
- path mapping/file sync debug view。

### 12.26 KB Experience

KB 页面第一版包含：

- built-in KB cases。
- user KB cases。
- pending candidates。
- approve/reject/merge 操作。

KB 页面应为后续 semantic knowledge UI 预留入口：

- source list。
- reindex。
- semantic search。
- retrieval audit。
- candidate generation from run/problem。

### 12.27 Markdown and Code Rendering

Markdown 使用：

```text
react-markdown
remark-gfm
```

不得使用不受控的 `dangerouslySetInnerHTML` 渲染模型输出。

代码块能力：

- syntax highlight extension point。
- copy button。
- diff rendering。
- artifact/file path links。

### 12.28 Frontend Quality Gates

重构验收至少包括：

- `npm run build` 通过。
- TypeScript 无关键错误。
- Browser 手动验证 sessions/terminal/monitor/vivado/kb 主路径。
- SSE reconnect 手动验证。
- Stop 手动验证。
- terminal markdown 渲染验证。
- responsive 基础验证。

后续必须加入：

- Playwright e2e。
- component tests。
- API mock tests。

---

### 12.29 Synthia Control Plane Frontend IA

Synthia 前端的长期定位不是普通聊天窗口，而是面向 EDA/工业软件执行的 Control Plane。Timeline Chat 是自然语言入口和审计时间线；Project、Run、Report、Approval、Connector、Knowledge、Monitor 页面共同构成企业级操作控制台。

长期一级导航应包含：

| 页面 | 定位 |
| --- | --- |
| Projects | 工程入口、manifest、器件、connector target、最近 run/session/problem |
| Sessions | 自然语言会话与 Timeline Chat，承载 Agent 交互、tool events、approval cards |
| Runs | 工业软件执行历史与当前 run 控制面 |
| Reports | Timing / Utilization / DRC / Methodology / Power 结构化报告浏览 |
| Approvals | Patch、Tcl/script、高风险操作、KB/Evolution 审批中心 |
| Connectors | Vivado / Verilator / Yosys / VCS / DC 等 connector 能力与健康状态 |
| Knowledge | Error KB、Semantic KB、KB candidates、retrieval audits、enterprise rules |
| Monitor | token、toolcall、run、problem、cost、retention、connector health 观测 |
| Settings | 模型、审批策略、Vivado target、connector policy、主题/语言 |

现有页面迁移关系：

```text
ProjectsPage       -> Projects / Project Detail
TerminalPage       -> Sessions / Timeline Chat
MonitorPage        -> Monitor
RunDetailPage      -> Runs / Run Detail
VivadoPage         -> Connectors / Vivado Detail
EvolutionPage      -> Knowledge / Evolution / KB Review
KnowledgeBasePage  -> redirect or merge into Knowledge
SettingsPage       -> Settings
```

前端原则：

1. **Timeline Chat 是入口，不是全部。** 用户可以用自然语言创建 task，但 task/run/report/approval 必须有结构化页面。
2. **Run 是工业软件执行核心对象。** 所有 connector execution、steps、artifacts、reports、problems、approvals 都围绕 run 展示。
3. **Report 是结构化数据，不是 log viewer。** 原始 log/rpt 可作为 artifact 打开，但 UI 首屏展示 ParsedReport。
4. **Approval 是企业安全边界。** 所有修改与高风险操作必须能在全局 Approval Queue 中追踪。
5. **Connector 是用户可见抽象。** 工具版本、target、capability、policy、health、license/mock 状态必须可见。
6. **Monitor 显示 harness 事实数据。** 不依赖 LLM 自觉上报。
7. **Knowledge 是企业经验入口。** KB、Semantic KB、retrieval audit、candidate/evolution 均应在 Knowledge 信息架构下收敛。

### 12.30 Projects 页面规划

Projects 页面是 Synthia 的工作入口。企业用户应先选择或创建 Project，再进入 Sessions、Runs、Reports 或 Connector 操作。

Project list/card/tree 必须展示：

- project name、status、archived 状态。
- root path、manifest path。
- top module、part、board part。
- default connector 与 default target。
- last run status、last active time。
- session count、run count、problem count、KB source count。
- manifest validation 状态。

Project Detail / Drawer 应包含：

```text
Project Detail
├── Manifest Summary
│   ├── connector
│   ├── top / part / board_part
│   ├── RTL/XDC/Tcl globs
│   └── validation diagnostics
├── Connector Target
│   ├── Vivado/local/remote target
│   ├── version / path / settings
│   └── health check
├── Recent Sessions
├── Recent Runs
├── Recent Problems
├── Recent Reports
└── Knowledge Sources
```

关键操作：

- Create / Edit / Archive Project。
- Validate Manifest。
- New Session / New Task。
- Run Synthesis / Run Implementation。
- Open Runs / Reports / Knowledge。

### 12.31 Sessions / Timeline Chat 页面规划

Sessions 页面保留现有 Timeline Chat，但产品语义升级为 Operator Timeline。

Timeline 必须支持以下 entry/card：

- user message。
- assistant reasoning / response。
- task created / plan generated。
- run started / run completed / run failed。
- step started / step completed / step failed。
- tool call / tool result / tool failure。
- approval request / approval decision。
- patch proposal。
- parsed report summary。
- problem detected。
- KB candidate generated。
- stop requested / stopped / partial response saved。

推荐布局：

```text
Timeline Chat
├── Left/Main: chronological timeline
│   ├── user / assistant messages
│   ├── reasoning blocks
│   ├── tool call blocks
│   ├── run step cards
│   ├── report summary cards
│   └── approval / patch cards
└── Right Panel: active context
    ├── current task
    ├── active run
    ├── step progress
    ├── artifacts
    ├── reports
    ├── context package
    └── pending approvals
```

Chat composer 必须能够：

- 创建普通问答 task。
- 创建 connector task，例如 run synth、run impl、debug timing、debug drc。
- Stop 当前任务。
- 对 pending approval 进行快捷操作。

### 12.32 Runs 页面与 Run Detail 规划

Runs 是 Synthia 工业执行的核心页面。Run list 必须支持跨 project/session/connector/stage/status 查询。

Run list 字段：

- run id。
- project / session / task。
- connector id / capability id。
- status / current stage。
- started_at / duration。
- WNS / TNS / DRC error count / LUT / FF。
- toolcall count / token count / cost。
- problem count / approval count。

Run Detail 推荐布局：

```text
Run Detail
├── Header
│   ├── run id / project / connector / status
│   ├── capability / stage / duration
│   ├── stop / rerun / compare / export buttons
│   └── links to session, project, artifacts
├── Step Timeline
│   ├── validate
│   ├── elaborate
│   ├── synth
│   ├── opt/place/route
│   ├── report
│   ├── diagnose
│   └── patch_proposal
├── Structured Reports
│   ├── timing summary cards
│   ├── utilization cards
│   ├── DRC cards
│   └── methodology cards
├── Problems
├── Artifacts
├── Tool Calls
├── Agent Diagnosis
├── Approvals / Patch Proposals
└── Audit / Context Package
```

Step Timeline 需要展示：

- step status、started/ended、duration。
- command / capability / risk level。
- log artifact。
- parsed report count。
- problem count。
- retry/rerun relation。

### 12.33 Reports 页面规划

Reports 页面展示 ParsedReport，不以原始 log 为中心。

Reports 可按 Project、Run、Connector、Report Type 查询。核心 tabs：

```text
Reports
├── Timing
├── Utilization
├── DRC
├── Methodology
├── Power
├── Simulation
└── Raw Artifacts
```

Timing 视图：

- WNS、TNS、WHS、THS。
- failing endpoints。
- worst paths table。
- clock/path group。
- 与上一 run 的 delta。
- 可跳转到 artifact 原文位置。

Utilization 视图：

- LUT、FF、BRAM、DSP、IO。
- percentage。
- 与上一 run 的 delta。
- trend chart。

DRC 视图：

- rule、severity、message、objects。
- suggested action。
- linked KB cases。
- create patch proposal / open approval。

Methodology / Power / Simulation 视图后续按 connector parser 扩展，不得写死 Vivado-only UI。

### 12.34 Approval Center 页面规划

Approval Center 是企业安全边界的全局入口。Session 内 approval card 与全局 approval queue 必须共享同一数据源。

审批类型：

- RTL patch。
- XDC patch。
- Tcl/script 参数变更。
- 高风险 connector execution。
- 工程外路径访问请求。
- KB candidate approve/merge。
- Evolution overlay apply。

Approval list 字段：

- approval id、type、risk_level。
- project / session / task / run / step。
- connector / capability。
- requester agent。
- created_at / expires_at。
- status。

Approval detail：

```text
Approval Detail
├── Summary / Reason
├── Risk Explanation
├── Linked Problem
├── Linked Report Evidence
├── Diff Viewer
├── Proposed Command / Tcl Policy Result
├── Artifact references
├── Approve / Reject / Edit and Approve
└── Audit trail
```

Diff viewer 应优先使用 Monaco diff viewer 或等价组件。所有审批决策必须落库并生成 event。

### 12.35 Connectors 页面规划

Connectors 页面是 Industrial Tool Connector Layer 的用户可见控制台。

Connector list 展示：

- connector id / name。
- health status。
- version / supported versions。
- target count。
- capability count。
- license/reachable/mock 状态。
- last health check。

Connector Detail 推荐布局：

```text
Connector Detail
├── Environment
│   ├── local / remote
│   ├── executable path
│   ├── env script
│   ├── version
│   ├── license / reachable
│   └── remote workdir / path mapping
├── Capabilities
│   ├── validate_project
│   ├── run_synthesis
│   ├── run_implementation
│   ├── report_timing_summary
│   └── ...
├── Policies
│   ├── risk level
│   ├── approval requirement
│   ├── allowed paths
│   └── Tcl/script restrictions
├── Recent Runs
├── Recent Commands
└── Health Check History
```

现有 `VivadoPage` 应演进为 `/connectors/vivado`，但旧 `/vivado` 可作为兼容 redirect。

### 12.36 Knowledge 页面规划

Knowledge 页面收敛 Error KB、Semantic KB、KB Candidates、Retrieval Audits 与 Evolution 知识沉淀。

推荐 tabs：

```text
Knowledge
├── Error KB
├── Semantic KB
├── Candidates
├── Sources
├── Retrieval Audits
├── Project Rules
└── Evolution
```

展示内容：

- built-in cases。
- user approved cases。
- project/global knowledge。
- semantic sources 与 embedding 状态。
- authority_score / trust_score / relevance_score。
- retrieval audit query、selected chunks、token budget。
- KB candidate approve/reject/merge。
- Evolution KB candidates。

长期路由 `/kb` 和 `/evolution?tab=kb` 应收敛到 `/knowledge` 下；Evolution 可以保留为高级/管理页。

### 12.37 Monitor 页面规划

Monitor 页面继续作为 harness 强制观测的可视化入口。它展示事实数据，不展示 LLM 自述。

必须覆盖：

- run count、success/failure rate。
- connector / capability 使用分布。
- most failing stages。
- top error signatures。
- toolcall count、duration、failure rate。
- token input/output、cost。
- approval request/approve/reject rate。
- stop rate / partial response count。
- KB candidate generation / approval rate。
- artifact storage / retention cleanup。
- connector health history。

### 12.38 路由迁移计划

长期推荐路由：

```text
/                         -> Projects
/projects/:projectId       -> Project Detail
/projects/:projectId/tasks/new

/sessions                  -> Session list
/sessions/:sessionId       -> Timeline Chat
/term                      -> legacy alias or redirect

/runs                      -> Run list
/runs/:runId               -> Run Detail
/runs/:runId/reports       -> Report Detail
/runs/:runId/artifacts     -> Artifact Browser

/reports                   -> Report Explorer
/reports/:reportId

/approvals                 -> Approval Queue
/approvals/:approvalId

/connectors                -> Connector list
/connectors/:connectorId   -> Connector Detail
/connectors/vivado         -> Vivado Connector Detail

/knowledge                 -> Knowledge Base
/knowledge/candidates
/knowledge/retrieval

/monitor
/settings
```

兼容旧路径：

```text
/term       -> keep alias until Sessions page is complete
/vivado     -> redirect /connectors/vivado
/kb         -> redirect /knowledge/candidates or /knowledge
/evolution  -> keep as advanced evolution/admin page
```

### 12.39 前端实施阶段

前端按以下阶段演进：

- **Frontend IA Phase A：导航重组**  
  新增 Runs、Reports、Approvals、Connectors、Knowledge 一级入口；保留 Projects、Monitor、Settings、Timeline Chat。

- **Frontend IA Phase B：Run Detail 增强**  
  将 RunDetailPage 扩展为核心页面：summary、step timeline、tool calls、artifacts、parsed reports、problems、approvals、agent diagnosis。

- **Frontend IA Phase C：VivadoPage -> Connector Detail**  
  将现有 Vivado Runtime 页面演进为 Connector / Vivado Detail，并为后续 connector 预留通用组件。

- **Frontend IA Phase D：Knowledge Console 独立**  
  收敛 KB、Semantic KB、Retrieval Audit、KB Candidates、Evolution KB 到 Knowledge 信息架构。

- **Frontend IA Phase E：Approval Center**  
  打通 session 内 approval card 与全局 approval queue，支持 diff viewer、risk evidence、audit trail。

- **Frontend IA Phase F：Report Explorer 与 History Compare**  
  支持跨 run 的 Timing/Utilization/DRC 对比和趋势展示。

---

## 13. FastAPI 静态资源与开发模式

### 13.1 开发模式

后端：

```bash
edagent web --host 127.0.0.1 --port 8000
```

前端：

```bash
cd frontend
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

Vite dev server 代理：

```text
/api -> http://127.0.0.1:8000
```

### 13.2 构建模式

```bash
cd frontend
npm run build
```

FastAPI 服务构建产物：

```text
src/edagent_vivado/web/static/
```

### 13.3 发布策略

打包发布方式后续确定。Spec 只要求架构支持：

- 开发模式前后端分离。
- 构建模式 FastAPI 托管 React 静态资源。
- Python package 可包含已构建静态资源。

构建产物治理：

- `src/edagent_vivado/web/static/assets/index-*.js` / `index-*.css` 是 Vite 输出的带 hash 文件，**只允许一份当前版本进入仓库**；每次 `npm run build` 必须清空 `assets/` 后再写入，避免历史 hash 文件累积。
- `frontend/dist/`、`frontend/.vite/`、`frontend/bun.lock`、`*.egg-info/`、`__pycache__/`、`*.py[cod]`、`build/`、`dist/` 必须在 `.gitignore` 中。
- `examples/**/[0-9]{8}_*_agent_(synth|impl)/`、`examples/**/_*.py`、`examples/**/_*.tcl` 这类 run-time scratch 产物必须 ignore；历史已 tracked 的可以在专门的 cleanup PR 中 `git rm --cached`。

---

## 14. 旧 Dashboard/API 迁移

### 14.1 UI

React 应统一接管所有页面。

旧 dashboard HTML 页面不作为长期 UI 入口。

### 14.2 API

新的 terminal/monitor/KB API 是长期接口。

旧 API 可保留过渡：

```text
/api/runs
/api/runs/{id}
/api/runs/{id}/log
/api/chat
/api/chat/stream
/api/chat/multi
/api/errors/kb
```

但新 React terminal 不依赖旧 terminal API。

---

## 15. 数据裁剪、脱敏与保留策略

### 15.1 裁剪

必须对以下内容裁剪：

- tool input。
- tool output。
- reasoning。
- Vivado log excerpt。
- stack trace。
- model raw response。

长内容落 artifact，数据库保存 summary 和 artifact id。

### 15.2 脱敏

记录前必须做基础脱敏：

- API key。
- token。
- password。
- secret。
- authorization header。
- 可选隐藏绝对路径。

Tool input/output 支持 whitelist/blacklist。

### 15.3 保留策略

支持：

- 全局 retention，例如 30/90 天。
- session 手动清理。
- artifact 单独保留。
- 数据库只存路径/摘要/hash。

---

## 16. 验收标准

### 16.1 Project、Session 与记忆

- 用户必须先创建 Project，且后端校验 root path、Synthia YAML、Vivado `.xpr`、part/board part 等项目配置。
- 首页为 Projects，Project detail 展示该 Project 下的 Sessions。
- 创建 Session 时只需填写 session 名称，并继承 Project 的上下文与配置。
- 历史单层 Session 可根据 manifest/path 自动迁移到 Project。
- 创建 session 后可连续多轮对话，agent 能引用前文。
- 服务重启后 session 消息和摘要仍可恢复。
- 长 session 通过 memory summary 继续保持上下文。
- reasoning/tool 原文不直接污染 LLM 上下文。
- 每次 LLM 调用前都会生成 context package。
- Monitor/Terminal 可查看本次调用注入了哪些 memory、Error KB、Semantic KB、tool summary。

### 16.1A Semantic KB 与上下文注入

- Global KB 和 Project KB 可分别索引。
- 仓库文档、Vivado 文档、历史 run/session summary、用户上传文档、RTL、XDC、脚本均可进入知识库。
- 文件 hash 变化后支持增量 reindex。
- UI 支持手动 reindex。
- 知识检索使用 query rewrite、entity extraction、metadata filter、vector search、rerank、min score threshold。
- 检索结果包含来源、相关度、权威度、可信度。
- Context Builder 按优先级注入知识。
- 低可信或低相关知识不会进入高优先级上下文。
- Agent 和多 Agent 可主动调用 knowledge search tool。
- 模型不能直接写入 approved KB，只能生成 candidate 或 session memory。

### 16.2 后台运行与重连

- 用户关闭页面后 task 继续执行。
- 重新打开 session 后，历史事件完整恢复。
- active task 可继续通过 SSE 接收后续事件。
- 已完成 task 显示完整 response/tool/reasoning。

### 16.3 Stop

- Running task 时 Stop 按钮可用。
- Stop 后 task 进入 stopping/stopped。
- partial assistant response 保存并标记 stopped。
- 后续同 session 可继续发送新消息。

### 16.4 React UI

- Projects 首页支持新建/重命名/删除/归档/搜索/排序。
- Project detail 支持查看项目配置、健康状态、Project KB 摘要与该 Project 下的 Session list。
- Session list 支持新建/重命名/删除/归档/搜索/排序，且 Session 创建只填写名称。
- Terminal 支持聊天视图和 timeline 视图。
- Reasoning 默认折叠，可展开。
- Tool block 显示状态、耗时、输入输出摘要、artifact、错误、token/cost。
- Markdown 支持 GFM 表格、代码块、diff、复制。

### 16.5 Monitor

- 每个 task/tool/LLM/Vivado run 被记录。
- Toolcall 数量、耗时、状态可查询。
- Usage/cost 可查询。
- Run detail 可查看 timeline、toolcalls、usage、artifacts、problems。
- Run detail 可查看 retrieval audit 与 context package。

### 16.5A Vivado Runtime

- 默认远程 target 可通过配置加载。
- `/api/health/vivado` 可检测 SSH、settings、vivado path、workdir、version、license。
- Agent 可执行 raw Tcl、Tcl script、flow、query、project open/create。
- batch 和 long-lived Tcl session 均可用。
- project mode 与 non-project mode 均可用。
- Vivado command 全量 log 保存为 artifact。
- stdout/log 可通过 SSE 实时展示。
- Vivado errors/warnings/critical warnings/message IDs 被强制解析并进入 ProblemCollector。
- Stop 可 interrupt/terminate/kill Vivado job，并记录事件。
- 本地/远程路径映射正确。
- 文件同步记录可查询。
- 生成的 Tcl script 均保存 artifact 并可在 Monitor 中查看。

### 16.6 KB

- Vivado/parser/tool 问题被 harness 强制收集。
- 失败 run 自动生成 pending KB candidate。
- 用户可 approve/reject/merge candidate。
- Built-in YAML KB 与 user SQLite KB 合并查询。

### 16.7 多 Agent 扩展

- 事件、run、artifact、channel 数据结构支持 agent_id。
- Agent 间 channel message 可记录。
- Monitor 可按 agent 展示 token/tool/time。

### 16.8 测试

必须覆盖：

- 后端 pytest。
- 前端 unit tests。
- Playwright e2e。
- 手动验收 checklist。

重点测试：

- SSE reconnect。
- Stop partial 保存。
- 服务重启恢复。
- tool error problem collection。
- KB candidate workflow。
- Semantic KB indexing/reindex。
- Context Builder token budget 与注入优先级。
- Retrieval audit 可回放。
- Vivado remote health。
- Vivado Tcl policy approval。
- Vivado file sync/path mapping。
- Vivado stop/kill。
- session archive/hard delete。

---

## 17. 分阶段实施计划

分阶段实施是为了降低工程风险；每个阶段均必须服从本文档的长期架构，不引入与目标架构冲突的临时设计。

### Phase 1：核心持久化与 React Terminal

目标：

- SQLite repository。
- projects/sessions/tasks/messages/events/runs/tool_calls/llm_usage/artifacts 基础表。
- 新 project/session/task/event API。
- Project 创建校验 root path、Synthia YAML、Vivado `.xpr`、器件与默认 Vivado 配置。
- 旧单层 sessions 自动迁移到 Project。
- SSE stream + reconnect。
- Stop API。
- React/Vite/TS terminal。
- OpenAPI 类型化 client。
- Monitor Phase 1 API：runs/toolcalls/usage。
- Vivado target schema 与默认远程 target 配置读取。
- Vivado health check。

### Phase 1F：React Frontend Refactor

目标：

- 以 visual design gate 先确定 Terminal/Monitor/Vivado/KB 的生产级设计方向。
- 用可扩展 module system 重构当前 `frontend/src`。
- 新前端只依赖 `/api/v1`。
- 接入 OpenAPI generated client。
- 使用普通 CSS + design tokens 替代大面积 inline style。
- 使用 `react-markdown` + `remark-gfm` 渲染模型输出。
- 使用 `lucide-react` 和 `clsx` 构建统一 UI primitives。
- Terminal 使用 messages + events + SSE reducer 作为权威 UI 状态来源。
- 实现 projects 首页、project detail + sessions、terminal chat/timeline/debug drawer。
- 实现 monitor run list + run detail + toolcalls/usage/events。
- 实现 Vivado target/health/command history 框架。
- 实现 KB cases/candidates 审核界面。
- `npm run build` 与浏览器主流程验证通过。

### Phase 2：记忆与摘要

目标：

- 持久化 LangGraph checkpointer。
- AgentContextBuilder。
- memory_snapshots。
- 摘要模型接口。
- reasoning/tool summary。
- token budget 裁剪。
- context package 与 context audit。
- Error KB + Semantic KB 统一注入。
- retrieval audit。

### Phase 2A：Semantic KB 与向量检索

目标：

- Global KB / Project KB。
- knowledge source/chunk/embedding schema。
- VectorStore 抽象。
- EmbeddingProvider 抽象。
- 文档/RTL/XDC/script/run/session summary ingestion。
- hash 增量 reindex。
- 手动 reindex API/UI。
- query rewrite、entity extraction、metadata filter、vector search、rerank、min score threshold。
- 权威度/可信度评分。
- knowledge search tools。

### Phase 3：Harness 强制观测与 KB Candidate

目标：

- ObservedToolRunner。
- harness RunContext/EventSink。
- ProblemCollector。
- Vivado/parser/tool 强制 problem collection。
- KB candidate 自动生成。
- KB API 与审核 UI。
- Vivado Runtime Adapter 接入 ObservedToolRunner。
- Vivado log/report 强制 problem collection。

### Phase 3A：Vivado 全命令 Runtime

目标：

- VivadoTarget local/remote。
- RemoteExecutor：ssh/scp 与 paramiko 抽象。
- FileSync：hash 增量同步、SFTP/SCP/rsync 抽象。
- PathMapper：Windows local path <-> remote Linux path。
- TclPolicy：allowlist/denylist/approval。
- Raw Tcl/script/flow/query/project tools。
- Batch mode。
- Long-lived Tcl session。
- Project/non-project mode。
- Stop/interrupt/kill。
- Vivado command artifacts/log parser/problem collector。
- CLI：`edagent vivado tcl/script/health/session/targets`。

### Phase 4：Monitor Dashboard 完整化

目标：

- charts。
- token/cost 趋势。
- tool error rate。
- run detail artifacts/problems/events。
- retention/cleanup。
- LangSmith/OTel export adapter。

### Phase 5：多 Agent 协作

目标：

- agent identity。
- agent runs。
- channel store。
- file communication protocol。
- handoff events。
- multi-agent monitor graph。
- SSE 展示多 Agent 消息流。

---

### Phase 6：Synthia Industrial Tool Connector Platform

目标：将 Synthia 从 Vivado 专用 Agent 升级为可扩展的工业软件 Agent 平台，同时复用现有 Agent Harness、SSE Timeline、Approval、Monitor、Context Builder 和 Vivado Runtime Adapter。

交付物：

- Connector SDK：`ToolConnector`、`ToolCapability`、`ToolManifest`、`ToolRunRequest`、`PreparedRun`、`ToolRunResult`、`ParsedReportBundle`、`ToolErrorSummary`。
- Connector Registry 与 `/api/v1/connectors`、`/capabilities` API。
- Vivado Connector：包装现有 Vivado Runtime Adapter，提供标准 `validate_project`、`run_synthesis`、`run_implementation`、`run_simulation`、`parse_artifacts`、`classify_error` 能力。
- Controlled Execution 合同：所有 connector 执行都通过 ObservedToolRunner / Controlled Execution，禁止裸 shell。
- Structured Reports：Timing、Utilization、DRC、Methodology 结构化落库。
- Report UI：Run Detail 中展示 parsed reports、artifact、problem、history compare。
- PatchProposal：connector-aware diff、risk、approval、apply、rerun、before/after compare。
- WorkBuddy 接入：Skill 只调用 Synthia API，不直接执行 Vivado。
- 第二 connector 样板：Verilator/XSim/Yosys 任选其一，用来证明 Agent Core 不依赖 Vivado。

验收标准：

1. Agent Planner 输出 capability plan，而非 Vivado 命令。
2. Vivado synth/impl/sim 均可通过 `VivadoConnector` 执行并生成 Step、Artifact、ParsedReport、Problem。
3. 前端 Run 页面可以同时看到 timeline、steps、reports、artifacts、approval。
4. Context Builder 可以注入 connector environment、manifest、parsed report、tool error summary、artifact index。
5. 新增第二 connector 时不修改 Agent Core 的工具执行主流程。

## 18. 配置项

建议配置：

```yaml
runtime:
  dir: .edagent
  db_path: .edagent/edagent.db
  artifact_root: .edagent/artifacts

sse:
  heartbeat_seconds: 15
  reconnect_backoff_ms: 1000
  max_replay_events: 1000

memory:
  recent_message_limit: 20
  max_context_tokens: 64000
  summary_model: ""
  summarize_after_messages: 20

knowledge:
  vector_store: ""
  embedding_provider: ""
  embedding_model: ""
  rerank_model: ""
  default_top_k: 12
  min_score: 0.3
  enable_query_rewrite: true
  enable_rerank: true
  global_kb_enabled: true
  project_kb_enabled: true
  auto_reindex_on_hash_change: true
  authority_weights:
    official_doc: 1.0
    verified_user_kb: 0.9
    approved_case: 0.85
    project_doc: 0.75
    historical_run_summary: 0.65
    session_summary: 0.55
    pending_candidate: 0.3

vivado:
  default_target: default-remote
  targets:
    default-remote:
      type: remote_ssh
      host: root@192.168.31.150
      ssh_key: E:/dev/id_192.168.31.150
      vivado_path: /home/xilinx/vivado/Vivado/2022.1/bin/vivado
      settings_path: /home/xilinx/vivado/Vivado/2022.1/settings64.sh
      remote_work_root: /tmp/edagent_remote
      version: "2022.1"
  file_sync:
    method: sftp
    use_hash_incremental: true
  tcl_policy:
    require_approval_for_raw_tcl: true
    require_approval_for_dangerous_commands: true
    deny_patterns:
      - exec
      - file delete
      - open "|"
      - rm -rf
  session:
    enable_long_lived: true
    idle_timeout_sec: 1800
    command_timeout_sec: 3600
  stop:
    interrupt_timeout_sec: 10
    terminate_timeout_sec: 20
    kill_after_timeout: true

monitor:
  retention_days: 90
  redact_paths: false
  collect_token_usage: true
  collect_cost: true

kb:
  auto_generate_candidates_on_failed_run: true
  auto_approve: false

models:
  primary:
    provider: anthropic_compatible
    name: ""
  summary:
    provider: anthropic_compatible
    name: ""
```

---

## 19. 关键实现边界

### 19.1 LLM 不负责事实采集

LLM 可以总结，但不能作为唯一事实来源。事实必须来自：

- harness。
- parser。
- tool wrapper。
- command runner。
- event sink。
- artifact store。

### 19.2 前端不保存权威状态

浏览器只保存 UI 偏好和 last seq。权威状态来自 API/SQLite。

### 19.3 大内容不直接进数据库

数据库保存摘要、路径、hash、引用；大内容进入 artifact store。

### 19.4 SSE 是长期实时协议

多 Agent 也使用 SSE 进行前端实时展示。Agent 间通信通过文件 channel 和持久化事件表达。

### 19.5 单 worker 部署约束

当前 SSE queue、approval gate (`vivado_run_gate`)、HITL interaction store、file-batch、`patch_auto_approve` 在线缓存等运行时状态都驻留在单进程内存。Spec 接受这一现实，但要求：

- 后端默认以**单 uvicorn worker** 启动。多 worker 部署明确不支持。
- 所有运行时状态都必须**可由 events 表 + settings 表完整重建**：
  - Pending interaction 重启后由 `rehydrate_session_interactions(session_id)` 从 `interaction.requested` / `interaction.responded` 重放还原。
  - 审批开关由 `settings` 表持久化。
  - Vivado gate 状态可丢失：服务重启等价于"所有 pending Vivado 请求被拒"，前端必须能识别并提示用户重新申请。
- 集群部署（多 worker / 多进程）属于未来工作，需要把上述状态迁到外部 broker（Redis / SQLite advisory lock / NATS）后才可启用。当前实现不得依赖跨进程一致性。

---

## 22. 自进化（Self-Evolution）

### 22.1 目标

让 EdAgent-Vivado 在长期使用中从两类来源积累"经验"，并以受控、可观测、可回滚的方式把经验注入到下一次 Agent 执行：

- 显式信号：用户反馈、Run 结果（QoR/timing/log）、问题累积、审批通过率、回归 eval set。
- 隐式信号：reasoning summary、tool 摘要、memory snapshot 中的高置信片段。

自进化是**附加层**，从不强制覆盖；任何 surface 都必须可在不变更 SPEC §8 主流程的前提下被禁用或回滚。

### 22.2 进化面（Surface）

| Surface | 影响 | 默认级别 | A/B 是否允许 | 沙箱要求 |
|---|---|---|---|---|
| `kb` | Error/Semantic KB 条目 | Level 0 / 1 | 否（用 KB candidate 既有审批流） | 无 |
| `prompt` | Per-project system prompt overlay | Level 0 | 可选 Level 1 | 无 |
| `tool` | 启用/禁用工具、新增进化工具 | **Level 0 only** | 否 | AST whitelist + sandbox import |
| `flow_template` | Per-project Tcl 流程模板 | Level 0 / 1 | 可选 Level 1 | 单元测试通过后才能 promote |
| `routing` | Supervisor 多 agent routing 权重/规则 | Level 0 / 1 | 可选 Level 1 | 无 |

> Level 0 = 仅生成 candidate，必须人工审批；Level 1 = 自动应用为 shadow overlay 进 A/B 实验，胜出后进入"待 merge" 状态等待人工确认；Level 2/3 spec 暂不支持。

### 22.3 Overlay 解析与优先级

任何 surface 的有效配置由 **resolver** 统一返回，调用顺序如下：

```text
project-scope active overlay  →  global-scope active overlay  →  baseline (codebase 内嵌)
```

每个 surface 的 resolver 必须满足：

- 无 overlay 时返回 baseline，且不抛异常。
- 必须可以由配置开关临时禁用，例如 `EDAGENT_EVOLUTION_DISABLE=prompt,tool`。
- 每次解析必须写一条 `evolution.overlay.resolved` 事件（payload: surface/project_id/overlay_id 或 null），供 monitor 追溯。

### 22.4 数据模型

```sql
CREATE TABLE evolution_candidates (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                -- session | project | global
  project_id TEXT,
  session_id TEXT,
  surface TEXT NOT NULL,              -- kb | prompt | tool | flow_template | routing
  candidate_type TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT,
  signal_source_json TEXT,            -- 触发本 candidate 的信号快照
  diff_artifact_id TEXT,              -- 改动正文（overlay payload diff）
  baseline_artifact_id TEXT,          -- 应用前的 overlay snapshot
  confidence REAL,
  status TEXT NOT NULL,               -- pending|approved|rejected|merged|rolled_back|trialing
  created_by TEXT NOT NULL,           -- harness|evolver|user|run|recurrence
  created_at INTEGER NOT NULL,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  applied_overlay_id TEXT,
  metadata_json TEXT
);

CREATE TABLE overlays (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                -- project | global
  project_id TEXT,
  surface TEXT NOT NULL,
  name TEXT,
  state TEXT NOT NULL,                -- active | shadow | retired
  payload_json TEXT NOT NULL,
  source_candidate_id TEXT,
  parent_overlay_id TEXT,
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  metadata_json TEXT
);

CREATE TABLE evolution_trials (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  project_id TEXT,
  surface TEXT NOT NULL,
  baseline_overlay_id TEXT,
  variant_overlay_id TEXT,
  state TEXT NOT NULL,                -- running | completed | reverted
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  n_baseline INTEGER NOT NULL DEFAULT 0,
  n_variant INTEGER NOT NULL DEFAULT 0,
  metric_baseline_json TEXT,
  metric_variant_json TEXT,
  decision TEXT,                      -- variant_wins|baseline_wins|tie|insufficient_data
  decided_at INTEGER,
  metadata_json TEXT
);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT,
  message_id TEXT,
  user_thumb INTEGER,                 -- +1 | 0 | -1
  comment TEXT,
  tags_json TEXT,
  created_at INTEGER NOT NULL,
  metadata_json TEXT
);

CREATE TABLE metric_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT,
  task_id TEXT,
  run_id TEXT,
  overlay_id TEXT,
  trial_id TEXT,
  arm TEXT,                           -- baseline|variant|none
  scope TEXT NOT NULL,                -- task|session|project|global
  window TEXT NOT NULL,               -- single|rolling_10|rolling_50|all
  metrics_json TEXT NOT NULL,
  composite_score REAL,
  created_at INTEGER NOT NULL,
  metadata_json TEXT
);

CREATE TABLE eval_runs (
  id TEXT PRIMARY KEY,
  eval_set TEXT NOT NULL,
  overlay_id TEXT,
  state TEXT NOT NULL,                -- placeholder|queued|running|completed|error
  started_at INTEGER,
  finished_at INTEGER,
  total_cases INTEGER,
  passed INTEGER,
  failed INTEGER,
  metric_summary_json TEXT,
  metadata_json TEXT
);
```

### 22.5 进化范围与晋升路径

```text
session 行为
  → session-scope candidate（pending；仅 session 内可影响 retrieval/prompt 临时层）
  → 用户在 review UI 中 approve / session 结束指标改善触发自动晋升
  → project-scope overlay（active，作用于该 Project 所有新 session）
  → 多 Project 反复 approve 同一 normalized candidate
  → global candidate（pending；必须人工审批）
  → global overlay（与 built-in baseline 同级，但优先级低于 project overlay）
```

Session-scope candidate 不直接进 overlays 表；它由 ContextBuilder 在本次 task 临时注入。Project / global overlay 才会写入 overlays 表并被 resolver 长期使用。

### 22.6 信号源

| 信号 | 数据源 | 触发条件（SE-PR3 实现常量） | 产生 surface |
|---|---|---|---|
| `recurrence` | `problems.normalized_signature`（最近 30 天） | 同一 normalized signature 在 ≥ 3 个 distinct session 中出现 | `kb` |
| `repeated_failure` | latest project-scope `metric_snapshots(window=rolling_10)` | `first_run_success < 0.4` 且 `sample_size ≥ 5` | `prompt` |
| `negative_feedback` | `feedback`（project 范围，最近 10 条非空 thumb） | 负面 thumb ≥ 3 | `prompt` |
| `approval_drop` | latest project-scope `metric_snapshots(window=rolling_10)` | `approval_pass_rate < 0.5` 且 `sample_size ≥ 5` | `prompt` |
| `routing_drift` | 最近 20 个 task 的 `messages.role='user'` + `tool_calls.tool_name` | 同一 specialist 的关键词（timing/constraint/synthesis）在 ≥ 3 个 task 出现但对应工具一次都没被调用 | `routing` |
| `flow_template_reuse` | 最近 40 个 task 的成功 `run_vivado_script_tool` 调用 | 同一**归一化**（去注释 + 去空白）的 Tcl 脚本出现 ≥ 3 次 | `flow_template` |
| `eval_set` | `eval_runs` + `tests/eval_set/*.yaml` | 占位；SE-PR6 起 schema + CLI (`edagent eval`) + API (`POST /api/v1/evolution/eval/run`) 可用，runner 仍在后续 PR 中 | n/a |

Dedup 约定（generators 必须遵守）：每个 candidate 的 `signal_source_json.signal_key` 是 `<signal>:<normalized_key>` 形式；同 surface + 同 project + 同 `signal_key` 的 pending candidate 唯一。当上一轮 candidate 已 `rejected / merged / rolled_back` 时，下一次信号触发允许生成新 candidate。

### 22.6A A/B Trial 引擎（SE-PR5）

每个 surface 可选 opt-in 到 A/B 模式（per-project flag，存于 `settings`：`evolution.trial.<surface>.<project_id>`）。`tool` surface 永远拒绝（SPEC §22.2）。

启用后，`approve_candidate` 不再直接写 active overlay：

1. 创建 `state=shadow` 的 overlay，记录 candidate 已合成的 payload。
2. 写一条 `evolution_trials(state='running')`：`baseline_overlay_id` 指向当前 active overlay（可为空），`variant_overlay_id` 指向 shadow overlay。
3. candidate.status = `trialing`。
4. 发出 `evolution.trial.started` 事件；先前 active overlay **不退役**，继续服务 baseline 分支的任务。

调用方仍可传 `force_active=True` 绕过 trial 直接 apply（紧急回滚或人工裁定）。

**Arm 分配**：`_run_agent` 在调用 agent 之前为该 project 下所有 running trial 调用 `assign_arms_for_task(project_id, task_id)`，按 `md5(task_id || trial_id) % 2` 确定 baseline / variant。结果以 `{surface: (arm, overlay_id, trial_id)}` 形式放入 contextvar `evolution_task_arms`，同时落库到 `tasks.metadata_json.evolution_arms`。

**Resolver 优先级**：`active_overlay(surface, project_id)` 优先读取 contextvar。如果该 surface 在当前 task 中有 arm 分配，则直接返回 `overlay_id` 对应的行（variant 分支 → shadow overlay；baseline 分支 → 老 active overlay）。无 arm 时回退到 §22.5 的原始优先级。每个事件发出 `evolution.trial.assigned`。

**Metric 收集**：SE-PR2 的 `collect_task_metrics` 读取 `tasks.metadata_json.evolution_arms`，除了写 task-scope 主 snapshot 外，还为每个 arm 写一条额外 snapshot 并调用 `trials.record_snapshot(trial_id, arm, composite_score)`。Trial 行内的 `n_baseline / n_variant / metric_baseline_json / metric_variant_json` 滚动更新。

**判定**：每个 `task.done` 后，`_run_agent` 对该 task 涉及的 trial 调用 `maybe_decide_trial`：

- `n_baseline ≥ MIN_SAMPLES_PER_ARM` **且** `n_variant ≥ MIN_SAMPLES_PER_ARM`（默认 10）→ 计算 `delta = mean(variant) - mean(baseline)`：
  - `delta ≥ DECISION_MARGIN`（默认 0.05）→ `variant_wins`：retire baseline overlay，把 variant overlay 由 `shadow` 升级为 `active`，candidate.status=approved。
  - `delta ≤ -DECISION_MARGIN` → `baseline_wins`：retire variant overlay，candidate.status=rejected（metadata.ab_decision=`baseline_wins`）。
  - 其他 → `tie`：retire variant overlay，candidate.status=rejected（metadata.ab_decision=`tie`）。
- 启动 14 天后未决 → 自动 `abort_trial`，candidate 回到 pending。

**操作覆盖**：`POST /api/v1/evolution/trials/{id}/decide { decision }` 允许 operator 在样本不足时强制决策；`POST /api/v1/evolution/trials/{id}/abort` 手动放弃 trial，variant 退役、candidate 回 pending。

**事件**：

```text
evolution.trial.started        # approve_candidate 进入 trial 路径时
evolution.trial.assigned       # 每个 task 启动时，每个 arm 一条
evolution.trial.completed      # decide 落定（自动或 force）
evolution.trial.reverted       # abort_trial / max-age 触发
```

**约束**：

- `tool` surface 永远不能进 A/B（`set_trial_enabled` 与 `start_trial` 双重拒绝）。
- A/B 决策仍是"L1 自动应用"——variant_wins 自动把 shadow 升级为 active，无需人工二次确认。SPEC §22.11 的"10% / 3 窗口自动 rollback"独立于 A/B 决策依然生效，A/B 之后的劣化触发常规 rollback。

### 22.6B Eval set 占位（SE-PR6）

静态回归集是后续 A/B / drift detection 的"地面真值"，但 runner 还没写。SE-PR6 落地以下骨架，所有面都标注 `runner_implemented=false`，把"等运行器到位"和"已经能录入提案"解耦：

**YAML 约定**（位于 `tests/eval_set/<name>.yaml`，文件名 stem 必须等于 `name` 字段；强制 `[a-z0-9_-]` 且 `cases` 非空、`cases[].id` 唯一、`cases[].question` 非空）：

```yaml
name: smoke
description: 短描述（可选）
cases:
  - id: parse-synth-log
    question: |
      给 agent 的自然语言问题…
    project_id: 可选；指定后 runner 使用该 project 的 overlay
    expected:
      contains: ["WNS", "timing"]      # 必须全部出现
      not_contains: ["TODO"]
      tool_calls_any: ["parse_timing_tool"]
      tool_calls_all: []
      max_task_tokens: 8000
      min_first_run_success: null
    metadata: {}                         # 自由字段（tag、owner、关联 candidate）
```

`expected` 中的字段为 forward-compatible 约定；SE-PR6 的 loader 只校验结构，runner 在落地时再消费打分语义。

**存储**：

`eval_runs` 表已经在 SE-PR1 schema 里，本 PR 写入 `state='placeholder'`、`metadata_json.spec_section='22.6B'`，并保留 `total_cases` / `case_ids` / `note` / `path` 等字段。Runner 实装后将复用同一表行迁移状态：

```text
placeholder ─► queued ─► running ─► completed | error
```

**API**：

```
GET    /api/v1/evolution/eval/sets           # discovery
GET    /api/v1/evolution/eval/sets/{name}    # cases detail
GET    /api/v1/evolution/eval/runs           # list eval_runs (filter by eval_set / state)
GET    /api/v1/evolution/eval/runs/{id}
POST   /api/v1/evolution/eval/run            # 写入 placeholder 行，返回 runner_implemented=false
```

**CLI**：

```
edagent eval                       # 列出 eval set 和最近 runs
edagent eval smoke                 # 提交 smoke 为 placeholder
edagent eval smoke --show-cases    # 展开 smoke 的 cases
edagent eval --status placeholder  # 按 state 过滤 runs
```

**事件**：

```
evolution.eval.queued       # SE-PR6 起在每次 placeholder 写入时发出
evolution.eval.started      # 占位事件名，等 runner
evolution.eval.completed    # 占位事件名，等 runner
evolution.eval.error        # 占位事件名，等 runner
```

`runner_implemented=false` 标记由 API 与 CLI 同时回传，明确告诉 reviewer "提案已记录但还不会真正执行"。当 runner 到位时唯一变化是该 flag 翻 true + state 进入 `queued / running / completed`，调用方不需改 schema。

### 22.7 度量与综合 score

每次 `task.done` 必须生成一条 `metric_snapshots` 记录（scope=`task`, window=`single`），紧接着对所在 project 触发 `rolling_10` 与 `rolling_50` 聚合写入。聚合器读取 task-scope 单点快照的最近 N 条，逐字段取均值（数值）/ 成功率（布尔）/ 求和（计数），并以 project-scope（或 global-scope，当 session 未绑定 project 时）写回。`all` 窗口可以按需在 monitor 查询时按需聚合，不要求每次 task.done 都写入。

字段：

```json
{
  "vivado_success_rate": 0.0,
  "first_run_success": false,
  "wns_ps": 120,
  "tns_ps": 0,
  "lut_util_pct": 18.4,
  "ff_util_pct": 9.1,
  "drc_clean": true,
  "task_tokens_total": 12450,
  "task_elapsed_sec": 42.1,
  "approval_pass_rate": 0.91,
  "user_thumb_score": 1,
  "composite_score": 0.78
}
```

`composite_score` 计算：

```text
0.40 · norm(WNS)
+ 0.25 · norm(first_run_success)
+ 0.15 · norm(approval_pass_rate)
+ 0.10 · norm(1 / task_tokens_total)
+ 0.10 · norm(user_thumb_score)
```

权重在 `evolution_config` 中可调（per-project metadata）。缺失值贡献中性 0.5，部分遥测不会导致 score 崩塌。

### 22.8 候选生命周期

```text
proposed ─approve──▶ approved ──apply──▶ overlay.active
   │
   ├──reject──▶ rejected
   │
   ├──trial (Level 1)──▶ trialing ──decision──▶ approved / rejected
   │
   └─auto_rollback─▶ rolled_back
```

强制要求：

- 任何 surface 的 candidate 在被 apply 前必须保留先前 baseline 的恢复路径。SE-PR4 起的实现使用 `overlays.parent_overlay_id`：在 apply 新 overlay 前先 retire 当前 active overlay，并把它的 id 写入新 overlay 的 `parent_overlay_id`；rollback 时 retire 当前 overlay 并把 `parent_overlay_id` 指向的行重新置为 `active`。`baseline_artifact_id` 字段仍保留给未来需要"快照非 overlay 形态 baseline"的场景（如重写 system prompt 时的整文件快照）。
- rollback 必须发出 `evolution.candidate.rolled_back` 与 `evolution.overlay.retired` 事件，并把当前 `overlays.state` 改为 `retired`。
- `tool` surface 的 candidate 必须额外通过 AST whitelist 检查（禁止 `exec` / `eval` / `subprocess` / `os.system` / 网络访问）并存为只读 artifact。
- **Reject suppression**：reject API 接受可选的 `suppress_days`，被设置后 generator dedup 会同时把"已 reject 且 `metadata.suppressed_until > now()`"的候选视为占位，阻止同 `signal_key` 在窗口内重复生成。`suppress_days=0`（默认）保持现有"reject 不阻挡"语义。
- **Tool 沙箱（SE-PR8）**：surface=`tool` 的 overlay payload 形如 `{disabled: [...], additional_tools: [{name, source, description?}]}`，每条 `source` 必须先通过 AST 白名单（允许的 import 集 = `re/json/math/hashlib/typing/dataclasses/pathlib/langchain_core.tools`；禁止 `exec / eval / open / __import__ / subprocess / os.* / 文件 IO / async / yield / 双下划线属性 / class 定义`），再通过 sandbox loader 在精简的 `__builtins__`（含一个 whitelist 化的 `__import__`）下 exec，最终拿到 LangChain `@tool` 函数注册到 agent 工具集合。`approve_candidate(surface=tool)` 必须传 `confirm_source_reviewed=True`（API 返回 403 否则），并对 `additional_tools[*].source` 在持久化前**再次**校验一遍，确保即便绕过 UI 预检也无法把不安全 payload 落库。Loader 按 sha256 缓存编译结果，resolver 端任何加载失败都被吞掉 + 警告日志，单条坏 tool 永远不会让 agent 启动失败。

### 22.9 API

```http
GET    /api/v1/evolution/candidates
GET    /api/v1/evolution/candidates/{id}
POST   /api/v1/evolution/candidates/{id}/approve
POST   /api/v1/evolution/candidates/{id}/reject
POST   /api/v1/evolution/candidates/{id}/merge
POST   /api/v1/evolution/candidates/{id}/rollback

GET    /api/v1/evolution/overlays?project_id=...&surface=...
POST   /api/v1/evolution/overlays/{id}/retire

GET    /api/v1/evolution/trials?project_id=...
POST   /api/v1/evolution/trials/{id}/decide

POST   /api/v1/feedback
GET    /api/v1/sessions/{id}/feedback

GET    /api/v1/metrics/summary?project_id=...&window=rolling_10
GET    /api/v1/metrics/series?project_id=...&surface=...

POST   /api/v1/evolution/eval/run      (SE-PR6 起占位返回 501)
GET    /api/v1/evolution/eval/runs
```

### 22.10 事件

```text
evolution.candidate.created
evolution.candidate.updated
evolution.candidate.approved
evolution.candidate.rejected
evolution.candidate.merged
evolution.candidate.rolled_back

evolution.overlay.applied
evolution.overlay.retired
evolution.overlay.resolved        # 每次 resolver 命中 overlay 时发一条（可被 EDAGENT_EVOLUTION_LOG_RESOLVE=0 关闭）

evolution.trial.started
evolution.trial.assigned          # task 被分入 baseline / variant
evolution.trial.completed
evolution.trial.reverted

evolution.metric.snapshot         # 每条 metric_snapshots
evolution.signal.fired            # 信号源命中阈值
```

### 22.11 安全护栏

- 任何 surface 在生产环境下默认 Level 0；Level 1 必须在 `/api/v1/settings/approvals`（或 evolution 设置面板）显式 opt-in，per surface 独立。
- `tool` surface 永远不允许 Level 1；候选必须由人审，并在二次确认对话中再次声明"我已阅读源码"。
- 任何 overlay 应用后 24 小时内必须有 metric_snapshot 写入；否则视为 "应用未生效"，自动 retire 并报警。
- 复合 score 在应用 overlay 后的 rolling_10 窗口内相对 baseline 下降 >= 10% 且持续 3 个窗口，触发自动 rollback。

### 22.12 SE-PR 实施分期

| PR | 范围 |
|---|---|
| **SE-PR1** | 表结构 + resolver indirection（no-op）+ 本章 §22 |
| SE-PR2 | feedback API + metric_snapshots post-task hook + rolling aggregator |
| SE-PR3 | 4 个 candidate 生成器（recurrence / repeated_failure / negative_feedback / approval_drop）+ `/evolution/candidates` 只读 API + `/evolution/generators/run` 手动触发 |
| SE-PR4 | approve/reject/merge/rollback/retire 后端 API + overlay 生命周期 + reject suppression + default payload synthesis（prompt/kb/flow_template/routing/tool）|
| SE-PR4b | React `/evolution` review UI |
| SE-PR5 | A/B trial engine（opt-in per surface）+ `/evolution/config` + `/evolution/trials/*` + trial UI 面板 |
| SE-PR6 | Eval set 占位：`tests/eval_set/*.yaml` 约定 + 加载/校验 + `/evolution/eval/{sets,runs,run}` + `edagent eval` CLI + UI 启动器（runner 桩，本 PR 不执行）|
| SE-PR7 | `routing_drift` 与 `flow_template_reuse` 两个真实 candidate 生成器；approve 时 default payload 直接读 `signal_source.suggested_payload` 把候选载体一次性应用为 overlay |
| SE-PR8 | Tool surface 沙箱：AST 白名单 + 精简 `__builtins__` exec + sha256 缓存；`approve(surface=tool)` 强制 `confirm_source_reviewed` 二次确认；`POST /api/v1/evolution/tools/validate` 给前端预检；UI 在 detail modal 渲染源码与"我已阅读源码"复选框 |
| SE-PR6 | eval set placeholder（schema + CLI 桩）|
| SE-PR7 | routing overlay + supervisor consult（含规则与权重）|
| SE-PR8 | tool surface（AST whitelist + sandbox loader）|

每个 SE-PR 都必须保证：当对应 overlay 不存在时，系统行为与本 SPEC 主体（§1–§19）一致。

---

## 20. 术语表

- **Session**：用户长期会话。
- **Task**：一次用户消息触发的后台执行。
- **Run**：可观测执行单元。
- **Event**：持久化事实事件。
- **Message**：LLM 上下文与聊天记录。
- **Artifact**：大文件或外部产物。
- **Channel**：多 Agent 文件通信通道。
- **Problem**：从工具、Vivado、parser、用户或 agent 检测到的问题。
- **KB Candidate**：待审核知识库条目。
- **Memory Snapshot**：session 长期记忆摘要。
- **Usage**：token/cost 记录。
- **Error KB**：结构化错误知识库，用于 pattern/signature/category 匹配。
- **Semantic Knowledge Base**：面向文档、代码、历史 run/session 的语义知识库。
- **Vector Store**：存储知识片段 embedding 的可替换向量数据库后端。
- **Context Package**：一次 LLM 调用前实际注入模型的上下文包。
- **Retrieval Audit**：一次知识检索与上下文选择过程的审计记录。
- **Authority Score**：来源权威度评分。
- **Trust Score**：内容可信度评分。
- **Vivado Target**：一个本地或远程 Vivado 执行环境。
- **Vivado Runtime Adapter**：封装 Vivado Tcl/script/flow/session 执行的统一运行层。
- **FileSync**：本地与远程 Vivado 工作区之间的文件同步抽象。
- **PathMapper**：本地路径与远程路径互相转换的映射层。
- **TclPolicy**：Vivado Tcl 命令安全策略与审批层。
- **Long-lived Tcl Session**：持续运行的 `vivado -mode tcl` 进程，可连续执行命令。
- **Evolution Surface**：自进化可改动的一类系统配置，包括 `kb / prompt / tool / flow_template / routing`。
- **Overlay**：单一 surface 在 project 或 global 范围内的有效覆盖层，应用于 baseline 之上。
- **Evolution Candidate**：尚未应用的 overlay 提案，必须经过 approve / merge / trial 才能生效。
- **Evolution Trial**：一组 baseline / variant overlay 的 A/B 实验，基于 `metric_snapshots` 评判胜负。
- **Composite Score**：综合 timing / first-run / approval / token / user 反馈的 0..1 分数，用于 A/B 与回滚判断。
