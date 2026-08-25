# Synthia 精简正式流程、证据与交付契约（v1）

- 编号：PB-004
- 状态：P4 v1；已冻结
- 日期：2026-08-24
- 上位依据：[产品基线 v1](./product-baseline-v1.md)、[实施计划 v1](./implementation-plan-v1.md)、[任务工作区与正式采纳契约 v1](./task-workspaces-contract-v1.md)
- 建议迁移：`0010_process_gate_checks.sql`、`0011_delivery_release.sql`

## 1. 目的、范围与非目标

本文冻结 P4 的第一条完整工程闭环：工程项目按版本化 `process-profile.v1` 推进 G0～G4；Core 对每个门执行可复现检查；用户确认正式输入后，正式运行只消费同一份不可变输入；Core 冻结证据并区分试验/正式码流；G4 批准时原子建立 B2 与正式交付版本；正式完成后的任何修改都进入变更请求和新的工作版本。

本文覆盖：

- `GJB_REF_V1` 的 G0→G4 节点、顺序、里程碑与检查定义；
- G0 项目准备和工程配置快照；
- Core-owned gate evaluation；
- 正式输入预览、人工确认和 `input_hash`；
- 正式运行与快照、active 前提基线、工具链、器件和约束完整度的绑定；
- write-once 证据 manifest、试验/正式码流；
- G4 的 sealed delivery projection、正式 release 与可验证 manifest；
- 变更请求、工作版本、重新验证和基线换代；
- 功能开关、兼容、幂等、回滚和验收。

本文不实现完整备份/恢复，不承担 Connector 注册、租约、进程取消或跨重启幂等的组织级硬化，也不包含真实上板、下载或烧写。它们不能被 P4 的成功状态暗示为已经具备。P4 不新增 G5～G9，也不把旧 G0～G9 兼容流程当作首版完成线。

## 2. 权威边界与总不变量

1. Core 是流程 profile、G0 准备、工作版本、门检查、正式输入确认、ToolRun 绑定、冻结证据、码流分类、基线和交付版本的唯一事实源。Runtime 只能编排；Web 只能展示和发起明确的人类动作；Connector 只能执行 Core 已裁决的 Job。
2. `run_class=formal` 的唯一入口是有效的 `formal_input_approval`。请求方不能通过自报 `sources`、`constraints`、`part`、`inputApproved`、baseline ID 或任意历史批准 ID 获得 formal。
3. 正式输入等于 Core 物化的不可变输入 bundle。正式 Job 不从可变项目工作树重新读取文件，也不接受调用方覆盖 bundle 中任一字节。
4. 正式输入必须同时绑定：配置快照、该工作版本当前 active 的前提基线、G0 readiness、工程配置 hash、工具链 profile hash、目标器件、完整约束、允许的 operation 和人工确认身份。
5. `succeeded` ToolRun 只说明工具进程成功，不等于某项门检查通过，不自动建立基线、正式码流或 release。
6. evidence manifest 首次冻结后不可覆盖。Connector 后续返回不同内容时必须 fail-closed 并记录审计，不得“以最后一次 GET 为准”。
7. 非 formal 运行产生的码流一律为 `trial`。即使约束完整、DRC/时序通过，也不能升级为 `formal`；正式码流必须重新执行 formal implement。
8. formal 运行在约束不完整、前提基线失活、工具链漂移或 input hash 不一致时不得开始；不能通过降级成 trial 来伪装同一请求成功。
9. G4 进入 `in_review` 前必须已有通过的 Core evaluation 和 sealed delivery projection。G4 批准、ApprovedGateResult、B2 换代、delivery release、工作版本完成和 outbox 必须在一个数据库事务中提交。
10. 生成身份与确认身份分别保存。Core/Runtime/Connector/模型可以生成候选、运行和 manifest；只有认证 human 可以确认正式输入、批准门和开启变更请求。本人兼任两种职责时仍保留两条身份事实。
11. release、release item、冻结 evidence、bitstream classification、approval 和 ApprovedGateResult 均不可修改或删除。纠错通过新事实和新版本完成。
12. 所有项目关系都按 `(resource_id, project_id)` 校验。跨项目引用统一 fail-closed；读取不泄露其他项目资源是否存在。

## 3. `process-profile.v1`

### 3.1 Profile 响应

`GET /api/v1/process-versions/:processVersionId/profile` 返回可供 Runtime 与 Web 直接消费的同一结构：

```json
{
  "schema": "process-profile.v1",
  "id": "GJB_REF_V1",
  "version": "GJB_REF_V1",
  "name": "GJB 参考流程 v1",
  "nodes": [
    {
      "id": "G0",
      "kind": "gate",
      "ordinal": 0,
      "name": "项目准备",
      "goal": "记录项目边界、器件与工具准备状态",
      "activities": ["prepare_project"],
      "requiredChecks": [
        { "code": "project.engineering", "severity": "hard" },
        { "code": "process.bound", "severity": "hard" },
        { "code": "data_scope.recorded", "severity": "hard" },
        { "code": "target_part.recorded", "severity": "hard" },
        { "code": "board_status.recorded", "severity": "hard" },
        { "code": "source_materials.recorded", "severity": "hard" },
        { "code": "workspace.ready", "severity": "hard" },
        { "code": "toolchain.bound", "severity": "hard" }
      ],
      "milestoneBaseline": null
    },
    {
      "id": "G1",
      "kind": "gate",
      "ordinal": 1,
      "name": "需求确认",
      "goal": "确认需求来源、接口、验收目标与关键风险",
      "activities": ["intake"],
      "requiredChecks": [
        { "code": "artifact.development_requirements", "severity": "hard" },
        { "code": "snapshot.members_frozen", "severity": "hard" }
      ],
      "milestoneBaseline": "B0"
    },
    {
      "id": "G2",
      "kind": "gate",
      "ordinal": 2,
      "name": "行为与验证方案",
      "goal": "确认功能、时序、异常行为及需求对应的验证方法",
      "activities": ["behavior_wave", "verification_plan"],
      "requiredChecks": [
        { "code": "artifact.behavior_spec", "severity": "hard" },
        { "code": "artifact.verification_method_map", "severity": "hard" },
        { "code": "snapshot.members_frozen", "severity": "hard" }
      ],
      "milestoneBaseline": null
    },
    {
      "id": "G3",
      "kind": "gate",
      "ordinal": 3,
      "name": "设计确认",
      "goal": "确认架构、接口、寄存器、时钟复位、约束策略与关键边界",
      "activities": ["architecture", "register_spec", "constraint_strategy"],
      "requiredChecks": [
        { "code": "artifact.architecture_design", "severity": "hard" },
        { "code": "artifact.detailed_design", "severity": "hard" },
        { "code": "artifact.constraint_design", "severity": "hard" },
        { "code": "snapshot.members_frozen", "severity": "hard" }
      ],
      "milestoneBaseline": "B1"
    },
    {
      "id": "G4",
      "kind": "gate",
      "ordinal": 4,
      "name": "实现与交付",
      "goal": "由同一不可变输入生成、验证并交付可追溯的正式结果",
      "activities": ["rtl_build", "validate", "tb", "simulate", "xdc", "implement", "delivery"],
      "requiredChecks": [
        { "code": "artifact.rtl", "severity": "hard" },
        { "code": "artifact.testbench", "severity": "hard" },
        { "code": "artifact.constraints", "severity": "hard" },
        { "code": "formal_input.confirmed", "severity": "hard" },
        { "code": "constraints.complete", "severity": "hard" },
        { "code": "formal_simulation.succeeded", "severity": "hard" },
        { "code": "formal_implementation.succeeded", "severity": "hard" },
        { "code": "drc.clean", "severity": "hard" },
        { "code": "timing.met", "severity": "hard" },
        { "code": "evidence.frozen", "severity": "hard" },
        { "code": "bitstream.formal", "severity": "hard" },
        { "code": "delivery.manifest_sealed", "severity": "hard" }
      ],
      "milestoneBaseline": "B2"
    }
  ],
  "profileHash": "0f503a9bf66e0226f2242cfeb6d42b51d2172afc8dc2584f230e0e03f33f3c5e"
}
```

`nodes` 按 `ordinal` 升序，ID 不重复，首尾固定为 G0/G4。`profileHash` 等于对不含 `profileHash` 自身的 profile body 进行 `canonical-json.v1` 编码后的 SHA-256。Web 不再拼 15 节点；Runtime 不再持有另一份阶段链。节点文案、顺序、活动、里程碑和检查列表都以该响应为准；前置 gate 由 `ordinal` 推导，不能作为第二套 profile 字段维护。

### 3.2 `process_gate_definition`

`process_gate_definition` 是上述 `nodes` 的数据库事实源，至少包含：

| 字段 | 规则 |
|---|---|
| `process_version_id` / `gate` | 联合主键；引用不可变 `process_version`。 |
| `ordinal` | 同一版本唯一、从 0 连续递增。 |
| `name` / `goal` | 用户可见中文，不由 Web/Runtime 重写。 |
| `activities` | 非空 JSON 数组；由 profile 驱动 Runtime/Web 的阶段活动。 |
| `required_checks` | 非空 JSON 数组；每项含稳定 `code` 和 `severity=hard|advisory`。 |
| `milestone_baseline` | G1→B0、G3→B1、G4→B2；G0/G2 为空。 |
| `profile_hash` | 同一 profile 的所有 seed 行保存相同 `profileHash`，并与 API 响应一致。 |

GJB_REF_V1 的这些行创建后不可修改或删除。流程变化必须注册新的 process version，不能静默改写既有项目含义。数据库可继续保留 `gate_id` 的 G5～G9 值供 `LEGACY_COMPAT` 读取，但 GJB_REF_V1 的创建、submission、evaluation 和 approval API 必须拒绝 profile 中不存在的 gate。

### 3.3 推进语义

- G0 完成依据是当前工作版本存在 `state=ready` 的 `project_readiness`，不创建 GateSubmission 或 baseline。
- G1/G2/G3/G4 只能按当前工作版本的 `start_gate` 起顺序推进，不能跳过尚未完成的节点。
- G1 和 G3 批准后分别产生或换代 B0、B1；G2 只产生 ApprovedGateResult；G4 批准产生或换代 B2 并建立 release。
- `process_instance.current_gate` 降为可重建 projection：它表示 active work version 的首个未完成节点；G4 release 后仍为 G4，同时 `project_work_version.state=released`。API 另返回 `completed=true`，不得靠虚构 G5 表示完成。
- 同一 `(process_instance, work_version, gate)` 同时最多一个 `preparing|submitted|checking|in_review` submission。

## 4. G0 readiness 与工程配置

### 4.1 `project_readiness`

`project_readiness` 保存一次不可变的 G0 评估，至少包含：

| 字段 | 规则 |
|---|---|
| `id` / `project_id` / `process_instance_id` | 使用复合外键绑定同一工程项目。自由项目不得创建。 |
| `process_version_id` / `profile_definition_hash` | 必须等于项目冻结的 GJB_REF_V1。 |
| `work_version_id` | readiness 所服务的工作版本。 |
| `sequence` / `supersedes_readiness_id` | 项目内单调版本；新记录引用上一记录，旧记录不修改。 |
| `engineering_config` / `engineering_config_hash` | `engineering-config.v1` 规范 JSON 及其 hash。 |
| `source_snapshot_ids` | 已记录的来源资料快照，可为空数组但字段必须存在。 |
| `workspace_commit` / `workspace_manifest_hash` | 创建 readiness 时 Core 看到的项目工作区事实。 |
| `check_results` / `result_hash` | G0 五项检查及规范化结果 hash。 |
| `state` | `ready` 或 `blocked`，创建后不可改。 |
| `generated_by_type/id` | 生成准备清单的身份。 |
| `confirmed_by` / `confirmed_at` | 只有 human 可填写；`ready` 必须非空。 |

`engineering-config.v1` 固定结构：

```json
{
  "schema": "engineering-config.v1",
  "targetPart": { "value": "xc7k70tfbv676-1", "state": "identified" },
  "board": { "ref": "board-kc705-v1", "state": "identified" },
  "constraints": {
    "pin": { "state": "complete", "revisionIds": ["rev_xdc"] },
    "electrical": { "state": "complete", "revisionIds": ["rev_xdc"] },
    "clock": { "state": "complete", "revisionIds": ["rev_xdc"] }
  },
  "dataScope": { "classification": "D1", "description": "项目源文件与已确认资料" },
  "sourcePolicy": { "confirmedOnly": true }
}
```

`state` 只接受 `identified|missing`（器件/板卡）或 `complete|partial|missing`（三类约束）。每个 revision 必须属于同项目，类型适用于约束，内容 hash 与 revision 一致。Core 从三个约束状态和 revision 内容派生 `constraints_complete`；请求方不能提交或覆盖该布尔结果。

G0 的“准备完成”只要求器件、板卡和三类约束的当前状态被诚实记录，不要求它们已经 complete。因此 G0 可在约束仍缺失时完成；但正式输入确认和正式码流要求 target part、board、pin/electrical/clock 全部 identified/complete。缺失时仍可执行 exploratory implement 并得到 trial bitstream。

### 4.2 G0 检查

| code | hard 条件 |
|---|---|
| `G0_PROFILE_BOUND` | 工程项目、process instance、工作版本都绑定同一 active GJB_REF_V1 定义。 |
| `G0_SCOPE_RECORDED` | 数据分类和 dataScope 非空，未把密钥/证书/缓存声明为正式输入。 |
| `G0_ENGINEERING_CONFIG_RECORDED` | 工程配置字段齐全、枚举合法、引用均属本项目；允许状态为 missing。 |
| `G0_SOURCES_RECORDED` | 来源策略和当前来源快照集合已记录；未确认资料不会默认进入输入。 |
| `G0_WORKSPACE_READY` | Core 可读取受控工作区 commit/manifest，且没有未登记修改。 |

任一 hard check 失败产生 `blocked` readiness。只有认证 human 在看到准备清单后才能产生 `ready` 记录。

## 5. 工作版本、变更请求与基线换代

### 5.1 `project_work_version`

每个工程项目只有一个 active 工作版本，至少包含：

- `id`、`project_id`、单调 `version`；
- `origin=initial|change_request`；
- `change_request_id`（initial 为空，后续版本必填）；
- `base_delivery_release_id`（首版为空，后续版本绑定创建时的 current release）；
- `start_gate`、`current_gate`；
- `state=working|in_review|released|abandoned`；
- `created_by_type/id`、`created_at`、`released_at`；
- 状态和 `current_gate` 只允许由 Core 服务按 profile 前向推进，且每次写 outbox。

P4 首次启用时，为尚无正式 release 的 GJB_REF_V1 工程项目创建一个 initial work version；迁移不得自动把 G0 标成 ready，也不得自动批准任何门。已有 release 后，不允许再创建第二个 initial version。

### 5.2 `change_request`

已有 release 后，创建 revision、主工作区写入、P3 adoption、snapshot 或 formal input 都必须绑定 active `project_work_version`。若当前没有 active work version，写请求返回 `409 CHANGE_REQUEST_REQUIRED`。

change request 至少包含：

- `id`、`project_id`、`base_delivery_release_id`；
- 非空 `reason`、`affected_paths` 和 `impact_gate`；
- `state=open|released|withdrawn`；
- `proposed_by_type/id` 与 human `confirmed_by/confirmed_at`；
- 关联且唯一的 `project_work_version_id`。

`impact_gate` 是受影响最早节点，只能为 G1～G4。新 work version 必须从该节点重新 evaluation/approval，一直推进到新的 G4 release；不能只重打包旧正式码流。若影响范围扩大，旧 change request/work version 必须 abandoned/withdrawn，再以更早 impact gate 创建新记录，不能原地降低检查范围。

### 5.3 baseline supersession

`baseline` 新增新行方向的 `supersedes_baseline_id`。同 kind 换代必须在一个事务中：

1. 锁住该项目/类型当前唯一 active baseline，并确认它与 active work version 的前提一致；
2. 将旧行唯一允许的生命周期字段从 `active/null` 改为 `superseded/<new-id>`；
3. 插入 `state=active` 且 `supersedes_baseline_id=<old-id>` 的新 baseline；
4. 写 approval、ApprovedGateResult 和 outbox；任一步失败全部回滚。

`superseded_by_baseline_id` 外键必须可延迟到事务提交；`supersedes_baseline_id` 非空值唯一，防止一个旧 baseline 分叉出两个正式后继。baseline 的成员、manifest、approval 和创建身份仍严格不可变；append-only trigger 只豁免上述一次 `active→superseded` 生命周期转换，继续拒绝 DELETE、复活和其他 UPDATE。

active baseline 的判断只认 Core 当前事务确认的 `state=active` 行。引用 superseded/invalidated/retired baseline 的 formal approval、evaluation 或重放都必须重新鉴权并拒绝。

## 6. Core gate evaluation

### 6.1 数据模型

`gate_check_evaluation` 至少包含：

- `id`、`project_id`、`process_instance_id`、`work_version_id`、`gate_submission_id`；
- `gate`、`profile_definition_hash`、`check_set_hash`；
- `snapshot_id`、`snapshot_manifest_hash`、`input_fact_hash`；
- `state=passed|failed`、`result_hash`；
- G4 专用的 `sealed_projection` 和 `sealed_projection_hash`，其他门为空；
- `evaluator_version`、`generated_by_type/id`、`created_at`。

`gate_check_item` 是 evaluation 的不可变明细，至少包含 `check_code`、`check_version`、`severity=hard|advisory`、`status=passed|failed|not_applicable`、`fact_hash`、`details` 和 `evidence_refs`。每个 profile check 恰有一项，不能少项或重复。

evaluation、item 和 G4 sealed projection 一经写入不可修改或删除。`result_hash` 对不含时间戳的规范化 evaluation 计算；`sealed_projection_hash` 对 `delivery-candidate.v1` 计算。

### 6.2 生命周期

1. 创建 GateSubmission 时，Core 验证 gate 是当前 work version 的下一个节点，并把 submission 固定为 `preparing`。
2. `POST .../gate-submissions/:id/evaluations` 驱动 `preparing→submitted→checking` 并运行 Core evaluator。
3. 任一 hard item 失败时，写入完整 evaluation 后把 submission 置为 `rejected`；修复后必须创建新 snapshot 和新 submission，不能修改旧 evaluation。
4. 全部 hard item 通过时，submission 保持 `checking`。G4 同时生成并密封 `delivery-candidate.v1` projection。
5. `POST .../gate-submissions/:id/submit` 只在存在与当前 snapshot/profile/work version 完全匹配的 passed evaluation 时执行 `checking→in_review`。G4 缺 sealed projection 时拒绝。
6. approval 只接受 `in_review`，并重新验证 evaluation、前提 baseline、formal input、evidence、bitstream 和 work version 仍有效；不得仅比较调用方给出的 hash。

hard item 不可 waiver。现有 approval payload 中的 risks/waivers 只保留说明，不能把 failed hard item 转成 passed。`check_results_hash` 由 Core 从 evaluation.result_hash 填充；客户端提供不同值返回 409，省略时由服务端填入。

### 6.3 G1～G4 最低检查

| 阶段 | Core 必须证明的 hard 事实 |
|---|---|
| G1 | snapshot 含需求/来源材料；接口与验收目标可检查；关键风险均有处置；成员和 trace 均属本项目。 |
| G2 | 行为、性能、时序和异常情况已定义；验证方法覆盖需求；无关键未映射需求。 |
| G3 | 架构、接口/寄存器、时钟/复位/CDC、约束策略和设计 trace 齐全；B0 仍 active。 |
| G4 | artifact set、正式输入、validate/simulate/synthesize/implement、DRC、时序、原始证据、正式码流和 delivery projection 全部满足本契约；B1 仍 active。 |

G1～G3 的上述语义事实使用 snapshot 成员中的唯一 `p4-gate-evidence.v1` JSON 文档编码。Core 必须从 artifact revision 的受管字节读取文档，校验字节 SHA-256 与 snapshot manifest；不得用 artifact 类型、标题、路径、Markdown 标题或关键词命中代替字段校验。文档最大 256 KiB，每个数组最多 128 项，所有对象采用下列精确字段（未知/缺失字段拒绝），所有 `id` 和 ID 数组不得重复，`gate` 必须与当前 G1/G2/G3 精确相等：

- G1：`schema/gate/requirements/risks/traceRelationIds`。每项 requirement 固定含 `id/critical/source/interface/acceptance`；`source` 固定含冻结 source revision 的 `revisionId/locator`，且不得自指 evidence revision；`interface` 固定含 `name/direction/contract`，direction 只能是 `input|output|bidirectional`；`acceptance` 固定含 `criterion/method`。每项 risk 固定含 `id/critical/description/disposition`，disposition 固定含非空 `rationale/status`，status 只能是 `accepted|avoided|mitigated|transferred`。
- G2：`schema/gate/requirementIds/criticalRequirementIds/behavior/verificationMappings/traceRelationIds`。`behavior` 精确含四个非空字符串数组 `functional/performance/timing/exceptions`；每项 verification mapping 固定含 `id/requirementId/method/procedure/expected`，method 只能是 `analysis|inspection|simulation|test`。Core 从当前 active B0 的冻结 member revision 字节重新解析 G1 权威需求集合，要求 G2 的需求/关键需求集合精确一致，并要求所有关键需求至少有一个映射；不得读取当前工作树或信任 G2 自报的需求全集。
- G3：`schema/gate/architecture/interfaces/registers/clocks/resets/cdc/constraintStrategy/designTrace/traceRelationIds`。architecture 精确含 `summary/components`，component 含 `id/responsibility`；interface 含 `id/name/contract`；register 含 `id/name/address/description`；clock 含 `id/name/frequencyHz/domain`；reset 含 `id/name/kind/polarity/domain`，kind 只能是 `synchronous|asynchronous`，polarity 只能是 `active_high|active_low`。CDC 只能是精确的 `{status:"addressed",crossings:[...]}`（crossing 含 `id/sourceClockId/targetClockId/strategy`），或 `{status:"not_applicable",rationale:"..."}`；constraintStrategy 精确含 `pin/electrical/timing`；每项 design trace 固定含 `id/requirementId/designElementId/relationId`。Core 同样从 active B0 冻结字节取得权威需求，关键需求必须全部有 design trace，design element 和 relation 都必须引用本文件/本 snapshot 的已冻结事实。

G1～G3 snapshot 的 `trace_relation_ids` 不得为空，必须与 JSON 的 `traceRelationIds` 集合精确一致。每条 relation 必须是 `approved`、basis 非空、relation 行及 source/target artifact revision 均属于同一项目。成员缺失、字节/hash/manifest 不符、空或歧义 evidence 文档、错误 schema/gate、重复 ID、未处置风险、未映射关键需求、缺 active B0、空 trace、跨项目/未批准/端点缺失 trace 均使对应现有 profile hard check 失败；不得新增旁路 check code 或把失败转换为 waiver。

G4 的四项 operation 必须是 `validate_sources`、`simulate`、`synthesize`、`implement` 的 succeeded formal ToolRun，且全部绑定同一个 `formal_input_approval_id` 和 `input_hash`。implement 内的重复 synthesis 不能替代独立 synthesis 事实。DRC 必须 `errorCount=0`；timing 必须 `met=true` 且所有要求时钟已覆盖。只看退出码、日志中出现 `PASS` 或存在 `.bit` 文件均不足以通过。

## 7. 正式输入确认与正式 Job

### 7.1 `formal_input_approval`

`formal_input_approval` 是不可变的人类确认记录，至少包含：

| 字段 | 规则 |
|---|---|
| `id` / `project_id` / `work_version_id` | 属于 active 工程工作版本。 |
| `purpose` / `target_gate` | v1 固定 `g4_delivery` / G4。 |
| `snapshot_id` / `snapshot_manifest_hash` | 配置快照不可变且属于该项目/工作版本。 |
| `readiness_id` / `engineering_config_hash` | readiness 必须 ready；器件/板卡/三类约束完整。 |
| `prerequisite_baseline_id` / `baseline_manifest_hash` | 必须是当前 active B1。 |
| `toolchain_profile_hash` / `connector_id` | 取自 Core discovery 与项目配置，不接受调用方任意字符串。 |
| `target_part` / `constraint_manifest_hash` | 与 engineering config、snapshot 和输入文件一致。 |
| `allowed_operations` | v1 固定为四项 formal G4 operation 的去重排序数组。 |
| `authorized_task_id` / `runtime_actor_id` | 绑定唯一活动工程 main task；允许同一 human 直接提交。side task 不可绑定。 |
| `input_manifest` / `input_hash` | `formal-input.v1` 及其 SHA-256。 |
| `preview_hash` | 用户所见文件/用途预览的 hash；确认时 Core 必须重算一致。 |
| `generated_by_type/id` | 组装 manifest 的 Core/Runtime 身份。 |
| `confirmed_by` / `confirmed_at` | 认证 human，不能从请求 body 伪造。 |

### 7.2 `formal-input.v1` 与 hash

Core 从 snapshot 成员、已登记 workspace path、artifact revision 和工程配置组装：

```json
{
  "schema": "formal-input.v1",
  "projectId": "proj-1",
  "processVersionId": "GJB_REF_V1",
  "workVersionId": "wv-1",
  "targetGate": "G4",
  "purpose": "g4_delivery",
  "configurationSnapshot": { "id": "snap-4", "manifestHash": "..." },
  "prerequisiteBaseline": { "id": "bl-b1", "kind": "B1", "manifestHash": "..." },
  "readiness": { "id": "ready-1", "engineeringConfigHash": "..." },
  "targetPart": "xc7k70tfbv676-1",
  "toolchain": { "connectorId": "worker-66", "profileHash": "..." },
  "allowedOperations": ["implement", "simulate", "synthesize", "validate_sources"],
  "files": [
    { "path": "prj/constr/top.xdc", "role": "constraint", "revisionId": "rev-xdc", "sha256": "...", "sizeBytes": 1200, "storageUri": "content://sha256/..." },
    { "path": "rtl/top.sv", "role": "rtl", "revisionId": "rev-rtl", "sha256": "...", "sizeBytes": 4200, "storageUri": "content://sha256/..." },
    { "path": "tb/top_tb.sv", "role": "tb", "revisionId": "rev-tb", "sha256": "...", "sizeBytes": 5100, "storageUri": "content://sha256/..." }
  ]
}
```

路径按 UTF-8 字节升序，必须安全、唯一；每个 revision 恰好解析为一个 path，内容 hash 与归档字节一致。Core 在确认前把所有输入物化到按 hash 寻址的不可变受管存储；缺内容、hash 不符、当前 workspace 未登记修改、symlink/submodule、秘密/证书或 snapshot 成员重复都使确认失败。

规范 JSON 使用 `canonical-json.v1`：对象 key 递归按 ECMAScript 字符串升序；数组保持语义顺序，集合型数组在构造前按本契约指定 key 排序；UTF-8、无额外空白；禁止 `undefined`、NaN 和 Infinity。所有 hash 为 SHA-256 的 64 位小写十六进制。`input_hash = SHA256(canonical-json(formal-input.v1))`。时间戳、数据库自增号和临时文件路径不得进入 input hash。

### 7.3 预览与确认

`POST /api/v1/projects/:projectId/formal-input-approvals/preview` 接受 `work_version_id`、`snapshot_id`、`readiness_id` 和 `authorized_task_id`，返回完整文件列表、用途、前提 baseline、工具链、约束结论、`input_hash` 与 `preview_hash`，但不产生 approval。

用户看到该响应后调用 `POST /api/v1/projects/:projectId/formal-input-approvals`：

```json
{
  "id": "fia-1",
  "work_version_id": "wv-1",
  "snapshot_id": "snap-4",
  "readiness_id": "ready-1",
  "authorized_task_id": "task-main-1",
  "purpose": "g4_delivery",
  "preview_hash": "<64-hex>"
}
```

确认接口仅限有项目角色的 human。Core 在同一事务中重新组装 preview；任何事实变化返回 409 并要求重新预览。approval 创建后不变；它是否仍可使用由每次 Job submit 时动态检查 active baseline、work version、toolchain 和 feature flag 决定。

### 7.4 ToolRun 强绑定

`tool_run` 增加或冻结以下字段：`binding_version`、`formal_input_approval_id`、`input_snapshot_id`、`input_manifest_hash`、`toolchain_profile_hash`、`submitted_by_type/id`。新 P4 formal 行必须满足：

- `binding_version='formal-input.v1'`；
- 六项绑定字段均非空并与 approval 一致；
- operation 在 approval.allowed_operations 内；
- `parameters` 中的 sources/constraints/part 由 Core 从 input bundle 派生；
- Connector 外层 `input` 等于真实 `input_hash`，不得使用 `manifest:<jobId>`；
- Connector 内外 `jobId/projectId/operation/runClass/inputHash/part/toolchainHash` 逐项一致；
- 提交者是 approval.confirmed_by human，或 approval 绑定 main task 的 runtime actor；
- side task、其他 service、superseded baseline、非 active work version均拒绝。

正式 Job 请求不再接受 sources 等可变输入：

```json
{
  "operation": "implement",
  "run_class_intent": "formal",
  "formal_input_approval_id": "fia-1"
}
```

客户端同时发送 `sources`、`constraints`、`part`、`baseline_id`、`approved_gate_result_id` 或自报 `input_manifest_hash` 时返回 400，不能悄悄忽略。exploratory 请求保持现有参数形态。

## 8. 冻结证据

### 8.1 数据模型

`tool_run_evidence_manifest` 与 ToolRun 一对一，至少包含 `tool_run_id/project_id`、`schema_version=evidence-manifest.v1`、`run_state`、`operation`、`run_class`、`input_hash`、`toolchain_profile_hash`、`parser_version`、规范化 `verdicts`、`manifest_hash`、`frozen_at`。它创建后不可 UPDATE/DELETE。

`tool_run_evidence_entry` 至少包含：

- `(tool_run_id, name)` 唯一，name 是安全相对名；
- `role`、`sha256`、`size_bytes`、`media_type`；
- Core 受管的 `storage_uri`，不能把 Connector 临时 workspace URI当作正式长期地址；
- `completeness=full|partial`、`corrupt`；
- 可选规范化 `verdict` 和 `source_entry_names`；
- 与 manifest 同事务创建并 append-only。

现有 `tool_run.evidence` JSON 和 `evidence` 表只作为 legacy 读取兼容；P4 evaluation 只认上述 v1 manifest/entry。

### 8.2 冻结协议

`POST /api/v1/projects/:projectId/jobs/:jobId/evidence/freeze` 必须带幂等键：

1. 确认 ToolRun 属于项目并已终态；formal G4 证据要求 `succeeded`。
2. 从 Connector 读取 manifest，验证回传 job/project/input hash 与 Core 行一致。
3. 校验 entry name 唯一安全，逐项复制完整字节到 Core 受管内容存储并重算 sha256/size；formal entry 不接受 truncated/partial。
4. 使用版本化 Core parser 从受管原始证据生成结构化 verdict。客户端或 Runtime 自报 PASS 不被采用。
5. 在一个事务中写 manifest、entries、审计和 outbox；事务提交后才返回 frozen。
6. 同键同体重放返回同一 manifest。已有 manifest 时不再次覆盖；若 Connector 或请求声称不同 hash，返回 `409 EVIDENCE_MANIFEST_DIVERGED` 并保留原事实。

`GET .../jobs/:jobId/evidence` 和 `/content?name=` 在 P4 路径只读 Core 冻结内容。未冻结返回稳定 `409 EVIDENCE_NOT_FROZEN`；content 必须先证明 name 属于该 manifest，并在返回前复核内容 hash。诊断性失败/取消 evidence 可以冻结，但永远不能满足 G4 formal check。

### 8.3 G4 evidence role

每个 formal operation 至少包含 `input_manifest`、`run_script`、`stdout_log`、`stderr_log` 和 `tool_log`。此外：

- validate_sources：`validation_result`；
- simulate：`simulation_result`，规范 verdict 必须 `passed=true`；
- synthesize：`synthesis_result` 与 `utilization_report`；
- implement：`implementation_result`、`drc_report`、`timing_report`、`utilization_report`、`synth_checkpoint`、`routed_checkpoint` 和 `bitstream`。

DRC verdict 至少含 `errorCount`；timing verdict 至少含 `met`、`worstSlack` 和 covered clocks。缺原始报告、parser 无法确定、hash 不符或 verdict `unknown` 均按 hard fail，而不是 advisory。

## 9. 试验与正式码流

`bitstream_result` 是 immutable classification，至少包含：

- `id/project_id/tool_run_id/evidence_manifest_hash/evidence_entry_name`；
- `class=trial|formal`；
- `formal_input_approval_id`、`snapshot_id`、`input_hash`；
- `readiness_id/engineering_config_hash/prerequisite_baseline_id`；
- `target_part/toolchain_profile_hash/constraint_manifest_hash`；
- `sha256/size_bytes/storage_uri`；
- `generated_by_type/id/generated_at`。

Core 在冻结含 bitstream entry 的 evidence 后自动派生记录：

- 只有 `run_class=formal`、binding v1 完整、run succeeded、operation=implement、三类约束 complete、active B1、DRC errorCount=0、timing met=true，才可创建 `class=formal`；
- 其他可识别 bitstream 只能创建 `class=trial`；failed/corrupt/partial evidence 不创建可用 bitstream；
- trial 行所有可用来源仍保留，但 `formal_input_approval_id` 可为空；
- `class` 不可更新，trial ID/bytes/hash 不得出现在 delivery release；
- 同一 evidence entry 最多产生一个 bitstream_result。

Web、API 文件名和下载响应必须显式带 `trial` 或 `formal`，不能只用“码流已生成”。

## 10. G4 sealed projection 与正式交付

### 10.1 无独立 candidate 表

P4 v1 不增加可变 delivery candidate 表。通过 G4 evaluation 时，Core 直接从 `formal_input_approval + frozen evidence + formal bitstream + snapshot provenance + confirmation facts` 生成 `delivery-candidate.v1`，作为 `gate_check_evaluation.sealed_projection` write-once 保存。

projection 至少含：项目/process/work version、snapshot 和 input hash、active B1、readiness/config/toolchain、四个 formal run、所有待交付 item、formal bitstream、来源与生成身份。不得包含 trial bitstream、临时 workspace URI、缓存、密钥或证书。G4 submit 只接受已经 sealed 且 hash 仍匹配当前事实的 projection。

### 10.2 `delivery_release` / `delivery_release_item`

`delivery_release` 至少包含：

- `id`、`project_id`、单调 `version`、`supersedes_release_id`；
- `process_version_id`、`process_instance_id`、`work_version_id`；
- `gate_submission_id`、`gate_check_evaluation_id`、`candidate_manifest_hash`；
- `approval_record_id`、`approved_gate_result_id`、`baseline_id`；
- `formal_input_approval_id`、`bitstream_result_id`；
- `schema_version=delivery-manifest.v1`、`manifest`、`manifest_hash`；
- `generated_by_type/id` 与 human `confirmed_by/confirmed_at`；
- `state` 固定为 `sealed`，整行 append-only。

`delivery_release_item` 至少包含 `release_id/project_id`、`category`、`path`、`source_type/source_id`、`sha256`、`size_bytes`、`media_type`、`storage_uri` 和 `provenance`，并与 release 同事务、append-only。

必需 category：

- `rtl`、`tb`、`constraint`、`document`；
- `run_result` 和 `raw_evidence`；
- `confirmation`（readiness、formal input、gate approval）；
- `source`（实际使用的导入/复制/修订来源）；
- `bitstream`，且唯一并指向 formal bitstream_result。

`delivery-manifest.v1` 由 Core 生成，items 按 `(category,path,sourceType,sourceId,sha256)` 排序；manifest 不含生成时间，时间保存在 release 行。`manifest_hash = SHA256(canonical-json(manifest))`。release 下载包只是该 manifest 的物化；任何下载内容都必须逐项验证，不能成为另一套事实源。

### 10.3 G4 approval 原子边界

G4 approve 请求在现有 approval 字段外必须携带 `gate_check_evaluation_id`、`candidate_manifest_hash`、`delivery_release_id` 和 `baseline_id`。Core 在事务内重算并验证所有动态条件，然后：

1. 写 ApprovalRecord 与 ApprovedGateResult；
2. 创建/换代 B2；
3. 从 sealed projection 建立 `delivery_release` 和全部 items；
4. 将 work version 推进为 released；change request 若存在则推进为 released；
5. 更新 process projection 并写 outbox/idempotency response。

任何 item 冻结失败、release version 冲突、B2 换代冲突或前提失活都回滚全部数据库写入。G4 approval 不得先成功再异步“尽力生成”release。

## 11. API 契约摘要

所有写请求必须携带 `Idempotency-Key`，并遵循第 12 节语义。

### 11.1 Profile、准备和流程状态

- `GET /api/v1/process-versions/:id/profile`
- `GET /api/v1/projects/:projectId/process-state`
- `POST /api/v1/projects/:projectId/readiness`
- `GET /api/v1/projects/:projectId/readiness`

`process-state.v1` 必须返回 Core-owned `workVersionId`：存在 `working|in_review` 版本时返回该 active work version；完成态或撤回变更后返回最新 `released` work version。没有任何 work version 是损坏事实，返回 409；Web/Runtime 不得自行生成该身份。

readiness 请求包含上述 `workVersionId`、工程配置、来源快照、workspace expected commit/manifest 和确认 reason；响应返回逐项检查、状态、config hash 与 result hash。

### 11.2 Gate evaluation

- `POST /api/v1/projects/:projectId/gate-submissions`
- `POST /api/v1/projects/:projectId/gate-submissions/:subId/evaluations`
- `GET /api/v1/projects/:projectId/gate-submissions/:subId/evaluations`
- `POST /api/v1/projects/:projectId/gate-submissions/:subId/submit`
- `POST /api/v1/projects/:projectId/gate-submissions/:subId/approve`

evaluation 示例：

```json
{
  "evaluation_id": "eval-g4-1",
  "work_version_id": "wv-1",
  "expected_snapshot_manifest_hash": "<64-hex>"
}
```

passed G4 响应同时返回 `result_hash`、`sealed_projection_hash`、逐项事实和不可编辑的缺失项列表。

### 11.3 正式运行、证据和码流

- `POST /api/v1/projects/:projectId/formal-input-approvals/preview`
- `POST /api/v1/projects/:projectId/formal-input-approvals`
- `GET /api/v1/projects/:projectId/formal-input-approvals/:id`
- `POST /api/v1/projects/:projectId/jobs`
- `POST /api/v1/projects/:projectId/jobs/:jobId/evidence/freeze`
- `GET /api/v1/projects/:projectId/jobs/:jobId/evidence`
- `GET /api/v1/projects/:projectId/jobs/:jobId/evidence/content?name=...`
- `GET /api/v1/projects/:projectId/bitstreams`

formal Job 响应必须回显 `formalInputApprovalId`、`inputSnapshotId`、`inputHash`、`toolchainProfileHash` 与 `runClass=formal`，便于 Web 在运行前后显示同一绑定。

### 11.4 Release 与变更

- `GET /api/v1/projects/:projectId/delivery-releases`
- `GET /api/v1/projects/:projectId/delivery-releases/:releaseId`
- `GET /api/v1/projects/:projectId/delivery-releases/:releaseId/manifest`
- `GET /api/v1/projects/:projectId/delivery-releases/:releaseId/content?path=...`
- `POST /api/v1/projects/:projectId/change-requests`
- `GET /api/v1/projects/:projectId/change-requests`
- `POST /api/v1/projects/:projectId/change-requests/:changeRequestId/withdraw`
- `GET /api/v1/projects/:projectId/work-versions/:workVersionId`

创建 change request 的同一事务创建对应 work version：

```json
{
  "id": "cr-2",
  "work_version_id": "wv-2",
  "base_delivery_release_id": "rel-1",
  "reason": "修改 UART 波特率寄存器",
  "affected_paths": ["doc/registers.md", "rtl/uart_regs.sv", "tb/uart_regs_tb.sv"],
  "impact_gate": "G2"
}
```

若 base release 已不是 current、已有 active work version、路径不安全或 human 没有项目角色，整次创建失败。

## 12. 身份、授权与幂等

### 12.1 授权

- profile/process/readiness/evaluation/evidence/bitstream/release 读取要求 `core:read` 和项目可见性。
- candidate revision、snapshot、submission 和 exploratory Job 沿用受控写权限，但工程项目必须绑定 active work version。
- readiness 确认、formal input 确认、gate approve、change request 开启/撤回仅限有项目角色的 human。
- formal Job 可由确认人或 `formal_input_approval.authorized_task_id` 绑定的工程 main Runtime actor 提交；side task 和未绑定 service 永远拒绝。
- Core 必须从 bearer token 和持久化任务/角色解析身份，不接受 body 中的 actor/approver/runtime 身份。

### 12.2 幂等

所有写操作的 scope 为 `(actor_type, actor_id, project_id, operation, Idempotency-Key)`。相同 scope + 相同 canonical request hash 返回原响应；相同 key 异体返回 409。每次重放在返回缓存前重新检查 feature flag、项目/角色、active work version、active baseline 和资源归属；权限或前提失效时不能泄露旧成功响应。

正式 Job 使用由 Core 首次 claim 后固定的 `job_id`、downstream idempotency key、input hash 和 operation。Connector 已接受但 Core 响应丢失时，同键重放必须重新附着同一 job，不得生成第二个 formal execution。P4 验证同进程/响应丢失语义；跨 Connector 重启的持久化可靠性不由本文宣告完成。

evidence freeze、G4 approval/release 和 baseline supersession 必须用确定性 ID 或已持久化 intent 恢复，不能因为外部内容复制或响应丢失而重复建 manifest、release、baseline 或 outbox。

## 13. 功能开关、兼容与回滚

### 13.1 `SYNTHIA_FEATURE_FORMAL_DELIVERY`

Core 唯一权威开关为 `SYNTHIA_FEATURE_FORMAL_DELIVERY`，严格接受 `1|true|0|false`，未设置等同关闭，其他值阻止启动。默认关闭。

开关关闭时：

- readiness、gate evaluation、formal input approval、P4 formal Job、evidence freeze、formal bitstream、G4 submit/approve、release 和 change request 写入返回 `503 capability_unavailable`；
- 已有 P4 profile、readiness、evaluation、evidence、bitstream、release、change/work version 均可只读；
- exploratory Job、自由项目和旧个人验证读取路径继续可用；
- GJB_REF_V1 不得退化到旧 G4 approve 路径生成一个没有 release 的“成功”；
- trial 结果不能因关闭开关被重标为 formal。

### 13.2 兼容策略

1. DB 的 G0～G9 enum、B3/B4 和 `LEGACY_COMPAT` 保留读取，不删除历史。GJB_REF_V1 只接受 profile nodes 中的 G0～G4。
2. 旧 `process_instance.current_gate` 作为 projection 读取；首次启用 P4 时从 readiness/approved result/work version重建，不能根据 Runtime 文本猜测。
3. 旧 configuration snapshot 保留；0010 为 snapshot 加项目复合键、插入时成员/trace 项目校验和 UPDATE/DELETE 拒绝。不能通过 UPDATE 把旧 snapshot 伪装成 P4 输入。
4. 0010 前的 formal ToolRun 标为 `binding_version=legacy`，继续可读但永远不能成为 P4 G4 evidence、formal bitstream 或 release item。
5. 旧 `tool_run.evidence` JSON/`evidence` 行继续可读，但没有 v1 frozen manifest 的 run 不满足 P4。
6. 既有 baseline 回填新 supersession 列为空。只有经过 P4 服务事务换代的 active leaf 可供新 formal input 使用。
7. 既有 GJB_REF_V1 项目获得 initial work version，但 readiness 保持未完成；LEGACY_COMPAT 和自由项目不被静默升级。
8. API 兼容字段可继续返回，但 Web/Runtime 新路径必须优先消费 `process-profile.v1`、`process-state`、v1 binding 和 v1 manifest，不能混合新旧事实拼出成功。

### 13.3 发布与回滚顺序

1. 在开关关闭状态应用 0010、0011，并同步 fresh-install `schema.sql`。
2. 部署能够读取新旧事实的 Core、Runtime、Web/Connector adapter；执行迁移、profile、hash 和只读兼容验证。
3. 只在 P4 端到端验收通过后开启开关。开启前创建的 legacy formal 结果不自动升级。
4. 回滚时先关闭开关，停止新 formal/G4/release 写入，再恢复上一版服务代码；保留所有新表、release、证据、码流和 supersession 历史。
5. 禁止逆向迁移、删除正式事实、改 trial 分类、重写 manifest 或把旧 baseline 恢复为 active。若发现 snapshot/hash/项目隔离错误，封禁相关写入并保留只读审计。

## 14. 验收矩阵

| 范围 | 必须通过 | 关键反例 |
|---|---|---|
| 迁移 | fresh DB、0009 升级、重复应用结果一致；schema.sql 与编号迁移一致 | 半迁移、重复 seed、旧数据被自动批准/发布 |
| Profile | API 返回唯一、稳定、可由 Web/Runtime直接消费的 G0～G4 nodes | GJB_REF_V1 接受 G5～G9；Web/Runtime仍使用 15 节点硬编码 |
| G0 | 工程配置/来源/工作区状态可形成 ready；缺约束仍可诚实完成 G0 | 自报 constraints_complete；脏工作区或跨项目 revision 通过 |
| 顺序 | gate 按 work version/profile 前进；G1/B0、G3/B1、G4/B2 映射正确 | 跳门、两个活动 submission、调用方直接改 current_gate |
| Evaluation | 每个 check 恰一 immutable item；hard fail 留痕且不能进入 review | 伪造 check hash、缺 item、waiver 绕过 hard fail |
| 正式输入 | 用户看见并确认精确文件/用途；bundle、snapshot、B1、config、toolchain hash 一致 | 当前工作树覆盖文件；缺/旧 baseline；路径/hash/part不一致 |
| Formal Job | 四项 operation 都只消费同一 input hash；身份和 main task绑定 | side/任意 service formal；客户端传 sources；`manifest:<jobId>` |
| Formal 竞态 | preview 后事实变化、baseline 换代、toolchain 漂移均要求重新确认 | 重放返回已失效旧成功；一个 approval 被换入新输入 |
| Evidence | 首次 freeze 后只读；全部字节 hash/size复核；结构化 verdict 可追溯到 raw entry | 二次 GET 覆盖；partial/truncated/corrupt/失败 run 作为正式证据 |
| DRC/时序 | errorCount=0、timing met、要求时钟覆盖且 parser 确定 | 只看退出码、日志单词 PASS、unknown verdict 当通过 |
| 码流 | incomplete/non-formal 只产生 trial；正式 implement 产生 formal | trial 原地升级、trial 进入 release、仅存在 `.bit` 即正式 |
| Delivery | G4 submit 前 sealed projection 完整；approve 原子建立 B2+release；manifest 可逐项验证 | 缺 RTL/TB/XDC/raw log/source/confirmation；跨 input 混装；半 release |
| 身份 | revision/run 的生成身份与 readiness/input/gate/release 的 human 确认身份同时可查 | body 伪造 actor；service 创建 human confirmation |
| 变更 | release 后无 CR 写入被拒；impact gate 起重新验证后生成新 release | 直接修改已发布版本；旧 bitstream重打包成新 release |
| 换代 | B0/B1/B2 同类换代原子完成且历史可追溯；并发只有一个赢家 | 两个 active baseline、分叉 successor、失败后半套状态 |
| 幂等 | same-key replay 不重复 Job/evidence/baseline/release/outbox；异体 409 | 响应丢失后二次 formal execution 或第二个 release |
| 隔离 | 所有 snapshot/run/evidence/item/baseline/release 复合项目关系正确 | 跨项目 ID 拼装、404 资源探测、task/runtime 越权 |
| 开关/回滚 | 默认关闭；关闭写保留读；旧 exploratory 路径诚实可用 | 关闭后仍能走 legacy G4 假成功；删除 P4 历史 |

P4 只有在 fresh PostgreSQL、Core↔Runtime↔Connector 真实 HTTP、Web 桌面/窄屏主路径、故障注入、全量测试/类型检查和上述反例全部收敛后，才能称为“可与 P3 一起上手验收”。文档、mock、单元测试或单个成功码流都不能单独构成完成证据。
