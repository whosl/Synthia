# Synthia 当前讨论结果冻结基线

| 属性 | 内容 |
|---|---|
| 文档编号 | SYNTHIA-GOV-003 |
| 版本/状态 | v1.0 / 讨论冻结候选，待正式评审 |
| 冻结日期 | 2026-07-30 |
| 冻结范围 | 平台目标、总体架构、黄金流程、Agent 策略、领域对象、Connector 和证据边界 |
| 上游 | 开题报告、SYNTHIA-GOV-002 v1.0、SYNTHIA-FLOW-001～007 v0.1、截至冻结日的项目负责人讨论 |
| 不代表 | 平台已经实现、目标 PLDS 已通过门禁、已符合 GB/T 33781-2017 或 GJB 9432-2018 |

## 1. 冻结目的

本文把截至 2026-07-30 已形成共识的方向固定为后续需求、架构、接口、数据模型和开发计划的统一输入。发生冲突时：完整授权的适用标准和项目正式要求优先；其次是经项目负责人正式批准的受控文档；本文仅作为当前讨论冻结候选，批准前不得用于出具正式符合性或交付结论。

## 2. 平台定义

Synthia 是面向 FPGA 工程的智能体操作平台，不是 Vivado 或其他 FPGA 工业软件的替代品，也不是单一 RTL 生成器。平台接收原始需求或任务书，借助受控 Agent 和 Skill 完成需求理解、设计辅助、RTL/测试/约束候选生成、工程分析和任务规划；在用户明确授权范围内，通过 Vivado Connector 调用 Vivado Tcl/API 完成仿真、综合、实现、码流生成等任务，并保留工具原始证据和可追溯运行记录。

用户可以不直接打开 Vivado，通过 Synthia 完成授权范围内的 FPGA 开发；也可以回到 Vivado 的传统操作方式。Synthia 不复制 Vivado 的 GUI 和工程业务逻辑，不得未经明确授权接管、修改、重跑或影响传统工业软件操作。未来 Synthia 前端支持独立 Web 运行，也支持作为 FPGA 工业软件内的小窗/WebView；两种形态共享同一后端 API、身份、权限和审计边界。

平台软件与目标 PLDS 项目属于两条独立配置空间：

- Synthia 平台软件按自身软件工程过程版本化、测试和发布；
- 每个目标 PLDS 项目按 G0～G9 流程管理其需求、设计、实现、验证、基线和交付；
- 平台升级不得静默改变已批准项目的流程、门禁和证据解释；
## 3. 当前唯一有效的总体架构方向

```text
Synthia UI（独立或嵌入）/ Workflow / Agent
→ Synthia Core
→ 厂商无关 Connector Port
→ MCP Adapter 或 HTTP/Queue Adapter
→ Connector Worker
→ Vivado Tcl/API 或板级/实验室设备
```

关键边界：

1. Synthia UI 是可替换交互层，可以独立运行或嵌入 FPGA 工业软件；嵌入宿主不因此获得数据库、Core 内部或 Connector 直连权限。
2. Workflow Engine 拥有 G0～G9 流程状态，Orchestrator 只拆分和路由任务。
3. Synthia Core 是项目、制品、快照、批准、基线、追踪和工程运行元数据的事实源。
4. Agent 使用冻结任务包生成候选；Agent 和 Skill 无批准、豁免、基线和发布权。
5. Connector Port 对 Core 隐藏厂商命令细节；Vivado Connector 可在受控授权下把强类型能力和 Skill 转换为 Vivado Tcl/API 操作。
6. MCP 只是 Connector 的可替换外部协议适配器，不是 Connector 内部唯一架构，也不承载工程事实。
7. Connector Worker 基于 Connector SDK 执行强类型操作并采集原始证据。
8. Vivado Connector 与 Board/Lab Connector 分离。
9. 传统 Vivado/工业软件仍可独立运行；Synthia 只有在用户或策略明确授权后才能读取、修改或执行关联工程任务。
10. 工业软件集成只提供上下文、页面和任务入口，不复制原生 GUI，不成为 Synthia 的唯一事实源。

## 4. 黄金流程和责任边界

G1～G9 阶段划分保持不变，G0 为准备活动。G4/B2 是多 Agent 内容生成的责任边界，不是目标 PLDS 生命周期终点。B2 后的 Vivado、硬件、确认和交付活动仍属于同一过程与证据链。

| 门 | 主要批准结果 | 关键里程碑基线 |
|---|---|---|
| G1 | 系统需求批准结果 | B0 系统需求基线 |
| G2 | PLDS SRS/派生需求批准结果 | 无新增 B 编号，冻结为批准阶段结果 |
| G3 | 结构/详细设计批准结果 | B1 设计输入基线 |
| G4 | RTL/TB/XDC/代码审查批准结果 | B2 RTL 基线 |
| G5 | 综合/网表结构批准结果 | 无新增 B 编号，冻结为批准阶段结果 |
| G6 | 实现/DRC/STA 批准结果 | 无新增 B 编号，冻结为批准阶段结果 |
| G7 | 确认测试批准结果 | B3 验证基线 |
| G8 | 码流/板测/配置审核批准结果 | 无新增 B 编号，冻结为批准阶段结果 |
| G9 | 验收交付批准结果 | B4 产品基线 |

不存在“候选基线”。候选成果先形成不可变 `ConfigurationSnapshot`，由 `GateSubmission` 引用；人类 `ApprovalRecord` 批准后形成 `ApprovedGateResult`，只有配置为关键里程碑的门才建立 B0～B4。

## 5. 运行分类和工具结论

`ToolRun.status` 与工程门结论严格分离。运行分类固定为：

- `exploratory`：可使用候选输入，结果不进入门禁、覆盖率、通过率或发布结论；
- `gate_check`：只对冻结的 GateSubmission 快照执行，用于当前门的准入检查；快照变化立即失效；
- `formal`：只使用批准输入，形成后续工程活动和正式验证证据。

G4 使用 `gate_check` 完成编译、Lint、必要的 RTL/预综合 CDC/RDC 和代码审查；G5 对批准 B2 执行正式综合并重新执行综合后 CDC 和结构检查。Connector 的 `succeeded` 只表示工具进程成功且必需输出存在，不等于工程门批准。

## 6. Agent 组织策略

平台定义 9 种专业角色 Profile：Orchestrator、Standards、Requirements、Architecture、Detailed Design、RTL、Verification、Assurance、Vivado Analysis。MVP 使用 6 个逻辑实例按需承载：编排、需求与标准、设计、RTL、验证、保证；Vivado Analysis 初期由设计/保证实例承担，评测证明有必要后再独立。

默认采用“1 个生成 Agent + 1 个保证/审查 Agent + 确定性工具 + 人类阶段门”。复杂度主要放在工作流、制品、批准、追踪、回退和证据，不放在自由聊天、深层递归委派、多数投票或共享可写工作区。只有可独立验证、真正可并行的阶段内任务才临时扩展 Agent 数量。

## 7. Connector 与 MCP 决策

- Synthia Core 只依赖厂商无关 Connector Port；
- Connector SDK 统一 Capability、Job、Worker、Artifact、Evidence、哈希、授权、锁、幂等、错误和恢复模型；
- MCP Adapter、HTTP Adapter、Queue Adapter 均为可替换传输适配器；
- MCP Adapter 不直接运行 Vivado，提交后返回 `job_id`；
- 大型 DCP、波形和码流只返回 `artifact_id`、URI、SHA-256、大小、媒体类型、输入快照和 ToolRun ID；
- 采用“通用运行外壳 + 厂商专用强类型操作”；
- 不直接开放 `execute_tcl(any_string)`，自定义 Tcl 采用 `propose_tcl → 策略检查 → 人工/策略授权 → execute_approved_tcl`；
- Vivado Connector 负责 Vivado/XSim/Hardware Manager；Board/Lab Connector 负责串口、外部激励、电源、仪器和板卡资源锁；外部人工证据通过独立受控导入契约登记。

## 8. 数据和证据原则

- 元数据数据库保存工程对象、状态、关系、批准和运行索引；
- Git/等效配置库存放文档、RTL、TB、XDC 和脚本修订；
- 内容寻址对象存储保存日志、报告、DCP、波形、覆盖数据库、码流等大对象；
- Worker 可先上传对象，但不能直接建立批准事实或业务元数据；
- Core 独立复算哈希并通过登记事务接纳证据；
- 未登记对象进入孤儿对账，已登记但对象缺失时标记损坏并触发失效；
- 批准、撤销、豁免和基线建立均使用 append-only 记录。

## 9. RT-UART 定位和评测

RT-UART 仅作为第一条黄金参考项目、模板来源、多 Agent 评测集、Connector 回归样例和模拟知识库。默认知识检索只使用批准且有效成果，草案、错误方案和故障样本进入隔离历史库或评测集。

多 Agent 复杂度必须通过 RT-UART 对照试验证明。至少比较：单强 Agent + 工具、6 个逻辑 Agent + 受控工作流、9 个独立角色 Agent；指标包括需求遗漏、注入缺陷发现、孤立追踪、RTL/TB 不一致、人工修改量、G4 首次通过率、重复性、Token、延迟和费用。

## 10. 当前状态与未决事项

截至冻结日只有工程文档草案和 RT-UART 参考资料。冻结后实现进展（截至 2026-08-11）：Core 领域模型与 D1 批准切片已实现并在真实 PostgreSQL 上验证（migration 0000～0002）；Connector 9 项 vivado-batch-1 能力已在真实远程 Worker（66 节点，Vivado 2021.1，目标 part xc7k70t）完成 validate_sources/simulate/synthesize/implement 端到端探索性验证；Agent Runtime 最小任务闭环开发中；Skill Pack 10 个候选已固化。仍没有正式 ToolRun 批准记录、RTL 基线或板测证据。以下事项仍需项目负责人或责任角色决定：

1. 2026-07-31、2026-08-15、2026-09-15 是否仍为有效承诺及各节点最小交付；
2. 实际 Vivado Worker、版本、许可证、目标 part、板卡和实验设备；
3. 人工基线采集责任人、方法、样本和截止日期；
4. 正式角色任命、数据分级和完整性等级；
5. 完整授权标准文本的取得和逐条复核；
6. 平台正式部署的运维组织和 Q-013/Q-017 责任人。 

## 11. 冻结后执行顺序

1. 评审本冻结包并关闭阻断性定义分歧；
2. 形成平台软件 SRS、架构和接口的批准版本；
3. 优先实现 Synthia Core 最小数据骨架和 Connector SDK；
4. 以能力发现、Manifest/哈希、仿真、综合、报告、异步 Job 和 Evidence Manifest 为首个 Connector 切片；
5. 再扩展实现、码流、硬件和后续工业软件嵌入形态。
