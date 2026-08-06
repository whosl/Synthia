# Synthia API 与事件边界契约

| 属性 | 内容 |
|---|---|
| 文档编号 | SYNTHIA-IF-001 |
| 版本/状态 | v0.2 / 讨论冻结候选，待正式评审（新增 §9 远程 Connector 端点契约） |
| 日期 | 2026-07-30 |
| 上游 | SYNTHIA-ARC-001～004 |

## 1. 目的

本文固定服务边界和交互语义，不锁定具体 Web 框架、消息中间件或 URL。实现前应基于本文生成 OpenAPI、事件 Schema 和契约测试。

## 2. 命令、查询和事件

- 命令表达有权限的状态改变请求，必须带身份、项目、预期版本和幂等键；
- 查询只返回调用者有权看到的配置视图，必须明确候选工作区或基线；
- 事件描述已经发生的事实，按聚合序号单调追加；
- Agent 建议不能伪装为命令结果，Connector 运行结果不能伪装为工程批准。

## 3. Core API 能力组

| 能力组 | 代表性操作 |
|---|---|
| Project/Process | 创建项目、实例化流程、分配角色、读取门状态 |
| Artifact/Revision | 创建候选修订、读取差异、冻结内容 |
| Trace | 创建候选关系、查询正反向链、运行不变量和影响分析 |
| Snapshot/Gate | 创建快照、提交门禁、运行检查、撤回提交 |
| Approval/Baseline | 人类批准/拒绝/撤销/豁免、查询有效决定和 B0～B4 |
| Issue/Risk/Task | 登记、分派、处置、关闭和门禁关联 |
| Connector/Run | 能力发现、提交 Job、取消、查询状态和证据 |
| Knowledge | 从批准来源提取、隔离分区、按适用条件检索 |

批准、撤销、豁免、码流生成授权和硬件写操作不得通过普通 Agent 服务身份调用。

## 4. Connector Port

通用操作至少包括：

```text
connector_discover
connector_get_capabilities
job_submit
job_get_status
job_cancel
job_get_evidence_manifest
artifact_get_metadata
```

远程兼容模式端点管理额外包括（语义见 §9）：

```text
connector_register_endpoint
connector_approve_endpoint
connector_revoke_endpoint
connector_heartbeat
```

Vivado 专用强类型操作至少包括：

```text
vivado_validate_sources
vivado_compile_simulation
vivado_run_simulation
vivado_synthesize
vivado_report_cdc
vivado_implement
vivado_report_drc
vivado_report_timing
vivado_report_utilization
vivado_report_power
vivado_generate_bitstream
vivado_program_device
vivado_capture_ila
vivado_manage_vio
```

MCP Adapter 可把强类型操作暴露为 MCP Tool，但 Tool 只提交和查询 Job，不在正文返回大型文件。

## 5. JobRequest 最小字段

```text
job_id / idempotency_key
project_id / process_instance_id / gate
operation / capability_version
run_class
input_snapshot_id / input_manifest_hash
toolchain_profile
parameters
expected_outputs
authorization_context
policy_profile
timeout / resource_limits
correlation_id
```

`gate_check` 的 authorization_context 必须包含 GateSubmission ID；`formal` 必须包含批准阶段结果或基线 ID；硬件写操作还必须包含目标硬件、资源锁和目的绑定授权。

## 6. 事件信封

所有领域和 Connector 事件至少包含：

```text
event_id
event_type
schema_version
aggregate_type / aggregate_id / sequence
project_id
occurred_at
actor_type / actor_id
correlation_id / causation_id
classification
payload_hash
payload
```

消费者按 `event_id` 幂等，按聚合序号检测丢失或乱序。不得依赖消息到达顺序推断跨聚合事务。

## 7. 错误模型

错误至少区分：`validation`、`authorization`、`conflict`、`capability_unavailable`、`resource_locked`、`tool_failure`、`output_incomplete`、`timeout`、`cancelled`、`worker_lost`、`unknown_effect`、`evidence_corrupt`。远程兼容模式额外区分：`compatibility_rejected`、`endpoint_not_approved`、`lease_expired`、`capability_drift`（§9.5）。错误响应必须带稳定错误码、可重试性、客观细节引用和关联 ID，不把自然语言模型解释作为唯一错误依据。

## 8. 兼容与版本

API、事件、Capability、Artifact 和 Evidence Schema 独立版本化。破坏性变更需要迁移计划和历史基线重现验证。Connector Worker 可多版本并存，Core 根据项目工具链配置选择兼容能力。远程端点协议另以 `connector.remote.v1` 版本化（§9.2），与 Core API 版本解耦。

## 9. 远程 Connector 端点契约

本节定义远程兼容模式（SYNTHIA-FLOW-006 §16、SYNTHIA-ARC-003 §10）的端点记录、信封和生命周期事件。它只适用于用户自有 Linux/Windows + licensed Vivado 主机上的远程 Worker，不改变 §4～§6 的通用语义。

### 9.1 ConnectorEndpoint / ConnectorRegistration 字段

版本化记录（当前 `protocol_version` 对应 `connector.remote.v1`）：

| 字段 | 内容 |
|---|---|
| `connector_id` | 全局端点 ID |
| `display_name` | 管理展示名 |
| `endpoint_url` | direct_https 服务地址 |
| `protocol_version` | 端点协议版本 |
| `transport_mode` | `direct_https`；`outbound_tunnel` 为 typed reserved，未实现 |
| `auth_mode` | 本轮仅支持 `mtls`；bootstrap token 为后续一次性短期引导预留，未实现，真实 PoC 前必须补齐或由部署侧完成等价受控引导 |
| `tls_trust_ref` / `tls_client_cert_ref` | 信任链/客户端证书的引用；只存引用，不存 secret 值 |
| `project_scope` | 允许的项目集合 |
| `data_classification_scope` | 允许的数据分类范围 |
| `allowed_capability_ids` | 允许的强类型能力及版本 |
| `toolchain_profile_hash` | 注册时工具链/能力画像哈希，漂移判定基准 |
| `worker_labels` | 调度标签（OS、区域、资源） |
| `heartbeat_interval_seconds` / `lease_seconds` | 心跳间隔与租约时长 |
| `max_concurrency` | 并发上限 |
| `registration_state` | 生命周期状态（§9.4） |
| `created_at` / `updated_at` / `audited_by` | 时间与批准审计身份 |

本轮不实现 bootstrap token；若未来启用，必须一次性使用、短期过期、可轮换/撤销，不进入本记录和普通日志。

### 9.2 远程请求/响应信封

direct_https 上的所有请求和响应使用版本化 JSON envelope，`schema_version=connector.remote.v1`：

```text
schema_version
correlation_id
causation_id
idempotency_key
actor
project_id
classification
capability_version
payload
```

与 §6 事件信封的关系：`correlation_id`/`causation_id` 串联远程调用与领域事件；`classification` 不得超出端点 `data_classification_scope`；`idempotency_key` + 单调序号 + 时间窗构成重放防护。大型二进制对象不进入 envelope，仍以 Artifact/Evidence 描述符引用（SYNTHIA-ARC-003 §7）。

### 9.3 传输模式

`direct_https` 为唯一已实现模式；`outbound_tunnel` 仅作为 typed reserved 枚举保留，任何端点不得以该值进入 `approved`/`ready`。

### 9.4 生命周期与心跳

`registering → approved → ready → degraded → offline → revoked`（状态图见 SYNTHIA-FLOW-006 §16.4）。心跳请求按 `heartbeat_interval_seconds` 发出并携带 capability map 摘要；`lease_seconds` 过期转入 `offline`；`revoked` 为终态并 fail-closed。生命周期迁移产生带 §6 信封的审计事件。

### 9.5 漂移与兼容拒绝

心跳摘要与 `toolchain_profile_hash` 不一致产生 `capability_drift`；协议或 capability 版本不兼容返回 `compatibility_rejected`；非 `ready` 端点上的 formal/gate_check 提交返回 `endpoint_not_approved` 或 `lease_expired`。以上均阻断 formal 并进入审计（SYNTHIA-FLOW-006 §16.5）。
