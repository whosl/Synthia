# Synthia Self-Evolution M4-E 开发计划 v1

状态：Planning Gate PASS（P0=0，P1=0，P2 文档项已清理）

执行状态：E1/E2/E3 PASS；2026-08-27 独立复审 Core E3、Connector E3 与 B.6 均 P0/P1/P2=0。在专用 PostgreSQL 环境运行的 Core E3 扩展集合为 286 pass / 0 fail，另有 dispatcher trust-plane 12 pass / 0 fail；真实 Windows/Vivado 最终认证仍属于 M4-F。

Leader：主 Agent

独立评审：Reviewer Agent

开发成员：Core/Runtime Agent、Connector Agent

权威需求：`specs/self-evolution-v1.md` 附录 B.1–B.6

前置基线：M4-D R2 Core Gate PASS；本文件不重写附录 B 的冻结合同

## 0. 验收证据更正（2026-08-27）

先前状态行中的“精确 PostgreSQL 集合 296 pass / 0 fail”已撤回。独立审计证明，296 来自未设置 `DATABASE_URL` 时的 286 个具名测试加 10 个匿名 skip 占位；5 个外层 `describe.skipIf(!DATABASE_URL)` 会各为 hook 登记两个 `(unnamed)` skip。真实 PostgreSQL 下不存在这 10 个测试。未发现测试删除、`test.skip`、todo 或内部条件 skip；这是历史计数错误，不是实现覆盖退化。

Leader 在专用 PostgreSQL 上原样复跑以下 Core E3 扩展 8 文件集合，结果为 `286 pass / 0 fail / 2161 expect() calls`。其中 38 个具名测试不依赖 PostgreSQL，但在同一命令和冻结快照中运行：

```bash
DATABASE_URL=<dedicated-gate-db> bun test \
  core/tests/evolution-eval-domain.test.ts \
  core/tests/evolution-eval-api.test.ts \
  core/tests/evolution-eval-postgres.test.ts \
  core/tests/evolution-eval-postgres-invariants.test.ts \
  core/tests/evolution-eval-r2-api.test.ts \
  core/tests/evolution-eval-dispatcher-adversarial.test.ts \
  core/tests/evolution-eval-dispatcher-lifecycle.test.ts \
  core/tests/evolution-eval-sealed-input.test.ts
```

证据绑定到当前 dirty worktree 冻结快照；相关文件尚不在 `HEAD b830e054bca0b3df6cab58f1c4f2e3a6ffab6576` 中，不能用提交历史证明其更早的 registration 数量：

| 测试文件 | 具名测试 | SHA-256 |
|---|---:|---|
| `evolution-eval-domain.test.ts` | 9 | `8c222cc88b684cb9fb6596e5e2c95580d7ae7c145772a508a37b6419a57ba56b` |
| `evolution-eval-api.test.ts` | 11 | `9ccf0d0e226d21c216bb02bc1b95e4f2b8719232392801b4835443942844e369` |
| `evolution-eval-postgres.test.ts` | 4 | `d8eb083714165bbb6cbb2200091b7cc4a493fcc6f33792b3f04a0fbdf8181a73` |
| `evolution-eval-postgres-invariants.test.ts` | 151 | `064231003554e6ab5ea686aaa12b7666b9228aea7505e2dc6e4f5c53cab4db3d` |
| `evolution-eval-r2-api.test.ts` | 19 | `5c15ce6cc2fcea5728a9699fa90c9155c08077ce9dff875b553c0c1553c7b259` |
| `evolution-eval-dispatcher-adversarial.test.ts` | 83 | `77429c36c940c711d48ee73e3e3d80b02854e120074f82eba944c6c888145a53` |
| `evolution-eval-dispatcher-lifecycle.test.ts` | 4 | `13b31b459a897a4f35b78bd76e225def986e76e456e20e829500cdb6fb72a093` |
| `evolution-eval-sealed-input.test.ts` | 5 | `746587680d8686d597598f6821695d60b30a730297299a230b10a8ffcac60d23` |
| **扩展 PostgreSQL 集合** | **286** | — |
| `evolution-eval-dispatcher.test.ts`（独立 trust-plane） | 12 | `65f289c6d05ba50f4c1e776f5fb62b89d7872c644b7befa00c40493fe9437bbb` |

因此 M4-E 当前可复现证据记为扩展 PostgreSQL `286/0` 加独立 dispatcher `12/0`，同一冻结树合计 `298/0`；不得再引用“296 exact PostgreSQL pass”。

## 1. 目标与交付边界

M4-E 只交付 `evolution_eval` 的执行平面：Runtime Evaluator 通过 Core 专用 route 创建、修改并提交隔离 eval workspace；Core 进程内后台 dispatcher 只消费已提交的 typed outbox，在数据库事务外 query/调用 Connector，并由 Core 自身写回受约束结果；Connector 只为四个 allowlisted operation 执行强类型 Vivado 请求并持久保存 same-ID ledger/evidence retention 状态。

M4-E 不能让 Evaluator、Curator 或 Learned Skill 获得 raw Tcl、任意进程、正式项目写、adopt/approve/baseline/publish/download、hardware manager/target/device 或网络能力。`implement` 可以生成试验 `.bit`，但它永久属于 `experimental/evolution_eval + evolution_eval_only`。

本阶段不把 M4-F 的完整真实环境认证混入实现批次。每个 E Gate 仍需通过真实 PostgreSQL 行为测试、故障注入和受影响回归；M4-F 再做真实 Vivado/Connector 部署环境的最终端到端、长时与全量回归。

## 2. 当前基线与合同缺口

| Requirement | 当前证据 | 状态 | M4-E 缺口 |
|---|---|---|---|
| Core eval facts/routes | `0014`–`0016`、`evolution-eval-handlers.ts` | complete（M4-D） | 尚无进程内 outbox dispatcher/Connector 结果处理 |
| Runtime Curator/Scheduler | `runtime/evolution-workers.ts`、`evolution-service.ts` | partial | 没有 Eval client、recovery-first bounded action loop、exact eval refs |
| Connector run class | `connector/index.ts`、`remote.ts`、`vivado.ts` | contradicted | 类型和 discovery 只接受原三类 run class |
| 四 operation 显式能力 | `VIVADO_CAPABILITIES` | contradicted | 当前所有 Vivado operation 广告相同 run classes |
| same-ID durable ledger | `WorkerRuntime` 内存 Map | absent | 重启丢失，缺 dispatch hash/key 查询证明 |
| evidence budget/retention | Connector 64 entries/128 MiB 通用上限 | contradicted | eval 专用 128 entries/256 MiB、2 GiB、ack/quarantine/7d 未实现 |
| cancel/deadline/unknown | Core 已有 intent/facts | partial | Connector 有界 kill、query-first result ingestion 未接通 |
| formal 产物隔离 | Core R2 DB guards | partial | Connector evidence classification 与所有 selector 负例需贯通 |

附录 B 没有冻结后台 dispatcher 的部署位置和多实例 claim 机制。M4-E 冻结为 Core 进程内服务，不新增 HTTP route、bearer scope、Runtime credential 或结果摄入 API：

1. Evaluator 继续只持 exact singleton `core:evolution-eval`；Curator/Evaluator token 不能接触 Connector snapshot、terminal state、evidence bytes 或 retention acknowledgement 的写入接口。
2. Core dispatcher 直接读取 DB outbox、通过扩展后的专用 `EvolutionEvalConnectorPort` 调用 Connector，并通过非 HTTP 的内部 transaction service 写结果。`service:synthia-core-evolution-eval-dispatcher` 只作为 audit actor ID，不是可远程持有的 credential。
3. 多 Core 实例通过独立 `evolution_eval_dispatcher_lease` 表竞争同一 outbox event。claim 事务只操作 lease/outbox 并先 commit；它不同时取得 run/job 锁。fence/settle 事务重新从 `curator_run` 开始按固定锁序取锁，最后才核对 lease/outbox，避免反向锁序。
4. Core 从 DB binding 构造 Connector job ID、idempotency key、dispatch hash、run class、operation、deadline、toolchain、
   `sealed_input_projection_hash` 和 sealed source/constraint bytes；不存在 caller override。projection hash 是完整 durable manifest
   删除 Skill entries 后，对 exact JCS preimage
   `{schema:"evolution-eval-sealed-input-projection.v1",manifest:<source+overlay-only workspace manifest>,files:[{path,sha256,size_bytes,media_type}]}`
   的 SHA-256；dispatch hash 必须覆盖该字段，Connector wire/ledger 只接收并重算 source+overlay projection，任何 Skill wire entry 拒绝。
5. RPC 前后的进程崩溃依靠同 event、同 Connector ID/key/hash reclaim 并 query-first；transport retry 不提前消费 outbox。
6. rollout 默认关闭；即使 E1/E2 组件完成，也要等 E3 evidence/retention Gate PASS 后才能启用真实 M4-E 执行平面。

## 3. Core dispatcher duty 与 Connector 查询合同

dispatcher 只消费以下 exact outbox allowlist，其他 evolution-eval 或 generic event 永不触发 Connector RPC：

| Outbox event | Dispatcher duty | `published_at` 的唯一条件 |
|---|---|---|
| `evolution_eval.dispatch_requested` | same-ID query/preflight、effect fence、submit | job 已 pre-effect rejected/no-op；或 Connector acceptance/terminal 已写 Core，且 effect-possible job 已有 durable reconcile/freeze 后续 intent |
| `evolution_eval.reconcile_requested` | 原 ID/key/hash query | reconciliation 已 confirmed/not_needed，或 job 已 terminal/unknown；transient/ambiguous 保持未发布 |
| `evolution_eval.dispatch_tombstoned` | pre-effect no-op，或 running cancel/query | pre-effect rejected 已确认；或 running 已 cancelled/timeout/unknown；transient 保持未发布 |
| `evolution_eval.evidence.freeze_requested` | 完整 manifest/entries fetch+verify | frozen/corrupt/unavailable_at_deadline 已 durable；transient fetch 保持未发布 |
| `evolution_eval.evidence.ack_requested` | valid manifest ack | acknowledged 或合法 expired 已 durable；transient 保持未发布 |
| `evolution_eval.evidence.quarantine_requested` | 绑定 error fact hash 的 `corrupt_ack` | Connector 已确认 output 不可读 quarantine；未确认时 cleanup 不得越过 |
| `evolution_eval.evidence.cleanup_requested` | query-first physical cleanup | quarantine 前置已满足，且 cleaned/expired 已 durable；否则保持未发布 |

`deadline` 没有虚构的 outbox 类型。Core dispatcher 的权威时钟扫描只选择 `deadline_at<=Core now` 且尚未关闭的 eval run，在统一 run/job 锁事务中幂等物化 B.3 既有 tombstone、reconcile、unavailable/cleanup intents；随后仍由上表 exact events 完成外部收尾。扫描绝不直接 RPC，也不创建新 job。

Connector query 必须返回以下 strict taxonomy，且回显同 job ID/key/dispatch hash/ledger epoch：

- `proven_never_accepted`：健康 durable ledger 已原子保存同 ID/key/hash 的 reservation，并证明尚未接受或执行；只有该 proof 明确携带 `replay_permitted=true` 时才允许原 ID/key/hash submit，若该 ID 已被 durable tombstone 封死则 `replay_permitted=false` 且永不执行；
- `accepted`：已接受，携带 queued/preparing/running metadata；Core 保持 effect-possible `running`，不倒退；
- `terminal`：携带 succeeded/failed/cancelled/timeout 及 `process_stopped=true` 的可验证终局；
- `transient_unavailable`：保持原状态并确保 reconciliation required，不能猜 terminal；
- `ambiguous`：可能接受/执行或无法确认停止；到 definitive failure/deadline 映射 `unknown_effect`；
- `ledger_corrupt`：ledger incomplete/corrupt/epoch mismatch；立即 fail closed，按 B.4 进入 `unknown_effect`，绝不 replay。

普通 `not found` 不是 `proven_never_accepted`。任何异 key/hash/payload/epoch 都是 binding conflict 或 ledger corrupt，永远不能执行。Connector acceptance fact 必须先 durable 再返回；process terminal/stop confirmation 也必须先 durable 再返回。

evidence fetch 使用 Core 管理的有界 ephemeral temp 目录，逐 entry 流式校验 size/hash/media/name/classification 和总 cap。崩溃后 temp 丢弃，reclaim 以同 job ID/hash 重新 fetch。只有完整 manifest、全部 bytes、canonical hash 和 caps 全部通过后，才在一个 Core 事务中写 frozen fact/content/audit/outbox；raw corrupt、partial 和 deadline 后迟到 bytes 永不进入 DB/Core content store，只保留安全 metadata/hash/error。

Core 侧新增独立 `EvolutionEvalConnectorPort`，不把 eval 方法混进 generic `ConnectorPort` 的宽参数：

```ts
interface EvolutionEvalConnectorPort {
  preflight(binding: CoreIssuedEvalBinding): Promise<EvalPreflight>;
  query(binding: CoreIssuedEvalBinding): Promise<EvalLedgerQuery>;
  submit(binding: CoreIssuedEvalBinding, input: SealedEvalInput): Promise<EvalLedgerQuery>;
  cancel(binding: CoreIssuedEvalBinding, reason: EvalCancelReason): Promise<EvalLedgerQuery>;
  fetchEvidenceManifest(binding: CoreIssuedEvalBinding): Promise<EvalEvidenceManifest>;
  fetchEvidenceEntry(binding: CoreIssuedEvalBinding, name: string): Promise<AsyncIterable<Uint8Array>>;
  acknowledgeEvidence(binding: CoreIssuedEvalBinding, manifestHash: string): Promise<EvalRetentionResult>;
  acknowledgeCorrupt(binding: CoreIssuedEvalBinding, errorFactHash: string): Promise<EvalRetentionResult>;
  cleanupEvidence(binding: CoreIssuedEvalBinding, factHash: string): Promise<EvalRetentionResult>;
  querySpool(): Promise<{ unackedBytes: number; hardCapBytes: 2147483648 }>;
}
```

`CoreIssuedEvalBinding` 不是 HTTP DTO；只能由 dispatcher 从 locked DB rows 构造，含原 Connector ID/key/hash、`runClass:"evolution_eval"`、四选一 operation、完整 sealed manifest hash、`sealed_input_projection_hash`、absolute deadline、requested timeout/cap 和 toolchain identity。完整 manifest 仅在 Core 内绑定 Skill；`SealedEvalInput`/Connector remote envelope 只携带 source+overlay-only canonical manifest/files。Connector remote envelope 使用独立 actor ID `synthia-core-evolution-eval-dispatcher`，但复用 Core 管理的 mTLS/endpoint 信任，不向 Runtime 或模型暴露 credential。

结果处理接口同样仅为 Core 内部 transaction service：`claimNextDuty`、`fenceDispatch`、`applyLedgerObservation`、`freezeVerifiedEvidence`、`applyRetentionResult`、`materializeDeadlineIntents`。它们不接受任意目标 state/classification/project/job；只接受已 claim 的 event ID/lease nonce 和 Connector 原始 typed observation，并从 DB 重建 binding 后自行决定合法状态边、classification、audit/outbox 与 publication。

## 4. 固定锁序与外部效果顺序

数据库最后防线沿用附录 B：

```text
curator_run → evolution_eval_run → evolution_eval_job → tool_run
→ dispatch/tombstone/reconcile/evidence fact → dispatcher lease/outbox
```

禁止反向取得 run/job 锁。所有 Connector discover/status/submit/cancel/evidence/ack/cleanup 均在 DB transaction 外执行。

dispatch 的唯一合法时序：

```text
submit route commit sealed dispatch fact/outbox（ToolRun=submitted）
→ Core dispatcher claim committed duty
→ transaction 外 Connector same-ID ledger query + capability/license/spool preflight
→ Core effect fence 短事务：submitted→queued→preparing→running，逐边 audit，commit
→ transaction 外 Connector submit（原 ID/key/hash）
→ Core settle 新事务写 observation/transition/reconcile/unknown
```

dispatcher 在 effect fence commit 后、submit 前崩溃时，新 holder 必须 query-first。ledger 明确 `proven_never_accepted` 才可用原 payload replay；普通 not-found、ledger 损坏、cancel/timeout 不能确认停止或 deadline 后仍不可判定，必须进入 immutable `unknown_effect`。任何响应丢失都不能生成新 Connector job ID。

cancel/tombstone 与 dispatch fence 竞争同一 run/job 锁：tombstone 先提交则 dispatcher no-op；running fence 先提交则 cancel 走同 ID 的 cancel+query，确认停止才 cancelled/timeout，否则 unknown。Pause/rollout off/deadline 不能阻断 recover/cancel/freeze/ack/cleanup。

## 5. E1 — Trust Plane 与协议基座

### 交付

1. 实现 Core 进程内有界 dispatcher、exact event allowlist、DB lease/reclaim、deadline intent scan；不新增远程 result-ingestion API。
2. 新增 forward-only `0017_evolution_eval_dispatcher.sql` 与 fresh schema parity：`evolution_eval_dispatch.sealed_input_projection_hash`、dispatcher lease、append-only Connector observation、temp cleanup ownership；不削弱 `0014`–`0016` guards。
3. 扩展专用 `EvolutionEvalConnectorPort` typed interface；E1 用 fake Connector 验证 post-commit fence、same-ID query taxonomy 和 Core 唯一写状态。
4. Connector 新增独立 evolution-eval wire types、canonical dispatch hash binding、四 operation discovery policy 与 ledger interface；E1 使用 durable fake/file ledger 验证 query-first，不接真实 Vivado。
5. 验证 Evaluator/Core HTTP route 和所有 DB transaction 内 Connector import/call 为零；只有后台 dispatcher 在事务外 RPC。

### 独占文件

- Core/Runtime Agent：新增 `core/src/services/evolution-eval-dispatcher.ts`、`core/src/domain/evolution-eval-dispatcher.ts`、`core/src/db/migrations/0017_evolution_eval_dispatcher.sql`、`core/tests/evolution-eval-dispatcher.test.ts`；E1 不修改 Runtime worker。
- Connector Agent：新增 `connector/evolution-eval.ts`、`connector/evolution-eval-ledger.ts` 及对应 tests；E1 不改 Vivado executor。
- Leader：独占 `core/src/api/connector-port.ts`、`connector-adapter.ts`、`core/src/db/schema.sql`、`core/scripts/serve.ts`、`package.json` 和本计划的窄接线/合并。
- Reviewer：只读审查，不修改实现。

### Gate E1

- exact/mixed-scope、Evaluator/Curator token 互用、Evaluator 伪造 Connector result 全部负例；不存在 consumer HTTP route；
- lease claim/reclaim/旧 lease、outbox commit-before-claim、claim-vs-settle、pre-fence crash、post-fence pre-RPC crash、response-lost、dispatch-vs-tombstone、deadline-vs-dispatch 并发/死锁；
- fake ledger 覆盖完整 query taxonomy；只有 `proven_never_accepted` 可 same-ID replay，无 blind redispatch；
- migration/fresh parity、M4-D R1/R2 回归、P0/P1=0。

## 6. E2 — Connector 执行、恢复与强制停止

### 交付

1. `JobRequest.runClass`、remote discovery、Worker、Vivado typed request 全链精确支持 `evolution_eval`。
2. discovery 只有 `validate_sources|simulate|synthesize|implement` 逐项广告 `evolution_eval`；discover/query/report 等其他 operation 明确不得广告。
3. eval request 为独立 strict union；外层/内层 operation、run class、project/job/dispatch/projection hash、part/toolchain/deadline exact，
   Connector 对 source+overlay-only manifest/files 重算 `sealed_input_projection_hash`，Skill entry、未知字段、raw Tcl/command、hardware、formal/gate、publish/download/project path/write 全部拒绝。
4. Connector ledger 持久化 same job ID + idempotency key + dispatch hash + acceptance/effect/process/terminal/evidence/retention facts，原子落盘并可在 Worker 重启后 query-first。
5. Connector 以 `min(requested_timeout,2h cap,absolute deadline-now)` 执行；实现有界 process-tree cancel/timeout，只有确认停止才报告 cancelled/timeout。
6. Core dispatcher 完成 capability/license/spool preflight、dispatch、reconcile、cancel、deadline 和 unknown mapping；Core 保持唯一 ToolRun writer。
7. Connector 落盘前重验 source/constraint/path/type和分层/总 workspace预算；全局未 ack eval spool 达 2 GiB 时 fail closed。
8. Runtime 新增 bounded Evaluator：模型每轮严格返回 `run_eval|finalize`；`run_eval` 一次只允许一个四选一 typed job，Host 经附录 B route 执行并在 evidence 决议后再进入下一轮，最多 3 job。dry-run、`eval_input_ref=null`、deadline/unknown latch 时只能 finalize；最终 complete 自动携带 DB recovery/status 对应的全量 exact `eval_job_refs`。

### 独占文件

- Connector Agent：`connector/index.ts`、`remote.ts`、`worker.ts`、`server.ts`、`vivado.ts`、`http.ts` 及同名 tests，延续独占 E1 新模块。
- Core/Runtime Agent：延续独占 Core dispatcher/domain/migration；新增 `runtime/evolution-eval-client.ts`、`runtime/evolution-evaluator.ts` 及其 tests，并在明确 ownership 窗口内修改 `runtime/evolution-worker-client.ts`、`evolution-workers.ts`。
- Leader：独占 `runtime/evolution-service.ts`、`core/src/api/connector-port.ts`、`connector-adapter.ts` 的窄生命周期/port 接线和共享配置文件；其他人不得同时改这些文件。

### Gate E2

- 四 operation 正例和所有其他 operation/class 组合负例；raw Tcl/hardware/project-write/Skill-script execution 负例；
- Connector 重启 ledger 保留、同 ID 同 hash replay、同 ID 异 hash拒绝、submit response lost、status unavailable、ledger corrupt/lost；
- cancel 前/执行中/已终态、deadline 前后、无法确认 kill→unknown、unknown latch 禁止后续 job；
- bounded `run_eval|finalize`、recovery-first、exact eval refs、dry-run/evidence-only/无 eval input；
- 3 job/serial/2h、source 4096/512 MiB、Skill/overlay 512/32 MiB、workspace 5120/576 MiB、read/write 8 MiB、spool 2 GiB；
- 强制停止后无 orphan process、无 project workspace 写；P0/P1=0。

## 7. E3 — Evidence、留存与权威产物隔离

### 交付

1. Connector eval 专用 evidence 限额：最多 128 entries、单 entry 64 MiB、单 job 256 MiB；普通 run class 继续使用既有限额，不做全局放宽。
2. terminal job 的 manifest/entry 在 Core ephemeral temp 中完整 fetch、canonical verify，通过后直接 atomic freeze；partial/hash/name/media/limit/drift 才 corrupt，transport failure 保持 freeze_pending+required。
3. Core frozen 后发送同 manifest hash valid ack；Connector ack 后才正常 cleanup。`corrupt_ack` 进入不可读 quarantine，24h 内删除；所有 output terminal+7d 绝对删除。
4. 2h cutoff 未完整 frozen 永久 `unavailable_at_deadline`；迟到 bytes 只能 cleanup，不能升级 evidence 或评价。
5. ack/quarantine/expired/cleanup 均 query-first、same-ID、outbox 可重放；Core run 完成不等待后台 ack/cleanup。
6. `.bit` classification 双字段固定；formal/gate/baseline/release/delivery/publish/hardware selectors 同时要求 formal run class 并排除 eval classification。
7. ACL/redaction 与 trace chain：Curator evaluation → eval job/tool run → frozen manifest/entries/hash 可验证；终态 Evaluator route 永久关闭。

### 独占文件

- Connector Agent：延续独占 Connector ledger/evidence/worker/remote 文件及 tests。
- Core/Runtime Agent：延续独占 Core dispatcher/eval handler/domain/schema migration与 Runtime Evaluator tests；新增 evidence/retention integration tests。
- Leader：独占 formal selector 高冲突文件（`core/src/api/p4-handlers.ts` 等）做最小双重拒绝补丁并运行全量回归。

### Gate E3

- 128/64 MiB/256 MiB、2 GiB、完整/partial/hash/name/media/canonical drift；
- freeze commit 前后 crash、ack response lost/replay、corrupt_ack quarantine、24h、7d、2h unavailable、迟到 bytes；
- unknown/corrupt/unavailable 强制 `inconclusive + no_op`，Curator fail 不能绕过；
- trial `.bit` 不进入 formal/gate/baseline/release/delivery/publish/download/hardware；
- rollout off/Pause/终态 run 后仅后台 retention duty 可运行；P0/P1=0。

## 8. 审核节奏与开发编排

每批遵循同一闭环：

```text
Leader 冻结当批接口/文件 ownership
→ 两名开发成员在独占文件并行实现
→ Leader 做 diff/边界/测试初审
→ Reviewer 独立列 P0/P1/P2
→ 原开发成员修复 P0/P1
→ Reviewer 复验并签署 Gate
→ Leader 批准进入下一批
```

Reviewer 在每批中点额外审查一次，优先捕获身份越权、持锁 RPC、blind redispatch、错误 terminal 映射和 evidence 晋升错误。P0/P1 不清零不进入下一 Gate；P2 必须写明延期到 M4-F/M5 的理由且不能破坏本批安全合同。

## 9. 验证命令

每批至少运行：

```bash
bun test core/tests/evolution-eval-domain.test.ts \
  core/tests/evolution-eval-api.test.ts \
  core/tests/evolution-eval-postgres.test.ts \
  core/tests/evolution-eval-postgres-invariants.test.ts \
  core/tests/evolution-eval-r2-api.test.ts \
  core/tests/evolution-eval-dispatcher.test.ts
bun test connector
bun test runtime/evolution-eval-client.test.ts \
  runtime/evolution-evaluator.test.ts \
  runtime/evolution-service.test.ts
bun run check
bunx tsc --noEmit -p runtime/tsconfig.json
```

配置临时 PostgreSQL 后运行 migration/fresh parity、并发 barrier、crash/restart suites。E3 最终再运行：

```bash
bun test
(cd web && bun test)
(cd web && bun run check && bun run build)
```

发布前升级前置：M4-E execution plane 在 `0017` 前从未发布且 rollout 默认关闭，因此升级库的
`evolution_eval_dispatch` 必须为空。`0017` 在新增不可回填的 `sealed_input_projection_hash` 前显式检查该条件，
发现旧行时以 `M4E_0017_REQUIRES_EMPTY_PRE_RELEASE_EVOLUTION_EVAL_DISPATCH` fail closed。不得为旧行补造 projection hash
或重签 `dispatch_request_hash`；发布清单必须要求人工清除整套未发布 M4-E 开发状态或重建环境后再迁移。

若当前工作树仍有已知历史 type diagnostics，验收必须证明 M4-E 涉及文件零新增诊断，并记录完整命令的基线差异；不得用跳过相关测试代替。

## 10. 明确不包含项

- 不执行 Learned Skill 的 `.tcl/.py/.ts`；M5 sandbox 之前仍是只读说明资产。
- 不提供 raw Tcl、shell、任意进程、网络、hardware programming/download。
- 不向 Evaluator 增加 generic project/job/workspace/evidence route，也不保留终态历史读取后门。
- 不实现 M5 的人工 unknown resolution、人工 evaluation supersede、历史 evidence content UI。
- 不改变 7 天 Curator 周期、2h run budget、最多 3 job、串行 ordinal 或 dry-run 零 eval job 合同。
- 不把 eval `.bit` 采用为正式产物，不写回项目副本。
- 不在 M4-E 宣称真实 Vivado 全环境 Gate F 完成；该最终认证属于 M4-F。
