# Synthia 任务工作区与正式采纳契约（v1）

- 编号：PB-003
- 状态：P3 第一切片；已冻结
- 日期：2026-08-21
- 上位依据：[产品基线 v1](./product-baseline-v1.md)、[实施计划 v1](./implementation-plan-v1.md)

## 1. 目的与范围

本文固定 P3 第一条可演示闭环：从项目当前不可变 Git 提交创建侧边任务的独立副本，侧边任务只在副本中探索，Core 密封结果并计算差异，最后由人选择文件采纳为项目主工作区的新候选修订。

本切片只支持新增或修改符合工作区路径规则的 UTF-8 文本文件，单文件最多 1 MiB。不支持删除、二进制文件、符号链接、Git submodule、自动合并、自动采纳、侧边任务提门、侧边任务创建里程碑或侧边任务启动 `gate_check` / `formal` 运行。遇到这些情况必须 fail-closed，不得退化为直接修改项目主工作区。

功能由 `SYNTHIA_FEATURE_SIDE_TASKS` 控制，默认关闭。关闭时创建侧边任务、写侧边工作区、密封结果和采纳均返回 `503 capability_unavailable`；已经存在的任务、事件、结果、差异和采纳记录仍可只读。旧的个人主任务读取路径不因关闭开关而删除或改写。

## 2. 权威边界

- Core 是任务身份、父子关系、授权范围、状态、输入/输出哈希、对话事实、结果包和采纳记录的唯一事实源。
- Runtime 负责模型循环和 SSE 实时传输，但 Runtime 的内存 registry 与 `.runs/` 只是执行缓存和恢复材料。Runtime 不得以本地文件覆盖 Core 中的任务事实。
- 所有 Core-owned task（工程 main、自由 main、side）都使用显式启动屏障：Core 先持久化 `queued` 事实，Runtime 幂等登记，Core 绑定 `runtime_agent_id`，最后 Runtime 幂等 `/start`。首次 objective 在 `/start` 前不得进入模型；创建响应丢失、启动响应丢失和同键重放均不得重复执行 objective。
- 项目主工作区仍由 Core 管理。侧边任务使用独立 Git clone，不使用项目主工作树，也不共享可写 Git worktree 元数据。
- Web 只根据 Core 返回的任务描述、结果和差异展示状态。SSE 断开或 Runtime 不可用时，已经持久化的任务事实仍可读取。
- P2 复制得到的 `db://artifact_revision/...` 候选不会静默进入侧边副本。P3 第一切片的输入严格等于项目 Git `base_commit` 的树；要让其他候选参与，必须先显式物化并登记到项目工作区。

## 3. 数据字典

### 3.1 `agent_task`

| 字段 | 规则 |
|---|---|
| `id` | Core 生成的全局任务 ID；Runtime 使用同一 ID 幂等创建执行实例。 |
| `project_id` / `project_type` | 冻结任务所属项目；二者通过复合外键绑定项目真实类型。 |
| `kind` | `main` 或 `side`。`side` 必须有同项目、非终态的 `main` 父任务。 |
| `parent_task_id` | `main` 必须为空；`side` 必须指向父主任务。 |
| `workspace_id` | `main` 为空并使用项目主工作区；`side` 必须指向自己的任务工作区，且一个工作区只能属于一个任务。 |
| `authorization_scope` | `task-scope.v1` JSON。第一切片固定为 `isolated` 工作区；`read_paths` 只覆盖受控项目根目录，`write_paths` 必须是 1～32 个精确文件；工具运行只允许 `exploratory`，三项正式工程能力必须为 `false`。写路径不得使用 glob、绝对路径或 `..`，单条最多 512 个 UTF-8 字节、32 层，并须落在 `rtl/`、`tb/`、`doc/` 或 `prj/constr/`。`doc/` 不接受 HDL 扩展名。 |
| `status` | `queued`、`running`、`awaiting_user`、`succeeded`、`failed`、`cancelled`、`fail_closed`。 |
| `input_hash` / `output_hash` | 64 位小写 SHA-256。输出哈希仅在任务成功并密封一个结果时存在。 |
| `runtime_agent_id` | Runtime 执行实例标识，只能从 null 设置一次，不能换绑。 |
| `runtime_actor_id` | Core 配置并持久化的 task Runtime service uid，创建后不可换绑。生产默认 `synthia-runtime`，可用 `SYNTHIA_RUNTIME_ACTOR_ID` 覆盖；它必须与 `SYNTHIA_TASK_RUNTIME_TOKEN` 解析出的 service uid 一致。通用 `SYNTHIA_CORE_TOKEN` 可以属于另一个 service uid，但不能携带 `core:task-runtime`。 |

数据库必须用 partial unique index 保证每个工程项目同时最多一个非终态 `main`。自由项目不受该唯一索引限制。

### 3.2 `task_workspace`

`task_workspace` 记录服务端生成的 `storage_key`、不可变 `base_commit`、`base_manifest_hash`、当前 `head_commit` 和前向状态。`storage_key` 不是客户端路径，也不得包含目录分隔符。默认物理根由 `SYNTHIA_TASK_WORKSPACES_DIR` 指定；未指定时使用 Synthia 管理目录。

侧边副本只允许从所属项目当前可达的 Git commit 创建。第一切片要求创建时：

1. 请求中的 `base_commit` 等于项目当前 HEAD；
2. 项目主工作树没有未登记改动；
3. Core 在副本创建前计算并持久化 base manifest；
4. clone 失败时工作区进入 `failed`，不得启动 Runtime。

### 3.3 事件、结果与采纳

- `task_conversation_event` 是有序 append-only 事实。每任务的 `sequence` 单调递增，事件 ID 与 sequence 重放不得生成第二条记录。只持久化完整的用户消息、助手消息、工具调用/结果和状态事件，不持久化 SSE 文本 delta。
- `task_workspace_file` 是结果密封时捕获的新增/修改文件，保存 UTF-8 正文、base/result 哈希和字节数。它不是可变的工作树索引。
- `task_result` 以 `(task_id, output_hash)` 保证重复密封幂等，绑定任务、工作区、base/result commit、结论、测试摘要、规范化 manifest 和 `output_hash`。第一切片的成功任务只暴露一条密封结果；表结构保留未来多次密封结果的前向空间。结果一经写入不可修改或删除。
- side task 只有在 Runtime-only 控制工具 `synthia_complete_side_task` 成功调用后，随后的最终助手文本才可触发结果密封。普通助手文本只把任务推进到 `awaiting_user`；用户可通过同一 task 的消息接口补充信息，再进入 `running`。Web 必须展示 Core 中的用户/助手事件和补充入口，不能只显示一个不可操作的等待状态。
- 结果中的测试摘要只由 Core 查询与该 `project_id + task_id + workspace_id` 精确绑定的 `tool_run` 事实生成。Runtime 请求体中的自报 `tests` 不作为证据，也不得进入 `output_hash`。
- `task_adoption` 记录一次人工采纳尝试及主工作区前后 commit。状态只允许从 `applying` 前进到 `applied`、`conflicted` 或 `failed`。
- `task_adoption_file` 记录实际采纳的每个来源文件、采纳前目标哈希、目标 artifact/revision/version。相同 side task、result 和 path 最多采纳一次。

## 4. 状态机

### 4.1 任务

```text
queued ──→ running ──→ awaiting_user ──→ running
  │           │              │
  │           └──────────────┴──→ succeeded
  └──────────────────────────────→ failed | cancelled | fail_closed
```

`running` 和 `awaiting_user` 也可进入 `failed`、`cancelled` 或 `fail_closed`。终态不可恢复或改写。`side.succeeded` 必须与 `task_result`、结果文件和 `output_hash` 在同一数据库事务中完成。

### 4.2 工作区

```text
provisioning → active → sealed → released
      │           │
      └───────────┴────→ failed
```

只有 `active` 可写。`sealed` 后 `head_commit` 和结果文件不可变；`released` 只表示临时 clone 已清理，Core 中的密封结果仍完整可读。

### 4.3 采纳

```text
applying → applied | conflicted | failed
```

`conflicted` 和 `failed` 是本次采纳尝试的终态；刷新差异后必须使用新的采纳 ID 发起新尝试，不能修改旧记录伪装成功。

## 5. 哈希契约

所有哈希都对 UTF-8 字节计算 SHA-256，并编码为 64 位小写十六进制。

`base_manifest_hash` 的输入为所有可登记文件按规范化 path 升序排列后的行：

```text
<path> NUL <sha256(file-bytes)> NUL <size-bytes> LF
```

`input_hash` 的输入是 canonical JSON：对象键按 Unicode code point 升序，数组顺序保留，不输出无意义空白。对象固定包含：

```json
{
  "schema": "task-input.v1",
  "projectId": "...",
  "kind": "side",
  "parentTaskId": "...",
  "objective": "...",
  "baseCommit": "...",
  "baseManifestHash": "...",
  "authorizationScope": {}
}
```

结果 manifest 使用 `task-result.v1`，文件按 path 升序，至少包含 `path`、`changeKind`、`baseHash`、`resultHash` 和 `sizeBytes`；另含 `taskId`、`workspaceId`、`baseCommit`、`resultCommit`、`summaryHash` 和规范化测试结果。`output_hash` 是该 canonical JSON 的 SHA-256。时间戳不得进入 input/output hash。

## 6. API 契约

所有写请求必须带 `Idempotency-Key`；同 actor、project、operation、key 与相同 request hash 返回原响应，不同 request hash 返回 409。重放前必须重新检查功能开关、项目状态和当前项目权限。

对 Core-owned task 的 `POST .../message`，Core 与 Runtime 必须共同使用同一个幂等键：Core 不能重复追加用户事件，Runtime 在并发、响应丢失或重启后不能重复 prompt/steer；同键异体返回 409。兼容窗口内的旧 Runtime-only task 可继续接受无幂等键消息，但不得因此降低 Core-owned task 的语义。

Runtime 必须在任何对话审计、Core 事件、prompt 或 steer 副作用之前，先原子持久化该键的 `in_progress` intent；只有安全接受后才能把它推进为 `completed` 响应。若 Runtime 在副作用后、完成响应落盘前崩溃，重启后同键同体固定返回 `409 idempotency_in_progress`，同键异体返回 `409 idempotency_conflict`，两者都不得再次派发。旧账本中没有状态字段的已完成响应按 `completed` 兼容读取。

不同幂等键也必须按 task 串行完成最新终态检查、session 状态分类和 prompt/steer 派发。一次 prompt 从开始到助手事件、状态事件以及结果密封或 fail-closed 全部提交前，都属于同一个活动 turn；session 已回到 idle 但 turn 仍在封存时，新消息返回 `409 task_turn_finalizing` 且不产生对话副作用。任务进入 Core 终态后统一返回 `409 task_terminal`。

### 6.1 创建与读取

`POST /api/v1/projects/:projectId/tasks`

侧边任务请求：

```json
{
  "kind": "side",
  "parent_task_id": "task_...",
  "objective": "比较两种流水线实现",
  "base_commit": "<40-or-64-hex>",
  "authorization_scope": {
    "schema": "task-scope.v1",
    "workspace": "isolated",
    "read_paths": ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
    "write_paths": ["rtl/pipeline.v", "tb/pipeline_tb.sv"],
    "run_classes": ["exploratory"],
    "can_submit_gates": false,
    "can_create_milestones": false,
    "can_start_formal_runs": false
  }
}
```

成功返回 201，并至少包含 `task_id`、`project_id`、`kind`、`parent_task_id`、`workspace_id`、`base_commit`、`base_manifest_hash`、`authorization_scope`、`input_hash` 和 `status`。Core 先持久化任务事实并准备独立 clone，再允许 Runtime 处理；Runtime 不得自行解析项目路径创建副本。

创建或同键重放都要驱动以下可恢复序列：`Runtime register → Core bind → Runtime start`。若 Core 已提交而 register/start 暂时失败，任务保持 `queued`；原请求同键重放必须继续修复该序列。Runtime 返回 `already_started` 视为成功重放，不能再次派发 objective。

- `GET /api/v1/projects/:projectId/tasks`
- `GET /api/v1/projects/:projectId/tasks/:taskId`
- `GET /api/v1/projects/:projectId/tasks/:taskId/events?after=<sequence>`

读取以 Core 为准；Runtime 不可用不能把已经存在的任务变成 404。

### 6.2 任务工作区与结果

以下路由只供绑定该 task/project 的 Runtime 服务调用，Core 必须再次核对任务归属与授权范围：

- `GET /api/v1/projects/:projectId/tasks/:taskId/workspace/tree`
- `GET /api/v1/projects/:projectId/tasks/:taskId/workspace/file?path=...`
- `POST /api/v1/projects/:projectId/tasks/:taskId/workspace/files`
- `POST /api/v1/projects/:projectId/tasks/:taskId/events`
- `POST /api/v1/projects/:projectId/tasks/:taskId/result`
- `POST /api/v1/projects/:projectId/tasks/:taskId/jobs`
- `GET /api/v1/projects/:projectId/tasks/:taskId/jobs/:jobId`
- `GET /api/v1/projects/:projectId/tasks/:taskId/jobs/:jobId/evidence`
- `GET /api/v1/projects/:projectId/tasks/:taskId/jobs/:jobId/evidence/content?name=...`

这些 Runtime-only 路由要求 `SYNTHIA_TASK_RUNTIME_TOKEN` 提供的专用 `core:task-runtime` scope。按去重、无序的集合语义，专用 token 的 scope 必须精确等于 `{core:task-runtime}`；Core 鉴权必须拒绝任何同时携带 `core:task-runtime` 与其他不同 scope 的 token。Runtime 的通用 `SYNTHIA_CORE_TOKEN` 只用于主线治理和非 task-bound Connector，不得携带 `core:task-runtime`。

Core 同时核对认证身份是 service、其 uid 等于 `agent_task.runtime_actor_id`、任务头同时等于 path 中的 task 与已绑定 `runtime_agent_id`，并在 side task 上核对工作区头等于持久化 `workspace_id`。任一持久化绑定缺失或不一致都按 404 fail-closed；缺少专用 scope、混合 scope 或非 service 身份返回 403/401，且不得执行任何任务副作用。通用 `core:read` / `core:write` service token 即使伪造 task/workspace 头也不能调用这些路由；专用 task Runtime token 即使省略绑定头也不能调用项目主 workspace、gate、snapshot、approval 或通用 job 路由。

`workspace/files` 只能写 `authorization_scope.write_paths` 中的精确路径；`jobs` 忽略请求中的升级意图并把 side task 强制为 `exploratory`。task-scoped job 状态、证据清单和证据正文读取还必须逐次核对 `tool_run.project_id`、`parameters.taskId`、`parameters.workspaceId` 和 `run_class='exploratory'`；不满足时统一按 404。side task 不得调用项目主 workspace、gate、baseline、approval 或 formal job 写路由。

密封结果时 Core 从 `base_commit..head_commit` 重新计算完整 diff 和每个内容哈希，不能信任 Runtime 提交的 patch/hash。出现删除、越权路径、未提交改动、非 UTF-8、超过 1 MiB、symlink 或 submodule 时整次密封失败。

### 6.3 差异与采纳

- `GET /api/v1/projects/:projectId/tasks/:taskId/result`
- `GET /api/v1/projects/:projectId/tasks/:taskId/diff`
- `POST /api/v1/projects/:projectId/tasks/:taskId/adoptions`

`diff` 返回 path、change kind、base/result/current-target hash、文本差异和冲突原因，并返回覆盖当前目标状态的 `preview_hash`。

采纳请求必须来自 human，包含 `adoption_id`、`result_id`、选中 path、每路径在预览时看到的目标 hash、`preview_hash` 和非空 reason。服务身份、agent 和 connector 均不能采纳。

Core 在项目级数据库 advisory lock 与文件锁内一次性处理选中文件：

- `modified` 要求主工作区当前目标 hash 同时等于 side base hash 和预览 expected hash；
- `added` 要求主工作区不存在该路径，且预览 expected hash 为 null；
- 选中路径存在未登记修改时返回 409；
- 任一文件冲突时整批不写 Git、不建修订；
- 无冲突时选中文件进入一个主工作区 commit，并逐文件创建新的 `candidate` revision；
- revision 的 `created_by` 是确认采纳的人，来源 task/result/file 记录在 `task_adoption_file`，不继承任何批准状态。

不同路径上的主工作区变化不自动构成冲突；第一切片不做自动三方合并。为覆盖“Git commit 已成功但数据库完成记录失败”的故障点，采纳先持久化 `applying` 意图，Git commit 带确定性 adoption ID，重试根据该 ID 完成同一操作而不是再写一遍。

## 7. 隔离与失败语义

- 所有任务、父任务、工作区、结果、采纳和目标 revision 的数据库关系都用 `(resource_id, project_id)` 复合外键，不能只在 API 字符串层比较 project ID。
- 未授权访问其他项目或其他 task workspace 统一返回 404，避免探测资源存在性。
- 侧边 clone 路径只由 Core 的 `storage_key` 解析；客户端不能提交绝对路径、clone URL 或任意本地目录。
- Core 扫描 Git mode 并拒绝 symlink/submodule；词法 `..` 检查不能替代真实文件类型检查。
- 任务失败、Runtime 重启、功能开关关闭或临时 clone 清理都不能删除对话事件、密封结果或采纳记录。
- 数据迁移只前向保留。回滚使用关闭开关和恢复上一版服务代码，不删除 `0009` 表或已有任务事实。

## 8. 第一切片验收

1. 工程项目的 main 等待用户时仍能创建并运行 side；并发创建第二个活动 main 由数据库唯一约束拒绝。
2. side 写入后项目主 HEAD、主文件和 artifact revisions 完全不变。
3. Runtime 重启或 `.runs/` 丢失后，Core 仍能读取 task、events、result、diff 和 adoption。
4. 越权路径、跨项目 parent/workspace、side formal job、删除、二进制、symlink 和重复 finalize 全部 fail-closed。
5. 人能预览 diff、选择部分文件采纳；只产生选中文件的新 candidate revisions，未选文件不变。
6. 主线同路径变化、脏文件和重复采纳均返回稳定冲突且无半套状态；相同幂等键重放原响应。
7. Core-owned main/side 在 `/start` 前不执行 objective；register/start 或消息响应丢失后，同键重放只修复一次派发。
8. side 普通回复进入 `awaiting_user` 且不生成结果；用户能看到完整问题并幂等补充，只有显式完成信号才密封。结果测试只反映 Core 已记录的 tool run，Runtime 伪造 tests 被忽略。
9. Runtime-only 路由拒绝通用 service token；task Runtime token 无法调用项目主 workspace、gate、snapshot、approval 或通用 job 路由；混合 scope token 在鉴权层被拒绝。第二个 service 即使持有专用 scope 并伪造正确 task/workspace 头，也不能冒充任务绑定的 Runtime actor；合法绑定的 task-scoped job submit → status → evidence → content 链路仍完整通过。
10. 消息 intent 首写失败、完成响应落盘失败后重启、不同键并发和结果封存窗口都用故障注入验证：不得重复 prompt/steer，不得复活终态，也不得把任务错误推进为成功或半套状态。
