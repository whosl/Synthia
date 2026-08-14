# Tasks: Synthia 自由 Agent 模式改造

- **Branch**: `001-agent-freedom`
- **Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md)
- **Status**: Draft

任务按 spec-kit 惯例组织：Setup → Foundational → 各 User Story（US1-US5，按优先级）→ Polish。每个 User Story 阶段独立可交付、独立可测。

图例：`[P]` = 可并行；`[USn]` = 属于某 User Story。

---

## Phase 1: Setup

- [ ] T001 在 `runtime/` 建立 free-agent 分支脚手架：`free-agent.ts` / `skill-tools.ts` / `context-snapshot.ts` 空骨架与导出类型
- [ ] T002 [P] 在 `runtime/types.ts` 定义 `FreeAgentSession` / `SkillTool` / `ProjectContextSnapshot` / `GateSubmissionIntent` 类型（对齐 spec 关键实体）
- [ ] T003 [P] 验证底座 pi-agent-core 在本仓库可用：确认 `Agent`/`agentLoop`/`steer`/`abort`/`beforeToolCall`/`afterToolCall`/`beforeModelCall`/`subscribe` 的导入路径与签名（对照 ARC-005 §2.1 复核表）

## Phase 2: Foundational（所有 User Story 的前置）

- [ ] T010 实现 `ProjectContextSnapshot`（`runtime/context-snapshot.ts`）：经 Core API 拉取当前项目、所处里程碑（G1-G4）、最近 GateSubmission 态、已批准制品、最近事件，渲染为系统提示段
- [ ] T011 [P] 实现 SkillToolAssembler 核心（`runtime/skill-tools.ts`）：读 `skills/fpga/skill-pack.json`，每个 skill → `AgentTool`（name=skill_id，description=purpose）
- [ ] T012 [P] 在 SkillToolAssembler 中实现 skill execute 前置校验：读 skill 描述符 `preconditions`，不满足时返回结构化错误（含建议上游 skill），不静默产出
- [ ] T013 实现 `FreeAgentSession`（`runtime/free-agent.ts`）：包装 pi-agent-core `Agent`，绑定 projectId，暴露 `prompt()`/`steer()`/`abort()`，挂三层钩子
- [ ] T014 将三层钩子接入 FreeAgentSession：`beforeToolCall`（P0-P5 + capability 白名单 + 数据域）、`afterToolCall`（谱系写 Core）、`beforeModelCall`（数据域预检）——逻辑复用现有 `loop.ts`/`model-client.ts`
- [ ] T015 复用 `.runs/` run-state 持久化到 FreeAgentSession：每步落盘，崩溃可恢复（沿用现有 `RunState` 机制）
- [ ] T016 Foundational 测试：`free-agent.test.ts` 骨架——会话创建、上下文注入、三层钩子挂载断言

**Checkpoint**：FreeAgentSession 可创建、可 prompt、钩子生效。后续 User Story 可并行。

## Phase 3: US1 — 自由对话与闲聊 (P1)

**Goal**：闲聊直接文本回复（0 tool call），工程意图触发 tool。

**Independent Test**：绑定项目会话，发闲聊断言无 `tool_call` 事件；发工程指令断言有 skill tool call。

- [ ] T101 [US1] 在 `runtime/server.ts` 新增 `POST /tasks/:runId/message`：把用户消息接入 `session.prompt()`，返回 audit 事件增量
- [ ] T102 [P] [US1] `web/src/api/client.ts` 新增 `sendMessage(runId, text)` 调用
- [ ] T103 [P] [US1] `web/src/views/TaskWorkbenchView.vue` 新增对话输入框，消息经 sendMessage 接入；渲染沿用 ui-redesign-v2 part 信息流
- [ ] T104 [US1] 系统提示模板（`context-snapshot.ts`）：含"闲聊直接回复、不产 tool call"指令 + 项目上下文
- [ ] T105 [US1] US1 验收测试：闲聊 → 0 tool call + 自然语言回复；工程指令 → skill tool call（断言 audit 事件）

**Checkpoint**：用户可与 agent 闲聊，工程意图触发 skill。

## Phase 4: US2 — 自主推进项目里程碑 (P1)

**Goal**：高层目标（如"推进到 G3"）→ agent 自主调用 skill 序列，逐门禁停等人工批准。

**Independent Test**：空项目 + 目标 G3，断言 agent 依次产出 intake→behavior_wave→architecture→register_spec candidate，提交 G3 GateSubmission 后停等。

- [ ] T201 [US2] 实现里程碑推进意图：agent 经 core-api tool 调 `submitGateSubmission` 触发门禁（非流水线固定位置）
- [ ] T202 [US2] 实现门禁等待态：GateSubmission 提交后 agent 进入等待人工批准，期间仍可对话（不产下游正式制品）
- [ ] T203 [US2] 里程碑状态反馈：系统提示每轮刷新 ProjectContextSnapshot，模型据此决定下一 skill
- [ ] T204 [US2] US2 验收测试：空项目 + "推进到 G3" 端到端，断言 skill 序列 + G3 GateSubmission + 等待态

**Checkpoint**：agent 可自主把项目推进到指定门禁。

## Phase 5: US3 — 人类中途接管与纠偏 (P2)

**Goal**：运行中 steer 纠偏 / abort 终止，生成审计事件。

**Independent Test**：多步任务中注入纠偏消息，断言下一工具结束后被消费、影响后续行为、Core 记录接管事件。

- [ ] T301 [US3] 接 steer：`POST /tasks/:runId/message` 区分新 prompt 与运行中 steer（运行中 → `agent.steer()`）
- [ ] T302 [US3] 接 abort：`POST /tasks/:runId/abort` → `agent.abort()`，状态置 cancelled，审计记录完整
- [ ] T303 [US3] steer/abort 审计事件写 Core（接管人/原因/影响），补 ARC-005 所述底座无 steer/abort 事件的自生成
- [ ] T304 [US3] US3 验收测试：运行中 steer 纠偏生效 + abort 终止 + 审计事件存在

**Checkpoint**：人类可随时接管/终止自由 agent。

## Phase 6: US4 — Skill 自主选择 (P2)

**Goal**：agent 据前置状态自主选择正确 skill，不按固定顺序。

**Independent Test**：不同前置状态会话（有/无 intake、有/无架构），断言首个 skill 选择与前置匹配。

- [ ] T401 [US4] skill tool 描述增强：把 skill 的 inputs/preconditions 注入 tool description，帮助模型选择
- [ ] T402 [US4] 前置校验返回"建议上游 skill"：模型据此自纠（如缺 intake → 建议 fpga-intake）
- [ ] T403 [US4] US4 验收测试：多前置状态矩阵，断言 skill 选择正确性 + 前置错误自纠

**Checkpoint**：agent 智能选择 skill，摆脱固定顺序。

## Phase 7: US5 — 越权与合规边界 (P1，安全不变量)

**Goal**：自由模式下 approve/baseline/publish/硬件写 100% 被拦截。

**Independent Test**：诱导越权会话，断言双层拦截 + 安全事件 + agent 拒绝解释。

- [ ] T501 [US5] 校验 tool 集不含 P4/P5 能力：approveGate/baseline/publish 不出现在 AgentTool 集
- [ ] T502 [US5] `beforeToolCall` 拦截越权：模型尝试调用禁止能力 → `{block:true}` + Core 安全事件
- [ ] T503 [US5] skill 描述符禁止集合校验复用 `core/src/skill-catalog.ts`（不声明 approve/baseline/publish/hardware_write）
- [ ] T504 [US5] US5 验收测试：诱导"直接批 G1"/"绕过门禁产码流" → 全部拦截 + 安全事件 + 拒绝回复

**Checkpoint**：自由度提升不破坏任何合规边界。

## Phase 8: Polish & 回归

- [ ] T801 [P] 全量既有测试回归：`core/tests/*`、`runtime/*.test.ts`、`connector/*.test.ts` 保持绿（SC-7）
- [ ] T802 [P] 崩溃恢复测试：agent 运行中杀进程，重启从检查点恢复（SC-6）
- [ ] T803 谱系完整性测试：tool call/model call/steer/abort 全有 Core provenance（SC-5）
- [ ] T804 双协议兜底验证：`probe-model.ts` 验证 tool-calling，不稳则退回 JSON 协议（SC/假设）
- [ ] T805 文档：更新 ARC-005 增补"自由 agent 模式"一节，记录与流水线的差异与不变量保持

---

## 依赖与并行

- **Setup（T001-T003）→ Foundational（T010-T016）** 必须先完成（阻塞所有 US）
- **US1（对话通道）** 是 Web 接入前置，US2/US3 依赖其 server 端点
- **US2、US3、US4、US5** 在 Foundational 完成后可并行（不同 aspect）
- **US5（合规）** 虽为 P1，但实现上依赖 tool 集装配（T011），可与 US2 并行

## 并行示例

Foundational 完成后，可并行推进：
- 流 A：US1 对话通道（T101-T105）
- 流 B：US2 里程碑推进（T201-T204）
- 流 C：US5 合规边界（T501-T504）
- 流 D：US3 接管（T301-T304）
- 流 E：US4 skill 选择（T401-T403）

## 验证策略

每个 User Story 阶段结束跑该 story 的 Independent Test；全部完成后跑 Phase 8 回归。合规不变量（US5）为红线，任何 stage 不得破坏。
