# P2 历史资料库发布与验证手册

- 适用切片：`implementation-plan-v1.md` 的 P2
- 状态：本地候选；以本文“发布前验证”全部通过和最终提交记录为退出依据
- 非目标：Git 仓库导入、侧边任务、备份恢复、组织试用

## 1. 能力边界

本切片提供工程项目的“导入固定快照 → 待确认 → 人工确认/否决 → 默认检索 → 复制为候选”闭环。自由项目不自动接入资料库；未确认、否决、失败或过期资料不能进入 Agent 默认上下文；复制后的修订是当前项目的新候选，不继承来源确认状态。

P2 不是组织试用完成线。真实工程交付仍依赖后续 P3～P7，尤其是侧边任务/采纳、精简 G0～G4、备份恢复和 Connector 可靠性。

## 2. 启用方式

三层能力默认关闭，部署时必须分别显式启用：

```sh
export SYNTHIA_FEATURE_HISTORICAL_MATERIALS=1
export VITE_FEATURE_HISTORICAL_MATERIALS=1
```

- Core 与 Runtime 分别读取 `SYNTHIA_FEATURE_HISTORICAL_MATERIALS`；只开启其中一层不能视为完整发布。
- Core/Runtime 严格接受 `1`/`true` 和 `0`/`false`；歧义值会阻止启动。Web 在构建时只把 `1` 视为开启，其他值保持隐藏，改变配置后需要重新构建。
- `web` 的 `dev:mock` 脚本显式开启 Web 能力，只用于本地演示。

启用 Core 前先在目标数据库执行常规迁移，并确认 `schema_migrations` 包含 `0008_import_snapshots`。不要通过删除迁移表或快照数据来开关功能。

## 3. Mock 上手演示

```sh
cd web
bun run dev:mock
```

打开终端显示的本地 URL，进入预置工程项目，在项目工作台点击“历史资料”：

1. 导入一份规范化 JSON，确认状态为“待确认”。
2. 搜索其中内容，确认未确认资料不会出现。
3. 人工确认快照，再次搜索并看到结果。
4. 勾选文件，复制为候选，确认页面提示新候选且没有继承确认状态。
5. 另行验证否决、过期、危险路径和后端不可用反馈。

Mock 只验证交互和客户端契约，不替代 PostgreSQL、Core 或 Runtime 验证。

## 4. 真实链路演示

准备一个全新 PostgreSQL 测试库、Core、Runtime 与 Web，然后：

1. 迁移数据库，分别为 Core/Runtime 显式设置 `SYNTHIA_FEATURE_HISTORICAL_MATERIALS=1`，构建 Web 时设置 `VITE_FEATURE_HISTORICAL_MATERIALS=1`。
2. 创建或选择工程项目；确认登录身份对目标项目有角色和读写/确认 scope。
3. 从本地目录/ZIP 的规范化 JSON 导入，或从有权限的 Synthia 来源项目固定 commit 导入。
4. 在确认前调用搜索并发送一次 Agent 消息，证明正文不在默认上下文。
5. 人工确认后重新搜索并发送下一次 Agent 消息，证明 Runtime 只把校验后的资料作为独立不可信参考消息注入。
6. 复制一个文件，读取返回的服务端 `revision_ids`，确认新修订为 `candidate`、密级来自目标项目、来源关系/审计/outbox 完整。
7. 关闭 Runtime 开关并再发消息，确认不再查询或注入；关闭 Core 写开关，确认写操作返回 503 而既有快照仍可读。

## 5. 发布前验证

在最终候选提交上执行：

```sh
bun test
DATABASE_URL='<fresh-postgres-url>' bun test core/tests
bun run check:names
bunx tsc --noEmit -p runtime/tsconfig.json

cd web
bun test
bun run check
bun run build
```

此外必须完成一次浏览器 Mock 主路径和一次真实 PostgreSQL P2 API 回归，并执行 `git diff --check`。如果仓库级类型检查存在切片前的已知失败，必须记录精确命令、错误基线和本切片未新增错误的对比证据，不能把失败写成“通过”。

## 6. 已知风险与观察点

| 风险 | 当前控制 | 发布时观察 |
|---|---|---|
| 历史正文包含提示注入 | 独立 user-role 不可信 JSONL、固定 system 规则、正文/总量上限、每次调用重取 | 模型是否把资料中的指令当操作要求 |
| 来源跨项目或密级降级 | 来源/目标 ACL、无权来源按 404、密级单向校验 | 403/404 比例和审计事件 |
| 大型/恶意 tree 或 ZIP | 500 文件、1 MiB 单文件、16 MiB 总量、Git 预检、ZIP 元数据限制 | 400 拒绝及内存峰值 |
| 过期/撤销后仍被模型使用 | 每次调用重新查询；查询失败不复用旧资料 | 下一轮上下文是否立即消失 |
| 复制 ID 或来源关系冲突 | 操作 ID 与服务端修订 ID 分离、命名空间哈希、复合外键、事务锁 | 幂等重放与并发复制 |
| 三层开关配置不一致 | 默认关闭、各层可独立 fail-closed | 启动配置与 503/入口可见性 |

## 7. 最短回滚

1. 先关闭 Web 构建开关，隐藏新的写入口。
2. 关闭 Runtime 开关，停止查询和注入历史资料。
3. 关闭 Core 开关，封禁 create/confirm/deny/copy，保留 list/detail/search 和审计读取。
4. 如需回退二进制，恢复上一版 Core/Runtime/Web；保留 `0008` 表、快照、来源关系、审计和 outbox 数据。
5. 验证旧的个人项目读取/Agent 路径仍可用，并记录回滚原因与最后一个成功 correlation ID。

禁止通过删除历史快照、逆向迁移或伪造状态来回滚。

## 8. 下一阶段依赖与命名

权威计划只定义 P0～P7，没有定义“P2+”。P2 退出后可按计划并行推进 P3；如果团队希望用“P2+”表示增强切片，必须先在 `implementation-plan-v1.md` 中定义范围、依赖、验收和退出条件，再开始实现或宣布进入。

P3 至少可以复用 P2 的不可变来源、候选修订和审计关系，但不得把历史资料确认等同于侧边任务结果的正式采纳。
