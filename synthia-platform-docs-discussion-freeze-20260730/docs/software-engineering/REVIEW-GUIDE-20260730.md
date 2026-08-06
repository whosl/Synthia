# Synthia 讨论冻结包评审指南

| 属性 | 内容 |
|---|---|
| 包标识 | `synthia-platform-docs-discussion-freeze-20260730` |
| 状态 | 讨论冻结候选，待项目负责人及专业角色正式评审 |
| 适用范围 | Synthia 平台级治理、规划、需求、黄金流程、架构、接口和保证文档 |
| 排除范围 | RT-UART 详细产品文档、旧 Synthia 实现、标准全文、平台实现代码和运行证据 |

## 1. 推荐阅读顺序

1. `00-governance/DISCUSSION-FREEZE-20260730.md`：当前全部决定和未决项；
2. `02-requirements/STAKEHOLDER-REQUIREMENTS.md`、`PLATFORM-SRS.md`：平台上层和软件需求；
3. `01-planning/PLATFORM-DEVELOPMENT-PLAN.md`、`04-architecture/PLATFORM-ARCHITECTURE.md`：开发顺序、总体组件和信任边界；
4. `04-architecture/DOMAIN-AND-STATE-MODEL.md`：快照、批准、基线和状态机；
5. `03-golden-flow/GOLDEN-FLOW-SPEC.md`：G0～G9；
6. `03-golden-flow/ARTIFACT-CONTRACTS.md`、`GATE-AND-APPROVAL-RULES.md`、`TRACEABILITY-DATA-MODEL.md`；
7. `04-architecture/CONNECTOR-ARCHITECTURE.md`、`DATA-AND-STORAGE-ARCHITECTURE.md`、`05-interfaces/API-AND-EVENT-CONTRACT.md`；
8. `03-golden-flow/AGENT-TEAM-AND-PERMISSIONS.md`、`VIVADO-CONNECTOR-CONTRACT.md`、`MVP-ACCEPTANCE-PLAN.md`；
9. `00-governance/OPEN-QUESTIONS.md` 和 `01-planning/EFFECTIVENESS-MEASUREMENT-PLAN.md`。

## 2. 本次需要确认的决定性问题

### A. 总体定义

- 是否确认 Synthia 是面向 FPGA 工程的智能体操作平台，而不是 Vivado/工业软件替代品或单一 RTL 生成器？
- 是否确认 Synthia UI 可独立运行，并保留未来嵌入工业软件小窗/WebView 的形态？
- 是否确认 UI、Workflow、Agent、Core、Connector Port、Adapter、Worker 分层，以及命令/审批/查询只经版本化 Core API？
- 是否确认 Workflow Engine 和 Synthia Core 分别拥有流程及工程元数据真相？
### B. 配置与状态

- 是否确认每门产生 ApprovedGateResult，仅 G1/G3/G4/G7/G9 建立 B0～B4？
- 是否确认不存在 candidate Baseline？
- 是否确认不同实体采用独立状态机，批准/撤销/豁免 append-only？

### C. 工具运行

- 是否确认 `exploratory/gate_check/formal` 三类运行？
- 是否确认 G4 在冻结快照做 gate_check，G5 对 B2 正式 CDC/结构复核？
- 是否确认 ToolRun `succeeded` 不等于工程门批准？

### D. Agent

- 是否确认 9 种专业角色 Profile、6 个 MVP 逻辑实例？
- 是否确认默认 1 生成 + 1 保证/审查，复杂编排由评测证明后增加？

### E. Connector

- 是否确认 MCP 只是可替换 Adapter？
- 是否确认 Connector SDK、异步 Job、EvidenceManifest 是首个复用核心？
- 是否确认 Vivado 与 Board/Lab Connector 分离？
- 是否确认不直接开放任意 Tcl？

## 3. 批准前必须处置

至少应对 `OPEN-QUESTIONS.md` 中 Q-011、Q-013、Q-015～Q-020 指定责任人和截止日期。平台软件正式 SRS 仍需从利益相关方需求进一步派生；数据库产品、部署拓扑、API Schema、阈值和角色任命仍未批准。

## 4. 评审结论模板

```text
评审对象：synthia-platform-docs-discussion-freeze-20260730
结论：批准 / 有条件批准 / 退回修改
批准范围：
不批准或待修改项：
行动项及责任人：
截止日期：
评审人/角色：
日期：
```

“批准本讨论冻结包”只表示接受平台工程定义作为下一阶段输入，不表示平台已经实现、RT-UART 已建立 B2/B4，或已经符合 GB/T 33781-2017/GJB 9432-2018。
