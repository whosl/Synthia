# Synthia 自我进化方案研究与启动计划（v0.1）

> **历史研究记录，已被 `specs/self-evolution-v1.md` 取代。** 本文保留用于追踪早期
> Knowledge/Prompt 优先、评测后生效方案的决策过程；不得再作为实现或验收依据。

状态：研究/立项草案（不改变现有运行行为）
日期：2026-08-20
适用分支：当前 TypeScript/Bun 主线（`codex/self-evo`）

## 1. 先给结论

Synthia 的“自我进化”第一阶段不应定义成在线修改模型权重、无限制修改代码，或让 Agent 自己批准自己的改动。更适合本项目的定义是：

> Synthia 从已审计的任务轨迹、工具证据、人工修改和门禁结果中提取可复用经验；对提示、检索、修复策略和 Skill 版本提出候选变更；在冻结评测集和人工批准下，以可观测、可回滚的方式逐步生效。

推荐优先级：

1. **经验/知识进化**：先让系统可靠地记住“什么问题、为什么、怎么修、在哪些器件/工具版本下有效”。
2. **提示与策略进化**：在离线回放中优化 system prompt、few-shot、检索权重、工具路由和 repair policy，先 shadow/canary，再人工确认。
3. **Skill/模板进化**：把反复验证有效的步骤形成新版本 Skill、检查项或 Tcl 模板，走提案和人审。
4. **工具/Connector 能力进化**：只允许生成能力提案和契约测试，不允许运行中动态注册或绕过 Core。
5. **代码/运行时自修改**：作为后期研究项，只产生 branch/patch candidate，经沙箱、回归、门禁和人工批准后才能部署。

第一期明确不做：在线梯度学习、自动改模型权重、开放 shell/raw Tcl、自主批准/建基线/发布、把失败样本直接写入默认知识库。

## 2. 需求来源与措辞边界

开题报告没有直接使用“自我进化”四个字。它提出的是自我进化的业务前身和必要条件：

- 把个人经验沉淀为组织能力；
- 将典型问题、解决方案、验证结论沉淀为组织资产并复用；
- 将综合/实现/硬件结果反向反馈到需求和设计，形成闭环；
- 用问题闭环、知识沉淀和指标优化推动成果固化与跨项目推广；
- 对关键决策、基线、工程操作和交付保留人工审核。

依据是历史提交中的开题报告抽取文本 `tmp/pdfs/proposal.txt`（当前工作树未保留原 PDF）：总体目标/经验沉淀约第 55–63、68–73 行；四项 AI 能力约第 106–128 行；闭环和人工审核约第 129–178 行；问题闭环/知识沉淀/指标优化节点约第 268–283 行。

后续规格才把这组要求明确命名为 self-evolution：`specs/unified-project-page-v3.md` §9（自动经验沉淀、人审层、进化页），并明确本期后端另立切片（§“非目标”）。因此本文件是对已有方向的工程化启动，不是给开题报告追加未经批准的能力承诺。

## 3. 当前基线审计

### 3.1 已有、可以复用的能力

| 能力 | 当前证据 | 对进化的作用 | 状态 |
|---|---|---|---|
| 自由 Agent 多轮工具循环 | `runtime/free-agent.ts` 的 `runLoop`、steer/abort、消息 sidecar | 任务轨迹采集入口、经验注入入口 | 已有 |
| 固定 FPGA Skill 包 | `runtime/skill-tools.ts`、`skills/fpga/skill-pack.json` | 未来 SkillProposal 的基线和版本来源 | 已有（只读） |
| 任务内 repair/Conformity feedback | `runtime/loop.ts` 约 300–350、641–766 | 经验抽取的高价值信号（失败→修复→验证） | 已有（仅任务内） |
| Core 候选/审批/基线语义 | `core/src/domain/*`、`core/src/api/*` | 候选变更、人审、回滚的治理边界 | 已有 |
| Connector 原始日志和 Evidence | `connector/`、Core `ToolRun/Evidence` | 离线评测与根因分析的事实输入 | 已有/部分贯通 |
| 流式审计与进化提示位 | `runtime/stream-hub.ts`、`web/src/domain/parts.ts` | 展示“应用经验/沉淀经验” | UI 位已有 |

### 3.2 关键缺口

| 缺口 | 证据 | 影响 |
|---|---|---|
| Core 没有 KnowledgeEntry 实体/表/API | `core/src/domain/enums.ts` 虽有 `KNOWLEDGE_ENTRY`，但 `entities.ts`、`schema.sql`、router/handlers 无对应实现 | 无法实现 approved-only 检索和知识失效 |
| 没有 Experience/Trajectory/EvolutionProposal/EvalRun 事实模型 | 当前 Core 仅有工程实体、ToolRun、Evidence 等 | 优化器没有可信输入、版本和审批对象 |
| afterToolCall 默认 no-op | `runtime/free-agent.ts` 约 115–129 | 工具谱系不能自动汇总为进化信号 |
| beforeModelCall 默认全放行 | 同文件约 132–142 | 需接入数据域/知识版本过滤 |
| 上下文快照不检索知识 | `runtime/context-snapshot.ts` 只组装项目/门/制品/事件 | 后续任务无法稳定复用批准经验 |
| SkillLoader 是冻结只读加载 | `runtime/skill-loader.ts` | 需要“提案→评测→人审→新 pack 版本”，不能原地改 pack |
| 当前分支有大量未提交改动 | `git status --short` | 本计划不覆盖、重置或假定这些改动已经验收 |

历史 `master` 曾经有 Python 版 evolution/memory（候选、overlay、A/B、评测集、工具沙箱），可借鉴其数据契约和护栏；它与当前 TypeScript 主线不是同一连续实现，不能直接当作当前能力或直接 cherry-pick。

## 4. 可选方案比较

| 方案 | 学什么 | 优点 | 主要风险 | 适合 Synthia 的时间 |
|---|---|---|---|---|
| A. 经验/知识库进化 | 从轨迹抽取规则、故障模式、修复步骤、适用条件 | 最贴合开题报告；可解释；与 KnowledgeEntry/追踪契约天然兼容 | 错误记忆污染、过时知识误命中 | **现在，P0** |
| B. Prompt/策略优化 | prompt、few-shot、检索排序、工具路由、重试策略 | 不改模型；可离线 A/B；收益容易量化 | benchmark 过拟合、提示漂移、隐性回归 | **现在，P0/P1** |
| C. Skill/模板演化 | 新 Skill、检查项、Tcl 流程模板、修复 playbook | 能把专家经验变成组织流程资产 | Skill 版本不兼容、权限扩大、隐性副作用 | **第二期，P1** |
| D. Tool/Connector 演化 | 新的确定性分析器或 Connector capability | 扩展工程能力边界 | 代码执行、网络/凭据、供应链风险 | **中后期，P2** |
| E. 代码/运行时自修改 | 自动提出并验证 patch | 理论上上限最高 | 破坏治理、回归、不可解释、供应链风险 | **后期研究，P3** |
| F. 群体/元学习 | 多 Agent 竞赛、bandit、population search、自动增加角色 | 可探索复杂策略空间 | 成本高、方差大、分歧难收敛，不能替代人类决策 | **研究项，P4** |

### 4.1 参考研究及可借鉴点

- [Reflexion](https://arxiv.org/abs/2303.11366)：用语言化反馈形成下一次执行的反思记忆；适合借鉴“失败—反思—再试”，但记忆必须进入隔离/审核流程。
- [Self-Refine](https://arxiv.org/abs/2303.17651)：同一任务内的生成—反馈—改进；适合解释当前 repair loop，不等同于跨任务进化。
- [Voyager](https://arxiv.org/abs/2305.16291)：把成功经验沉淀为可复用技能库；适合借鉴 Skill 版本化，但 Synthia 必须加入 Core 权限、候选和人审。
- [DSPy](https://arxiv.org/abs/2310.03714)、[OPRO](https://arxiv.org/abs/2309.03409)、[TextGrad](https://arxiv.org/abs/2406.07496)：把 prompt/程序策略当成可评测对象优化；Synthia 应采用“不可变策略版本 + 冻结评测 + shadow/canary”，不必引入其框架。
- [A-MEM](https://arxiv.org/abs/2502.12110)：强调结构化、可链接的 agent memory；可借鉴 episodic/semantic/procedural 分层，但 PostgreSQL/Core 仍是权威源，向量索引只是派生物。
- [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954)、[AlphaEvolve](https://deepmind.google/discover/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)：展示“提出 patch→基准评测→保留优胜者”的上限；对 Synthia 只能采用受限的 proposal/benchmark 思路，不能开放无界自改。
- [On the Fragility of Self-Improving Agents](https://arxiv.org/abs/2608.18066)：提示多次运行方差、任务顺序和任务规格不足会显著影响结论；因此必须多 seed、随机任务顺序、holdout 和明确 rubric。
- [SEAL: Self-Authored Verification Is Unreliable](https://arxiv.org/abs/2607.24300)：优化对象不能同时控制最终验收器；评测器应由 harness 维护，Agent 只能收到 accept/reject 或受限摘要。

## 5. 推荐总体架构

```text
observe
  └─ Task/Model/Tool/Connector/Gate/人工修改轨迹 + 原始证据
      ↓
diagnose
  └─ 失败签名、根因、修复动作、验证结果、适用范围
      ↓
propose
  └─ Experience / KnowledgeEntry / StrategyVersion / SkillProposal
      ↓
deterministic checks
  └─ schema、来源、权限、数据域、版本兼容、去重、冲突、静态检查
      ↓
sealed offline evaluation
  └─ frozen benchmark + holdout + 多 seed/随机顺序 + incumbent 对照
      ↓
human approval (P4)
      ↓
shadow → canary → active
      ↓
monitor → automatic rollback / retire
```

### 5.1 建议对象（优先复用已有对象）

| 对象 | 关键字段 | 事实/派生 |
|---|---|---|
| `Trajectory` | agent/task、输入/输出哈希、model/prompt/skill/tool/context manifest 版本、事件序列 | Core append-only 事实 |
| `Experience` | 问题→根因→修复→验证、source_ids、confidence、适用 part/Vivado/标准、失效条件 | 隔离候选 |
| `KnowledgeEntry` | 来源制品、知识分区、状态、适用条件、数据域、有效期/失效原因 | 批准后可检索 |
| `EvolutionProposal` | surface、parent version、diff artifact、风险、预期收益、评测计划、状态 | 人审对象 |
| `EvolutionEvalRun` | benchmark snapshot、上下文/知识 manifest、评测器版本、原始证据、指标 | 评测事实 |
| `PromotionRecord` | shadow/canary/active、流量、批准人、回滚点、撤回原因 | 发布审计 |

已有 `ArtifactRevision`、`ConfigurationSnapshot`、`ApprovalRecord`、`Evidence` 可作为提案内容、快照、审批和证据载体，避免再造一套事实源。

### 5.2 进化面与等级

| 等级 | 允许变化 | 默认行为 |
|---|---|---|
| Level 0 | 知识候选、prompt/策略候选、Skill/检查项候选 | 只生成 candidate，必须人工批准 |
| Level 1 | 已批准 prompt/检索/路由/repair 的 shadow 或小流量 canary | 每个 surface 显式 opt-in，评测胜出后仍需人工 merge |
| Level 2 | 新 Skill/工具/Connector capability | 仅提案；契约测试、沙箱和人工批准后发布 |
| Level 3 | 运行时代码 patch | 后期研究；独立分支、隔离构建、双人/人类门 |

`tool` 和 `code` surface 默认永不自动生效；任何 surface 都必须能一键退回 baseline。解析顺序建议：project active → global active → built-in baseline，并记录 `evolution.overlay.resolved` 事件。

## 6. 第一阶段实施路线

### Phase 0：可信观测与基线（2–4 周，必须先做）

1. 将 `task.done`、模型调用、工具调用、Connector Job、门禁、steer/abort、人工编辑和最终处置统一成 append-only trajectory。
2. 固定 RT-UART 及故障注入/历史问题集，建立 baseline、holdout、版本清单和随机种子。
3. 完成 Experience quarantine：失败、草案、来源不明内容不能进入默认检索。
4. 采集六类指标：人工投入、周转、正确性、首次通过、人工干预、成果复用；同时记录 token/费用/墙钟/重试。

**验收**：同一任务可重放；每个结论可追到输入/模型/提示/知识/工具版本；评测器不由提案 Agent 修改。

### Phase 1：知识 + 策略 shadow（4–6 周，首个可交付）

1. Core 增加 `KnowledgeEntry` candidate/approved/invalidated 状态、来源关系、适用条件和数据域过滤。
2. Runtime 在任务结束、repair 成功、门禁拒绝、人工修改后抽取 Experience，写入隔离区。
3. `knowledge_retrieve` 只返回 approved、来源有效、版本/器件/数据域匹配且未失效的条目。
4. 将 prompt、few-shot、检索排序、tool routing、repair policy 做成不可变 `StrategyVersion`；候选先离线回放，再 shadow/canary。
5. 增加自动回滚：指标相对 incumbent 持续下降、无轨迹/无指标、数据域违规时立即 retire。

**验收**：RT-UART holdout 上质量不下降；复用率和人工修改量有可测改善；负面反馈/错误知识不会污染默认上下文。

### Phase 2：Skill/检查项提案（6–10 周）

1. `SkillProposal` 只生成 descriptor diff、前置条件、输出/evidence、required capabilities 和风险说明。
2. 在 hermetic sandbox 回放 RT-UART/故障集，运行 schema、权限、能力白名单、静态检查和回归。
3. 人工通过底部审批抽屉批准，生成新的 immutable skill-pack 版本；运行中的 pack 不改变。
4. 统计复用次数、命中率、适用性错误、回滚和跨项目泛化。

### Phase 3/4：工具、代码和群体方案（后续研究）

- Tool/Connector：先能力提案，再 Connector contract test、SBOM/license/secret/egress 检查和人工批准。
- Code/runtime patch：只写 branch/patch candidate；独立子进程/容器构建，跑 Bun/Core/Web/Connector 测试、RTL 仿真、G4 replay、资源限制和 canary。
- Population/meta-learning：先用固定角色的 bandit/beam/tournament 做离线研究；只有在 A/B 证明稳定收益后增加 Agent 数量或委派深度，绝不以多数投票替代人类决定。

## 7. 必须先关闭的治理问题

在 Phase 1 之前需要负责人确认：

- 正式完整性/安全关键等级和批准人（OPEN-QUESTIONS Q-004）；
- 模型、提示、上下文、外网和数据域控制（Q-012）；
- 质量/配置/安全等批准职责（Q-013）；
- 人工基线负责人、任务、样本和日期（Q-017）；
- 里程碑与最小可信交付安排（Q-018）。

已知硬约束：纯内网/敏感数据不出域；Core 为事实源；PG/Git/MinIO 受控记录不可物理删除；Agent 最高 P3；G1–G9 和发布/硬件操作仍需人类授权。

## 8. 第一批工程任务（建议单独立项）

建议创建下一切片 `self-evolution-phase-0`，范围只到可信观测和知识候选，不碰 prompt 自动生效：

1. Core：Trajectory/Experience/KnowledgeEntry 的最小 schema、迁移、实体和 append-only API。
2. Runtime：在 `free-agent.ts`/`loop.ts` 的 terminal、repair、gate rejection 和人工 edit 处发出统一事件；补齐 `afterToolCall` 真实写回。
3. Retrieval：实现 approved-only + source/validity/data-domain/part/tool/version 过滤，向量索引只做派生查询。
4. Extractor：先用确定性规则 + 结构化模型输出抽取 Experience，失败时不写默认知识。
5. Evaluation：RT-UART baseline/holdout、故障注入、随机顺序、多 seed、sealed evaluator 和 incumbent 对照。
6. UI/API：进化历史、候选队列、来源/适用条件/评测证据和批准/拒绝/回滚状态；复用现有审批抽屉。
7. Tests：跨项目泄漏、草案命中、过期知识命中、重复候选、回滚、评测器不可修改、断电恢复和幂等。

## 9. 首期验收标准

- 每次 terminal task 都有完整 trajectory，且可由 event/hash 追溯到模型、prompt、skill、tool、知识和输入快照。
- 经验候选默认不可检索；只有人工批准且来源/关系/数据域/版本均满足时才进入默认检索。
- 同一故障重复出现时能生成去重后的 candidate，并能展示根因、修复、验证证据和适用范围。
- 任何策略/Skill 变更均有 immutable parent、离线评测、批准记录和回滚点。
- holdout 质量、G4/G5/G6 首次通过、批准后缺陷和重复运行一致性不劣于 incumbent；不能只用 token 或“少审批”证明改进。
- Agent 无法调用 approve/baseline/publish/hardware_write；不能修改或读取 sealed holdout evaluator。

## 10. 决策请求

本草案建议先批准以下三个方向性决策，再进入代码切片：

1. 将“自我进化”定义为**受控的知识/策略/Skill 版本演进**，不包含在线权重自改。
2. 采用“trajectory → quarantine → proposal → sealed evaluation → human approval → shadow/canary → monitor/rollback”作为统一闭环。
3. 先实施 Phase 0 + Phase 1；Phase 2 以后必须以 RT-UART 和故障集的可重复收益作为进入条件。
