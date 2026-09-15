# M4-F Self-Evolution 真实闭环 Runner

`run-self-evolution-m4f-e2e.ts` 只覆盖两个有边界的生产链路验收：

1. `success`：真实任务自动封存 Episode，Runtime Distiller 自动创建 Skill；后续独立任务搜索、查看、采用并关闭该 Skill；Runtime Curator 经 Core dispatcher 和 Connector 调用真实 Vivado 综合，冻结证据后把版本从 `active_unproven` 晋级为 `active_observed`。
2. `failure-quarantine`：同一新 Skill 版本被三个独立任务采用；Curator 串行运行三个可归因的真实 Vivado 综合失败，最终验证 `active_unproven → needs_review → degraded → quarantined`。模型返回的 remediation 固定为 `no_op`，所以隔离只能来自 Core 的失败次数状态机，不能用 Curator 直接要求 quarantine 来冒充。

隔离状态成立后，`failure-quarantine` 还会新建一个独立的负例任务：搜索结果中不得再出现该版本；即使提交一条与任务事件精确绑定的再次采用请求，Core 也必须以 `409 conflict / SKILL_NOT_AVAILABLE / retryable=false` 拒绝。Runner 会在请求前后比对该版本的 eval-job、dispatch、Vivado ToolRun 和 Connector durable observation 完整身份列表；任何新增或变化都使验收失败。这里能证明正式 Core→Connector 路径没有新增 Vivado 执行；它不替代 Windows 侧进程/ledger 的最终归档核对。

Runner 不直接写 PostgreSQL，不导入 Connector/Vivado adapter，也不执行 Tcl。所有写入都经过现有 Core HTTP 路由；Distiller、Curator 和 `EvolutionEvaluator` 使用现有 Runtime 类。PostgreSQL 连接只执行 `BEGIN TRANSACTION READ ONLY`，用于启动前隔离检查、回执收敛等待和结束后的证据汇总。Runner 复用 B v2 已认证的 canary project，不会再创建第二个项目。

## 前置条件

- 每个场景使用一个单独的、已迁移数据库，名称必须以 `synthia-selfevo-gate-` 开头。不要在包含业务数据的数据库运行。
- Core 必须通过 `core/scripts/serve.ts` 启动，并启用 Self-Evolution、side task、evolution-eval dispatcher host 和 new effects。
- Core 必须加载当前 Gate 对应的 release manifest、真实 Windows toolchain attestation、F0 certification B v2、active Connector config 和 canary binding。
- Windows Worker 必须处于认证后的 `reopen` 模式；`evolution_eval_enabled=true`；Connector 公网 endpoint 仍为认证中的精确 origin；`project_scope` 必须且只能包含 B v2 的 `canary.project_id`。
- 普通任务 Runtime 必须使用 `runtime/m4f-e2e-service.ts`：它保留真实 RuntimeServer、Core 客户端、task token 回调和任务状态机，只把对话模型固定为“不调用工具并进入 awaiting_user”。每个场景使用仓库外的全新空 runs 目录。
- 执行期间不得同时运行另一个 `runtime:evolution` 服务或其他会领取同一 Gate DB evolution lease 的 worker。用 `SYNTHIA_M4F_E2E_EXCLUSIVE_WORKERS=1` 表示操作者已经确认这一点。
- Curator 与 Evaluator 使用两个不同、单 scope 的 service token。Runner 会通过正式 role-assignment API给二者授予 fixture 项目 ACL。
- F0 certification 默认只有 10 分钟有效期，toolchain attestation 最长 4 小时；应先完成 Windows ceremony，再立即运行 preflight 和 execute。执行前剩余有效期必须严格大于“串行 Vivado job 数 × 单 job 超时 + Runtime 就绪超时 + 120 秒安全余量”。

Runner 不会清理数据库、项目、Connector ledger 或 Windows spool。失败后保留现场；重新运行必须换新的 Gate 数据库/`RUN_ID`，不能通过删除事实“修好”场景。

## Fresh DB 与正式身份引导

两个场景各自创建并迁移一套空数据库；数据库角色必须能创建迁移所需的
`pgcrypto` 和 `pg_trgm` extension。以下命令只展示变量名，不要把密码或输出的
token 写进仓库、shell history 或共享日志：

```bash
DATABASE_URL='postgres://<user>@<host>:<port>/synthia-selfevo-gate-success' \
bun run db:migrate

DATABASE_URL='postgres://<user>@<host>:<port>/synthia-selfevo-gate-success' \
bun run bootstrap:self-evolution:gate
```

bootstrap 只允许在名称以 `synthia-selfevo-gate-` 开头的数据库运行，输出 Runner
和普通任务 Runtime 需要的六个环境变量；其中 `SYNTHIA_CORE_TOKEN` 只供 Runtime
读取项目事实，Runner 本身仍只接收其余五枚 token。明文 token 只显示一次；重复
运行视为轮换，会吊销这六个身份已有的有效 token。`synthia-runtime` 同时是 Core 默认的
`SYNTHIA_RUNTIME_ACTOR_ID`；如果 Core 显式设置该变量，值必须仍与该 uid 一致。

对 `failure-quarantine` 数据库重复上述两步，并单独保管它生成的六枚 token。
两套数据库的 token、B v2 certification 和 canary binding 不能交叉复用。

身份引导完成后，按
`core/scripts/bootstrap-evolution-eval-canary-m4f.md` 在 rollout 全关的本机 Core 上，
通过公开 HTTP API 为该数据库创建唯一 canary project 并签发 binding。不得手写
`evolution_eval_job`/`evolution_eval_dispatch` 或复制另一场景的 binding；认证 canary 是
独立的 append-only issuance，不冒充 Curator 业务 job。完成 binding 后停止 bootstrap
Core，再以它执行本场景自己的 `reserve → restart → certify` 并生成 B v2。

## Core 生产 Gate 启动

Core 必须在同一个 Gate 数据库上加载完整 B v2、唯一 canary binding 和 18443 直连 mTLS 凭据。以下变量均为必需项；路径使用本机绝对路径，两个 endpoint 变量必须是与 certification 完全一致的 `https://100.96.223.49:18443`：

```bash
DATABASE_URL='postgres://.../synthia-selfevo-gate-success' \
PORT='8787' \
SYNTHIA_RUNTIME_URL='http://127.0.0.1:8790' \
SYNTHIA_FEATURE_SIDE_TASKS='1' \
SYNTHIA_FEATURE_SELF_EVOLUTION='1' \
SYNTHIA_FEATURE_EVOLUTION_EVAL_DISPATCHER_HOST='1' \
SYNTHIA_FEATURE_EVOLUTION_EVAL_EXECUTION='1' \
SYNTHIA_M4F_GATE_ID='m4f-20260828-success' \
SYNTHIA_M4F_RELEASE_MANIFEST='/absolute/path/release-manifest.json' \
SYNTHIA_M4F_F0_CERTIFICATION='/absolute/path/f0-certification.json' \
SYNTHIA_M4F_F0_CERTIFICATION_SHA256='<sha256>' \
SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION='/absolute/path/toolchain-attestation.json' \
SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION_SHA256='<sha256>' \
SYNTHIA_CONNECTOR_CONFIG='/absolute/path/worker-66.config.json' \
SYNTHIA_M4F_CANARY_BINDING='/absolute/path/canary-binding.json' \
SYNTHIA_M4F_ENDPOINT_URL='https://100.96.223.49:18443' \
SYNTHIA_M4F_ENDPOINT_ALLOWED_ORIGIN='https://100.96.223.49:18443' \
SYNTHIA_M4F_DIRECT_MTLS_AUTHORIZATION='I_AUTHORIZE_M4F_18443_DIRECT_MTLS' \
SYNTHIA_M4F_DIRECT_MTLS_CA_PATH='/absolute/secret/path/ca.pem' \
SYNTHIA_M4F_DIRECT_MTLS_CA_SHA256='<sha256>' \
SYNTHIA_M4F_DIRECT_MTLS_CLIENT_CERT_PATH='/absolute/secret/path/client.pem' \
SYNTHIA_M4F_DIRECT_MTLS_CLIENT_CERT_SHA256='<sha256>' \
SYNTHIA_M4F_DIRECT_MTLS_CLIENT_KEY_PATH='/absolute/secret/path/client-key.pem' \
SYNTHIA_M4F_DIRECT_MTLS_CLIENT_KEY_SHA256='<sha256>' \
bun run core/scripts/serve.ts
```

CA、client cert 和 client key 必须是三个不同的普通文件，归当前用户所有，权限为 `0600`，内容与对应 SHA-256 完全一致。Connector config 必须声明 `transport_mode=direct_https`、`auth_mode=mtls`、`tls_trust_ref=cert://m4f-direct/trust`、`tls_client_cert_ref=cert://m4f-direct/client`。Core 启动时会重新验证 certification、canary binding、mTLS 材料和 Worker 身份；验证失败时 new effects 不会生效。不要把 mTLS 私钥、token 或认证产物提交进仓库。

`certify-evolution-eval-m4f.ts` 的 preflight、reserve、certify 三个阶段在精确 origin 为 `https://100.96.223.49:18443` 时也使用上述同一组受审 mTLS 文件约束和严格 direct transport，不再走 Cloudflare Service Token。TLS 服务端证书校验始终开启，代码没有 `servername` 覆盖、hostname bypass 或关闭校验的入口。由于 endpoint 使用 IP，Windows 旁路服务端证书必须包含精确的 `iPAddress SAN=100.96.223.49`；只有 DNS SAN 或 CN 不足以通过生产认证，禁止通过弱化 TLS 规避。

## 确定性普通 Runtime

Core 启动时把 `SYNTHIA_RUNTIME_URL` 指向本机 Runtime；然后使用同一 Gate DB 引导出的
ordinary Core token 与 task Runtime token 启动专用服务。`SYNTHIA_RUNS_DIR` 必须在仓库外，
且启动时不存在或为空：

```bash
SYNTHIA_RUNTIME_MODE='core' \
SYNTHIA_FEATURE_SELF_EVOLUTION='1' \
SYNTHIA_CORE_URL='http://127.0.0.1:8787' \
SYNTHIA_CORE_TOKEN='...' \
SYNTHIA_TASK_RUNTIME_TOKEN='...' \
SYNTHIA_RUNTIME_PORT='8790' \
SYNTHIA_RUNS_DIR='/absolute/outside/repository/m4f-success-runs' \
SYNTHIA_M4F_E2E_DETERMINISTIC_RUNTIME='I_ASSERT_M4F_DETERMINISTIC_RUNTIME_FIXTURE' \
bun run runtime:self-evolution:m4f
```

服务只接受 `free` 项目、只连接精确 loopback HTTP Core origin，并拒绝关闭治理、复用
两种 token 或加载非空 runs 目录。固定模型不会调用 Skill、Vivado 或其他工具；Runner
随后仍通过正式 Runtime/Core task 状态机观察任务进入 `awaiting_user`。

## 只读预检

默认模式是 `preflight`，不会创建项目、任务、Skill、Curator run 或 Connector effect。它会只读访问本机 Core、Runtime、Gate 数据库和 Connector config 文件，但 Runner 自身不会调用远端 Connector：

```bash
DATABASE_URL='postgres://.../synthia-selfevo-gate-success' \
SYNTHIA_M4F_GATE_ID='m4f-20260828-success' \
SYNTHIA_M4F_E2E_RUN_ID='success-20260828-01' \
SYNTHIA_M4F_E2E_SCENARIO='success' \
SYNTHIA_CORE_URL='http://127.0.0.1:8787' \
SYNTHIA_M4F_E2E_RUNTIME_URL='http://127.0.0.1:8790' \
SYNTHIA_M4F_E2E_HUMAN_TOKEN='...' \
SYNTHIA_TASK_RUNTIME_TOKEN='...' \
SYNTHIA_EVOLUTION_DISTILLER_TOKEN='...' \
SYNTHIA_EVOLUTION_CURATOR_TOKEN='...' \
SYNTHIA_EVOLUTION_EVALUATOR_TOKEN='...' \
SYNTHIA_M4F_RELEASE_MANIFEST='/absolute/path/release-manifest.json' \
SYNTHIA_M4F_F0_CERTIFICATION='/absolute/path/f0-certification.json' \
SYNTHIA_M4F_F0_CERTIFICATION_SHA256='<sha256>' \
SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION='/absolute/path/toolchain-attestation.json' \
SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION_SHA256='<sha256>' \
SYNTHIA_CONNECTOR_CONFIG='/absolute/path/worker-66.config.json' \
bun run core/scripts/run-self-evolution-m4f-e2e.ts
```

preflight 和 execute 都强制提供并严格解析以下完整 B v2 六项；缺一项即拒绝：

```text
SYNTHIA_M4F_RELEASE_MANIFEST
SYNTHIA_M4F_F0_CERTIFICATION
SYNTHIA_M4F_F0_CERTIFICATION_SHA256
SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION
SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION_SHA256
SYNTHIA_CONNECTOR_CONFIG
```

预检要求：

- Self-Evolution 未暂停、Learned Skills 已启用，dispatcher host、new effects 和 rollout 在 Core 中真实生效；
- Core 当前加载的 certification hash、到期时间、`https://100.96.223.49:18443` endpoint、canary project、Connector、Worker instance、ledger epoch 和 active config 与 B v2 完全一致；
- Runtime `/tasks` 可访问且全新 runs 目录中没有任务；
- Gate 数据库恰好存在一个项目，而且就是 B v2 canary project；该项目必须是 active free project，part/profile 与 B v2 一致；
- 本地 Connector config 必须是 `direct_https`/`mtls`、使用受控 direct-mTLS trust/client refs、处于 `reopen`、已启用 evolution eval，并且唯一 `project_scope` 就是 canary project；
- 五个 token 身份/单 scope 正确；除 certification canary 自身以外，没有 queued/running distillation、queued/running Curator、pending application 或未关闭 eval run。

## 明确授权后执行

在预检环境基础上提供完整 B v2 六项，并增加：

```bash
SYNTHIA_M4F_E2E_MODE='execute' \
SYNTHIA_M4F_E2E_EFFECTS_AUTHORIZATION='I_AUTHORIZE_M4F_SELF_EVOLUTION_EFFECTS' \
SYNTHIA_M4F_E2E_EXCLUSIVE_WORKERS='1' \
SYNTHIA_M4F_E2E_DETERMINISTIC_RUNTIME='I_ASSERT_M4F_DETERMINISTIC_RUNTIME_FIXTURE' \
SYNTHIA_M4F_E2E_SUMMARY_OUTPUT='/absolute/outside/repository/m4f-success-summary.json' \
bun run core/scripts/run-self-evolution-m4f-e2e.ts
```

`SYNTHIA_M4F_E2E_SUMMARY_OUTPUT` 必须在仓库外且不存在；Runner 使用 exclusive create 和 `fsync`，不会覆盖既有证据。

失败隔离场景把场景和独立数据库改为：

```text
DATABASE_URL=.../synthia-selfevo-gate-failure
SYNTHIA_M4F_E2E_SCENARIO=failure-quarantine
SYNTHIA_M4F_E2E_RUN_ID=failure-20260828-01
```

可选参数：

- `SYNTHIA_M4F_E2E_TARGET_PART`：默认 `xc7k70tfbv676-1`，必须与 B v2 完全一致。
- `SYNTHIA_M4F_E2E_RUNTIME_URL`：默认 `http://127.0.0.1:8790`，只接受精确 loopback HTTP origin。
- `SYNTHIA_M4F_E2E_JOB_TIMEOUT_MS`：`success` 单个 typed Vivado job 默认 180000，范围 10000..7200000；`failure-quarantine` 固定为 90000，不能覆盖。
- `SYNTHIA_M4F_E2E_POLL_INTERVAL_MS`：Evaluator 查询间隔，默认 1000，范围 10..60000。
- `SYNTHIA_M4F_E2E_RUNTIME_READY_TIMEOUT_MS`：Runtime 任务就绪上限，默认 30000，范围 1000..300000。
- `SYNTHIA_M4F_E2E_RETENTION_TIMEOUT_MS`：等待 Connector acknowledgement/cleanup durable receipts 的上限，默认 120000，范围 10000..600000。

B v2 的剩余有效期必须严格大于：

```text
(success 为 1、failure-quarantine 为 3) × SYNTHIA_M4F_E2E_JOB_TIMEOUT_MS
+ SYNTHIA_M4F_E2E_RUNTIME_READY_TIMEOUT_MS
+ 120000
```

## 验收输出

成功 summary 至少包含：

- Gate/database/B v2/Worker instance/Connector/ledger epoch 身份；
- 自动沉淀的 version ID；
- application、Curator evaluation、eval job、ToolRun 和 frozen evidence manifest 对应关系；
- Skill 最终质量状态；
- 原项目执行前后 commit，并要求完全相同。

`success` 必须是一个 application、一个 `synthesize/succeeded` 真实 eval job、一个 evaluation，并留下 `active_unproven → active_observed` lifecycle edge。`failure-quarantine` 必须是三个独立 application、三个串行 `synthesize/failed` 真实 eval job、三个 `execution_failure` evaluation，并留下 `active_unproven → needs_review → degraded → quarantined` 三段 lifecycle edge。生命周期按 `from_projection → to_projection` 重建唯一链，不依赖同一事务内不可靠的时间戳/UUID 顺序；分叉、断链或循环均失败。

`failure-quarantine` 的 summary 还必须包含 `quarantine_negative_proof`：`search_absent/apply_rejected/zero_new_eval_jobs/zero_new_vivado_tool_runs/zero_new_connector_observations` 全为 `true`，前后各类计数和 `effect_snapshot_hash` 完全相同，且拒绝事实为 `SKILL_NOT_AVAILABLE`。缺少这一段不能宣称失败隔离闭环已打通。

每个 evaluation 必须精确引用同一 application 的 eval job、ToolRun 和 frozen manifest。每个 job 还必须形成完整 durable retention 链：`frozen → ack_pending → acknowledged → cleanup_pending → cleaned`，并且恰好具有一个 `acknowledgement/acknowledged` 和一个 `cleanup/cleaned` Connector receipt，其 authorization/fact hash 均有效。任一 job 缺冻结事实、确认回执或清理回执，Runner 都会失败，不会给出通过 summary。

该 summary 绑定 Core/PostgreSQL 事实和 B v2 Connector 身份；最终 Gate F 报告仍需同时归档 Windows/Vivado 原始输出与 Connector durable ledger/manifest，不能只拿本 JSON 宣告完整生产认证通过。
