# M4-F Canary Project 与 Binding 引导

该流程在真实 `reserve → restart → certify` 之前，为每个 Self-Evolution 场景创建唯一的
free project，并让 Core 签发 Connector 可严格解析的 canary binding。项目和 binding 的
写入只经过 Core HTTP API；脚本不直连 PostgreSQL、不连接 Connector、不执行 Vivado。

Canary 是认证探针，不是 Curator 业务 job：Core 把 deadline 固定为已经过去的
`2000-01-01T00:00:00.000Z`。Connector 的 `reserve/query` 仍可证明 ledger 的
never-accepted 与跨进程 reopen；任何人即使误把该 binding 交给 `submit`，也会在 spool、
workspace、进程或 Vivado effect 之前因 timeout 被拒绝。

## 一库一场景

`success` 与 `failure-quarantine` 必须分别使用以下全部独立资源：

- 名称以 `synthia-selfevo-gate-` 开头的数据库；
- identity bootstrap 生成的六枚 token；
- canary project ID 与 canary binding 文件；
- Connector active config、唯一 `project_scope` 和 ledger/spool；
- reservation receipt 与 B v2 certification。

不要在同一数据库创建两个场景。Core 的签发 API要求数据库中恰好有一个 active free
project、没有 application/Curator/distillation/eval-job 业务状态，并将
`database_name + gate_id + scenario + project_id + part + toolchain profile` 一起纳入
binding 身份。数据库只允许一条 append-only canary issuance；同一请求可安全重放，
任何字段变化都返回 409。

## 准备数据库与身份

对两个数据库分别迁移、分别引导 token。下面只展示 success；failure 数据库重复执行，
不要复制 success 的 token：

```bash
DATABASE_URL='postgresql://<user>@<host>:<port>/synthia-selfevo-gate-success-<gate>' \
bun run db:migrate

DATABASE_URL='postgresql://<user>@<host>:<port>/synthia-selfevo-gate-success-<gate>' \
bun run bootstrap:self-evolution:gate
```

将一次性输出保存在受管秘密环境中，不写入仓库、命令日志或证据文件。

## 以 rollout 关闭状态启动本机 Core

先启动只服务 bootstrap API 的本机 Core。此时不要提供 B v2，不要打开 dispatcher host、
new effects 或 Self-Evolution rollout：

```bash
DATABASE_URL='postgresql://.../synthia-selfevo-gate-success-<gate>' \
PORT='8787' \
SYNTHIA_FEATURE_SELF_EVOLUTION='0' \
SYNTHIA_FEATURE_EVOLUTION_EVAL_DISPATCHER_HOST='0' \
SYNTHIA_FEATURE_EVOLUTION_EVAL_EXECUTION='0' \
bun run core/scripts/serve.ts
```

签发路由要求 human identity 且 token 含 `core:admin`；普通 write service、Evaluator、
Curator 和 Runtime token 均不能调用。

## 创建项目并签发 binding

输出路径必须在仓库外且尚不存在。`SYNTHIA_M4F_TOOLCHAIN_PROFILE_HASH` 使用本次冻结
release/toolchain profile 的 64 位小写 SHA-256；后续 Worker config、toolchain
attestation、B v2 和业务场景必须使用同一个值。

```bash
DATABASE_URL='postgresql://.../synthia-selfevo-gate-success-<gate>' \
SYNTHIA_CORE_URL='http://127.0.0.1:8787' \
SYNTHIA_M4F_CANARY_BOOTSTRAP_AUTHORIZATION='I_AUTHORIZE_M4F_CANARY_BOOTSTRAP' \
SYNTHIA_M4F_CANARY_SCENARIO='success' \
SYNTHIA_M4F_GATE_ID='<exact-success-gate-id>' \
SYNTHIA_M4F_CANARY_PROJECT_ID='<unique-success-project-id>' \
SYNTHIA_M4F_TARGET_PART='xc7k70tfbv676-1' \
SYNTHIA_M4F_TOOLCHAIN_PROFILE_HASH='<64-lowercase-hex>' \
SYNTHIA_M4F_E2E_HUMAN_TOKEN='<success-db-human-admin-token>' \
SYNTHIA_M4F_CANARY_BINDING_OUTPUT='/absolute/outside/repository/success-canary-binding.json' \
bun run bootstrap:self-evolution:m4f-canary
```

脚本依次执行：

1. `POST /api/v1/projects`，使用稳定 Idempotency-Key 创建或重放唯一项目；
2. `GET /api/v1/projects/:id`，回读并核对 project type、part、profile 和 active 状态；
3. `POST /api/v1/evolution/m4f-canary-bindings`，由 Core 生成并保存 binding；
4. 严格解析 Core 返回值，以 exclusive create、`0600`、`fsync` 写出 binding-only JSON。

stdout 只包含数据库、Gate、场景、项目、binding hash、文件 hash和输出路径，不包含 token。
若输出文件已存在，脚本拒绝覆盖；选择新的空证据路径重放同一请求即可取回同一个 binding。

对 failure 数据库重复执行，并同时更换：数据库、六枚 token、scenario、Gate ID、project ID、
输出文件。CLI不会批量创建两套资源，避免调用者误以为两套资源共享同一进程配置。

## 接入 B v2

停止 bootstrap Core。将该文件作为认证 CLI 的：

```text
SYNTHIA_M4F_CANARY_BINDING=/absolute/outside/repository/<scenario>-canary-binding.json
```

随后对该场景自己的 database、Connector config 和 ledger依次执行
`preflight → reserve → 外部显式重启 Worker → certify`。Certification CLI 会在只读事务中
重新读取 append-only issuance，核 binding 全量 canonical bytes、binding hash、project、
database identity 后，才允许远端 reserve/query。B v2 会再次绑定 database identity、
canary binding、receipt、post-restart process instance 与 active config。

完成 success B 后不要把它用于 failure；failure 必须从自己的 binding 重新产生 receipt 和 B。
任何失败或 UNKNOWN 证据保持冻结，不通过删除 issuance、项目或 ledger 重新包装为成功。
