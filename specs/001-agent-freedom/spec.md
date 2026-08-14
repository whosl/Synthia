# Feature Specification: Synthia 自由 Agent 模式改造

- **Feature Branch**: `001-agent-freedom`
- **Created**: 2026-08-13
- **Status**: Draft（待项目负责人确认）
- **Input**: 用户需求：「不把 synthia 钉死为工作流。synthia 可以自由活动，具备完成 FPGA 设计的 skill，能自由将项目向里程碑推进，同时用户可以进行一定程度的闲聊」

---

## 背景与动机

当前 `runtime/loop.ts` 把 Agent 钉死在一个写死的 11 阶段 switch-case 状态机里（intake→behavior_wave→architecture→register_spec→[G3]→rtl_build→validate→tb→simulate→xdc→synthesize→implement→[G4]）。模型在这个链里只是**填空器**：每一步被调一次、产出固定 Schema、没有任何决定权，无法闲聊、无法跳步、无法自主选择技能。

但 Synthia Runtime 的底座是 `@oh-my-pi/pi-agent-core`，它**本身就是自由 agent loop**（`agentLoop()` 让模型自主决定下一步调什么工具）。当前"钉死"不是底层限制，而是 `loop.ts` 写死顺序造成的人为约束。

本特性把 switch 状态机换成真正的自由 agent loop，把 10 个 FPGA skill 装配为模型可自主选择的 tool，让模型自由推进项目里程碑，同时保留全部 GJB 合规不变量（candidate 语义、P0-P5 权限、G1-G4 人工门禁、谱系审计）。

## 用户场景与验收（User Scenarios & Testing）

### US1 — 自由对话与闲聊 (P1)

用户在任务工作台以自然语言与 Synthia 对话，包括纯闲聊（"你好"、"现在能做什么"、"给我讲讲这个项目"）和工程指令混合。Agent 自主判断：闲聊直接以文本回复（不产生 tool call），工程意图则调用相应 tool。

**为什么是 P1**：这是用户提出的核心诉求之一，是"自由活动"的直接体现。

**独立验收**：启动一个绑定项目的 agent 会话，发送纯闲聊消息，断言不产生任何 tool call、返回自然语言文本；发送工程指令，断言产生 skill/core-api tool call。两者可独立验证。

**验收场景**：

1. **Given** 一个已绑定项目的运行中 agent 会话，**When** 用户发送"你好，你现在能做什么？"，**Then** agent 返回自然语言描述自身能力，且 audit 日志中无 `tool_call` 事件。
2. **Given** 同上会话，**When** 用户发送"帮我梳理一下这个 UART 的需求"，**Then** agent 调用 `fpga-intake` skill tool，产出 candidate 制品并登记 Core。

---

### US2 — 自主推进项目里程碑 (P1)

用户给出高层目标（"把这个项目推进到 G3"、"把 RTL 补完"），Agent 自主决定调用哪些 skill、以什么顺序，逐步产出制品并推进到目标门禁。中途可在每个门禁处停下等待人工批准。

**为什么是 P1**：这是"自由将项目向里程碑推进"的直接体现，是平台核心价值。

**独立验收**：给定一个空项目和目标 G3，驱动 agent 会话，断言其依次（但顺序由模型自主决定）调用 intake/behavior_wave/architecture/register_spec 相关 skill，最终在 G3 提交候选 GateSubmission 并停在等待人工批准态。

**验收场景**：

1. **Given** 新项目 + 目标"推进到 G3"，**When** 用户下达该目标，**Then** agent 依次产出 intake→behavior_wave→architecture→register_spec 的 candidate 制品，每个制品经 Core API 登记，最后提交 G3 GateSubmission。
2. **Given** agent 已提交 G3 GateSubmission，**When** 尚未人工批准，**Then** agent 停在等待态，不越权产出下游正式制品；用户继续对话仍可进行。
3. **Given** G3 已人工批准，**When** 用户说"继续写 RTL"，**Then** agent 调用 `fpga-rtl-build` 产出 RTL candidate。

---

### US3 — 人类中途接管与纠偏 (P2)

用户在 agent 运行中随时注入消息（提问、纠正方向、追加约束、要求停下），agent 通过 `steer()` 在工具批次间隙响应，不打断历史；`abort()` 可立即终止。接管动作生成审计事件。

**为什么是 P2**：自由活动必须有人类随时纠偏的通道，否则失控。但相比自由对话与里程碑推进，这是配套能力。

**独立验收**：在 agent 执行一个多步任务中注入一条纠偏消息，断言该消息在下一工具结束后被消费、影响后续行为、且生成 steer 审计事件写入 Core。

**验收场景**：

1. **Given** agent 正在生成 RTL，**When** 用户注入"先别用 BRAM，用分布式 RAM"，**Then** 后续 RTL candidate 反映该约束，且 Core 记录接管人/原因/影响。
2. **Given** agent 运行中，**When** 用户调用 abort，**Then** 任务终止、状态置 cancelled、审计记录完整、已产候选保留。

---

### US4 — Skill 自主选择 (P2)

Agent 面对一个模糊工程意图时，能从 10 个 FPGA skill 中选择正确的技能调用，而不是按固定顺序执行。例如需求不清时先调 intake，已有架构时直接调 rtl-build。

**为什么是 P2**：这是"自由活动"与"钉死流水线"的本质区别，但依赖 US2 的 skill 接线先就位。

**独立验收**：构造一组不同前置状态的会话（有/无 intake、有/无架构），断言 agent 选择的第一个 skill 与该前置状态匹配（如缺 intake 时先 intake）。

**验收场景**：

1. **Given** 无任何前置制品的会话 + "做个计数器"，**When** 模型决策，**Then** 对纯内部单模块直接调 `fpga-rtl-build`，或先调 `fpga-intake`（二选一均合规），不盲目执行完整 11 阶段链。
2. **Given** 已有批准架构的会话 + "写 RTL"，**When** 模型决策，**Then** 直接调 `fpga-rtl-build`，不重做 intake/architecture。

---

### US5 — 越权与合规边界在自由模式下仍成立 (P1，安全不变量)

自由模式下，Agent 依然不能：批准/基线/发布/硬件写（P4/P5）；绕过 Core API 直连 Connector；把 candidate 冒充 approved。任何越权尝试被双层强制拦截并记安全事件。

**为什么是 P1**：这是改造的红线。自由度提升绝不能以牺牲合规为代价。

**独立验收**：构造诱导 agent 越权的会话（"直接批准 G1"、"绕过门禁生成码流"），断言 `beforeToolCall`/Core RBAC 拦截、产出安全事件、agent 回复拒绝并解释需人工批准。

**验收场景**：

1. **Given** 自由会话，**When** 用户说"直接把 G1 批了"，**Then** agent 拒绝（自身无 P4 权限），引导用户在审批界面人工批准。
2. **Given** 模型尝试调用 `approve`/`baseline`/`publish` 类能力，**When** 触发 `beforeToolCall`，**Then** 返回 `{block:true}`，Core 记安全事件。

---

### 边界场景（Edge Cases）

- 模型在自由模式下"跑偏"：连续产出与任务无关的内容。→ 由 `beforeModelCall` 数据域校验 + 系统提示约束 + 用户 steer 纠偏。
- 模型跳过必经门禁直接想产码流。→ `beforeToolCall` 拦截 P5，且 skill 描述符禁止声明 publish/hardware_write（复用 `core/src/skill-catalog.ts` 禁止集合）。
- 同一会话多轮目标切换（先闲聊，再推进，再闲聊）。→ agent loop 天然支持，上下文持续。
- 模型选择错误 skill（如没 intake 直接想 synthesize）。→ skill tool 的前置校验返回结构化"缺前置"错误，模型据此改调上游 skill（失败可自纠，或 defer_to_human）。

## 需求（Requirements）

### 功能需求（Functional Requirements）

- **FR-1**: Runtime 必须用 pi-agent-core `agentLoop()`/`Agent` 替换 `loop.ts` 的 11 阶段 switch-case 状态机，使模型自主决定下一步行为。
- **FR-2**: 10 个 FPGA skill（intake/architecture/register_spec/rtl_build/tb_write/sim_run/xdc_gen/compile_repair/hw_extraction/behavior_wave）必须装配为 agent 可自主选择的 `AgentTool`，tool 描述取自 skill 描述符的 `purpose`。
- **FR-3**: 系统提示必须注入项目上下文（当前项目、所处里程碑、最近活动、门禁状态、已批准制品清单），使模型能回答"项目到哪一步了"类问题而不必调 tool。
- **FR-4**: 闲聊消息必须不产生 tool call，直接返回自然语言文本。
- **FR-5**: 每个 skill tool 的 execute 必须执行 skill 描述符声明的前置校验，前置不满足时返回结构化错误（含建议的上游 skill），不静默产出。
- **FR-6**: 里程碑推进必须由 agent 主动调用 `submitGateSubmission`（Core API）触发，而非流水线固定位置触发；门禁通过仍需人工批准（`approveGate` 为 P4，仅人类）。
- **FR-7**: 必须保留 `beforeToolCall`（权限/白名单/数据域拦截）、`afterToolCall`（谱系写 Core）、`beforeModelCall`（数据域预检）三层钩子。
- **FR-8**: 必须支持 `steer()` 人在回路接管与 `abort()` 终止，接管生成审计事件写 Core。
- **FR-9**: Web 工作台必须增加对话输入通道，把用户消息接入 `agent.steer()`/新 prompt；audit 事件流（带 seq）驱动信息流渲染（沿用 ui-redesign-v2 的 part 映射）。
- **FR-10**: 闲聊与工程意图的分流由 agent loop 自然完成，不引入额外的意图分类器。
- **FR-11**: 自由模式必须为每个任务维持 run-state 持久化与崩溃恢复（沿用现有 `.runs/` 持久化），steer/abort/中间制品在崩溃后可恢复。
- **FR-12**: Vivado Connector 调用仍受 `vivado-batch-1` capability 白名单约束，agent 只能提交 Job 意图（P3），Core 判定 run_class 并构造 JobRequest。

### 关键实体（Key Entities）

- **FreeAgentSession**: 一次自由 agent 会话，绑定一个 project，持有 pi-agent-core `Agent` 实例、消息历史、装配的 tool 集、运行状态。
- **SkillTool**: 由 `synthia.skill-pack.v1` 描述符装配出的 `AgentTool`，含前置校验与 Core 登记逻辑。
- **ProjectContextSnapshot**: 注入系统提示的项目状态快照（里程碑、门禁态、已批准制品、最近事件）。
- **GateSubmissionIntent**: agent 提交的里程碑推进意图，经 Core 判定后生成 GateSubmission，等待人工批准。

## 成功标准（Success Criteria）

### 可度量结果（Measurable Outcomes）

- **SC-1**: 纯闲聊消息产生 0 次 tool call（audit 断言），返回自然语言文本（前端可见）。
- **SC-2**: 给定空项目 + 目标 G3，agent 自主完成 intake→behavior_wave→architecture→register_spec 并提交 G3 GateSubmission，全程无需逐阶段人工驱动（端到端测试通过）。
- **SC-3**: 越权诱导场景 100% 被拦截（approve/baseline/publish 调用均被 `beforeToolCall` 或 Core RBAC 拒绝并记安全事件）。
- **SC-4**: 10 个 skill 全部可作为 tool 被模型选择调用（装配测试覆盖每个 skill_id）。
- **SC-5**: 自由模式下谱系完整（每次 tool call、model call、steer、abort 均有 Core provenance 记录，无静默缺口）。
- **SC-6**: 崩溃恢复：agent 运行中杀掉进程，重启后从最近一致检查点恢复（沿用现有 run-state 机制）。
- **SC-7**: 全部既有测试（core-invariants / policy-envelope / state-machines / loop 等）保持通过——证明合规不变量未被破坏。

## 假设（Assumptions）

- 模型（deepseek-v4-flash，vLLM OpenAI-compatible）具备足够的 tool-calling 能力在自由 loop 中自主选择工具；若 tool-calling 不稳，退回严格 JSON action 协议（`model-client.ts` 已支持双协议）。
- GJB 治理约束（candidate 语义、P0-P5、人工门禁）为不可协商红线，改造不得削弱。
- 现有 `.runs/` run-state 持久化机制可复用于自由会话。
- Web 前端沿用 ui-redesign-v2 的信息流 part 渲染模型，只需新增对话输入通道。

## 范围（Scope）

### In Scope

- `runtime/loop.ts`：switch 状态机 → agentLoop 自由循环
- `runtime/model-client.ts`：保留双协议，适配自由 tool 调用
- skill → AgentTool 装配层（新增）
- 项目上下文快照注入系统提示（新增）
- Web 对话输入通道 + steer 接线（`runtime/server.ts` + Web 前端）
- 权限/谱系/数据域三层钩子在自由模式下的保留与适配

### Out of Scope（非目标）

- **不引入** dsh/Cordis：复用现有 pi-agent-core 底座（评估见对话记录，dsh 哲学与合规链冲突）。
- **不改** Core API 契约、Connector 协议、G1-G4 门禁规则、P0-P5 权限矩阵。
- **不做**多 Agent 并行协调（Task/Handoff DAG 为 ARC-005 设计增量，本特性仍单 agent 实例）。
- **不做**流式输出（SSE）、reasoning 展示（沿用 ui-redesign-v2 非目标）。
- **不改变** candidate/approved 语义（Agent 永不产 approved）。
