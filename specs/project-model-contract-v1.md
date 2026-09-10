# Synthia 项目模型与流程版本契约 v1

- 编号：PB-001
- 状态：已定稿
- 日期：2026-08-20
- 上位依据：[产品基线 v1](./product-baseline-v1.md)、[实施计划 v1](./implementation-plan-v1.md)

## 1. 目的与范围

本文固定首版项目类型、流程版本、旧数据兼容和跨服务边界。它回答“项目创建后是什么”“各服务可以依据什么做决定”，不定义历史导入、侧边任务、备份恢复或完整 G0～G4 门禁。

首版只有两个对外项目类型：`free` 和 `engineering`。首版唯一可选的工程流程版本是 `GJB_REF_V1`，显示名为“GJB 参考流程 v1”。该名称表示平台提供的参考工程流程，不表示产品已经取得 GJB 9432-2018 符合性。

## 2. 数据字典

### 2.1 项目

| 字段 | 类型 | 含义与规则 |
|---|---|---|
| `id` | string | 项目唯一 ID，同时用于工作区标识；创建后不变。 |
| `name` | string | 用户可见名称；创建时必填。 |
| `project_type` | `free \| engineering` | 项目工作方式；创建后不可原地切换。 |
| `process_version_id` | string 或 null | 项目绑定的流程版本主键。新版工程项目为 `GJB_REF_V1`；自由项目为 null；旧项目为 `LEGACY_COMPAT`。 |
| `process_profile_id` | string 或 null | API 使用的流程 profile 标识。首版与 `process_version_id` 使用同一内部 ID。 |
| `process_profile_version` | string 或 null | 冻结在项目上的版本标识。首版同样为 `GJB_REF_V1`；兼容项目为 `LEGACY_COMPAT`。 |
| `process_profile_name` | string 或 null | 冻结的显示名，首版为“GJB 参考流程 v1”。 |
| `target_part` | string 或 null | FPGA 器件型号。自由项目可省略；工程项目建议创建时填写，但正式 G4 前必须满足后续约束完整性规则。 |
| `process_instances` | array | 该项目的流程实例。新版工程项目创建时包含一个处于 G0 的实例；自由项目不强制创建。 |
| `status` | `active \| archived` | 项目生命周期状态。 |

`process_profile_*` 是项目创建时的冻结快照，便于稳定展示和审计；注册表中的同名记录不能被修改后静默影响已有项目。

### 2.2 流程注册表

`process_definition` 表示流程定义，`process_version` 表示可绑定的不可变版本。首版公开记录如下：

| 字段 | 值 |
|---|---|
| `id` | `GJB_REF_V1` |
| `profile_id` | `GJB_REF_V1` |
| `version` | `GJB_REF_V1` |
| `name` | `GJB 参考流程 v1` |
| `status` | `active` |

`LEGACY_COMPAT` 是内部兼容记录，状态为 `retired`，不出现在新建工程项目的可选流程列表中。它只说明该项目沿用旧行为，不能被解释为通过或采用 `GJB_REF_V1`。

### 2.3 流程实例

`process_instance` 记录项目实际推进状态，核心字段为 `project_id`、`gate_profile_version`、`current_gate` 和 `created_at`。新版工程项目创建时，Core 在同一事务中绑定 `GJB_REF_V1` 并建立 G0 实例；重复请求不得建立第二个准备实例。现有 G0～G9 枚举暂时保留兼容，但首版新流程只开放 G0～G4。

## 3. 不可变规则

1. `project_type` 在创建时确定。自由项目正式化必须复制成新的工程项目并记录来源，不能原地改型。
2. 工程项目必须在创建时选择一个 `active` 流程版本。首版只接受 `GJB_REF_V1`。
3. 项目绑定的 `process_version_id`、profile ID、版本和显示名创建后不可静默更换。数据库约束阻止直接替换；未来升级必须是单独的用户操作，并产生迁移和审计记录。
4. 自由项目不绑定流程版本，也不因旧默认逻辑自动出现 GJB 阶段。
5. `LEGACY_COMPAT` 永远不能自动升级为 `GJB_REF_V1`。用户要进入新版工程流程时，应复制为新项目。
6. 所有项目写操作继续使用 `Idempotency-Key`、事务和 outbox。相同键与相同请求返回原结果；相同键但不同请求返回冲突。
7. 手工创建流程实例时，新版工程项目的 `gate_profile_version` 必须等于项目冻结的 profile，否则拒绝，避免旁路更换流程。

## 4. 自由、工程与旧数据兼容矩阵

| 场景 | 存储的 `project_type` | 流程标识 | `target_part` | 创建时 G0 | 客户端行为 |
|---|---|---|---|---|---|
| 显式新建自由项目 | `free` | null | 可为 null | 不创建 | 显示自由工作台，不显示强制阶段。 |
| 显式新建工程项目 | `engineering` | `GJB_REF_V1` | 可为 null；正式 G4 前补齐 | 创建并绑定 | 显示“GJB 参考流程 v1”和 G0～G4 主线。 |
| 显式工程项目但缺流程 | 不创建 | 无 | 无 | 不创建 | Core 返回输入校验错误。 |
| 显式工程项目但流程无效或停用 | 不创建 | 无 | 无 | 不创建 | Core 返回输入校验错误。 |
| 旧 API 请求同时缺 `project_type` 和流程字段 | `engineering` | `LEGACY_COMPAT` | 保留旧默认/请求值 | 不自动创建 | 仅按兼容项目展示，不得显示成新版 GJB 流程。 |
| 迁移前已有项目 | 回填为 `engineering` | `LEGACY_COMPAT` | 原值不变 | 原实例不变 | 保留历史行为；不得自动补新版 G0。 |

兼容窗口只保障旧请求和旧数据仍可读取、创建和继续使用，不承诺它们自动获得新版工程流程能力。

## 5. Core API 契约

所有示例省略统一成功信封中的 `correlation_id` 等公共字段。写请求必须携带认证信息和 `Idempotency-Key`。

### 5.1 查询可选流程

`GET /api/v1/process-versions`

```json
[
  {
    "id": "GJB_REF_V1",
    "profile_id": "GJB_REF_V1",
    "version": "GJB_REF_V1",
    "name": "GJB 参考流程 v1",
    "status": "active",
    "process_profile_id": "GJB_REF_V1",
    "process_profile_version": "GJB_REF_V1",
    "process_profile_name": "GJB 参考流程 v1"
  }
]
```

### 5.2 创建自由项目

`POST /api/v1/projects`

```json
{
  "id": "scratch_uart",
  "name": "UART 排错",
  "project_type": "free"
}
```

响应数据：

```json
{
  "id": "scratch_uart",
  "name": "UART 排错",
  "status": "active",
  "project_type": "free",
  "process_profile_id": null,
  "process_profile_version": null,
  "process_profile_name": null,
  "target_part": null,
  "process_instances": []
}
```

### 5.3 创建工程项目

`POST /api/v1/projects`

```json
{
  "id": "flight_ctrl_fpga",
  "name": "飞控 FPGA",
  "project_type": "engineering",
  "process_profile_id": "GJB_REF_V1",
  "target_part": "xc7a200tsbg484-1"
}
```

响应数据：

```json
{
  "id": "flight_ctrl_fpga",
  "name": "飞控 FPGA",
  "status": "active",
  "project_type": "engineering",
  "process_profile_id": "GJB_REF_V1",
  "process_profile_version": "GJB_REF_V1",
  "process_profile_name": "GJB 参考流程 v1",
  "target_part": "xc7a200tsbg484-1",
  "process_instances": [
    {
      "id": "pi_flight_ctrl_fpga_G0",
      "gate_profile_version": "GJB_REF_V1",
      "current_gate": "G0"
    }
  ]
}
```

### 5.4 查询项目

`GET /api/v1/projects` 返回项目数组，按创建时间倒序；每项包含 `project_type`、流程快照、`target_part` 和 `process_instances`。

`GET /api/v1/projects/:id` 返回同样的模型，并增加 `scope`、数据分类、标准版本、工具链配置和完整流程实例时间字段。例如：

```json
{
  "id": "flight_ctrl_fpga",
  "name": "飞控 FPGA",
  "project_type": "engineering",
  "process_version_id": "GJB_REF_V1",
  "process_profile_id": "GJB_REF_V1",
  "process_profile_version": "GJB_REF_V1",
  "process_profile_name": "GJB 参考流程 v1",
  "target_part": "xc7a200tsbg484-1",
  "process_instances": [
    {
      "id": "pi_flight_ctrl_fpga_G0",
      "gate_profile_version": "GJB_REF_V1",
      "current_gate": "G0",
      "created_at": "2026-08-20T08:00:00.000Z"
    }
  ]
}
```

## 6. 迁移顺序与回滚策略

### 6.1 前向迁移

1. 依次应用现有 `0000`～`0005` 迁移。
2. 应用 `0006_project_type_process_version.sql`：建立流程定义/版本表，为项目增加类型与流程快照字段，使 `target_part` 可空，并注册 `GJB_REF_V1` 与内部 `LEGACY_COMPAT`。
3. 将尚无流程标记的历史项目回填为 `engineering + LEGACY_COMPAT`，保持原器件和原流程实例不变。
4. 建立流程绑定不可变约束，记录迁移版本；同步的 `schema.sql` 用于新数据库。
5. 后续若增加项目约束完整度，可由独立的 `0007` 前向迁移完成，不得改写 `0006` 已发布语义。

迁移必须可重复执行；重复执行不能重复 seed、重复创建约束或改变已绑定项目。

### 6.2 发布回滚

数据库采用前向兼容，不通过删除列、删除流程记录或反向改写历史项目来回滚。最短回滚路径是：

1. 关闭 Web 新建向导和新版工程项目写入口；保留项目、流程和审计数据只读。
2. 恢复上一版 API/Runtime 时，禁止旧服务继续创建无法正确标记的新项目；必要时暂时封禁 `POST /projects`。
3. 保留 `0006` 新表、新列、`LEGACY_COMPAT` 回填和 outbox，不删除已经创建的 G0 实例。
4. 修复后用新的前向迁移和服务版本恢复写入，并验证重复请求不产生重复项目或流程实例。

如果发现项目被错误绑定流程，应停止相关写操作并保留证据，不能把记录直接改成 `GJB_REF_V1` 作为“修复”。

## 7. Runtime、Web 与 Connector 边界

### Core

Core 是项目类型、流程注册表、项目流程绑定、幂等和审计事实的唯一权威。其他服务不能用默认值绕过 Core，也不能直接改数据库来切换项目类型或流程。

### Runtime

Runtime 每次根据 Core 返回的 `project_type` 和冻结流程字段选择工作方式：

- `free` 使用自由会话，不附加 GJB 阶段或默认器件要求；
- `engineering + GJB_REF_V1` 使用工程主线，并只按首版 G0～G4 推进；
- `LEGACY_COMPAT` 走明确的兼容路径，不得推断为 `GJB_REF_V1`；
- 配置缺失、未知 profile 或项目归属不一致时 fail-closed，并向用户报告配置问题。

Runtime 不创建替代的流程事实，`.runs` 或会话状态也不能成为项目类型和流程版本的唯一来源。

### Web

Web 新建入口必须先让用户选择自由或工程项目。工程项目的流程选项来自 `GET /process-versions`，创建后只读展示类型与流程；自由项目不显示强制阶段，也不强制填写器件。Web 不提供原地“自由转工程”或流程版本切换按钮，正式化使用后续的复制流程。

对于 `LEGACY_COMPAT`，Web 应显示“兼容旧流程”或等价提示，不显示“GJB 参考流程 v1”。错误、冲突和重放结果使用 Core 返回的统一信封处理。

### Connector

Connector 不拥有项目类型或流程选择逻辑，不增加新的 Connector 类型，也不修改 `connector.remote.v1`。它只执行 Core 已校验和授权的工具任务，并保持项目 ID、输入快照、运行类别和证据绑定。自由/工程差异由 Core 与 Runtime 在提交任务前决定，Connector 不根据缺失字段自行补流程。

## 8. 验收要点

- 自由项目和工程项目均能创建并在刷新后保持字段不变。
- 工程项目缺少或使用无效流程时被拒绝；成功创建时只有一个 G0 准备实例。
- 自由项目的器件可空，且没有强制 GJB 流程实例。
- 旧请求和历史项目显示为 `LEGACY_COMPAT`，不会显示为 `GJB_REF_V1`。
- 相同幂等请求不重复创建项目、流程实例或 outbox 事实。
- Runtime、Web 和 Connector 都不能绕过 Core 更换项目类型或流程版本。
