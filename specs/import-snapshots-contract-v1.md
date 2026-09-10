# Synthia 历史资料快照契约（v1）

状态：P2 第一切片；只允许已确认且仍有效的资料进入 Agent 默认上下文。

本文固定历史资料库第一切片的跨服务契约。它实现“导入 → 待确认 → 确认/否决 → 检索 → 复制为候选”的最小闭环，不定义 Git 仓库导入、侧边任务或备份恢复。

## 1. 状态与来源

`import_snapshot.status` 只有以下值：

- `pending_confirmation`：已固定快照，等待人工确认；
- `confirmed`：人工确认，可被默认检索；
- `denied`：人工否决，永不进入默认检索；
- `expired`：超过 `expires_at`，即使曾确认也不可检索；
- `failed`：导入或校验失败，没有可消费内容。

`source_kind` 为 `project`、`local_directory` 或 `zip`。`local_directory` 和 `zip` 的 HTTP 请求统一使用已解析的 UTF-8 文件清单；上传层必须在送入 Core 前解包，Core 仍会重新校验每个相对路径、条目数、总字节数和敏感文件名。Core 不接受未经解析的任意路径、原始 ZIP 字节或 shell 命令。

`project` 来源固定到一个已经存在的 Synthia 工作区 Git commit。调用方提供 `source_project_id`，可以同时提供 40/64 位十六进制 `commit`；省略时 Core 在事务内解析当前 HEAD，并把解析后的 commit 写入快照。调用方可以省略 `files`，由 Core 读取该固定 commit；如果同时提供 `files`，其规范化 manifest 哈希必须与该 commit 完全一致。

## 2. API

所有写请求带 `Idempotency-Key`，并受项目归属校验约束。

### 导入与查看

`POST /api/v1/projects/:projectId/import-snapshots`

```json
{
  "id": "imp_…",
  "source_kind": "local_directory",
  "source_name": "legacy-pwm",
  "source_project_id": null,
  "source_hash": "<sha256>",
  "expires_at": null,
  "files": [
    { "path": "rtl/pwm.v", "content": "module pwm;…", "media_type": "text/x-verilog" }
  ]
}
```

请求中的 `id` 是可选的幂等资源标识；省略时由服务端生成。`source_hash` 如提供，必须是规范化文件 manifest 的 64 位小写 SHA-256；`expires_at` 只接受 ISO 时间字符串或 `null`。`source_name` 最多 256 UTF-8 字节，不允许 C0/C1 控制字符、换行或 Unicode 行分隔符；全空白名称回退为安全的来源默认名。

`source_kind=project` 必须提供调用者有权读取的 `source_project_id`，且来源资料密级不得高于目标项目；无权访问的来源统一按不存在处理。`zip` 请求使用相同的解析后 `files` 结构，并额外校验归档条目、压缩大小、展开大小和压缩比元数据。

`GET /api/v1/projects/:projectId/import-snapshots` 返回快照摘要；
`GET /api/v1/projects/:projectId/import-snapshots/:snapshotId` 返回摘要与文件清单。响应中的 `valid` 由状态和有效期共同计算。

### 人工确认

`POST /api/v1/projects/:projectId/import-snapshots/:snapshotId/confirm`

```json
{ "reason": "已核对来源与适用器件" }
```

`POST …/:snapshotId/deny`

```json
{ "reason": "来源不明" }
```

只有人工身份可以确认/否决；确认和否决都是追加审计事件，不原地删除文件。

### 检索

`GET /api/v1/projects/:projectId/import-snapshots/search?q=<query>`

默认只返回 `status=confirmed` 且 `expires_at` 为空或晚于当前时间的文件。自由项目调用该接口得到空结果，不会被强制接入资料库。

规范响应 envelope 为：

```json
{
  "items": [],
  "results": [],
  "query": "pwm",
  "total": 0
}
```

`items` 与 `results` 必须是内容完全相同的数组；双字段只用于兼容当前 Web 与 Runtime 消费端，不允许其中一份承载额外结果。默认不返回正文；受信 Runtime 使用 `include_content=true` 读取正文，并重新校验每条结果。

### 复制为候选

`POST /api/v1/projects/:projectId/import-snapshots/:snapshotId/copy`

```json
{
  "id": "copy_…",
  "name": "从历史资料提取的 PWM 候选",
  "file_ids": ["impfile_…"],
  "artifact_type": "RTL_SOURCE_SET"
}
```

复制只能针对已确认且仍有效的快照；每个文件在当前项目中形成新的 `candidate` 修订，不继承来源的确认状态。请求 `id` 是这次复制操作的幂等标识，不是修订 ID；服务端为每个文件按目标项目、快照、复制操作和文件生成独立的 `import_rev_…`，并在响应的 `revision_ids`/`copied_files[].revision_id` 中返回。修订的 `source_ids`、来源关系和 outbox 事件保存快照/文件来源。

## 3. 安全上限

第一切片默认限制：单快照最多 500 个文件、展开后最多 16 MiB、单文件最多 1 MiB。拒绝绝对路径、`..` 越界段、NUL/反斜杠、`.env`、密钥/证书文件、常见私钥命名、submodule 及 `sim/` 工具产物；工作区占位用的 `.gitkeep` 不算工具产物。项目来源必须先用 Git tree 元数据完成文件数和字节预算预检，再读取 blob。任何一项校验失败都回滚整个导入，不产生半个可检索快照。

## 4. Runtime 消费规则

Runtime 只调用搜索接口的已确认有效结果，并在上下文中显示来源快照、文件路径和内容哈希。它只接受上面的规范 envelope，并逐条校验目标项目、`confirmed`、有效/可检索标记、来源类型组合、相对路径、来源名、64 位内容哈希及正文重新计算后的 SHA-256。

历史正文不进入 system prompt，也不写入持久 conversation。Runtime 在每次模型调用前重新查询 Core，把最多 8 条、单条序列化最多 2800 字符、总计最多 24000 字符的资料编码成带 `SYNTHIA_UNTRUSTED_REFERENCE_DATA_V1` 标记的独立 user-role JSONL 消息。该消息明确是不可执行的不可信参考数据；资料被撤销或过期后，下一次模型调用即不再包含它。

Core 不可达、查询失败、正文哈希不符或结果形状不合法时，Runtime 显示“资料库不可用/无可用资料”，不注入部分结果，也不复用上一次查询的资料。

## 5. 独立开关与回滚语义

P2 默认显式关闭，三层使用同名能力但各自独立配置：

- Core：`SYNTHIA_FEATURE_HISTORICAL_MATERIALS=1`。关闭时 create/confirm/deny/copy 返回 `503 capability_unavailable`；list/detail/search 保持只读，便于审计和回滚。
- Runtime：`SYNTHIA_FEATURE_HISTORICAL_MATERIALS=1`。关闭时不发起资料查询，也不注入资料消息。
- Web：构建时 `VITE_FEATURE_HISTORICAL_MATERIALS=1`。关闭时不显示历史资料入口。

Core 与 Runtime 严格接受 `1`/`true`（启用）和 `0`/`false`/未配置（关闭），其他值启动报错；Web 构建只接受明确的 `1`，其他值安全地关闭入口。关闭开关不删除 `0008_import_snapshots` 数据，不回退迁移，也不移除只读审计能力。演示、风险和最短回滚步骤见 [`p2-historical-materials-release.md`](./p2-historical-materials-release.md)。
