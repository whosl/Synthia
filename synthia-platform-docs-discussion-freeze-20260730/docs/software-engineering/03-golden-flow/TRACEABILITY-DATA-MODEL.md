# Synthia 双向追踪数据模型

| 属性 | 内容 |
|---|---|
| 文档编号 | SYNTHIA-FLOW-005 |
| 版本/状态 | v0.2 / 讨论冻结候选，待正式评审 |
| 上游 | SYNTHIA-FLOW-001～004 v0.2、SYNTHIA-ARC-002/004 |
| 权威原则 | 结构化数据为事实源；Markdown/PDF 矩阵为生成视图 |

## 1. 目标

追踪模型用于回答：需求为何存在、分配到何处、由什么代码实现、由什么测试验证、在哪个工具/硬件配置上得到什么结果、由谁批准并进入哪个基线。模型同时支持覆盖率、影响分析、门禁、审计和知识检索隔离。

## 2. 核心实体

| 实体 | 说明 | 关键字段 |
|---|---|---|
| `Project` | 目标 PLDS 项目 | ID、范围、流程版本、数据域、状态 |
| `WorkflowInstance` | 黄金流程实例 | 阶段、Gate Profile、标准/裁剪版本 |
| `Source` | 原始需求/任务书/标准/接口资料 | 来源、版本、哈希、授权、数据域 |
| `Requirement` | 系统或 PLDS 需求 | 层级、文本、来源、关键度、状态、验证方法 |
| `Decision` | 批准的技术/过程决策 | 问题、选项、结论、理由、批准 |
| `DesignElement` | 单元、接口、状态机、寄存器、算法、约束设计 | 类型、章节/模型位置、状态 |
| `ImplementationItem` | RTL 模块/文件、IP、XDC 规则 | 语言、位置、版本、哈希、许可证 |
| `VerificationItem` | 审查、分析、检查、测试、覆盖点 | 方法、通过准则、执行要求 |
| `ToolRun` | Agent/工具/Connector 运行 | run_class、输入快照/批准结果、环境、命令、状态、输出和原始证据 |
| `Evidence` | 日志、报告、波形、DCP、码流、板测记录 | 类型、哈希、存储引用、生成运行 |
| `Issue` | 缺陷、不符合项、问题或风险触发 | 严重度、影响、根因、措施、状态 |
| `ConfigurationSnapshot` | 不可变候选/配置视图 | 成员/关系精确修订、流程/Gate Profile、清单哈希 |
| `GateSubmission` | 阶段门提交 | 门、快照、检查、差异、问题和状态 |
| `ApprovalRecord` | 人类审查/批准/拒绝/撤销/豁免事件 | 对象快照、人类身份、决定、理由；append-only |
| `ApprovedGateResult` | G1～G9 批准阶段结果 | 门、快照、检查和批准 ID |
| `Baseline` | B0～B4 不可变里程碑配置 | 类型、成员、关系快照、清单哈希、批准 ID；无 candidate |
| `KnowledgeEntry` | 可检索知识/历史/评测资产 | 来源、分区、状态、适用条件、数据域 |

所有实体使用稳定 ID；标题、文件路径、章节号和 Git 行号不能作为唯一身份。

## 3. 关系类型

| 关系 | 来源 → 目标 | 含义 |
|---|---|---|
| `derived_from` | PLDS/派生需求 → 上游需求/Source | 来源或派生依据 |
| `refines` | 下层需求/设计 → 上层对象 | 细化但不替代 |
| `allocated_to` | Requirement → DesignElement | 需求分配 |
| `implemented_by` | Requirement/DesignElement → ImplementationItem | 实现关系 |
| `verified_by` | Requirement/Design/Implementation → VerificationItem | 验证规划 |
| `executed_in` | VerificationItem → ToolRun | 具体执行 |
| `produces` | ToolRun → Evidence/Artifact | 运行产物 |
| `supports` | Evidence → Requirement/Gate/Conclusion | 证据支持对象 |
| `contradicts` | Issue/Evidence → 对象 | 发现冲突或失败 |
| `affected_by` | 对象 → Change/Issue | 影响分析结果 |
| `submitted_as` | ConfigurationSnapshot → GateSubmission | 快照提交到某门 |
| `decided_by` | GateSubmission/Waiver → ApprovalRecord | 人类决定关系 |
| `establishes` | ApprovalRecord → ApprovedGateResult/Baseline | 批准建立阶段结果或里程碑 |
| `member_of` | Artifact/Evidence/Relation → ConfigurationSnapshot/Baseline | 配置归属 |
| `supersedes` | 新版本 → 旧版本 | 版本替代 |
| `extracted_as` | 批准 Artifact/Evidence → KnowledgeEntry | 知识提取 |

关系自身具有 ID、创建者、来源依据、版本、状态和批准归属。Agent 建立的是候选关系，人类门禁批准快照内的正式关系。文档/集合是 Artifact 容器，Requirement、DesignElement、ImplementationItem、VerificationItem 是可独立修订和影响分析的成员实体。

## 4. ID 规则

建议格式：`<PROJECT>-<TYPE>-<DOMAIN>-<NNNN>`，例如 `RTUART-REQ-FUN-0001`、`RTUART-DES-FSM-0002`、`RTUART-TST-UART-0010`。平台内部使用不可变 UUID/ULID，显示 ID 可由项目规则生成；显示 ID 变更不能破坏内部引用。

类型前缀至少包括：`SRC/SYSREQ/PLDSREQ/DRV/DES/RTL/IP/XDC/VER/TST/RUN/EVD/ISS/RISK/REV/APR/BL/KNW`。

## 5. 追踪不变量

### 5.1 G2 需求不变量

- 每条批准 PLDS 需求必须有至少一个 `derived_from` 上游，或有批准的派生理由；
- 每条批准系统需求至少有一个 PLDS 分配或经批准不适用；
- 派生需求影响必须回到 G1/G2 审查，不能只在设计中隐藏。

### 5.2 G3 设计不变量

- 每条批准 PLDS 需求至少 `allocated_to` 一个设计元素；
- 每个批准设计元素至少有需求/约束/批准决策来源，避免无来源设计；
- 安全关键需求必须关联专项设计和验证项。

### 5.3 G4 B2 不变量

- 每条适用需求至少关联实现项和验证项；
- 每个交付 RTL/IP/XDC 有批准设计来源和配置身份；
- 每个正式测试有批准需求或设计目标，不能只为提高覆盖率存在；
- 代码审查和静态报告必须关联精确源版本。

### 5.4 G5～G9 证据不变量

- `formal` ToolRun 的所有输入状态为 approved 且属于同一允许配置视图；`gate_check` 必须绑定冻结 GateSubmission；
- Evidence 必须关联产生它的 ToolRun，ToolRun 关联工具/环境和输入基线；
- 需求结论必须经 VerificationItem → ToolRun → Evidence 证明；
- Bitstream 必须追溯到实现检查点、B2、part、Vivado/strategy 和批准 G6/G7；
- B4 成员必须全部具有版本、哈希和交付决定。

## 6. 状态与有效性

关系有效性取决于两端对象版本和关系自身状态。上游批准对象变化时，下游关系进入 `review_required`；确认当前不能支持新放行时，相关验证结果和批准有效性进入 `invalidated`。旧关系保留用于历史重现，不直接删除。

关系状态为 `candidate/in_review/approved/rejected/review_required/superseded/invalidated`。ArtifactRevision、GateSubmission、Baseline、ApprovalRecord、ToolRun、Issue/Risk/Task 使用各自状态机，权威定义见 `../04-architecture/DOMAIN-AND-STATE-MODEL.md`，禁止套用关系状态。

## 7. 覆盖率定义

| 指标 | 分子 | 分母 | 限制 |
|---|---|---|---|
| 需求来源覆盖 | 有有效来源/派生批准的需求 | 适用批准需求 | 不表示设计或实现完成 |
| 设计分配覆盖 | 有批准 `allocated_to` 的需求 | 适用批准需求 | 不表示设计正确 |
| 实现规划覆盖 | 有 `implemented_by` 候选/批准关系的需求 | 适用批准需求 | 必须区分候选和批准 |
| 验证规划覆盖 | 有 `verified_by` 的需求 | 适用批准需求 | 不表示执行通过 |
| 验证执行覆盖 | 有正式 ToolRun 的验证项 | 应执行验证项 | 失败运行仍计“已执行”，不能计通过 |
| 需求通过率 | 有批准通过结论和有效证据的需求 | 应验证需求 | 排除/未执行单列 |
| 反向实现覆盖 | 有批准来源的实现项 | 交付实现项 | 发现无来源代码/IP |

平台必须同时显示分子、分母、状态和时间/基线。禁止把规划覆盖率写成测试通过率。

## 8. 结构化示例

```yaml
relationship:
  id: RTUART-TRACE-000123
  type: verified_by
  source:
    id: RTUART-PLDSREQ-FUN-0004
    version: 1.0
  target:
    id: RTUART-TST-RX-0002
    version: 0.3
  state: candidate
  rationale: "16x oversampling phase and glitch behavior"
  created_by:
    kind: agent
    role: verification
    task_id: task-01J...
  schema_version: "1.0"
```

该示例只说明形状，不代表关系已批准或测试已执行。

## 9. 影响分析

变更从对象沿出边/入边传播，至少返回：直接受影响、间接受影响、可能失效批准、必需回归、需要重新审查的门、未能解析的未知影响。分析结果是候选，关键范围由人类确认。

典型规则：

- Requirement 变更：重新检查下游设计、RTL、验证、报告和交付；
- DesignElement 变更：检查 RTL、XDC、测试模型、综合网表和确认结果；
- RTL/XDC 变更：使相关静态、仿真、综合、实现、码流和板测证据失效；
- Toolchain/part 变更：至少使 G5～G8 结果失效，并检查 G3/G4 约束；
- VerificationItem/参考模型变更：重新评估过去通过结论是否可信。

## 10. 基线快照

ConfigurationSnapshot 保存成员精确版本、关系快照、门禁配置、流程版本、标准/裁剪版本和清单哈希。每个门批准形成 ApprovedGateResult；只有 G1/G3/G4/G7/G9 建立 B0～B4。查询“当前项目状态”必须指定基线、批准阶段结果或候选工作区，不能混合最新文件与历史批准结果。

## 11. 知识库关系

KnowledgeEntry 不能脱离来源制品独立存在。默认检索必须满足：来源 approved、关系有效、数据域允许、适用器件/工具/标准版本匹配、未被后续问题标记失效。历史/错误样本只在显式评测上下文中返回。

## 12. 平台 API/查询最低能力

- 从任何需求正向导航到设计、RTL、测试、运行、证据和基线；
- 从任何 RTL/IP/XDC 反向导航到需求和批准设计；
- 从码流反向导航到 part、Vivado、strategy、B2、测试和批准；
- 检测孤立、跨项目越权、失效关系和未执行项；
- 计算候选/批准/执行/通过四类覆盖率；
- 对变更给出影响图和建议回退门；
- 为评审和交付导出不可变追踪快照。

## 13. 后续实现要求

本模型批准后，应建立数据库约束和 JSON Schema、关系迁移策略、并发修改/合并规则、查询性能目标、权限过滤测试及 RT-UART 结构化数据样本。当前 Markdown 矩阵仅作为迁移输入，不能直接视为平台数据层已完成。
