# Synthia Self-Evolution v1 开发计划

状态：已冻结（Gate A PASS）
Leader：主 Agent
独立评审：Reviewer Agent
权威需求：`specs/self-evolution-v1.md`

## 1. 交付策略

采用可运行纵切片逐步扩展。每个里程碑都必须保留 Core 治理边界、不可变事实和关闭开关，不能用 mock、
文档或 UI 壳代替真实实现。当前 dirty worktree 是既有成果；不重置、不覆盖，优先新增模块并对高冲突文件
做窄补丁。

```text
Episode → Distiller → active_unproven Skill → search/view/apply/close
                                            ↓
                                  Curator evaluation → lifecycle/metrics → UI
```

## 2. 基线（2026-08-26）

- 根测试：636 pass，339 skip，0 fail；PostgreSQL 行为测试因未配置 `DATABASE_URL` 跳过。
- Web 测试：437 pass，0 fail；`vue-tsc` 和 Vite build 通过。
- `bun run check` 与 Runtime tsc 在当前未提交 Project Agent/P4 改动上有历史类型错误；开发验收要求
  self-evo 相关文件零错误且不增加既有诊断，最终集成另行处理基线错误。
- 高冲突文件：`core/src/db/schema.sql`、`core/src/api/router.ts`、`runtime/server.ts`、
  `web/src/views/ProjectView.vue`、`web/src/api/index.ts`、`web/src/api/types.ts`。

## 3. 里程碑

### M0 — Contract 与接口冻结

交付：本 contract、开发计划、旧草案 superseded 标记、traceability matrix。冻结 episode 语义、正交生命周期、
application 聚合、DTO/internal route/exact scope、幂等/CAS、权限矩阵、脚本非执行边界、三轴开关、指标公式
和 `evolution_eval` run class 决策。

退出 Gate A：Reviewer 无 P0/P1 规格问题；开发 Agent 只按冻结接口实现。

### M1 — Core 事实层与只读/控制 API

负责人：Core/Runtime Agent；Reviewer 做 Gate B/D 审核。

交付：

1. forward-only `0013_self_evolution.sql` 与 fresh schema 等价更新；
2. 独立 `self-evolution-handlers.ts` 和窄 router/feature flag 接入；
3. episode/distillation/Skill/version/file/application/evaluation/curator run 事实；
4. overview/list/detail/version/application/evaluation-history API；
5. Pause/Disable、Skill disable/enable、rollback active pointer、手动 Curator API；
6. deterministic asset scanner 与生命周期纯函数；
7. Core contract/unit/PostgreSQL tests。

退出 Gate B：append-only、ACL、feature-off、CAS、幂等、崩溃重试、跨项目 redaction 和 migration 等价测试通过。

### M2 — Runtime Distiller 与 Learned Skill 应用闭环

负责人：Core/Runtime Agent；Leader 处理 `runtime/server.ts` 高冲突接线；Reviewer 做 Gate C/D 审核。

交付：

1. Project Agent 每个 sealed turn、bounded task terminal 产生一次 episode，并原子绑定同 observation key 的 application；
2. Distiller no-op/create/patch typed client，lease/retry/CAS；
3. `learned_skill_search/view/apply/close`，固定版本、local goal、primary/supporting；
4. 工具/Vivado/Evidence 引用与人工纠正事实写入；
5. quarantined/disabled/archived 搜索过滤；
6. System Skill 和治理零回归测试。

退出 Gate C/D：重放不重复、并发 patch 不丢更新、恶意资产 fail closed、Distiller 无 Connector，端到端 application pending 可见。

### M3 — Curator（证据评价）与 Evolution UI

负责人：Web/Test Agent 实现独立 `/evolution` 模块；Core/Runtime Agent 实现 Curator；Reviewer 做 Gate D/E 审核。

交付：

1. `Run Curator now` 和 dry-run；基于已有真实证据完成四分类；
2. immutable evaluation/supersede、失败阈值、observed/unknown 指标；
3. 评价后的 no-op/patch/scope change/state action；parent/control CAS，Pin/Disable 竞态 fail closed；
4. `/evolution` 概览、Skill/版本/来源/application/evaluation；
5. Pause/Disable、Skill disable/enable、手动 Curator；数据库/API 保留 rollback 能力；
6. mock 只用于 UI 开发，另有真实 Core API 合约测试；1440/390/320 走查。

退出 Gate E：自动沉淀 → 乐观可发现 → 显式应用 → Curator 评价 → 状态/指标/UI 完整跑通；重启和幂等重放通过。

### M4 — 周期 Curator 与隔离 Vivado 补评

负责人：Core/Runtime/Connector Agent；Reviewer 做专门安全审核。

交付：

1. 7 天资格 + idle 2h 调度；成功的手动 run 重置下一次 7 天周期，dry-run 不重置。Scheduler
   使用 exact singleton `core:evolution-scheduler` 只调用 ensure-scheduled；Curator 分 manual/scheduled
   claim lane，claim 不再隐式物化；
2. 独立 `evolution_eval` run class、service identity、专用 Core route/token；
3. 每轮串行最多 3 个 Vivado job、总时长 2h；
4. 只在隔离副本仿真/综合/实现/生成试验码流；
5. 禁止正式项目写、adopt、approve、baseline、publish、hardware download；
6. crash recovery、资源预算、审计与强制停止测试。

Vivado 只在失败、多次 inconclusive、大范围 patch、冲突或高风险抽样时按需补评；无工作即跳过，错过的周期
不累积，失败按指数退避但不越过 7 天资格/2 小时预算。

M4 按以下可独立审核批次推进，任何批次 P0/P1 未清零不得进入下一批：

- M4-A：Core-owned canonical schedule generation、exact scheduler singleton、manual/scheduled claim 双 lane；
- M4-B：Host typed scheduler client、idle 2h 与 graceful stop 接线；Host 不提交 Core 时间/bucket；
- M4-C：只冻结 `specs/self-evolution-v1.md` 附录 B 的 `evolution_eval` contract，不写实现；
- M4-D：migration/fresh schema parity、`evolution_eval_run/job/dispatch/workspace/revision`、专用 Core typed route、
  canonical hash、审计/outbox；
- M4-E：Runtime Evaluator 与 Connector `evolution_eval` class/四 operation 显式广告、post-commit dispatch、same-ID
  reconcile/cancel、evidence freeze+ack retention；
- M4-F：真实 PostgreSQL/Connector 端到端、安全负例、崩溃恢复和全量回归。

M4-C Contract Gate 要求 Reviewer 逐项确认：

1. exact singleton scope 为 `core:evolution-eval`，混 scope、Curator/Evaluator token 互用和所有 generic project/job/workspace
   route 均 fail closed；
2. claim 签发不可伪造的 `eval_input_ref/input_manifest_hash`，prepare/read/write 只作用于 Core 创建的隔离 workspace，
   submit 消费 sealed manifest；caller 不能选择 project、commit、Host path、Connector、run class 或 raw command；
3. Core/DB/Connector 对 `run_class=evolution_eval` 单一真相一致，只有
   `validate_sources|simulate|synthesize|implement` 显式广告该 class；
4. Core 锁内权威执行首 claim 固定 2h deadline、最多 3 job、ordinal 串行、timeout clamp，reclaim/restart 不重置；claim
   recovery snapshot 与 recover route 让新 holder query-first 恢复全部 in-flight job；
5. prepare/read/write/submit/status/cancel/evidence 与 A.6 claim/lease/complete/fail 的 strict DTO、幂等、状态映射、
   stable error/HTTP/retryability/DB-write 语义完整；
6. prepare 原子创建 submitted draft；submit 先 commit sealed dispatch fact/唯一 outbox且仍为 submitted；任何可能产生
   外部效果前按既有 ToolRun machine 逐边 submitted→queued→preparing→running 并 commit，之后才 RPC。response lost、
   restart、cancel/timeout 不可证明时进入不可自动改判的 `unknown_effect`，受影响 application 只能
   `inconclusive + no_op`，Curator fail 不能绕过；
7. eval `.bit` 永久为 experimental/evolution_eval evidence，不能满足 formal/gate/baseline/release/delivery，且无任何
   project write/adopt/approve/publish/hardware download 能力；
8. evaluation 到 frozen evidence/tool_run/input/workspace manifest 的 append-only trace 可验证；Core 完整 freeze 足以在 2h 内
   complete，Connector ack/retention/cleanup 是 run-independent background duty，output 最迟保留 7d；跨项目仍
   conceal/redacted，run 后只经 ACL-aware public projection 读 entry-level hash/classification metadata。

退出 Gate F：上述 Contract Gate 已 PASS；scope 组合负例、3 job/2h/serial 并发、dry-run、pause/rollout、ACL、
idempotency、migration parity、既有 ToolRun transition audit、response-lost/restart/cancel unknown_effect、formal bitstream
混淆、raw Tcl/hardware、source 4096/512MiB、skill/overlay 512/32MiB、workspace 5120/576MiB、read 8MiB、global spool
2GiB、manifest/canonical-hash drift、evidence 128-entry/64MiB/256MiB/corrupt/unavailable-at-2h/7d retention/
background-ack/quarantine、unknown/corrupt/unavailable fail-bypass、Connector跨deadline仍释放run、dispatch-vs-tombstone
并发 CAS/no-op 负例全部通过；Connector 不暴露 raw Tcl/hardware write，Curator 报告可回溯到完整
Evidence，强制停止后无 orphan process 或可写 project copy。

### M5 — Learned Script Sandbox 与完整用户控制

负责人：独立安全切片，默认仍关闭。

交付：无网 OS 隔离、只读 Skill/项目副本、可写临时目录、CPU/内存/时间限制；Tcl 只能编译到 Connector
强类型 operation，不提供 raw Tcl。补齐 Pin、Unpin、Archive/Restore、版本 diff、人工 supersede、问题族趋势，以及
按来源 ACL 读取历史 eval evidence 内容；M4 已提供长期 manifest/entry hash metadata，不保留终态 Evaluator route。

退出 Gate G：逃逸/联网/进程/secret/raw Tcl/路径攻击套件全部 fail closed；关闭 sandbox 后不影响只读 Skill 使用。

## 4. 团队分工与审核节奏

| 角色 | 职责 | 禁止事项 |
|---|---|---|
| Leader | 冻结接口、处理高冲突接线、合并、测试、最终验收 | 不以 Agent 自报替代代码/测试证据 |
| Core/Runtime Agent | M1/M2 数据、API、Runtime、Curator 服务 | 不改 Web；不扩张 Connector 权限 |
| Web/Test Agent | 独立 evolution API/domain/view/mock/tests | 不直连 Runtime；不碰 ProjectView dirty 区 |
| Reviewer Agent | Gate A–G 独立审查；按严重度列问题 | 不直接修改实现，保持独立性 |

审核发生在：计划冻结、M1 schema/API 完成、M2 Runtime 接线完成、M3 UI/E2E 完成、M4-C contract 冻结、
M4-D Core facts/routes、M4-E Runtime/Connector 接线和最终回归后。
P0/P1 必须修复后才能进入下一 Gate；P2 要有明确延期记录和不阻塞理由。

## 5. Traceability Matrix

| Requirement | Planned evidence | Verification | Initial status |
|---|---|---|---|
| Learned Skill 优先、System 不可改 | 独立表/loader/tool | System pack 回归 + 权限负例 | absent |
| Episode once-only | episode unique + terminal/turn hook | replay/restart/concurrency tests | absent |
| 自动 create/patch 乐观生效 | Distiller + scanner + CAS | no-op/create/patch/security tests | absent |
| 显式应用和 primary 归因 | application facts/tools | fixed-version/one-primary tests | absent |
| Curator 四分类 | append-only evaluation | threshold/supersede/inconclusive tests | absent |
| 周期与 Vivado 隔离 | M4 scheduler + 附录 B `evolution_eval` | schedule generation、scope、budget/serial、ACL、sealed manifest、evidence tests | in_progress |
| Eval crash safety | Core job truth + same-ID reconcile + unknown latch | response-lost/restart/cancel/timeout/unknown_effect tests | absent |
| Eval 码流不混权威事实 | experimental/evolution_eval classification | formal/gate/baseline/release/delivery/hardware negative tests | absent |
| 观察性指标 | Core projection | unknown/pending/primary formulas | absent |
| 用户刹车与回滚 | settings/control API | idempotency/CAS/race tests | absent |
| Evolution UI | `/evolution` | domain/UI/API/browser tests | absent |

## 6. 验证命令

```bash
bun test core/tests connector runtime
bun run check
bunx tsc --noEmit -p runtime/tsconfig.json
(cd web && bun test)
(cd web && bun run check && bun run build)
```

另需配置临时 PostgreSQL 执行 migration equivalence、ACL、幂等、崩溃恢复与 Core→Web 真实集成测试。

## 7. 第一开发批次（立即执行）

本批次冻结为 M1 + M2 的可组合内核，以及 M3 的独立 Web/API consumer：

- Core/Runtime Agent：先实现领域纯函数、scanner、0013 schema、typed service/API 合约；再接 search/view/apply/close 和 episode seam。
- Web/Test Agent：按冻结 DTO 实现 `/evolution` 可读页面、unknown 指标和 Pause/Disable/Run Curator 控制；在 Core API 未完成前用 mock 开发，最终改为同一 contract。
- Reviewer：M1 中期审查 schema/API/scanner；M2/M3 完成后做跨模块审查。
- Leader：只亲自修改两个 Agent 都不应独占的接线点，解决接口漂移并运行全量门禁。
