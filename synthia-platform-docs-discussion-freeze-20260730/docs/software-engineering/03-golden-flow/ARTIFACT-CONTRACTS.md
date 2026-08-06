# Synthia 黄金流程制品契约

| 属性 | 内容 |
|---|---|
| 文档编号 | SYNTHIA-FLOW-002 |
| 版本/状态 | v0.2 / 讨论冻结候选，待正式评审 |
| 上游 | SYNTHIA-FLOW-001 v0.2、SYNTHIA-ARC-002/004 |
| 目的 | 固定各阶段输入、输出、元数据、状态和证据包边界 |

## 1. 契约原则

平台把内容制品、过程记录、配置快照、批准、执行和证据作为不同的 `ControlledObject` 对象族管理，而不是把所有对象强塞进一个 artifact 类型和状态机。Agent 可以生成候选内容和建议，但不能通过只输出一段自然语言宣称任务完成；阶段完成必须由规定对象、机器校验和人类批准共同证明。

制品内容可存于 Git、数据库或对象存储，但元数据、关系和哈希必须由同一配置视图解析。

## 2. 公共元数据

每个内容制品修订至少具有：

| 字段 | 要求 |
|---|---|
| `artifact_id` | 项目内唯一且不可复用 |
| `artifact_type` | 使用本契约批准的类型枚举 |
| `project_id` | 所属目标 PLDS 项目 |
| `version` | 单调版本或不可变修订 ID |
| `state` | 内容修订状态，见 SYNTHIA-ARC-002 |
| `snapshot_ids/baseline_ids` | 引用该精确修订的快照/批准基线；候选基线不存在 |
| `source_ids` | 直接输入制品/需求/决策/运行 ID |
| `created_by` | 人员、Agent 或 Connector 服务身份 |
| `created_at` | 可信时间戳和时区 |
| `content_hash` | 内容 SHA-256 或批准算法 |
| `schema_version` | 结构契约版本 |
| `classification` | 数据域/密级标签及继承规则 |
| `tool_model_provenance` | 适用时记录模型、提示、知识库或工具版本 |
| `change_reason` | 新建、修复、需求变更、重新生成等原因 |
| `review_ids` | 关联审查、问题、豁免和批准记录 |

任何批准制品内容或关键元数据发生变化都必须产生新版本和新哈希，不能原地修改。

## 3. 对象族与状态

| 对象 | 状态规则 |
|---|---|
| ArtifactRevision | `candidate → in_review → approved/rejected`；approved 可转 `superseded/invalidated` |
| GateSubmission | `preparing → submitted → checking → in_review → approved/rejected/withdrawn` |
| Baseline | 由批准事件创建为 `active`，可转 `superseded/invalidated/retired`；无 candidate |
| ApprovalRecord | append-only 决定事件，不原地修改；撤销创建新事件 |
| ToolRun | 独立异步状态机，见 SYNTHIA-ARC-002/003 |
| TraceRelation | `candidate/in_review/approved/rejected/review_required/superseded/invalidated` |
| Issue/Risk/Task/Waiver | 使用各自工作流，不复用内容状态 |

`review_required` 表示需要重新判断；`invalidated` 表示当前不能继续支持新的正式放行；`superseded` 表示已由后续批准对象替代。

## 4. 核心制品类型

内容制品是容器，Requirement、DesignElement、ImplementationItem 和 VerificationItem 是可独立修订和追踪的成员。容器与成员均具有稳定 ID、修订和哈希；单条成员变化通过关系图传播影响，不默认粗暴作废整个容器。

### 4.0 过程、配置和治理对象

| 类型 ID | 对象 | 最小内容 |
|---|---|---|
| `CONFIGURATION_SNAPSHOT` | 不可变配置快照 | 精确成员/关系修订、流程/Gate Profile、清单哈希 |
| `GATE_SUBMISSION` | 阶段门提交 | 门、快照、提交者、检查状态、问题和差异 |
| `APPROVAL_RECORD` | 人类决定事件 | 决定、对象/哈希、身份/角色、理由、证据和时间 |
| `APPROVED_GATE_RESULT` | 批准阶段结果 | 门、批准快照、检查与批准记录 |
| `BASELINE` | B0～B4 配置里程碑 | kind、成员、关系快照、清单哈希和批准 ID |
| `WAIVER` | 豁免/偏差 | 规则、证据、影响、补偿、范围、到期和批准 |
| `ISSUE_RISK_DECISION` | 问题、风险和决策 | 严重度/概率、影响、措施、责任、结论和证据 |
| `TASK_HANDOFF` | 任务与交接 | 冻结输入、允许动作、输出 Schema、预算和结果 |
| `KNOWLEDGE_ENTRY` | 知识条目 | 来源、分区、适用条件、状态、数据域和失效条件 |

### 4.1 G0/G1 项目与系统需求

| 类型 ID | 制品 | 最小内容 |
|---|---|---|
| `SOURCE_PACKAGE` | 原始需求/任务书包 | 原文件、来源、接收时间、哈希、数据域、完整性检查 |
| `PROJECT_PROFILE` | 项目配置 | 范围、标准、等级状态、器件/板卡/工具、角色、数据域、交付边界 |
| `TAILORING_RECORD` | 标准适用/裁剪记录 | 条款、适用性、理由、风险、替代证据、批准 |
| `FEASIBILITY_RISK_REPORT` | 可行性及风险分析 | 器件、环境、资源、时序、工具、进度、人员和关键风险 |
| `DEVELOPMENT_REQUIREMENTS` | 开发技术要求 | 功能/性能/接口/器件/环境/安全可靠性/测试/交付要求 |
| `SYSTEM_REQUIREMENTS` | 系统需求规格 | 稳定 ID、来源、需求文本、验证方向、状态和关键度 |
| `OPEN_QUESTION_SET` | 澄清/假设集合 | 问题、假设、影响、责任、期限和处置 |

### 4.2 G2 PLDS 需求

| 类型 ID | 制品 | 最小内容 |
|---|---|---|
| `PLDS_SRS` | PLDS 软件需求规格 | 功能、性能、接口、算法、时钟复位、资源时序、器件、可靠性、安全、保密、测试和维护需求 |
| `DERIVED_REQUIREMENT_SET` | 派生需求集合 | 派生理由、上游反馈、影响和批准状态 |
| `REQUIREMENT_TRACE` | 系统—PLDS 追踪 | 双向关系、覆盖状态和孤立项 |
| `VERIFICATION_METHOD_MAP` | 需求验证方法 | 审查/分析/静态/仿真/测试及初始通过准则 |

### 4.3 G3 设计

| 类型 ID | 制品 | 最小内容 |
|---|---|---|
| `ARCHITECTURE_DESIGN` | 结构设计 | 设计单元、接口、数据/控制流、需求分配和设计原则 |
| `DETAILED_DESIGN` | 详细设计 | 寄存器、状态机、时序、算法、存储、IP、异常、安全和诊断语义 |
| `CONSTRAINT_DESIGN` | 约束设计 | 时钟、I/O、CDC/RDC、时序例外、面积/功耗目标和依据 |
| `DESIGN_TRACE` | 需求—设计追踪 | 每项需求到单元/接口/状态/约束的关系 |
| `DESIGN_REVIEW` | 设计评审记录 | 对象版本、参与角色、问题、行动、结论和签署 |

### 4.4 G4 RTL 基线

| 类型 ID | 制品 | 最小内容 |
|---|---|---|
| `RTL_SOURCE_SET` | RTL 源码集 | 文件/模块、语言、需求/设计引用、IP/许可证和哈希 |
| `TB_SOURCE_SET` | 验证源码集 | TB、BFM、参考模型、断言、覆盖、故障注入和种子策略 |
| `XDC_CANDIDATE` | 约束草案 | 目标对象、约束内容、来源和未决板级项 |
| `CODE_TRACE` | 需求/设计—RTL—测试追踪 | 模块、信号/过程、测试、覆盖点关系 |
| `CODE_REVIEW` | 代码审查记录 | 规范、接口、时钟复位、异常、安全、可测试性、问题和批准 |
| `STATIC_REPORT_SET` | 编译/Lint/CDC/RDC 结果 | 原始报告、工具版本、配置、问题和豁免 |
| `BUILD_MANIFEST` | B2 构建清单 | 输入、版本、哈希、生成谱系、命令、环境和输出 |

### 4.5 G5/G6 Vivado 工程实现

| 类型 ID | 制品 | 最小内容 |
|---|---|---|
| `TOOLCHAIN_PROFILE` | 工具链配置 | Vivado/补丁/许可证环境、part、strategy、Connector 版本和能力 |
| `TOOL_RUN` | 受控运行记录 | 运行 ID、操作、`run_class`、输入快照/批准结果、命令/参数、状态、时间、操作者和返回码 |
| `SYNTH_RESULT` | 综合结果 | 原始日志、综合网表/DCP、资源、综合 DRC/CDC 和结构检查 |
| `IMPLEMENT_RESULT` | 实现结果 | opt/place/route 检查点、日志、资源和物理结果 |
| `DRC_REPORT` | DRC | 原始规则、严重度、违规和豁免 |
| `STA_REPORT` | 静态时序分析 | 时钟/路径、WNS/WHS、未约束对象、例外和完整报告 |
| `POWER_REPORT` | 功耗分析 | 条件、模型、活动率、结果和余量；适用时必须提供 |

### 4.6 G7～G9 测试、产品和交付

| 类型 ID | 制品 | 最小内容 |
|---|---|---|
| `CONFIRMATION_TEST_PLAN` | 确认测试计划 | 范围、环境、角色、入口/退出、覆盖和问题流程 |
| `TEST_SPECIFICATION` | 测试说明/用例 | 需求关联、前置、激励、期望、通过准则和证据要求 |
| `TEST_RUN` | 测试执行 | 配置、版本、种子/仪器、日志、波形、结果和问题 |
| `COVERAGE_REPORT` | 覆盖报告 | 分母、命中、排除、工具和原始数据库引用 |
| `CONFIRMATION_TEST_REPORT` | 确认测试报告 | 需求结果、失败、覆盖、遗留问题和批准结论 |
| `BITSTREAM_PACKAGE` | 码流包 | `.bit/.bin` 等、输入实现 ID、生成命令、哈希和目标器件 |
| `HARDWARE_TEST_RECORD` | 板测/在线调试记录 | 板卡/器件/序列号、接线、下载、ILA/VIO、仪器、步骤和结果 |
| `CONFIG_AUDIT` | 功能/物理配置审核 | 需求满足、交付清单、版本、哈希和缺口 |
| `USER_MANUAL` | 用户手册 | 集成、配置、接口、构建、下载、诊断、限制和维护 |
| `DEVELOPMENT_SUMMARY` | 研制总结 | 过程、指标、问题、风险、经验和交付结论 |
| `RELEASE_PACKAGE` | 正式交付包 | B4 清单、签署、接收方、介质/位置、完整性和归档 |

## 5. 阶段输入输出契约

| 门 | 必须批准的输入 | 必须产生的候选输出 |
|---|---|---|
| G1 | SOURCE_PACKAGE、PROJECT_PROFILE、适用裁剪输入 | 可行性/风险、开发技术要求、系统需求、开放问题处置 |
| G2 | B0 系统需求 | PLDS SRS、派生需求、系统—PLDS 追踪、验证方法 |
| G3 | 批准 G2 阶段结果 | 结构/详细/约束设计、设计追踪和评审记录 |
| G4 | B1 设计输入 | RTL、TB、XDC 草案、代码追踪、审查、静态报告、manifest |
| G5 | B2、TOOLCHAIN_PROFILE | 综合运行、网表/DCP、资源/结构/综合报告 |
| G6 | 批准 G5 阶段结果 | 实现运行、检查点、DRC、STA、资源/功耗报告 |
| G7 | 批准需求/设计/G6 结果和测试计划/说明 | 测试运行、覆盖、问题和确认测试报告 |
| G8 | 批准 G6/G7 阶段结果、硬件环境 | 码流、下载/ILA/VIO/板测记录和配置审核 |
| G9 | 批准 G8 阶段结果 | 用户手册、总结、质量/配置报告、交付/接收记录 |

## 6. 运行与证据分类

- `exploratory` 可使用候选输入，但不得计入门禁、正式覆盖、需求通过率或发布；
- `gate_check` 必须绑定冻结 GateSubmission 快照，只能支持该门审批，快照变化即失效；
- `formal` 输入必须全部批准且有效，工作区可重现，工具/模型版本受控，原始结果完整，输出哈希固定。

三类运行均保存失败、取消、超时、人工干预和原始证据。`succeeded` 不能自动产生工程批准。

## 7. 知识库与评测集契约

| 分区 | 允许内容 | 默认检索 |
|---|---|---|
| 批准知识库 | approved 需求、设计、规则、审查结论、经验证工具经验 | 允许，按项目/数据域/版本过滤 |
| 历史库 | superseded、普通草案、讨论和人工修改历史 | 默认关闭，显式审计时使用 |
| 评测集 | 错误 RTL、失败日志、缺陷注入、对抗提示和预期判定 | 不作为正确知识，只供评测运行 |
| 隔离区 | rejected、来源不明或恶意/未扫描内容 | 禁止普通 Agent 检索 |

任何知识条目都必须关联来源制品、批准状态、适用器件/工具版本、数据域和失效条件。

## 8. 契约校验

平台应提供确定性校验：Schema、必填字段、ID 唯一性、哈希、分实体状态转换、引用存在性、孤立追踪、快照/基线一致性、批准身份、run_class 与输入状态、豁免到期和知识分区。校验失败必须阻止相应门禁，不能由 Agent 自行忽略。

## 9. 后续机器可读化

本文件批准后，应建立 JSON Schema 或等效结构定义，并为每类制品提供最小有效、缺字段、非法状态和跨项目引用等测试样本。Markdown/PDF 是人类视图，不作为唯一追踪事实源。
