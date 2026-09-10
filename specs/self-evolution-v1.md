# Synthia Self-Evolution v1 Contract

状态：已冻结（Gate A PASS；实现与验收的权威来源）
日期：2026-08-26
取代：`self-evolution-options-v1.md` 的实现建议

## 1. 产品定义与成功标准

Self-evolution 是：

> 自动把真实任务中形成的有效方法沉淀为立即可用的 Learned Skill，通过真实调用记录
> 和周期性 Curator 评价持续修补、降级或淘汰，以提高同类问题成功率、减少人工纠正、
> 解决以前无法解决的问题，并缩短局部目标完成时间。

创建 Skill 只是进化途径，不是成功本身。v1 只演进 Learned Skill，不演进模型权重、
System Skill、Core/Runtime/Connector 代码、prompt 或工具权限。

## 2. 不变量

1. `System Skill` 来自只读 skill pack，不允许 Distiller 或 Curator 修改。
2. `Learned Skill` 是独立的 Core 权威对象；不能混入 system skill pack。
3. Skill 不携带 capability，不直接调用 Connector，也不能批准、建基线、发布或下载硬件。
4. 所有执行仍由主 Agent/Curator 通过 Core 和既有治理完成。
5. Skill 内容和版本不可变；修改产生新版本，运行中应用固定精确版本。
6. Distiller 不能访问 Connector、执行 Skill 脚本、写正式项目或修改 System Skill。
7. Curator 可在隔离副本运行 Vivado，但不能写回正式项目、批准、建基线、发布或下载硬件。
8. 来源事实和 sanitized Skill 内容分离；全局 Skill 不能泄漏项目名、绝对路径、源码、日志或敏感证据。

## 3. Learning Episode

提炼单位不是笼统的 task terminal，而是不可变 `LearningEpisode`：

- Project Agent：一次 turn 的消息、工具和证据完全封存，Agent 回到 `awaiting_user` 时产生。
- bounded run/side：任务进入 `succeeded`、`failed`、`cancelled` 或 `fail_closed` 时产生。
- 每个 episode 固定非空 `observation_key`、`episode_key`、`task_id`、可空 `turn_id`、`end_event_sequence`、
  `content_hash`、工具区间、Evidence 引用和非权威 outcome claim。
- `observation_key` 在 turn/task 开始时即可确定：Project Agent 是 `turn:<turn_id>`，bounded task 是
  `task:<task_id>`；application 可以先绑定这个 key，settling 后再绑定完整 episode。
- Project Agent 的 key 是 `turn:<turn_id>:<end_event_sequence>`；bounded task 的 key 是
  `terminal:<end_event_sequence>`；`(task_id, episode_key)` 唯一，禁止依赖 PostgreSQL 的 nullable UNIQUE。
- Project episode 只能在完整消息/工具回调已 flush、Core 已提交 `awaiting_user` settling status event 后，
  以该 event 的 sequence 为边界创建；bounded episode 同理绑定已提交的 terminal status/result event。
- 重放和崩溃恢复不得重复 episode 或 DistillationRun。

三类开关的精确语义见 §9。Pause Learning 不停止 episode/application 观测，也不影响现有 Skill 使用。

## 4. Distiller

Distiller 对每个 episode 最多完成一次 crash-safe `DistillationRun`，结果只能是：

- `no_op`：没有可复用方法；
- `create`：创建 curator-managed Learned Skill 和 v1；
- `patch`：以 expected parent version 做 CAS，创建新不可变版本；并发冲突不得覆盖。

Distiller 可读 episode、受 ACL 保护的来源和现有 Learned Skill；不可执行工具。输出经过确定性门：

- 只允许 `SKILL.md`、`references/`、`templates/`、`scripts/`；
- `scripts/` 第一版允许 Tcl、Python、TypeScript，禁止 Shell；
- 规范化相对路径，拒绝路径穿越、符号链接、非 UTF-8、超限文件/总量；
- secret、网络、进程启动、动态加载、危险文件 API、raw Tcl/capability 注入扫描 fail closed；
- 保存每个文件的 hash、size、media type 和扫描器版本。

通过后立即成为 `active_unproven`。v1 首个纵切片中的脚本是可生成、可读、不可执行资产；
脚本执行器必须经过独立 sandbox 安全门。

失败/取消 episode 只有在其中存在已被证据支持的局部有效步骤或明确人工纠正时才允许 create/patch；
纯失败、无验证的猜测和低置信结论必须 no-op。扫描失败仍保存不可变 candidate version 与扫描报告，
标记 `quarantined` 且不移动 active pointer；不得静默丢弃安全证据。

## 5. 检索与应用

适用条件写入 Skill 供 Agent 判断，不做严格路由。Runtime 提供渐进加载：

1. `learned_skill_search`：返回可用 Skill 的短摘要；
2. `learned_skill_view`：读取固定版本的说明和资产清单；
3. `learned_skill_apply`：显式记录采用；
4. `learned_skill_close`：局部目标结束时封存结果和证据引用。

`SkillApplication` 是一个局部目标聚合，创建时固定 `task_id + observation_key`、`local_goal`、工具事件区间、
Vivado/ToolRun/Evidence 引用、人工纠正次数、非权威 outcome claim 和 started/closed time。
`SkillApplicationSkill` 将一个或多个精确 SkillVersion attach 到该聚合，并记录采用理由与
`primary`/`supporting` 角色；数据库 partial unique 保证每个 application 最多一个 primary。
只有 primary 进入成功率，supporting 只保留协同事实。

第一次 `learned_skill_apply` 创建 application 并 attach primary；后续 apply 可用 `application_id`
attach supporting skill。若没有 primary、目标已 close、task/version 不一致或试图 attach 第二个 primary，
Core fail closed。`learned_skill_close` 关闭整个局部目标，不逐个关闭 Skill。

Application 在 turn/task settling 前的 `episode_id` 必须为 null。Project apply body 携带 `turn_id`，Core 校验
对应已提交 tool_call event 的 turn id 并派生 observation key；bounded task 由 Core 根据 agent role 派生。
settling hook 在创建 episode 的同一幂等事务中，把所有同 task/observation key 且未绑定的 applications 绑定到
该 episode，绑定后不可变。显式 close 可先进入 `closed_pending_episode`；只有 episode 绑定完成后才变为
`pending_evaluation`。Curator 不领取未绑定 application。

`disabled`、`quarantined`、`archived` 版本不进入普通搜索；已开始的 application 仍保留固定版本事实。
未 close 的 application 在 episode 封存时保持 pending 或由系统标记 inconclusive，不能被当成失败。

## 6. Curator 评价

Curator 对 pending application 创建不可变 `CuratorEvaluation`：

- `success`
- `applicability_failure`
- `execution_failure`
- `inconclusive`

低置信度必须是 inconclusive。评价可以由后续评价或人工评价 `supersede`，不能覆盖或删除。
新 SkillVersion 独立计分，不继承父版本成绩。

首个纵切片必须提供 `Run Curator now` API/CLI；dry-run 可同时提供。正式调度为：

- 每 7 天获得运行资格；
- 系统空闲连续 2 小时后启动；
- 每轮最多串行 3 个 Vivado 评估；
- 总时长最多 2 小时；
- 可运行仿真、综合、实现和生成试验码流；禁止下载到硬件。

Vivado 补评使用独立 `evolution_eval` run class、专用 service identity 和隔离 workspace，不能伪装为
普通 exploratory run。首个纵切片可只使用已有真实证据完成评价；端到端 Vivado 评估是后续里程碑。

评价之后 Curator 必须执行一个明确 remediation 决策：`no_op`、`patch`、`scope_change` 或
`state_action`。它可以修改触发条件、步骤与适用范围，或暂停/归档/回退；patch/scope change 创建新
不可变版本，以 expected parent version + Skill control revision 做 CAS，新版从 `active_unproven` 重新计分。
`pinned` 或 `enabled=false` 在提交时阻止自动 version/pointer/state action，竞态 fail closed；安全扫描仍可
把版本 quality 标为 quarantined，但不能自动启用或切换用户禁用的 Skill。Curator 不自动合并两个 Skill；
merge 作为后续提案能力。

## 7. 生命周期与用户控制

生命周期是正交状态，不是单一混合枚举：

- Skill：`enabled: boolean`、`pinned: boolean`、`availability_state: available|archived`、
  `active_version_id`、`control_revision`；
- Version：`quality_state: active_unproven|active_observed|needs_review|degraded|quarantined`；
- Skill 投影：`freshness_state: current|stale`，由最后使用时间计算。

新版本初始为 `active_unproven`；有有效成功评价后为 `active_observed`。自动处置：

- 首次归因失败：`needs_review`
- 连续 2 次归因失败：`degraded`
- 连续 3 次，或最近 5 次中失败 3 次：`quarantined`
- 安全问题：立即 `quarantined`
- 30 天未使用：freshness 变为 `stale`；下一次合法 application 开始时恢复 `current`
- 90 天未使用：availability 变为 `archived`，可恢复，不物理删除

`inconclusive` 不进成功/失败分母，也不推进失败阈值。版本修补重新从 `active_unproven` 计分。
`needs_review` 下一次 success 恢复 `active_observed`；`degraded` 第一次连续 success 恢复
`needs_review`，第二次恢复 `active_observed`。`quarantined` 不自动恢复，只能切换到非 quarantined
既有版本，或由 patch 产生新版本。

普通 Agent 的可见矩阵：

| 条件 | search | recommended | 已固定 application 可 view/close |
|---|---|---|---|
| enabled + available + current + unproven/observed | 是 | 是 | 是 |
| needs_review/degraded/stale | 是，带警告 | 否 | 是 |
| quarantined、disabled 或 archived | 否 | 否 | 是 |

Rollback 不能指向 quarantined version；Skill disabled 时人类可 rollback 但仍保持 disabled；archived 必须先
restore。所有 projection 改变与不可变 lifecycle event 在同一事务提交。

用户控制：

- Pin：允许使用，阻止 Distiller/Curator 自动修改；
- Disable/Enable；
- Rollback：将 active pointer 前向切到既有不可变版本；
- Archive/Restore；
- Pause Learning；
- Disable Learned Skills；
- Run Curator now / dry-run；
- 人工评价或纠正评价（通过 supersede）。

所有写控制必须带 reason、Idempotency-Key 和 expected revision/version；竞态 fail closed。

## 8. 指标

只使用真实任务观察性数据，不强制 A/B，并明确标为非因果：

- 局部成功率：Curator `success / (success + applicability_failure + execution_failure)`，只统计 primary；
- 中位耗时：application apply 到 close；
- 人工纠正次数；
- 以前失败、现在首次成功的问题族数量；
- applied、evaluated、pending、inconclusive 单独计数。

样本不足显示 `measurement_state=unknown` 和“提升未知”，不得把 pending/inconclusive 算失败。

## 9. 权限与开关

Core 使用字面量 exact scopes：

- 人类/普通 UI：`core:read`；控制操作为 `core:write`；
- task-bound Runtime：沿用 singleton `core:task-runtime`，只在绑定项目/task route 写 episode/application；
- Distiller：singleton `core:evolution-distiller`；
- Curator：singleton `core:evolution-curator`；
- Curator Scheduler：singleton `core:evolution-scheduler`，只物化 scheduled run，不能 claim/lease/complete。
- Evolution Evaluator：singleton `core:evolution-eval`，只能使用附录 B 的隔离 eval route。

后四种 capability token 的 scope 数组必须只包含对应一个 scope，不能混用。一个 Curator 进程可持有相互独立的
Curator token 和 Evaluator token，但每次请求只能使用其中一枚；不能把两种 scope 放入同一 token。Distiller 只能 claim/complete
DistillationRun；Curator 只能 claim/complete CuratorRun、写 evaluation/remediation，并仅通过专用 eval job route
使用 Connector。Evaluator 不能 claim/lease/complete CuratorRun，不能调用 generic project job/workspace route。
已认证且未过期/撤销的 known token 若包含 singleton capability 但 scope 非 exact、混入其他 scope 或重复 scope，统一返回
403 `EVOLUTION_SCOPE_FORBIDDEN`；只有缺失、格式错误、未知、过期或撤销 token 返回 401。混 scope token 不能退回 generic route。
来源读取必须重新校验项目 ACL；无权来源返回 404 或 redacted projection，不能暴露是否存在。

三个开关正交，行为如下：

| 操作 | rollout flag off | Pause Learning on | Disable Learned Skills on |
|---|---|---|---|
| 历史/admin 读取、紧急 Disable | 允许 | 允许 | 允许 |
| 创建 episode/补齐已开始 application 的 close/evidence | 允许 | 允许 | 允许 |
| search/view 后新 apply | 拒绝 | 允许 | 拒绝 |
| Distiller create/patch | 拒绝 | 拒绝 | 允许 |
| Curator 写 evaluation/remediation | 拒绝 | 拒绝 | 允许 |
| Curator dry-run（零写） | 拒绝 | 允许 | 允许 |

- rollout flag `SYNTHIA_FEATURE_SELF_EVOLUTION` 默认 false，是代码发布门；off 时不产生新的能力或使用，
  但继续记录 episode 和封存已开始的 application，避免事实链断裂。
- Pause Learning 只暂停 Distiller 与 Curator 的持久化学习；现有 Skill 仍可用，application 继续记录。
- Disable Learned Skills 只暂停普通 Agent 的发现和新 apply；学习管道可以继续观测、评价和修补。
- 任一状态都不能阻止已有 application close、历史读取或紧急 Disable。Web 使用对应显式 rollout flag。

## 10. Core 事实模型和接口

最小事实模型：

- `evolution_settings`
- `learning_episode`
- `distillation_run`
- `learned_skill`
- `learned_skill_version`
- `learned_skill_file`
- `skill_application`
- `skill_application_skill`
- `curator_run`
- `curator_evaluation`
- `evolution_eval_run`
- `evolution_eval_job`
- `evolution_eval_dispatch`
- `evolution_eval_workspace`
- `evolution_eval_workspace_revision`
- `evolution_eval_workspace_projection`
- `evolution_eval_evidence_fact`
- `evolution_eval_evidence_entry`

版本、文件、episode、评价 append-only；Skill/settings/active pointer 只允许受约束前向变更。

UI 读接口：

- `GET /api/v1/evolution/overview`
- `GET /api/v1/learned-skills`
- `GET /api/v1/learned-skills/:skillId`
- `GET /api/v1/learned-skills/:skillId/versions/:versionId`
- `GET /api/v1/learned-skills/:skillId/applications`
- `GET /api/v1/skill-applications/:applicationId`

控制接口：

- `POST /api/v1/evolution/settings`
- `POST /api/v1/evolution/curator-runs`
- `POST /api/v1/learned-skills/:skillId/{pin|unpin|disable|enable|rollback|archive|restore}`

Runtime/服务写接口应使用独立 internal route 或 typed Core client，且必须覆盖 episode 幂等、Distiller lease、
parent-version CAS、application idempotency、Curator schedule/manual key 和 evaluation 唯一键。

完整 v1 DTO、internal route 与操作矩阵见附录 A；实现不得另行发明不兼容字段。

## 11. 进化页

全局 `/evolution` 页面展示：

- 学习/使用开关、Curator 上次运行/下次资格/pending；
- Skill 列表、生命周期、当前版本、条件摘要和 observed/unknown 指标；
- 版本内容、资产 manifest、parent、来源、applications 和 evaluations；
- Pause/Disable、单 Skill Disable，以及按里程碑开放的 Pin/Rollback/Archive、手动 Curator。

Web 只调用 Core，不直连 Runtime；来源按当前用户 ACL redacted。桌面、390px 和 320px 可用。

## 12. v1 非目标

- 在线训练或修改模型权重；
- KnowledgeEntry/RAG、prompt/tool-routing 自优化；
- System Skill、Core、Runtime、Connector 自修改；
- Skill 自动获得权限；
- 自动批准、建基线、发布、写正式项目或下载硬件；
- 用 A/B 或主 Agent 自报结果替代 Curator 评价。

## 附录 A：冻结 API/DTO v1

所有 JSON 使用 snake_case，外层沿用 Core `{data, correlation_id}` envelope。所有写请求拒绝未知字段；
时间为 ISO-8601；hash 为小写 SHA-256；分页 `limit` 为 1–100，cursor 是 opaque string。

### A.1 公共 DTO

```ts
type QualityState = "active_unproven" | "active_observed" | "needs_review" | "degraded" | "quarantined";
type AvailabilityState = "available" | "archived";
type MeasurementState = "unknown" | "observed";
type EvaluationOutcome = "success" | "applicability_failure" | "execution_failure" | "inconclusive";

interface SkillMetricsV1 {
  measurement_state: MeasurementState;
  primary_applied: number;
  evaluated: number;
  pending: number;
  inconclusive: number;
  success: number;
  applicability_failure: number;
  execution_failure: number;
  success_rate: number | null;
  median_duration_ms: number | null;
  human_corrections: number | null;
  first_solved_problem_families: number | null;
}

interface LearnedSkillSummaryV1 {
  schema: "learned-skill-summary.v1";
  skill_id: string;
  slug: string;
  name: string;
  summary: string;
  applicability_summary: string;
  active_version_id: string | null;
  active_version_no: number | null;
  quality_state: QualityState | null;
  freshness_state: "current" | "stale";
  availability_state: AvailabilityState;
  enabled: boolean;
  pinned: boolean;
  recommended: boolean;
  control_revision: number;
  last_used_at: string | null;
  metrics: SkillMetricsV1;
}
```

`GET /api/v1/evolution/overview` returns:

```ts
interface EvolutionOverviewV1 {
  schema: "evolution-overview.v1";
  rollout_enabled: boolean;
  learning_paused: boolean;
  learned_skills_enabled: boolean;
  settings_revision: number;
  skill_counts: Record<QualityState | "archived" | "disabled", number>;
  pending_applications: number;
  curator: {
    last_run_at: string | null;
    next_eligible_at: string | null;
    pending_evaluations: number;
    schedule_days: 7;
    idle_hours: 2;
    max_vivado_jobs: 3;
    max_duration_minutes: 120;
  };
}
```

`GET /api/v1/learned-skills?status=&cursor=&limit=` returns
`{schema:"learned-skill-list.v1", items: LearnedSkillSummaryV1[], next_cursor:string|null}`.

`GET /api/v1/learned-skills/:skillId` returns summary plus
`versions:[{version_id,version_no,parent_version_id,quality_state,content_manifest_hash,created_at}]`、
`source_summary:{distillation_run_id,source_count,visible_source_count}`。来源项目细节不在此接口返回。

`GET /api/v1/learned-skills/:skillId/versions/:versionId` returns
`{schema:"learned-skill-version.v1", skill:LearnedSkillSummaryV1, version:{version_id,version_no,
parent_version_id,quality_state,description,applicability,outcome_contract,content_manifest_hash,created_at,
files:[{path,kind,language,sha256,size_bytes,media_type,content}], scan:{scanner_version,decision,findings}}}`。

`GET /api/v1/learned-skills/:skillId/applications?cursor=&limit=` returns
`{schema:"skill-application-list.v1",items:[{application_id,project_ref,task_ref,local_goal,state,
started_at,closed_at,duration_ms,human_corrections,outcome_claim,skills:[{version_id,role}],
current_evaluation:{evaluation_id,outcome,confidence,created_at}|null}],next_cursor}`；`project_ref/task_ref`
按当前 actor ACL 返回 id 或 `redacted`。

`GET /api/v1/skill-applications/:applicationId` returns:

```ts
interface SkillApplicationDetailV1 {
  schema: "skill-application-detail.v1";
  application_id: string;
  project_ref: string | "redacted";
  task_ref: string | "redacted";
  observation_key: string;
  episode_ref: string | null | "redacted";
  local_goal: string;
  state: "open" | "closed_pending_episode" | "pending_evaluation" | "evaluated";
  started_at: string;
  closed_at: string | null;
  duration_ms: number | null;
  human_corrections: number | null;
  outcome_claim: string | null;
  skills: { skill_id: string; version_id: string; role: "primary" | "supporting"; reason_codes: string[] }[];
  evidence_summary: { visible: number; redacted: number; refs: { type: string; id: string; hash: string }[] };
  evaluations: {
    evaluation_id: string;
    outcome: EvaluationOutcome;
    confidence: number;
    reason: string;
    evidence_summary: { visible: number; redacted: number; hashes: string[] };
    supersedes_id: string | null;
    evaluator_type: "curator" | "human";
    evaluator_version: string;
    eval_job_refs: {
      eval_job_ref: string | "redacted";
      tool_run_ref: string | "redacted";
      operation: "validate_sources" | "simulate" | "synthesize" | "implement";
      state: "rejected" | "succeeded" | "failed" | "cancelled" | "timeout" | "unknown_effect";
      input_manifest_hash: string;
      workspace_manifest_hash: string | null;
      dispatch_request_hash: string | null;
      evidence_manifest_hash: string | null;
      evidence_state: "none" | "frozen" | "corrupt" | "unavailable_at_deadline";
      retention_state: "not_applicable" | "pending_ack" | "acknowledged" | "quarantine_pending" | "expired";
      evidence_entries: {
        name: string | "redacted";
        sha256: string;
        size_bytes: number;
        media_type: string;
        artifact_classification: "experimental/evolution_eval" | "evolution_eval_evidence";
        usage_classification: "evolution_eval_only";
      }[];
    }[];
    created_at: string;
  }[];
}
```

evaluations 按 created_at/ID 稳定升序返回完整 append-only/supersede 链；无来源 ACL 时只返回 hash/count，
不返回项目证据内容。M3 UI 必须能打开此 detail；人工 supersede 写接口仍在 M5。

M4 的 `eval_job_refs` 是长期 ACL-aware 审计投影：有 source ACL 时返回完整 eval/tool refs、operation/state、
input/workspace/dispatch/evidence hashes、evidence state、双 classification 和 entry name/hash/size/media；无 source ACL 时
`eval_job_ref/tool_run_ref/entry.name="redacted"`，但保留 operation、terminal state、各 manifest/request hash、evidence state、
entry-level 双 classification、entry sha256/size/media 这些 hash-only/non-content metadata。bit/log 混合 manifest 必须保留
各 entry 自己的 classification，job 级聚合若实现只能是派生值，不能替代 entry facts。任何字段不得因 run 已结束而从 projection
消失；raw input/workspace/evidence bytes 和 project/Connector identity 始终不在此 DTO。

### A.2 人类控制写

以下接口都要求 `core:write`、`Idempotency-Key`、非空 `reason`；同 key/同 body replay，异 body 409：

- `POST /api/v1/evolution/settings` body
  `{learning_paused:boolean,learned_skills_enabled:boolean,expected_revision:number,reason:string}`；返回 overview。
- `POST /api/v1/evolution/curator-runs` body
  `{mode:"run"|"dry_run",reason:string,manual_key:string}`；返回
  `{schema:"curator-run.v1",curator_run_id,state:"queued"|"dry_run_complete",mode,created_at}`。
- `POST /api/v1/learned-skills/:skillId/{pin|unpin|disable|enable|archive|restore}` body
  `{expected_control_revision:number,reason:string}`；返回 summary。
- `POST /api/v1/learned-skills/:skillId/rollback` body
  `{target_version_id:string,expected_active_version_id:string,expected_control_revision:number,reason:string}`；
  返回 summary。

稳定错误：`EVOLUTION_DISABLED` 503、`LEARNING_PAUSED` 409、`LEARNED_SKILLS_DISABLED` 409、
`EVOLUTION_CAS_CONFLICT` 409、`SKILL_NOT_AVAILABLE` 409、`SKILL_VERSION_NOT_ACTIVE` 409、
`APPLICATION_ALREADY_CLOSED` 409、`EVOLUTION_SCOPE_FORBIDDEN` 403。

### A.3 task-bound Runtime 接口（singleton `core:task-runtime`）

- `POST /api/v1/projects/:projectId/tasks/:taskId/learning-episodes`
  body `{schema:"learning-episode-create.v1",observation_key,episode_key,turn_id,end_event_sequence,content_hash,
  outcome_claim,tool_event_start_sequence,tool_event_end_sequence,evidence_refs}`；返回
  `{schema:"learning-episode.v1",episode_id,observation_key,episode_key,
  distillation_state:"queued"|"paused"|"disabled",bound_application_ids,replayed}`。
- `GET .../learned-skills/search?q=&limit=` returns
  `{schema:"learned-skill-search.v1",items:[{skill_id,version_id,name,summary,applicability_summary,
  quality_state,recommended}],learned_skills_enabled}`。
- `GET .../learned-skills/:skillId/versions/:versionId` returns sanitized version DTO A.1。
- `POST .../skill-applications` body
  `{schema:"skill-application-create.v1",tool_call_id,turn_id:string|null,version_id,local_goal,reason_codes}`；
  创建 primary，返回 `{schema:"skill-application.v1",application_id,observation_key,episode_id:null,
  state:"open",version_id,role:"primary",replayed}`。
- `POST .../skill-applications/:applicationId/skills` body
  `{schema:"skill-application-attach.v1",tool_call_id,version_id,role:"supporting",reason_codes}`；返回同形 attach result。
- `POST .../skill-applications/:applicationId/close` body
  `{schema:"skill-application-close.v1",end_event_sequence,outcome_claim,human_corrections,
  evidence_refs,tool_run_refs}`；返回 `{schema:"skill-application.v1",application_id,
  state:"closed_pending_episode"|"pending_evaluation",replayed}`。

上述写均带 Idempotency-Key；Core 校验 task/project/runtime actor 绑定、tool_call event 已提交、版本 active pointer
与可用矩阵。episode settling hook 会幂等 close 遗留 open application，但不伪造 outcome。

### A.4 Distiller 接口（singleton `core:evolution-distiller`）

- `POST /api/v1/internal/evolution/distillation-runs/claim` body
  `{worker_id,lease_seconds}`，其中 lease 30–900 秒；返回：

```ts
interface DistillationClaimV1 {
  schema: "distillation-claim.v1";
  run: null | {
    run_id: string;
    state: "running";
    attempt: number;
    lease_token: string;
    lease_expires_at: string;
    episode: {
      episode_id: string;
      observation_key: string;
      episode_key: string;
      project_ref: string;
      task_ref: string;
      turn_id: string | null;
      end_event_sequence: number;
      content_hash: string;
      outcome_claim: string | null;
    };
    trajectory: {
      schema: "learning-trajectory.v1";
      objective: string;
      messages: { sequence: number; role: "user" | "assistant"; content: string; content_hash: string }[];
      tools: { call_sequence: number; result_sequence: number | null; tool_call_id: string; name: string;
        args: unknown; result: unknown; is_error: boolean; tool_run_refs: string[]; evidence_refs: string[] }[];
      human_corrections: { sequence: number; content: string; content_hash: string }[];
    };
    existing_skills: LearnedSkillSummaryV1[];
  };
}
```

- `POST /api/v1/internal/evolution/distillation-runs/:runId/lease` body
  `{lease_token,lease_seconds}`；只有当前未过期 lease 可续租，返回新 expiry。
- `POST /api/v1/internal/evolution/distillation-runs/:runId/complete` body
  `{lease_token,input_hash,model_id,prompt_hash,action:"no_op"|"create"|"patch",
  expected_parent_version_id:string|null,expected_control_revision:number|null,
  skill:{skill_id?,slug,name,summary,description,applicability,outcome_contract,files}|null}`。
- `POST /api/v1/internal/evolution/distillation-runs/:runId/fail` body
  `{lease_token,error_code,retryable,details_hash}`。

Complete 在一个事务执行 lease 检查、parent/control CAS、确定性扫描、version/scan/source/lifecycle/outbox 写；
响应 `{schema:"distillation-result.v1",run_id,state:"noop"|"succeeded"|"quarantined",version_id,replayed}`。
`patch` 必须同时传 expected parent/control revision；`create` 与 `no_op` 两者必须为 null，且 no_op 的 skill
必须为 null。Run 状态为 `queued|running|succeeded|noop|quarantined|failed`。Claim 原子领取 queued 或 lease
已过期的 running run，`FOR UPDATE SKIP LOCKED`，递增 attempt 并生成新 token；旧/过期 token 所有写均 409。
同一 episode 只有一个 run；complete 结果可幂等重放，failed(retryable=true) 回 queued，否则终态 failed。

Core status hook 自动封存的 Distillation run 有固定 30 秒 enrichment grace；显式 Runtime enrichment
到达会立即将 run 置为 ready。首次 claim 固定 input cutoff，lease reclaim 不采纳 cutoff 后的 enrichment。
该 30 秒 deadline 是 v1 部署常量，后续参数化前不得由 worker 绕过。

### A.5 Curator Scheduler 接口（singleton `core:evolution-scheduler`）

- `POST /api/v1/internal/evolution/curator-runs/ensure-scheduled` strict body
  `{request_key:string}`。`request_key` 只用于请求追踪，不能选择周期或资格；Host 不提交时间或 bucket。
  Core 在 advisory lock 内从数据库中最新成功的 persistent run 派生 canonical generation：首次为
  `scheduled:initial`，后续为 `scheduled:after:<latest-success-run-id>`，并计算 Core canonical
  `eligible_at=completed_at+7d`。Core 重新校验资格、pending application、learning pause 和全局无其他
  queued/running run；只幂等物化当前 generation 的 `manual_key IS NULL` queued run，绝不签发 lease。
  返回 `{schema:"curator-schedule.v1",request_key,schedule_bucket,eligible_at,
  state:"queued"|"no_work"|"already_completed",curator_run_id,reason_code,replayed}`。
- 同 bucket 的 retryable failure 已由 fail 回 queued；nonretryable failed 可在 Host 指数退避后由同
  request 的 ensure 触发 Core 复核。只有 failed row 仍属于当前 canonical generation，且 pause/7 天资格/
  pending/无其他 active run/Core retry backoff 全部通过后，才原子重置为 queued 并保留 attempt 历史。
  不同 request_key 不能绕过 generation 或 backoff；旧 generation 和 completed 永不复活。若该 failed row
  已经创建并关闭 `evolution_eval_run`，重置 Curator row 不得清空、替换或重新打开原 2 小时预算；后续 attempt
  只能基于已有 Core 证据做 evidence-only 评价，所有 Evaluator routes 保持永久关闭。

### A.6 Curator 接口（singleton `core:evolution-curator`）

- `POST /api/v1/internal/evolution/curator-runs/claim-manual` 只领取 `manual_key IS NOT NULL`；
- `POST /api/v1/internal/evolution/curator-runs/claim-scheduled` 只领取 `manual_key IS NULL`；
- 两者 body 均为 `{worker_id,lease_seconds}`（30–900 秒）。旧 `/claim` route 不存在并 fail closed；
  两个 claim route 都不物化 scheduled run。返回：

```ts
interface CuratorClaimV1 {
  schema: "curator-claim.v1";
  run: null | {
    run_id: string;
    mode: "run" | "dry_run";
    state: "running";
    attempt: number;
    lease_token: string;
    lease_expires_at: string;
    schedule_bucket: string;
    eval_recovery: {
      budget_started_at: string | null;
      deadline_at: string | null;
      unknown_effect_latched_at: string | null;
      jobs: {
        eval_job_id: string;
        tool_run_id: string;
        application_id: string;
        version_id: string;
        ordinal: 1 | 2 | 3;
        operation: "validate_sources" | "simulate" | "synthesize" | "implement";
        state: "submitted" | "running" | "rejected" | "succeeded" | "failed" | "cancelled" | "timeout"
          | "unknown_effect";
        workspace_id: string;
        workspace_revision: number;
        workspace_manifest_hash: string;
        workspace_sealed: boolean;
        evidence_state: "none" | "freeze_pending" | "frozen" | "corrupt" | "unavailable_at_deadline";
        retention_state: "not_applicable" | "pending_ack" | "acknowledged" | "quarantine_pending" | "expired";
        evidence_manifest_hash: string | null;
        reconciliation_state: "not_needed" | "confirmed" | "required";
      }[];
    };
    applications: {
      application: SkillApplicationDetailV1;
      primary_version: {
        skill: LearnedSkillSummaryV1;
        version_id: string;
        content_manifest_hash: string;
        description: string;
        applicability: unknown;
        outcome_contract: unknown;
        files: { path: string; kind: string; language: string | null; sha256: string; content: string }[];
      };
      eval_input: null | {
        eval_input_ref: string;
        input_manifest_hash: string;
        source_commit: string;
        source_manifest_hash: string;
        allowed_operations: ("validate_sources" | "simulate" | "synthesize" | "implement")[];
        trial_bitstream_allowed: boolean;
        part: string | null;
        toolchain_profile_hash: string;
      };
      evidence_snapshot_hash: string;
      evidence: { type: string; id: string; sha256: string; summary: string; content: string | null }[];
    }[];
  };
}
```

- `POST /api/v1/internal/evolution/curator-runs/:runId/lease` body `{lease_token,lease_seconds}`；语义同 Distiller。
- `POST /api/v1/internal/evolution/curator-runs/:runId/complete` body
  `{lease_token,evaluator_version,evaluations:[{application_id,evidence_snapshot_hash,outcome,confidence,
  reason,evidence_refs,eval_job_refs:[{eval_job_id,tool_run_id,evidence_manifest_hash:string|null}],supersedes_id}],
  remediations:[{skill_id,expected_active_version_id,
  expected_control_revision,action:"no_op"|"patch"|"scope_change"|"state_action",patch?,state_action?}]}`。
- `POST /api/v1/internal/evolution/curator-runs/:runId/fail` body `{lease_token,error_code,retryable,details_hash}`。

Evaluation 唯一键是 `(application_id,evidence_snapshot_hash,evaluator_version)`；complete 对每个 remediation 独立
CAS，冲突记录为 skipped，不覆盖。响应含 immutable evaluation ids、produced version ids、skipped actions。
`confidence` 为 0–1 finite number；evaluation `reason` 为 1–4096 UTF-8 bytes、NFC 且无 C0/C1 控制字符；
`evaluator_version`、fail `error_code` 最多 128 bytes，`evidence_refs` 最多 128 项，`eval_job_refs` 最多 3 项且各数组唯一。
Run 状态为 `queued|running|completed|dry_run_complete|failed`；claim/reclaim/token/renew/retry 与 Distiller 相同。
dry-run complete 返回拟评价和 remediation 但不写 evaluation/version/lifecycle，也不重置 schedule bucket。
dry-run claim 的所有 `eval_input` 必须为 null，且附录 B 的任何 prepare/submit 路由都拒绝 dry-run。
若 application 没有可重现、ACL 可读且与 reservation 一致的输入，`eval_input` 为 null；Curator 只能使用已有证据评价，
不能由 caller 自报 project、commit、manifest 或路径补齐。`eval_input_ref` 是 Core 签发的 opaque binding，不是 bearer
credential；它固定到 curator run、application、primary version、evidence snapshot 和输入 manifest，reclaim 返回同一 binding。
每次 first claim/reclaim 都必须在返回前，对数据库中全部“已有 dispatch fact 的 submitted”及 `running` eval job 以持久化的
Connector job ID/key 做 query-first reconciliation；未 seal 的 submitted draft 不访问 Connector。每个待恢复 job 要么更新为已确认状态，要么在 Connector 暂时不可达时保留
原状态并显式返回 `reconciliation_state=required`。存在 required job 时任何新 prepare/write/submit 均拒绝，只允许附录 B
的 recover/status/cancel/read/evidence 安全收尾；新 holder 从 `eval_recovery.jobs` 得到完整 ID 和 workspace snapshot，
不猜测或扫描 generic project routes。claim/reclaim 先 commit 新 lease 与 durable reconcile intents，之后才在数据库事务外
query Connector，再以新事务写结果；不允许持锁 RPC。dry-run 的 recovery jobs 必须为空且 budget/deadline 为 null。

### A.7 操作矩阵

| Actor | Read source | Episode/application | Skill version | Evaluation | Eval Vivado | Project/governance write |
|---|---|---|---|---|---|---|
| task Runtime | 绑定 task | 写 | 只读 active | 无 | 既有 task 权限 | 既有治理边界 |
| Distiller | sanitized episode | 无 | create/patch curator-managed | 无 | 无 | 无 |
| Curator | ACL-filtered snapshot | 无 | patch/scope/action | 写/supersede | 专用 M4 route | 无 |
| Evolution Evaluator | 仅 Core-issued eval input | 无 | 只读固定版本 | 无 | 附录 B 专用 route | 无 |
| Human UI | ACL-filtered | 只读 | controls/rollback | manual supersede（M5） | 手动触发 | 既有独立权限 |

## 附录 B：冻结 `evolution_eval` 合同 v1

本附录冻结 M4-C。除 A.6 的 Curator claim/lease/complete/fail 外，Evaluator 只可调用本附录逐条列出的 route；
所有 route 都是 strict JSON、拒绝未知字段、使用 Core envelope，并要求 actor_type=`service`、scope 数组精确等于
`["core:evolution-eval"]`。任何旧名、别名、generic `/projects/*/jobs` 或 generic workspace route 对 Evaluator
均为 404/403 fail closed。Evaluator token 不能调用 Curator claim/lease/complete/fail；Curator token 也不能调用
本附录路由。每个请求还必须携带当前 `curator_lease_token`，Core 在事务中重校验它属于 path 中 run、尚未过期，
且 run 为 `mode=run,state=running`。rollout off、Pause Learning 或 dry-run 时不能创建、修改或提交 eval job。

### B.1 权威状态、预算与数据库事实

`run_class` 的 Core domain、PostgreSQL enum、Connector protocol 和 discovery 唯一新增字面量为
`evolution_eval`。Core 是 run class 的唯一裁决者：caller 不提交 `run_class`；Core 创建的 `tool_run` 和发送给
Connector 的外层 JobRequest、内层 Vivado typed request 必须全部精确等于 `evolution_eval`，任一不一致即拒绝。
它不等价于 `exploratory`、`gate_check` 或 `formal`，不能通过其他 class 伪装。Connector discovery 必须按 operation
显式广告是否支持 `evolution_eval`，未广告即 `503 EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE`，不能降级到别的 class。

forward-only migration 与 fresh `schema.sql` 必须等价新增下列权威事实；具体列名可以按 SQL 风格展开，但不可合并进
普通 task/workspace 状态而丢失绑定：

- `evolution_eval_run`：一对一绑定 `curator_run_id`，保存不可重置的 `budget_started_at`、`deadline_at`、
  `max_jobs=3`、`unknown_effect_latched_at` 和创建/完成时间。第一份 persistent `mode=run` Curator claim 在锁住
  `curator_run` 的事务内写入 `budget_started_at=Core now`、`deadline_at=budget_started_at+2h`；reclaim、续租、
  重启和 Host 时间都不能移动 deadline。dry-run 不创建此事实。Curator 首次进入 `completed|failed` 时必须
  已关闭该 eval run；A.5 允许同 generation 的 nonretryable failed row 退避后重置为 queued，但 eval run 的
  `completed_at` 仍不可逆，因此反向不要求“已关闭 eval run 的 Curator 必须永远保持终态”。
- `evolution_eval_job`：不可变绑定 `eval_job_id`、`curator_run_id`、`application_id`、`version_id`、
  `eval_input_ref`、`input_manifest_hash`、`tool_run_id`、Core 生成的 `connector_job_id`/`connector_idempotency_key`、
  Header-derived `request_key`、`prepare_request_hash`、`ordinal`、`operation`、`deadline_at` 与 timestamps；
  `UNIQUE(curator_run_id,request_key)`、`UNIQUE(curator_run_id,ordinal)`、`UNIQUE(tool_run_id)`、
  `UNIQUE(connector_job_id)`，hash 为小写 SHA-256，所有引用有 FK。prepare 在一个事务中同时创建 state=`submitted` 的
  `tool_run`、此 immutable binding、初始 workspace revision 与 audit；job state 只从绑定 `tool_run.state` 投影，
  `evolution_eval_job` 不保存第二份可漂移 state。
- `evolution_eval_dispatch`：每 eval job 最多一个的 append-only submit fact，保存 sealed workspace revision/manifest hash、
  `sealed_input_projection_hash`、`dispatch_request_hash`、requested timeout、operation cap、absolute deadline、created_at；
  submit replay 只能读取该 fact，
  不能 null→hash 或覆盖。
- `evolution_eval_dispatch_tombstone`：每 dispatch 最多一个 append-only cancel/pause/deadline fact，保存 reason/error hash 与
  created_at；永不撤销、删除或覆盖原 dispatch/outbox。
- `evolution_eval_reconcile_fact`：每次把 in-flight job 标记为 `reconciliation_state=required` 时，按 job 内连续 sequence
  append 一条 typed intent，固定 Connector job ID/key、当前 workspace revision/manifest 与 canonical
  `reconcile_request_hash`；同事务精确拥有 `event_type=reconcile_required` audit 和
  `evolution_eval.reconcile_requested` outbox，audit/outbox 反向只能有该一个 owner。claim/recover replay 在已有 unresolved
  required intent 时不得重复追加，R1 只提交 intent、绝不在持锁事务或 route 内调用 Connector。
- `evolution_eval_workspace`：immutable 一对一 binding，只保存 eval job、Core-issued source snapshot、40/64 位小写 Git
  commit 和 input/source manifest hash；不得原地改写。
- `evolution_eval_workspace_revision`：append-only `(workspace_id,revision)` facts，保存 normalized manifest、manifest hash、
  file/byte count、created_at；revision 从 1 严格递增且唯一。
- `evolution_eval_workspace_projection`：每 workspace 唯一的受约束单调投影，只保存 `current_revision` CAS pointer、
  `sealed_at`、`discarded_at`；pointer 只能 +1，seal/discard 只能 null→timestamp，不可反转。每次 pointer/state 变更与新的
  revision/event 在同一事务提交。raw 文件在 ACL 保护的 content-addressed store。不得保存 lease token、service secret、
  Connector credential 或 Host 绝对路径。
- `evolution_eval_input_skill_file`：append-only 固定输入事实，逐文件绑定 `eval_input_ref`、primary `version_id` 与
  `learned_skill_file` identity/path/kind/language/hash/size/media/content；缺失、伪造、额外或跨版本文件均拒绝。
  `input_manifest.skill_files`、revision 1 和所有后续 revision 的只读 skill layer 必须与此集合双向 exact；无 Skill 文件时
  唯一合法表示是显式空数组/空集合。一个 SkillVersion 一旦被任一 `evolution_eval_input` 固定，其文件集合即视为封存；
  对该 version 的后续 `learned_skill_file` insert 必须在 commit 时反向复验所有关联 input manifest 与 workspace，任何漂移
  都拒绝。SkillVersion、文件、input/input-skill binding 与 workspace 可在同一事务按 FK 允许的顺序创建，只要 commit
  的最终集合 exact；未被任何 eval input 引用的普通 SkillVersion 不受此反向校验限制。为关闭并发 write skew，
  `evolution_eval_input` 与 `learned_skill_file` 的 insert 必须在写入前以相同锁序取得目标 `learned_skill_version` 的排他行锁，
  再由 deferred exact validator 基于串行后的最终集合决定 commit。
- `evolution_eval_evidence_fact/entry`：append-only 保存 freeze/corrupt/unavailable_at_deadline 评价证据结论、
  ack/quarantine/expired/cleanup retention facts 与 valid entry metadata；同 job 的 valid manifest hash 唯一，evidence conclusion
  只能 `none→frozen|corrupt|unavailable_at_deadline` 且不可改变。retention projection 独立单调，Connector expiry 不能把已经
  Core-frozen 的 evidence 降级。raw valid bytes 进入 Core content-addressed store，raw corrupt/late-unavailable bytes 禁止入库。

对 API/recovery 稳定投影而言，非终态只有 `submitted|running`，终态为
`rejected|succeeded|failed|cancelled|timeout|unknown_effect`。Core 仍严格使用既有全局 ToolRun machine；其中
`queued|preparing|cancelling` 只允许作为同一短事务内逐边验证/审计的中间状态，不能 commit 为可恢复稳定态。
`lost` 对 `evolution_eval` 非法：Connector ledger 有持久证明 job 从未接受且以后也不可能执行时，submitted/pre-send
投影 `rejected`，effect-possible running 才投影 `failed + EVOLUTION_EVAL_NOT_ACCEPTED`；任何“可能执行”或“未确认停止”
一律为 `unknown_effect`。Core 在锁住 `curator_run` 与 `evolution_eval_run` 的同一事务分配 ordinal；每个 Curator run
最多 3 个 job（包括 submitted、rejected、失败和 `unknown_effect`），且只有前一 ordinal 已终态
才能 prepare 下一 job。任何并发请求都必须经过 `FOR UPDATE` 权威计数，不能信任 Host 计数。当前时间已到 deadline、
剩余预算为零或已 latch `unknown_effect` 时不能创建/提交新 job。operation timeout 为
`min(request.timeout_ms, operation_cap, deadline_at-Core now)`；v1 operation cap 为 2 小时，结果必须大于零。
数据库最后防线的竞争锁序固定为 `evolution_eval_run → evolution_eval_job → tool_run`：prepare 以权威 job count 分配
连续 ordinal 并重验前一 ordinal 已终态；dispatch 与 `submitted→queued` effect fence 在同一锁序下重验 latch。
latch 事务锁住对应 job，且 transaction-origin guard 拒绝同事务或其后新增 job、dispatch 或 effect fence。

所有 `evolution_eval_*` binding、workspace manifest、evidence manifest 与审计/outbox 为 append-only。写状态变更必须
原子产生 outbox/audit；至少覆盖 prepare、workspace write/seal、submit、每条 dispatch fence transition、reconcile、cancel、
rejected/terminal、evidence freeze/corrupt/unavailable、retention ack/expired/cleanup、`unknown_effect`、complete/fail。审计只保存
actor/service/worker ID、correlation/request hash、资源 ID、状态转换、
operation、manifest/evidence hash、字节/文件计数和稳定 error code，不保存 token、源字节、secret、raw log 或绝对路径。

数据库必须用 CHECK/UNIQUE/FK 与 deferred constraint trigger 保证：run↔CuratorRun、job↔workspace、job↔tool_run 均
一对一，job↔dispatch/job↔dispatch tombstone 为零或一；ordinal 只能 1..3；`tool_run.run_class=evolution_eval` 且 operation 与 binding 相等；commit/source/hash/ID 格式
合法；workspace revision/pointer 单调；tool_run terminal 不可复活；`unknown_effect` 与 run latch/audit/outbox 在锁住 run
的同一事务写入且不可清除；deferred constraint 拒绝 evolution_eval 的 queued/preparing/cancelling 在事务提交时残留，并
要求逐边 audit 数量与 transition 一致；evidence conclusion 唯一，retention/cleanup facts 单调且不覆盖 conclusion。migration 与 fresh schema
必须通过结构和行为 parity test。

所有 request/manifests 使用确定性 canonical bytes：先要求所有字符串 NFC、所有 path 通过 B.2 规范化，再按 RFC 8785
JSON Canonicalization Scheme 生成 UTF-8；对象 key 排序，数组保留 DTO 语义顺序，唯有 manifest 的 files/entries 在编码前
分别按 portable path key/evidence name bytewise 升序。SHA-256 对这些 canonical bytes 计算并输出 64 位小写十六进制；
文件 SHA-256 始终对解码后的原始 bytes 计算。workspace manifest exact shape 为
`{schema:"evolution-eval-workspace-manifest.v1",workspace_id,revision,files:[{path,sha256,size_bytes,media_type,
layer:"source"|"skill"|"overlay",read_only:boolean}]}`。
Connector-visible sealed input 不复用完整 workspace manifest hash，而以同一 canonical path 顺序从完整 manifest 确定性投影：
先删除所有 `layer="skill"` entry，保留 source/overlay entry 的完整 workspace-manifest 字段，再构造 exact JCS preimage
`{schema:"evolution-eval-sealed-input-projection.v1",manifest:<source+overlay-only workspace manifest>,
files:[{path,sha256,size_bytes,media_type}]}`。`files` 与投影后 `manifest.files` 同序且逐项同源，不得含 `layer/read_only/content`
或任何 Skill entry；其 SHA-256 为 `sealed_input_projection_hash`。Core 必须从 durable 完整 manifest 重算，DB dispatch fact、
Core-issued binding、Connector wire/ledger 和 Connector 落盘前重算值必须 exact 相等，任一漂移 fail closed。

### B.2 输入与隔离 workspace

A.6 claim 中的 `eval_input_ref` 由 Core 从已 reservation 的 application、ACL 重新校验后的 immutable source snapshot、
固定 SkillVersion 与 evidence snapshot 派生。`input_manifest_hash` 覆盖 source commit、规范化源/约束文件 path+hash+size、
固定 Skill 文件 hash、目标器件/工具链要求、allowed operations、trial-bitstream policy 和 binding IDs。operation 必须属于
该 ref 的 `allowed_operations`；`implement.generate_trial_bitstream=true` 还要求 `trial_bitstream_allowed=true`。part、toolchain
profile、所有 source/constraint path 都必须与 binding/sealed manifest 重新比对。无 ACL、redacted、来源不可重现、不在
该 run reservation、version/evidence/input hash 不匹配统一返回 404 或 B.5 的 binding conflict，不暴露哪一对象存在。
input manifest exact shape 额外冻结 `skill_files`：
`{schema,eval_input_ref,curator_run_id,application_id,project_id,version_id,evidence_snapshot_hash,source_commit,
source_manifest_hash,allowed_operations,trial_bitstream_allowed,part,toolchain_profile_hash,files,
skill_files:[{path,kind,language,sha256,size_bytes,media_type}]}`。`skill_files` 使用与 workspace 相同的 ASCII portable key 排序，
其完整 canonical bytes 纳入 `input_manifest_hash`；Core claim 返回的 ref/hash 必须对应这一不可变集合，不能由 caller 补写。

每个 job 使用新隔离副本：source tree、固定 SkillVersion 和 Core input snapshot 只读；只有该 job 的 overlay 与 temp/output
目录可写。prepare/read/write 只能访问 Core 创建且绑定到当前 run/job 的 workspace。v1 eval path 收窄为
ASCII workspace-relative POSIX subset：总长最多 512 bytes、最多 32 个 segment，每个 segment 必须匹配
`[A-Za-z0-9][A-Za-z0-9._-]*`。portable key 只以确定性的 ASCII `A-Z`→`a-z` fold 计算，不依赖 ICU/locale；
拒绝所有非 ASCII、隐藏 segment、绝对路径、反斜线、`.`/`..`、符号链接、硬链接、设备文件和大小写 collision。
含非 ASCII source path 的项目不迁移或改名原文件；该 application 的 `eval_input_ref=null`，只能做 evidence-only 评价。
不得从 mutable project HEAD、Host path 或 caller 文件清单替换 source snapshot。

v1 资源预算按 layer 独立计算：revision 1 的只读 source layer 最多 4096 files/512 MiB/单文件 4 MiB；只读 Skill layer
最多 512 files/32 MiB/单文件 1 MiB；可写 overlay 最多 512 files/32 MiB/单文件 1 MiB；完整 normalized workspace
最多 5120 files/576 MiB。workspace write 每请求最多 32 个 change、解码后最多 8 MiB；workspace read 每请求 1–32
个唯一 path，解码后 response 总量最多 8 MiB。UTF-8 与 `.v/.sv/.vh/.svh/.xdc` 限制只适用于 source layer 和
overlay 中实际进入 Connector `source_paths/constraint_paths` 的 Vivado input。
禁止写 `.tcl`、shell、Python、TypeScript、二进制、Skill 文件、source snapshot 原件或 project workspace；固定 Skill
中的合法 sanitized manifest 可含 `SKILL.md`、`references/`、`templates/` 与只读 `.tcl/.py/.ts` scripts；这些只是说明资产，
绝不执行、不可由 overlay 修改、不可出现在 source/constraint paths、不可传给 Connector。delete 只删除
overlay 中由本 job 创建的文件，不能删除只读 source。Core 对每次 write 做 expected revision CAS、content SHA-256 校验、
确定性 XDC/path 扫描，更新 normalized workspace manifest。submit 先 seal manifest；seal 后 read 仍允许，write/delete 永久
拒绝，所有 Connector 输入只由 sealed manifest 的 Core content store bytes 解析，不能由 submit body 再提供 source/constraint。
kill 必须有界；确认进程终止后可清理 transient temp，但 Connector output 在 B.3 freeze+ack 完成前不得删除，ack 后才
最终 discard。清理失败记审计但不能把 job 改写成成功；无法确认 kill 则进入 unknown_effect，不能边跑边清 output。

Core 必须在 prepare、每次 write、seal 和 Connector 消费 sealed manifest 前重验上述分层/总量预算。超限返回
`413 EVOLUTION_EVAL_RESOURCE_LIMIT`，non-retryable；prepare 超限零业务写，已创建 draft 的 write/submit 超限也不得改变
workspace revision、seal/dispatch fact 或 ToolRun 状态。Connector 还必须在落盘前执行同等或更严上限，不能只信 Core。

对 source layer 和 overlay 的实际 Vivado inputs，caller 不提交 media type；Core 严格从小写扩展名派生：`.v/.vh → text/x-verilog`、
`.sv/.svh → text/x-systemverilog`、`.xdc → application/x-xdc`，并以 fatal UTF-8 decoder 验证 bytes。
Skill layer media type/hash 来自已通过 scanner 的固定 Skill manifest，不使用此 Vivado extension 映射。
`source_paths` 为 1–512 项，`constraint_paths` 为 0–128 项，所有数组内 path 必须唯一，单 path 1–512 UTF-8 bytes、
最多 32 段；`top`/`testbench` 匹配 `^[A-Za-z_][A-Za-z0-9_$]{0,127}$`，`part` 匹配
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`。`reason_code` 匹配 `^[A-Z][A-Z0-9_]{0,127}$`；所有 opaque ID、
Idempotency-Key 和 eval input ref 最多 128 UTF-8 bytes 且不得含控制字符；`timeout_ms` 是 1–7,200,000 的整数。
以上边界已在 M4-C 冻结，不延期到实现选择。

### B.3 专用 route 与 typed DTO

公共类型：

```ts
type EvolutionEvalOperation = "validate_sources" | "simulate" | "synthesize" | "implement";
type EvolutionEvalJobState = "submitted" | "running" | "rejected" | "succeeded" | "failed" | "cancelled"
  | "timeout" | "unknown_effect";

type EvolutionEvalParametersV1 =
  | { operation: "validate_sources"; source_paths: string[]; top: string | null }
  | { operation: "simulate"; source_paths: string[]; top: string; testbench: string }
  | { operation: "synthesize"; source_paths: string[]; top: string; part: string }
  | { operation: "implement"; source_paths: string[]; constraint_paths: string[]; top: string; part: string;
      generate_trial_bitstream: boolean };

interface EvolutionEvalStatusV1 {
  schema: "evolution-eval-status.v1";
  eval_job_id: string;
  tool_run_id: string;
  curator_run_id: string;
  application_id: string;
  version_id: string;
  ordinal: 1 | 2 | 3;
  operation: EvolutionEvalOperation;
  run_class: "evolution_eval";
  state: EvolutionEvalJobState;
  deadline_at: string;
  error_code: string | null;
  workspace_manifest_hash: string;
  evidence_manifest_hash: string | null;
  evidence_state: "none" | "freeze_pending" | "frozen" | "corrupt" | "unavailable_at_deadline";
  retention_state: "not_applicable" | "pending_ack" | "acknowledged" | "quarantine_pending" | "expired";
  reconciliation_state: "not_needed" | "confirmed" | "required";
  replayed: boolean;
}
```

prepare/write/submit/cancel/evidence freeze/ack mutation 都要求 `Idempotency-Key`，格式见 B.2。prepare 的 Header key
同时成为数据库 `request_key`，body 不再重复提交 request key。Core 幂等 scope 精确为
`(scope="core:evolution-eval",run_id,eval_job_id|null,action,Idempotency-Key)`；logical request hash 是 canonical strict body
删除 `curator_lease_token` 后的 SHA-256。Core 必须先验证 exact scope、当前 lease、run/job binding 和 ACL，之后才查 replay；
因此新 lease holder 可用原 action/key 重放原逻辑结果，但旧 token 不能 replay，换 key 不能绕权限/CAS/预算。
同 scope/key/同 logical hash 返回原结果并 `replayed=true`，同 key 异 hash 返回 409。

Core 在 prepare 时生成并持久化 `connector_job_id`；Connector Idempotency-Key 只由固定 namespace + stable
`eval_job_id` 确定性派生为 64 位小写 SHA-256，与 HTTP Header key/body 字段不同，caller 不可提交或覆盖。
`prepare_request_hash` 是 prepare logical body hash；submit seal 后 Core 只写一次 `dispatch_request_hash`，它覆盖
eval/input binding、sealed workspace manifest hash、`sealed_input_projection_hash`、operation、typed parameters、part/toolchain、requested timeout/operation cap/
absolute deadline policy
和 `run_class=evolution_eval`。Connector ledger 以同 job ID/key + dispatch_request_hash 检测异 payload；任何不一致 fail closed，
因此 overlay 内容不会被 prepare hash 或稳定 key 漏掉。status/recover/workspace read 是 strict POST read，不要求 Header key；
它们仍先验证当前 lease/ACL。
所有 path 中 `runId/evalJobId` 与 body binding 必须一致。

1. `POST /api/v1/internal/evolution/curator-runs/:runId/eval-jobs/prepare`

```ts
interface EvolutionEvalPrepareRequestV1 {
  schema: "evolution-eval-prepare.v1";
  curator_lease_token: string;
  application_id: string;
  evidence_snapshot_hash: string;
  version_id: string;
  eval_input_ref: string;
  input_manifest_hash: string;
  operation: EvolutionEvalOperation;
  parameters: EvolutionEvalParametersV1;
  timeout_ms: number;
}
interface EvolutionEvalPrepareResultV1 {
  schema: "evolution-eval-prepare-result.v1";
  eval_job_id: string;
  tool_run_id: string;
  workspace_id: string;
  ordinal: 1 | 2 | 3;
  state: "submitted";
  workspace_revision: number;
  source_commit: string;
  source_manifest_hash: string;
  workspace_manifest_hash: string;
  deadline_at: string;
  effective_timeout_ms: number;
  replayed: boolean;
}
```

Core 必须从 `eval_input_ref` 解析 project、source/constraint bytes、SkillVersion、target/toolchain 与 Connector policy。
caller 严禁提交或覆盖 `project_id`、`run_class`、workspace/Host path、Connector ID、raw Tcl/command、任意 source bytes、
formal/gate/baseline/approval/adopt/publish/download/program 字段。`parameters.operation` 必须与顶层 operation 相等，
prepare 时所有 path 必须安全且属于 Core input，或是本 job 后续允许创建的 overlay path；submit 时所有引用 path 必须
实际存在于 sealed manifest，part/toolchain 必须与 Core binding 相等。prepare 创建 immutable job binding 和尚未 seal 的
隔离 workspace；write 可补齐声明的新 testbench/source overlay，但不能改变已冻结的 operation/parameters/request hash。
Core 可在任何业务写前使用已持久化的 discovery/license ledger 做 capability preflight；明确不可用时返回 503 且零业务写。
通过后，prepare 在锁 run/budget 的单一数据库事务中创建 `submitted tool_run + immutable eval job binding + workspace binding +
revision 1 + audit`，所以返回的 `tool_run_id/connector_job_id` 在任何外部调用前已经 durable。prepare 不调用 Connector，
也不创建 dispatch outbox。此 `submitted` 表示 Core 已接受但尚未 seal/dispatch 的 eval draft，不表示 Connector 已接受。

2. `POST /api/v1/internal/evolution/curator-runs/:runId/eval-jobs/:evalJobId/workspace/read`

body `{schema:"evolution-eval-workspace-read.v1",curator_lease_token,workspace_id,workspace_revision,paths:string[]}`，
其中 1–32 个唯一 path；返回 `{schema:"evolution-eval-workspace-files.v1",workspace_id,workspace_revision,
workspace_manifest_hash,files:[{path,sha256,size_bytes,media_type,read_only,content_base64}]}`。只能读取 manifest 中的源、
固定 Skill 或 overlay 文件；ACL/binding 不匹配统一 conceal。

3. `POST /api/v1/internal/evolution/curator-runs/:runId/eval-jobs/:evalJobId/workspace/write`

body `{schema:"evolution-eval-workspace-write.v1",curator_lease_token,workspace_id,expected_workspace_revision,
changes:({action:"upsert",path,sha256,content_base64}|{action:"delete",path})[]}`；返回
`{schema:"evolution-eval-workspace-result.v1",workspace_id,workspace_revision,workspace_manifest_hash,
file_count,total_bytes,replayed}`。只在 job state=`submitted`、没有 dispatch fact 且未 seal 时允许，并执行 B.2 的
CAS、类型、扫描和预算。

4. `POST /api/v1/internal/evolution/curator-runs/:runId/eval-jobs/:evalJobId/submit`

body `{schema:"evolution-eval-submit.v1",curator_lease_token,workspace_id,expected_workspace_revision,
expected_workspace_manifest_hash}`；首次成功响应 `EvolutionEvalStatusV1(state="submitted")`。Core 在同一事务重验
run/lease/budget/serial/binding、operation/paths/part/toolchain/trial-bitstream policy，seal workspace，保持已有
`tool_run.state=submitted`，并写唯一 `(eval_job_id,"dispatch")` outbox/audit，然后先 commit。dispatch fact 区分未 seal draft
和已 seal dispatch-pending；二者 ToolRun state 都是 submitted。
submit 不创建第二个 tool_run/job ID；在数据库事务内、commit 前或没有 durable outbox 时绝不调用 Connector。
seal 事务同时从 sealed manifest 计算 `sealed_input_projection_hash`，再从完整 dispatch policy（含该 projection hash）计算
`dispatch_request_hash` 并插入唯一 append-only
`evolution_eval_dispatch` fact；唯一 dispatch outbox 携带/绑定该 hash，异 hash replay 返回 idempotency conflict。

dispatcher 只消费已 commit outbox，以持久化的 Connector endpoint/job ID/key、absolute deadline、
`run_class=evolution_eval`、operation、sealed workspace hash、sealed input projection hash/toolchain/typed parameters 工作。
发送给 Connector 的 manifest/files 只能是上述 source+overlay projection，Skill metadata/bytes 永不进入 wire。每次启动、进程重启和 outbox replay
都先在事务外 query/preflight 同一 Connector job ID、capability/class/license。若确定尚未产生外部效果且 policy reject、cancel
或 deadline 已到，Core 只走现有合法边 `submitted→rejected`，不发送 job。若 ledger 已存在则只 reconcile；只有 ledger
明确 never accepted 且仍满足 policy/deadline 时才准备以原 ID/key/payload submit，绝不 blind redispatch 或生成新 ID。

真正可能产生外部效果前，Core 在一个短数据库事务中对现有全局 machine 逐边验证并 append audit：
以统一锁序 `curator_run→evolution_eval_run→evolution_eval_job/tool_run→dispatch fact` 获取行锁，CAS 重验
`tool_run.state=submitted`、dispatch fact 存在、dispatch tombstone 不存在、policy/deadline 仍有效；随后
`submitted→queued→preparing→running`，每边 append audit 后 commit，commit 后才允许 Connector submit RPC。`queued/preparing` 不能在
事务外可观察、恢复或停留；每条 audit 明确这是 dispatch fencing，Core `running` 的含义是 `effect_possible=true`，不是
伪称 Connector/Vivado 已经运行。Connector 回报的 queued/preparing 只作为 reconciliation metadata，Core 不倒退 state。
所有 Connector query/submit 都发生在 commit 后，结果写入另一个短事务。dispatch 时重新计算 deadline-Core now 作为是否
仍可派发的门；实际 Connector payload始终使用
dispatch fact 中不变的 requested timeout/operation cap/absolute deadline，Connector 再以自己的 now 执行同一
`min(requested,cap,deadline-now)`，从而 replay payload/hash 不随网络延迟漂移。remaining≤0 时不提交；
若已进入 Core running 后 Connector durable reject/never-accepted/capability drift，则走现有 `running→failed` 并使用
`EVOLUTION_EVAL_NOT_ACCEPTED|EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE`；无法确认是否执行则 `running→unknown_effect`。
B.5 的 503/零写只适用于进入 effect-possible fence 前的 preflight。

5. `POST /api/v1/internal/evolution/curator-runs/:runId/eval-jobs/:evalJobId/status`

body `{schema:"evolution-eval-status-request.v1",curator_lease_token}`；返回 `EvolutionEvalStatusV1`。Core 可用同 Connector job ID
reconcile，但只有 Core 写 `tool_run.state`。需要外部 query 时先在短事务提交唯一 reconcile intent/outbox，再由 dispatcher
在事务外 query，同步请求可以等待第二事务的结果后返回；不能在持锁事务中 RPC。Connector timeout 只有在确认进程停止
时才映射 timeout；Connector `lost` 或任何不确定结果映射 unknown_effect，不得用 HTTP 200 假装 success。

5a. `POST /api/v1/internal/evolution/curator-runs/:runId/eval-jobs/recover`

body `{schema:"evolution-eval-recover.v1",curator_lease_token}`；返回 A.6 的 exact `eval_recovery` object。Core 为每个
in-flight job 先提交唯一 reconcile intent，commit 后以持久 ID/key query-first，再在新事务更新状态/reconciliation flag；
返回前每个 job 必须是 confirmed/not_needed，或在暂时不可达时显式 required。此 route 让 holder 在 claim 后重复安全恢复，
不接受 job ID 列表，因此不能漏掉或探测其他 run；存在 required 时仍禁止 prepare/write/submit。

6. `POST /api/v1/internal/evolution/curator-runs/:runId/eval-jobs/:evalJobId/cancel`

body `{schema:"evolution-eval-cancel.v1",curator_lease_token,reason_code:string}`；返回 `EvolutionEvalStatusV1`。
submitted draft/dispatch-pending 尚未进入 effect-possible fence 时，cancel 按 dispatcher 相同锁序在一个事务 append immutable
dispatch tombstone/audit，并走 `submitted→rejected`，error_code=`EVOLUTION_EVAL_CANCELLED_BEFORE_DISPATCH`，不删除、覆盖或
撤销原 dispatch fact/outbox。旧 outbox consumer 获取相同行锁后发现 state 非 submitted 或 tombstone 存在，只能将 event
永久 consume/no-op 并追加审计，不能 fence/RPC。若 dispatcher 先获得锁并 commit running，cancel 后获得锁并进入 running
安全路径；若 cancel 先获得锁，dispatcher 必须 no-op。running 时先 append durable
cancel intent/audit 而保持 `running`，commit 后才以同 Connector job ID cancel/query；确认停止后在一个事务逐边
`running→cancelling→cancelled`，确认因 deadline 停止可走 `running→timeout`，无法确认则直接
`running→unknown_effect`。永不执行 `cancelling→unknown_effect`，也不让 cancelling 成为事务外稳定态。terminal replay
返回原事实；cancel HTTP 不在数据库事务内 RPC。

7. `POST /api/v1/internal/evolution/curator-runs/:runId/eval-jobs/:evalJobId/evidence`

strict body 是三选一：

- `{schema:"evolution-eval-evidence.v1",curator_lease_token,action:"freeze"}`；
- `{schema:"evolution-eval-evidence.v1",curator_lease_token,action:"ack",expected_manifest_hash}`；
- `{schema:"evolution-eval-evidence.v1",curator_lease_token,action:"read",name,expected_sha256}`。

freeze 仅允许 Connector 曾接受且可能有 output 的 terminal job；pre-dispatch rejected、durable NOT_ACCEPTED 与
unknown_effect 保持 evidence_state=none，freeze 返回 evidence-not-ready。Core 先提交唯一 freeze intent/outbox；
commit 后 dispatcher 才向 Connector 取完整
manifest/entries，在新事务中验证并 append-only 保存 content-addressed bytes、manifest、entries、audit。pending 返回
`{schema:"evolution-eval-evidence-pending.v1",eval_job_id,action:"freeze"|"ack",duty_state:
"freeze_pending"|"ack_pending",replayed}`；完成后返回 `{schema:"evolution-eval-evidence-manifest.v1",eval_job_id,
tool_run_id,manifest_hash,evidence_state:"frozen",retention_state:"pending_ack"|"acknowledged",entries:[{name,sha256,size_bytes,media_type,
artifact_classification:"experimental/evolution_eval"|"evolution_eval_evidence",usage_classification:
"evolution_eval_only"}],replayed}`。

Core 只在完整 manifest/bytes 已 durable commit 后接受 ack mutation；ack 先提交唯一 ack outbox，commit 后 Connector 记录
Core ack，随后 Core 写 `retention_state=acknowledged`。一旦 valid bytes/manifest 已在 Core 完整 frozen，`frozen` 即是 run 内可归因的 evidence
终局，Curator complete 不等待 Connector ack；ack/retention/cleanup outbox 变为不依赖 Curator lease/run 的后台义务。
Connector 必须保留全部 output 到同 manifest hash 的 Core ack 成功为止，v1 没有短 lease 自动清理；只有 acknowledged
后才可正常 cleanup。Connector retention expiry 不删除 Core frozen copy；read 只读已经 frozen 的 Core copy，返回
`{schema:"evolution-eval-evidence-content.v1",name,sha256,size_bytes,media_type,content_base64}`，不访问 Connector。

每 manifest 最多 128 entries、单 entry 最多 64 MiB、解码后总量最多 256 MiB；name 必须唯一并匹配下述 regex；
media type 只允许 `application/json|text/plain|application/octet-stream`，且 `.json` 必须为 application/json，
`.rpt/.log/.tcl` 必须为 text/plain，`.bit/.dcp` 必须为 application/octet-stream。evidence canonical manifest exact shape 是
`{schema:"evolution-eval-evidence-manifest.v1",eval_job_id,tool_run_id,entries:[{name,sha256,size_bytes,media_type,
artifact_classification,usage_classification}]}`，entries 按 name bytewise 升序后按 B.1 JCS/hash。partial、缺失、超限、
name/media/hash 不符或再次 freeze 得到不同 manifest 均 fail closed；未完整 freeze 的 evidence 不能进入 Curator evaluation。

暂时 transport/fetch failure 是 retryable `freeze_pending + reconciliation_required`，不得改写为 corrupt。只有完整获取后
确定性发现 partial、hash/name/media/limit/canonical-manifest 不一致，才在同一事务写 immutable `evidence_state=corrupt`、
安全 metadata/hash/error fact、audit 与唯一 cleanup intent/outbox；不把 raw corrupt bytes 写入 Core content store。事务 commit
前必须已存在来自更早已提交事务的唯一 `freeze_pending`；`freeze_pending+corrupt` 同事务或预种 orphan facts 均拒绝。corrupt、
quarantine intent 与 cleanup intent 必须同一 transaction origin 原子提交。
后 cleanup dispatcher 自动向 Connector 发送绑定 error fact hash 的 `corrupt_ack`，使其进入不可读 quarantine；这不是 valid
evidence ack，不依赖 Evaluator 再调用一个 route，outbox 重放仍使用同 job ID/fact hash。

Connector 单 job evidence spool 上限等于 256 MiB；所有未 ack 的 evolution_eval output 全局 hard cap 为 2 GiB，Core/Connector
在 prepare、submit seal 前和 effect-possible fence 前重验，满时 `503 EVOLUTION_EVAL_SPOOL_FULL` fail closed。prepare/submit
同步错误零业务写；已 seal dispatch-pending 若随后遇满则保持 submitted 等待恢复，不能绕 cap，deadline 到后 rejected。
正常 output 保留至 Core valid ack，但绝对不超过
job terminal time + 7 天；到期前 Core/Connector 必须 query-first 尝试 freeze/ack，仍未完成则双方 append immutable
`retention_state=expired` fact，Core 同事务写唯一 cleanup intent/outbox。retention expiry 不改变先前 frozen conclusion；
expired 必须绑定更早已提交的 frozen manifest hash、job 已 terminal+7d 且不存在 acknowledged fact；expired 与 frozen 同事务、
无 frozen conclusion、已 acknowledged 或缺少同事务 cleanup intent 均拒绝。
没有 frozen conclusion 的 job 已在 2h cutoff 固定为 unavailable_at_deadline。corrupt/unavailable 均禁止成为评价证据；
corrupt_ack 后 output 不可读 quarantine 并要求 24h 内
物理删除，所有 output 无论如何 7 天为绝对删除上限。清理/删除以同 job ID/outbox 恢复，历史只留 metadata/hash/error，
不留 raw corrupt/expired bytes。

durable corrupt/unavailable_at_deadline 是 evidence 终局，不是永久 blocking state：受影响 application/primary version 被强制
`inconclusive + no_op`；Core 已提交 cleanup intent 后允许 Curator complete，不等待 Connector cleanup ack。accepted terminal
且 evidence 有效的 job 只需在 Core frozen。这样全局 scheduler 和 spool 不会因一个坏 manifest 或后台 ack 永久死锁。

`evolution_eval_run.deadline_at`（最迟 budget_started_at+2h）同时是 run 内 evidence cutoff。deadline handler 在统一 run/job
锁事务中先保证没有非终态稳定 job：submitted 追加 tombstone 后 rejected；running 若已确认停止则 timeout，未确认则
unknown_effect。随后逐 job处理 evidence：若 valid manifest/bytes 已 Core frozen，保留 frozen 并允许评价；若未完整 frozen（包括 Connector
暂时不可达/freeze_pending），原子 append immutable `evidence_state=unavailable_at_deadline`、audit 与 retention/cleanup intent，
强制该 application/primary `inconclusive + no_op`，并让 Curator fail 返回 EVIDENCE_REQUIRES_COMPLETE。该 terminal fact 永久
不可被迟到 bytes、后台 freeze/ack 或人工重放升级/覆盖。run 可在 fact+intent commit 后 complete，不等待 Connector。

eval run 关闭后所有 Evaluator routes 仍永久关闭，包括 A.5 将同一 failed Curator row 重置为 queued/running 的后续
evidence-only attempt；lease/run-independent 后台 outbox consumer 只能以既有 job ID、dispatch/evidence
hash 做 query-first retention、必要的 freeze/hash verification、ack 或 cleanup，不能新建 job、改变
unavailable_at_deadline/corrupt/evaluation/lifecycle。retention expired 也不能覆盖 frozen conclusion。迟到 bytes 只用于安全
清理协议，不成为 Core valid evaluation evidence。
7 天是 Connector spool 后台硬删上限而不是 active run 时长；active Curator run 必须在 2h boundary 结束评价/释放 scheduler，
任何 Connector unavailable 跨 deadline 场景都不能继续占用 active run。

逐 route 状态矩阵如下。所有“允许”仍要求 exact scope、当前 Curator lease、run/job binding 和 ACL；CuratorRun 一旦
completed/dry_run_complete/failed，Evaluator routes 永久关闭。run 必须等全部 DB eval job terminal 且 evidence 进入
frozen/corrupt/unavailable_at_deadline/合法 none 终局
后才能结束，因此安全收尾不会依赖终态 run 的 Evaluator token。

| Route/action | 正常 active run | rollout off / Pause | deadline 已到 | unknown latch / reconciliation required |
|---|---|---|---|---|
| prepare | 允许 | 403 forbidden | 409 budget exhausted | 409 run not active / reconciliation required |
| workspace write | 仅 submitted+无dispatch+unsealed | 403 forbidden | 409 budget exhausted | 409 run not active / reconciliation required |
| submit | 仅 submitted+无dispatch+unsealed | 403 forbidden | 409 budget exhausted | 409 run not active / reconciliation required |
| workspace read | 允许必要只读 | 允许安全收尾 | 允许安全收尾 | 允许安全收尾 |
| status / recover | 允许并 query-first | 允许安全收尾 | 允许；触发 deadline cancel | 允许且必须先 reconcile |
| cancel | 非终态允许 | 允许安全收尾 | 允许/自动触发 | 允许安全收尾；terminal replay 只读 |
| evidence freeze / ack | 仅 terminal/合法 evidence state | 允许安全收尾 | deadline handler 先决议 frozen/unavailable；ack 可后台 | 允许安全收尾 |
| evidence read | 仅 frozen Core copy | 允许安全收尾 | 允许安全收尾 | 允许安全收尾 |

deadline 是 Core 绝对时间：到点后 dispatcher 必须创建 durable cancel intent；确认进程停止才投影 timeout，不能确认即
unknown_effect。未 dispatch 的 submitted draft 到点按统一锁序 append tombstone 后走 rejected。Pause/rollout/deadline/latch 从不阻断
status/recover/cancel/必要 read/freeze/ack，也不会授权新的 write/submit。
Pause/rollout off 或 Curator 显式放弃时，所有尚未进入 effect-possible fence 的 submitted draft/dispatch-pending 必须在锁 run
的事务中 append tombstone 并走 `submitted→rejected`；原 outbox 保留并由 consumer no-op，不能遗留一个无法 complete/fail 的 draft。

成功 HTTP 状态冻结如下；不得用其他状态表达同一业务结果：

| Route | 首次成功 | 幂等 replay / 已终态读取 |
|---|---:|---:|
| `.../eval-jobs/prepare` | 201 | 200 |
| `.../workspace/read` | 200 | 200 |
| `.../workspace/write` | 200 | 200 |
| `.../submit` | 202 | 200 |
| `.../status` | 200 | 200 |
| `.../recover` | 200 | 200 |
| `.../cancel` | 202（durable intent）或 200（pre-dispatch rejected） | 200 |
| `.../evidence` action=`freeze` | 202（pending）或 200（已 frozen） | 202 或 200 |
| `.../evidence` action=`ack` | 202（pending）或 200（已 acknowledged） | 202 或 200 |
| `.../evidence` action=`read` | 200 | 200 |

evidence `name` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$`；任何 query-string content、generic evidence
route、GET/PUT/PATCH/DELETE 别名均不存在并返回 404。

A.6 的 `complete`/`fail` 仍是唯一 CuratorRun 终结 route，不为 Evaluator 增加别名。B 版冻结 A.6 complete 中每个
evaluation 的 exact shape 为 `{application_id,evidence_snapshot_hash,outcome,confidence,reason,evidence_refs,
eval_job_refs:[{eval_job_id,tool_run_id,evidence_manifest_hash:string|null}],supersedes_id}`；确实没有 Vivado 补评时传空数组。
Core 不信任 refs：complete 和 fail 都在锁 run 的事务中查询该 run 的全部 DB eval job，任何非终态 job、required
reconciliation 或未完成的 run 内 evidence 决议都拒绝结束。凡 Connector ledger 已接受的 succeeded/failed/cancelled/timeout
job 都必须 Core frozen，或具有 durable corrupt/unavailable_at_deadline fact + retention/cleanup intent；Connector ack
是后台义务，不阻塞 complete。pre-dispatch rejected、durable NOT_ACCEPTED
和 unknown_effect 可为 evidence_state=none。
complete 中每个 application 的 `eval_job_refs` 必须与 DB 中该
application 的 job 集合精确相等，不能省略 job 绕过校验；非 unknown job 被用作证据时 manifest/hash 必须完整可追溯，
unknown/corrupt/unavailable_at_deadline/rejected job 的 hash 为 null。Curator lease complete/fail 的幂等、CAS 与
redaction 语义不变。

若 DB 中存在任一 unknown_effect job，Curator `fail` 无论 retryable 值都返回
`409 EVOLUTION_EVAL_UNKNOWN_REQUIRES_COMPLETE` 且零业务写；若存在任一 corrupt/unavailable_at_deadline
evidence，则返回
`409 EVOLUTION_EVAL_EVIDENCE_REQUIRES_COMPLETE` 且零业务写。两者都只能走 complete：Core 从 DB 强制每个受影响
application 的 outcome=`inconclusive`，并强制其 primary version 的 remediation=`no_op`；缺少、冲突或试图 patch/state
action 均 409。Core 不自动伪造 Curator 输出，但拒绝所有不等价 complete，因此 fail 不能绕过这些事实。

### B.4 `unknown_effect` 与崩溃恢复

以下任一情况无法以同 Connector job ID 证明“从未执行或已经终止”，只能落 terminal `unknown_effect`：submit 已发出但
响应丢失且重启后 Connector 找不到/无法确认；cancel/timeout 后无法确认进程已停止；Connector/Host 丢失导致执行结果
在 deadline/definitive recovery failure 后仍不可判定。短暂 transport unavailable 先保持原状态+
`reconciliation_state=required`，不立即猜成 unknown；但到 deadline 仍不能确认，或 durable ledger 已损坏/丢失时必须
unknown。它不能降格为 failed/cancelled/timeout，不能自动复活、覆盖或以同/新 ID 重跑；它计入 3-job 和 2h 预算，
并在锁住 run 的事务中与 tool_run terminal、run latch、audit/outbox 原子写入，禁止该 Curator run 再启动 Connector job。
数据库锁序为 `run→job→tool_run`，并以不可伪造 transaction origin 在 deferred commit guard 中拒绝 latch 同事务或之后的
prepare、dispatch 与 `submitted→queued`；并发双方无论谁先取得 run lock，都只能有一方提交其 effect-possible 动作。
reclaim 先以原 Connector job ID/key + dispatch_request_hash query/reconcile；只有 durable ledger 证明 never accepted/never
execute 时才允许原 payload replay；若决定终止，尚为 submitted 则 rejected，已进入 effect-possible running 则
failed/NOT_ACCEPTED。只有确证执行进程终止才落 cancelled/timeout。

`unknown_effect` evidence 只能作为不可归因背景；对该 job 绑定的 application 与 primary version，Curator 必须提交
`outcome=inconclusive` 且对应 remediation=`no_op`，不能得出 success/applicability_failure/execution_failure，也不能自动
patch/scope/state action。run latch 只禁止后续 Connector job；其他 application 仍可基于已有真实证据做 evidence-only 评价。
Core 按 DB 全量 job/application binding 强制该规则，即使 complete body 省略/伪造 refs 也不能绕过。v1 不提供
operator/manual 改判 route；人工 resolution 延期，原 terminal fact 永不静默改变。Evaluator/Curator lease 过期本身不取消
Connector job；新 claim holder 必须先 reconcile。Curator fail 只有在没有 submitted/running/reconciliation-required/
unknown job、也没有 corrupt/unavailable_at_deadline evidence 时才可能提交；是否 requeue 仍遵循 A.6 retry 语义。

### B.5 稳定错误

| HTTP / error_code | retryable | DB 改变 | 语义 |
|---|---|---|---|
| 400 `EVOLUTION_EVAL_INVALID_REQUEST` | 否 | 否 | strict shape、path/hash/base64/typed parameters 非法 |
| 400 `EVOLUTION_EVAL_OPERATION_FORBIDDEN` | 否 | 否 | 非四项 allowlist、raw Tcl/command/hardware/formal 字段 |
| 400 `EVOLUTION_EVAL_TIMEOUT_INVALID` | 否 | 否 | timeout 非正整数或超 operation cap |
| 413 `EVOLUTION_EVAL_RESOURCE_LIMIT` | 否 | 否 | source/skill/overlay/read/write/full workspace 超 B.2 上限 |
| 401 `AUTHENTICATION_REQUIRED` | 否 | 否 | 缺失/无效 token |
| 403 `EVOLUTION_SCOPE_FORBIDDEN` | 否 | 否 | 非 exact singleton `core:evolution-eval` 或混 scope |
| 403 `EVOLUTION_EVAL_FORBIDDEN` | 否 | 否 | rollout off、Pause Learning、dry-run 或禁用动作 |
| 404 `EVOLUTION_EVAL_NOT_FOUND` | 否 | 否 | run/job/application/ACL/reservation/binding conceal |
| 409 `EVOLUTION_LEASE_CONFLICT` | 是 | 否 | Curator lease 旧、过期或不匹配 |
| 409 `EVOLUTION_EVAL_BINDING_CONFLICT` | 否 | 否 | version/evidence/input/workspace manifest 不一致 |
| 409 `EVOLUTION_EVAL_IDEMPOTENCY_CONFLICT` | 否 | 否 | 同 action/Header key 异 logical/dispatch hash |
| 409 `EVOLUTION_EVAL_BUDGET_EXHAUSTED` | 否 | 否 | 已有 3 job、deadline 已到或剩余 timeout 为零 |
| 409 `EVOLUTION_EVAL_SERIAL_CONFLICT` | 是 | 否 | 前一 ordinal 尚非 terminal |
| 409 `EVOLUTION_EVAL_RUN_NOT_ACTIVE` | 否 | 否 | run 非 mode=run/running 或 unknown latched；deadline 只映射 budget exhausted |
| 409 `EVOLUTION_EVAL_WORKSPACE_SEALED` | 否 | 否 | submit 后 write/delete |
| 409 `EVOLUTION_EVAL_TERMINAL_CONFLICT` | 否 | 否 | terminal job 的非幂等 submit/write；cancel 同 key replay 返回事实 |
| 409 `EVOLUTION_EVAL_EVIDENCE_NOT_READY` | 是 | 否 | job 未 terminal 或完整 manifest 尚不可得 |
| 409 `EVOLUTION_EVAL_RECONCILIATION_REQUIRED` | 是 | 可追加 intent/audit | in-flight/响应丢失状态不能安全开启新工作/结束 run |
| 409 `EVOLUTION_EVAL_UNKNOWN_REQUIRES_COMPLETE` | 否 | 否 | unknown job 禁止 Curator fail，只能受约束 complete |
| 409 `EVOLUTION_EVAL_EVIDENCE_REQUIRES_COMPLETE` | 否 | 否 | corrupt/unavailable_at_deadline 禁止 Curator fail，只能受约束 complete |
| 502 `EVOLUTION_EVAL_EVIDENCE_CORRUPT` | 否 | 原子写 corrupt fact+audit+cleanup intent | 完整获取后确定性发现 partial/超限/hash/name/media/canonical mismatch |
| 503 `EVOLUTION_EVAL_CONNECTOR_UNAVAILABLE` | 是 | preflight 零写；收尾可追加 intent/audit | transport 暂时不可用，保留原状态+required，不自动伪造 terminal |
| 503 `EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE` | 是 | 仅 commit 前 preflight 零写 | ledger 显示 operation/class/license 不可用 |
| 503 `EVOLUTION_EVAL_SPOOL_FULL` | 是 | 否 | 全局 unacked evolution_eval spool 已达 2 GiB，接受新 job 前 fail closed |

错误发生后的 envelope 仍带 correlation_id。只有表中明确允许的 audit/intent 可写；其他 HTTP error 必须零业务写。
commit 后 dispatch 发现 capability/license drift 不再返回上述 503，而是以 status 投影 terminal
error_code。尚在 submitted/pre-send 的 cancel、deadline、capability/policy reject 统一合法投影为 `rejected`，分别使用
`EVOLUTION_EVAL_CANCELLED_BEFORE_DISPATCH|EVOLUTION_EVAL_DEADLINE_BEFORE_DISPATCH|
EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE`；已经进入 effect-possible running 后的 durable capability reject/never accepted
投影 `failed/EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE|EVOLUTION_EVAL_NOT_ACCEPTED`。这些是 status 中的 job error_code，
不是把异步失败伪装成同步 HTTP error。transient evidence fetch failure 使用 connector unavailable/reconciliation required，
不得使用 non-retryable corrupt code。

A.2 的稳定错误继续支配人类控制、task Runtime、Distiller、Scheduler 和 Curator routes；B.5 只对附录 B exact routes
作 route-specific override。特别是 `EVOLUTION_EVAL_FORBIDDEN` 只用于 prepare/write/submit，安全收尾 route 按 B.3 状态矩阵
继续允许；任何未在 B.5 覆盖的 A.2 code/HTTP 不得被实现重新解释。

### B.6 operation、码流、治理与 redaction 边界

allowlist 精确为 `validate_sources|simulate|synthesize|implement`；Connector discovery 中四者必须逐项显式包含
`evolution_eval`，其他 operation 不得包含该 class。禁止 discover/query/report/raw Tcl、caller command、
`write_cfgmem`、`program_hw*`、hardware manager/target/device、网络和任意进程入口。`implement` 可以产生 `.bit`，但 Core
必须对 `.bit` entry 同时写 `artifact_classification=experimental/evolution_eval` 与
`usage_classification=evolution_eval_only`；它不是 formal bitstream，永远不能满足 gate/formal input、ApprovedGateResult、
baseline、release、delivery manifest、publish 或 hardware download 查询，也不能复制/写回 project workspace。
所有 formal/gate/baseline/release/delivery selector 必须双重拒绝：先要求 `tool_run.run_class=formal`，再独立排除任一
experimental/evolution_eval 或 evolution_eval_only classification；不能只依赖其中一个字段。任何 adopt/approve/baseline/
publish/download/project write route 对 Evaluator 均拒绝。

原始 source、workspace 文件、log/evidence content 保持 source project ACL 与 classification；全局 Skill/application/evaluation
projection 只暴露允许的 redacted summary、count 和 hash。Evaluator 只能凭当前 binding 读取；Curator complete 再次按当前
actor/source ACL redaction。追溯链必须可以从 `curator_evaluation → evidence refs → evolution_eval_job binding → tool_run →
frozen evidence manifest/entries/hash` 完整验证，同时无权用户只能看到 redacted/hash，不能借 eval ID 探测跨项目存在性。
CuratorRun 结束后 `core:evolution-eval` route 永久关闭，不能靠旧 token 读历史；A.1 的 ACL-aware application/evaluation detail
至少长期返回 eval/tool refs（无权时 redacted）、operation、terminal state、manifest/entry hash/size/media metadata，使审计者
不依赖 Connector workspace 也能验证链。历史 evidence 内容读取延期到 M5，并不允许 M4 实现保留 Evaluator 后门。
