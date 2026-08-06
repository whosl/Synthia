# ARC-005 架构修正指令（Tech Lead blocker 裁定）

## ARC005-001 修正：Agent Runtime 不直连 Connector MCP

原文 §2.2/§3/§13 写的"Agent → omp MCP 客户端 → MCP Adapter → Connector Worker"绕过了 Core，违反 GOV-003 §3、ARC-001 §2/§5.2、ARC-003 §1、FLOW-006 §2 固定的控制链。

正确链路：

Agent Runtime → Core API 工具（AgentTool 包装 Core 的 Connector/Run 能力组）
              → Core 构造 JobRequest（含权限校验、输入状态校验、run_class 判定）
              → Connector Port → Adapter（MCP/HTTP/Queue）→ Connector Worker

Agent Runtime 不发现、不连接、不持有 MCP Server 连接。Connector 的 MCP Adapter 是 Port 与 Worker 之间的可替换传输，不是 Agent 与 Connector 之间的通道。

如果仍需复用 omp 的 MCP loader（仅用于降低实现成本），它必须由 Core 侧调用，不是 Agent Runtime 侧。Runtime 只看到 Core API 暴露的 Connector 操作（提交 Job、查询状态、获取证据描述符）。

## ARC005-002 修正：run_class 由 Core 判定，不由 Runtime 填入

原文 §13 要求 Runtime 填入 run_class，§6.1 又禁止 Agent 调 formal 端点——自相矛盾。

修正：
- Runtime 按 P3 提交"运行意图"（operation、目标输入引用、期望输出）；
- Core 根据输入状态（候选 / 冻结 GateSubmission / 批准 Baseline）、授权上下文和项目策略，判定并填入 run_class；
- Agent 可以提交 formal 运行意图，但 Core 只在输入确实为批准且有效的 Baseline/ApprovedGateResult 时才构造 formal JobRequest；
- 否则 Core 自动降级为 exploratory（候选输入）或拒绝（不满足 gate_check 绑定条件）。

## 通用原则

1. Core 是所有工程事实源和授权判定点；Agent Runtime 是执行层，不做工程判定。
2. §6 第 1 类"确定性工具"必须是纯本地、无厂商执行、无外部副作用（Schema/追踪/规则检查）。任何需要 EDA 工具链的编译/仿真/CDC 都是 Connector operation。
3. 底座（pi-agent-core）维护可变进程内状态（AgentState/消息/队列），不是"无状态"。appendOnlyContext 是可选配置。谱系必须由 Runtime 主动写入 Core，不依赖底座持久化。
4. setTools() 替换工具数组但不"冻结"——RBAC 在 beforeToolCall 和 Core 两层独立执行。
5. beforeModelCall 钩子通过 Agent.setBeforeModelCall(fn) 设置，回调返回 {stop: true, reason?: string} 终止请求。
