# Synthia 平台软件开发计划

| 属性 | 内容 |
|---|---|
| 文档编号 | SYNTHIA-PLAN-004 |
| 版本/状态 | v0.1 / 讨论冻结候选，日期与人员待定 |
| 日期 | 2026-07-30 |
| 上游 | SYNTHIA-GOV-003、SYNTHIA-REQ-002、SYNTHIA-ARC-001～004、SYNTHIA-FLOW-007 |

## 1. 开发原则

采用模块化单体 Core + 独立 Connector Worker 起步。先固定领域对象、状态、权限和证据，再扩展 UI 与 Agent 自动化；先实现可重现的纵向切片，再增加多 Agent 复杂度、厂商范围和高级 Vivado 能力。日期在 Q-018 关闭后基线化，本计划只固定依赖顺序。

## 2. 工作分解

| WP | 工作包 | 主要输出 |
|---|---|---|
| WP-0 | 文档和架构批准 | GOV/REQ/ARC/IF/FLOW v1.0、未决问题责任人 |
| WP-1 | Synthia Core 骨架 | Project、Process、ArtifactRevision、Snapshot、Gate、Approval、Baseline |
| WP-2 | 追踪和治理 | Trace、Impact、Issue/Risk/Waiver、确定性不变量 |
| WP-3 | 数据与身份 | 元数据数据库、Git/对象存储接纳、RBAC、审计、Outbox |
| WP-4 | Connector SDK | Capability、Job、Worker、Manifest、Evidence、锁、幂等、错误、恢复 |
| WP-5 | Vivado 首切片 | 发现、预检、XSim、综合、DRC/STA/资源、EvidenceManifest |
| WP-6 | MCP Adapter | 强类型 Tool、异步 job_id、状态和证据资源 |
| WP-7 | Agent/Workflow 到 B2 | 6 逻辑实例、冻结 TaskPackage、G1～G4、RT-UART |
| WP-8 | 实现和确认 | opt/place/route、CDC/结构、G5～G7 |
| WP-9 | Board/Lab 和交付 | 码流、下载、ILA、UART/仪器、G8/G9、B4 |
| WP-10 | 产品化 | 恢复、运维、度量、更多样例、工业软件嵌入形态和更多 Adapter |

## 3. 分阶段入口和退出

### D0 定义基线

入口：讨论冻结包完成。退出：决定性对象、状态、基线、运行分类、Connector 边界获得正式评审；Q-011、Q-013、Q-015～Q-020 有责任人和日期。

### D1 Core 数据骨架

入口：REQ/ARC/IF 批准。退出：核心 Schema、迁移、状态转换、append-only 批准、快照哈希和单元/契约测试通过；不要求完整 Web。

### D2 Connector 首切片

入口：Connector Port/SDK 和数据接纳协议批准。退出：真实 Worker 完成能力发现、Manifest/哈希、至少一次仿真和综合、DRC/STA/资源报告、取消/超时/失败和 EvidenceManifest；MCP Adapter 可提交并查询异步 Job。

### D3 G1～G4/B2

入口：Core 与首切片稳定。退出：RT-UART 从来源包经拒绝/修订/批准到 B2；gate_check 与 formal 隔离；9 角色/6 实例映射和三组评测可运行。

### D4 G5～G7/B3

入口：批准 B2 和 EDA Worker。退出：正式综合、实现、DRC/STA/CDC/结构、确认测试和问题回归形成 B3。

### D5 G8～G9/B4

入口：板卡、实验环境和角色批准。退出：码流、目标授权、下载、ILA/板测、配置审核、交付重现和 B4 完成。

### D6 产品化

入口：端到端闭环。退出：部署、备份恢复、升级兼容、度量、运维、更多样例和安全审查达到批准目标。

## 4. 开发与验证策略

- 每个领域状态机使用表驱动转换和非法转换测试；
- 每个 API/事件/Capability 提供 Schema、正例、缺字段、越权、并发和版本兼容测试；
- 批准、基线和 Evidence 接纳使用事务/故障注入测试；
- Connector 使用模拟工具进行快速测试，并在真实 Vivado Worker 上保留原始回归证据；
- 非幂等硬件操作测试断线、超时、lost 和 unknown_effect，不自动重试；
- RT-UART 作为回归和评测输入，不把其器件/接口规则提升为平台默认；
- 安全、数据域、审计和恢复作为每阶段横切退出条件；
- 远程 Connector 兼容模式（SYNTHIA-FLOW-006 §16、SYNTHIA-IF-001 §9）以注入 transport/fetch 的 Fake/HTTP 契约测试验证；真实 Vivado PoC 须在用户提供授权主机后按 SYNTHIA-FLOW-006 §16.8 步骤执行并保留原始回归证据，此前任何里程碑不得把远程模式标记为已验证。

## 5. 配置与发布

平台代码、Schema、流程模板、Agent Profile、Connector SDK/Worker、Adapter 和解析器分别版本化。每个发布包应包含变更、迁移、兼容矩阵、测试结果、已知限制和回退方案。平台发布不能静默改变已批准目标项目；需要迁移时先生成 ImpactAssessment。

## 6. 资源和依赖

需要平台开发、FPGA/Vivado、验证、质量/配置、安全、硬件/实验室角色，以及 Linux/Windows Vivado Worker、许可证、板卡和存储/身份环境。实际人员、并行度和日历在 Q-008/Q-010/Q-013/Q-014/Q-018/Q-020 关闭后填写。

## 7. 当前状态

截至 2026-07-30，D0 为讨论冻结候选；D1～D6 均未开始。旧 Synthia 实现不作为新基线，只有项目负责人后续明确提供和评审的部分才可选择性复用。
