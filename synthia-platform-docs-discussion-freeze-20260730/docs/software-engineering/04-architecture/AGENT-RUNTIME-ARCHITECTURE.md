# Synthia Agent Runtime 架构

| 属性 | 内容 |
|---|---|
| 文档编号 | SYNTHIA-ARC-005 |
| 版本/状态 | v0.2 / 草案，待正式评审 |
| 日期 | 2026-07-30 |
| 上游 | SYNTHIA-GOV-003、SYNTHIA-ARC-001～004、SYNTHIA-FLOW-001/003/004/006、SYNTHIA-IF-001、SYNTHIA-PLAN-004 |
| 适用对象 | Synthia 平台软件 Agent Runtime 层；不覆盖 Core、Connector、数据层 |
| 选型依据 | 基于 `@oh-my-pi/pi-agent-core`（pi-agent-core）已发布版本的公开类型导出面复核，证据等级 C（第三方运行时库，参见 README §4）；选型结论的适用范围限于已复核版本，最终依赖版本与契约以实现期锁定版本为准 |
| 迭代记录 | v0.2：经 Tech Lead（gpt-5.6-sol）审查 + 后端/集成/文档三路开发（glm-5.2/kimi-k3）并行修订 + QA（gpt-5.6-terra）复核。关闭 2 个阻断项（ARC005-001 MCP 直连绕过 Core、ARC005-002 run_class 归属矛盾）和 10 个主要项（钩子签名/loader 装配/配置约束/确定性工具本地化/底座状态语义/TaskPackage 全字段/权限矩阵/协调协议/迁移检查清单/版本锁定）。已知限制见 §17 |

## 1. 目的与边界

本文定义 Agent Runtime 的技术选型、分层、实例模型、任务执行契约、工具接入、权限、人在回路、失败恢复和首期切片。Agent Runtime 是 Synthia 的受控执行层：它从 Workflow Engine 接收冻结 TaskPackage，调度 Agent 角色和模型产出候选，调用 Core API 与 Connector，并把工具调用、模型调用、人工干预、输出哈希和谱系如实回报给 Core。

Agent Runtime **不拥有**工程事实源、流程状态、门禁、基线、追踪图、批准权或发布权（参见 SYNTHIA-ARC-001 §3、SYNTHIA-FLOW-004 §1、SYNTHIA-ARC-002 §6 核心不变量 1-2）。它不是对话产品，不追求自由聊天、深层递归委派或多数投票。

## 2. 选型决策

### 2.1 选用 pi-agent-core 作为执行底座

Agent Runtime 采用 `@oh-my-pi/pi-agent-core`（以下简称"底座"）作为单次冻结任务的执行循环。底座提供 `Agent` 类与 `agentLoop()`：给定一组工具、系统提示、模型和消息，它驱动模型调用 → 工具调度 → 结果回填的循环，并以 `AgentEvent` 流和 `AgentMessage[]` 暴露全部过程。

底座的抽象边界与 Synthia 需求逐点对齐。以下钩子名称与签名基于已发布版本的类型定义复核（`agent.d.ts`/`types.d.ts`/`agent-loop.d.ts`）：

| Synthia 需求（SYNTHIA-FLOW-004） | 底座原生能力（已复核签名） | 备注 |
|---|---|---|
| 角色 Profile 注入 | `setSystemPrompt(v)` / `setModel(m)` | 9 种 Profile 对应不同提示与模型 |
| 工具集装配 | `setTools(AgentTool[])` | 替换公开工具数组；注意该方法本身不"冻结"或执行 RBAC，运行中仍可被宿主再次调用，权限须在 §6.1 两层独立强制 |
| 精确版本输入，禁用"最新文件" | `replaceMessages(AgentMessage[])` 显式装配上下文 | 不依赖宿主文件系统当前状态 |
| 人在回路中断/接管 | `steer(m: AgentMessage)` 在工具批次间隙注入；`interruptMode: "immediate"` 使 steering 在**下一个工具调用结束后**跳过批次剩余工具 | 当前正在执行的工具通常**不**被强制中止；只有声明为 interruptible 且正确处理 signal 的等待型工具才可协作提前结束 |
| 立即终止 | `abort(reason?)` | 终止运行 |
| 权限/数据域拦截 | `beforeToolCall`（构造选项或可重赋值的 `Agent` 属性）；签名 `(ctx: BeforeToolCallContext, signal?) => {block: true, reason?} \| {args} \| undefined` | `block` 阻止执行并产出 error tool result；`args` 替换并重校验 |
| 发模型前预检 | `setBeforeModelCall(fn)` / `addBeforeModelCall(fn)`；回调返回 `{stop: true, reason?: string}` | 返回 stop 终止请求，不发 `turn_start`，不计费 |
| 工具后谱系 | `afterToolCall`（构造选项或可重赋值属性）；签名 `(ctx: AfterToolCallContext, signal?) => AfterToolCallResult \| undefined` | 可覆盖结果字段 |
| 消息流谱系 | `onAssistantMessageEvent`（构造选项）/ `subscribe(fn)` | usage、provider、model |
| OpenTelemetry | `telemetry`（`AgentLoopConfig.telemetry`）；spans `invoke_agent`/`chat`/`execute_tool` | 接入平台可观测后端 |
| 候选输出标记 | `transformAssistantMessage(message, signal)` | 在 assistant message 入上下文/入 UI/派发前改写文本与工具参数 |

底座依赖 `@oh-my-pi/pi-ai`（统一模型适配：Anthropic/OpenAI/Gemini 等，含 `Model`/`ApiKey`/`streamSimple`/provider 发现）、`pi-utils`、`pi-natives`、`pi-wire`、`pi-catalog`。模型多路复用、流式、工具参数校验、Steering 中断、可选的 append-only 上下文缓存（`appendOnlyContext`）、OpenTelemetry 均由底座提供，Agent Runtime 不重写。

`AgentEvent` 联合包含 `agent_start`/`turn_start`/`turn_end`/`tool_execution_start`/`tool_execution_update`/`tool_execution_end`/`message_start`/`message_update`/`message_end` 等类型，**不含**独立的 `steer`/`abort` 事件。Runtime 必须在调用 `steer()`/`abort()` 时自行生成并持久化审计事件（接管人、原因、时间、影响），不依赖底座事件流提供。

### 2.2 复用 omp 的 MCP 客户端模块（由 Core 侧调用）

底座不内建 MCP 客户端。Synthia Connector 首切片以 MCP Server 形态部署（SYNTHIA-FLOW-006 §2、SYNTHIA-IF-001 §4），但 **Agent Runtime 不直接发现、连接或持有 MCP Server 连接**。Connector MCP Adapter 是 Connector Port 与 Worker 之间的可替换传输（SYNTHIA-ARC-003 §1、SYNTHIA-FLOW-006 §2），不是 Agent 与 Connector 之间的通道。

如果复用 `@oh-my-pi/pi-coding-agent`（omp）的 MCP 发现与加载函数（`discoverAndLoadMCPTools`）降低实现成本，该调用**必须由 Synthia Core 侧发起**，不是 Agent Runtime 侧。Agent Runtime 只看到 Core API 暴露的 Connector 操作（提交 Job、查询状态、获取证据描述符）。

omp MCP loader 产出的是包装对象 `LoadedCustomTool`（带 `path`/`resolvedPath`/`tool` 字段），真正可注入的是每项的 `.tool`（omp 自身也执行 `result.tools.map(loaded => loaded.tool)`）。生成的工具名规则为 `mcp__<sanitized_server>_<sanitized_tool>`，清洗可能碰撞。因此 **`allowed_tools` 不应按 omp 生成名授权**，而应按稳定 capability ID（Connector capability map 中的 operation + capability_version）建立不可混淆的授权映射。装配步骤：

1. 取得 MCP 加载结果（工具包装对象 + `MCPManager` 实例）；
2. 保留并管理 `MCPManager`（连接生命周期、断连、资源清理）；
3. 对每项执行 `loaded.tool` 提取，包装成 Synthia 自有 `AgentTool`；
4. 按原始 server identity、原始 MCP operation、capability version 建立授权映射；
5. 增加重复名/清洗碰撞拒绝测试。

omp 在本架构中**仅作为 MCP 客户端实现来源**，不作为 Agent 执行环境、会话容器、交互审批层或 coding 工具集。其 TUI、session JSONL、approval mode、bash/edit/grep 等内置工具、skills、扩展机制一律不进入 Agent Runtime 或 Core。

### 2.3 不采用 omp 全栈 / 其它框架的理由

omp 全栈（`pi-coding-agent` 的 `AgentSession`/RPC/TUI）设计为交互式 coding 工作台：默认 `approvalMode: yolo`、工作区等于宿主文件系统、会话持久化与 Core 事实源并行、内置 coding 工具与 Synthia 的最小权限模型（SYNTHIA-FLOW-004 §3/§4）冲突。在已复核版本范围内，强行适配需对抗其全部默认行为，且其 session 谱系与 Core 的 ToolRun 形成双轨记录。这一判断限于已复核版本；未来版本若提供更适合无头受控嵌入的接口，可重新评估。

LangGraph/LangChain 不内建模型多路复用、流式、工具校验、Steering 中断与 OpenTelemetry，采用它们等于重写底座已有部分。AutoGen/CrewAI 以对话/辩论/投票驱动，与"冻结任务、最小上下文、无自由聊天、无多数投票"（SYNTHIA-GOV-003 §6、SYNTHIA-FLOW-004 §1）范式冲突。

## 3. 分层模型

```text
Workflow Engine（G0～G9 状态，拥有流程真相）
        │  创建不可变 TaskPackage
        ▼
Synthia Task Runner（Runtime 宿主，本文档）
        │  TaskPackage → Agent 配置 + 工具网关 + 输入装配
        ▼
pi-agent-core Agent（单次冻结任务执行循环）
        │  beforeToolCall / afterToolCall / beforeModelCall 钩子
        ▼
工具：① 确定性本地工具（纯本地、无厂商执行、无外部副作用）
      ② Core API 工具（包装 Core 能力组，含 Connector/Run）
              │
              ▼
      Synthia Core API（事实源、RBAC、证据接纳、run_class 判定）
              │  Core 构造 JobRequest
              ▼
      Connector Port → Adapter（MCP/HTTP/Queue）→ Connector Worker
```

关键修正（相对 v0.1）：Agent Runtime **不直连 Connector MCP**。所有 Connector 操作经 Core API 的 Connector/Run 能力组提交，由 Core 构造 JobRequest（含权限校验、输入状态校验、run_class 判定），再经 Connector Port → Adapter → Worker 执行。这与 SYNTHIA-GOV-003 §3、SYNTHIA-ARC-001 §2/§5.2、SYNTHIA-ARC-003 §1、SYNTHIA-FLOW-006 §2 固定的控制链一致。

事实源归属：

| 对象 | 事实源 |
|---|---|
| 工程域、门、基线、追踪、批准、ToolRun/Evidence 索引 | Synthia Core（元数据库，SYNTHIA-ARC-004 §2） |
| 工具运行（命令/返回码/原始日志） | Connector Worker；经接纳协议登记进 Core（SYNTHIA-ARC-004 §3） |
| 任务执行过程（模型调用、工具调用、steering、usage） | Agent Runtime → 写入 Core 的 provenance/ToolRun 投影 |

底座（`pi-agent-core`）维护可变的进程内执行状态：`AgentState`、`AgentMessage[]`、steering/follow-up 队列（`peekSteeringQueue`/`peekFollowUpQueue`），并暴露 `replaceMessages`/`popMessage`/`clearMessages`/`reset`。这些是进程内执行状态，**不是**工程权威状态，**不替代** Core 的事实源角色。`appendOnlyContext` 是可选配置（用于稳定 prompt 前缀以命中 provider 缓存），不是 `AgentMessage[]` 的固有不变量。Runtime 必须主动将每次输入装配、模型请求结果、工具前后事件、steer/abort 决策和输出哈希幂等地写入 Core（§9），不依赖底座持久化业务状态。

## 4. Agent 实例模型

SYNTHIA-FLOW-004 §2 定义 9 种专业角色 Profile，MVP 用 6 个逻辑实例承载（§2.1）。在 Agent Runtime 中：

| MVP 逻辑实例 | 承载角色 | 典型工具集 | 权限上限 |
|---|---|---|---|
| 编排 | Orchestrator | Workflow 查询、校验 API、任务/交接 | P1（任务/交接候选写入）；不生成技术结论 |
| 需求与标准 | Standards + Requirements | 需求规则、术语/冲突检查、条款映射 | P2（确定性检查 + 候选写入） |
| 设计 | Architecture + Detailed Design | 建模/静态分析辅助、约束候选 | P2 |
| RTL | RTL | 编译/Lint 等低影响工具（P2）、Connector Job 申请（P3） | P3 |
| 验证 | Verification | 仿真申请（P3）、分析工具、覆盖 | P3；不从 DUT 实现复制为唯一参考期望 |
| 保证 | Assurance（初期承载 Vivado Analysis） | 追踪、配置、质量校验、Connector 只读查询 | P3 |

角色与实例是多对一映射：9 种 Profile 不因 MVP 合并为 6 实例而删减；同一逻辑实例在不同任务中以不同 `systemPrompt`/`setTools` 表现不同角色。Vivado Analysis 只有在 RT-UART 对照评测证明稳定收益时才拆为独立运行实例（SYNTHIA-FLOW-004 §2.1）。

默认拓扑为"1 个生成 Agent + 1 个保证/审查 Agent + 确定性工具 + 人类阶段门"（SYNTHIA-GOV-003 §6）。Task Runner 按该拓扑分别创建多个 `Agent` 实例并独立执行，由 Workflow Engine/Orchestrator 汇集候选与差异；Agent 之间不共享可写上下文。

### 4.1 多 Agent 协调协议

多 Agent 团队通过专业分工、受控交接和相互校验提高工程质量，不是多个模型自由聊天或多数投票（SYNTHIA-FLOW-004 §1）。协调机制：

- **Task/Handoff DAG**：Orchestrator 把子阶段拆分为 Task 和 Handoff，形成有向无环图；每个 Task 有冻结的输入 Schema 和输出 Schema（SYNTHIA-FLOW-004 §5）。
- **冻结 I/O Schema**：生成 Agent 和复核 Agent 使用不同的任务上下文和明确的审查清单；同一模型可承担不同角色进行早期原型，但不能把角色分离误报为人员/模型独立性（SYNTHIA-FLOW-004 §9）。
- **分歧保留**：Agent 间分歧时保留各自候选、依据和置信；确定性规则先消除 Schema/算术/接口/来源问题；Assurance 生成分歧摘要；技术分歧由人类角色决策并形成 Decision 制品（SYNTHIA-FLOW-004 §8）。
- **人工 Decision 闭环**：禁止用简单多数投票决定安全关键设计、标准裁剪、测试通过、豁免或发布（SYNTHIA-FLOW-004 §8）。
- **委派深度**：默认委派深度 ≤ 2（Orchestrator → 生成/复核）；终止条件为所有 Task 的 acceptance_checks 通过或人类决策介入。
- **G1～G4 调用表**：系统需求候选（Requirements + Standards → Assurance 复核 → G1）；PLDS SRS/派生（Requirements → Architecture + Verification + Assurance → G2）；结构/详细设计（Architecture + Detailed Design → Verification + Assurance → G3）；RTL/XDC（RTL → Detailed Design + Assurance → G4）；TB/参考模型（Verification → Requirements + Assurance → G4/G7）；B2 提交（Orchestrator 汇集 → 人类设计/验证/配置 → G4）（SYNTHIA-FLOW-004 §7）。

## 5. 任务执行契约

Task Runner 接收 SYNTHIA-FLOW-004 §5 的 TaskPackage，翻译为一次底座执行。映射关系：

| TaskPackage 字段 | 底座配置 / Runtime 处理 |
|---|---|
| `task_id/type` | 进入运行身份、ToolRun provenance 和策略选择 |
| `project/workflow_stage` | 进入所有 Core API/Job 请求的 `project_id`/`process_instance_id`/`gate` |
| `actor_role/model_profile` | `setSystemPrompt(roleProfile.prompt)` + `setModel(modelProfile)` |
| `input_artifact_ids`（精确版本/哈希） | 通过虚拟 URI（§7）或 Core API 读取，`replaceMessages()` 装配为冻结上下文；禁止隐式使用最新文件 |
| `context_manifest`（提示/知识片段/模板/规则清单与哈希） | 装配进系统提示与首条用户消息；哈希进入 ToolRun provenance |
| `expected_output_schema` | 由 Assurance/确定性校验工具在候选落库前按清单执行并保存结果；底座 `transformAssistantMessage` 不替代工程校验 |
| `allowed_tools/permissions` | `setTools()` 装配；超出集合的调用由 `beforeToolCall` 拦截（fail-closed） |
| `acceptance_checks` | 候选提交前按清单执行确定性校验并保存结果；失败则候选不得提交 |
| `timeout/cancel/retry` | `deadline`、`abort()`、Task Runner 层的幂等重试 |
| `classification`（数据域） | `beforeToolCall`/`beforeModelCall` 沿数据域标签过滤；数据域从来源向派生制品继承（SYNTHIA-ARC-004 §7） |

缺少 TaskPackage 或输入版本不明确时，Task Runner 拒绝创建 Agent，不猜测（SYNTHIA-FLOW-004 §5）。所有字段及 manifest 哈希进入 provenance。

### 5.1 端到端数据流示例

以 G4 RTL 候选生成 + 独立审查为例（典型"1 生成 + 1 审查"拓扑）：

```text
① Workflow Engine 冻结 TaskPackage（B1 设计输入、RTL 角色、allowed_tools、expected_output_schema）
② Task Runner 创建 RTL Agent（setSystemPrompt + setModel + setTools[Core API 工具 + 确定性工具]）
③ RTL Agent 经 Core API 读取批准 B1（精确版本 + 哈希校验），replaceMessages 装配上下文
④ RTL Agent 产出 Verilog/XDC 候选 → Core API 候选写入（ArtifactRevision: candidate）
⑤ Task Runner 创建 Assurance Agent（独立上下文、审查清单）
⑥ Assurance Agent 对冻结 GateSubmission 快照执行 gate_check：
   经 Core API 提交运行意图（operation=compile/lint/cdc, run_class 目标=gate_check）
   → Core 判定 run_class=gate_check（绑定 GateSubmission ID）
   → Core 构造 JobRequest → Connector Port → Worker → 返回 job_id
⑦ Worker 执行 Vivado compile/lint，返回原始报告 + EvidenceManifest
⑧ Core 复算哈希、登记证据、更新 ToolRun 投影
⑨ Assurance Agent 读取报告（经 Core API，非直连 Worker），产出审查结论（candidate）
⑩ 人类查看差异 + 原始报告 + 谱系，批准/拒绝 G4 → 建立 B2
```

关键：步骤⑥中 Agent 只提交运行意图，Core 判定 run_class 并构造 JobRequest；Agent 不直连 Connector Worker，不持有 MCP 连接。

## 6. 工具接入与权限网关

Agent 可调用两类工具，统一注册为底座 `AgentTool`（v0.1 的"三类"已修正——Connector 操作不直接作为 Agent 工具，而是经 Core API 提交）：

1. **确定性本地工具**（P2）：纯本地、无厂商执行、无外部副作用的 Schema 校验、追踪不变量检查和静态规则检查。**编译、仿真、CDC/RDC 综合检查不属于此类**——它们是 Connector 强类型能力（SYNTHIA-FLOW-006 §6.2/§6.3、SYNTHIA-ARC-003 §4.1），必须经 Core → Connector Port → Worker 执行。
2. **Core API 工具**（P0-P3）：包装 Core 能力组（SYNTHIA-IF-001 §3），包括 Project/Process 查询、Artifact/Revision 候选写入、Trace 候选、Connector/Run（提交 Job 意图、查询状态、获取证据描述符）和 Knowledge 检索。每个工具调用经 Core API 命令信封（身份、项目、预期版本、幂等键，SYNTHIA-IF-001 §2）提交，Core 在服务端执行同一权限判定。

### 6.1 权限双层强制

权限在两层独立执行，任一层失效不影响另一层。权限按 FLOW-004 §3 的 P0-P5 分级和 §4 的角色矩阵判定，**不单凭工具名或 `allowed_tools` 集合**：

| 层 | 机制 | 判定内容 |
|---|---|---|
| Agent Runtime（纵深防御） | 底座 `beforeToolCall(ctx, signal)` | 工具是否在 TaskPackage `allowed_tools` 内；operation 是否超出该角色的 P0-P3 上限；参数是否符合数据域、路径和网络策略；不符合返回 `{block: true, reason}` |
| Synthia Core API（兜底） | 服务端 RBAC + 授权上下文 | Agent 服务身份调用 P4/P5 端点（批准/拒绝/豁免/基线/发布/码流/硬件写）直接拒绝并记安全事件（SYNTHIA-IF-001 §3、SYNTHIA-ARC-001 §7） |

P0-P5 与角色/operation 的映射（引用 SYNTHIA-FLOW-004 §3/§4）：

| 权限 | 含义 | Agent 可持 | 典型 operation |
|---|---|---|---|
| P0 只读 | 读取被授权制品和状态 | 是 | 查询需求、读取报告、只读 Connector 查询 |
| P1 候选写入 | 在隔离区创建候选制品/差异 | 是 | 生成 SRS、RTL、TB、任务/交接 |
| P2 受控工具 | 调用白名单确定性检查 | 是 | Schema、Lint、追踪、静态规则 |
| P3 EDA 执行申请 | 创建 Connector Job 意图，需策略/适用时人工授权 | 是（上限） | 仿真、综合、实现 |
| P4 工程批准 | 批准/拒绝、接受风险/豁免、建立基线 | **否（仅人类）** | — |
| P5 发布/硬件 | 生成/发布码流、下载、VIO/ILA | **否（仅人类触发）** | — |

所有 Agent 最高只能持有 P3，且 P3 只表示可申请 Connector Job，不表示可授权执行、接受运行结果或批准工程门（SYNTHIA-FLOW-004 §3）。

`beforeModelCall`（经 `setBeforeModelCall(fn)` 设置）在每次发模型前检查装配后的提示是否越域；越域返回 `{stop: true, reason}`，不发起该次请求、不计费、不留开放 turn（SYNTHIA-ARC-004 数据域继承）。

### 6.2 关于"skill"

Synthia 文档体系中无"skill"概念。其它语境下的对应物在本架构中由四者组合表达：① 角色 Profile（`systemPrompt`）；② 任务契约 `allowed_tools`；③ Connector 强类型能力（capability map，SYNTHIA-FLOW-006 §6）；④ 批准知识库条目（带来源/状态/版本/数据域/失效条件，见 SYNTHIA-FLOW-005 §11 知识库与评测集契约）。Agent 不加载外部插件式技能；能力被任务契约（上侧裁剪）与 Connector capability map（下侧声明）共同夹定。

## 7. 输入装配与工作区隔离

Agent 不直接读取宿主工程文件系统。输入经两条受控通道：

- **Core API 读取**：精确版本的制品/需求/设计/RTL 以 `AgentTool` 调用形式获取，返回候选差异或批准视图，不暴露文件路径。
- **虚拟 URI**：必要时以宿主侧 scheme（如 `synthia://artifact/<id>@<rev>`）映射到只读内容，Agent 通过工具读取，写入只能落到候选命名空间。

每任务使用隔离工作区。`cwd` 是工具执行的当前目录参数，**不是**安全隔离边界——进程内嵌入模式下 Agent 与宿主共享进程内存，`cwd` 无法阻止越权内存访问。MVP 采用进程内嵌入时以独立 `cwd` 与内存会话约束，但这仅适合单租户私有化的受控信任域，不满足多租户或不可信 Agent 的隔离要求。生产采用子进程隔离时每 Agent 一进程，`cwd` 指向临时隔离目录，制品经虚拟 URI 往返，Agent 不接触真实工程目录、凭据、跨项目数据（SYNTHIA-FLOW-004 §10）。

## 8. 人在回路

人在回路在 Agent Runtime 层的落点：

| Synthia 机制（SYNTHIA-FLOW-003） | Runtime 实现 |
|---|---|
| 人工中断/接管 | `Agent.steer(msg)` 在工具批次间隙注入；`interruptMode: "immediate"` 使 steering 在下一个工具调用结束后跳过批次剩余工具；`abort()` 立即终止。注意：当前正在执行的工具通常不被强制中止 |
| 接管不擦除历史 | 底座 `AgentMessage[]` 为进程内可变状态；steering/abort 由 Runtime 生成独立审计事件（`AgentEvent` 联合中无 steer/abort 类型）并写入 Core 的接管记录（接管人、原因、修改、影响） |
| 阶段门批准 | 不在 Agent Runtime；Runtime 仅产出候选与证据，放行由 Core 的 GateSubmission/ApprovalRecord 完成（SYNTHIA-FLOW-003 §4） |
| 审批界面要求（SYNTHIA-FLOW-003 §10） | Runtime 经 `subscribe()` 上报 tool_call/tool_result/usage/diff 原始事件供 Web 审批界面渲染；禁止只上报 Agent 的"建议通过"摘要 |

人工可随时对一个运行中的 Agent 注入 steering 消息或中止；这些动作与 Agent/工具的既有输出一并保留为谱系，符合"人工接管记录接管人、原因、修改、影响，不擦除 Agent/工具历史"（SYNTHIA-FLOW-001 §7）。

## 9. 谱系与度量

Runtime 经下列渠道采集谱系并写入 Core。谱系分三类契约：

| 类别 | 采集渠道 | 写入 Core 目标 |
|---|---|---|
| 模型调用 | `subscribe()`（`message_*` 事件）、`onAssistantMessageEvent` | usage（input/output/cache/cost）、provider、model、提示/模板版本 |
| 工具调用 | `afterToolCall`、`subscribe()`（`tool_execution_*` 事件） | 工具名、参数、结果、耗时、ToolRun 关联 |
| 运行级 | `telemetry`（OpenTelemetry spans `invoke_agent`/`chat`/`execute_tool`）、`transformAssistantMessage` | 输出哈希、上下文 manifest 哈希 |

**先登记后执行**：Core API 工具调用和 Connector Job 意图在执行前先在 Core 登记（创建 ToolRun 记录），执行后回填结果。**fail-closed**：谱系采集失败（如 Core 不可达）时，Runtime 标记任务失败而非静默继续，避免谱系缺口。

记录模型/服务版本、提示/模板版本、推理参数、上下文 manifest 哈希、工具调用、输出哈希、人工修改与最终处置（SYNTHIA-FLOW-004 §12）。度量任务一次通过率、返工、缺陷类型、人工修改量、错误建议与门禁影响；不以"减少人工审批次数"为单一成功指标（SYNTHIA-FLOW-003 §11）。

## 10. 嵌入模式

| 模式 | 形态 | 适用 | 取舍 |
|---|---|---|---|
| 进程内嵌入（MVP） | Task Runner 直接 `new Agent(...)`，内存会话 | D3：G1～G4 跑通，单租户私有化 | 低延迟、易调试；Agent 崩溃影响宿主；隔离仅靠 cwd，**非生产安全边界** |
| 子进程隔离（生产） | 每 Agent 一子进程，stdio 控制平面 | 多 Agent 并行、生产、强隔离 | 进程崩溃不传染；权限与工作区物理隔离；多一层 IPC |

### 10.1 迁移判定条件与检查清单

从进程内切换到子进程模式的判定条件：① 多 Agent 并行执行；② 不可信或半可信 Agent 身份；③ 多租户或多项目并发；④ 生产部署。迁移检查清单：

1. 工具网关接口在两种模式下行为一致（`AgentTool` 签名不变）；
2. 虚拟 URI 在子进程模式下经 host 通道往返；
3. 权限双层（`beforeToolCall` + Core RBAC）在子进程中独立执行；
4. 谱系采集在子进程模式下经 IPC 回传，不丢失；
5. 子进程崩溃检测与 Core 侧恢复点一致；
6. 资源清理（进程退出、临时目录、连接断开）完整。

## 11. 失败与恢复

底座维护可变的进程内执行状态（`AgentState`/消息/队列），**不是**无状态。Runtime 必须主动将状态写入 Core 以支持恢复。

| 失败 | Runtime 处理 |
|---|---|
| 模型输出不符 Schema | 标记任务失败，保留原输出；Task Runner 层有限次修复重试（SYNTHIA-FLOW-004 §11） |
| 输入冲突/缺失 | 创建澄清问题，不产出假设性正式成果 |
| 工具调用失败 | 经 `afterToolCall` 保存参数/返回码/部分证据，交诊断而非伪装成功 |
| 超时/取消 | `deadline` 到期或 `abort()`；状态置 `timeout/cancelled`；仅幂等任务允许重新排队 |
| Agent 越权请求 | `beforeToolCall` 拒绝、告警并记安全事件 |
| 人工修改 | 产生新候选版本与差异，重新执行受影响检查 |
| 进程崩溃（子进程模式） | Task Runner 检测退出，从 Core 侧最近一致 ToolRun/provenance 点恢复；不自动重放非幂等操作；未持久化的 steering/follow-up 队列丢失 |

恢复检查点内容：已登记的 ToolRun、已写入 Core 的 provenance、候选 ArtifactRevision、GateSubmission 快照。恢复前重新验证输入状态和授权（SYNTHIA-ARC-004 §4）。

非幂等硬件写操作由 Connector 标记 `unknown_effect` 并要求人工检查，Agent Runtime 不自动重试（SYNTHIA-FLOW-006 §10）。

## 12. 边界与风险

| 项 | 说明 | 缓解 |
|---|---|---|
| 底座依赖活跃演进 | `pi-agent-core`/`pi-ai` API 可能变更 | 版本锁定（§15）；Task Runner 作为适配层吸收变更；CI 跑契约测试覆盖钩子与工具签名 |
| omp MCP 模块耦合 | MCP 客户端实现取自 omp，由 Core 侧调用 | 仅依赖 loader 产出（`loaded.tool` 提取）；禁用 project-level discovery（`enableProjectConfig: false`）；受控 cache storage 或禁用缓存；任务结束/失败时调用 `manager.disconnectAll()`；Connector 为自研 MCP Server，必要时替换为自写薄客户端 |
| 数据出域风险 | 模型 provider 端点可能在外网 | `ModelRegistry` 仅注册受控/私有端点；`getApiKey` 绑定受控凭证；`beforeModelCall` 校验提示数据域 |
| 底座不理解 candidate/approved | Agent 可能"以为"任务完成 | 系统提示明确"仅产出候选"；Core 永不据 Agent 输出直接置 `approved`（SYNTHIA-ARC-002 §6 不变量 1-2）；`transformAssistantMessage` 可强制标注 |
| omp 默认行为泄漏 | 若误用 omp 全栈会带入 yolo/coding 工具 | 仅 import MCP loader（Core 侧）；Runtime/Core 不实例化 omp 的 `AgentSession`；出厂配置禁用交互审批 |
| omp loader 配置发现 | loader 默认允许 project-level `.mcp.json` | 显式关闭；仅从已批准的 PlatformConfiguration 注入 server allowlist、transport、证书/服务身份、数据域和 capability 版本；TaskPackage 执行期间不接纳 late registration |

## 13. 与 Connector 的关系

Agent Runtime 通过 Core API 的 Connector/Run 能力组与 Connector 交互，**不直连** Connector MCP Server 或 Worker。调用链：

```text
Agent 调用 Core API 工具（Connector/Run 能力组）
  → Core 校验权限、输入状态、授权上下文
  → Core 判定 run_class（exploratory / gate_check / formal）
  → Core 构造 JobRequest
  → Connector Port → Adapter（MCP/HTTP/Queue）→ Connector Worker
  → Worker 执行，返回原始证据
  → Core 复算哈希、登记 EvidenceManifest、更新 ToolRun 投影
  → Agent 经 Core API 获取结果摘要和证据描述符
```

run_class 由 Core 判定（**不由 Runtime 填入**），判定规则（SYNTHIA-FLOW-006 §5、SYNTHIA-IF-001 §5）：

- Agent 提交运行意图（operation、目标输入引用、期望输出）；
- Core 根据输入状态判定：候选输入 → `exploratory`；冻结 GateSubmission 快照 → `gate_check`（绑定提交，快照变化即失效）；批准且有效的 Baseline/ApprovedGateResult → `formal`；
- Agent 可提交 `formal` 运行意图，但 Core 只在输入确实为批准且有效的 Baseline 或 ApprovedGateResult 时才构造 `formal` JobRequest；否则降级为 `exploratory` 或拒绝（不满足 `gate_check` 绑定条件）；
- 硬件写操作另需目的绑定授权和资源锁。

提交返回 `job_id`，大对象只返回 `artifact_id/uri/sha256/...`（SYNTHIA-IF-001 §4、SYNTHIA-FLOW-006 §7）。Connector `succeeded` ≠ 工程门通过（SYNTHIA-FLOW-006 §6）；Runtime 不据 Connector 成功判定放行。

## 14. 首期实现切片

按 SYNTHIA-PLAN-004 的 WP-7 与 D3 节点：

1. Task Runner 骨架：TaskPackage 全字段解析 → `Agent` 配置 + 工具网关 + 虚拟 URI；
2. 9 角色 Profile 的 `systemPrompt`/模型映射，由 6 逻辑实例承载（Profile 不随实例合并删减）；
3. Core API 工具集（Project/Process 查询、Artifact 候选写入、Trace、Connector/Run 意图提交、Knowledge 检索）作为 `AgentTool`；
4. Core 侧 Connector MCP loader 接入（omp `discoverAndLoadMCPTools`，Core 调用），连接首个 Vivado Connector MCP Server；
5. `beforeToolCall`/`setBeforeModelCall` 权限与数据域拦截（fail-closed）；
6. `afterToolCall`/`subscribe`/`telemetry` 谱系写入 Core（先登记后执行）；
7. 用 RT-UART 跑通 G1～G4，验证 `gate_check`/`formal` 隔离（Core 判定 run_class）与三组编排对照。

子进程隔离、Vivado Analysis 独立实例、更多模型/provider、自写薄 MCP 客户端等后置。

## 15. 第三方依赖证据与版本锁定

| 依赖 | 角色 | 证据等级 | 版本锁定策略 |
|---|---|---|---|
| `@oh-my-pi/pi-agent-core` | Agent 执行循环（`Agent`/`agentLoop`/钩子/`AgentTool`/`AgentEvent`） | C（第三方运行时库，已发布版本类型定义复核） | 锁定具体版本；CI 跑钩子签名契约测试；Task Runner 适配层吸收 API 变更 |
| `@oh-my-pi/pi-ai` | 统一模型适配（`Model`/`ApiKey`/`streamSimple`/provider 发现） | C | 同上 |
| `@oh-my-pi/pi-coding-agent`（omp） | MCP 客户端 loader（`discoverAndLoadMCPTools`），仅 Core 侧调用 | C | 仅依赖 loader 产出；不依赖 Agent/session/TUI；版本锁定 |

断言 → 证据映射：§2.1 钩子签名依据 `agent.d.ts`/`types.d.ts`/`agent-loop.d.ts` 已发布类型定义；§2.2 loader 产出依据 omp MCP 运行时文档。所有断言的适用范围限于已复核版本。升级时必须重跑契约测试和历史基线重现验证；回滚需要 ImpactAssessment（SYNTHIA-PLAN-004 §5）。

表述范围约束：本文档对 pi-agent-core/omp 行为的描述限于已复核版本的公开类型导出面和官方文档。不声称这些行为在未复核版本中保持不变。

## 16. 不进入首期切片

- omp 全栈 AgentSession/RPC/TUI 与内置 coding 工具；
- Agent 自由聊天、递归委派、多数投票、共享可写工作区；
- 任意 shell/Tcl 工具（自定义 Tcl 仍走 SYNTHIA-FLOW-006 §7 的 `propose_tcl` 通道）；
- Agent 持久化业务状态（事实源归 Core）；
- Agent 直接批准、豁免、建立基线、发布码流或执行硬件写。

## 17. 已知限制与后续深化（v0.3 待办）

以下为 QA 复核（ARC005-006/008/010/011/012/013/014/015/016）标注的深度不足项，非技术错误，列入 v0.3 深化范围：

- §6.1 需补充逐角色 × 逐 operation × 逐 run_class 的完整 P0–P5 授权矩阵（含 FLOW-004 §3 允许的"获准低风险 gate_check 申请"如何判为 P2），使 Runtime 与 Core 执行同一策略判定；
- §5/§6 需补全 Core API AgentTool 的命令/查询信封（correlation_id、causation_id、classification、查询视图选择、候选父修订与预期版本、冲突稳定错误码、重试 attempt 与幂等键关系），对齐 SYNTHIA-IF-001 §2/§6 与 SYNTHIA-ARC-002 §7；
- §4.1 需写明并发候选的显式合并规则（携带父修订、冲突后合并策略），保证不违反 ARC-002 §7 的禁止静默覆盖；
- §5.1 需补充 formal Job 的完整端到端时序（含 task/snapshot/manifest hash/authorization/idempotency 字段、对象检疫接纳、失败/取消/重试路径）；
- §9 需定义独立的 AgentTaskRun/ModelCall/AgentToolCall 谱系契约及其与 Connector ToolRun 的关联，所有事件按 IF-001 §6 带 event_id/聚合序号/actor/classification/payload_hash/脱敏参数；
- §7/§10 需落实进程内 MVP 的 OS 身份/沙箱、只读挂载、凭据代理、egress allowlist、资源限额和销毁取证（对照 FLOW-004 §10、ARC-001 §7）；
- §2/§15 需记录实际复核的精确依赖版本、lockfile integrity、源提交、许可证/SBOM 和复核日期，使 C 级证据可重现；
- §5/§6/§12 需将 classification 映射到 provider/endpoint/地域/保留/训练/缓存/遥测策略，在上下文装配前强制最小化与脱敏（对照 ARC-004 §7）。
