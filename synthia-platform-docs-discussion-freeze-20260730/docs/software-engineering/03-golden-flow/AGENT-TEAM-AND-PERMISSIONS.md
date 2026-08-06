# Synthia 多 Agent 团队与权限规范

| 属性 | 内容 |
|---|---|
| 文档编号 | SYNTHIA-FLOW-004 |
| 版本/状态 | v0.2 / 讨论冻结候选，待正式评审 |
| 上游 | SYNTHIA-FLOW-001～003 v0.2、SYNTHIA-GOV-003 |
| 适用范围 | 需求到 B2 的多 Agent 团队及 B2 后的分析/执行 Agent |

## 1. 目标

多 Agent 团队通过专业分工、受控交接和相互校验提高工程质量。团队不是多个模型自由聊天，也不采用“多数投票等于正确”的规则；每个 Agent 都在冻结输入、输出 Schema、工具权限、禁止动作和人类门禁下运行。复杂度主要位于 Workflow、制品、批准、追踪和证据；只有评测证明有收益时才增加运行中的 Agent 数量和委派深度。

## 2. 团队组成

| Agent 角色 | 主要任务 | 典型输出 |
|---|---|---|
| Orchestrator | 驱动流程状态、拆分任务、准备上下文包、收集结果和触发检查 | Task、Handoff、Gate Submission 候选 |
| Standards Agent | 解释临时标准矩阵、检查活动/工作产品/裁剪缺口 | 条款映射、检查意见、裁剪候选 |
| Requirements Agent | 需求提取、澄清、规范化、派生需求和冲突检查 | 系统需求、PLDS SRS、问题、追踪候选 |
| Architecture Agent | 单元划分、接口、数据/控制流、设计权衡 | 结构设计、需求分配、风险候选 |
| Detailed Design Agent | 寄存器/FSM/时钟复位/CDC/存储/IP/约束细化 | 详细设计、约束设计、派生决策 |
| RTL Agent | 依据批准设计生成或修订 RTL/IP 封装/XDC 草案 | Verilog、XDC、代码追踪候选 |
| Verification Agent | 从批准需求建立独立模型、TB、断言、覆盖和测试 | TB、参考模型、测试规格、失败分析 |
| Assurance Agent | 追踪、质量、配置、风险、代码审查和门禁检查 | 审计、缺口、问题、manifest 候选 |
| Vivado Analysis Agent | 解释 Connector 返回的原始报告并提出诊断/优化候选 | 结构化诊断、变更提案、回归建议 |

Vivado Connector 是受控执行服务，不是可以自由修改项目的对话 Agent。它只能执行经过验证和授权的任务契约。

### 2.1 专业角色与 MVP 实例

上表定义 9 种专业能力与权限 Profile，不等于 9 个常驻进程或模型。MVP 使用 6 个逻辑 Agent 实例承载：

| MVP 逻辑实例 | 承载角色 |
|---|---|
| 编排 Agent | Orchestrator |
| 需求与标准 Agent | Standards + Requirements |
| 设计 Agent | Architecture + Detailed Design |
| RTL Agent | RTL |
| 验证 Agent | Verification |
| 保证 Agent | Assurance；初期按任务承载 Vivado Analysis |

默认任务拓扑为“1 个生成 Agent + 1 个保证/审查 Agent + 确定性工具 + 人类阶段门”。Vivado Analysis 只有在 RT-UART 对照评测证明稳定收益时才拆为独立运行实例。

## 3. 权限等级

| 等级 | 能力 | 示例 |
|---|---|---|
| P0 只读 | 读取被授权制品和状态 | 审查需求、读取报告 |
| P1 候选写入 | 在隔离区创建候选制品/差异 | 生成 SRS、RTL、测试 |
| P2 受控工具 | 调用白名单确定性检查或申请低风险 gate_check | Schema、Lint、追踪、批准的编译/CDC 检查 |
| P3 EDA 执行申请 | 创建 Connector Job，需策略/适用时人工授权 | 仿真、综合、实现 |
| P4 工程批准 | 批准/拒绝、接受风险/豁免、建立基线 | 仅授权人类 |
| P5 发布/硬件 | 生成/发布码流、下载、VIO/ILA 高影响操作 | 授权人类触发，Connector 执行 |

所有 Agent 最高只能持有 P3，且 P3 只表示可申请 Connector Job，不表示可授权执行、接受运行结果或批准工程门；它仍受任务类型、项目、数据域、工作区和命令策略限制。

## 4. 角色权限矩阵

| Agent | 读取 | 候选写入 | 工具 | 明确禁止 |
|---|---|---|---|---|
| Orchestrator | 当前流程和授权上下文 | 任务/交接/摘要 | Workflow 查询和校验 API | 拥有或修改流程真相、生成技术结论、批准、改原始证据 |
| Standards | 标准、项目裁剪、工作产品 | 条款映射/缺口 | 规则检查 | 宣称正式 GJB 符合、修改批准需求 |
| Requirements | 原始输入、问题、系统上下文 | 需求/派生/追踪 | 需求规则、术语/冲突检查 | 未经人类确认关闭重大歧义 |
| Architecture/Design | 批准需求、器件/环境输入 | 设计、决策、约束候选 | 建模/静态分析辅助 | 静默改变需求或测试期望 |
| RTL | 批准 B1、编码规范、模板 | RTL/XDC 差异 | 编译/Lint 等低影响工具 | 读取无关项目、批准自身代码、任意 shell/Tcl |
| Verification | 批准需求/设计、接口契约 | TB/模型/测试/覆盖 | 仿真申请、分析工具 | 用 DUT 实现复制为唯一参考期望、删除失败运行 |
| Assurance | 全部授权工程元数据和证据 | 审计/问题/门禁建议 | 追踪、配置、质量校验 | 更改工具原始报告、代替人类批准 |
| Vivado Analysis | 批准运行输入摘要、原始报告 | 诊断和运行提案 | Connector 只读查询/受控 Job 申请 | 直接执行任意 Tcl、修改批准 XDC、发布码流 |

## 5. 任务契约

每次 Agent 任务至少包含：

| 字段 | 内容 |
|---|---|
| `task_id/type` | 唯一任务和批准任务类型 |
| `project/workflow_stage` | 项目及 G0～G9 阶段 |
| `actor_role/model_profile` | Agent 角色和模型/策略版本 |
| `input_artifact_ids` | 精确版本和状态，禁止隐式使用最新文件 |
| `context_manifest` | 提示、知识片段、模板和规则清单/哈希 |
| `expected_output_schema` | 允许产生的制品类型和 Schema |
| `allowed_tools/permissions` | 工具、参数范围、目录和网络权限 |
| `acceptance_checks` | 任务级确定性检查，不是工程批准 |
| `timeout/cancel/retry` | 超时、取消和幂等重试策略 |
| `classification` | 继承的数据域和输出限制 |

缺少任务契约或输入版本不明确时，Agent 应拒绝执行而不是猜测。

## 6. 上下文构建

Agent 只能获得完成任务所需的最小上下文：

1. 当前批准基线的相关对象；
2. 明确标记的候选差异；
3. 适用标准/规则和项目裁剪；
4. 经数据域过滤的批准知识；
5. 相关问题、风险和既有决策；
6. 输出 Schema、门禁和禁止动作。

平台保存上下文 manifest 和哈希。知识检索结果必须带来源、状态、版本、适用器件/工具及数据域；不得将失败样本作为正确参考混入默认上下文。

## 7. 需求到 B2 的团队流水线

| 子阶段 | 主 Agent | 独立复核 Agent | 人类门 |
|---|---|---|---|
| 系统需求候选 | Requirements + Standards | Assurance | G1 |
| PLDS SRS/派生 | Requirements | Architecture + Verification + Assurance | G2 |
| 结构/详细设计 | Architecture + Detailed Design | Verification + Assurance | G3 |
| RTL/XDC 候选 | RTL | Detailed Design + Assurance | G4 |
| TB/参考模型/测试 | Verification | Requirements + Assurance | G4/G7 |
| B2 提交 | Orchestrator 汇集，Assurance 检查 | 人类设计/验证/配置角色 | G4 |

验证 Agent 应从批准需求和接口契约建立期望。它可以读取设计以理解接口和可观测性，但不能把 RTL 计算过程复制为唯一黄金模型。

## 8. 分歧和冲突处理

Agent 间出现分歧时：

1. 保留各自候选、依据和置信/限制，不覆盖前一结果；
2. 由确定性规则先消除 Schema、算术、接口和来源问题；
3. Assurance Agent 生成分歧摘要和受影响对象；
4. 技术分歧由相应人类角色决策，并形成 Decision 制品；
5. 决策反馈到需求/设计/测试和知识库。

不得用简单多数投票决定安全关键设计、标准裁剪、测试通过、豁免或发布。

## 9. 自检、交叉检查和独立性

- 每个 Agent 在提交前执行自身 Schema/引用/完整性检查；
- 交叉检查者应使用不同任务上下文和明确的审查清单；
- 同一模型可承担不同角色进行早期原型，但不能把角色分离误报为人员/模型独立性；
- 正式项目的模型多样性、人员独立性和验证强度由完整性等级决定；
- Agent 生成的测试通过不能批准同一 Agent 生成的 RTL。

## 10. 工具与执行隔离

每个候选任务使用隔离工作区和最小文件权限。Agent 不共享可写工程目录，不能读取凭据、修改基线标签、删除审计日志或访问未授权网络。Connector Job 只接收不可变输入包，不信任 Agent 提供的任意路径或命令字符串。

需要自定义 Tcl 时，Agent 只能提交 Tcl 提案；策略层进行语法/命令/路径检查，高影响命令需人工执行授权，实际执行身份和结果进入审计。

## 11. 失败和恢复

| 失败 | 处理 |
|---|---|
| 模型输出不符合 Schema | 标记任务失败，保留原输出；有限次数修复重试 |
| 输入冲突/缺失 | 创建澄清问题，不生成假设性正式成果 |
| 工具调用失败 | 保存参数/返回码/部分证据，交给诊断而非伪装成功 |
| 超时/取消 | 状态 `timeout/cancelled`，只有幂等任务允许重新排队 |
| Agent 越权请求 | 拒绝、告警并记录安全事件 |
| 人工修改 | 产生新候选版本和差异，重新执行受影响检查 |

## 12. Agent 谱系和度量

保存模型/权重或服务版本、系统提示/模板版本、推理参数、上下文 manifest、工具调用、输出哈希、人工修改和最终处置。度量任务一次通过率、返工、缺陷类型、人工修改量、错误建议和门禁影响；不以“减少人工审批”作为唯一成功指标。

## 13. MVP 团队裁剪

MVP 可先部署 Orchestrator、Requirements、Design、RTL、Verification、Assurance 六类逻辑角色；Standards 可并入 Assurance，Architecture/Detail 可由同一模型不同任务承担。权限、制品隔离和人类门禁不能因角色合并而取消。
