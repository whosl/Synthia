# P3 任务工作区与正式采纳发布验证手册

- 适用切片：`implementation-plan-v1.md` 的 P3 第一切片
- 状态：P3 第一切片本地可上手验证；本文退出清单已于 2026-08-21 全部通过并按六个审计边界形成提交
- 权威契约：[`task-workspaces-contract-v1.md`](./task-workspaces-contract-v1.md)
- 非目标：宣告整个 P3 完成、自动合并/自动采纳、删除或二进制结果、侧边任务提门/建里程碑/启动正式运行、P4～P7

## 1. 能力边界

本切片提供一条受控闭环：Core 先持久化主/侧任务，侧边任务从项目当前不可变 Git commit 创建独立 clone，Runtime 只在精确授权路径内探索，Core 密封结果并重新计算差异，最后由人选择文件原子采纳为项目主工作区的新 `candidate` 修订。

Core 是任务、对话事件、结果、差异和采纳记录的事实源；Runtime 的内存状态与 `.runs/` 只用于执行和恢复。所有 Core-owned main/side task 都必须经过 `register → bind → /start` 显式屏障，首次 objective 在 `/start` 前不得进入模型。侧边普通回复只进入 `awaiting_user`，只有 Runtime 控制工具 `synthia_complete_side_task` 成功后才允许密封结果。

本切片不是整个 P3 或组织试用完成线。尤其不包含自动三方合并、强制覆盖、任务结果自动进入正式阶段，也不替代后续 P4 的精简 G0～G4 与正式证据、P5 的备份恢复、P6 的 Connector 可靠性和 P7 的组织试用门槛。

## 2. 身份、凭据与启用方式

### 2.1 两枚 Runtime 凭据必须分离

先在目标数据库执行常规迁移，再由 bootstrap 创建独立 service 身份：

```sh
DATABASE_URL='<postgres-url>' bun run core/scripts/bootstrap-admin.ts
```

脚本会只显示一次明文 token；应立即写入受管 secret storage，禁止写进仓库、日志或发布文档。Runtime 使用其中两枚不同凭据：

| bootstrap 输出 | Runtime 环境变量 | 身份与精确权限 | 允许用途 |
|---|---|---|---|
| `SERVICE_TOKEN` | `SYNTHIA_CORE_TOKEN` | 默认 uid `synthia-service`；`core:read`、`core:write` | 主线治理及非 task-bound Connector/Core 请求 |
| `TASK_RUNTIME_TOKEN` | `SYNTHIA_TASK_RUNTIME_TOKEN` | 默认 uid `synthia-runtime`；scope 必须精确等于单元素集合 `{core:task-runtime}` | 已绑定 task 的事件、工作区、结果和 exploratory job 回调 |

两枚 token 不能合并或互换。Core 在鉴权边界拒绝同时带 `core:task-runtime` 与任何其他不同 scope 的 token；普通 token 不能调用 Runtime-only task 路由，task token 也不能调用项目主工作区、gate、snapshot、approval 或通用 job 路由。

`SYNTHIA_RUNTIME_ACTOR_ID` 是 Core 为新 Core-owned task 持久化的 Runtime service uid，默认值为 `synthia-runtime`。它必须与 `SYNTHIA_TASK_RUNTIME_TOKEN` 解析出的 service uid 完全一致；若部署使用自定义 task Runtime uid，必须同时：

1. 为该 uid 创建仅含 `core:task-runtime` 的 service token；
2. 在 Core 进程设置相同的 `SYNTHIA_RUNTIME_ACTOR_ID`；
3. 在 Runtime 进程把该 token 配置为 `SYNTHIA_TASK_RUNTIME_TOKEN`。

通用 `SYNTHIA_CORE_TOKEN` 可以属于不同 uid。不要通过把 task scope 加到通用 token 来修复 actor 不匹配。

### 2.2 开关默认关闭

P3 第一切片只有 Core 和 Web 两层发布开关，均默认关闭：

```sh
# Core：严格接受 1/true 或 0/false；未配置等同关闭，其他值阻止启动
export SYNTHIA_FEATURE_SIDE_TASKS=1

# Web：构建时只有精确字符串 1 才开启，改变后必须重新构建
export VITE_FEATURE_SIDE_TASKS=1
```

- Core 开关关闭时，创建侧边任务、侧边工作区写入、结果密封和采纳返回 `503 capability_unavailable`；既有任务、事件、结果、差异与采纳事实仍可读。
- Web 开关关闭时，探索任务入口隐藏且不得发送 side-task 请求。
- Runtime 没有独立的 P3 功能开关；它依靠 Core 能力开关、task 绑定和专用 token fail-closed。不要记录或部署不存在的 `SYNTHIA_FEATURE_SIDE_TASKS` Runtime 开关。
- `web` 的 `dev:mock` 脚本会显式开启 Web 开关，只用于本地交互验收。

### 2.3 最小双服务配置

Core 至少需要：

```sh
export DATABASE_URL='<fresh-postgres-url>'
export SYNTHIA_FEATURE_SIDE_TASKS=1
export SYNTHIA_RUNTIME_URL='http://127.0.0.1:8790'
export SYNTHIA_RUNTIME_ACTOR_ID='synthia-runtime'
bun run core/scripts/serve.ts
```

Runtime 至少需要：

```sh
export SYNTHIA_RUNTIME_MODE=core
export SYNTHIA_CORE_URL='http://127.0.0.1:8787'
export SYNTHIA_CORE_TOKEN='<SERVICE_TOKEN>'
export SYNTHIA_TASK_RUNTIME_TOKEN='<TASK_RUNTIME_TOKEN>'
bun run runtime/server.ts
```

真实模型、Connector 和工作目录仍按部署环境配置；`SYNTHIA_TASK_WORKSPACES_DIR` 可覆盖 Core 管理的侧边 clone 根目录。上面的占位符不得替换成提交到仓库的明文秘密。

## 3. Mock 与浏览器验收

```sh
cd web
bun run dev:mock
```

在预置项目工作台完成以下主路径：

1. 保持主任务处于等待/运行状态，打开独立的“探索任务”抽屉；确认主阶段、主对话、当前主任务 ID 和 URL 不改变。
2. 创建带 1～32 个精确写路径的侧边任务；确认状态与对话按 Core 风格事件推进。
3. 在 `awaiting_user` 中补充消息；确认消息只进入侧边对话，主 composer 草稿和主阶段不被覆盖。
4. 打开已完成任务，检查结论、Core 证据化测试、逐文件 diff、base/result/current-target hash 和未采纳标记。
5. 选择无冲突文件做部分采纳；确认只选中的文件变为候选修订，未选文件仍显示未采纳。冲突文件必须禁选，整批冲突不得产生半套状态。
6. 创建一个运行中任务并执行安全停止；确认任务进入终态、既有事件可读，且不污染主任务。
7. 分别在桌面、390 px 和 320 px viewport 重走创建、补充消息、diff 与采纳；页面不得横向溢出，抽屉、文件选择和 composer 必须可操作。
8. 每个 viewport 最后检查 console 与 network；不得有未解释的 error/warning、重复写请求或 side-task 404/5xx。

Mock 只验证交互、响应恢复和客户端契约，不替代真实 PostgreSQL 或 Core↔Runtime HTTP 验证。

### 本地候选浏览器记录（2026-08-21）

| 场景 | 当前证据 | 状态 |
|---|---|---|
| 桌面：独立抽屉、`awaiting_user` 补充、主线/URL 隔离 | 已走通；侧边交互前后主阶段、主任务和 URL 均未切换 | 通过 |
| 桌面：完成结果、测试、diff、冲突禁选、部分采纳、安全停止 | 结果摘要、测试和逐文件 diff 可见；冲突的 `rtl/pwm_gen.v` 禁选；只采纳 `tb/pwm_gen_explore_tb.sv` 后任务变为“部分已采纳”，正式工作区出现新候选；越权约束任务显示“安全停止”且没有可采纳结果 | 通过 |
| 390×844 | `document/body scrollWidth=390`；抽屉边界 `0..390`、关闭按钮可见；主对话 composer 边界 `43..312`，可操作 | 通过 |
| 320×720 | `document/body scrollWidth=320`；抽屉边界 `0..320`、关闭按钮边界 `266..308`；composer 边界 `37.6..242`，可操作 | 通过 |

三个 viewport 的 console 只有 Vite debug 与 mock info，没有 warning/error；未观察到 network 失败。该浏览器记录已经满足本切片 UI 退出项，但仍须与 fresh PostgreSQL、真实双 HTTP 和最终提交验证共同成立，不能单独用于宣布可上手验证。

## 4. Fresh PostgreSQL 与真实 HTTP 验证

### 4.1 Fresh PostgreSQL

每次候选都应创建全新数据库并执行完整迁移，禁止复用被手工修补过的 schema。最小回归：

```sh
DATABASE_URL='<fresh-postgres-url>' bun test \
  core/tests/api-side-tasks.test.ts \
  core/tests/api-tasks.test.ts \
  core/tests/feature-flags.test.ts \
  core/tests/postgres-contract.test.ts

DATABASE_URL='<fresh-postgres-url>' bun test core/tests
```

2026-08-21 的最终候选记录：

- fresh database：`synthia_p3_final_core_0821b`；全部 10 个编号迁移由空库建立；
- P3/API/feature/schema 定点：`78 pass / 0 fail / 808 assertions`；
- 全 Core：`422 pass / 0 fail / 2556 assertions`。

这份记录证明当前工作树的迁移与 Core 路径可在空库建立，不替代最终提交上的复跑。

### 4.2 真实 Core HTTP ↔ Runtime HTTP

验收必须启动真实 Core HTTP 与真实 Runtime HTTP，使用 fresh PostgreSQL 和两枚真实分离的 service token；测试 harness 只能脚本化驱动与断言，不能把任一服务替换为 fake client。模型和 Connector 边界可以使用确定性替身，以保证故障可定位、结果可重复。至少覆盖：

1. Core 先写 main/side task，再完成 Runtime `register → bind → /start`；objective 只派发一次。
2. Runtime 用 `SYNTHIA_TASK_RUNTIME_TOKEN` 回写事件、侧边工作区和结果；用普通 token 调相同路由被拒绝。
3. 合法 task-scoped exploratory job 能走通 submit → status → evidence → content，并逐次核对 project/task/workspace/job/run class。
4. side 普通回复进入 `awaiting_user`，补充消息可继续；显式完成后 Core 密封结果。
5. Core 读取结果与 diff，并由 human token 完成至少一次无冲突的部分采纳。

仓库内可重复入口为 `core/scripts/verify-p3-http.ts`。本地验证命令：

```sh
DATABASE_URL='postgres://synthia_test:synthia_test@127.0.0.1:55432/synthia_test' \
  bun run core/scripts/make-test-db.ts synthia_p3_http_verify

DATABASE_URL='postgres://synthia_test:synthia_test@127.0.0.1:55432/synthia_p3_http_verify' \
  bun run core/scripts/verify-p3-http.ts
```

2026-08-21 在 fresh database `synthia_p3_final_http_0821b` 上的仓库入口复跑结果为 exit 0、`outcome: PASS`：全部 10 个编号迁移由空库建立，44 项检查通过，记录 25 次 task-scoped Core HTTP 调用，Connector submit/status/evidence/content 各 1 次，side model 共 5 次调用。覆盖 main/side `register → bind → /start`、普通/task/mixed token 正反隔离、隔离写入、task-scoped exploratory job、`awaiting_user` 后幂等补充、显式完成与单次密封、Core `tool_run` 测试事实、diff 和 human adoption。side 运行期间 main 保持运行；主工作区在人工采纳前不变，采纳后才产生受控提交。另行 fresh PostgreSQL 定点覆盖 Core-owned abort 的必填键、同键缓存和 Runtime 已接受但响应丢失后的稳定下游键恢复。

## 5. 发布前验证矩阵

在最终候选提交上执行：

```sh
bun test
bun run check:names
bun run check
bunx tsc --noEmit -p runtime/tsconfig.json

cd web
bun test
bun run check
bun run build

git diff --check
```

最终候选代码树的证据如下；拆分提交只改变 Git 边界，不改变文件内容，提交后仍须复核状态与补丁完整性：

| 检查 | 2026-08-21 当前证据 | 判定 |
|---|---|---|
| 仓库无 DB 全量 `bun test` | `985 pass / 301 skip / 0 fail` | 通过 |
| Runtime Connector/workspace/server/stream 定点 | `109 pass / 0 fail / 663 assertions` | 通过；包含 `stream-hub.ts` 与 abort 幂等回归 |
| Web `bun test` | `437 pass / 0 fail / 1993 assertions` | 通过 |
| Web `bun run check` | `vue-tsc --noEmit` 通过 | 通过 |
| Web `bun run build` | 通过，仅有既有 Monaco large-chunk warning | 通过 |
| `bun run check:names` | 通过 | 通过 |
| Core `bun run check` | HEAD 与候选均为 24 条既有错误 | 未新增；不是全绿 |
| Runtime `tsc --noEmit` | HEAD 80 条、候选 70 条 | 未新增；不是全绿 |
| `git diff --check` | 通过 | 通过 |

类型债必须按“基线错误数 + 当前错误数 + 无新增 diff”记录，不能把仍返回非零的 Core/Runtime 命令写成“通过”。本切片对 `runtime/stream-hub.ts` 的分布式联合修正减少了 Runtime 既有错误，但不能因此掩盖剩余 70 条债务。

## 6. 安全与恢复观察点

| 风险 | 当前控制 | 验收时观察 |
|---|---|---|
| task token 越权为普通 Core service | 单一 scope 鉴权不变量、普通/task 两枚 token 分离 | 401/403，且无 workspace/gate/job 副作用 |
| 第二个 service 冒充绑定 Runtime | `runtime_actor_id` + task/agent/workspace headers 与持久化绑定同时核对 | 404 fail-closed，合法 actor 路径仍通过 |
| objective、消息、abort 或 job 重复执行 | Core/Runtime 多层幂等 intent、显式启动屏障、稳定下游键、终态与封存窗口检查 | 响应丢失/重启重放只返回原结果或稳定冲突；取消事实只出现一次 |
| side 改动污染项目主工作区 | 独立 clone、精确 write paths、Core 重新计算 manifest/diff | side 完成前后主 HEAD/文件/revisions 不变 |
| diff 后主线变化被覆盖 | preview hash、expected target hash、项目/文件锁、原子批次 | 任一冲突整批不写，刷新后用新 adoption ID |
| 伪造测试证据 | Core 只汇总精确绑定的 `tool_run` | Runtime 自报 tests 不进入结果或 output hash |
| 功能关闭后事实丢失 | 写入口 503、只读事实保留、迁移只前向 | 旧 task/event/result/adoption 可读取 |

最终安全复核为 `NO BLOCKER`。已知的非阻断尾差是：模型回复已经返回、Runtime 正在提交 assistant/finalization 回调的极窄窗口内收到 Core-owned abort 时，Core 仍由任务行锁与终态检查稳定保持 `cancelled` 且不会密封结果，但 Runtime 本地 handle/SSE 可能短暂显示 `fail_closed` 或在 abort 响应中显示 `idle`；刷新 Core 权威状态后收敛。后续可在 Runtime 的 `.then` finalization 边界显式消费 abort intent，消除这项可观测性尾差。

## 7. 最短回滚

1. 先把 Web 构建开关 `VITE_FEATURE_SIDE_TASKS` 关闭并重新构建，隐藏创建、消息和采纳入口。
2. 把 Core 的 `SYNTHIA_FEATURE_SIDE_TASKS` 设为 `0` 并重启 Core，封禁 side 创建、工作区写入、密封和采纳；保留任务、事件、结果、差异和采纳只读。
3. 停止新的 Runtime side 执行；保留 `.runs/` 作为恢复材料，不把它当成 Core 事实的替代品。
4. 如需回退二进制，恢复上一版 Core/Runtime/Web；保留 `0009_task_workspaces` 表、Git 采纳 commit、任务事实、审计和 outbox 数据。
5. 不删除侧边 clone 以掩盖失败；如按保留策略释放 clone，只把工作区前向标为 `released`，密封结果仍须可读。
6. 验证旧的个人主任务读取路径和项目主工作区仍可用，记录回滚原因、最后一个成功 task/adoption ID 和相关 correlation ID。

禁止通过逆向迁移、删除 P3 事实、重写 Git 历史、复用 combined-scope token 或伪造成功状态来回滚。

## 8. 退出清单与上手时点

P3 第一切片只有同时满足以下条件，才能从“本地候选”进入“可上手验证”：

- fresh PostgreSQL 定点与全 Core 在最终提交上通过；
- 仓库级、Runtime、Web、构建和 diff 检查完成，类型债与切片前基线逐条对比；
- 仓库内真实 Core HTTP ↔ Runtime HTTP 入口完整通过，普通/task token 的正反向隔离都有证据；
- 浏览器桌面、390 px、320 px 的完整创建→对话→结果→diff→部分采纳→安全停止链路通过；
- 变更按 Core persistence、Core API、Runtime、Web 和验证文档拆成可审计提交，且未纳入 `.claude/`、`.edagent/`、`.codex-tmp/`。

在这些退出项完成前，可以由开发者继续做本地验证和补证据，但不能把整个 P3 标为完成，也不能把本切片描述为组织试用就绪。

2026-08-21 最终候选已满足以上退出项，可开始 P3 第一切片的本地上手验证；整个 P3、P4～P7 与组织试用仍不在本次完成声明内。
