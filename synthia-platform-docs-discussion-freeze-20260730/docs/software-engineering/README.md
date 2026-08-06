# Synthia FPGA 工程智能体操作平台软件工程文档库

| 属性 | 内容 |
|---|---|
| 文档状态 | 平台方向 v1.2 讨论冻结候选；2026-07-30 讨论冻结包待正式评审 |
| 基线日期 | 2026-08-06（定位修订；冻结包原始日期 2026-07-30） |
| 维护方式 | Markdown 为工程源文件；评审/交付时再生成受控版式 |
| 项目来源 | 《智能体驱动的抗辐射亿门级 FPGA 应用开发平台项目开题报告》 |

## 1. 文档库目的

本目录用于把开题报告中的项目设想转化为可开发、可验证、可评审、可追踪的软件工程基线，并持续维护：

1. 平台软件自身的需求、架构、实现、测试和交付；
2. 平台所生成的 FPGA/PLDS 工程成果及其完整生命周期过程证据；
3. 从原始需求、结构化需求、设计、RTL/约束、验证证据到硬件结果的双向追踪；
4. 智能体自动化过程中的人工审核、安全管控、配置管理和审计证据。

## 2. 两条工程对象

| 对象 | 定义 | 当前适用规则 |
|---|---|---|
| Synthia 平台软件 | 承载需求理解、设计辅助、候选制品生成、受控 EDA 执行、验证分析、知识与审计的智能体操作平台 | 通用软件工程过程；具体质量/军标等级待项目确认 |
| 目标 PLDS 产品 | 平台为具体 FPGA 项目生成并验证的需求、设计、RTL、约束、网表、码流、测试和报告 | 暂按 GB/T 33781-2017 结构监控 G1～G9 完整生命周期；正式项目仍需按完整授权标准及项目要求逐项裁剪 |

> 符合性声明边界：平台不能仅凭“生成了 RTL”宣称符合 GJB 9432-2018。符合性来自受控过程、完整工作产品、双向追踪、规定的验证活动、评审/批准记录和配置基线共同形成的证据链。

当前总体架构采用“Synthia UI（独立或工业软件嵌入）/Workflow/Agent → Synthia Core → 厂商无关 Connector Port → MCP 或 HTTP/Queue Adapter → Connector Worker → Vivado/实验设备”。Synthia 是智能体操作层，不复制或替代 Vivado/工业软件原生 GUI；MCP 是可替换协议 Adapter；所有工程命令、审批和查询经版本化 Core API；传统 Vivado 工作方式保持独立。多 Agent 候选生成可在 G4/B2 收束，后续仿真、综合、实现、DRC、STA、码流、下载、在线调试、板测和交付仍属于同一 PLDS 过程和证据链。

## 3. 目录与维护顺序

| 路径 | 文档 | 当前状态 |
|---|---|---|
| `REVIEW-GUIDE-20260730.md` | 本次冻结包阅读顺序、评审问题和结论模板 | 交付入口 |
| `PACKAGE-CONTENTS-20260730.md` | 冻结包范围与分组清单 | 交付清单 |
| `00-governance/PLATFORM-DIRECTION-BASELINE.md` | 平台目标、架构、G1～G9 和 RT-UART 定位 | v1.1 讨论冻结候选；v1.0 仍为已确认基线 |
| `00-governance/DISCUSSION-FREEZE-20260730.md` | 截至 2026-07-30 的总体方向、对象、状态和 Connector 决策 | v1.0 讨论冻结候选，当前评审入口 |
| `00-governance/DOCUMENT-CONTROL-PLAN.md` | 文档控制计划 | v0.1 草案 |
| `00-governance/DECISION-LOG.md` | 架构与过程决策记录 | 已建立 |
| `00-governance/OPEN-QUESTIONS.md` | 待确认问题与假设 | 平台落地问题已更新 |
| `01-planning/PROJECT-SCOPE.md` | 项目范围与产品边界 | v0.1 草案 |
| `01-planning/LIFECYCLE-AND-DELIVERABLES.md` | 生存周期、评审门和交付物 | v0.1 草案 |
| `01-planning/EFFECTIVENESS-MEASUREMENT-PLAN.md` | 人工基线、六维效果指标和多 Agent 对照 | v0.1 讨论冻结候选 |
| `01-planning/PLATFORM-DEVELOPMENT-PLAN.md` | 平台工作包、依赖顺序和开发验证策略 | v0.1 讨论冻结候选 |
| `02-requirements/STAKEHOLDER-REQUIREMENTS.md` | 平台利益相关方需求 | v0.3 讨论冻结候选 |
| `02-requirements/PLATFORM-SRS.md` | 平台软件功能、质量、数据和接口需求 | v0.1 讨论冻结候选 |
| `03-golden-flow/GOLDEN-FLOW-SPEC.md` | 平台级 G0/G1～G9 黄金流程与 B0～B4 | v0.2 讨论冻结候选 |
| `03-golden-flow/ARTIFACT-CONTRACTS.md` | 制品、治理对象、快照、状态与知识隔离契约 | v0.2 讨论冻结候选 |
| `03-golden-flow/GATE-AND-APPROVAL-RULES.md` | 阶段门、人工批准、豁免和失效传播规则 | v0.2 讨论冻结候选 |
| `03-golden-flow/AGENT-TEAM-AND-PERMISSIONS.md` | 9 角色 Profile、6 MVP 实例、任务和最小权限 | v0.2 讨论冻结候选 |
| `03-golden-flow/TRACEABILITY-DATA-MODEL.md` | 双向追踪实体、关系、不变量和覆盖率 | v0.2 讨论冻结候选 |
| `03-golden-flow/VIVADO-CONNECTOR-CONTRACT.md` | Connector Port/Adapter/Worker、Job、能力和证据契约 | v0.2 讨论冻结候选 |
| `03-golden-flow/MVP-ACCEPTANCE-PLAN.md` | 平台 MVP 端到端与横切验收计划 | v0.2 讨论冻结候选 |
| `04-architecture/PLATFORM-ARCHITECTURE.md` | 平台组件、控制流、信任边界和部署 | v0.1 讨论冻结候选 |
| `04-architecture/DOMAIN-AND-STATE-MODEL.md` | 领域对象、快照/批准/基线和分实体状态机 | v0.1 讨论冻结候选 |
| `04-architecture/CONNECTOR-ARCHITECTURE.md` | Connector SDK、Adapter、Worker 和强类型能力 | v0.1 讨论冻结候选 |
| `04-architecture/DATA-AND-STORAGE-ARCHITECTURE.md` | 数据分层、一致性、哈希和证据接纳 | v0.1 讨论冻结候选 |
| `05-interfaces/API-AND-EVENT-CONTRACT.md` | Core/Connector API、事件、错误和版本边界 | v0.1 讨论冻结候选 |
| `06-assurance/GJB9432-COMPLIANCE-MATRIX.md` | GJB 9432 符合性与平台支撑矩阵 | 初始框架 |
| `06-assurance/TRACEABILITY-SCHEMA.md` | 双向追踪人类概览 | v0.2；权威模型为 FLOW-005 |
| `01-planning/ASSURANCE-BASELINE.md` | 完整性、安全、部署与审核说明 | 一期建议 |
| `07-pilot/RT-UART/00-PILOT-SELECTION.md` | RT-UART 黄金参考项目定位与公开参考 | v0.3 定位已调整 |
| `07-pilot/RT-UART/01-SYSTEM-REQUIREMENTS.md` | RT-UART 系统需求 | v1.0 已批准 |
| `07-pilot/RT-UART/02-PLDS-SRS.md` | PLDS 软件需求规格 | v1.0 已批准 |
| `07-pilot/RT-UART/03-ARCHITECTURE-DESIGN.md` | 结构设计 | v1.0 已批准 |
| `07-pilot/RT-UART/04-TRACEABILITY-MATRIX.md` | 需求—设计—验证追踪 | v1.0 规划基线 |
| `07-pilot/RT-UART/05-DETAILED-DESIGN.md` | 详细设计 | v1.0 已批准 |
| `07-pilot/RT-UART/06-VERIFICATION-VALIDATION-PLAN.md` | 验证与确认计划 | v0.1 待评审 |
| `07-pilot/RT-UART/07-VERILOG-CODING-STANDARD.md` | Verilog 编码规范 | v0.1 待评审 |
| `07-pilot/RT-UART/08-TEST-SPECIFICATION.md` | 测试与审计规格 | v0.1 待评审 |
| `07-pilot/RT-UART/09-DETAILED-DESIGN-REVIEW-RECORD.md` | 详细设计评审记录 | v1.0 已关闭 |
| `07-pilot/RT-UART/10-CONFIGURATION-MANAGEMENT-PLAN.md` | 配置管理计划 | v0.1 待评审 |
| `07-pilot/RT-UART/11-QUALITY-ASSURANCE-PLAN.md` | 质量保证计划 | v0.1 待评审 |
| `07-pilot/RT-UART/12-IMPLEMENTATION-READINESS-BASELINE.md` | 实现准备基线 | v0.1 有条件就绪 |
| `07-pilot/RT-UART/13-SOFTWARE-DEVELOPMENT-PLAN.md` | PLDS 软件开发计划 | v0.1 待评审 |
| `07-pilot/RT-UART/14-FEASIBILITY-RISK-ANALYSIS.md` | 可行性及风险分析报告 | v0.1 待评审 |
| `07-pilot/RT-UART/15-RISK-MANAGEMENT-PLAN.md` | 风险管理计划与初始登记册 | v0.1 待评审 |
| `07-pilot/RT-UART/16-SAFETY-MANAGEMENT-PLAN.md` | 安全性管理计划 | v0.1 待评审 |
| `07-pilot/RT-UART/17-SECURITY-DEVELOPMENT-ENVIRONMENT-PLAN.md` | 保密、病毒防护与开发环境控制计划 | v0.1 待评审 |
| `07-pilot/RT-UART/18-COMPLIANCE-TAILORING-MATRIX.md` | 临时符合性与裁剪矩阵 | v0.1 待评审 |
| `07-pilot/RT-UART/19-PLDS-TRACEABILITY-SUPPLEMENT.md` | PLDS/详细派生需求追踪补充表 | v0.1 待评审 |
| `07-pilot/RT-UART/20-IMPLEMENTATION-PROCESS-REVIEW-RECORD.md` | 实现前过程文件评审记录 | v0.1 待项目负责人处置 |
| `07-pilot/RT-UART/21-ACTION-ITEM-REGISTER.md` | 统一行动项登记册 | v0.1 已建立 |

当前优先事项是评审 `SYNTHIA-GOV-003`、`SYNTHIA-ARC-001～004`、`SYNTHIA-IF-001` 和修订后的 `SYNTHIA-FLOW-001～007`，随后把契约落实为 Schema、状态机、权限、Connector SDK 和首个 Worker PoC。RT-UART 的未决产品行动继续保留在参考项目登记册中，待平台进入黄金参考项目实例化时按影响和优先级重新调度；它们不再控制平台级文档工作的先后顺序，也不能替代平台软件自身的需求、架构、数据/知识治理、安全、部署运维和验收文档。

## 4. 权威资料与证据等级

| 等级 | 资料 | 用法 |
|---|---|---|
| A | 正式发布且完整的标准文本、经批准的项目需求/合同/技术要求 | 合规判断与验收依据 |
| B | 开题报告、经评审的项目工程文档 | 项目范围和设计依据 |
| C | 对应国标、历史规格、专家经验、工具手册 | 补充说明与方案参考，不单独支持军标符合性结论 |
| D | AI 整理稿、OCR、讨论记录 | 检索和起草辅助，必须复核 |

当前资料状态：

- 开题报告：B 级，已提取项目目标、范围、指标与里程碑；
- `../GJB-9432-2018.pdf`：只包含封面、前言及正文第 1 页，属于不完整标准文本；
- `../GJB-9432-2018.md`：混合 GJB OCR、GB/T 33781 内容及解释性补充，仅作为 D 级辅助资料；
- `../GBT-33781-2017.pdf`：当前文件也仅到正文第 1 页，属于不完整的 C 级参考资料；
- Git 历史中的旧版 SPEC/架构文档：作为历史输入待逐项确认，不自动成为新基线。

## 5. 当前基线结论

1. 产品主线已固定为 G1～G9：“系统需求 → PLDS SRS/派生需求 → 结构/详细设计 → RTL/TB/XDC 与 B2 → 综合 → 布局布线/DRC/STA → 确认测试 → 码流/板测/配置审核 → 验收交付”；G0 负责项目准备。
2. 三个重点业务环节为高覆盖可测性向量、需求到可综合 FPGA 设计、设计到硬件。
3. 需求—设计—代码—验证追踪覆盖率目标为 100%。
4. Agent 只能产生 `candidate`，只有授权人类可以批准、拒绝、豁免、建立基线和验收；工具运行分为 exploratory/gate_check/formal，关键 EDA 操作成功也不等于工程门获批。
5. 平台原则上本地或私有化部署，敏感工程数据不出域。
6. 尚未确认的需求不得隐藏在正文中，应使用 `TBD` 和问题编号管理。
7. RT-UART 是第一条黄金参考项目、模板来源、多 Agent 评测集、Connector 回归样例和模拟知识库，不再作为平台主规格优先深化。
8. 现阶段只能表述为“按 GB/T 33781-2017 结构进行临时过程监控”，不能声明已经符合 GB/T 33781-2017 或 GJB 9432-2018。
9. RT-UART 当前只有产品文档和规划关系：尚无 RTL、XDC、综合网表、实现报告、运行证据或码流。其 31/31、46/46、4/4 等数字只表示相应追踪关系已规划，不表示平台或产品实现、验证已经通过。
10. 默认知识检索只使用已批准且有效的成果；草案、错误方案、故障注入样本和失败运行必须进入隔离的历史库或评测集。
11. 每个门批准形成 ApprovedGateResult，只有 G1/G3/G4/G7/G9 建立 B0～B4；不存在候选基线。
12. 平台定义 9 种专业角色 Profile，MVP 用 6 个逻辑实例按需承载；增加编排复杂度必须由对照评测证明收益。
