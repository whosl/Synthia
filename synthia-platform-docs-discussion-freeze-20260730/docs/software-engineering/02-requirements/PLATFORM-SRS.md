# Synthia 平台软件需求规格说明

| 属性 | 内容 |
|---|---|
| 文档编号 | SYNTHIA-REQ-002 |
| 版本/状态 | v0.2 / 讨论冻结候选，待正式需求评审（新增 SRS-F-065/066 远程兼容模式） |
| 日期 | 2026-07-30 |
| 上游 | SYNTHIA-REQ-001 v0.3、SYNTHIA-GOV-003、SYNTHIA-FLOW-001～007 |
| 适用对象 | Synthia 平台软件；不等同于平台生成的目标 PLDS SRS |

## 1. 目的和范围

本规格把平台利益相关方需求分解为可设计、可实现和可验收的软件需求。第一阶段以独立或可嵌入的 Synthia UI、Synthia Core、受控 Agent/Skill、Connector SDK、Vivado Worker、MCP Adapter 和 RT-UART 参考链为范围。Synthia 是 FPGA 工程智能体操作平台，不复制或替代 Vivado/工业软件原生 GUI 和工程业务逻辑；用户可以在明确授权后通过 Synthia 驱动 Vivado 完成任务，也可以直接回到传统 Vivado 操作。具体性能阈值、部署产品和项目角色在 TBD 关闭后进入正式基线。

## 2. 外部角色

项目负责人、系统/需求负责人、PLDS 设计负责人、RTL/实现工程师、验证工程师、质量保证、配置管理员、安全/保密管理员、硬件/实验室工程师、平台管理员、验收方，以及受控 Agent/Connector 服务身份。

## 3. 功能需求

### 3.1 项目和工作流

| ID | 需求 |
|---|---|
| SRS-F-001 | 平台应创建隔离 Project，绑定数据域、流程模板、标准/裁剪版本、目标器件/工具候选、角色和交付范围。 |
| SRS-F-002 | Workflow Engine 应实例化 G0～G9，并保存当前门、入口/出口准则、回退、行动项和流程模板版本。 |
| SRS-F-003 | 只有满足确定性检查和授权人类决定时，平台才可形成 ApprovedGateResult 并推进下一门。 |
| SRS-F-004 | 平台应支持按追踪影响回到最早受影响门，不得用页面状态覆盖历史阶段事实。 |
| SRS-F-005 | G0 应输出项目档案、流程实例、角色、数据域、裁剪、初始风险和配置记录，不建立产品技术基线。 |
| SRS-F-006 | UI 应支持独立运行和嵌入 FPGA 工业软件的小窗/WebView；两种形态调用同一版本化 Core API，并继承相同身份、项目、数据域、授权和审计边界。 |
| SRS-F-007 | 用户可提交高层工程目标，由 Agent/Skill 规划并在授权范围内调用 Vivado Connector；平台应显示计划、授权范围、运行状态、原始日志/报告和结构化诊断。 |
| SRS-F-008 | Synthia 不得复制或替代 Vivado 原生 GUI 和工程业务逻辑；用户直接使用 Vivado 时，平台不得未经明确授权读取、修改、重跑或影响关联工程。 |
| SRS-F-009 | Workflow/Agent 应支持 Skill 作为版本化任务方法，记录适用的 Vivado 版本/能力、前置条件、步骤、输出、风险、授权要求和失败处理；Skill 不得绕过 Core/Connector 策略执行任意 Tcl。 |

### 3.2 制品、快照、批准和基线

| ID | 需求 |
|---|---|
| SRS-F-010 | 平台应管理 Artifact 容器及不可变 ArtifactRevision，并为 Requirement、DesignElement、ImplementationItem、VerificationItem 提供稳定成员 ID。 |
| SRS-F-011 | 平台应冻结成员/关系精确修订形成 ConfigurationSnapshot，计算规范化清单和 SHA-256。 |
| SRS-F-012 | 平台应使用 GateSubmission 把一个不可变快照提交到指定流程门，并保留每次提交和检查历史。 |
| SRS-F-013 | ApprovalRecord 应以授权自然人身份 append-only 记录批准、拒绝、带行动批准、撤销、无影响确认和豁免。 |
| SRS-F-014 | 每个 G1～G9 批准应形成 ApprovedGateResult；只有 G1/G3/G4/G7/G9 分别建立 B0/B1/B2/B3/B4。 |
| SRS-F-015 | Baseline 只能由批准事件建立，不得存在 candidate Baseline；替代、失效和退役不得删除历史成员。 |
| SRS-F-016 | 批准修订不得原地修改；任何内容或关键元数据变化应创建新修订和新哈希。 |

### 3.3 追踪和影响分析

| ID | 需求 |
|---|---|
| SRS-F-020 | 平台应建立 Source→Requirement→DesignElement→ImplementationItem→VerificationItem→ToolRun→Evidence→Baseline/Release 的双向关系。 |
| SRS-F-021 | Agent 创建的关系应为 candidate，只有随提交快照获得批准后才进入正式覆盖口径。 |
| SRS-F-022 | 平台应分别计算来源、设计分配、实现规划、验证规划、验证执行、需求通过和反向实现覆盖率，并显示分子、分母、状态和配置视图。 |
| SRS-F-023 | 平台应识别孤立、断裂、失效、跨项目和版本端点不匹配的关系。 |
| SRS-F-024 | 上游变化应产生 ImpactAssessment，列出直接/间接影响、待复核关系、可能失效批准、必需回归和建议回退门；关键范围由人类确认。 |

### 3.4 Agent 编排

| ID | 需求 |
|---|---|
| SRS-F-030 | 平台应支持 9 种专业角色 Profile，并允许 MVP 的 6 个逻辑 Agent 实例按任务承载这些 Profile。 |
| SRS-F-031 | Workflow 应向 Agent 提供冻结 TaskPackage，包含输入快照、允许动作、输出 Schema、工具权限、数据域、预算和完成判据。 |
| SRS-F-032 | Agent 只能创建候选修订、关系、诊断和任务建议，不得批准、豁免、建立基线、验收或发布码流。 |
| SRS-F-033 | Agent 工作区应按任务隔离，不得共享跨项目可写目录、读取凭据、修改批准记录或删除失败证据。 |
| SRS-F-034 | Orchestrator 只能拆分、路由、收集和触发检查，不得拥有流程状态真相或替代专业结论。 |
| SRS-F-035 | 平台应保存模型、提示模板、知识版本、参数、TaskPackage、输出和人工修改谱系。 |

### 3.5 阶段门和检查

| ID | 需求 |
|---|---|
| SRS-F-040 | 平台应执行 Schema、必填字段、哈希、引用、状态转换、追踪不变量、批准身份、豁免到期和运行输入检查。 |
| SRS-F-041 | G4 应允许针对冻结 GateSubmission 执行 `gate_check` 编译、Lint、必要预综合 CDC/RDC 和代码审查；快照变化时结果失效。 |
| SRS-F-042 | G5 应对批准 B2 执行 `formal` 综合、综合后 CDC、DRC 和关键网表结构检查。 |
| SRS-F-043 | Web 审批界面应显示精确快照、差异、追踪缺口、检查结果、原始证据、问题/风险/豁免和 Agent/工具谱系。 |
| SRS-F-044 | 硬门禁失败不得被 Agent 摘要、批准行动或普通项目豁免改名为通过。 |

### 3.6 Connector 和运行

| ID | 需求 |
|---|---|
| SRS-F-050 | Synthia Core 应只通过厂商无关 Connector Port 提交和查询工业软件/硬件任务。 |
| SRS-F-051 | Connector SDK 应统一 Capability、Job、Worker、InputManifest、Artifact/Evidence、授权、锁、幂等、错误、取消、超时和恢复。 |
| SRS-F-052 | MCP、HTTP、Queue Adapter 应可替换；Adapter 不得直接运行工业软件或保存工程批准事实。 |
| SRS-F-053 | 长任务应采用异步 Job，至少支持 submitted/rejected/queued/preparing/running/cancelling/succeeded/failed/cancelled/timeout/lost/unknown_effect。 |
| SRS-F-054 | ToolRun 应具有独立 `run_class=exploratory/gate_check/formal`；状态 `succeeded` 不得自动产生工程批准。 |
| SRS-F-055 | formal 运行只接受批准且有效输入；gate_check 只接受冻结 GateSubmission；exploratory 结果不得进入正式覆盖、通过率或发布。 |
| SRS-F-056 | Worker 应验证 manifest、哈希、能力、part、工具、路径、数据域和资源条件，并在独立工作区执行。 |
| SRS-F-057 | Worker 应返回原始日志、命令、环境、返回码、输出清单、哈希、完整性和解析器版本；大型对象使用 URI/Artifact ID 引用。 |
| SRS-F-058 | 平台不得开放 `execute_tcl(any_string)`；自定义 Tcl 必须完成提案、策略检查、授权和任务哈希。 |

### 3.7 Vivado、板级和交付

| ID | 需求 |
|---|---|
| SRS-F-060 | Vivado Worker 应以强类型 Capability 支持工具/许可证/part发现、源码预检、XSim、综合、实现、CDC、DRC、STA、资源、功耗、DCP、码流及适用的 Hardware Manager 操作。 |
| SRS-F-061 | Board/Lab Worker 应独立管理串口、激励、电源、仪器、板卡资源锁和环境证据。 |
| SRS-F-062 | 硬件写操作应绑定精确目标、操作者、目的、输入码流、资源锁和授权；未知副作用应进入 unknown_effect 且禁止自动重试。 |
| SRS-F-063 | 外部人工/夹具证据应记录来源、操作者、时间、环境、方法、目标硬件和原始哈希，并以候选 Evidence 导入。 |
| SRS-F-064 | Bitstream 应追溯至 B2、批准 G5/G6/G7 结果、part、Vivado/strategy、生成 ToolRun 和目标硬件。 |
| SRS-F-065 | 平台应支持远程兼容模式：授权的任意 Linux/Windows + licensed Vivado 主机可注册为版本化 ConnectorEndpoint；配置只存证书/信任引用不存 secret；本轮经 mTLS 和 allowlist 建立 direct_https 通道；bootstrap token 仅为后续一次性短期引导预留，当前未实现，真实 PoC 前必须补齐或由部署侧完成等价受控引导；outbound_tunnel 为 typed reserved，不得隐式启用（SYNTHIA-FLOW-006 §16.2/§16.3、SYNTHIA-IF-001 §9.1）。
| SRS-F-066 | 远程端点生命周期应为 registering→approved→ready→degraded→offline→revoked；heartbeat/lease 过期或能力漂移应阻断 formal 运行并审计。当前已完成 vivado-66-xc7k70t 的真实 Vivado Worker discovery、part/license、XSim、综合、DRC、STA、资源报告和 DCP 验证；公网 Cloudflare Access 授权链路仍须通过 Service Token discovery 后，才可作为 Core 正式接入证据（SYNTHIA-FLOW-006 §16.4～§16.8）。 |

### 3.8 知识、审计和报告

| ID | 需求 |
|---|---|
| SRS-F-070 | 默认知识检索只返回批准、有效、数据域允许且适用条件匹配的条目。 |
| SRS-F-071 | 历史、错误、失败和对抗样本应进入隔离历史库或评测集，不得作为正确知识返回。 |
| SRS-F-072 | 平台应保留用户、Agent、Core、Adapter、Worker 和工具事件的关联 ID、可信时间、身份、数据域和不可变审计链。 |
| SRS-F-073 | 平台应导出人类可审阅文档和机器可读清单；生成视图不得替代结构化权威数据。 |

## 4. 质量和约束需求

| ID | 需求 |
|---|---|
| SRS-Q-001 | 平台应支持本地/私有化部署和项目/数据域隔离；具体拓扑与身份源见 Q-006/Q-011。 |
| SRS-Q-002 | 批准、撤销、豁免、门禁、基线和受控运行事件应 append-only，普通用户和服务不得物理删除。 |
| SRS-Q-003 | 同一不可变输入、工具配置和策略应能重现命令、配置身份和可解释结果；允许的工具非确定性须单独基线化。 |
| SRS-Q-004 | 业务命令应使用预期版本和幂等键；非幂等硬件操作不得因断线自动重试。 |
| SRS-Q-005 | 对象内容和清单使用 SHA-256；Worker 初算、Core/证据服务复算。 |
| SRS-Q-006 | 元数据存在但对象缺失、对象存在但未登记、哈希不符和证据不完整应被检测、隔离和对账。 |
| SRS-Q-007 | API、事件、Capability、Artifact 和 Evidence Schema 应独立版本化，并具备迁移和兼容测试。 |
| SRS-Q-008 | 系统应区分工具事实、解析诊断、知识建议和模型推断，不以自然语言摘要替代原始证据。 |
| SRS-Q-009 | 增加 Agent 数量或编排深度必须由 SYNTHIA-PLAN-003 的可重复评测证明收益。 |
| SRS-Q-010 | 正式符合性结论必须等待完整授权标准、项目裁剪和质量/标准化审计；UI 和报告在此之前显示临时监控边界。 |

## 5. 外部接口

Web/API、身份源、模型运行时、Git/配置存储、对象存储、MCP/HTTP/Queue Adapter、Vivado Tcl/API、Hardware Manager、Board/Lab Driver 和外部证据导入。权威交互语义见 SYNTHIA-IF-001。

## 6. 数据要求

权威数据模型以 SYNTHIA-ARC-002、SYNTHIA-ARC-004 和 SYNTHIA-FLOW-005 为准。任何查询“当前状态”必须指定候选工作区、ApprovedGateResult 或 Baseline；禁止混合“最新文件”和历史批准结果。

## 7. 验收映射

- SRS-F-001～044：MVP-E2E-001～003、MVP-X-001/002/005/006；
- SRS-F-050～058：Connector 首切片、MVP-E2E-004/005、MVP-X-003/004/009；
- SRS-F-060～064：MVP-E2E-005～008；
- SRS-F-065～066：远程兼容模式契约测试、端点生命周期与漂移演练（真实 Vivado PoC 为其前置，接入步骤见 SYNTHIA-FLOW-006 §16.8）；
- SRS-F-070～073：MVP-X-007/008；
- SRS-Q 系列：横切测试、恢复演练、安全审查和文档审计。

详细用例、阈值和测试数据在正式需求评审后进入平台测试计划。当前未决项见 Q-004、Q-006、Q-008、Q-010～Q-020。
