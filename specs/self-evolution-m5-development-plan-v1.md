# Synthia Self-Evolution M5 开发计划与冻结合同候选 v1 — Revision 8

状态：冻结候选（待独立评审；**未 PASS**）

日期：2026-08-28

权威上位合同：`specs/self-evolution-v1.md`

文档修订：8（关闭 Revision 7 binding-chain review finding；仍未通过 Gate）

适用 Gate：M5-A 至 M5-E / Gate G

> 本文不是 Gate G 通过声明。在“DECISION REQUIRED”得到产品决定、本文完成独立架构与安全评审，且
> P0/P1 清零前，M5-C sandbox 和 M5-D typed Tcl 不得进入实现。本文通过后应把冻结结论回写上位合同；
> 回写前发生冲突时以上位合同为准，并 fail closed。

## 1. 范围、已完成基线与当前事实

M5 只补齐 Learned Skill 的安全执行与剩余控制/审计面，不改变以下 v1 不变量：Skill 不携带 capability，
不直接调用 Connector，不批准、建基线、发布或下载硬件；正式执行仍由主 Agent/Curator 经 Core 治理完成
（`specs/self-evolution-v1.md:18-27`）。

已完成、M5 不得重复实现的用户控制：Pin、Unpin、Archive、Restore，以及既有 Disable、Enable、Rollback。
当前 Core route 已暴露这些动作（`core/src/api/router.ts:423-453`），实现使用 human、reason、Idempotency-Key、
control revision 和事务内 lifecycle event（`core/src/api/self-evolution-handlers.ts:969-1071`）。它们仍需进入
M5-E 回归，但不属于 M5 新交付。

当前实现边界是本合同的起点：

| 当前事实 | Source-backed evidence | M5 含义 |
|---|---|---|
| Learned scripts 是数据，不可执行 | `runtime/learned-skill-tools.ts:1-14,61-108`，每个文件显式 `executable:false` | sandbox 默认关闭时保持原行为 |
| scanner 是 regex/shape gate | `core/src/services/learned-skill-scan.ts:58-121,142-169,181-283` | 只能 defense-in-depth，不能作为隔离边界 |
| trajectory sanitizer 也是模式替换 | `core/src/services/trajectory-sanitize.ts:18-68` | 不能证明任意源码/日志/客户信息已消失 |
| 主 Runtime 能建联网 Connector，并持 task Core token | `runtime/deps.ts:94-135,191-203` | 不可信脚本不得在主 Runtime 同进程执行 |
| Core/Connector 只接受四项 typed eval operation | `core/src/domain/evolution-eval.ts:261-280` | 不新增 raw Tcl/command 通道 |
| Eval API 前置拒绝 raw Tcl、command、hardware 等字段 | `core/src/api/evolution-eval-handlers.ts:52-69,164-172` | M5 不得放宽 |
| Skill layer 不进入 Connector stream，也不能成为 Vivado input | `core/src/services/evolution-eval-sealed-input.ts:135-150,252-278` | M5-D 传 IR，不传 Skill bytes |
| 历史 eval bytes 已由 Core DB 冻结 | `core/src/db/schema.sql:3912-3993` | M5 读 Core managed copy，不恢复 Evaluator token |
| public projection 已有 project ACL 与 entry metadata | `core/src/api/self-evolution-handlers.ts:250-270,672-755` | 内容 route 每次重新走同一来源 ACL |
| 当前 Runtime 把 tool args JSON-stringify 后经 string callback 持久化 | `runtime/free-agent.ts:600-605`、`runtime/agent-types.ts:192-197`、`runtime/server.ts:2183-2215` | M5 必须对三种 effect-bearing tool call 显式迁移为独立 validated object authority；其它 generic event 不改合同，不能把现状当已满足 |
| 当前 problem-family 指标刻意为 unknown | `core/src/domain/self-evolution.ts:160-183,195-244` | 只有显式 Core fact 后才可观察 |
| 评价是 append-only，但 predecessor 尚无唯一索引 | `core/src/db/schema.sql:3446-3469,3565-3567` | M5-B 必须补链唯一性与质量 revision CAS |
| 只有总 self-evolution rollout flag | `core/src/api/feature-flags.ts:79-86` | sandbox 必须新增独立默认 false flag |

M5 不修改 System Skill、模型权重、prompt、Core/Runtime/Connector 自修改规则，也不把观察性指标描述为因果提升。

## 2. DECISION REQUIRED — Learned Skill 的隐私发布域

### 2.1 不能继续假设的命题

regex sanitizer/scanner 可以拦截已知 secret、绝对路径和若干危险 API，但无法证明自由文本中不存在：项目源码片段、
日志原文、客户术语、未命中格式的 credential、可逆业务标识或多文件组合泄漏。因此“scanner pass ⇒ 可立即跨项目全局
发布”不是安全证明，并与上位合同“全局 Skill 不能泄漏项目名、源码、日志或敏感证据”
（`specs/self-evolution-v1.md:18-27`）之间存在未闭合风险。

### 2.2 方案 A（首选）— 立即项目内生效，独立审批后全局推广

自动 Distillation 成功后，exact SkillVersion 立即在来源项目成为 `project_active_unproven`，满足“即时可用”；它只对
`source_project_id` 的 ACL actor 可检索/查看/应用/执行。跨项目必须有针对**同一不可变 version manifest hash** 的独立、
append-only privacy approval，Core 才能前移 global pointer。每个 patch 都是新版本，必须重新审批，不能继承父版本批准。

现有 `learned_skill.active_version_id` 冻结为 **global approved pointer**；它只能指向当前 `global_approved` 且未被任何 privacy/quality
quarantine latch 命中的版本。来源项目 pointer 与 global pointer 完全分离，新增以下逻辑 schema；本节及后文所有 SQL block 都受
§4.1 的 exact DDL/NULL/append-only 规则约束：

```sql
learned_skill_project_activation(
  project_id text NOT NULL, skill_id text NOT NULL, active_version_id text NULL,
  control_revision bigint NOT NULL CHECK(control_revision >= 1),
  current_revision_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id, skill_id),
  FOREIGN KEY(active_version_id, skill_id) REFERENCES learned_skill_version(id, skill_id),
  FOREIGN KEY(active_version_id, project_id)
    REFERENCES learned_skill_version_publication(version_id,source_project_id)
)

learned_skill_version_publication(
  version_id text PRIMARY KEY, skill_id text NOT NULL, source_project_id text NOT NULL,
  content_manifest_hash sha256_text NOT NULL,
  state text NOT NULL CHECK (state IN
    ('project_active_unproven','privacy_review_pending','global_approved',
     'global_denied','privacy_quarantined')),
  publication_revision bigint NOT NULL CHECK(publication_revision >= 1),
  current_revision_id text NOT NULL UNIQUE,
  latest_review_id text NULL, quarantine_latched boolean NOT NULL DEFAULT false,
  audit_event_id text NOT NULL UNIQUE, outbox_event_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE(version_id,skill_id), UNIQUE(version_id,source_project_id),
  UNIQUE(version_id,skill_id,source_project_id,content_manifest_hash),
  UNIQUE(version_id,source_project_id,content_manifest_hash),
  FOREIGN KEY(version_id,skill_id) REFERENCES learned_skill_version(id,skill_id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id),
  FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK((state='privacy_quarantined') = quarantine_latched),
  CHECK((state IN ('global_approved','global_denied','privacy_quarantined') AND latest_review_id IS NOT NULL) OR
        (state IN ('project_active_unproven','privacy_review_pending')))
)

learned_skill_version_publication_revision(
  id text PRIMARY KEY, version_id text NOT NULL, skill_id text NOT NULL, source_project_id text NOT NULL,
  content_manifest_hash sha256_text NOT NULL,
  publication_revision bigint NOT NULL CHECK(publication_revision >= 1),
  state text NOT NULL CHECK(state IN
    ('project_active_unproven','privacy_review_pending','global_approved',
     'global_denied','privacy_quarantined')),
  latest_review_id text NULL, quarantine_latched boolean NOT NULL,
  audit_event_id text NOT NULL UNIQUE, outbox_event_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  UNIQUE(id,version_id,skill_id,publication_revision),
  UNIQUE(version_id,skill_id,publication_revision), UNIQUE(version_id,publication_revision),
  FOREIGN KEY(version_id,skill_id) REFERENCES learned_skill_version(id,skill_id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id),
  FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK((state='privacy_quarantined') = quarantine_latched),
  CHECK((state IN ('global_approved','global_denied','privacy_quarantined') AND latest_review_id IS NOT NULL) OR
        (state IN ('project_active_unproven','privacy_review_pending') AND latest_review_id IS NULL))
)

ALTER TABLE learned_skill_version_publication
  ADD UNIQUE(current_revision_id,version_id,skill_id,publication_revision),
  ADD FOREIGN KEY(current_revision_id,version_id,skill_id,publication_revision)
    REFERENCES learned_skill_version_publication_revision(id,version_id,skill_id,publication_revision)
    DEFERRABLE INITIALLY DEFERRED;

learned_skill_project_activation_revision(
  id text PRIMARY KEY, project_id text NOT NULL, skill_id text NOT NULL,
  control_revision bigint NOT NULL CHECK(control_revision >= 1),
  from_active_version_id text NULL, to_active_version_id text NULL,
  action text NOT NULL CHECK(action IN ('distill_activate','curator_patch','human_rollback','privacy_fallback','quality_fallback','clear')),
  reason text NOT NULL, actor_type actor_type NOT NULL, actor_id text NOT NULL,
  audit_event_id text NOT NULL, outbox_event_id uuid NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE(id,project_id,skill_id,control_revision),
  UNIQUE(id,audit_event_id,outbox_event_id), UNIQUE(project_id,skill_id,control_revision),
  FOREIGN KEY(from_active_version_id,skill_id) REFERENCES learned_skill_version(id,skill_id),
  FOREIGN KEY(to_active_version_id,skill_id) REFERENCES learned_skill_version(id,skill_id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

learned_skill_project_activation_event(
  id text PRIMARY KEY, revision_id text NOT NULL, project_id text NOT NULL, skill_id text NOT NULL,
  control_revision bigint NOT NULL, audit_event_id text NOT NULL UNIQUE, outbox_event_id uuid NOT NULL UNIQUE,
  event_hash sha256_text NOT NULL UNIQUE, created_at timestamptz NOT NULL,
  UNIQUE(revision_id,project_id,skill_id,control_revision),
  FOREIGN KEY(revision_id,project_id,skill_id,control_revision)
    REFERENCES learned_skill_project_activation_revision(id,project_id,skill_id,control_revision),
  FOREIGN KEY(revision_id,audit_event_id,outbox_event_id)
    REFERENCES learned_skill_project_activation_revision(id,audit_event_id,outbox_event_id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

ALTER TABLE learned_skill_project_activation
  ADD FOREIGN KEY(current_revision_id,project_id,skill_id,control_revision)
    REFERENCES learned_skill_project_activation_revision(id,project_id,skill_id,control_revision)
    DEFERRABLE INITIALLY DEFERRED;

-- Authoritative global pointer projection. learned_skill.active_version_id is only a guarded compatibility mirror.
learned_skill_global_activation(
  skill_id text PRIMARY KEY, active_version_id text NULL, active_publication_revision bigint NULL,
  global_control_revision bigint NOT NULL CHECK(global_control_revision >= 1),
  current_revision_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE(skill_id,active_version_id),
  CHECK((active_version_id IS NULL) = (active_publication_revision IS NULL)),
  FOREIGN KEY(active_version_id,skill_id) REFERENCES learned_skill_version(id,skill_id),
  FOREIGN KEY(active_version_id,skill_id,active_publication_revision)
    REFERENCES learned_skill_version_publication_revision(version_id,skill_id,publication_revision)
)

learned_skill_global_activation_revision(
  id text PRIMARY KEY, skill_id text NOT NULL,
  global_control_revision bigint NOT NULL CHECK(global_control_revision >= 1),
  from_active_version_id text NULL, from_publication_revision bigint NULL,
  to_active_version_id text NULL, to_publication_revision bigint NULL,
  action text NOT NULL CHECK(action IN
    ('privacy_approve','human_rollback','privacy_fallback','quality_fallback','clear')),
  reason text NOT NULL, actor_type actor_type NOT NULL, actor_id text NOT NULL,
  audit_event_id text NOT NULL, outbox_event_id uuid NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE(id,skill_id,global_control_revision), UNIQUE(id,audit_event_id,outbox_event_id),
  UNIQUE(skill_id,global_control_revision),
  CHECK((from_active_version_id IS NULL) = (from_publication_revision IS NULL)),
  CHECK((to_active_version_id IS NULL) = (to_publication_revision IS NULL)),
  FOREIGN KEY(from_active_version_id,skill_id,from_publication_revision)
    REFERENCES learned_skill_version_publication_revision(version_id,skill_id,publication_revision),
  FOREIGN KEY(to_active_version_id,skill_id,to_publication_revision)
    REFERENCES learned_skill_version_publication_revision(version_id,skill_id,publication_revision),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

learned_skill_global_activation_event(
  id text PRIMARY KEY, revision_id text NOT NULL, skill_id text NOT NULL,
  global_control_revision bigint NOT NULL,
  audit_event_id text NOT NULL UNIQUE, outbox_event_id uuid NOT NULL UNIQUE,
  event_hash sha256_text NOT NULL UNIQUE, created_at timestamptz NOT NULL,
  UNIQUE(revision_id,skill_id,global_control_revision),
  FOREIGN KEY(revision_id,skill_id,global_control_revision)
    REFERENCES learned_skill_global_activation_revision(id,skill_id,global_control_revision),
  FOREIGN KEY(revision_id,audit_event_id,outbox_event_id)
    REFERENCES learned_skill_global_activation_revision(id,audit_event_id,outbox_event_id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

ALTER TABLE learned_skill_global_activation
  ADD FOREIGN KEY(current_revision_id,skill_id,global_control_revision)
    REFERENCES learned_skill_global_activation_revision(id,skill_id,global_control_revision)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE learned_skill
  ADD FOREIGN KEY(id,active_version_id)
    REFERENCES learned_skill_global_activation(skill_id,active_version_id) DEFERRABLE INITIALLY DEFERRED;

learned_skill_privacy_review(
  id text PRIMARY KEY, version_id text NOT NULL, skill_id text NOT NULL,
  source_project_id text NOT NULL, content_manifest_hash sha256_text NOT NULL,
  scanner_version text NOT NULL, scan_report_hash sha256_text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve_global','deny_global','quarantine')),
  reason text NOT NULL CHECK(octet_length(reason) BETWEEN 1 AND 4096),
  reviewer_type text NOT NULL CHECK (reviewer_type IN ('service','human')),
  reviewer_id text NOT NULL, reviewer_version text NOT NULL,
  declassification_profile text NULL, declassification_ack boolean NULL,
  request_hash sha256_text NOT NULL, expected_publication_revision bigint NOT NULL CHECK(expected_publication_revision >= 1),
  audit_event_id text NOT NULL UNIQUE, outbox_event_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  UNIQUE(version_id, request_hash),
  UNIQUE(id,version_id),
  FOREIGN KEY(version_id,skill_id,source_project_id,content_manifest_hash)
    REFERENCES learned_skill_version_publication(version_id,skill_id,source_project_id,content_manifest_hash),
  FOREIGN KEY(version_id,skill_id,expected_publication_revision)
    REFERENCES learned_skill_version_publication_revision(version_id,skill_id,publication_revision),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id),
  FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK((decision='approve_global' AND reviewer_type='human' AND
         declassification_profile='human-explicit.v1' AND declassification_ack=true)
     OR (decision<>'approve_global' AND declassification_profile IS NULL AND declassification_ack IS NULL))
)

ALTER TABLE learned_skill_version_publication
  ADD FOREIGN KEY(latest_review_id,version_id)
    REFERENCES learned_skill_privacy_review(id,version_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE learned_skill_version_publication_revision
  ADD FOREIGN KEY(latest_review_id,version_id)
    REFERENCES learned_skill_privacy_review(id,version_id) DEFERRABLE INITIALLY DEFERRED;

privacy_review_run(
  id text PRIMARY KEY, version_id text NOT NULL UNIQUE, skill_id text NOT NULL,
  source_project_id text NOT NULL, content_manifest_hash sha256_text NOT NULL,
  state text NOT NULL CHECK(state IN ('queued','running','denied','quarantined','failed','cancelled')),
  run_revision bigint NOT NULL CHECK(run_revision >= 1), attempt integer NOT NULL CHECK(attempt=1),
  worker_id text NULL, lease_token_hash sha256_text NULL,
  lease_revision bigint NOT NULL CHECK(lease_revision >= 0), lease_expires_at timestamptz NULL,
  request_hash sha256_text NOT NULL, terminal_request_hash sha256_text NULL,
  terminal_review_id text NULL, error_code text NULL, details_hash sha256_text NULL,
  audit_event_id text NOT NULL UNIQUE, outbox_event_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, completed_at timestamptz NULL,
  UNIQUE(id,run_revision),
  FOREIGN KEY(version_id,skill_id,source_project_id,content_manifest_hash)
    REFERENCES learned_skill_version_publication(version_id,skill_id,source_project_id,content_manifest_hash),
  FOREIGN KEY(terminal_review_id,version_id) REFERENCES learned_skill_privacy_review(id,version_id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id),
  FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK((state='queued' AND worker_id IS NULL AND lease_token_hash IS NULL AND lease_expires_at IS NULL) OR
        (state='running' AND worker_id IS NOT NULL AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL) OR
        (state IN ('denied','quarantined','failed','cancelled') AND completed_at IS NOT NULL)),
  CHECK((state IN ('denied','quarantined') AND terminal_review_id IS NOT NULL AND error_code IS NULL) OR
        (state='failed' AND terminal_review_id IS NULL AND error_code IS NOT NULL AND details_hash IS NOT NULL) OR
        state IN ('queued','running','cancelled'))
)

privacy_review_run_revision(
  run_id text NOT NULL, run_revision bigint NOT NULL CHECK(run_revision >= 1),
  state text NOT NULL CHECK(state IN ('queued','running','denied','quarantined','failed','cancelled')),
  lease_revision bigint NOT NULL CHECK(lease_revision >= 0), fact_hash sha256_text NOT NULL,
  audit_event_id text NOT NULL UNIQUE, outbox_event_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(run_id,run_revision),
  FOREIGN KEY(run_id) REFERENCES privacy_review_run(id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id),
  FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)
```

publication 状态边精确为：

```text
project_active_unproven -> privacy_review_pending | global_approved | global_denied | privacy_quarantined
privacy_review_pending  -> global_approved | global_denied | privacy_quarantined
global_denied           -> global_approved | privacy_quarantined   (human only)
global_approved         -> privacy_quarantined
privacy_quarantined     -> privacy_quarantined                      (terminal latch)
```

任一 privacy/quality quarantine 无论在批准前后发生，都在锁序
`learned_skill → publication → privacy run/review → global activation → project activation rows (project_id bytewise)` 的**同一 CAS
事务**：写 immutable quarantine review/latch，递增 publication/global/project control revisions，把 global pointer 从该版本回退到该 Skill 最新的仍
`global_approved`、未 quarantine 且 manifest 不漂移的祖先版本（按 ancestry depth、created_at、id 唯一排序；无则 null），并把所有
指向该版本的 project activation 回退到同 source project 的最近安全祖先（无则 null），同时提交 audit/outbox。不得先暴露
quarantine 再异步清 pointer；CAS 失败整笔回滚重试。

quarantine commit 后，任一**没有 source project 当前 ACL**的 actor 对该版本的 search/view/file-content/diff/apply/run、sandbox
input、以及既有 fixed application 的 Skill content/read/run 都立即统一 404。更强的不变量是：所有 privacy-sensitive API——Skill/
Version search、summary、view、file-content、diff、apply、script-run/typed-handoff、fixed-application Skill content/read，以及它们的
ACL/binding/error 分支——在 `project_active_unproven/privacy_review_pending/global_approved/global_denied/privacy_quarantined` **每一种**
publication 状态下，所有成功与错误响应都固定同时带 `Cache-Control: no-store`、`Pragma: no-cache`、
`Vary: Authorization`；不得只在撤销后添加 header，也不得发送 `public/max-age/s-maxage/immutable/ETag` 或允许 304。只认可遵守
HTTP `no-store` 的客户端、反向代理和中间件；如果某个既有客户端/中间件过去违反该指令缓存了敏感响应，Core 不声称能通过
quarantine 或新 header 远程驱逐那份违规缓存，必须作为部署事故另行处置。既有 application/audit 只保留 redacted history
`{skill_id,version_id,content_manifest_hash,publication_state:"privacy_quarantined"}`，不返回 title/description/file/diff/output/source
project existence。source ACL actor 仍可只读检查 quarantined content，但所有 actor 都不能新 apply/run/publish；历史 ToolRun 不改判。

`publication` 的每次 state/revision edge 也必须先追加 `learned_skill_version_publication_revision`；projection 的
`current_revision_id/version/skill/publication_revision` 复合 FK 命中该不可变 fact，deferred trigger 再逐字段证明 state、review、latch、
manifest/source 与 fact 相等并要求 revision 恰好 +1。历史 revision fact 不 FK 回可变 publication projection；review 的
`expected_publication_revision` 必须命中锁内 current revision，而不能只凭 caller 数值。

`project activation` 的每条 pointer edge 都先追加 revision + event；event 通过同一 revision id 复合绑定 exact audit/outbox，projection
只指向 current revision。deferred trigger 用 SQL `IS NOT DISTINCT FROM` 强制 projection `active_version_id` 等于 current revision 的
`to_active_version_id`，并强制上一 revision 的 `to` 等于下一 revision 的 `from`；NULL clear 也不能绕过。`project activation` 和
`publication review` 都 append-only；受约束 projection 只能由 trigger 守护的 Core transaction 更新。task
project 的 summary/search/apply/create-run 先在锁内选择本项目 non-null project activation；否则选择 global pointer；两者都必须
重验 publication/quality/control revision 与 content hash。project-only 版本对无 source ACL actor 统一 404。v1 global approval 必须是
human `core:write` 且对 source project 有当前 ACL；exact singleton `core:evolution-privacy-review` service 只能
deny/quarantine，不能 approve。service token 的 scopes 必须精确等于
`["core:evolution-privacy-review"]`，不得与 Distiller/Curator/Sandbox scope 混用。审批者不能修改内容，不能批准自己生成的
版本，不能访问 Connector、sandbox 或 project write route。

`global activation` 与 project activation 对称，但使用独立、单调的 `global_control_revision`，它是 global pointer 的唯一 ABA fence；
`learned_skill.active_version_id` 只是兼容镜像，selector 不得直接把它当权威。每次 non-no-op edge 必须在同一事务追加 global revision、
global event、exact audit/outbox，前移 projection/current revision，并由 deferred trigger 以 `IS NOT DISTINCT FROM` 同时证明：projection
等于 revision 的 `to`；legacy mirror 等于 projection；前一 revision 的 `to/version+publication_revision` 等于下一 revision 的 `from`；
revision 恰好 `+1`。`to_active_version_id` 非 null 时 `to_publication_revision` 必须非 null，且 composite FK 命中该 version/skill 的
immutable publication revision fact；trigger 在锁内要求该 fact state=`global_approved`、同时仍是 target publication projection 的
current revision、quality 非 quarantined、manifest 未漂移。target 为 null 时 target publication revision 必须 null，绝不要求或伪造
一个不存在 target。`from` pair 也复合绑定其当时的 immutable publication revision fact，因此历史 edge 不 FK 回可变 publication
projection；version/skill、publication revision、global revision/event、audit/outbox 均可独立复算。

所有可能改变 global pointer 的 human approval、human rollback、privacy/quality fallback 与 clear body 都必须携带
`expected_global_active_version_id` 和 `expected_global_control_revision`；target 非 null 时还必须携带
`expected_target_publication_revision`，target null 时该字段必须 null。Core 先锁 global activation 并同时 CAS pointer+revision；所以
`A→B→A` 产生三个不同 revision，拿第一次 A 的旧 revision 永远不能通过。相同 Idempotency-Key/相同 logical request 只 replay 原 edge；
不同 key 请求把 current pointer 设为同一 value 是授权后 200 `no_op=true`，不追加 revision/event/audit/outbox，也不递增 revision；同 key
异 body 409。任何真正 from≠to 的 mutation 不允许被 no-op 优化。

全局 promotion body 冻结为：

```ts
interface PrivacyReviewCompleteV1 {
  schema: "learned-skill-privacy-review-complete.v1";
  version_id: string;
  content_manifest_hash: Sha256;
  scanner_version: string;
  scan_report_hash: Sha256;
  decision: "approve_global" | "deny_global" | "quarantine";
  expected_publication_revision: number;
  expected_global_active_version_id: string | null;
  expected_global_control_revision: number;
  reason: string;
  reviewer_version: string;
  declassification_profile: "human-explicit.v1" | null;
  declassification_ack: true | null;
}
interface PrivacyReviewResultV1 {
  schema: "learned-skill-privacy-review-result.v1"; review_id: string; version_id: string;
  decision: "approve_global" | "deny_global" | "quarantine";
  publication_state: "global_approved" | "global_denied" | "privacy_quarantined";
  publication_revision: number; global_active_version_id: string | null; global_control_revision: number;
  project_active_version_id: string | null; replayed: boolean;
}
```

`approve_global` 时两个 declassification 字段必须分别为 `human-explicit.v1`/`true`；deny/quarantine 时必须均为 null。
这是 human 的明确 declassify 决定，不是 scanner 的证明。未来只有另行冻结、可机械证明且独立评审通过的结构化
declassification profile 才可允许 service approve；v1 没有这样的 profile。

service lane 使用 append-only `privacy_review_run`，状态只允许
`queued→running→denied|quarantined|failed|cancelled`；没有 approved terminal 或回退到 queued 的边，每个 version 最多一个 run。
run 与初始 publication 在 immutable SkillVersion commit 的同一事务物化为 queued/project_active_unproven；claim 时 publication CAS 到
privacy_review_pending。exact singleton DTO/response 为：

```ts
interface PrivacyReviewClaimV1 {
  schema: "privacy-review-claim.v1"; worker_id: string; lease_seconds: number; // 30..900
}
interface PrivacyReviewClaimResultV1 {
  schema: "privacy-review-claim-result.v1"; run_id: string; run_revision: number; lease_revision: number;
  lease_token: string; lease_expires_at: IsoDateTime; version_id: string; source_project_id: string;
  content_manifest_hash: Sha256; scanner_version: string; scan_report_hash: Sha256;
  sanitized_package_manifest: {path:string;sha256:Sha256;size_bytes:number;media_type:string}[];
}
interface PrivacyReviewLeaseV1 {
  schema: "privacy-review-lease.v1"; lease_token: string; expected_run_revision: number;
  expected_lease_revision: number; lease_seconds: number;
}
interface PrivacyReviewLeaseResultV1 {
  schema: "privacy-review-lease-result.v1"; run_revision: number; lease_revision: number;
  lease_expires_at: IsoDateTime; publication_revision: number;
}
interface PrivacyReviewServiceCompleteV1 {
  schema: "privacy-review-service-complete.v1"; lease_token: string; expected_run_revision: number;
  expected_lease_revision: number; expected_publication_revision: number;
  expected_global_active_version_id: string | null; expected_global_control_revision: number;
  content_manifest_hash: Sha256;
  scanner_version: string; scan_report_hash: Sha256; decision: "deny_global" | "quarantine";
  reason: string; reviewer_version: string; declassification_profile: null; declassification_ack: null;
}
interface PrivacyReviewFailV1 {
  schema: "privacy-review-fail.v1"; lease_token: string; expected_run_revision: number;
  expected_lease_revision: number; error_code: string; retryable: false; details_hash: Sha256;
}
interface PrivacyReviewTerminalResultV1 {
  schema: "privacy-review-terminal-result.v1"; run_id: string;
  state: "denied" | "quarantined" | "failed" | "cancelled"; run_revision: number;
  publication_state: "privacy_review_pending" | "global_denied" | "privacy_quarantined" | "global_approved";
  publication_revision: number; global_active_version_id: string | null; global_control_revision: number; replayed: boolean;
}
```

routes 分别为 `POST .../claim`、`POST .../:runId/lease`、`POST .../:runId/package/manifest`、
`POST .../:runId/package/list`、`POST .../:runId/package/read`、`POST .../:runId/complete`、`POST .../:runId/fail`。
claim/lease 首次 200，complete/fail 首次 200；所有 mutation 要 Idempotency-Key；claim key identity=
`(scope,worker_id,"claim",key)`，同 key replay 原 claim response、不能领取第二个 run；其它 identity=`(scope,run_id,action,key)`。canonical
body logical hash 不含 raw lease token而含其 hash。同 key同 hash replay 200，异 hash/旧 revision/旧 lease 409。每个 mutation 的
token 同时绑定 run id、worker、run revision floor、lease revision 与 expiry；DTO 仍显式携带 expected lease revision，二者都须匹配。
run failed 为 terminal 且 `retryable:false`；不自动 retry、不复活该 run。需要结论时由 human lane处理，不创建第二个 service run。

privacy reviewer 必须能读取 exact immutable sanitized Version bytes，而不只看 metadata；三条 package route 都要求 exact service scope
和同一未过期 lease，并复用 `expected_run_revision/expected_lease_revision/content_manifest_hash` CAS：

```ts
interface PrivacyReviewPackageRequestV1 {
  schema: "privacy-review-package-request.v1"; lease_token: string;
  expected_run_revision: number; expected_lease_revision: number; expected_content_manifest_hash: Sha256;
}
interface PrivacyReviewPackageReadV1 extends PrivacyReviewPackageRequestV1 {
  schema: "privacy-review-package-read.v1"; path: string; expected_sha256: Sha256;
  offset_bytes: number; length_bytes: number; encoding: "utf8" | "base64";
}
interface PrivacyReviewPackageManifestV1 {
  schema: "privacy-review-package-manifest.v1"; run_id: string; version_id: string;
  content_manifest_hash: Sha256; entry_count: number; total_bytes: number;
}
interface PrivacyReviewPackageListV1 {
  schema: "privacy-review-package-list.v1"; run_id: string; content_manifest_hash: Sha256;
  entries: {path:string;sha256:Sha256;size_bytes:number;media_type:string}[];
}
interface PrivacyReviewPackageChunkV1 {
  schema: "privacy-review-package-chunk.v1"; run_id: string; content_manifest_hash: Sha256;
  path: string; sha256: Sha256; size_bytes: number; media_type: string;
  offset_bytes: number; chunk_size_bytes: number; chunk_sha256: Sha256; complete: boolean;
  encoding: "utf8" | "base64"; content_utf8: string | null; content_base64: string | null;
}
```

manifest/list 无额外字段，read 的 offset/length 语义同 §4 zero-byte/EOF，单次 decoded chunk 0..1 MiB；binary 只 base64，UTF-8
必须 fatal/boundary-valid。Core 每次从 version managed content 重算 entry/full manifest hash；path/hash/manifest/lease mismatch 409，
range 416，integrity failure 503，不访问 source project/workspace/log/evidence/Connector，也不返回 raw project source/log。三条 route
均为 read-like POST，首次/replay 200、无 DB mutation，并在成功/错误上固定 privacy no-store 三 headers。

human lane 使用
`POST /api/v1/learned-skills/:skillId/versions/:versionId/privacy-reviews`，body 为上述 DTO，不含 lease token。
service claim 只返回 exact version sanitized package、scanner report、source-derived不可逆匹配信号和 manifest hashes；不返回 raw
project source/log。两条 lane 都调用同一 Core transaction service，审批行与 pointer move 不可分割；旧/过期 lease、同 version
并发 terminal review 或 expected publication/run revision drift 用 `PRIVACY_REVIEW_STATE_CONFLICT`，global pointer/control drift 用
`LEARNED_SKILL_GLOBAL_ACTIVATION_CONFLICT`，均 409。human complete 首次 201/replay 200，response exact 为
`PrivacyReviewResultV1`。

所有写要求 Idempotency-Key；同 key/同 canonical body replay，异 body 409。`approve_global` 只在 scan pass、version immutable、
manifest/hash 完全一致、Skill enabled/available、version 非 quarantined、global pointer CAS 成功时生效。`quarantine` 同事务
执行上述 latch/pointer fallback；`deny_global` 不影响来源项目内现有可用性。并发优先级为：quarantine safety latch 最高且可在批准后
撤销；human approve/deny 可从 project_active_unproven/pending/global_denied 按新 revision 决定；service deny 只能在尚无更晚 human
decision 时提交；service fail 不改变 publication。锁序将竞态串行化，较旧 expected revision 一律 409，不按 wall-clock 猜 winner。
全局批准不把 source facts/ACL/content 复制到 Skill DTO。

human approve/deny 不抢先终止正在运行的 immutable-content service review：service 随后 `quarantine` 仍可从 global_approved 提交并
撤销 pointer；service `deny_global` 若发现已有更晚 human approve，则同事务只把 service run 置 cancelled、publication 不变并返回
terminal result。human/service 任一 quarantine 提交后 latch 终止并取消未终态 review run。这样 safety quarantine > human decision >
service deny > service fail 的优先级由 publication revision/state transition 强制，而不是调度时序。

pointer writer 合同：Distiller 创建根版本必须传 `expected_project_active_version_id:null`；Distiller/Curator patch 的 parent 必须等于
锁内 source-project activation 当前值，并传 expected project control/publication revision；不能以 global pointer 或 caller
`source_project_id` 作为 parent/source。Core 从 task/application/episode 的 immutable project binding 派生 source project。project
rollback route `POST /api/v1/projects/:projectId/learned-skills/:skillId/project-active-version` body exact
`{schema:"learned-skill-project-active-version.v1",active_version_id:string|null,expected_control_revision:number,reason:string}`；仅 human
`core:write` + project ACL，可选版本必须同 source project、非 quarantined。global rollback route
`POST /api/v1/learned-skills/:skillId/global-active-version` body exact
`{schema:"learned-skill-global-active-version.v1",active_version_id:string|null,expected_global_active_version_id:string|null,
expected_global_control_revision:number,expected_target_publication_revision:number|null,reason:string}`。target 非 null 时要求 human
`core:write` + target version source ACL、`expected_target_publication_revision` 非 null 且 exact，只能选择已 global_approved、未
quarantine 版本；target null 时 target publication revision 必须 null，授权改为 human `core:write` 且对**当前 pointer version** 的 source
project 有当前 ACL，或命中独立、显式配置的 human-only `global-learned-skill-admin.v1` exact policy。clear 绝不能因不存在 target 而跳过
授权，也不能要求不存在 target 的 source ACL。两 route 首次 200/replay 200；project CAS 用 `EVOLUTION_CAS_CONFLICT`，global
pointer/revision/target-publication CAS 用 `LEARNED_SKILL_GLOBAL_ACTIVATION_CONFLICT`，ACL conceal 为 404，锁序同上；
summary/search/apply/run 都不得绕过 selector。
response exact 为
`{schema:"learned-skill-active-pointer-result.v1",domain:"project"|"global",project_id:string|null,skill_id:string,
active_version_id:string|null,control_revision:number,no_op:boolean,replayed:boolean}`；project response 的 project_id 非 null，global 为 null。

Distiller/Curator 的版本 commit 分别走
`POST /api/v1/internal/evolution/distillation-runs/:runId/version-commits` 与
`POST /api/v1/internal/evolution/curator-runs/:runId/version-commits`；除 exact singleton scope 不同外使用同一 strict DTO/domain service：

```ts
interface LearnedSkillProjectVersionCommitV1 {
  schema: "learned-skill-project-version-commit.v1"; lease_token: string;
  expected_run_revision: number; expected_lease_revision: number;
  skill_id: string; parent_version_id: string | null;
  expected_project_active_version_id: string | null; expected_project_control_revision: number | null;
  expected_parent_publication_revision: number | null;
  staged_content_manifest_hash: Sha256; scanner_version: string; scan_report_hash: Sha256; reason: string;
}
interface LearnedSkillProjectVersionCommitResultV1 {
  schema: "learned-skill-project-version-commit-result.v1"; skill_id: string; version_id: string;
  source_project_id: string; parent_version_id: string | null; content_manifest_hash: Sha256;
  project_active_version_id: string; project_control_revision: number;
  publication_state: "project_active_unproven"; publication_revision: 1; privacy_review_run_id: string;
  replayed: boolean;
}
```

root 要求三个 parent/expected pointer/revision 字段分别为 null/null/null；patch 要求全部非 null 且三者锁内匹配。source project 只从
run→episode/application/task 复合 FK 派生，DTO 无该字段。锁序固定
`run/lease→task/application/episode→learned_skill→project activation→parent publication→staged manifest/scanner`；版本、publication、
project pointer、queued privacy run、audit/outbox 同事务，首次 201/replay 200，lease/pointer/parent/hash drift 409，不能只提交版本
后异步移 pointer。

forward migration 在任何 publication、activation、global/project pointer、quality projection 或 quarantine 写入前，先对全部既有
version/evaluation 做只读全量 preflight：从 immutable creating application/episode/task binding 推导 source project，校验 manifest/source、
parent ancestry、旧 pointer、evaluation root/predecessor 与 quarantine origin 均唯一。任一 version 为 0 个或多于 1 个 source 候选、
parent 跨 project、manifest/source 不完整、多 root/跨链或 origin 多义时，整次 migration **零业务写中止**；只输出有数量/bytes 上限的
redacted ambiguity report（version/evaluation 使用不可逆 hash，禁止 title/content/project/log/evidence），不得先 quarantine 某些版本、清空
pointer 或提交部分 backfill。管理员必须提供经 schema 校验、签名/哈希绑定的显式 per-version migration input，至少冻结
`source_project_id`、project-only attribution 或 human declassification disposition，并在质量多义时冻结 canonical legacy chain 与
quarantine origin；Core 校验 input 引用的原始 row/hash、actor authority 和全局一致性后，从头重跑同一 preflight。input 缺项或矛盾仍
中止，不能用 `now()`、任意 project/root 或默认 declassification 猜测。

只有 preflight 全通过后，migration 才在单一提交边界按 source project/ancestry 回填 publication、project activation、显式 migration
resolution facts、quality facts 与 audit/outbox；旧 `active_version_id` 不自动视为 privacy approval。每个 Skill 创建
`global_control_revision=1` 的 append-only `clear` revision/event，from/to 和两 publication revisions 均为 null，global projection 与 legacy
mirror 一律先置 null，待 human 显式批准；不得只清 legacy column 而缺少 global edge。patch parent、project/global pointer、publication
review、audit/outbox backfill 使用 deferred FK validation；upgrade 与
fresh schema 在提交前逐约束 parity，任何孤儿/多义使整笔 migration 回滚。

### 2.3 方案 B（保留 immediate-global）及不足

替代方案是保持当前“scan pass 后立即 global active_unproven”，并增加 DLP、源片段相似度、二次模型审查与事后撤回。
它延迟最低、跨项目学习最快，但二次 regex/DLP/模型仍不能证明没有未知格式泄漏；误发发生在审批前，Disable/Archive 只能
阻止后续发现，不能收回已经读取的内容。该方案也使 source ACL 与 global content 的信任边界继续耦合。

**待决定：A 或 B。本文后续 schema、ACL、Gate 默认按方案 A 编写。若选择 B，必须修改本文的 publication、search、diff、
sandbox mount ACL 和隐私对抗测试，并重新独立评审；不能只删掉 approval route 后继续开发。**

## 3. M5 权限、开关与总不变量

新增 exact singleton scope：`core:evolution-sandbox`。其 token scopes 数组必须只含这一项；actor 必须为 service。
它只能 claim/lease/heartbeat/read sealed input/stage output/complete/fail LearnedScriptRun，不能调用 generic project/task/job/
workspace、Distiller、Curator、Evaluator、approval、baseline、publish、delivery 或 hardware route。task Runtime 仍使用 singleton
`core:task-runtime`，且只能访问 header 绑定的 project/task/application route。

新增代码发布门 `SYNTHIA_FEATURE_LEARNED_SCRIPT_SANDBOX`，默认 false；它与
`SYNTHIA_FEATURE_SELF_EVOLUTION` 独立。启动配置不是权威 claim 条件；Core 持久化 gate projection：

```sql
evolution_effect_gate(
  id text PRIMARY KEY, gate_kind text NOT NULL CHECK(gate_kind IN
    ('self_evolution_rollout','learned_script_sandbox','learned_skill_control','learned_version_safety')),
  subject_id text NOT NULL, enabled boolean NOT NULL,
  gate_revision bigint NOT NULL CHECK(gate_revision >= 1),
  effect_generation bigint NOT NULL CHECK(effect_generation >= 1),
  reason text NOT NULL, audit_event_id text NOT NULL UNIQUE, outbox_event_id uuid NOT NULL UNIQUE,
  updated_at timestamptz NOT NULL, UNIQUE(gate_kind,subject_id),
  UNIQUE(id,gate_kind,subject_id,effect_generation),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

learned_script_run_gate_binding(
  effect_type text NOT NULL CHECK(effect_type='learned_script_run'), run_id text NOT NULL,
  gate_kind text NOT NULL CHECK(gate_kind IN
    ('self_evolution_rollout','learned_script_sandbox','learned_skill_control','learned_version_safety')),
  gate_id text NOT NULL, gate_subject_id text NOT NULL,
  created_generation bigint NOT NULL CHECK(created_generation >= 1),
  PRIMARY KEY(effect_type,run_id,gate_kind), FOREIGN KEY(run_id) REFERENCES learned_script_run(id),
  FOREIGN KEY(gate_id,gate_kind,gate_subject_id,created_generation)
    REFERENCES evolution_effect_gate(id,gate_kind,subject_id,effect_generation)
)

learned_typed_handoff_gate_binding(
  effect_type text NOT NULL CHECK(effect_type='learned_typed_handoff'), handoff_id text NOT NULL,
  gate_kind text NOT NULL CHECK(gate_kind IN
    ('self_evolution_rollout','learned_script_sandbox','learned_skill_control','learned_version_safety')),
  gate_id text NOT NULL, gate_subject_id text NOT NULL,
  created_generation bigint NOT NULL CHECK(created_generation >= 1),
  PRIMARY KEY(effect_type,handoff_id,gate_kind), FOREIGN KEY(handoff_id) REFERENCES learned_typed_operation_handoff(id),
  FOREIGN KEY(gate_id,gate_kind,gate_subject_id,created_generation)
    REFERENCES evolution_effect_gate(id,gate_kind,subject_id,effect_generation)
)
```

四种 binding 的 subject exact 固定为：rollout=`global`、sandbox=`global`、skill-control=`skill_id`、version-safety=`version_id`。
DB deferred constraint trigger 对每个 Run/Handoff 强制**恰好四行**、四个 gate_kind 各一、subject 与 effect immutable binding 相等；
缺行、多行、重复 kind、错 subject 或把另一个 Skill/Version gate 绑进来都使创建事务失败。两张 binding 表的复合主键等价于
`UNIQUE(effect_type,effect_id,gate_kind)`，不能 vacuously pass。

每个 run/handoff 的 `created_generation` 是创建事务锁住的四类 gate 当前 `effect_generation`，逐行保存而不是 caller 字段。
effect projection 中的 `generation_bindings_hash` 必须由 Core/DB 对四行按上述 gate_kind 固定顺序构造
`[{gate_kind,gate_id,gate_subject_id,created_generation}]` JCS 后 SHA-256；deferred trigger 复算并要求相等。
任何 off/disable/archive/quarantine 先锁相应 gate，递增 `effect_generation` 与 `gate_revision`、置 enabled=false，再提交 audit/outbox；
on/enable/restore 同样再次递增 generation 后置 true。generation 单调且绝不复用，因此 reopen 只允许在新 generation 创建的新
effect，旧 queued/compiled handoff binding 永远不再匹配。claim/typed dispatch 在 effect commit 的同一事务按 kind 锁四行
binding+gate，先断言 count=4、subject/hash exact，再要求 enabled=true 且 `created_generation=effect_generation`；任一缺/多/错即
`EVOLUTION_EFFECT_GATE_BINDING_INVALID` 并 fail closed，旧 generation 则写 cancel intent/拒绝 dispatch；不能因当前配置重新为 true 而复活。
migration 时默认 disabled 且生成新 generation；没有完整 gate bindings 的旧 pending effect fail closed cancel。

状态矩阵：

| 动作 | self-evolution off | sandbox off | Pause Learning | Disable Learned Skills | Skill disabled/archived/quarantined |
|---|---|---|---|---|---|
| search/view 既有只读资产 | 按 v1 | 允许 | 允许 | 按 v1 | privacy quarantine 按 §2 立即 redact/404；其它按 v1 |
| 创建新 script run | 503 | 503 | 允许 | 409 | 409 |
| claim 新 queued run | 不允许 | 不允许 | 允许 | 不允许 | 不允许 |
| 已开始 run heartbeat/cancel/kill/complete/fail/recovery | 必须允许安全收尾 | 必须允许安全收尾 | 允许 | 必须允许安全收尾 | 必须允许安全收尾 |
| typed IR 的新 Vivado handoff | 403 | 403 | 允许 | 409 | 409 |

静态启动时，Core 把默认 false/配置变化经单 writer CAS 投影到上述 gate；worker 只信 Core gate/binding，不信本地环境变量。
配置缺失、非法、profile/cert 不匹配时只启用 reconciliation/
cancel/complete/fail/read safety routes，不 claim 新 run。热关闭采用两阶段、可恢复协议：先原子切换 generation gate 并让所有
create/claim/typed-handoff 在下一次锁检查时拒绝新 effect；再由 lease-independent durable sweeper 分页锁定每个 queued/running
run，逐 run 提交唯一 cancel intent + audit/outbox。单个配置事务**不**尝试批量 cancel，也不声称进程已停止。sweeper crash 后从
run/id cursor 重放，同 run intent 同 hash no-op；heartbeat/reconcile/kill/complete/fail/output read 始终可用，直到每个 run 进入
terminal。热重新打开只允许新 generation 的新 Run，不撤销旧 cancel intent，不复活旧 Run。

Disable/Enable、Archive/Restore、privacy/quality quarantine 走相同 generation cutoff；关闭态再执行“逐 run durable cancel”。
Pin 只阻止自动修改，不阻止
已批准版本执行。sandbox off 不影响 `.tcl/.py/.ts` 的只读 view。

脚本进程的零权限不变量：无 Core/Connector/model/secret token；无网络、DNS、loopback、Unix socket、Named Pipe、device、
hardware；不能读取 host env、HOME、主 Runtime fd 或 host path；不能写项目/Skill/Core DB；唯一可写位置是该 run 的 tmpfs
`/output`。scanner 是 defense-in-depth，OS sandbox 和 Core binding 才是权威边界。

## 4. LearnedScriptRun 事实、状态机与 task Runtime API

### 4.1 Core 事实

新增 forward-only migration 与 fresh schema 等价事实：

SQL notation 规则是本合同的一部分：除显式写 `NULL` 的列外，以下全部列一律 `NOT NULL`，migration/fresh schema 不得依赖
SQL `CHECK` 对 NULL 返回 unknown 的行为。所有 id/actor/version/path/reason 使用独立 domain check（trimmed UTF-8、无 NUL，分别受
1..128/256/4096 bytes 上限）；`sha256_text` 固定 `^[0-9a-f]{64}$`，OCI digest 固定 `^sha256:[0-9a-f]{64}$`；count/size/time/
revision 均有文中上下界且非负。JSON 必须先过 strict schema、JCS 与 size cap，DB 保存 canonical bytes/hash，不能保存 unchecked
arbitrary jsonb。每个 projection revision/state edge 与它的 immutable revision/event、audit event、outbox event 使用复合 FK 和同一
事务；所有 immutable/fact/revision/event/content 表有 trigger 拒绝 UPDATE/DELETE，projection trigger 只允许匹配 next revision 的
Core transaction。migration 先回填、再 `NOT VALID` 加复合 FK/check、验证、最后设 NOT NULL；任一 NULL/orphan/duplicate/multi-root
使 migration fail closed。upgrade/fresh DDL 必须由 catalog parity test 比较 column nullability、domain/check、index、FK deferrability
和 trigger hash，而不只比较表名。

```sql
-- M5 adds this composite identity to the existing immutable table.
ALTER TABLE learned_skill_file ADD UNIQUE(id,version_id);
ALTER TABLE task_conversation_event
  ADD UNIQUE(id,project_id,task_id,sequence,event_kind,payload_hash,created_at);

task_tool_call_commit_fact(
  event_id text PRIMARY KEY, project_id text, task_id text, event_sequence bigint CHECK(event_sequence > 0),
  event_kind text CHECK(event_kind='tool_call'), payload_hash sha256_text,
  turn_id text NULL, turn_binding_key text, tool_call_id text, tool_name text, args_hash sha256_text,
  args_jcs bytea, payload_jcs bytea, committed_at timestamptz,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE,
  CHECK(tool_name IN ('learned_script_run','learned_tcl_compile','learned_typed_operation_handoff')),
  UNIQUE(event_id,project_id,task_id,event_sequence,event_kind,payload_hash,committed_at,
         tool_call_id,turn_binding_key,tool_name,args_hash),
  UNIQUE(event_id,project_id,task_id,event_sequence,tool_call_id,turn_binding_key,tool_name,args_hash),
  UNIQUE(task_id,tool_call_id),
  FOREIGN KEY(event_id,project_id,task_id,event_sequence,event_kind,payload_hash,committed_at)
    REFERENCES task_conversation_event(id,project_id,task_id,sequence,event_kind,payload_hash,created_at),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK(encode(digest(args_jcs,'sha256'),'hex')=args_hash),
  CHECK(encode(digest(payload_jcs,'sha256'),'hex')=payload_hash)
)
```

`task_conversation_event` 的真实 append-only row 是**通用事件权威**；其既有五种 event kind、payload 合同、UPDATE/DELETE deny trigger 与
NULL 语义必须保留。M5 不给该表新增 `turn_id` 或 `turn_binding_key`，也不要求每个通用 event 有 turn。Project Agent 的 initial-objective、
recovery、status 等合法 event 可以没有 `turn_id`；它们必须正常写入，但绝不能因此生成 `task_tool_call_commit_fact`。新增七列
`UNIQUE(id,project_id,task_id,sequence,event_kind,payload_hash,created_at)` 与所有通用-event FK 的列数、顺序、类型完全一致；不能用一个
额外含 turn key 的八列 unique 代替，否则 generic status/tool_call FK 没有可引用 identity。

`task_tool_call_commit_fact` 是与通用事件分离的**effect-bearing tool-call authority**。只有 `event_kind='tool_call'` 且 name exact 属于
`learned_script_run|learned_tcl_compile|learned_typed_operation_handoff` 的 committed event 才是候选；其 payload exact keys 只能是
`turn_id/tool_call_id/name/args`，不得缺项或带 extra key，且 `args` 必须为 plain JSON object：
`{"turn_id":string|null,"tool_call_id":string,"name":string,"args":object}`。`payload_jcs` 是完整 object 的 JCS bytes，`args_jcs` 是其中
`args` 的 JCS bytes，两个 digest 分别等于 generic event `payload_hash` 与 `args_hash`。Core 必须在追加候选 event 的同一事务物化 commit
fact，复制 DB 分配的 generic event 七列 identity、raw nullable `turn_id`，并写 non-null derived `turn_binding_key`；非 tool event、其它
tool name 或 shape 不满足的 row 不能生成 commit fact。deferred trigger 重读 generic row/payload 并逐字段、逐 byte、NULL-safe 验证，
任何 event kind/name/shape/hash/turn 漂移、非 tool event 冒充或孤立 fact 都回滚。

只有 commit fact 的 `turn_binding_key` 由 Core 根据 `agent_task.agent_role` 派生，caller 不能传：Project Agent 的 effect-bearing tool call
必须有 non-empty raw turn id，key=`turn:<turn_id>` 且匹配当前授权 turn；bounded `run|side` task 的同类 tool call raw turn id 必须严格为
JSON null，key=`task:<task_id>`。commit-fact/effect deferred trigger 以 `IS NOT DISTINCT FROM` 比较 nullable raw turn，并重算 role/key；
所有 Run/compile/handoff 的复合 FK 只使用 commit fact 的 non-null key，不把 nullable raw turn 放进 MATCH SIMPLE FK。因此 bounded null
不能绕过 authority FK，Project Agent tool call 也不能伪装成 task-bound null；这些规则绝不施加到其它 generic event。

upgrade 不回填或改写 `task_conversation_event` 的 turn 列，因为通用表没有这些列。migration 只扫描上述三种候选 tool-call event；仅当
generic 七列 identity、strict payload、plain-object args 与 task role/turn 组合均可唯一证明时才创建 commit fact。候选存在 string args、
shape/role/turn 多义或非法时只记 bounded redacted ineligible report、不生成 fact；禁止 `JSON.parse`、随机 turn、借用当前 turn 或退化 key。
所有非候选 initial/recovery/status/message/tool event 原样保留且不生成 commit fact。

这是明确的 **M5 Runtime producer migration**，不是对当前 producer 的完成声明；它只约束上述三种 effect-bearing tool-call event，
不改变 initial-objective/recovery/status/message/tool-result 等 generic event payload。`runtime/free-agent.ts` 必须在候选工具执行前验证
`call.args` 是无 prototype/custom class、无 undefined/function/symbol/bigint、有限数字、递归满足 JSON 的 plain object；JCS 后最多
1,048,576 bytes、最大 nesting depth 32、递归累计 object keys 最多 4,096，三个边界都测试 exact limit 与 +1；
`runtime/agent-types.ts` 的 tool-start contract 同时携带供 UI/SSE 的 truncated display string 和独立 validated
`args_payload` object；`runtime/server.ts` 只能把 object 写到 event `payload.args`，display string 永不进入权威 payload。non-object、malformed
或 canonicalization 失败必须以 `EVOLUTION_TOOL_ARGS_INVALID` 在 event/Run/compile/handoff/Connector effect **之前**拒绝并写非 effect
Runtime error；工具也不得执行。
既有 `args` 为 string 的历史候选 tool_call rows 永久 ineligible，migration 只报 bounded redacted count/hash并不生成 commit fact；禁止
`JSON.parse` 猜测、silent parse/backfill 或把展示字符串重新解释成 authority。后续 Run/compile/handoff 只能复合 FK 绑定这个真实 event
的 immutable identity，不能从 assistant proposal、HTTP body 或另一张虚构 event 表推导“已提交”。

```sql

ALTER TABLE skill_application_skill
  ADD UNIQUE(application_id,version_id,skill_id,role);

learned_script_run(
  id text PRIMARY KEY, project_id text, task_id text, application_id text,
  skill_id text, version_id text,
  application_skill_role text CHECK(application_skill_role IN ('primary','supporting')),
  script_file_id text,
  language text CHECK(language IN ('python','typescript')),
  tool_call_event_id text, tool_call_event_sequence bigint CHECK(tool_call_event_sequence > 0),
  tool_call_id text, tool_call_turn_id text NULL, tool_call_turn_binding_key text,
  tool_call_name text CHECK(tool_call_name='learned_script_run'),
  tool_call_args_hash sha256_text,
  state text CHECK (state IN
    ('queued','running','succeeded','failed','cancelled','timeout','unknown_effect')),
  attempt integer CHECK(attempt=1), state_revision bigint CHECK(state_revision >= 1),
  lease_revision bigint CHECK(lease_revision >= 0),
  worker_id text NULL, sandbox_host_id text NULL, launch_intent_id text NULL,
  lease_token_hash sha256_text NULL, lease_expires_at timestamptz NULL,
  cancel_requested_at timestamptz NULL, process_started_at timestamptz NULL,
  project_snapshot_hash sha256_text, input_manifest_hash sha256_text,
  generation_bindings_hash sha256_text, output_manifest_hash sha256_text NULL,
  request_hash sha256_text, terminal_request_hash sha256_text NULL, terminal_result jsonb NULL,
  created_by text, created_at timestamptz, updated_at timestamptz, completed_at timestamptz NULL,
  UNIQUE(task_id, tool_call_id), UNIQUE(id,version_id), UNIQUE(id,state_revision),
  FOREIGN KEY(application_id, task_id, project_id)
    REFERENCES skill_application(id, task_id, project_id),
  FOREIGN KEY(application_id,version_id,skill_id,application_skill_role)
    REFERENCES skill_application_skill(application_id,version_id,skill_id,role),
  FOREIGN KEY(version_id, skill_id) REFERENCES learned_skill_version(id, skill_id),
  FOREIGN KEY(script_file_id,version_id) REFERENCES learned_skill_file(id,version_id),
  FOREIGN KEY(tool_call_event_id,project_id,task_id,tool_call_event_sequence,tool_call_id,
              tool_call_turn_binding_key,tool_call_name,tool_call_args_hash)
    REFERENCES task_tool_call_commit_fact(event_id,project_id,task_id,event_sequence,tool_call_id,
                                          turn_binding_key,tool_name,args_hash),
  CHECK((state='queued' AND worker_id IS NULL AND sandbox_host_id IS NULL AND launch_intent_id IS NULL AND
         lease_token_hash IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL AND
         terminal_request_hash IS NULL AND terminal_result IS NULL AND output_manifest_hash IS NULL) OR
        (state='running' AND worker_id IS NOT NULL AND sandbox_host_id IS NOT NULL AND launch_intent_id IS NOT NULL AND
         lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NULL AND
         terminal_request_hash IS NULL AND terminal_result IS NULL AND output_manifest_hash IS NULL) OR
        (state IN ('succeeded','failed','cancelled','timeout','unknown_effect') AND completed_at IS NOT NULL AND
         lease_token_hash IS NULL AND lease_expires_at IS NULL AND terminal_request_hash IS NOT NULL AND terminal_result IS NOT NULL)),
  CHECK((state='succeeded') = (output_manifest_hash IS NOT NULL))
)

learned_script_run_revision(
  run_id text, state_revision bigint CHECK(state_revision >= 1),
  state text CHECK(state IN ('queued','running','succeeded','failed','cancelled','timeout','unknown_effect')),
  attempt integer CHECK(attempt=1), lease_revision bigint CHECK(lease_revision >= 0), fact_hash sha256_text,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  PRIMARY KEY(run_id,state_revision), UNIQUE(run_id,state_revision,lease_revision),
  FOREIGN KEY(run_id) REFERENCES learned_script_run(id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

learned_script_launch_intent(
  id text PRIMARY KEY, run_id text UNIQUE, attempt integer CHECK(attempt=1),
  state_revision bigint, sandbox_host_id text, sandbox_profile_hash sha256_text,
  host_certification_fact_id text, host_identity_hash sha256_text,
  host_registration_fact_id text, host_registration_revision bigint,
  host_attestation_key_issue_fact_id text, host_attestation_public_key_id text,
  host_attestation_public_key_hash sha256_text,
  sandbox_host_boot_id text, host_boot_attestation_fact_id text,
  host_ledger_root_fact_id text, host_ledger_genesis_hash sha256_text,
  sandbox_instance_id text UNIQUE,
  container_identity text UNIQUE, cgroup_identity text UNIQUE,
  input_manifest_hash sha256_text, launch_request_hash sha256_text,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, committed_at timestamptz,
  UNIQUE(id,run_id),
  FOREIGN KEY(run_id,state_revision)
    REFERENCES learned_script_run_revision(run_id,state_revision),
  FOREIGN KEY(host_certification_fact_id,sandbox_host_id,host_identity_hash,
              host_registration_fact_id,host_registration_revision,
              host_attestation_key_issue_fact_id,host_attestation_public_key_id,host_attestation_public_key_hash,
              sandbox_host_boot_id,host_boot_attestation_fact_id,
              host_ledger_root_fact_id,host_ledger_genesis_hash,sandbox_profile_hash)
    REFERENCES learned_sandbox_host_certification_fact(
      id,sandbox_host_id,host_identity_hash,host_registration_fact_id,host_registration_revision,
      attestation_key_issue_fact_id,attestation_public_key_id,attestation_public_key_hash,
      boot_id,boot_attestation_fact_id,ledger_root_fact_id,ledger_genesis_hash,profile_hash),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

learned_script_cancel_intent(
  id text PRIMARY KEY, run_id text UNIQUE, expected_state_revision bigint,
  reason text, intent_hash sha256_text, audit_event_id text UNIQUE,
  outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(id,run_id,intent_hash),
  FOREIGN KEY(run_id,expected_state_revision)
    REFERENCES learned_script_run_revision(run_id,state_revision),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

learned_script_stage_rejection_fact(
  id text PRIMARY KEY, run_id text, state_revision bigint CHECK(state_revision >= 1),
  lease_revision bigint CHECK(lease_revision >= 1),
  action text CHECK(action IN ('output_manifest','output_chunk','stdout','stderr')),
  path text NULL, error_code text CHECK(error_code IN
    ('LEARNED_SCRIPT_RESOURCE_LIMIT','LEARNED_SCRIPT_STREAM_LIMIT','LEARNED_SCRIPT_OUTPUT_REJECTED',
     'LEARNED_SCRIPT_OUTPUT_MANIFEST_CONFLICT','LEARNED_SCRIPT_STAGING_CONFLICT',
     'LEARNED_SCRIPT_UTF8_BOUNDARY_INVALID')),
  request_hash sha256_text, cancel_intent_id text, cancel_intent_hash sha256_text,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(run_id,request_hash),
  FOREIGN KEY(run_id,state_revision,lease_revision)
    REFERENCES learned_script_run_revision(run_id,state_revision,lease_revision),
  FOREIGN KEY(cancel_intent_id,run_id,cancel_intent_hash)
    REFERENCES learned_script_cancel_intent(id,run_id,intent_hash),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

learned_script_input_entry(
  run_id text, version_id text, path text, portable_path_key text,
  layer text CHECK(layer IN ('skill','project','input')),
  sha256 text, size_bytes bigint, media_type text, managed_content bytea,
  read_only boolean CHECK(read_only=true), PRIMARY KEY(run_id,layer,path),
  UNIQUE(run_id,portable_path_key),
  FOREIGN KEY(run_id,version_id) REFERENCES learned_script_run(id,version_id),
  CHECK(octet_length(managed_content)=size_bytes),
  CHECK(encode(digest(managed_content,'sha256'),'hex')=sha256)
)

learned_script_output_manifest(
  run_id text PRIMARY KEY, manifest_hash sha256_text UNIQUE, manifest jsonb,
  entry_count integer CHECK(entry_count BETWEEN 0 AND 64),
  total_bytes bigint CHECK(total_bytes BETWEEN 0 AND 8388608),
  created_at timestamptz, UNIQUE(run_id,manifest_hash),
  FOREIGN KEY(run_id) REFERENCES learned_script_run(id)
)

learned_script_output_manifest_entry(
  run_id text, path text, portable_path_key text, sha256 sha256_text,
  size_bytes bigint CHECK(size_bytes BETWEEN 0 AND 1048576),
  media_type text CHECK(media_type IN ('application/json','text/plain','application/octet-stream')),
  ordinal integer CHECK(ordinal BETWEEN 0 AND 63),
  PRIMARY KEY(run_id,path), UNIQUE(run_id,portable_path_key), UNIQUE(run_id,ordinal),
  UNIQUE(run_id,path,sha256,size_bytes,media_type),
  FOREIGN KEY(run_id) REFERENCES learned_script_output_manifest(run_id)
)

learned_script_output_entry(
  run_id text, path text, portable_path_key text, sha256 sha256_text,
  size_bytes bigint CHECK(size_bytes BETWEEN 0 AND 1048576), media_type text,
  managed_content bytea, PRIMARY KEY(run_id,path),
  UNIQUE(run_id,portable_path_key),
  FOREIGN KEY(run_id,path,sha256,size_bytes,media_type)
    REFERENCES learned_script_output_manifest_entry(run_id,path,sha256,size_bytes,media_type),
  CHECK(octet_length(managed_content)=size_bytes),
  CHECK(encode(digest(managed_content,'sha256'),'hex')=sha256)
)

learned_script_output_chunk(
  run_id text, path text, offset_bytes bigint CHECK(offset_bytes >= 0), chunk_sha256 sha256_text,
  chunk_bytes bytea, request_hash sha256_text, created_at timestamptz,
  PRIMARY KEY(run_id,path,offset_bytes),
  FOREIGN KEY(run_id,path) REFERENCES learned_script_output_manifest_entry(run_id,path),
  CHECK(octet_length(chunk_bytes) BETWEEN 0 AND 1048576),
  CHECK(encode(digest(chunk_bytes,'sha256'),'hex')=chunk_sha256)
)

learned_script_stream(
  run_id text, stream text CHECK(stream IN ('stdout','stderr')),
  observed_bytes bigint CHECK(observed_bytes BETWEEN 0 AND 1048576),
  stored_bytes integer CHECK(stored_bytes BETWEEN 0 AND 262144),
  truncated boolean, observed_sha256 sha256_text, stored_prefix_sha256 sha256_text, managed_prefix bytea,
  PRIMARY KEY(run_id,stream), FOREIGN KEY(run_id) REFERENCES learned_script_run(id),
  CHECK(octet_length(managed_prefix)=stored_bytes)
)

learned_script_stream_chunk(
  run_id text, stream text CHECK(stream IN ('stdout','stderr')),
  offset_bytes bigint CHECK(offset_bytes >= 0), chunk_sha256 sha256_text,
  chunk_bytes bytea, request_hash sha256_text, created_at timestamptz,
  PRIMARY KEY(run_id,stream,offset_bytes), FOREIGN KEY(run_id) REFERENCES learned_script_run(id),
  CHECK(octet_length(chunk_bytes) BETWEEN 0 AND 262144),
  CHECK(encode(digest(chunk_bytes,'sha256'),'hex')=chunk_sha256)
)

learned_script_run_event(
  id text PRIMARY KEY, run_id text, event_type text, from_state text NULL,
  to_state text NULL, state_revision bigint, fact_hash sha256_text, payload jsonb,
  actor_type actor_type, actor_id text,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(run_id,state_revision,event_type),
  FOREIGN KEY(run_id,state_revision)
    REFERENCES learned_script_run_revision(run_id,state_revision),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

ALTER TABLE learned_script_run
  ADD FOREIGN KEY(id,output_manifest_hash)
    REFERENCES learned_script_output_manifest(run_id,manifest_hash) DEFERRABLE INITIALLY DEFERRED,
  ADD FOREIGN KEY(launch_intent_id,id)
    REFERENCES learned_script_launch_intent(id,run_id) DEFERRABLE INITIALLY DEFERRED;

learned_sandbox_profile_artifact(
  profile_hash sha256_text PRIMARY KEY, outer_image_digest oci_digest,
  runner_manifest_hash sha256_text, runtime_binary_hash sha256_text,
  seccomp_hash sha256_text, policy_hash sha256_text, apparmor_selinux_hash sha256_text,
  limits_hash sha256_text, canonical_manifest bytea,
  created_at timestamptz,
  CHECK(encode(digest(canonical_manifest,'sha256'),'hex')=profile_hash)
)

learned_sandbox_profile_fact(
  id text PRIMARY KEY, profile_hash sha256_text,
  decision text CHECK(decision IN ('issue','revoke')),
  supersedes_fact_id text NULL UNIQUE, certifier_id text, certifier_key_id text,
  evidence_hash sha256_text,
  signature_algorithm text CHECK(signature_algorithm='ed25519'),
  signed_preimage_hash sha256_text, signature_base64 text,
  reason text, valid_from timestamptz, valid_until timestamptz,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(id,profile_hash), FOREIGN KEY(profile_hash) REFERENCES learned_sandbox_profile_artifact(profile_hash),
  FOREIGN KEY(supersedes_fact_id,profile_hash) REFERENCES learned_sandbox_profile_fact(id,profile_hash),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK(valid_until > valid_from)
)

learned_sandbox_profile_active(
  profile_hash sha256_text PRIMARY KEY, state text CHECK(state IN ('certified','revoked')),
  active_fact_id text, projection_revision bigint CHECK(projection_revision >= 1), updated_at timestamptz,
  FOREIGN KEY(active_fact_id,profile_hash) REFERENCES learned_sandbox_profile_fact(id,profile_hash)
)

learned_sandbox_attestation_public_key_fact(
  id text PRIMARY KEY, public_key_id text, key_revision bigint CHECK(key_revision >= 1),
  algorithm text CHECK(algorithm='ed25519'), public_key_bytes bytea,
  public_key_hash sha256_text, decision text CHECK(decision IN ('issue','revoke')),
  supersedes_fact_id text NULL UNIQUE, issuer_id text, issuer_key_id text,
  evidence_hash sha256_text, signed_preimage_hash sha256_text, signature_base64 text,
  reason text, audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(id,public_key_id,algorithm,public_key_hash,decision), UNIQUE(public_key_id,key_revision),
  UNIQUE(id,public_key_id),
  FOREIGN KEY(supersedes_fact_id,public_key_id)
    REFERENCES learned_sandbox_attestation_public_key_fact(id,public_key_id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK(octet_length(public_key_bytes)=32),
  CHECK(encode(digest(public_key_bytes,'sha256'),'hex')=public_key_hash)
)

learned_sandbox_attestation_public_key_active(
  public_key_id text PRIMARY KEY, active_fact_id text, algorithm text CHECK(algorithm='ed25519'),
  public_key_hash sha256_text, active_fact_decision text CHECK(active_fact_decision IN ('issue','revoke')),
  state text CHECK(state IN ('active','revoked')),
  projection_revision bigint CHECK(projection_revision >= 1), updated_at timestamptz,
  FOREIGN KEY(active_fact_id,public_key_id,algorithm,public_key_hash,active_fact_decision)
    REFERENCES learned_sandbox_attestation_public_key_fact(id,public_key_id,algorithm,public_key_hash,decision),
  CHECK((active_fact_decision='issue' AND state='active') OR
        (active_fact_decision='revoke' AND state='revoked'))
)

learned_sandbox_host_identity(
  sandbox_host_id text PRIMARY KEY, host_identity_hash sha256_text UNIQUE,
  current_registration_fact_id text UNIQUE, current_registration_revision bigint,
  current_key_issue_fact_id text, current_attestation_public_key_id text,
  current_attestation_public_key_hash sha256_text, created_at timestamptz,
  UNIQUE(sandbox_host_id,host_identity_hash,current_registration_fact_id,current_registration_revision,
         current_key_issue_fact_id,current_attestation_public_key_id,current_attestation_public_key_hash)
)

learned_sandbox_host_identity_registration_fact(
  id text PRIMARY KEY, sandbox_host_id text, host_identity_hash sha256_text,
  registration_revision bigint CHECK(registration_revision >= 1),
  action text CHECK(action IN ('register','rotate')),
  predecessor_registration_fact_id text NULL UNIQUE,
  attestation_key_issue_fact_id text, attestation_public_key_id text,
  attestation_public_key_algorithm text CHECK(attestation_public_key_algorithm='ed25519'),
  attestation_public_key_hash sha256_text, key_fact_decision text CHECK(key_fact_decision='issue'),
  evidence_hash sha256_text, registrar_id text, registrar_key_id text,
  signature_algorithm text CHECK(signature_algorithm='ed25519'),
  signed_preimage_hash sha256_text, signature_base64 text,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(id,sandbox_host_id,host_identity_hash),
  UNIQUE(id,sandbox_host_id,host_identity_hash,registration_revision,attestation_key_issue_fact_id,
         attestation_public_key_id,attestation_public_key_hash),
  UNIQUE(sandbox_host_id,registration_revision),
  FOREIGN KEY(predecessor_registration_fact_id,sandbox_host_id,host_identity_hash)
    REFERENCES learned_sandbox_host_identity_registration_fact(id,sandbox_host_id,host_identity_hash),
  FOREIGN KEY(attestation_key_issue_fact_id,attestation_public_key_id,attestation_public_key_algorithm,
              attestation_public_key_hash,key_fact_decision)
    REFERENCES learned_sandbox_attestation_public_key_fact(id,public_key_id,algorithm,public_key_hash,decision),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK((registration_revision=1 AND action='register' AND predecessor_registration_fact_id IS NULL) OR
        (registration_revision>1 AND action='rotate' AND predecessor_registration_fact_id IS NOT NULL))
)

ALTER TABLE learned_sandbox_host_identity
  ADD FOREIGN KEY(current_registration_fact_id,sandbox_host_id,host_identity_hash,current_registration_revision,
                  current_key_issue_fact_id,current_attestation_public_key_id,current_attestation_public_key_hash)
    REFERENCES learned_sandbox_host_identity_registration_fact(
      id,sandbox_host_id,host_identity_hash,registration_revision,attestation_key_issue_fact_id,
      attestation_public_key_id,attestation_public_key_hash) DEFERRABLE INITIALLY DEFERRED;

learned_sandbox_host_boot_attestation_fact(
  id text PRIMARY KEY, sandbox_host_id text, host_identity_hash sha256_text,
  registration_fact_id text, registration_revision bigint,
  attestation_key_issue_fact_id text, attestation_public_key_id text,
  attestation_public_key_hash sha256_text,
  boot_id text UNIQUE, boot_nonce_hash sha256_text UNIQUE, evidence_hash sha256_text,
  booted_at timestamptz, signature_algorithm text CHECK(signature_algorithm='ed25519'),
  signed_preimage_hash sha256_text, signature_base64 text,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(id,sandbox_host_id,boot_id),
  UNIQUE(id,sandbox_host_id,host_identity_hash,registration_fact_id,registration_revision,
         attestation_key_issue_fact_id,attestation_public_key_id,attestation_public_key_hash,boot_id),
  FOREIGN KEY(registration_fact_id,sandbox_host_id,host_identity_hash,registration_revision,
              attestation_key_issue_fact_id,attestation_public_key_id,attestation_public_key_hash)
    REFERENCES learned_sandbox_host_identity_registration_fact(
      id,sandbox_host_id,host_identity_hash,registration_revision,attestation_key_issue_fact_id,
      attestation_public_key_id,attestation_public_key_hash),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

learned_sandbox_host_ledger_root_fact(
  id text PRIMARY KEY, sandbox_host_id text, host_identity_hash sha256_text,
  registration_fact_id text, registration_revision bigint,
  attestation_key_issue_fact_id text, attestation_public_key_id text,
  attestation_public_key_hash sha256_text,
  boot_id text, boot_attestation_fact_id text, ledger_genesis_hash sha256_text UNIQUE,
  root_sequence bigint CHECK(root_sequence=0), previous_hash text NULL,
  evidence_hash sha256_text, signature_algorithm text CHECK(signature_algorithm='ed25519'),
  signed_preimage_hash sha256_text, signature_base64 text,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(id,sandbox_host_id,boot_id,ledger_genesis_hash), UNIQUE(sandbox_host_id,boot_id),
  UNIQUE(id,sandbox_host_id,host_identity_hash,registration_fact_id,registration_revision,
         attestation_key_issue_fact_id,attestation_public_key_id,attestation_public_key_hash,
         boot_id,boot_attestation_fact_id,ledger_genesis_hash),
  FOREIGN KEY(boot_attestation_fact_id,sandbox_host_id,host_identity_hash,registration_fact_id,
              registration_revision,attestation_key_issue_fact_id,attestation_public_key_id,
              attestation_public_key_hash,boot_id)
    REFERENCES learned_sandbox_host_boot_attestation_fact(
      id,sandbox_host_id,host_identity_hash,registration_fact_id,registration_revision,
      attestation_key_issue_fact_id,attestation_public_key_id,attestation_public_key_hash,boot_id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK(previous_hash IS NULL)
)

learned_sandbox_host_boot(
  boot_id text PRIMARY KEY, sandbox_host_id text, host_identity_hash sha256_text,
  registration_fact_id text, registration_revision bigint,
  attestation_key_issue_fact_id text, attestation_public_key_id text,
  attestation_public_key_hash sha256_text,
  boot_attestation_fact_id text UNIQUE, ledger_root_fact_id text UNIQUE,
  ledger_genesis_hash sha256_text UNIQUE, booted_at timestamptz,
  UNIQUE(boot_id,sandbox_host_id),
  UNIQUE(boot_id,sandbox_host_id,host_identity_hash,registration_fact_id,registration_revision,
         attestation_key_issue_fact_id,attestation_public_key_id,attestation_public_key_hash,
         boot_attestation_fact_id,ledger_root_fact_id,ledger_genesis_hash),
  FOREIGN KEY(registration_fact_id,sandbox_host_id,host_identity_hash,registration_revision,
              attestation_key_issue_fact_id,attestation_public_key_id,attestation_public_key_hash)
    REFERENCES learned_sandbox_host_identity_registration_fact(
      id,sandbox_host_id,host_identity_hash,registration_revision,attestation_key_issue_fact_id,
      attestation_public_key_id,attestation_public_key_hash),
  FOREIGN KEY(ledger_root_fact_id,sandbox_host_id,host_identity_hash,registration_fact_id,
              registration_revision,attestation_key_issue_fact_id,attestation_public_key_id,
              attestation_public_key_hash,boot_id,boot_attestation_fact_id,ledger_genesis_hash)
    REFERENCES learned_sandbox_host_ledger_root_fact(
      id,sandbox_host_id,host_identity_hash,registration_fact_id,registration_revision,
      attestation_key_issue_fact_id,attestation_public_key_id,attestation_public_key_hash,
      boot_id,boot_attestation_fact_id,ledger_genesis_hash)
)

learned_sandbox_host_certification_fact(
  id text PRIMARY KEY, certification_hash sha256_text UNIQUE, sandbox_host_id text,
  host_identity_hash sha256_text, host_registration_fact_id text, host_registration_revision bigint,
  attestation_key_issue_fact_id text, attestation_public_key_id text,
  attestation_public_key_hash sha256_text,
  boot_attestation_fact_id text, ledger_root_fact_id text, ledger_genesis_hash sha256_text,
  boot_id text, profile_hash sha256_text, decision text CHECK(decision IN ('issue','revoke')),
  supersedes_fact_id text NULL UNIQUE, evidence_hash sha256_text, certifier_id text, certifier_key_id text,
  signature_algorithm text CHECK(signature_algorithm='ed25519'),
  signed_preimage_hash sha256_text, signature_base64 text,
  reason text, valid_from timestamptz, valid_until timestamptz,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(id,sandbox_host_id), UNIQUE(id,sandbox_host_id,boot_id,profile_hash),
  UNIQUE(id,sandbox_host_id,host_identity_hash,host_registration_fact_id,host_registration_revision,
         attestation_key_issue_fact_id,attestation_public_key_id,attestation_public_key_hash,
         boot_id,boot_attestation_fact_id,ledger_root_fact_id,ledger_genesis_hash,profile_hash),
  FOREIGN KEY(boot_id,sandbox_host_id,host_identity_hash,host_registration_fact_id,host_registration_revision,
              attestation_key_issue_fact_id,attestation_public_key_id,attestation_public_key_hash,
              boot_attestation_fact_id,ledger_root_fact_id,ledger_genesis_hash)
    REFERENCES learned_sandbox_host_boot(
      boot_id,sandbox_host_id,host_identity_hash,registration_fact_id,registration_revision,
      attestation_key_issue_fact_id,attestation_public_key_id,attestation_public_key_hash,
      boot_attestation_fact_id,ledger_root_fact_id,ledger_genesis_hash),
  FOREIGN KEY(profile_hash) REFERENCES learned_sandbox_profile_artifact(profile_hash),
  FOREIGN KEY(supersedes_fact_id,sandbox_host_id)
    REFERENCES learned_sandbox_host_certification_fact(id,sandbox_host_id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK(valid_until > valid_from)
)

learned_sandbox_host_certification_active(
  sandbox_host_id text PRIMARY KEY, active_fact_id text, host_identity_hash sha256_text,
  host_registration_fact_id text, host_registration_revision bigint,
  attestation_key_issue_fact_id text, attestation_public_key_id text,
  attestation_public_key_hash sha256_text,
  boot_id text, boot_attestation_fact_id text, ledger_root_fact_id text,
  ledger_genesis_hash sha256_text, profile_hash sha256_text,
  state text CHECK(state IN ('certified','revoked','expired')),
  projection_revision bigint CHECK(projection_revision >= 1), updated_at timestamptz,
  FOREIGN KEY(active_fact_id,sandbox_host_id,host_identity_hash,host_registration_fact_id,
              host_registration_revision,attestation_key_issue_fact_id,attestation_public_key_id,
              attestation_public_key_hash,boot_id,boot_attestation_fact_id,ledger_root_fact_id,
              ledger_genesis_hash,profile_hash)
    REFERENCES learned_sandbox_host_certification_fact(
      id,sandbox_host_id,host_identity_hash,host_registration_fact_id,host_registration_revision,
      attestation_key_issue_fact_id,attestation_public_key_id,attestation_public_key_hash,
      boot_id,boot_attestation_fact_id,ledger_root_fact_id,ledger_genesis_hash,profile_hash)
)

learned_sandbox_host_state(
  sandbox_host_id text PRIMARY KEY, state text CHECK(state IN ('available','quarantined')),
  state_revision bigint CHECK(state_revision >= 1), active_certification_fact_id text,
  active_boot_id text, active_profile_hash sha256_text,
  quarantine_fact_hash sha256_text NULL, updated_at timestamptz,
  UNIQUE(sandbox_host_id,state_revision),
  FOREIGN KEY(active_certification_fact_id,sandbox_host_id,active_boot_id,active_profile_hash)
    REFERENCES learned_sandbox_host_certification_fact(id,sandbox_host_id,boot_id,profile_hash)
)

learned_sandbox_host_revision(
  sandbox_host_id text, state_revision bigint, state text,
  certification_fact_id text, boot_id text, profile_hash sha256_text,
  fact_hash sha256_text, audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  PRIMARY KEY(sandbox_host_id,state_revision),
  FOREIGN KEY(sandbox_host_id) REFERENCES learned_sandbox_host_state(sandbox_host_id),
  FOREIGN KEY(certification_fact_id,sandbox_host_id,boot_id,profile_hash)
    REFERENCES learned_sandbox_host_certification_fact(id,sandbox_host_id,boot_id,profile_hash),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

learned_sandbox_host_event(
  id text PRIMARY KEY, sandbox_host_id text, state_revision bigint,
  action text CHECK(action IN ('certify','supersede','quarantine','unquarantine','revoke')),
  from_state text, to_state text, certification_fact_id text,
  reason text, fact_hash sha256_text, actor_type actor_type, actor_id text, created_at timestamptz,
  UNIQUE(sandbox_host_id,state_revision),
  FOREIGN KEY(sandbox_host_id,state_revision)
    REFERENCES learned_sandbox_host_revision(sandbox_host_id,state_revision)
)
```

`portable_path_key.v1` 不依赖宿主 Unicode/UCD：合法 path 只允许 ASCII bytes
`[A-Za-z0-9._/-]`，必须是相对 POSIX path、1..255 bytes/1..32 非空 segment；segment 不能是 `.`/`..`、不能前后空格、不能
连续或尾随 `/`。key 是逐 byte 把 `A-Z` 映射到 `a-z`，其它 byte 不变；非 ASCII 输入直接 400。Skill/project/input 三层以
`UNIQUE(run_id,portable_path_key)` 共同拒绝跨 layer collision/shadowing，manifest identity 是 `(layer,path,key,sha256,size,media)`，
排序用 `(portable_path_key,layer)`，mount/broker materialization 必须使用已验证 canonical `path`，不得在 host 再 normalize。
output、diff、typed Tcl snapshot 复用同一算法和 collision 语义。Core 计算后 DB deferred guard 以 ASCII SQL function 重算并拒绝不等值。
run revision、launch/cancel intent、input、final output/
stream、event、profile/cert/event 都 append-only；staged chunk 只能由 retention worker 在 terminal manifest durable 后清理。run 与
host state 是受约束 projection，DB trigger 拒绝 DELETE、binding/hash/actor/time 回写。每次 state edge、revision、audit/outbox
同事务。

`learned_script_run` 的 `(application_id,version_id,skill_id,application_skill_role)` 必须以复合 FK 命中既有 immutable
`skill_application_skill` attachment row；目标表新增 exact 四列 UNIQUE 只为提供可引用身份，不改变其已有
`UNIQUE(application_id,version_id)` 或 one-primary 规则。Core 从 attachment row 复制 `skill_id/role`，caller 不能传或改写 role。v1 允许
exact attached primary 或 supporting version 执行脚本；supporting run 仍是协同事实，不能进入 primary 成功率、first-solved attribution，
也不能借执行结果把该 attachment 提升为 primary。unattached version、属于另一 application 的 version、skill id/role substitution 在 DB
直写与 API 都必须以 `LEARNED_SCRIPT_BINDING_CONFLICT` 零 Run/input/gate/audit/outbox 拒绝。

状态边精确为：

```text
queued  -> running | cancelled
running -> succeeded | failed | cancelled | timeout | unknown_effect
terminal -> terminal（只允许同 terminal_request_hash 的幂等读取；不得改判）
```

claim 原子锁一个 queued run 和 host state，预分配 attempt=1、sandbox instance/container/cgroup identity，创建 append-only
launch intent + run revision + audit/outbox，并在同一事务提交 `queued→running` 后才返回 lease。identity 计算固定为
`base32(sha256("learned-script-launch.v1\0"+run_id+"\0"+attempt+"\0"+sandbox_host_id+"\0"+profile_hash))`；container name
为 `synthia-lsr-<前32字符>`，cgroup relative path 为 `synthia/learned-script/<完整字符>`，不得由 worker/caller替换。任何 OCI
create/start/mount/cgroup effect 都必须发生在 Core launch intent commit 之后。旧/过期 lease 不能写；lease 过期绝不回 queued。
prestart reject 只有取得可认证 `proven_never_accepted` receipt 后才 terminal failed/cancelled；否则 unknown_effect。同 Run 没有
retry/requeue/revive。用户重新执行必须创建新 Run、新 tool_call、新 identity。

每个 host 有独立 append-only、fsync-on-commit launch ledger，至少记录
`intent_received→launch_prepared→oci_accepted|proven_never_accepted|effect_ambiguous→kill_requested→tree_empty|tree_unproven`，每条绑定
launch_request_hash、前项 hash 和 exact identity。worker 在取得 host-local singleton fence（跨进程 OS lock）后先 fsync
`launch_prepared`，再按 deterministic identity query OCI/cgroup/mount：存在则 reconcile，不存在时只有 runtime 提供可认证的
never-accepted receipt 才可继续/终止；timeout、ledger 缺失/损坏、query 矛盾或不能证明 never accepted 均不得创建第二个，必须
terminal unknown_effect + host quarantine。worker/Core restart 都从 Core intent + host ledger + exact identity query 恢复。

`unknown_effect` 表示不能证明整个 OCI/cgroup process tree 已消失或 mount namespace 已卸载；其 output 永不可信、不得进入
application evidence、问题族或 Vivado handoff。同一 `sandbox_host_id` 被 durable quarantine，禁止再 claim，直到运维提供新的
host certification；v1 没有人工把该 run 改为 success/failed 的 route。

host identity、attestation key、boot 与 ledger root 先于 certification 独立冻结。attestation public-key registry routes
`POST /api/v1/internal/evolution/sandbox-attestation-keys/:keyId/{issue|revoke}` 仅 exact singleton
`core:evolution-sandbox-key-issuer`，issuer key 必须在 release allowlist。identity registration routes
`POST /api/v1/internal/evolution/sandbox-hosts/:hostId/identity-registrations/{register|rotate}` 仅 exact singleton
`core:evolution-sandbox-registrar`；registrar key 同样必须在独立 release allowlist。boot/ledger routes
`POST /api/v1/internal/evolution/sandbox-hosts/:hostId/boots` 与
`POST /api/v1/internal/evolution/sandbox-hosts/:hostId/boots/:bootId/ledger-roots` 仅 exact singleton
`core:evolution-sandbox-attestor`，token host binding 必须等于 path host，且签名必须由当前 registration 精确绑定、registry 当前 active 的
host attestation key bytes 验证；只匹配 key id 或 caller 传入 key bytes 不足以验签。

```ts
interface SandboxAttestationPublicKeyMutationV1 {
  schema: "sandbox-attestation-public-key-mutation.v1"; decision: "issue" | "revoke";
  public_key_id: string; algorithm: "ed25519"; public_key_base64: string; public_key_hash: Sha256;
  supersedes_fact_id: string | null; expected_active_projection_revision: number;
  expected_active_fact_id: string | null; evidence_hash: Sha256;
  issuer_id: string; issuer_key_id: string; signed_preimage_hash: Sha256;
  signature_algorithm: "ed25519"; signature_base64: string; reason: string;
}
interface SandboxHostIdentityRegistrationV1 {
  schema: "sandbox-host-identity-registration.v1"; sandbox_host_id: string; host_identity_hash: Sha256;
  action: "register" | "rotate"; expected_registration_revision: number;
  predecessor_registration_fact_id: string | null; attestation_key_issue_fact_id: string;
  attestation_public_key_id: string; attestation_public_key_hash: Sha256; evidence_hash: Sha256;
  registrar_id: string; registrar_key_id: string; signed_preimage_hash: Sha256;
  signature_algorithm: "ed25519"; signature_base64: string;
}
interface SandboxHostBootAttestationV1 {
  schema: "sandbox-host-boot-attestation.v1"; sandbox_host_id: string; host_identity_hash: Sha256;
  registration_fact_id: string; registration_revision: number; attestation_key_issue_fact_id: string;
  attestation_public_key_id: string; attestation_public_key_hash: Sha256;
  boot_id: string; boot_nonce_hash: Sha256; booted_at: IsoDateTime;
  evidence_hash: Sha256; signed_preimage_hash: Sha256;
  signature_algorithm: "ed25519"; signature_base64: string;
}
interface SandboxHostLedgerRootV1 {
  schema: "sandbox-host-ledger-root.v1"; sandbox_host_id: string; host_identity_hash: Sha256;
  registration_fact_id: string; registration_revision: number; attestation_key_issue_fact_id: string;
  attestation_public_key_id: string; attestation_public_key_hash: Sha256;
  boot_id: string; boot_attestation_fact_id: string; ledger_genesis_hash: Sha256;
  root_sequence: 0; previous_hash: null; evidence_hash: Sha256; signed_preimage_hash: Sha256;
  signature_algorithm: "ed25519"; signature_base64: string;
}
interface SandboxHostAuthorityFactResultV1 {
  schema: "sandbox-host-authority-fact-result.v1";
  fact_kind: "attestation_key" | "identity_registration" | "boot_attestation" | "ledger_root";
  fact_id: string; sandbox_host_id: string | null; host_identity_hash: Sha256 | null;
  registration_revision: number | null; attestation_public_key_id: string | null;
  boot_id: string | null; ledger_genesis_hash: Sha256 | null; replayed: boolean;
}
```

四种 signed preimage 分别是删除 `signature_base64/signed_preimage_hash` 后的完整 DTO，加 exact route path、actor scope/id/key id 后 JCS；
Core 复算 `signed_preimage_hash=SHA256(JCS)`。key issue 首项必须 `key_revision=1/supersedes=null`；revoke 必须 revision 恰好 +1、
supersede current active issue，且复制同一 raw 32-byte Ed25519 public key/id/hash；两者都由 Core 复算 raw-key hash，已 revoke key id 不在 v1
重新 issue，rotation 使用新的 active key id/issue fact。registration revision=1/action=register/predecessor=null；同 stable host identity 的
key rotation 必须 action=rotate、revision 恰好 +1、predecessor 等于 current registration，new key issue fact 当前 active，随后原子前移
identity projection。rotation 不改变
`host_identity_hash`，也不受旧的 `(host,identity)` UNIQUE 阻碍；同 predecessor 只能一个 successor。改变 stable host identity 不是 rotate，
必须 human quarantine 后走另行 re-enrollment 决策，v1 不静默接受。旧 key revoke 不能改写旧 boot/history，但立即阻止新 boot、cert、claim。
boot/boot attestation/ledger root 等历史 row 只以复合 FK 指向 immutable registration/key issue facts，绝不能持续 FK 到
`learned_sandbox_host_identity.current_*` 可变 projection，否则 rotation 会破坏旧历史。boot 创建事务的 deferred guard 另行锁定并要求
所引用 registration 恰为当时 identity current registration、key issue 恰为 registry current active issue 且未 revoked；该 guard 只决定
新事实能否提交，不把历史 row 重新解释为仍 current。rotation/revoke 后旧 boot、ledger、cert/launch history 仍可验证但不能创建新 cert、
claim 或 launch。
boot 首次 201/replay 200，boot id/nonce 全局唯一；ledger root 首次 201/replay 200，必须
`root_sequence=0,previous_hash=null` 且一个 boot 恰好一个 root。四类 route 都要求 Idempotency-Key，CAS/签名/
actor/FK 冲突 409：key、registration、boot、ledger 的 signature/preimage 分别使用 §13 对应 signature code，revoked key 使用
`SANDBOX_ATTESTATION_KEY_REVOKED`，跨 fact/revision/hash 混拼使用 `SANDBOX_HOST_CRYPTO_CHAIN_BINDING_INVALID`。response exact 为
`SandboxHostAuthorityFactResultV1`；每个 fact 与 audit/outbox 同事务且 append-only。

profile/host certification 的签名 preimage 分别是
`sandbox-profile-certification.v1` / `sandbox-host-certification.v1` 的 JCS object（删除 signature 字段），包含全部 artifact/hash、
`evidence_hash`、decision、supersedes、validity、host identity/registration fact、boot/attestation fact、ledger root/genesis、
certifier/key id；`signed_preimage_hash=SHA256(JCS)`，Core 用
release allowlist 中 exact Ed25519 public key 验签并复算所有 hash。issue/revoke 都只允许 exact singleton service
`core:evolution-sandbox-certifier`；human `core:write` 只能 quarantine，不能伪造签名 revoke；certifier 不能 issue 自己未产生 evidence 的
profile/host。routes 为 `POST /api/v1/internal/evolution/sandbox-profiles/:profileHash/{issue|revoke}` 与
`POST /api/v1/internal/evolution/sandbox-hosts/:hostId/certifications/{issue|revoke}`；strict body 包含 schema、decision、subject hashes、
expected active projection revision/fact id、validity、evidence hash、certifier/key id、preimage hash、signature、reason，首次 201、
replay 200、CAS/signature/binding 409。

```ts
interface SandboxSignedCertificationV1 {
  schema: "sandbox-signed-certification.v1"; subject_kind: "profile" | "host";
  decision: "issue" | "revoke"; profile_hash: Sha256;
  sandbox_host_id: string | null; host_identity_hash: Sha256 | null; boot_id: string | null;
  host_registration_fact_id: string | null; host_registration_revision: number | null;
  attestation_key_issue_fact_id: string | null; attestation_public_key_id: string | null;
  attestation_public_key_hash: Sha256 | null; boot_attestation_fact_id: string | null;
  ledger_root_fact_id: string | null; ledger_genesis_hash: Sha256 | null; supersedes_fact_id: string | null;
  expected_active_projection_revision: number; expected_active_fact_id: string | null;
  evidence_hash: Sha256; valid_from: IsoDateTime; valid_until: IsoDateTime;
  certifier_id: string; certifier_key_id: string; signed_preimage_hash: Sha256;
  signature_algorithm: "ed25519"; signature_base64: string; reason: string;
}
interface SandboxCertificationResultV1 {
  schema: "sandbox-certification-result.v1"; subject_kind: "profile" | "host";
  fact_id: string; decision: "issue" | "revoke"; profile_hash: Sha256;
  sandbox_host_id: string | null; boot_id: string | null;
  active_state: "certified" | "revoked"; active_projection_revision: number; replayed: boolean;
}
```

profile body 的所有 host/key/boot/ledger 字段必须 null；host body 必须全部非 null，key registry→registration→boot attestation→ledger
root/genesis→certification 的完整 composite subject 一致且 profile active certified。任何从另一个 host、registration、key、old boot 或
ledger root 拼接的“各自有效”事实都必须 FK/guard 拒绝。
revoke 必须 supersede 当前 active issue；
issue 可在无 active fact 时 supersedes null，或 supersede revoke/expired fact。所有 route 要 Idempotency-Key；response exact 为上述 DTO。

锁序固定 `profile artifact→profile active→attestation key active→host identity registration→host identity→boot attestation→ledger root→host boot→host
certification active→host state`。profile/host issue/revoke
只追加 fact 后重算 active projection；不能 UPDATE artifact/fact。host reboot 必须产生由稳定 host identity 签名的新 `boot_id`、boot
attestation 与全新空 ledger genesis；旧 boot certification 立即不匹配 claim，即使仍在 validity 内。新 cert 必须绑定新 boot 与
genesis；ledger 每条 prev hash 必须最终锚定该 genesis。无法证明 stable host identity、boot attestation、ledger genesis/head chain
或旧 boot tree empty 时保持 quarantined，不得把旧 certification/ledger 搬到新 boot。

claim/launch transaction 必须锁 key active、identity current registration、boot、ledger root、cert active 与 host state，并把完整
`(host_id,identity_hash,registration_fact/revision,key_issue_fact/id/hash,boot_id,boot_attestation_fact,
ledger_root_fact/genesis,profile_hash,cert_fact)` 复制到 launch intent。上述单一 composite FK 必须命中 exact certification fact，且
deferred guard 重算 certification/launch preimage、确认 key 仍 active、registration/boot/cert 都是 current；`ledger_genesis_hash` 不能从
FK 中省略。这里 current/active 只作为 transaction-time guard；launch intent、boot、certification 等 append-only history 均只复合 FK 到
immutable facts，不持续引用可变 current projection。任一 mix-and-match、old key/registration/boot、reboot 后旧 cert、只同 host id 的
弱匹配都以 `SANDBOX_HOST_CRYPTO_CHAIN_BINDING_INVALID` 在 `queued→running` 前拒绝且零 effect；仅 key 已 revoked 时使用
`SANDBOX_ATTESTATION_KEY_REVOKED`。

host 控制 route 为 `POST /api/v1/evolution/sandbox-hosts/:hostId/{quarantine|unquarantine}`，仅 human `core:write`；body exact
`{schema:"sandbox-host-control.v1",expected_state_revision,certification_fact_id,boot_id,profile_hash,reason}` + Idempotency-Key。
quarantine 可引用当前 cert；unquarantine 必须引用一条在 quarantine 后创建、supersede 旧 cert、绑定当前 boot/ledger genesis、
尚未过期且 profile 仍 certified 的新 certification，并证明
该 host 所有 running/unknown identity 已 exact query、whole-tree empty、mount detached；否则 409。unknown_effect terminal commit
自动在同一事务写 host quarantine revision/event，不等待 human。manual control 只改变 host projection，永不改判历史 Run。

### 4.2 创建、读取与取消 route

task Runtime route：

- `POST /api/v1/projects/:projectId/tasks/:taskId/skill-applications/:applicationId/script-runs`
- `GET  /api/v1/projects/:projectId/tasks/:taskId/skill-applications/:applicationId/script-runs/:scriptRunId`
- `POST /api/v1/projects/:projectId/tasks/:taskId/skill-applications/:applicationId/script-runs/:scriptRunId/cancel`

创建 body strict exact：

```ts
interface LearnedScriptRunCreateV1 {
  schema: "learned-script-run-create.v1";
  tool_call_id: string;
  version_id: string;
  script_path: string;
  expected_script_sha256: Sha256;
  expected_skill_control_revision: number;
  expected_application_state: "open";
  project_inputs: {
    path: string;
    expected_sha256: Sha256;
    expected_revision_id: string;
  }[];
  input_json: JsonValue;
  timeout_ms: number;
}
```

Core 在锁 application、Skill control、exact version/file、项目 revision 后验证：application 属于 header project/task 且为 open；
version 以 §4.1 四列复合 FK attached 到该 application，且服务端复制的 skill/role 与 attachment exact；script file 与 SHA 精确匹配；version 在该项目可见、scan pass、非 quarantined；Skill
enabled/available；每个项目文件来自 task 绑定 workspace 的 immutable registered revision。Core 从受管 storage 复制 bytes，
拒绝 caller bytes、host path、symlink/reparse/hardlink、非 ASCII path/ASCII-fold collision、hash/revision drift，生成 canonical
`learned-script-input-manifest.v1`。请求只选择已登记相对路径，不能传 source content、runtime、image、command、env、mount 或
Connector 字段。

在上述资源锁之前，Core 必须读取 `tool_call_id` 对应的已提交 immutable task tool-call event 及其 commit fact：name 必须 exact
`learned_script_run`；Project Agent commit fact 必须匹配当前授权 turn/key，bounded task commit fact 必须严格为 raw turn null +
`task:<task_id>` key。args 必须与 HTTP body 删除 `schema/tool_call_id` 后的 JCS
preimage 完全相等；preimage 还固定包含 route 的 `project_id/task_id/application_id` 与 schema
`learned-script-run-tool-call-args.v1`，防止同 body 跨 binding 重放。Core 保存 raw nullable turn、non-null turn binding key、name/args hash
并以复合 FK + deferred role/key guard 绑定。
pending/assistant proposal、不同 task/name、extra/missing arg、hash 漂移均 409 `LEARNED_SCRIPT_TOOL_CALL_CONFLICT`；task role、raw turn、
binding key 或当前授权 turn 组合不符则为 409 `EVOLUTION_TURN_BINDING_CONFLICT`，两者都零 Run/input write。`UNIQUE(task_id,tool_call_id)` 保证一个
committed tool call 最多一个 Run；同 tool-call + 同 Idempotency-Key/body 只 replay 原 Run，换 key 也不得创建第二个；同 key异 body
按 idempotency conflict。锁序从 `task tool-call event→application→Skill control/publication→generation gates→project revisions` 开始。

预算：`project_inputs` 0–256 项，单项不超过 8 MiB、总计不超过 64 MiB；Skill layer 沿用 64 files/1 MiB；`input_json`
JCS 后不超过 64 KiB；timeout 为 1,000–120,000 ms，默认由 caller 显式传 30,000。path 必须符合 §4.1 的 ASCII
`portable-path-key.v1`，1–255 bytes、最多 32 segments、跨 layer case-insensitive 唯一。

首次 create 返回 201，同 key replay 200：

```ts
interface LearnedScriptRunV1 {
  schema: "learned-script-run.v1";
  script_run_id: string;
  application_id: string;
  skill_id: string;
  version_id: string;
  script_path: string;
  language: "python" | "typescript";
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timeout" | "unknown_effect";
  state_revision: number;
  input_manifest_hash: Sha256;
  generation_bindings_hash: Sha256;
  output_manifest_hash: Sha256 | null;
  provenance: LearnedScriptProvenanceV1 | null;
  created_at: IsoDateTime;
  completed_at: IsoDateTime | null;
  replayed: boolean;
}
```

cancel body `{schema:"learned-script-run-cancel.v1",expected_state_revision:number,reason:string}`，要求 Idempotency-Key。
queued 在锁内直接 cancelled/200；running 写 durable cancel intent/202，只有 worker 的 kill proof 后才投影 cancelled；终态同 key
返回 200，异 key/异 intent 409。GET 每次重验 project/task/application ACL，无权或 binding mismatch 统一 404。

```ts
interface LearnedScriptCancelResultV1 {
  schema: "learned-script-cancel-result.v1";
  script_run_id: string;
  state: "running" | "succeeded" | "failed" | "cancelled" | "timeout" | "unknown_effect";
  cancel_status: "cancel_pending" | "terminal";
  state_revision: number;
  cancel_intent_hash: Sha256 | null;
  terminal_error_code: string | null;
  replayed: boolean;
}
```

running/202 只能返回 `state=running,cancel_status=cancel_pending`；queued 直接取消或任一已终态/200 返回完整 terminal union，不能把
unknown/failed/timeout 伪装为 cancelled。privacy/quality/generation cutoff 产生的 cancel intent 使用同 DTO/read semantics。

task Runtime 的 ACL-aware output routes 为：

- `GET .../script-runs/:scriptRunId/outputs/manifest`（无 query）；
- `GET .../script-runs/:scriptRunId/outputs/list`（无 query；最多 64 项，不分页）；
- `POST .../script-runs/:scriptRunId/outputs/read`；
- `POST .../script-runs/:scriptRunId/streams/:stream/read`，`:stream=stdout|stderr`。

四条 route 每次都重验 project/task/application/run binding、source project ACL、terminal state、manifest/entry/stream SHA；任何
无权、错绑、unknown_effect、非终态或未完整 stage 统一 404。file output 只在 succeeded 暴露；stdout/stderr 可在
succeeded/failed/cancelled/timeout 且 whole-tree proof 成立时暴露。所有成功/错误响应都带
`Cache-Control: no-store`、`Pragma: no-cache`、`Vary: Authorization`，不返回 host/container identity。

```ts
interface LearnedScriptOutputManifestReadV1 {
  schema: "learned-script-output-manifest-read.v1";
  script_run_id: string;
  manifest_hash: Sha256;
  entry_count: number;
  total_bytes: number; // only files, 0..8388608
  stdout: {observed_bytes:number;stored_bytes:number;observed_sha256:Sha256;stored_prefix_sha256:Sha256;truncated:boolean};
  stderr: {observed_bytes:number;stored_bytes:number;observed_sha256:Sha256;stored_prefix_sha256:Sha256;truncated:boolean};
}

interface LearnedScriptOutputListReadV1 {
  schema: "learned-script-output-list-read.v1";
  script_run_id: string;
  manifest_hash: Sha256;
  entries: {path:string;sha256:Sha256;size_bytes:number;media_type:string}[];
}

interface LearnedScriptChunkReadRequestV1 {
  schema: "learned-script-chunk-read.v1";
  path: string; // output read only; omitted for stream route
  expected_sha256: Sha256;
  offset_bytes: number;
  length_bytes: number; // 0..8388608
  encoding: "utf8" | "base64";
}

interface LearnedScriptStreamReadRequestV1 {
  schema: "learned-script-stream-read.v1";
  expected_sha256: Sha256;
  offset_bytes: number;
  length_bytes: number; // 0..8388608; stored stream itself <=262144
  encoding: "utf8" | "base64";
}

interface LearnedScriptChunkReadResultV1 {
  schema: "learned-script-chunk-read-result.v1";
  script_run_id: string;
  kind: "output" | "stdout" | "stderr";
  path: string | null;
  sha256: Sha256; // output full SHA or stream stored-prefix SHA
  size_bytes: number; // output full size or stream stored size
  media_type: string;
  offset_bytes: number;
  chunk_size_bytes: number;
  chunk_sha256: Sha256;
  complete: boolean;
  encoding: "utf8" | "base64";
  content_utf8: string | null;
  content_base64: string | null;
}
```

stream read 使用 `LearnedScriptStreamReadRequestV1`；expected SHA 是 stored-prefix SHA。offset 必须 0..size；length
0..8 MiB；实际 chunk 为 `min(length,size-offset)`；`complete` 精确等于
`offset_bytes + chunk_size_bytes === size_bytes`。zero-byte file/stream 合法：只允许 offset=0，任意合法 length 都返回空 bytes、
SHA-256(empty)、chunk_size=0、complete=true。非空对象 offset=size 只在 length=0 时合法并返回 empty/complete=true；其它越界
416。binary 只允许 base64；utf8 必须边界/fatal decode。file streams 不计入 8 MiB file total，二者各最多存 256 KiB。

## 5. Sandbox worker internal API、幂等与 provenance

internal routes 都要求 exact singleton `core:evolution-sandbox`：

- `POST /api/v1/internal/evolution/learned-script-runs/claim`
- `POST /api/v1/internal/evolution/learned-script-runs/:runId/lease`
- `POST /api/v1/internal/evolution/learned-script-runs/:runId/heartbeat`
- `POST /api/v1/internal/evolution/learned-script-runs/:runId/input/manifest`
- `POST /api/v1/internal/evolution/learned-script-runs/:runId/input/read`
- `POST /api/v1/internal/evolution/learned-script-runs/:runId/output/manifest`
- `POST /api/v1/internal/evolution/learned-script-runs/:runId/output/list`
- `POST /api/v1/internal/evolution/learned-script-runs/:runId/output/chunks`
- `POST /api/v1/internal/evolution/learned-script-runs/:runId/streams/:stream/stage`
- `POST /api/v1/internal/evolution/learned-script-runs/:runId/cancel`
- `POST /api/v1/internal/evolution/learned-script-runs/:runId/reconcile`
- `POST /api/v1/internal/evolution/learned-script-runs/:runId/complete`
- `POST /api/v1/internal/evolution/learned-script-runs/:runId/fail`

所有 body 都是 plain object、拒绝未知/缺失字段；所有 mutation 都要求 Idempotency-Key。DTO 冻结如下：

```ts
interface LearnedScriptClaimRequestV1 {
  schema: "learned-script-claim-request.v1";
  worker_id: string;
  sandbox_host_id: string;
  sandbox_host_certification_fact_id: string;
  sandbox_host_boot_id: string;
  host_ledger_genesis_hash: Sha256;
  sandbox_profile_hash: Sha256;
  lease_seconds: number; // integer 30..300
}

interface LearnedScriptClaimResponseV1 {
  schema: "learned-script-claim.v1";
  run: null | {
    run_id: string;
    claim_mode: "start_new" | "reconcile_existing";
    state: "running";
    attempt: 1;
    state_revision: number;
    lease_revision: number;
    lease_token: string;
    lease_expires_at: IsoDateTime;
    launch_intent: {
      launch_intent_id: string;
      sandbox_host_id: string;
      sandbox_instance_id: string;
      container_identity: string;
      cgroup_identity: string;
      launch_request_hash: Sha256;
      committed_at: IsoDateTime;
    };
    input_manifest_hash: Sha256;
    generation_bindings_hash: Sha256;
    sandbox_profile_hash: Sha256;
    outer_image_digest: `sha256:${string}`;
    runner_artifact_digest: `sha256:${string}`;
    runner_kind: "deno" | "cpython-wasi";
    limits: LearnedScriptLimitsV1;
  };
}

interface LearnedScriptLeaseV1 {
  schema: "learned-script-lease.v1";
  lease_token: string;
  expected_state_revision: number;
  expected_lease_revision: number;
  lease_seconds: number; // 30..300
}

interface LearnedScriptLeaseResponseV1 {
  schema: "learned-script-lease-result.v1";
  state_revision: number;
  lease_revision: number;
  lease_expires_at: IsoDateTime;
  cancel_requested: boolean;
}

interface LearnedScriptHeartbeatV1 {
  schema: "learned-script-heartbeat.v1";
  lease_token: string;
  expected_state_revision: number;
  expected_lease_revision: number;
  sandbox_instance_id: string;
  container_identity: string;
  cgroup_identity: string;
  host_ledger_head_hash: Sha256;
  observation: "not_created" | "created" | "running" | "stopped" | "missing" | "ambiguous";
  process_started: boolean;
  wall_ms: number;
  cpu_ms: number;
  memory_peak_bytes: number;
  pids_peak: number;
  output_bytes: number;
  output_files: number;
}

interface LearnedScriptHeartbeatResponseV1 {
  schema: "learned-script-heartbeat-result.v1";
  state_revision: number;
  lease_revision: number;
  lease_expires_at: IsoDateTime;
  action: "continue" | "cancel" | "reconcile";
}

interface LearnedScriptInputManifestRequestV1 {
  schema: "learned-script-input-manifest-read.v1";
  lease_token: string;
  expected_state_revision: number;
  expected_lease_revision: number;
  expected_input_manifest_hash: Sha256;
}

interface LearnedScriptInputManifestResponseV1 {
  schema: "learned-script-input-manifest-result.v1";
  manifest: LearnedScriptInputManifestV1;
  manifest_hash: Sha256;
}

interface LearnedScriptInputChunkReadV1 {
  schema: "learned-script-input-chunk-read.v1";
  lease_token: string;
  expected_state_revision: number;
  expected_lease_revision: number;
  expected_input_manifest_hash: Sha256;
  path: string;
  expected_sha256: Sha256;
  offset_bytes: number;
  length_bytes: number; // 0..8388608
}

interface LearnedScriptInputChunkV1 {
  schema: "learned-script-input-chunk.v1";
  path: string;
  sha256: Sha256;
  size_bytes: number;
  offset_bytes: number;
  chunk_size_bytes: number;
  chunk_sha256: Sha256;
  complete: boolean;
  content_base64: string;
}

interface LearnedScriptOutputManifestStageV1 {
  schema: "learned-script-output-manifest-stage.v1";
  lease_token: string;
  expected_state_revision: number;
  expected_lease_revision: number;
  input_manifest_hash: Sha256;
  manifest: LearnedScriptOutputManifestV1;
  manifest_hash: Sha256;
}

interface LearnedScriptOutputListV1 {
  schema: "learned-script-output-list.v1";
  lease_token: string;
  expected_state_revision: number;
  expected_lease_revision: number;
  expected_manifest_hash: Sha256;
}

interface LearnedScriptOutputListResultV1 {
  schema: "learned-script-output-list-result.v1";
  manifest_hash: Sha256;
  entries: {path:string;size_bytes:number;sha256:Sha256;staged_bytes:number;complete:boolean}[];
  streams: {stream:"stdout"|"stderr";observed_bytes:number;stored_bytes:number;final:boolean}[];
}

interface LearnedScriptOutputChunkStageV1 {
  schema: "learned-script-output-chunk-stage.v1";
  lease_token: string;
  expected_state_revision: number;
  expected_lease_revision: number;
  expected_manifest_hash: Sha256;
  path: string;
  expected_size_bytes: number;
  expected_sha256: Sha256;
  offset_bytes: number;
  chunk_sha256: Sha256;
  content_base64: string; // decoded 0..1048576 bytes
}

interface LearnedScriptStreamStageV1 {
  schema: "learned-script-stream-stage.v1";
  lease_token: string;
  expected_state_revision: number;
  expected_lease_revision: number;
  stream: "stdout" | "stderr"; // must equal path :stream
  offset_bytes: number;
  prefix_chunk_sha256: Sha256;
  content_base64: string; // decoded 0..262144 total stored prefix
  final: boolean;
  observed_bytes: number; // 0..1048576, monotonic
  observed_sha256: Sha256;
  stored_prefix_sha256: Sha256;
  truncated: boolean;
}

interface LearnedScriptWorkerCancelV1 {
  schema: "learned-script-worker-cancel.v1";
  lease_token: string;
  expected_state_revision: number;
  expected_lease_revision: number;
  cancel_intent_hash: Sha256;
  sandbox_instance_id: string;
  host_ledger_head_hash: Sha256;
}

interface LearnedScriptReconcileV1 {
  schema: "learned-script-reconcile.v1";
  lease_token: string;
  expected_state_revision: number;
  expected_lease_revision: number;
  launch_request_hash: Sha256;
  sandbox_instance_id: string;
  container_identity: string;
  cgroup_identity: string;
  host_ledger_head_hash: Sha256;
  result: "proven_never_accepted" | "running" | "stopped_tree_empty" | "effect_ambiguous" | "tree_unproven";
  whole_tree_empty: boolean;
  mount_namespace_detached: boolean;
  proof_hash: Sha256;
}

interface LearnedScriptCompleteV1 {
  schema: "learned-script-complete.v1";
  lease_token: string;
  expected_state_revision: number;
  expected_lease_revision: number;
  input_manifest_hash: Sha256;
  expected_output_manifest_hash: Sha256;
  expected_stdout_observed_sha256: Sha256;
  expected_stderr_observed_sha256: Sha256;
  exit_code: 0;
  provenance: LearnedScriptProvenanceV1;
}

interface LearnedScriptFailV1 {
  schema: "learned-script-fail.v1";
  lease_token: string;
  expected_state_revision: number;
  expected_lease_revision: number;
  terminal_state: "failed" | "cancelled" | "timeout" | "unknown_effect";
  error_code: string;
  details_hash: Sha256;
  retryable: false;
  provenance: LearnedScriptProvenanceV1;
}

interface LearnedScriptStageResultV1 {
  schema: "learned-script-stage-result.v1";
  run_id: string;
  action: "output_manifest" | "output_chunk" | "stdout" | "stderr";
  state: "running";
  state_revision: number;
  lease_revision: number;
  manifest_hash: Sha256 | null;
  staged_bytes: number;
  complete: boolean;
  replayed: boolean;
}

interface LearnedScriptWorkerCancelResultV1 {
  schema: "learned-script-worker-cancel-result.v1";
  run_id: string;
  state: "running" | "succeeded" | "failed" | "cancelled" | "timeout" | "unknown_effect";
  state_revision: number;
  action: "kill_required" | "cancel_pending" | "already_terminal";
  terminal_error_code: string | null;
  replayed: boolean;
}

interface LearnedScriptReconcileResultV1 {
  schema: "learned-script-reconcile-result.v1";
  run_id: string;
  state: "running" | "failed" | "cancelled" | "unknown_effect";
  state_revision: number;
  host_state: "available" | "quarantined";
  next_action: "continue" | "complete_or_fail" | "none";
  replayed: boolean;
}

interface LearnedScriptTerminalResultV1 {
  schema: "learned-script-terminal-result.v1";
  run_id: string;
  state: "succeeded" | "failed" | "cancelled" | "timeout" | "unknown_effect";
  state_revision: number;
  output_manifest_hash: Sha256 | null;
  host_state: "available" | "quarantined";
  replayed: boolean;
}
```

Core 只接受 active issue facts 未 revoked/expired、profile artifact digest 与 release allowlist 相等、host identity/boot/ledger genesis
与 claim 精确匹配的 cert/profile。claim 优先返回同 host+boot 的 lease-expired running
`reconcile_existing`，保留同 launch identity，只递增 lease_revision；不得 OCI create 第二次。不同 host 不接管。5 分钟无
same-host recovery 的 sweeper按 §4 落 unknown/quarantine。

input/output/stream 的 zero-byte 合法：size=0 时 offset=0、length/content=0，chunk SHA 是 SHA-256(empty)，complete=true；
非空对象允许 offset=size 且 length/content=0 读取/重放。output manifest 必须先 stage；path/size/SHA 必须逐 chunk 相符、offset
连续且无洞/重叠。output/list 是只读 staging projection。stdout/stderr **不计入** output files 的 8 MiB；各自 observed hard cap
1 MiB、Core stored prefix 256 KiB，超过 1 MiB 时只追加 rejection fact + durable cancel intent，返回 413 且 Run 保持
`running/cancel_pending`。stream final 后不可追加；
observed SHA 由 certified worker/provenance attest，stored-prefix SHA 由 Core 对 staged bytes 复算。

stage handler 先完成 strict top-level DTO、scope、route run id、lease token/revision、Idempotency-Key 与 `state=running` 校验；这些
步骤失败表示尚未取得可写的 bound Run，固定零 mutation。stage/rejection transaction 必须锁 current Run revision，要求请求的
`(run_id,state_revision,lease_revision)` 命中上述 immutable revision identity、token hash 匹配且 `lease_expires_at > transaction_timestamp()`；
expired/superseded lease 即使曾经合法也必须返回 409 `EVOLUTION_LEASE_CONFLICT`，不能写 rejection/cancel intent/audit/outbox。DB FK 防错 revision，deferred trigger 防止使用历史
lease；没有“先写 rejection 再发现 lease 过期”的顺序。上述校验成功后，任何 manifest/path/type/media/UTF-8
boundary/size/count/total/hash、chunk offset/hole/overlap/replay/final-stream 或 quota rejection，无论最终 HTTP code 是
400/409/413/422，都遵循同一两阶段语义：拒绝
当前 bytes，不把它们纳入 manifest，首次请求原子追加唯一 `learned_script_stage_rejection_fact` + cancel intent + audit/outbox，Run
仍 `running/cancel_pending`；同 request hash replay 同一 rejection，已有 cancel intent 时复用它。worker 必须 kill whole tree。只有随后
complete/fail/reconcile 带 `whole_tree_empty=true`、`mount_namespace_detached=true` 和 exact proof hash 时才可 terminal failed/
cancelled/timeout；proof 缺失或矛盾只能 unknown_effect + host quarantine。HTTP rejection 本身绝不直接写 terminal failed。

reconcile 的 `effect_ambiguous|tree_unproven` 或 false kill proof 在同一事务强制 unknown_effect+host quarantine；
`proven_never_accepted` 也只允许 terminal failed/cancelled，不能回 queued；`running` 继续原 Run；`stopped_tree_empty` 允许随后
complete/fail。cancel route 只确认 worker 已接收 durable intent/开始 whole-tree kill，最终状态仍由 complete/fail/reconcile 提交。

claim 的 key identity 为 `(scope,worker_id,sandbox_host_id,"claim",key)`，同 key replay 原 response、不能领取第二个 Run；其它
internal mutation 为 `(scope,run_id,action,key)`。logical hash 包含 route binding 与 strict canonical body（lease token 只比较其 hash）。同 key/同 hash
返回首次状态，异 hash 409。除 claim 外，每个 internal DTO 都显式包含 `lease_token + expected_state_revision +
expected_lease_revision`；token hash 绑定 run/worker/host boot/state-revision floor/lease revision/expiry，显式 CAS 与 token binding
必须同时成立，read-like POST 也不例外。complete/fail 另存 terminal
request hash，避免换 key 改判。HTTP 首次成功：claim/lease/heartbeat/input-manifest/input-read/output-list/reconcile 为 200；
output-manifest/chunk/stream-stage 与 worker-cancel 为 202；complete/fail 为 200。相同 replay 200；terminal conflict 409。

```ts
interface LearnedScriptProvenanceV1 {
  schema: "learned-script-provenance.v1";
  worker_build_hash: Sha256;
  sandbox_host_id: string;
  sandbox_host_identity_hash: Sha256;
  sandbox_host_boot_id: string;
  sandbox_host_certification_fact_id: string;
  host_ledger_genesis_hash: Sha256;
  host_ledger_head_hash: Sha256;
  sandbox_profile_hash: Sha256;
  outer_image_digest: `sha256:${string}`;
  runner_artifact_digest: `sha256:${string}`;
  runner_version: string;
  container_id_hash: Sha256;
  cgroup_id_hash: Sha256;
  generation_bindings_hash: Sha256;
  input_manifest_hash: Sha256;
  output_manifest_hash: Sha256 | null;
  started_at: IsoDateTime | null;
  ended_at: IsoDateTime;
  wall_ms: number;
  cpu_ms: number;
  memory_peak_bytes: number;
  pids_peak: number;
  exit_code: number | null;
  termination: "normal" | "term_then_kill" | "never_started" | "unproven";
  whole_tree_empty: boolean;
  mount_namespace_detached: boolean;
  proof_hash: Sha256;
}
```

Core 拒绝 `whole_tree_empty=false` 或 `mount_namespace_detached=false` 的 success/failed/cancelled/timeout；只能接受 unknown_effect。
stdout/stderr 分别最多 256 KiB，截断时保留 full observed byte count、prefix hash 与 `truncated=true`，不得进入全局 Skill。

## 6. Certified OCI outer sandbox 合同

### 6.1 唯一受支持执行面

v1 生产执行仅支持经 Gate M5-C 认证的 Linux OCI profile。镜像、runner、seccomp、AppArmor/SELinux policy、rootfs、
runtime binary 和配置都以 release manifest 中的 `sha256:<64 lowercase hex>` 固定；tag、`latest`、host interpreter 或
未认证 digest 一律 `SANDBOX_PROFILE_UNAVAILABLE`。macOS/Windows 开发机若没有同等认证 Linux VM，只能 view/compile，
不能 host-fallback 执行 Python/TypeScript。

外层 profile 精确要求：

1. user/group 固定为无特权 UID/GID 65532；禁止 setuid/setgid；`no_new_privileges=true`；capability bounding、effective、
   permitted、inheritable、ambient sets 全空。
2. rootfs read-only；`/proc` 使用 hidepid/只读最小视图；无 host `/sys`；`/dev` 是空只读 tmpfs 且没有 device node，
   禁止 GPU、USB、JTAG、PCI、serial、Vivado/hw_server device。
3. 新 network namespace 内 loopback 保持 down；没有 veth、route、DNS/hosts credential。seccomp 拒绝 socket/socketpair/
   connect/bind/listen/accept/send/recv；因此 AF_INET/AF_INET6/AF_UNIX/netlink 全不可用。不得挂载 Docker/containerd socket、
   SSH agent、Named Pipe 或主 Runtime IPC。
4. exec environment 必须是 exact empty map `{}`；没有 PATH、HOME、locale、timezone、proxy、Core/Connector/model token、cloud
   credential、project/user value。runtime 以已固定的绝对 executable fd 启动；argv 固定由 runner 构造，Skill/input 不能控制
   executable/options。
5. launcher 在 exec 前关闭除 stdin/stdout/stderr 和已审计只读 input fd 外的所有 fd；stdin 只读固定 `/input/input.json`，
   stdout/stderr 是有界 pipe。不能继承主 Runtime/worker listener、token file、cwd 或 umask state。
6. `/skill` 由 Core managed Skill bytes materialize 成 content-addressed、`portable-path-key.v1` unique tree，以
   `ro,nodev,nosuid,noexec` 挂载；project snapshot **不**以 language-loader 可见的文件树挂载，而编码为
   `/input/project-manifest.json` + `/input/project-bytes.bin`（两者 hash 进入 input manifest）的只读 framed byte broker；
   `/input` 只读；`/output` 是 `rw,nodev,nosuid,noexec` tmpfs。无 `/project` tree、无其它 bind mount。mount root 名包含
   manifest hash，但容器内路径固定，不暴露 host path。
7. cgroup v2 限制：`memory.max=536870912`、`memory.swap.max=0`、`pids.max=64`、CPU quota=1 logical CPU；
   RLIMIT_NOFILE=64、RLIMIT_FSIZE=8 MiB、RLIMIT_CORE=0。wall timeout 由 Core clamp 至 120s，CPU time hard cap 60s。
8. output：最多 64 files，单项 1 MiB，总计 8 MiB；只允许 regular file，path 规则同 §4。拒绝 symlink、hardlink
   (`nlink!=1`)、FIFO、socket、device、reparse/whiteout、sparse logical-size 欺骗、非 ASCII/ASCII-fold collision。launcher 从已经停止的
   container 以 fd-relative no-follow walk 读取，每项复算 size/SHA/media；超限立即 kill/discard。
9. TERM grace 5s，随后 KILL grace 5s。kill 作用于整个 dedicated cgroup/container，而非单 PID；结束必须同时证明
   `cgroup.events populated=0`、cgroup 下无 task、OCI inspect 为 stopped/deleted、mount namespace 已 detach。任一不可读、
   timeout 或矛盾只能上报 unknown_effect。
10. profile certification 包含逃逸、socket、DNS/loopback/Unix socket、fd、env、proc、device、mount、fork bomb、内存、
    CPU、wall、output path/link、kill/restart tests；证书最长有效 24h，worker 每次 claim 前重读并复算 raw/profile hash。

脚本本身没有容器 runtime socket。Sandbox worker 是独立最小进程，只持 sandbox token；主 Runtime 不加载 runner，
`runtime/deps.ts:94-135,191-203` 所示 Connector/Core 配置永不进入 child。Outer OCI 认证失败时没有“仅本地运行”降级。

### 6.2 Canonical input/output manifest

```ts
interface LearnedScriptInputManifestV1 {
  schema: "learned-script-input-manifest.v1";
  script_run_id: string;
  application_id: string;
  skill_id: string;
  version_id: string;
  skill_content_manifest_hash: Sha256;
  source_project_id: string;
  project_snapshot_hash: Sha256;
  input_json_sha256: Sha256;
  entries: {
    path: string;
    layer: "skill" | "project" | "input";
    sha256: Sha256;
    size_bytes: number;
    media_type: string;
    read_only: true;
  }[];
}

interface LearnedScriptOutputManifestV1 {
  schema: "learned-script-output-manifest.v1";
  script_run_id: string;
  entries: {
    path: string;
    sha256: Sha256;
    size_bytes: number;
    media_type: "application/json" | "text/plain" | "application/octet-stream";
  }[];
  stdout: {sha256: Sha256; observed_bytes: number; stored_bytes: number; truncated: boolean};
  stderr: {sha256: Sha256; observed_bytes: number; stored_bytes: number; truncated: boolean};
}
```

entries 按 path UTF-8 bytewise 升序，JCS 后 SHA-256；manifest 不含 host/container path、token、env、command 或 raw secret。
所有 output 继承 source project ACL，classification 固定 `learned_script_output/project_only`，不能自动写回项目、Skill、
Distillation input、formal/evolution_eval evidence、baseline、release、publish 或 hardware selector。主 Agent 可读取后通过既有显式
project edit 工具选择性采用；采用产生正常项目 revision/audit，sandbox 自身没有写权限。

## 7. Python 与 TypeScript 双层运行时

### 7.1 TypeScript

只执行 `scripts/*.ts` 且 `language=typescript`。内层 runtime 是 release manifest 固定 digest 的 Deno；禁止 Bun/Node。
执行前，pinned TypeScript parser 构造完整 import graph：只允许 static relative import，resolve 后必须是同一 exact SkillVersion
manifest 中的 `.ts`；拒绝 `import()`、data/blob/http/file absolute specifier、`node:`、npm/JSDoc type import、import map、plugin、
eval/new Function/WebAssembly dynamic module。trusted bundler 将已验证 graph 机械地合成单一 content-addressed
`/runtime/program.js`；bundle hash、graph nodes/edges 和 compiler digest 写 provenance。任何 parser/compiler diagnostic、unresolved
edge 或 graph/manifest drift 都在 OCI effect 前拒绝。

project snapshot 只作为 `/input/project-manifest.json` + `/input/project-bytes.bin` 的长度前缀 byte broker；manifest 将逻辑 path
映射到 blob offset/length/SHA。程序可按受约束 helper 读取 bytes，但 Deno language loader 看不到 `/project` 路径，`program.js`
没有 dynamic import，且 `/output` 没有 read permission，因而 project/output bytes 不能成为 module。runner 使用 deny-all baseline，
仅授予 read exact `/runtime/program.js,/input/input.json,/input/project-manifest.json,/input/project-bytes.bin` 和 write `/output`；
显式拒绝 env、net、run、ffi、sys、hrtime、prompt。

固定 invocation 由 runner 生成，等价语义为：

```text
deno run --no-config --no-lock --cached-only --no-npm --no-remote
  --allow-read=/runtime/program.js,/input/input.json,/input/project-manifest.json,/input/project-bytes.bin
  --allow-write=/output
  --deny-env --deny-net --deny-run --deny-ffi --deny-sys --deny-hrtime
  /runtime/program.js
```

实际 argv/可执行/bundle/graph digest 写 provenance；原 `<exact script_path>` 只用于构造并验证 graph，不进入 Deno argv。
Deno permission 是内层边界，§6 OCI/seccomp 是独立外层边界；任一层失效都不得放宽另一层。

### 7.2 Python

只执行 `scripts/*.py` 且 `language=python`。内层为 release manifest 固定 digest 的 CPython-WASI + Wasmtime embedding；禁止
host CPython、PyPy、virtualenv、pip 和 native extension。Python `sys.path` exact 只包含固定 `/runtime/stdlib.zip` 与 exact
Skill package `/skill`；没有 project/output。project 同样只能经 `/input/project-manifest.json` + `/input/project-bytes.bin`
读取。WASI preopen fd 3=`/skill` read-only、4=`/input` read-only、5=`/output` create/write（无 execute、无 read-back）；无 inherited
cwd/env、host fd、socket/process API。

stdlib 是固定 content hash，只允许 pure-Python/WASI-compatible modules。`socket`、`subprocess`、`multiprocessing`、`ctypes`、
`cffi`、`resource`、`ssl`、`urllib` network backend 和 native `.so/.dylib/.dll` import 在 importer/runner 双重拒绝；
WASI ABI module 必须 exact `wasi_snapshot_preview1`，allowed imports 仅为：

```text
args_get args_sizes_get environ_get environ_sizes_get
clock_res_get clock_time_get random_get sched_yield proc_exit
fd_advise fd_allocate fd_close fd_datasync fd_fdstat_get fd_fdstat_set_flags
fd_filestat_get fd_filestat_set_size fd_pread fd_prestat_dir_name fd_prestat_get
fd_pwrite fd_read fd_readdir fd_seek fd_sync fd_tell fd_write
path_create_directory path_filestat_get path_open path_remove_directory path_rename path_unlink_file
```

clock 被量化为 10ms、environ exact empty；path mutation rights 只授予 preopen fd5 `/output`，fd3/fd4 只有 lookup/read。
`path_link/path_symlink/path_readlink`、`poll_oneoff`、全部 `sock_*`、任何非该 module import、process spawn、native dlopen 均拒绝
instantiate。CPython module import section、stdlib hash、Wasmtime ABI/host-function table hash 必须与 profile manifest 完全一致；多一项
import 即 profile certification fail。Python 可经 broker 读取 project bytes、写 `/output` regular file，但不能把 project/output
加入 importer，也不能修改 `/skill`/`/input`。

### 7.3 scanner 的地位

现有 Python/TypeScript deny regex（`core/src/services/learned-skill-scan.ts:81-93`）继续作为早期 quarantine 和审计信号，
并升级 scanner version；对混淆、别名、反射、编码或解释器差异的绕过测试可以穿过 scanner，但必须被内层权限或外层 OS
隔离阻断。任何测试不得用“scanner 没匹配”直接证明 sandbox 漏洞，也不得用“scanner 匹配”代替真实隔离测试。

## 8. `learned-tcl-typed.v1`：封闭 grammar、IR 与 Connector handoff

### 8.1 文件与 grammar

普通 `scripts/*.tcl` 仍是 `language=tcl` 的只读参考资产，永久 `executable:false`。可编译资产使用新扩展
`scripts/*.ltcl`、language exact `learned-tcl-typed.v1`、media type `application/vnd.synthia.learned-tcl-typed`。
它不由 Tcl/Vivado interpreter 解释。

forward migration 为 `learned_skill_file` 增加 DB shape check：`.tcl⇔language=tcl⇔media=text/x-tcl⇔executable=false`；
`.ltcl⇔language=learned-tcl-typed.v1⇔media=application/vnd.synthia.learned-tcl-typed⇔executable=false`，且这两种 suffix 不允许其它
language/media。旧数据中任何 `.ltcl`、suffix/language/media 多义或 NULL 都进入 §2.2 同一 migration preflight，先以 redacted
file/version hash 报告并零写中止；管理员须在显式 input 中逐 file 选择 `preserve_reference` 或 `quarantine_version`，整笔重跑时才
应用，绝不自动改类型或部分 quarantine。只有新
Distillation/Curator patch 经 `learned-skill-scanner.vNext` 的 exact typed parser 后才能创建 `.ltcl`。scanner report 保存
parser/compiler version、source hash、grammar result；regex 不能把普通 `.tcl` 升级成 typed。`executable=false` 表示不交给任意
interpreter，typed effect 只能走本节 compile/handoff。

输入必须 UTF-8/NFC、LF、ASCII token，最多 4096 bytes/32 lines。预扫描无条件拒绝任意 `$`、`[`、`]`、`;`、反斜杠、
NUL/control（LF 除外）、quote、brace、colon、comment、空行及前后空格。因此不存在 substitution、command nesting、控制流、
proc、eval、source、package、file、open、exec 或 raw Vivado command。

ABNF 冻结为：

```text
program          = "schema learned-tcl-typed.v1" LF
                   "operation " operation LF
                   "source_set project_snapshot" LF
                   top-line
                   [ testbench-line ]
                   [ constraint-line trial-line ]
                   "end" [ LF ]
operation        = "validate_sources" / "simulate" / "synthesize" / "implement"
top-line         = "top project_declared" LF / "top none" LF
testbench-line   = "testbench project_declared" LF
constraint-line  = "constraint_set project_snapshot" LF
trial-line       = "trial_bitstream policy_bound_true" LF /
                   "trial_bitstream false" LF
```

shape 约束：validate_sources 只允许 `top none|project_declared`，无 testbench/constraint/trial；simulate 必须 top+testbench；
synthesize 必须 top，无其它行；implement 必须 top+constraint+trial。字段顺序固定、不得重复/省略/追加。旧 scanner 中允许的
`get_timing_paths`、`get_cells`、`foreach`、`if` vectors（`core/src/services/learned-skill-scan.ts:104-109`）在本 grammar
全部拒绝；它们不能无歧义映射到现有四 operation。

compiler 是 Core 内的纯 parser + immutable binding assembler，不启动 OCI/Tcl/Vivado；parser 先产生 grammar/symbolic requests，assembler
只从本事务已验证的 binding fact/snapshot/attachment rows 补齐 `bindings`，输出：

```ts
interface LearnedTclTypedIrV1 {
  schema: "learned-tcl-typed-ir.v1";
  operation: "validate_sources" | "simulate" | "synthesize" | "implement";
  binding_requests: {
    source_set: "project_snapshot";
    top: "project_declared" | "none";
    testbench: "project_declared" | null;
    constraint_set: "project_snapshot" | null;
    trial_bitstream: "policy_bound_true" | "false" | null;
  };
  bindings: {
    application_id: string;
    project_id: string;
    task_id: string;
    version_id: string;
    binding_fact_id: string;
    binding_fact_hash: Sha256;
    binding_selection_hash: Sha256;
    policy_fact_hash: Sha256;
    toolchain_profile_hash: Sha256;
    project_snapshot_id: string;
    project_snapshot_hash: Sha256;
  };
  source_sha256: Sha256;
  compiler_version: "learned-tcl-typed-compiler.v1";
  ir_hash: Sha256;
}
```

`ir_hash` 精确等于 SHA-256(JCS(preimage))，其中 preimage 是上述 object **删除 `ir_hash` 字段后**的完整对象；禁止
自引用、字段省略、非 JCS JSON 或其它 hash preimage。DB `ir_preimage_jcs` 只保存这份“删除 ir_hash 后”的 canonical bytes，并直接
digest 得到 `ir_hash`；它不是包含 `ir_hash` 的 full DTO。v1 不另存 full DTO；API response 若返回 full IR，只能由已验证 preimage +
列中的 ir_hash 机械重建。全文中的 “IR JCS” 均指该 `ir_preimage_jcs`，不得再以含 hash 的 object 代替 preimage。

### 8.2 Core compile route 与 project binding

typed Tcl 不创建 OCI LearnedScriptRun。Core 提供同步、task-bound route：

- `POST /api/v1/projects/:projectId/tasks/:taskId/skill-applications/:applicationId/typed-tcl-compilations`
- `GET  /api/v1/projects/:projectId/tasks/:taskId/skill-applications/:applicationId/typed-tcl-compilations/:compilationId`

```sql
ALTER TYPE run_class ADD VALUE IF NOT EXISTS 'learned_script_typed';
ALTER TABLE tool_run
  ADD UNIQUE(id,project_id),
  ADD UNIQUE(id,project_id,run_class,operation,input_manifest_hash);

learned_typed_project_binding_fact(
  id text PRIMARY KEY, project_id text, task_id text, application_id text, version_id text, workspace_id text,
  workspace_revision_hash sha256_text, top text NULL, testbench text NULL, part text NULL,
  trial_bitstream_requested boolean, trial_bitstream_allowed boolean, selection_hash sha256_text,
  policy_fact_hash sha256_text, toolchain_profile_hash sha256_text,
  fact_hash sha256_text UNIQUE, audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(id,application_id,project_id,task_id,version_id,
         fact_hash,selection_hash,policy_fact_hash,toolchain_profile_hash),
  FOREIGN KEY(application_id,task_id,project_id) REFERENCES skill_application(id,task_id,project_id),
  FOREIGN KEY(application_id,version_id) REFERENCES skill_application_skill(application_id,version_id),
  FOREIGN KEY(task_id,workspace_id,project_id) REFERENCES agent_task(id,workspace_id,project_id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

learned_typed_project_snapshot(
  id text PRIMARY KEY, application_id text, project_id text, task_id text, version_id text,
  binding_fact_id text, binding_fact_hash sha256_text, binding_selection_hash sha256_text,
  policy_fact_hash sha256_text, toolchain_profile_hash sha256_text,
  snapshot_hash sha256_text UNIQUE, entry_manifest_hash sha256_text,
  source_count integer CHECK(source_count BETWEEN 1 AND 512),
  constraint_count integer CHECK(constraint_count BETWEEN 0 AND 512),
  total_bytes bigint CHECK(total_bytes BETWEEN 0 AND 67108864), manifest_jcs bytea,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(id,project_id,task_id), UNIQUE(id,snapshot_hash),
  UNIQUE(id,application_id,project_id,task_id,version_id,
         binding_fact_id,binding_fact_hash,binding_selection_hash,
         policy_fact_hash,toolchain_profile_hash,snapshot_hash),
  FOREIGN KEY(binding_fact_id,application_id,project_id,task_id,version_id,
              binding_fact_hash,binding_selection_hash,policy_fact_hash,toolchain_profile_hash)
    REFERENCES learned_typed_project_binding_fact(
      id,application_id,project_id,task_id,version_id,
      fact_hash,selection_hash,policy_fact_hash,toolchain_profile_hash),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK(encode(digest(manifest_jcs,'sha256'),'hex')=snapshot_hash)
)

learned_typed_project_snapshot_entry(
  snapshot_id text, project_id text, task_id text, path text, portable_path_key text,
  role text CHECK(role IN ('source','constraint')), ordinal integer CHECK(ordinal BETWEEN 0 AND 511),
  workspace_file_id text, sha256 sha256_text, size_bytes bigint CHECK(size_bytes BETWEEN 0 AND 8388608),
  media_type text CHECK(media_type IN ('text/x-verilog','text/x-systemverilog','text/x-vhdl','application/x-xdc')),
  managed_content bytea,
  PRIMARY KEY(snapshot_id,path), UNIQUE(snapshot_id,portable_path_key), UNIQUE(snapshot_id,role,ordinal),
  UNIQUE(snapshot_id,path,role,sha256,size_bytes,media_type),
  FOREIGN KEY(snapshot_id,project_id,task_id) REFERENCES learned_typed_project_snapshot(id,project_id,task_id),
  FOREIGN KEY(workspace_file_id,task_id,project_id,path,sha256)
    REFERENCES task_workspace_file(id,task_id,project_id,path,content_hash),
  CHECK(octet_length(managed_content)=size_bytes),
  CHECK(encode(digest(managed_content,'sha256'),'hex')=sha256)
)

learned_tcl_compilation(
  id text PRIMARY KEY, project_id text, task_id text, application_id text,
  skill_id text, version_id text,
  application_skill_role text CHECK(application_skill_role IN ('primary','supporting')),
  script_file_id text, script_sha256 sha256_text,
  tool_call_event_id text, tool_call_event_sequence bigint CHECK(tool_call_event_sequence > 0),
  tool_call_id text, tool_call_turn_id text NULL, tool_call_turn_binding_key text,
  tool_call_name text CHECK(tool_call_name='learned_tcl_compile'),
  tool_call_args_hash sha256_text, state text CHECK(state IN ('compiled','rejected')),
  binding_fact_id text NULL, binding_fact_hash sha256_text NULL,
  binding_selection_hash sha256_text NULL, policy_fact_hash sha256_text NULL,
  toolchain_profile_hash sha256_text NULL,
  project_snapshot_id text NULL, project_snapshot_hash sha256_text NULL,
  ir_hash sha256_text NULL, rejection_code text NULL, request_hash sha256_text,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(task_id,tool_call_id), UNIQUE(id,application_id),
  UNIQUE(id,application_id,project_id,task_id,version_id,
         binding_fact_id,binding_fact_hash,binding_selection_hash,
         policy_fact_hash,toolchain_profile_hash,
         project_snapshot_id,project_snapshot_hash,ir_hash),
  FOREIGN KEY(application_id,task_id,project_id) REFERENCES skill_application(id,task_id,project_id),
  FOREIGN KEY(application_id,version_id,skill_id,application_skill_role)
    REFERENCES skill_application_skill(application_id,version_id,skill_id,role),
  FOREIGN KEY(version_id,skill_id) REFERENCES learned_skill_version(id,skill_id),
  FOREIGN KEY(script_file_id,version_id) REFERENCES learned_skill_file(id,version_id),
  FOREIGN KEY(tool_call_event_id,project_id,task_id,tool_call_event_sequence,tool_call_id,
              tool_call_turn_binding_key,tool_call_name,tool_call_args_hash)
    REFERENCES task_tool_call_commit_fact(event_id,project_id,task_id,event_sequence,tool_call_id,
                                          turn_binding_key,tool_name,args_hash),
  FOREIGN KEY(binding_fact_id,application_id,project_id,task_id,version_id,
              binding_fact_hash,binding_selection_hash,policy_fact_hash,toolchain_profile_hash)
    REFERENCES learned_typed_project_binding_fact(
      id,application_id,project_id,task_id,version_id,
      fact_hash,selection_hash,policy_fact_hash,toolchain_profile_hash),
  FOREIGN KEY(project_snapshot_id,application_id,project_id,task_id,version_id,
              binding_fact_id,binding_fact_hash,binding_selection_hash,
              policy_fact_hash,toolchain_profile_hash,project_snapshot_hash)
    REFERENCES learned_typed_project_snapshot(
      id,application_id,project_id,task_id,version_id,
      binding_fact_id,binding_fact_hash,binding_selection_hash,
      policy_fact_hash,toolchain_profile_hash,snapshot_hash),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK((state='compiled' AND binding_fact_id IS NOT NULL AND binding_fact_hash IS NOT NULL AND
         binding_selection_hash IS NOT NULL AND policy_fact_hash IS NOT NULL AND toolchain_profile_hash IS NOT NULL AND
         project_snapshot_id IS NOT NULL AND project_snapshot_hash IS NOT NULL AND ir_hash IS NOT NULL AND rejection_code IS NULL)
     OR (state='rejected' AND binding_fact_id IS NULL AND binding_fact_hash IS NULL AND
         binding_selection_hash IS NULL AND policy_fact_hash IS NULL AND toolchain_profile_hash IS NULL AND
         project_snapshot_id IS NULL AND project_snapshot_hash IS NULL AND ir_hash IS NULL AND rejection_code IS NOT NULL))
)

learned_tcl_compilation_ir(
  compilation_id text PRIMARY KEY, application_id text, project_id text, task_id text, version_id text,
  binding_fact_id text, binding_fact_hash sha256_text, binding_selection_hash sha256_text,
  policy_fact_hash sha256_text, toolchain_profile_hash sha256_text,
  project_snapshot_id text, project_snapshot_hash sha256_text, ir_hash sha256_text UNIQUE,
  operation text CHECK(operation IN ('validate_sources','simulate','synthesize','implement')),
  ir_preimage_jcs bytea, compiler_version text CHECK(compiler_version='learned-tcl-typed-compiler.v1'),
  created_at timestamptz,
  UNIQUE(compilation_id,application_id,project_id,task_id,version_id,
         binding_fact_id,binding_fact_hash,binding_selection_hash,
         policy_fact_hash,toolchain_profile_hash,
         project_snapshot_id,project_snapshot_hash,ir_hash),
  UNIQUE(compilation_id,application_id,project_id,task_id,version_id,
         binding_fact_id,binding_fact_hash,binding_selection_hash,
         policy_fact_hash,toolchain_profile_hash,
         project_snapshot_id,project_snapshot_hash,operation,ir_hash),
  FOREIGN KEY(compilation_id,application_id,project_id,task_id,version_id,
              binding_fact_id,binding_fact_hash,binding_selection_hash,
              policy_fact_hash,toolchain_profile_hash,
              project_snapshot_id,project_snapshot_hash,ir_hash)
    REFERENCES learned_tcl_compilation(
      id,application_id,project_id,task_id,version_id,
      binding_fact_id,binding_fact_hash,binding_selection_hash,
      policy_fact_hash,toolchain_profile_hash,
      project_snapshot_id,project_snapshot_hash,ir_hash),
  CHECK(encode(digest(ir_preimage_jcs,'sha256'),'hex')=ir_hash)
)

learned_typed_operation_handoff(
  id text PRIMARY KEY, compilation_id text, application_id text, project_id text, task_id text, version_id text,
  binding_fact_id text, binding_fact_hash sha256_text, binding_selection_hash sha256_text,
  policy_fact_hash sha256_text, toolchain_profile_hash sha256_text,
  tool_call_event_id text, tool_call_event_sequence bigint CHECK(tool_call_event_sequence > 0),
  tool_call_id text, tool_call_turn_id text NULL, tool_call_turn_binding_key text,
  tool_call_name text CHECK(tool_call_name='learned_typed_operation_handoff'), tool_call_args_hash sha256_text,
  operation text CHECK(operation IN ('validate_sources','simulate','synthesize','implement')),
  ir_hash sha256_text, project_snapshot_id text, project_snapshot_hash sha256_text, generation_bindings_hash sha256_text,
  state text CHECK(state IN ('created','dispatched','rejected','cancelled')),
  current_dispatch_fact_id text NULL,
  request_hash sha256_text, audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(task_id,tool_call_id), UNIQUE(id,compilation_id),
  UNIQUE(id,compilation_id,application_id,project_id,task_id,version_id,operation,
         binding_fact_id,binding_fact_hash,binding_selection_hash,
         policy_fact_hash,toolchain_profile_hash,
         project_snapshot_id,project_snapshot_hash,ir_hash),
  FOREIGN KEY(compilation_id,application_id,project_id,task_id,version_id,
              binding_fact_id,binding_fact_hash,binding_selection_hash,
              policy_fact_hash,toolchain_profile_hash,
              project_snapshot_id,project_snapshot_hash,ir_hash)
    REFERENCES learned_tcl_compilation(
      id,application_id,project_id,task_id,version_id,
      binding_fact_id,binding_fact_hash,binding_selection_hash,
      policy_fact_hash,toolchain_profile_hash,
      project_snapshot_id,project_snapshot_hash,ir_hash),
  FOREIGN KEY(compilation_id,application_id,project_id,task_id,version_id,
              binding_fact_id,binding_fact_hash,binding_selection_hash,
              policy_fact_hash,toolchain_profile_hash,
              project_snapshot_id,project_snapshot_hash,operation,ir_hash)
    REFERENCES learned_tcl_compilation_ir(
      compilation_id,application_id,project_id,task_id,version_id,
      binding_fact_id,binding_fact_hash,binding_selection_hash,
      policy_fact_hash,toolchain_profile_hash,
      project_snapshot_id,project_snapshot_hash,operation,ir_hash),
  FOREIGN KEY(application_id,task_id,project_id) REFERENCES skill_application(id,task_id,project_id),
  FOREIGN KEY(tool_call_event_id,project_id,task_id,tool_call_event_sequence,tool_call_id,
              tool_call_turn_binding_key,tool_call_name,tool_call_args_hash)
    REFERENCES task_tool_call_commit_fact(event_id,project_id,task_id,event_sequence,tool_call_id,
                                          turn_binding_key,tool_name,args_hash),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK((state='created' AND current_dispatch_fact_id IS NULL) OR
        (state='dispatched' AND current_dispatch_fact_id IS NOT NULL) OR state IN ('rejected','cancelled'))
)

learned_typed_operation_dispatch_fact(
  id text PRIMARY KEY, handoff_id text UNIQUE, compilation_id text,
  application_id text, project_id text, task_id text, version_id text,
  binding_fact_id text, binding_fact_hash sha256_text, binding_selection_hash sha256_text,
  policy_fact_hash sha256_text, toolchain_profile_hash sha256_text,
  project_snapshot_id text, project_snapshot_hash sha256_text, ir_hash sha256_text,
  operation text CHECK(operation IN ('validate_sources','simulate','synthesize','implement')),
  sealed_request_jcs bytea, sealed_request_hash sha256_text, input_manifest_hash sha256_text,
  connector_submission_id text UNIQUE, tool_run_id text UNIQUE,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(id,handoff_id),
  UNIQUE(id,handoff_id,compilation_id,application_id,project_id,task_id,version_id,operation,
         binding_fact_id,binding_fact_hash,binding_selection_hash,
         policy_fact_hash,toolchain_profile_hash,
         project_snapshot_id,project_snapshot_hash,ir_hash,
         sealed_request_hash,input_manifest_hash,tool_run_id),
  UNIQUE(id,connector_submission_id),
  FOREIGN KEY(handoff_id,compilation_id,application_id,project_id,task_id,version_id,operation,
              binding_fact_id,binding_fact_hash,binding_selection_hash,
              policy_fact_hash,toolchain_profile_hash,
              project_snapshot_id,project_snapshot_hash,ir_hash)
    REFERENCES learned_typed_operation_handoff(
      id,compilation_id,application_id,project_id,task_id,version_id,operation,
      binding_fact_id,binding_fact_hash,binding_selection_hash,
      policy_fact_hash,toolchain_profile_hash,
      project_snapshot_id,project_snapshot_hash,ir_hash),
  FOREIGN KEY(compilation_id,application_id,project_id,task_id,version_id,
              binding_fact_id,binding_fact_hash,binding_selection_hash,
              policy_fact_hash,toolchain_profile_hash,
              project_snapshot_id,project_snapshot_hash,ir_hash)
    REFERENCES learned_tcl_compilation(
      id,application_id,project_id,task_id,version_id,
      binding_fact_id,binding_fact_hash,binding_selection_hash,
      policy_fact_hash,toolchain_profile_hash,
      project_snapshot_id,project_snapshot_hash,ir_hash),
  FOREIGN KEY(compilation_id,application_id,project_id,task_id,version_id,
              binding_fact_id,binding_fact_hash,binding_selection_hash,
              policy_fact_hash,toolchain_profile_hash,
              project_snapshot_id,project_snapshot_hash,operation,ir_hash)
    REFERENCES learned_tcl_compilation_ir(
      compilation_id,application_id,project_id,task_id,version_id,
      binding_fact_id,binding_fact_hash,binding_selection_hash,
      policy_fact_hash,toolchain_profile_hash,
      project_snapshot_id,project_snapshot_hash,operation,ir_hash),
  FOREIGN KEY(tool_run_id,project_id) REFERENCES tool_run(id,project_id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK(encode(digest(sealed_request_jcs,'sha256'),'hex')=sealed_request_hash),
  CHECK(input_manifest_hash=sealed_request_hash)
)

ALTER TABLE learned_typed_operation_handoff
  ADD FOREIGN KEY(current_dispatch_fact_id,id)
    REFERENCES learned_typed_operation_dispatch_fact(id,handoff_id) DEFERRABLE INITIALLY DEFERRED;

learned_typed_tool_run_fact(
  id text PRIMARY KEY, dispatch_fact_id text, handoff_id text, compilation_id text,
  application_id text, project_id text, task_id text, version_id text,
  binding_fact_id text, binding_fact_hash sha256_text, binding_selection_hash sha256_text,
  policy_fact_hash sha256_text, toolchain_profile_hash sha256_text,
  project_snapshot_id text, project_snapshot_hash sha256_text,
  ir_hash sha256_text, sealed_request_hash sha256_text, tool_run_id text,
  run_class text CHECK(run_class='learned_script_typed'),
  operation text CHECK(operation IN ('validate_sources','simulate','synthesize','implement')),
  input_manifest_hash sha256_text, audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(dispatch_fact_id,handoff_id,tool_run_id),
  FOREIGN KEY(dispatch_fact_id,handoff_id,compilation_id,application_id,project_id,task_id,
              version_id,operation,binding_fact_id,binding_fact_hash,binding_selection_hash,
              policy_fact_hash,toolchain_profile_hash,
              project_snapshot_id,project_snapshot_hash,ir_hash,
              sealed_request_hash,input_manifest_hash,tool_run_id)
    REFERENCES learned_typed_operation_dispatch_fact(
      id,handoff_id,compilation_id,application_id,project_id,task_id,
      version_id,operation,binding_fact_id,binding_fact_hash,binding_selection_hash,
      policy_fact_hash,toolchain_profile_hash,
      project_snapshot_id,project_snapshot_hash,ir_hash,
      sealed_request_hash,input_manifest_hash,tool_run_id),
  FOREIGN KEY(tool_run_id,project_id,run_class,operation,input_manifest_hash)
    REFERENCES tool_run(id,project_id,run_class,operation,input_manifest_hash),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

learned_typed_connector_response_fact(
  id text PRIMARY KEY, dispatch_fact_id text, connector_submission_id text,
  response_sequence bigint CHECK(response_sequence >= 1),
  state text CHECK(state IN ('accepted','rejected','running','succeeded','failed','cancelled','timeout','unknown_effect')),
  predecessor_id text NULL UNIQUE, predecessor_sequence bigint NULL,
  response_hash sha256_text, response_jcs bytea,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(id,dispatch_fact_id), UNIQUE(id,dispatch_fact_id,response_sequence),
  UNIQUE(dispatch_fact_id,response_sequence), UNIQUE(connector_submission_id,response_hash),
  FOREIGN KEY(dispatch_fact_id,connector_submission_id)
    REFERENCES learned_typed_operation_dispatch_fact(id,connector_submission_id),
  FOREIGN KEY(predecessor_id,dispatch_fact_id,predecessor_sequence)
    REFERENCES learned_typed_connector_response_fact(id,dispatch_fact_id,response_sequence) DEFERRABLE,
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK((response_sequence=1 AND predecessor_id IS NULL AND predecessor_sequence IS NULL) OR
        (response_sequence>1 AND predecessor_id IS NOT NULL AND predecessor_sequence=response_sequence-1)),
  CHECK(encode(digest(response_jcs,'sha256'),'hex')=response_hash)
)
```

这里冻结一个不可拆分的 binding chain。记
`Q=(application_id,project_id,task_id,version_id,binding_fact_id,binding_fact_hash,binding_selection_hash,
policy_fact_hash,toolchain_profile_hash)`，`B=(Q,project_snapshot_id,project_snapshot_hash)`；SQL 中每个引用 Q/B 的 composite FK 与其目标
UNIQUE 必须逐列同顺序、同类型，不能拆成两个“各自有效”的弱 FK，也不能依赖 `MATCH SIMPLE` 的 NULL 行为。compiled chain 的 B
全部 non-null；rejected compilation 才允许整组为 NULL，且不能生成 snapshot/IR/handoff。

`selection_hash` 由 Core 计算为 SHA-256(JCS(`learned-typed-binding-selection.v1`))。preimage 必须保留所有 key，nullable value 使用 JSON
null，且恰含 `application_id/project_id/task_id/version_id/workspace_id/workspace_revision_hash/top/testbench/part/
trial_bitstream_requested/trial_bitstream_allowed/policy_fact_hash/toolchain_profile_hash`；不得省略 unused field、借当前 project profile 补值或接受
caller hash。`fact_hash` 是 SHA-256(JCS(`learned-typed-project-binding-fact.v1`))，preimage 恰含 `binding_fact_id`、上述四项
application/project/task/version identity、`workspace_id`、`selection_hash`、`policy_fact_hash`、`toolchain_profile_hash`。deferred constraint
trigger 从 immutable columns 重建两个 preimage；任一不等整笔回滚。

`entry_manifest_hash` 是按 `(role,ordinal,path)` UTF-8 bytewise 排序的全部 entry
`(path,portable_path_key,role,ordinal,workspace_file_id,sha256,size_bytes,media_type)` 的 Core-fixed
`learned-typed-project-entry-manifest.v1` JCS hash。`manifest_jcs` 的
`learned-typed-project-snapshot.v1` preimage 恰含 `project_snapshot_id`、完整 Q、entry manifest hash、counts/total bytes 与同一完整 entry
array，但不含 `project_snapshot_hash` 以避免自引用；`snapshot_hash=digest(manifest_jcs)`。deferred trigger 从 binding fact 与全部
managed-content entries 重建 entry manifest、snapshot manifest、counts/bytes/hash，禁止把有效 B1 manifest/entries 与有效 B2
binding/part/policy/toolchain 组合。

IR `ir_preimage_jcs.bindings` 必须逐字段等于 B，`ir_hash` 因而同时承诺 typed operation、symbolic requests、script source 与 exact binding
chain。compilation 的 `request_hash` 还必须由 strict committed tool-call args、route identity、attachment row 与 B 的 Core-fixed
`learned-tcl-compilation-request.v1` JCS preimage 重建。binding、snapshot、compilation 与 IR 的 deferred guards 在事务提交前复算所有这些
preimage/hash；不接受“各行 hash 单独有效”作为可 cross-pair 的充分条件。

`learned_tcl_compilation` 与 Run 使用同一 attachment 规则：
`(application_id,version_id,skill_id,application_skill_role)` 必须命中 exact `skill_application_skill` row，role 由 Core 复制；primary 与
supporting 均可 compile/handoff，但 supporting 永不进入 primary evaluation、success rate 或 first-solved attribution。unattached version、
wrong application、skill/role substitution 在任何 binding/snapshot/IR write 前以 `LEARNED_TCL_BINDING_CONFLICT` 拒绝；binding fact 自身还以
`(application_id,version_id)` 命中 exact attachment。DB direct insert 与 HTTP 都必须证明零 binding/snapshot/compilation/IR/audit/outbox。

handoff 的 identity 不能由两条各自有效但可 cross-pair 的弱 FK 拼成。`learned_tcl_compilation` 提供 exact `UNIQUE(id+B+ir_hash)`；handoff
以 matching composite FK 命中该 compiled row，并以另一个 matching FK 命中 `compilation+B+operation+ir_hash` 的 exact IR row。因此
application/task/project、version、binding selection、part/policy/toolchain 或 snapshot 都不能来自另一 compilation。`.ltcl` script file/hash
不复制到 handoff：immutable compilation id 已唯一冻结 `script_file_id/script_sha256`，deferred trigger 仍从该 row 与 IR preimage 复算；
caller 无第二份可替换 script authority。dispatch fact 继续携带 B，并同时复合 FK 到 exact handoff、compilation 与 IR；typed ToolRun fact
再以同一 B + sealed/input/tool-run identity 复合绑定 dispatch。对
`compilation_id/application_id/project_id/task_id/version_id/binding_fact_id/binding_fact_hash/binding_selection_hash/policy_fact_hash/
toolchain_profile_hash/project_snapshot_id/project_snapshot_hash/ir_hash/operation` 任一字段做 substitution，或把有效 B1 snapshot 与有效 B2
binding/part/policy/toolchain 组合，或从两个合法 compilation/handoff 混拼，DB transaction/API 都必须返回
`LEARNED_TCL_DISPATCH_BINDING_CONFLICT`，且零 handoff/dispatch/ToolRun/audit/outbox/Connector effect。若 substitution/cross-pair 首先发生在
binding fact→snapshot→compilation→IR transaction，则 DB composite FK/deferred guard 拒绝，HTTP 统一为
`LEARNED_TCL_BINDING_CONFLICT`，并证明零 binding/snapshot/compilation/IR/handoff/dispatch/ToolRun/audit/outbox/Connector effect；不得先保存一半链再
异步 quarantine。connector response 不重复这些
字段，只以 non-null `(dispatch_fact_id,connector_submission_id)` 复合 FK 指向已闭合的 immutable dispatch row，因此也没有第二条弱 tuple。

```ts
interface LearnedTclCompileV1 {
  schema: "learned-tcl-compile.v1";
  tool_call_id: string;
  version_id: string;
  script_path: string;
  expected_script_sha256: Sha256;
  expected_skill_control_revision: number;
  expected_application_state: "open";
  binding: {
    source_paths: string[];       // 1..512
    top: string | null;
    testbench: string | null;
    part: string | null;
    constraint_paths: string[];   // 0..512
    trial_bitstream_requested: boolean;
  };
}

interface LearnedTclCompilationResultV1 {
  schema: "learned-tcl-compilation-result.v1";
  compilation_id: string;
  state: "compiled" | "rejected";
  application_id: string;
  version_id: string;
  script_path: string;
  script_sha256: Sha256;
  binding_fact_id: string | null;
  binding_fact_hash: Sha256 | null;
  binding_selection_hash: Sha256 | null;
  policy_fact_hash: Sha256 | null;
  toolchain_profile_hash: Sha256 | null;
  project_snapshot_id: string | null;
  project_snapshot_hash: Sha256 | null;
  committed_tool_call_args_hash: Sha256;
  ir: LearnedTclTypedIrV1 | null;
  rejection_code: string | null;
  created_at: IsoDateTime;
  replayed: boolean;
}
```

Core 必须先读取 `tool_call_id` 对应、已提交的 `task_conversation_event`/commit fact，要求 name=`learned_tcl_compile`，并将 event 中 strict args
与 schema=`learned-tcl-compile-tool-call-args.v1`、route project/task/application 及 HTTP body 除 schema/tool_call_id 外字段组成的
JCS preimage byte-equal；event id + `(task_id,sequence)` + payload hash 均须匹配，未提交、不同 task 或参数漂移为
`LEARNED_TCL_TOOL_CALL_CONFLICT`。Project Agent 必须匹配当前授权 `turn:<id>`，bounded task 必须匹配 raw null +
`task:<task_id>`；任何相反 turn/key/role 组合均以 `EVOLUTION_TURN_BINDING_CONFLICT` 在 compiled fact 前 409。Core 随后从
已登记 project workspace 复制 body 指定 paths 的 exact revision bytes，生成 immutable `learned-typed-project-snapshot.v1`：
source entries 恰为 `source_paths`，constraint entries 恰为 `constraint_paths`；不扫描目录、不 glob、不补隐含文件。

selection 规则冻结如下：

- source path 必须为 `.v|.sv|.vhd|.vhdl`，portable unique，1–512；constraint 必须 `.xdc`，portable unique，0–512；同 path
  跨 role、ASCII portable-key collision、重复或不存在均 409，任一数组 >512 为 413 且零 compilation/snapshot write；
- validate_sources：top 可 null，testbench/part/constraints/trial 必须 null/null/[]/false；
- simulate：top/testbench 均为一个合法 HDL identifier 且不同，part=null、constraints=[]、trial=false；
- synthesize：top 为一个 identifier，part 必须与 Core project profile 中**唯一当前 part fact** exact 相等，testbench=null、
  constraints=[]、trial=false；
- implement：top/part 同上，testbench=null；constraint paths 可 0–512，但数组就是完整 constraint set；trial request 仅是请求，
  Core 同快照绑定 policy fact 后得到唯一 boolean；
- `project_declared` 精确指 snapshot metadata 的 body top/testbench；`project_snapshot` 精确指该 snapshot 中按 role bytewise 排序的
  全部 entries。不存在 heuristic/module-name inference。Core part facts 为 0 个、>1 个或与 body 不同，top/testbench 缺失/多值、
  policy fact 缺失/冲突均 409 `LEARNED_TCL_BINDING_CONFLICT`，不得猜测；
- source+constraint 合计还受 §4 64 MiB input；任一 path/hash/revision 在 compile transaction 内漂移则 409。

grammar/HTTP binding 双向 exact：`top none` 当且仅当 body `binding.top=null`，只允许 validate_sources；`top project_declared`
当且仅当 body top 是唯一合法 identifier。testbench line 当且仅当 operation=simulate 且 body testbench 是唯一 identifier。
constraint/trial 两行当且仅当 operation=implement，constraint set 恰等 body 完整数组；`trial_bitstream false` 当且仅当 body request
false，`policy_bound_true` 当且仅当 body request=true 且 snapshot 时唯一 policy fact=true。body true/policy false 或缺失/多义必须
409，不能把 grammar true 改成 false；grammar false/body true 也拒绝。simulate/validate/synthesize 的 unused body fields 必须取上文
exact null/[]/false，IR 每个 binding_request 与 grammar token、body、snapshot/policy 四方相等，否则零 compiled fact。

POST 是同步且无 worker/lease/OCI state：grammar/binding 全通过时同事务写 immutable binding fact、snapshot、全部 managed-content
entries、IR 与 compiled fact，Q/B、selection/fact/manifest/snapshot/request/IR hash、role/order/part/policy/toolchain 全部复算，首次 201；
grammar reject 时只写 immutable rejected compilation fact并返回 422，response 的
`binding_fact_id/binding_fact_hash/binding_selection_hash/policy_fact_hash/toolchain_profile_hash/project_snapshot_id/
project_snapshot_hash/ir` 必须全部 null；
binding/ACL/CAS/limit error 零 write。相同 Idempotency-Key replay
compiled 为 200、rejected 仍为 422；异 body 409。GET 每次按 project/task/application ACL，错绑/无权 404。

### 8.3 Core rebind、run class 与 effect handoff

compiled fact 本身无 Connector effect。主 Agent 若选择采用，必须
通过 task-bound route：

`POST /api/v1/projects/:projectId/tasks/:taskId/skill-applications/:applicationId/typed-tcl-compilations/:compilationId/handoffs`

strict body：

```ts
interface LearnedTypedOperationHandoffV1 {
  schema: "learned-typed-operation-handoff.v1";
  tool_call_id: string;
  expected_ir_hash: Sha256;
  expected_project_snapshot_hash: Sha256;
  expected_skill_control_revision: number;
  expected_application_state: "open";
}
interface LearnedTypedOperationHandoffResultV1 {
  schema: "learned-typed-operation-handoff-result.v1"; handoff_id: string;
  state: "created" | "dispatched" | "rejected" | "cancelled";
  run_class: "learned_script_typed"; operation: "validate_sources" | "simulate" | "synthesize" | "implement";
  binding_fact_hash: Sha256; binding_selection_hash: Sha256;
  policy_fact_hash: Sha256; toolchain_profile_hash: Sha256;
  ir_hash: Sha256; project_snapshot_hash: Sha256; generation_bindings_hash: Sha256;
  tool_run_id: string | null; replayed: boolean;
}
```

Core 锁并重验 application/task/project、publication ACL、Skill control、exact attachment row、compiled full-tuple fact、完整 Q/B、IR/snapshot
hash、immutable `learned_typed_project_binding_fact` 与全部 `learned_typed_project_snapshot_entry`。sealed request 只能从这些 DB immutable rows 重建：
snapshot entries 按 `(role,ordinal,path)` 取 exact managed bytes/path/hash/media，binding fact 提供 top/testbench/part、trial policy 与
toolchain profile；不得回读当前 workspace、目录、HTTP body 或 caller cache，也不得在 dispatch 时补文件/glob/inference。IR 只能选择
symbolic binding，并须与 compilation IR JCS、selection/fact/policy/toolchain hash、snapshot manifest/hash 逐 byte 复算一致。缺失/多义 entry 或 ordinal、
hole/collision、hash drift、policy 禁止均 409，不猜测、不采用 caller value。`policy_bound_true` 只在 immutable binding fact 已明确允许
试验码流时为 true；否则拒绝，不能降格偷偷执行 false。

handoff 在任何 gate/Connector 锁之前读取 `tool_call_id` 的 committed event/commit fact，要求 name exact
`learned_typed_operation_handoff`；Project Agent commit fact 必须匹配当前授权 turn/key，bounded task commit fact 必须匹配 raw null +
task key。event strict
args 与 body 删除 `schema/tool_call_id` 后的 JCS bytes 相等；保存
preimage 还必须包含 schema=`learned-typed-handoff-tool-call-args.v1` 与 route project/task/application/compilation id。保存
raw nullable turn/non-null key/name/args hash 并走上述复合 FK/guard。pending/异 task/name/args、同 tool call 第二个 handoff或换 key重建为
`LEARNED_TCL_TOOL_CALL_CONFLICT`；turn/key/role/current-turn 组合错误为 `EVOLUTION_TURN_BINDING_CONFLICT`；均 409 且零 dispatch。
锁序为 `task tool-call→application→publication/control→compilation/binding/snapshot→generation gates→Connector dispatch fact`。HTTP
handoff transaction 只追加 handoff、exact 四条 generation binding、audit/outbox，初始 `created/null`，不在数据库事务内调用 Connector；
首次 201、同 key replay 200。durable dispatcher 随后锁定同一 handoff 并重新验证 §3 四条 gate 的 kind/subject/generation/hash 全部
匹配；在**一个 Core transaction**内从上述 DB rows 重建 sealed request，生成 deterministic `connector_submission_id`，插入
`run_class='learned_script_typed'` 的真实 `tool_run`、`learned_typed_operation_dispatch_fact`、`learned_typed_tool_run_fact`，把 handoff
projection 前移为 `dispatched` 并绑定 `current_dispatch_fact_id`，同时提交 audit/outbox。任一行缺失或 hash/gate drift 整笔回滚且零
Connector effect。handoff 每个 id 最多一个 dispatch fact；POST replay 若该 transaction 已提交才返回 dispatched/tool_run_id，否则
仍返回 created/null。generation/tool-call/binding CAS 为 409，response 始终 exact `LearnedTypedOperationHandoffResultV1`。

`connector_submission_id` 固定为
`lts_<base32(sha256("learned-typed-submit.v1\0"+handoff_id+"\0"+sealed_request_hash))>`，完整 digest 不截断；caller、dispatcher 与
Connector 均不能替换，DB deferred trigger 必须复算。`tool_run_id` 在上述事务中只创建一次，并被
handoff→dispatch→typed ToolRun 的复合 UNIQUE/FK 锚定。

`sealed_request_jcs` 的 schema/keys/order/hash 由 Core 固定，只包含四项 operation 之一、完整 Q/B、snapshot entry manifest 与 managed bytes
（逐 entry 使用带 padding 的 RFC 4648 standard `content_base64`）、binding fact 中的 top/testbench/part/policy/toolchain 及其 hashes；
不含 `.ltcl`、AST/IR、自由参数、command/raw Tcl。`input_manifest_hash` 必须等于 `sealed_request_hash`。dispatch deferred trigger 从
immutable compilation IR preimage、version、snapshot entries/binding fact 重新构造 sealed request，复算 selection/fact/entry-manifest/snapshot/
IR/request/sealed/input hash，并要求 handoff/compilation/IR/dispatch 的
`application_id/project_id/task_id/compilation_id/version_id/binding_fact_id/binding_fact_hash/binding_selection_hash/policy_fact_hash/
toolchain_profile_hash/project_snapshot_id/project_snapshot_hash/operation/ir_hash` 全相等；typed ToolRun trigger 再要求 dispatch/typed-fact 的
完整 Q/B tuple 及真实 ToolRun 的 `project_id/operation/input_manifest_hash` 相等。复合 FK 使
application/project/task/compilation/version/binding-selection/policy/toolchain/snapshot/IR 与 run-class/operation/input 不可错绑，trigger 防止
即使各 hash 单独有效仍互换两条 compilation/handoff/request chain。专门的双链反例必须以有效 B1 snapshot/entries/manifest + 有效 B2
binding fact/part/policy/toolchain（以及反向组合）提交，二者各自独立校验通过仍必须失败；任一此类失败统一为
`LEARNED_TCL_DISPATCH_BINDING_CONFLICT`，零 dispatch/ToolRun/outbox 与 Connector effect。

Connector submission 只允许以下 durable 顺序：DB dispatch transaction commit 后，outbox worker 用已持久化的
`connector_submission_id + sealed_request_hash` 提交；首次响应 fact 必须为 `accepted|rejected|unknown_effect`，`accepted` 后只允许
`running` 或一个 terminal，`running` 后只允许一个 terminal，terminal=`succeeded|failed|cancelled|timeout|unknown_effect` 且不得有
successor，`rejected` 也是 terminal。deferred trigger 强制同 dispatch、连续 `response_sequence`、predecessor 与允许边；每个响应 fact
和 ToolRun projection edge、evidence manifest、audit/outbox 同事务提交。

dispatcher crash/restart 时必须先按 `connector_submission_id` query Connector：已存在则只导入/复核 response；明确 absent 且 Connector
支持 same-id/same-hash idempotent submit 时，才可重放**同一 id、同一 sealed bytes**，same id/different hash 必拒绝。query/receipt 无法
证明 absent/accepted 时写 `unknown_effect` 并停止自动提交；永远不得换新 submission id、创建第二个 ToolRun 或 blind retry。由此
Connector 传输失败不会造成重复综合/实现。response replay 由 `(connector_submission_id,response_hash)` 去重。

handoff 使用新的 Core-fixed `run_class="learned_script_typed"`，**不是**普通 `exploratory`，也不是 Curator 的
`evolution_eval` route/token。Connector discovery 只能给四项 operation 显式增加该 run class；caller/IR 不能选 run_class。
Core 为该 class 使用与 evolution_eval 同等 sealed bytes、serial/tool timeout、no-hardware policy；Connector 最终只收到四项枚举
operation、Core managed bytes 和 Core-bound fields，不收到 `.ltcl` 文本、AST、IR、Skill file、自由参数、command 或 raw Tcl。

该 run class 所有 output 都是 source-project ACL experimental evidence；`.bit` 必须且只能为
`artifact_classification=experimental/evolution_eval`、`usage_classification=evolution_eval_only`，不得复制回 project workspace。
非 bit evidence 也固定 `usage_classification=evolution_eval_only`。formal/gate/baseline/release/delivery/publish/adopt/download/hardware
selector 必须同时拒绝 `run_class=learned_script_typed` 和上述 classification；禁止 hw_server、device、program/download route。
这样不会把 typed handoff 伪装成普通 exploratory ToolRun。Idempotency-Key、ToolRun audit、snapshot、compilation/IR、dispatch/evidence
hash 形成 append-only trace。

## 9. Human evaluation supersede 合同

Route：

`POST /api/v1/skill-applications/:applicationId/evaluations/:evaluationId/supersede`

actor 必须为 human 且含 `core:write`；每次根据 application source project 重新校验 ACL，无权、跨 app、跨 version 或不存在
统一 404。service、task-runtime、Curator、Evaluator、Sandbox token 均禁止。body strict：

```ts
interface HumanEvaluationSupersedeV1 {
  schema: "human-evaluation-supersede.v1";
  expected_leaf_evaluation_id: string;
  expected_quality_revision: number;
  outcome: "success" | "applicability_failure" | "execution_failure" | "inconclusive";
  confidence: number; // finite, 0..1
  reason: string; // trimmed UTF-8, 1..4096 bytes
}
```

confidence 低于 0.7 时 outcome 必须为 `inconclusive`；`confidence<0.7` 与任一可归因 outcome 的组合 400 且零 write。

要求 Idempotency-Key。path evaluation 必须等于 body expected leaf，且在锁内是该 application/primary SkillVersion 唯一 current
leaf；只能 supersede current leaf，不能从历史节点分叉。Core 从 predecessor **server-side 原样复制** application_id、skill_id、
version_id、evidence_snapshot_hash、evidence_refs、eval_job_refs；client 不能传 refs、project、version、evaluator 或 remediation。
新行 `evaluator_type=human`、`evaluator_version=human-supersede.v1`、`curator_run_id=NULL`，append-only。

M5 migration 必须：

- 新增 `learned_skill_version_status.quality_revision bigint NOT NULL DEFAULT 1`、
  `quarantine_latched boolean NOT NULL DEFAULT false`、`quarantine_origin text NULL CHECK(... IN
  ('scanner','security','curator_evaluation','human_evaluation','privacy'))`，并要求 latch=false 当且仅当 origin NULL；
- 新增 partial root UNIQUE `curator_evaluation(application_id,version_id) WHERE supersedes_id IS NULL`，阻止多个 root；
- 新增 partial UNIQUE `curator_evaluation(supersedes_id) WHERE supersedes_id IS NOT NULL`；
- 给 evaluation 增 `UNIQUE(id,version_id)`，给 version status 墯 exact
  `FOREIGN KEY(last_evaluation_id,version_id) REFERENCES curator_evaluation(id,version_id) DEFERRABLE`；last id 可 NULL 仅当该版本没有
  evaluation；
- 以 deferred constraint trigger 强制 predecessor 与 successor 的 application/skill/version 完全相同；
- DB CHECK 强制 `evaluator_type=human` 当且仅当 `curator_run_id IS NULL` 且
  `evaluator_version='human-supersede.v1'`；`evaluator_type=curator` 当且仅当 `curator_run_id IS NOT NULL`、run/application/version
  复合 FK 成立且 evaluator_version 来自 run。其它 actor/value、SQL NULL 绕过一律拒绝；
- 把现有 root idempotency unique 拆为 `WHERE supersedes_id IS NULL`，human replay 由 Core idempotency table 管理，不能用
  evaluator_version 拼接随机 ID 规避；
- 在同一事务锁 version status、插入 evaluation、从确定初始状态全量重算：scanner/security quarantine 初始且永久为
  `quarantined`，其它 version 初始为 `active_unproven`；再按全部 current leaves canonical application.started_at/
  application.id/evaluation.created_at/evaluation.id 顺序逐项应用冻结 lifecycle 规则。不得把旧 quality projection 当输入；同时全量
  重算 metrics/problem-family trend、递增 quality_revision、更新 last_evaluation_id、追加 lifecycle/audit/outbox。

任一 scanner/security/privacy **或 curator/human evaluation lifecycle** 首次把 quality 投影推入 quarantined 时，必须在同一事务设置
`quarantine_latched=true` 与不可变 first origin；后续全量重算先应用 latch，永远不得恢复为其它 quality，也不得用后来的 human
success 清除。human supersede 仍可保存审计事实，但只能切换非 quarantined 版本或创建新 patch；v1 没有 unlatch route，改变该
语义需另行产品决定。migration 若发现任一 application/version 多 root、跨链 predecessor、last_evaluation 错绑或无法唯一确定既有
quarantine origin，必须走 §2.2 同一只读全量 preflight 与 bounded redacted ambiguity report，保持 rollout/effect gate disabled 并
**零业务写中止 migration**；管理员必须在显式 per-version migration input 中冻结 canonical legacy chain 与 quarantine origin，且输入的
每个原始 row/hash、authority、source attribution/declassification disposition 都通过校验后才允许从头整笔重跑。不得在输入前删除/改写
旧评价、任取 root、先 quarantine/pointer fallback 或暂时建可写 projection；任一未解决多义使整笔回滚。quality CAS 或 leaf CAS 失败为
409 且零业务写。首次成功 201，
同 key replay 200。

## 10. Same-Skill version diff 合同

Route：

`GET /api/v1/projects/:projectId/learned-skills/:skillId/version-diff?from_version_id=&to_version_id=`

只接受这两个 query key；要求 `core:read`。两个 version 必须属于 path Skill 且对 actor 的 path project/global publication 可见；
Core 每次重验 path project ACL；
project-only 内容无 source ACL 统一 404。接口只比较 sanitized immutable Skill assets，不读取 episode、source project、application、
Evidence 或 Connector。相同 version 合法返回空 diff。

```ts
interface LearnedSkillVersionDiffV1 {
  schema: "learned-skill-version-diff.v1";
  skill_id: string;
  from: {version_id:string; version_no:number; manifest_hash:Sha256};
  to: {version_id:string; version_no:number; manifest_hash:Sha256};
  files: {
    path: string;
    change: "added" | "removed" | "modified" | "unchanged";
    from: {sha256:Sha256;size_bytes:number;media_type:string} | null;
    to: {sha256:Sha256;size_bytes:number;media_type:string} | null;
    render_mode: "plain_text" | "metadata_only";
    unified_diff: string | null;
    omitted_reason: "binary" | "invalid_utf8" | "file_too_large" | "diff_too_large" | null;
  }[];
  truncated: boolean;
  rendered_bytes: number;
}
```

union path 最多 128（每 version 64）；按 UTF-8 bytewise 排序。可 text-diff 的 exact media allowlist 为
`text/plain|text/markdown|text/x-tcl|text/x-python|text/typescript|text/verilog|text/systemverilog|text/x-xdc|
application/json|application/yaml|application/vnd.synthia.learned-tcl-typed`；不使用 `text/*` wildcard。只有双方/单方 media 均在
allowlist、文件各不超过 64 KiB、fatal UTF-8 decode 成功时做 LF-preserving line diff。单文件 unified diff 最多 64 KiB/2000 lines，
响应全部 diff 最多 256 KiB；达到边界后该文件/后续文件 metadata-only 并 `truncated=true`，不截断 UTF-8 code point。
binary、oversized、decode fail 分别返回 `binary|file_too_large|invalid_utf8`。`unchanged` 精确为两侧 sha256/size/media 全相等，
固定 `render_mode=metadata_only,unified_diff=null,omitted_reason=null`；其它 metadata-only 必须有非 null omitted_reason；成功 text diff
固定 `render_mode=plain_text,omitted_reason=null`。`rendered_bytes` 只累计所有非 null `unified_diff` 的 UTF-8 bytes，不计 JSON framing、
metadata、path/header 之外由 diff 字符串实际包含的 bytes，也不计 unchanged；256 KiB cap 就是该和。JSON 返回 plain text；Web 必须用 textContent/`<pre>`，禁止 `v-html`、
ANSI/Markdown/HTML interpretation。HTTP 200；无分页、Range、download 或 content alias。

## 11. Project-scoped problem-family facts 与趋势

### 11.1 权威事实

`local_goal`、模型即时聚类、slug 相似度或 outcome claim 都不能成为指标事实。新增 project-scoped、append-only facts：

```sql
ALTER TABLE learning_episode ADD UNIQUE(id,task_id,project_id);
ALTER TABLE learning_episode ADD UNIQUE(id,task_id,project_id,end_event_sequence);
ALTER TABLE skill_application ADD UNIQUE(id,episode_id,task_id,project_id);
ALTER TABLE skill_application ADD UNIQUE(id,task_id,project_id,start_event_sequence);
ALTER TABLE curator_run ADD UNIQUE(id,worker_id,curator_version);

learning_episode_occurrence_fact(
  episode_id text PRIMARY KEY, task_id text, project_id text, occurred_at timestamptz,
  source_event_id text, source_event_sequence bigint CHECK(source_event_sequence >= 1),
  source_event_kind text CHECK(source_event_kind='status'), source_event_payload_hash sha256_text,
  fact_hash sha256_text UNIQUE, audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE,
  created_at timestamptz,
  UNIQUE(episode_id,task_id,project_id,occurred_at),
  UNIQUE(source_event_id,project_id,task_id,source_event_sequence,source_event_kind,source_event_payload_hash,occurred_at),
  FOREIGN KEY(episode_id,task_id,project_id,source_event_sequence)
    REFERENCES learning_episode(id,task_id,project_id,end_event_sequence),
  FOREIGN KEY(source_event_id,project_id,task_id,source_event_sequence,source_event_kind,
              source_event_payload_hash,occurred_at)
    REFERENCES task_conversation_event(id,project_id,task_id,sequence,event_kind,payload_hash,created_at),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

skill_application_start_fact(
  application_id text PRIMARY KEY, task_id text, project_id text, started_at timestamptz,
  source_event_id text, source_event_sequence bigint CHECK(source_event_sequence >= 1),
  source_event_kind text CHECK(source_event_kind='tool_call'), source_event_payload_hash sha256_text,
  fact_hash sha256_text UNIQUE, audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(application_id,task_id,project_id,started_at),
  UNIQUE(source_event_id,project_id,task_id,source_event_sequence,source_event_kind,source_event_payload_hash,started_at),
  FOREIGN KEY(application_id,task_id,project_id,source_event_sequence)
    REFERENCES skill_application(id,task_id,project_id,start_event_sequence),
  FOREIGN KEY(source_event_id,project_id,task_id,source_event_sequence,source_event_kind,
              source_event_payload_hash,started_at)
    REFERENCES task_conversation_event(id,project_id,task_id,sequence,event_kind,payload_hash,created_at),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

problem_family(
  id text PRIMARY KEY, project_id text, family_key text,
  title text, definition text, definition_hash text,
  revision bigint CHECK(revision=1), created_by_type actor_type, created_by text,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(project_id,family_key), UNIQUE(id,project_id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

problem_family_occurrence(
  id text PRIMARY KEY, family_id text, project_id text, task_id text, episode_id text,
  application_id text NULL, occurred_at timestamptz,
  evidence_snapshot_hash sha256_text, created_by_type actor_type, created_by text,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(family_id,episode_id),
  FOREIGN KEY(family_id,project_id) REFERENCES problem_family(id,project_id),
  FOREIGN KEY(episode_id,task_id,project_id) REFERENCES learning_episode(id,task_id,project_id),
  FOREIGN KEY(episode_id,task_id,project_id,occurred_at)
    REFERENCES learning_episode_occurrence_fact(episode_id,task_id,project_id,occurred_at),
  FOREIGN KEY(application_id,episode_id,task_id,project_id)
    REFERENCES skill_application(id,episode_id,task_id,project_id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id)
)

problem_family_outcome_fact(
  id text PRIMARY KEY, occurrence_id text,
  outcome text CHECK(outcome IN ('success','failure','inconclusive')),
  supersedes_id text NULL, reason text, evidence_refs jsonb,
  evaluator_type text CHECK(evaluator_type IN ('curator','human')),
  evaluator_id text, evaluator_version text, curator_run_id text NULL,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  UNIQUE(id,occurrence_id), UNIQUE(supersedes_id),
  FOREIGN KEY(occurrence_id) REFERENCES problem_family_occurrence(id),
  FOREIGN KEY(supersedes_id,occurrence_id)
    REFERENCES problem_family_outcome_fact(id,occurrence_id) DEFERRABLE,
  FOREIGN KEY(curator_run_id,evaluator_id,evaluator_version)
    REFERENCES curator_run(id,worker_id,curator_version),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK((evaluator_type='human' AND evaluator_version='human-problem-family.v1' AND curator_run_id IS NULL) OR
        (evaluator_type='curator' AND curator_run_id IS NOT NULL))
)

CREATE UNIQUE INDEX problem_family_outcome_one_root
  ON problem_family_outcome_fact(occurrence_id)
  WHERE supersedes_id IS NULL;

-- Existing referenced identities are mandatory migration/fresh-schema parity:
-- project(id) PRIMARY KEY; learned_skill(id) PRIMARY KEY; learned_skill_version UNIQUE(id,skill_id).
problem_family_trend_revision(
  project_id text, skill_id text, version_id text, projection_revision bigint CHECK(projection_revision >= 1),
  measurement_state text CHECK(measurement_state IN ('unknown','observed')),
  first_solved_count integer NULL, complete_family_count integer CHECK(complete_family_count >= 0),
  incomplete_family_count integer CHECK(incomplete_family_count >= 0),
  input_fact_hash sha256_text, fact_hash sha256_text UNIQUE,
  audit_event_id text UNIQUE, outbox_event_id uuid UNIQUE, created_at timestamptz,
  PRIMARY KEY(project_id,skill_id,version_id,projection_revision),
  UNIQUE(project_id,skill_id,version_id,projection_revision,fact_hash),
  FOREIGN KEY(project_id) REFERENCES project(id),
  FOREIGN KEY(skill_id) REFERENCES learned_skill(id),
  FOREIGN KEY(version_id,skill_id) REFERENCES learned_skill_version(id,skill_id),
  FOREIGN KEY(audit_event_id) REFERENCES audit_event(id), FOREIGN KEY(outbox_event_id) REFERENCES outbox_event(id),
  CHECK((measurement_state='unknown' AND first_solved_count IS NULL) OR
        (measurement_state='observed' AND first_solved_count IS NOT NULL AND first_solved_count >= 0))
)

problem_family_trend_projection(
  project_id text, skill_id text, version_id text, projection_revision bigint,
  measurement_state text CHECK(measurement_state IN ('unknown','observed')),
  first_solved_count integer NULL, complete_family_count integer,
  incomplete_family_count integer, input_fact_hash sha256_text,
  revision_fact_hash sha256_text, updated_at timestamptz,
  PRIMARY KEY(project_id,skill_id,version_id),
  UNIQUE(project_id,skill_id,version_id,projection_revision),
  FOREIGN KEY(project_id) REFERENCES project(id),
  FOREIGN KEY(skill_id) REFERENCES learned_skill(id),
  FOREIGN KEY(version_id,skill_id) REFERENCES learned_skill_version(id,skill_id),
  FOREIGN KEY(project_id,skill_id,version_id,projection_revision,revision_fact_hash)
    REFERENCES problem_family_trend_revision(project_id,skill_id,version_id,projection_revision,fact_hash),
  CHECK((measurement_state='unknown' AND first_solved_count IS NULL) OR
        (measurement_state='observed' AND first_solved_count IS NOT NULL AND first_solved_count >= 0)),
  CHECK(complete_family_count >= 0 AND incomplete_family_count >= 0)
)
```

family identity/definition 和 occurrence binding 不可变；定义变化创建新 family，不覆盖。`problem_family_outcome_fact` 只用于
`application_id IS NULL` 的无-Skill历史 occurrence；partial unique 强制每个 occurrence 至多一个 root，链只能 supersede
current leaf，且 predecessor 只能有一个 successor。首次 outcome 必须 `supersedes_id=null`；后续必须指向同 occurrence 的当前
leaf，并在同一事务以 expected leaf CAS + deferred FK + unique constraints 防止双 root、分叉或跨 occurrence predecessor。带 application 的
occurrence 的 outcome 必须来自该 application/primary version 的 current `curator_evaluation` leaf，不能复制 outcome claim。

上述 occurrence/start fact 的 event 复合 FK 是时间与顺序权威：episode fact 必须把
`learning_episode.end_event_sequence` 绑定到同 project/task 的 exact `task_conversation_event` status row；application fact 必须把
`skill_application.start_event_sequence` 绑定到 exact tool_call row。deferred trigger 还要求后者 payload 的 `tool_call_id` 等于
application `primary_tool_call_id` 且 name=`learned_skill_apply`。两种 fact 的 `occurred_at/started_at` 都只能复制所绑定 event 的
`created_at`，payload hash 必须与 immutable event 一致；不能使用其它虚构事件表、caller time、row insertion time 或相邻 sequence。
这两条 FK 精确引用 §4 的 generic 七列 event unique，完全不含 `turn_id/turn_binding_key`，也不要求存在
`task_tool_call_commit_fact`：status 永远不是 commit-fact 候选，`learned_skill_apply` start tool call 也不是本 M5 三种 effect-bearing
authority。由此 Project Agent 的 null-turn lifecycle/status 可以成为合法 problem-family 时间权威；非 tool event 仍不能冒充 application
start，application start 也不能改绑另一 task/kind/hash/time。

写 actor 仅 human `core:write` + source ACL，或 exact Curator service `core:evolution-curator` 在当前 run 已绑定 evidence 时；
task-runtime/Distiller/Sandbox/Evaluator 均不能创建 family/outcome。human routes：

- `POST /api/v1/projects/:projectId/problem-families`
- `POST /api/v1/projects/:projectId/problem-families/:familyId/occurrences`
- `POST /api/v1/projects/:projectId/problem-families/:familyId/occurrences/:occurrenceId/outcomes`

每个 body 带 schema、reason、expected family revision/leaf（适用时）和 Idempotency-Key；来源 episode/application binding 由
Core 重查，跨项目/无 ACL 404。Curator 使用同一 domain service 的 internal typed DTO，不另建宽 route。

human strict bodies 冻结为：

```ts
interface ProblemFamilyCreateV1 {
  schema: "problem-family-create.v1";
  family_key: string; // ^[a-z0-9]+(?:-[a-z0-9]+)*$, 1..128 bytes
  title: string;      // trimmed, 1..256 UTF-8 bytes
  definition: string; // trimmed, 1..4096 UTF-8 bytes
  reason: string;     // trimmed, 1..4096 UTF-8 bytes
}

interface ProblemFamilyOccurrenceCreateV1 {
  schema: "problem-family-occurrence-create.v1";
  episode_id: string;
  application_id: string | null;
  expected_family_revision: 1;
  reason: string;
}

interface ProblemFamilyOutcomeCreateV1 {
  schema: "problem-family-outcome-create.v1";
  outcome: "success" | "failure" | "inconclusive";
  expected_leaf_outcome_fact_id: string | null;
  expected_family_revision: 1;
  reason: string;
  evidence_refs: {type:string;id:string;sha256:Sha256}[]; // max 64
}

interface CuratorProblemFamilyCreateV1 {
  schema: "curator-problem-family-create.v1"; lease_token: string;
  expected_curator_run_revision: number; expected_lease_revision: number;
  family_key: string; title: string; definition: string; reason: string;
}
interface CuratorProblemFamilyOccurrenceCreateV1 {
  schema: "curator-problem-family-occurrence-create.v1"; lease_token: string;
  expected_curator_run_revision: number; expected_lease_revision: number;
  episode_id: string; application_id: string | null; expected_family_revision: 1; reason: string;
}
interface CuratorProblemFamilyOutcomeCreateV1 {
  schema: "curator-problem-family-outcome-create.v1"; lease_token: string;
  expected_curator_run_revision: number; expected_lease_revision: number;
  outcome: "success" | "failure" | "inconclusive";
  expected_leaf_outcome_fact_id: string | null; expected_family_revision: 1; reason: string;
}
interface ProblemFamilyWriteResultV1 {
  schema: "problem-family-write-result.v1"; action: "family" | "occurrence" | "outcome";
  family_id: string; occurrence_id: string | null; outcome_fact_id: string | null;
  family_revision: 1; current_leaf_outcome_fact_id: string | null;
  occurred_at: IsoDateTime | null; evidence_snapshot_hash: Sha256 | null; replayed: boolean;
}
```

family 是 immutable identity，`revision` 在 v1 固定为 1；没有 update/delete route。Occurrence 若 application 非 null，Core
要求其 immutable episode_id 与 body episode_id 相同，且禁止创建 outcome fact；其 outcome 只看 evaluation current leaf。
无 application occurrence 才接受 outcome route。`occurred_at` 永远由 Core 从已绑定 `learning_episode` 的权威发生时间复制，
client/internal caller 都不能传时间。唯一权威字段是 `learning_episode_occurrence_fact.occurred_at`，它等于 episode terminal
`task_conversation_event.created_at`，并与 DB-assigned `sequence/id/payload_hash` 同事务冻结；application start 同理由
`skill_application_start_fact` 冻结。新 episode/application 在对应 lifecycle commit 同事务写 fact；旧数据只有
`end_event_sequence/start_event_sequence` 指向的 exact status/tool_call row 且 composite identity 全匹配时才能 backfill，否则保持
missing/incomplete 并拒绝新 occurrence 409，不能按 timestamp 搜索“最近事件”或用 request/DB `now()` 猜测。
`evidence_snapshot_hash` 也不属于任何 caller DTO：Core 在同一写事务重读 episode、可选 application 及其已提交 immutable evidence
bindings，按 `(project_id,task_id,episode_id,application_id-or-null)` 与按 `type,id,sha256` bytewise 排序的完整 evidence refs 构造
`problem-family-evidence-snapshot.v1` JCS，并取 SHA-256；任一 ref 缺 hash、漂移、多义或不属于该 binding 都 409 且零写。
created actor/time 同样由 Core 注入。首次 create 201，同 key replay 200，current-leaf/family CAS 冲突 409。

Curator exact singleton routes 为
`POST /api/v1/internal/evolution/curator-runs/:runId/problem-families`、
`POST .../:runId/problem-families/:familyId/occurrences`、
`POST .../:runId/problem-families/:familyId/occurrences/:occurrenceId/outcomes`，只接受上述三个 strict DTO；scope 必须 exact
`core:evolution-curator`。Core 从 run/lease 注入 evaluator id/version 与完整 evidence refs/hash，caller 不得传。human/Curator 首次
成功都 201、同 key replay 200；strict/schema 400、ACL/binding conceal 404、leaf/family/run/lease CAS 409、evidence incomplete 422。
response 都是 `ProblemFamilyWriteResultV1` 且 no-store；两 lane 共用同一锁序/domain transaction。

### 11.2 “以前失败、现在首次成功”的 exact 算法

对一个 SkillVersion `V` 与一个 project family `F`，只有以下条件全部满足时，F 为 V 的 first-solved family：

1. 存在 timeline key 小于 S start key 的完整无-Skill occurrence，其 current outcome=`failure`；
2. `S` 是按下述统一六元 application-start timeline key 排序最早的、primary
   version=`V` 且 current evaluation=`success` 的
   occurrence；
3. 在 S 之前，F 没有任何完整 occurrence 的 current outcome=`success`（无 Skill、其它 Skill、V 的父版本均计入）；
4. S 的 version/content hash 与 application 固定事实一致；supporting Skill 不归因；
5. F 在 S 及所有更早 occurrence 都有显式 family binding 和完整 current outcome。

所有比较统一使用同 arity、同类型、lexicographic total order：
`(event_at,task_id,event_sequence,event_id,entity_kind,entity_id)`，timestamp 后所有 text 都按 UTF-8 bytewise 排序。problem occurrence
映射为 `(occurred_at,task_id,source_event_sequence,source_event_id,"problem_occurrence",occurrence_id)`；application start 映射为
`(started_at,task_id,source_event_sequence,source_event_id,"application_start",application_id)`。第一项就是绑定 event 的 `created_at`；
timestamp 相同先按 task id、DB sequence、event id、entity kind/id 依次消歧。不得比较五元与四元 tuple、不得省略 task id，也绝不只
依赖 timestamp、episode id 或 fact 插入顺序。

因此可表达“无 Skill 旧失败 → 有 Skill 首次成功”。inconclusive、pending、缺 family binding、缺 no-Skill outcome、分叉 outcome/
evaluation leaf 或 ACL 不可验证，使相应 family 为 incomplete；不能当作 0。若一个 version 的任一 evaluated primary application
缺少完整 family facts，version 的 `first_solved_problem_families=null`、measurement state 对该指标为 unknown，同时返回
`incomplete_family_count`；只有 facts 完整才返回 observed/count。

新增 read route：

`GET /api/v1/learned-skills/:skillId/versions/:versionId/problem-family-trend`

```ts
interface ProblemFamilyTrendV1 {
  schema: "problem-family-trend.v1"; skill_id: string; version_id: string;
  measurement_state: "unknown" | "observed";
  first_solved_problem_families: number | null;
  complete_family_count: number; incomplete_family_count: number;
  causality: "observational_non_causal"; visible_input_fact_hash: Sha256;
  visible_projection_revision_hash: Sha256;
}
```

projection 每行只含一个 `project_id` 的 facts；每次 Curator evaluation、human supersede、family/occurrence/outcome fact 提交时，
在同一事务锁该 project/version projection，按该项目全部 current leaves canonical 全量重算、递增 projection_revision，并保存
project-scoped input fact hash/audit，禁止把全局聚合回写任一行。revision 与 projection 都必须以 `project(id)` 和
`learned_skill_version(id,skill_id)` 的 FK 证明 project/version/skill identity；projection 的复合 FK 还必须命中 exact revision
`fact_hash`。deferred trigger 逐字段要求 projection 的 measurement/count/input hash 等于该 revision，不能只碰巧引用同 revision number。
read 每次重新求当前 actor 有 source project ACL 且该版本可见的
project id 集合，只读取并聚合这些 project rows；无可见 project 统一 404，无权 family/project 不暴露 id/title、count、revision
或是否存在。`complete_family_count`/`incomplete_family_count` 对可见行求和；只有所有可见 project row 都是 observed 时才返回
`measurement_state=observed` 与 `first_solved_count` 求和，否则返回 unknown/null。DTO 明确
`causality:"observational_non_causal"`；visible hashes 由可见 project row 的 hash/revision 排序后 JCS 再 hash，不返回 project id。
成功 200，ACL/无可见版本 404，projection integrity 503；响应带 `Cache-Control: no-store`、`Pragma: no-cache`、
`Vary: Authorization`。generic `SkillMetrics`/search/summary 不允许读取全局 projection 或缓存 count：M5 v1 中其
`first_solved_problem_families` 固定 null、measurement unknown；只有本 actor-aware route 可返回 count，避免跨项目侧信道。scanner
quarantined 不改变历史指标，但 Skill recommendation 仍按生命周期规则 fail closed。

## 12. Historical evolution_eval evidence 内容读取

Route exact：

`GET /api/v1/skill-applications/:applicationId/evaluations/:evaluationId/eval-jobs/:evalJobId/evidence/:entryName`

只要求 `core:read`，但每次请求必须从 DB 重新验证：application 存在 → evaluation 属于 application → eval_job 在该 evaluation 的
`eval_job_refs` 且属于 application → job.project_id 等于 application.project_id → frozen conclusion/manifest 存在 → entry 属于
该 frozen fact/job/name。然后按当前 actor 对 source project 调用 ACL。任一不存在、binding mismatch、非 frozen、无权或已被
另一 manifest 替换均统一 404，不能用不同 error 探测跨项目存在性。

route 只读 `evolution_eval_evidence_entry.managed_content`（`core/src/db/schema.sql:3956-3993`）；不访问 Connector、workspace、
旧 Evaluator token，也不开放 `core:evolution-eval` 历史别名。M4 的 public metadata projection
（`core/src/api/self-evolution-handlers.ts:672-755`）继续保留。

query exact 为 `offset_bytes`、`length_bytes`、`encoding`：offset integer 0..size；length integer 0..8,388,608，实际 chunk
为 `min(length,size-offset)`；encoding=`utf8|base64`。zero-byte entry 合法，唯一 offset=0，任意合法 length 均返回 empty bytes；
非空 entry 的 offset=size 仅在 length=0 时合法并返回 empty bytes。其它 offset/length 越界为 416
`EVOLUTION_EVIDENCE_RANGE_INVALID`，零 DB mutation。binary media 只允许 base64。text/json utf8 请求必须在 UTF-8 code point
边界切片且 fatal decode 成功，否则 400 `EVOLUTION_EVIDENCE_UTF8_BOUNDARY_INVALID`；caller 可改用 base64。

```ts
interface EvolutionEvalHistoricalEvidenceContentV1 {
  schema: "evolution-eval-historical-evidence-content.v1";
  application_id: string;
  evaluation_id: string;
  eval_job_id: string;
  evidence_fact_id: string;
  evidence_manifest_hash: Sha256;
  name: string;
  sha256: Sha256;            // full entry
  size_bytes: number;        // full entry
  media_type: string;
  artifact_classification: "experimental/evolution_eval" | "evolution_eval_evidence";
  usage_classification: "evolution_eval_only";
  offset_bytes: number;
  chunk_size_bytes: number;
  chunk_sha256: Sha256;
  complete: boolean;
  encoding: "utf8" | "base64";
  content_utf8: string | null;
  content_base64: string | null;
}
```

`complete` 精确等于 `offset_bytes + chunk_size_bytes === size_bytes`；因此 zero-byte 和合法 EOF empty read 都为 true。每次读取在
发出任何 content 前都以有界 streaming buffer 对完整 `managed_content` 重算 size/SHA-256，并同时核对 entry row、冻结 manifest
中的 size/SHA 与请求绑定；不能只信 DB metadata。任一不一致返回 503 `EVOLUTION_EVIDENCE_INTEGRITY_FAILED`，不返回部分 bytes、
不 fallback 到 Connector/workspace，也不产生业务 mutation。单次 decoded response hard cap 8 MiB；完整性校验可以流式遍历完整
content，但内存中不得缓冲超过请求 chunk 与固定 hash buffer。chunk SHA 对实际返回 bytes 实时复算。所有成功与错误响应都带
`Cache-Control: no-store`、`Pragma: no-cache`、`Vary: Authorization`。
`.bit` 对有 ACL actor 可按 base64 chunk 读取，但始终返回
`artifact_classification=experimental/evolution_eval`、`usage_classification=evolution_eval_only`；该读能力不是 formal/hardware
download，不能提供 approve/adopt/baseline/release/delivery/publish/program route，也不能改变 M4 selectors。

## 13. Stable HTTP error、retry 与 mutation 语义

除上位合同已有 error 外，M5 exact errors：

| HTTP / code | retryable | DB mutation | 语义 |
|---|---:|---|---|
| 400 `LEARNED_SCRIPT_INVALID_REQUEST` | 否 | 否 | strict DTO/path/hash/timeout/query 非法 |
| 400 `EVOLUTION_TOOL_ARGS_INVALID` | 否 | 否 | 三种 effect-bearing tool-call 的 Runtime args 不是受限 plain JSON object、含非法值或超出 depth/size/key-count；必须在候选 event 与工具 effect 前拒绝，不影响 generic event payload |
| 400 `LEARNED_SCRIPT_UTF8_BOUNDARY_INVALID` | 否 | pre-bind 零写；bound stage rejection + cancel intent、仍 running | output/stream utf8 chunk 非法；已绑定 staging 不允许换编码继续同 Run |
| 400 `EVOLUTION_EVIDENCE_UTF8_BOUNDARY_INVALID` | 否 | 否 | utf8 chunk 非法，改用 base64 |
| 401 `AUTHENTICATION_REQUIRED` | 否 | 否 | token 缺失/无效 |
| 403 `EVOLUTION_SCOPE_FORBIDDEN` | 否 | 否 | 非 exact singleton/mixed scope/actor 不符 |
| 403 `LEARNED_SCRIPT_EFFECT_FORBIDDEN` | 否 | 否 | typed handoff 企图 raw/formal/hardware/publish effect |
| 404 `EVOLUTION_NOT_FOUND` | 否 | 否 | 资源不存在或 ACL/binding conceal |
| 409 `EVOLUTION_CAS_CONFLICT` | 是 | 否 | control/application/quality/publication/state revision drift |
| 409 `LEARNED_SKILL_GLOBAL_ACTIVATION_CONFLICT` | 是 | 否 | global pointer/version、global control revision 或 non-null target immutable publication revision 不匹配；A→B→A 的旧 CAS 也必须失败 |
| 409 `EVOLUTION_IDEMPOTENCY_CONFLICT` | 否 | 否 | 同 key 异 logical hash |
| 409 `EVOLUTION_LEASE_CONFLICT` | 是 | 否 | sandbox lease 旧/过期/不匹配；stage route 在 lease 过期时 rejection/cancel/audit/outbox 也必须零写 |
| 409 `EVOLUTION_TURN_BINDING_CONFLICT` | 否 | 否 | 物化或使用 effect-bearing commit fact 时，Project Agent 的 non-null turn/key 或 bounded run/side 的 null turn/task key 与 task role、当前授权 turn 不一致；generic event 无此错误 |
| 409 `LEARNED_SCRIPT_STATE_CONFLICT` | 否 | 否 | 非法状态边/终态改判 |
| 409 `LEARNED_SCRIPT_BINDING_CONFLICT` | 否 | 否 | app/version attachment 缺失或属于另一 application、skill/primary-supporting role substitution，或 script/snapshot/manifest/IR drift |
| 409 `LEARNED_SCRIPT_TOOL_CALL_CONFLICT` | 否 | 否 | create event 非 exact effect-bearing committed tool-call fact（含非 tool event 冒充）、name/args 不符，或 tool call 已绑定另一 Run |
| 409 `LEARNED_TCL_TOOL_CALL_CONFLICT` | 否 | 否 | compile/handoff event 非 exact effect-bearing committed tool-call fact（含非 tool event 冒充）、name/args 不符或重复 effect |
| 409 `LEARNED_TCL_BINDING_CONFLICT` | 否 | 否 | binding→snapshot→compilation→IR 的 app/version attachment、tool-call args、workspace selection、binding fact/id/hash、selection/part/policy/toolchain、snapshot/manifest 或 IR 任一漂移、多义、逐字段 substitution；含两条各自有效的 B1 snapshot 与 B2 binding/part/policy/toolchain cross-pair |
| 409 `LEARNED_TCL_DISPATCH_BINDING_CONFLICT` | 否 | 否 | handoff/dispatch/typed ToolRun 的 compilation/application/project/task/version/binding fact/selection/policy/toolchain/operation/IR/snapshot、sealed request/input manifest 任一 substitution 或两条有效 chain mix-and-match |
| 409 `EVOLUTION_EFFECT_GATE_BINDING_INVALID` | 否 | queued run 可写 cancel intent；typed handoff 拒绝 dispatch | effect 缺少/多出四条 gate、kind/subject/generation/hash 不一致或重复 |
| 409 `EVOLUTION_EFFECT_GENERATION_CONFLICT` | 否 | queued run 可写 cancel intent | binding generation 已被 off/on/disable/restore/quarantine cutoff |
| 409 `PRIVACY_REVIEW_STATE_CONFLICT` | 否 | 否 | publication/pointer/review run revision 或 terminal latch 冲突 |
| 409 `SANDBOX_ATTESTATION_KEY_SIGNATURE_INVALID` | 否 | 否 | key issue/revoke issuer authority、allowlisted key、preimage、raw-key hash 或 Ed25519 signature 不符 |
| 409 `SANDBOX_ATTESTATION_KEY_REVOKED` | 否 | 否 | 新 registration/boot/cert/claim 引用了已 revoked、非 current active 的 attestation key issue fact |
| 409 `SANDBOX_HOST_REGISTRATION_SIGNATURE_INVALID` | 否 | 否 | registrar authority/key/preimage/signature 或 host identity 绑定不符 |
| 409 `SANDBOX_BOOT_ATTESTATION_SIGNATURE_INVALID` | 否 | 否 | boot id/host/registration/nonce/attestation key/preimage/signature 绑定不符 |
| 409 `SANDBOX_LEDGER_ROOT_SIGNATURE_INVALID` | 否 | 否 | boot-scoped genesis/root/sequence/key/preimage/signature 或链绑定不符 |
| 409 `SANDBOX_CERTIFICATION_SIGNATURE_INVALID` | 否 | 否 | certifier authority/key/preimage/signature/subject binding 不符 |
| 409 `SANDBOX_CERTIFICATION_BINDING_INVALID` | 否 | 否 | certificate 在创建时未复合绑定 current registration/boot attestation/ledger root/profile evidence |
| 409 `SANDBOX_HOST_CRYPTO_CHAIN_BINDING_INVALID` | 否 | 否 | key issue→registration→boot attestation→ledger genesis/root→certification→launch 任一 fact/revision/hash/boot/genesis 被混拼或使用旧 current subject |
| 409 `LEARNED_SCRIPT_LAUNCH_IDENTITY_CONFLICT` | 否 | 否 | effect 前 intent 与 deterministic identity 不一致，且已证明 runtime never accepted |
| 409 `LEARNED_SCRIPT_OUTPUT_MANIFEST_CONFLICT` | 否 | bound stage: rejection + cancel intent、仍 running | 已鉴权/lease-bound Run 的 manifest path/size/hash/media 不一致 |
| 409 `LEARNED_SCRIPT_STAGING_CONFLICT` | 否 | bound stage: rejection + cancel intent、仍 running | 已绑定 chunk offset/hole/overlap/final-stream/replay hash 不一致 |
| 409 `LEARNED_SCRIPT_CANCEL_PENDING` | 是 | 可已有 cancel intent | 进程尚未证明停止 |
| 409 `LEARNED_SKILLS_DISABLED` | 否 | 否 | 用户禁用新 Learned Skill effect |
| 413 `LEARNED_SCRIPT_RESOURCE_LIMIT` | 否 | create/pre-bind 零写；bound stage rejection+cancel intent、仍 running | input/output/runtime quota 超限 |
| 413 `LEARNED_SCRIPT_STREAM_LIMIT` | 否 | bound stage rejection + cancel intent、仍 running | stdout/stderr observed bytes 超过 1 MiB，等待 kill proof |
| 416 `LEARNED_SCRIPT_OUTPUT_RANGE_INVALID` | 否 | 否 | output/stream offset/length 越界 |
| 416 `EVOLUTION_EVIDENCE_RANGE_INVALID` | 否 | 否 | evidence offset/length 越界 |
| 422 `LEARNED_TCL_TYPED_REJECTED` | 否 | 仅 immutable rejected compilation fact | grammar/shape 禁止；与 §8 的 422 一致 |
| 422 `LEARNED_SCRIPT_IMPORT_GRAPH_REJECTED` | 否 | never-started proof 后 failed | dynamic/absolute/node/npm/data import 或 graph/manifest drift；无 proof 则 cancel/unknown |
| 422 `LEARNED_SCRIPT_RUNTIME_REJECTED` | 否 | stop/mount proof 后 failed | Deno/CPython-WASI compatibility/permission 拒绝；HTTP 本身不抢先终态 |
| 422 `LEARNED_SCRIPT_OUTPUT_REJECTED` | 否 | bound stage rejection + cancel intent、仍 running | output type/path/hash/size/media/no-follow 校验失败，等待 kill proof |
| 422 `PROBLEM_FAMILY_EVIDENCE_INCOMPLETE` | 否 | 否 | occurrence/outcome 所需 terminal/start/evidence fact 不完整或多义 |
| 503 `LEARNED_SCRIPT_SANDBOX_DISABLED` | 是 | 否 | 独立 rollout flag off |
| 503 `SANDBOX_PROFILE_UNAVAILABLE` | 是 | 否；已有 run 可写 cancel intent | pinned image/runtime/policy/profile 不满足 |
| 503 `SANDBOX_CERTIFICATION_UNAVAILABLE` | 是 | 否；已有 run 可写 cancel intent | host certificate 缺失、过期、revoked 或 hash 不符 |
| 503 `SANDBOX_WASI_ABI_UNAVAILABLE` | 否 | 否；已有 run 可写 cancel intent | CPython-WASI module/import table/Wasmtime host ABI 非 exact allowlist |
| 503 `SANDBOX_HOST_QUARANTINED` | 否 | 否 | 该 host 有 unknown process/mount effect |
| 503 `SANDBOX_LAUNCH_LEDGER_UNAVAILABLE` | 否 | unknown_effect + host quarantine | fsync ledger 缺失/损坏/断链或 singleton fence 不可证明 |
| 503 `SANDBOX_EFFECT_RECONCILE_UNPROVEN` | 否 | unknown_effect + host quarantine | OCI/cgroup/mount/never-accepted proof 缺失、超时或矛盾 |
| 503 `EVOLUTION_EVIDENCE_INTEGRITY_FAILED` | 否 | 否 | managed bytes、entry metadata 与 frozen manifest size/SHA 不一致 |
| 503 `PROBLEM_FAMILY_PROJECTION_INTEGRITY_FAILED` | 否 | 否 | actor-visible project projection/hash/revision 不完整或不一致 |

HTTP error 默认零业务 mutation；表中允许的 quarantine/cancel/terminal safety fact 必须与 audit/outbox 原子提交。transport failure
保持原状态并 query/reconcile，不能猜 success/failed。表中“retryable”只表示 caller 可在外部状态改变后重放同一 HTTP 请求或
轮询，绝不表示现有 Run 可 requeue/revive/new attempt；create/controls/worker mutations 只能凭同 Idempotency-Key 重放，
unknown_effect 永不自动执行。只有已经存在的 Run/launch/cancel intent 才能写表中列出的 safety mutation；pre-claim/profile/
certification/import-graph/ABI/Tcl binding 错误不得制造 effect。identity/ledger/reconcile 只要不能证明 never accepted、whole-tree empty
及 mount detached，就必须选择 unknown_effect + host quarantine，不能降格为普通 409/422 后继续。error envelope 继续带
correlation_id。

## 14. 分阶段开发、ownership 与 Gate

### M5-A — Contract、privacy decision 与 threat model

交付本文、独立权威威胁模型 `specs/self-evolution-m5-threat-model-v1.md`、publication 决策、migration/API traceability、
OCI/runtime certification plan。威胁模型由独立 Agent 产出，至少覆盖 privacy revoke/cache、pointer migration、generation cutoff、
tool-call authenticity、OCI/ledger/cert/reboot、inner runtime、typed Connector/hardware、ACL aggregation 与 evidence integrity；本文不代建
该文件。两份文档都必须 fresh-context 审查并各自 P0/P1=0 后才可冻结。若方案 A 未获决定，M5-B 可实现与 publication 无关的
read/control，但 M5-C/D 不得开始。

### M5-B — 非执行控制/读取面

交付：human supersede + quality revision/unique chain；same-Skill bounded diff；problem-family facts/trend；historical Core evidence
content；若选 A，再交付 project activation/privacy review。要求 migration/fresh schema parity、ACL 404、idempotency/CAS、Web
plain-text UI 与 PostgreSQL 并发测试。此阶段仍保持所有 script `executable:false`。

### M5-C — Python/TypeScript certified sandbox

交付 exact sandbox scope/strict worker DTO、Run state machine、OCI profile、deterministic launch identity、Core launch intent、host-local
fsync ledger/singleton fence/restart reconcile、host certification/quarantine、task Runtime output/stream read、Deno import graph + project byte
broker、CPython-WASI exact ABI/preopens、input/output manifest 与两阶段 flag-off sweeper。先 certification harness，再接 Runtime tool；
不得使用 host fallback。独立 Reviewer P0/P1=0 才进入 D。

### M5-D — typed Tcl compiler 与 Core rebind

交付 `.ltcl` scanner/parser/IR、普通 `.tcl` 只读回归、committed tool-call args exact binding、无 heuristic/glob 的
source/top/testbench/part/constraint/trial selection、`run_class=learned_script_typed` handoff 与 experimental/evolution_eval-only selector
隔离。Connector 不新增 raw/AST route；必须证明收到的只可能是四项枚举 typed operation，且永不进入 formal/download/hardware。

### M5-E — Gate G adversarial/full integration

交付真实 PostgreSQL、Core HTTP、task Runtime、独立 sandbox host 和可控 Connector mock/受控 Vivado integration；执行下表全部
对抗与全量回归。硬件保持物理断开，禁止 hardware download/programming。Reviewer 独立复跑关键证据并签署 P0/P1=0。

ownership：Core/DB owner 负责事实、ACL、CAS；Sandbox owner 负责 worker/OCI/Deno/WASI；Runtime/Connector owner 负责工具接线与
typed handoff；Web owner 负责 diff/supersede/trend/evidence UI；Reviewer 只读审查。共享 router/schema 由 Leader 窄合并，任何人
不得覆盖 dirty worktree 或用 mock 替代 Gate 证据。

## 15. Gate G adversarial matrix

| 威胁/要求 | 必须测试的正反例 | 通过证据 |
|---|---|---|
| 隐私发布 | pre-approval 与 approved/quarantined 等五种 publication state 的敏感 route 成功/错误均断言三 headers；未批准跨项目全 404；批准后 quarantine 同事务 pointer fallback；无 source ACL 的 fixed app content 立即 404；并发撤销 | DB pointer/review/audit + API/header/cache tests |
| Global activation | A→B→A 后旧 pointer+revision CAS 拒绝；non-null target 绑定 immutable approved publication revision；NULL clear 不伪造 target revision且必须 current-source ACL 或 exact global admin；same-value 新 key no-op、same key replay、异 body conflict | publication/global revision facts + composite FK/trigger/API concurrency tests |
| Token/secret | child env/proc/fd/argv/mount 搜索；Core/Connector/model/proxy/HOME 全不可见 | container capture + known canary secret absence |
| 网络/IPC | IPv4/6、DNS、loopback、AF_UNIX、netlink、Named Pipe、worker/runtime socket | syscall/packet/namespace evidence，零外联 |
| 进程/逃逸 | Deno.Command、Python subprocess/ctypes、fork/clone bomb、namespace/mount/device probes | inner deny + seccomp/cgroup terminal facts |
| 文件隔离 | `..`、absolute、Unicode/case collision、symlink/hardlink/FIFO/device/sparse、TOCTOU | no-follow walk/hash/mount/output rejection |
| 资源 | 每项边界与 +1：64MiB input、8MiB output、512MiB memory、64 pids、60s CPU、120s wall、fd/fsize | quota/kill/provenance tests |
| Kill/recovery | cancel、timeout、worker crash/lease loss；cert revoke/reboot/new ledger genesis；不能证明 whole-tree empty | signed cert/ledger + unknown_effect/quarantine，无 blind retry |
| Host crypto chain | key issue/revoke 与 raw-key hash/signature；register→rotate predecessor/revision；旧 key/registration/boot/genesis；跨 host/key/boot/root mix-and-match；rotation 后旧历史仍可读但新 cert/claim/launch 全拒绝 | immutable key/registration/boot/ledger/cert/launch composite facts + DB/API tests |
| Generic event compatibility | Project Agent null-turn initial-objective/recovery/status/message 正常写入且无 commit fact；episode status 与 `learned_skill_apply` start 经 exact 七列 generic identity 成功创建 problem-family occurrence/start fact；任一列错绑拒绝 | generic event insert regressions + seven-column UNIQUE/FK catalog/transaction tests |
| Tool-call authenticity | 三种 run/compile/handoff 候选的 pending、异 task/name/args、同 event 换 key重建全部拒绝；Project Agent tool call non-null `turn:<id>` 正例及 null/task-key 反例；bounded run/side tool call null `task:<task_id>` 正例及 non-null/turn-key 反例；非 tool/其它 name 冒充 commit、nullable raw turn 借 MATCH SIMPLE 绕过均拒绝 | separate commit-fact composite FK + NULL-safe role/key deferred guard + captured zero-effect tests |
| Application attachment | Run/Compilation 对 exact attached primary 与 supporting 各一正例；unattached version、wrong application、skill id/role substitution、supporting 冒充 primary 均在 DB/API 零 effect 拒绝；supporting 成功不进入 primary metrics/family attribution | `skill_application_skill` four-column UNIQUE/FK + DB transaction/API/metric tests |
| Runtime args producer | 仅三种 effect-bearing tool-call 的 plain object/nested JSON 正例；string、array、custom prototype、undefined/function/symbol/bigint、NaN/Infinity 均拒绝；JCS 1 MiB/depth 32/4,096 keys 各测边界与 +1，全部在候选 event/tool 前拒绝；其它 generic payload 不变，历史候选 string args 永久 ineligible且不 parse/backfill | Runtime producer unit/integration + generic-event regression + migration redacted-report tests |
| Stage rejection | 已绑定 stage 的 400/409/413/422 前后 crash；当前且未过期 lease 才能追加 rejection/cancel；expired/superseded lease 零 mutation；合法 rejection 只 cancel_pending，kill proof 后 terminal；proof 缺失 unknown | revision+lease composite FK/guard、rejection/cancel/reconcile transaction + cgroup/mount proof |
| TS | fetch/WebSocket/node/npm/remote import/env/run/ffi/sys，合法 local parser | Deno permission + OCI tests |
| Python | socket/subprocess/multiprocessing/ctypes/native import/path escape，合法 WASI parser | Wasmtime host-call/preopen tests |
| Tcl | `$ [] ; \\`、control flow/eval/source/get_cells/raw command/duplicate/reorder 全拒绝；四 grammar 正例 | parser corpus/property/fuzz tests |
| Connector | raw Skill/AST/IR/command/hardware 字段永不到 Connector；四 operation Core rebind hash 一致；binding fact→snapshot→compilation→IR→handoff→dispatch→typed ToolRun 的 application/project/task/version/binding fact/selection/part/policy/toolchain/snapshot/operation/IR/sealed/input identity 任一逐字段 substitution，或有效 B1 snapshot + 有效 B2 binding/part/policy/toolchain、两条合法链 mix-and-match，均在 DB/API 双层拒绝且零 Connector effect | full-tuple composite FK/trigger + Core→Connector captured request |
| Trial bitstream | policy true 才允许 implement；`.bit` experimental/evolution_eval_only；formal/hardware selectors 全排除 | selector SQL/API negative tests |
| Supersede | nonhuman、无 ACL、历史节点、双并发、quality CAS、异 app/version refs、scanner quarantine | UNIQUE/trigger/API/concurrency tests |
| Diff | cross-Skill、project ACL、binary、invalid UTF-8、64KiB/2000 lines/256KiB cap、HTML/ANSI payload | deterministic DTO + browser text render |
| Problem family | local_goal/即时聚类不计数；无 Skill failure→V success；missing/pending/inconclusive unknown；supersede 翻转；同 timestamp/task/sequence/event 下 occurrence/application 使用同 arity 六元 key，并由 entity kind/id 稳定消歧 | fact/projection/transaction + bytewise total-order tests |
| Evidence content | app/eval/job/fact/entry 各层错绑、ACL 404、chunk/hash/UTF8/base64/8MiB、`.bit` classification | managed_content hash + API tests |
| Flags | off/on、disable/enable、archive/restore、quarantine generation 全矩阵；旧 queued reopen 不复活，收尾可用 | gate binding/generation + sweeper crash tests |
| DB/幂等 | migration upgrade/fresh parity、append-only、same-key replay/different-body conflict、crash at every commit fence | PostgreSQL restart/concurrency tests |

Gate G 的“无 orphan”必须由 cgroup/container/mount 三面证明；仅看到父 PID 退出或 command timeout 不算。网络测试不得真的访问
生产 endpoint；使用隔离 namespace 内 canary listener/packet capture。Vivado 测试只到受控 Connector operation，禁止连接板卡。
隐私 cache harness 必须放置一个默认会缓存 200/4xx 的中间层，证明 pre-approval、approved 与撤销后响应因
`no-store/no-cache/Vary: Authorization` 从未被存储或跨 actor 命中。另需预置一份模拟“旧版本曾违规缓存”的 stale object，证明新 Core
header/quarantine **不能**远程驱逐它并使测试 fail closed/触发部署事故流程；Gate 只能信任从一开始遵守 no-store 的中间层，不能把
清除本地测试 cache 当成产品撤回保证。

Revision 2/3/4/5/6/7/8 审查缺口必须按下表逐项产出独立 test id；任一项缺 evidence 时不得以相邻测试代替：

| ID | 修订合同 | 最小必需对抗测试 |
|---|---|---|
| R2-01 | §2 human-only global approval/declassification；A/B 仍待产品决定 | service approve 必拒绝；human 无 source ACL、自审、ack/profile 缺失、hash drift 必拒绝；project-only 跨项目全 404 |
| R2-02 | §4 launch intent、deterministic identity、fsync ledger/singleton fence | 在 intent commit、ledger fsync、OCI accept、首 heartbeat 前后逐点 crash；restart 只能 exact reconcile，不能二次 create |
| R2-03 | §4–5 attempt=1 且无 requeue/revive | prestart reject、lease expiry、transport failure、never-accepted proof 均终止或继续原 Run；再次执行必须新 run/tool-call/identity |
| R2-04 | §5 strict worker claim/lease/read/stage/cancel/reconcile/terminal DTO | extra/missing field、scope、revision、lease、hash、idempotency replay/冲突逐 route 正反例与 exact HTTP status |
| R2-05 | §4–5 output/stream read 与 staging | ACL/binding 404、manifest/list/chunk、zero-byte/EOF、UTF-8/base64、hole/overlap；files 8 MiB 与每 stream observed 1 MiB/stored 256 KiB 独立边界 |
| R2-06 | §4 run/entry/event composite binding 与 portable path | 异 version/run/revision FK、双 event、非 ASCII/ASCII-fold/cross-layer collision、manifest/hash drift 在 DB 与 API 双层拒绝 |
| R2-07 | §4/6 profile/cert/host quarantine lifecycle | expired/revoked/superseded cert、unknown effect 自动 quarantine、旧 cert/未清空 identity unquarantine CAS 全拒绝 |
| R2-08 | §6–7 project byte broker、Deno graph、WASI exact imports/preopens | `/project`/file/dynamic/node/npm/data import 不可见；多一个 WASI host import、project/output 入 sys.path、fd rights 扩张均 certification fail |
| R2-09 | §8 typed binding 与新 run class | committed args drift、0/>1 part/top、>512 path、glob/inference、IR hash drift 拒绝；captured Connector 只含四 operation + learned_script_typed，bit 不可 formal/download/hardware |
| R2-10 | §3 two-phase hot flag sweep | off 与 create/claim 竞态先阻止新 effect；逐 Run cancel intent crash/replay；安全收尾/read 可用且 reopen 不复活旧 Run |
| R2-11 | §11 family root、Core-derived time/hash、project projection/ACL aggregate | concurrent 双 root/分叉、caller time/hash 注入、跨 occurrence predecessor 拒绝；不同 ACL actor 只聚合各自 project rows |
| R2-12 | §12 historical evidence exact content semantics | zero-byte、EOF length=0、complete equality、headers、全内容 size/hash/manifest 任一损坏均 503 且零 content/零 fallback |
| R2-13 | §10 exact diff semantics | exact media allowlist、unchanged null fields、invalid_utf8 reason、rendered_bytes 仅 unified-diff bytes 与 256 KiB 边界 |
| R3-01 | §2 approval revoke + dual pointers | global approve 后 privacy/quality quarantine 与 read 并发，commit 后 global/project fallback + fixed app content 404 + no-store；compliant cache 从未存储，违规旧 cache 明确不承诺可驱逐 |
| R3-02 | §2 service/pointer migration | service/human review竞态、lease/revision replay、Distiller/Curator parent CAS；旧 pointer/无唯一 source/multi-parent preflight 以 redacted report 零写中止 |
| R3-03 | §3 durable generation | off→on、disable→enable、archive→restore 后旧 queued/compiled binding 永不 claim/dispatch；sweeper逐 intent crash replay |
| R3-04 | §4/8 committed tool call | create/compile/handoff 的异 task/turn/name/JCS args、pending event、duplicate key/换 key均 409 且零 effect |
| R3-05 | §4–6 signed cert/reboot | profile/host issue/revoke authority/signature、revoked cert claim、reboot boot-id/new genesis、旧 ledger/cert replay全部拒绝 |
| R3-06 | §5 stage before kill proof | 已绑定 output/stream 400/409/413/422 只写 rejection+cancel intent并保持 running；whole-tree/mount proof 后终态，否则 unknown+quarantine |
| R3-07 | §9/11 actor facts | evaluation quarantine latch不可被human success解除；multi-root migration abort；family app↔episode/time event/FK与Curator DTO/ACL aggregation |
| R4-01 | §2 all-state privacy headers/cache | 五种 publication state 的 search/view/diff/apply/run/fixed-content 成功与 4xx/5xx 均 exact 三 headers；pre-approval/approved 通过 compliant intermediary 不落盘；预置违规 stale cache 无法被 Core 驱逐并触发 fail-closed deployment incident |
| R4-02 | §4/11 generic event + tool authority | generic event 七列 identity 可独立被 status/application facts 引用；只有三种 effect-bearing tool-call payload exact 四 key/JCS/hash 才物化 commit fact并供 Run/compile/handoff 复合绑定；Project Agent tool call non-null turn/`turn:` key 与 bounded run/side tool call null turn/`task:` key 各做正例及交叉反例；episode end/status 与 application start/tool_call 的七列任一错绑均 FK/trigger 拒绝 |
| R4-03 | §3 exact four generation bindings | 每个 run/handoff 恰有 global/global/skill/version 四行；缺一、多一、重复、错误 subject/generation 或伪造 bindings hash 均 `EVOLUTION_EFFECT_GATE_BINDING_INVALID` 且 claim/dispatch fail closed |
| R4-04 | §4/6 key/registration/boot/ledger/cert | key issue/revoke、registrar、boot attestation、ledger genesis/root、certificate 各 authority/signature/preimage/composite FK 逐项错绑拒绝；register→rotate revision/predecessor CAS、跨 key/host/boot mix-and-match、旧 key/registration/boot/genesis 的新 cert/claim/launch 全拒绝；历史 boot 不因 current projection 前移而失效 |
| R4-05 | §5 stage-before-proof | 已绑定 manifest/chunk/stream 的 400/409/413/422 全部只追加 rejection+cancel intent并保持 running；只有 tree-empty+mount-detached proof 后可 failed/cancelled/timeout，否则 unknown+host quarantine |
| R4-06 | §8 typed snapshot/dispatch/response | dispatch sealed bytes 只从 immutable exact Q/B + snapshot entries 重建；handoff/dispatch/typed fact 的 compilation/application/project/task/version/binding fact/selection/policy/toolchain/operation/IR preimage+hash/snapshot/sealed/input manifest/real ToolRun 任一 DB 注入、逐字段 substitution 与 API mix-and-match 均拒绝；handoff→单 dispatch/typed ToolRun/audit/outbox 原子；crash 后 same submission id/hash query/replay，无 blind duplicate；response predecessor/terminal edge错绑拒绝 |
| R4-07 | §2/9 migration preflight abort | source/parent/manifest/pointer、多 root/跨链/origin 任一多义时 bounded redacted report且零 publication/quarantine/pointer/quality 写；只有完整显式 admin per-version input 校验后整笔重跑 |
| R4-08 | §2 privacy package reads | lease/run/revision/manifest/path/hash/offset/encoding 正反例；manifest/list/chunk 只来自 sanitized immutable version bytes，禁止 project/log/evidence，所有 success/error exact privacy headers |
| R4-09 | §2 activation revisions | 每次 project pointer set/fallback/NULL clear 都有 append-only revision+event+exact audit/outbox；projection/current revision、from→to continuity 与 NULL edge 的 composite FK/trigger 竞态测试 |
| R4-10 | §11 trend FK/projection | trend revision/projection 的 project 与 `(version,skill)` composite FK 错绑拒绝；projection 必须绑定 exact revision fact hash；actor 只聚合当前可见 project rows，混合 ACL 不泄漏 count/revision/existence |
| R5-01 | §2 global ABA/publication history | global A→B→A 每边递增独立 revision，旧 A CAS 拒绝；projection 与 from/to 都复合绑定 exact immutable publication revision fact，publication projection 后续前移不破坏历史 |
| R5-02 | §2 global clear/no-op/replay | target NULL 必须 publication revision NULL，按 current pointer source ACL 或 exact human global-admin 授权；无权 404；same-value 新 key 200 no-op 零 revision/event/audit/outbox，同 key同 body replay、异 body conflict |
| R5-03 | §4 role-derived tool-call turn binding | Project Agent effect-bearing tool call non-empty raw turn + `turn:<id>` 与 bounded run/side tool call raw null + `task:<task_id>` 各自通过；四种反向/null/key/task-role 组合、MATCH SIMPLE 绕过及授权 turn 漂移全部在 commit-fact/guard 层零 effect 拒绝；generic event 不受该 turn 合同约束 |
| R5-04 | §4 Runtime args producer | `free-agent` 只对三种 effect-bearing tool call 接受受限 plain JSON object，agent-types 分离 display string/`args_payload`，server 只持久化 object；string/malformed/prototype vectors 与 JCS 1 MiB/depth 32/4,096 keys 边界/+1 在工具前验证，历史候选 string rows 不 parse/backfill且无 commit fact；其它 generic payload 回归不变 |
| R5-05 | §4–5 stage lease identity | rejection fact 复合绑定 run/state/lease revision；锁内 current+token+expiry guard；expired/superseded lease 对 400/409/413/422 请求均零 rejection/cancel/audit/outbox，未过期 lease 才走 cancel_pending |
| R5-06 | §4/6 attestation-key rotation chain | key raw bytes/hash/issue/revoke signature，registration register/rotate predecessor，boot creation-time current guard；旧 history 仅 FK immutable facts，rotation/revoke 后旧 key/boot/cert 不可用于新 cert/claim/launch，任一 mix-and-match 拒绝 |
| R5-07 | §8 typed identity closure | compilation/application/project/task/version/binding fact/selection/policy/toolchain/operation/IR preimage/hash/snapshot 贯穿 handoff/dispatch/typed fact；sealed request hash=input manifest hash；typed fact 与 real ToolRun 复合绑定 project/run class/operation/input，逐字段 DB/API mutation 均 `LEARNED_TCL_DISPATCH_BINDING_CONFLICT` 且零 Connector effect |
| R5-08 | §11 generic-event family timeline | occurrence/application 都从 exact 七列 generic event identity 派生，并映射六元 `(event_at,task_id,event_sequence,event_id,entity_kind,entity_id)`；不依赖 commit fact/turn key；同 timestamp 及相同前四项时按 UTF-8 bytewise kind/id 稳定排序，不再比较不同 arity tuple，first-solved 可复算 |
| R6-01 | §4 generic event 与 effect authority 分离 | Project Agent null-turn initial/recovery/status/message 正常写入且绝无 commit fact；仅三种 strict tool-call 候选可物化 commit fact；Project/bounded turn 正反例、非 tool/name 冒充、nullable MATCH SIMPLE 绕过均 fail closed |
| R6-02 | §4/11 exact generic event FK | `task_conversation_event` 提供与 consumer FK 完全相同的七列 UNIQUE；episode occurrence/application start/problem-family 可引用合法 generic status/tool_call，逐列类型/顺序/catalog 校验及七列任一错绑拒绝，且不要求 turn key/commit fact |
| R7-01 | §4/8 application-version attachment | `skill_application_skill` 提供 `(application_id,version_id,skill_id,role)` exact UNIQUE；Run/Compilation 复合 FK 命中 attached row。primary/supporting 正例；unattached、wrong app、skill/role substitution DB/API 零 effect；supporting 不归因 |
| R7-02 | §8 handoff full compilation tuple | compilation exact UNIQUE 与 handoff matching FK 固定 application/project/task/version/Q/B/IR，IR FK另固定 operation；dispatch/typed fact 延续完整 tuple。每字段 substitution、两条合法 compilation/handoff mix-and-match 在 DB transaction/API 全拒绝 |
| R8-01 | §8 end-to-end binding chain closure | 对 `application/project/task/version/binding_fact_id/binding_fact_hash/binding_selection_hash/policy_fact_hash/toolchain_profile_hash/project_snapshot_id/project_snapshot_hash` 每字段单独 substitution；构造两条各自完全有效的 B1/B2 binding+snapshot，并提交 B1 snapshot/entries/manifest + B2 binding/part/policy/toolchain（及反向组合）。binding→snapshot→compilation→IR 的 DB direct transaction，以及在每个 DB read/commit fence 并发切换 B1/B2 workspace revision/part/policy/toolchain 的 compile API，均 `LEARNED_TCL_BINDING_CONFLICT` 且零 binding/snapshot/compilation/IR/audit/outbox；handoff→dispatch→typed ToolRun 的 DB/API 均 `LEARNED_TCL_DISPATCH_BINDING_CONFLICT` 且零 handoff/dispatch/ToolRun/audit/outbox/Connector effect。catalog test 还须证明每组 FK/target UNIQUE 列顺序与类型 exact |

## 16. Verification commands 与退出标准

通用静态/回归：

```bash
DATABASE_URL=<dedicated-m5-postgres> bun test
bun run check
bunx tsc --noEmit -p runtime/tsconfig.json
(cd web && bun test && bun run check && bun run build)
git diff --check
```

M5 专项命令由实现阶段提供固定脚本，不允许手写不可复现 ceremony；至少包括：

```bash
bun test core/tests/self-evolution-m5-*.test.ts
bun test runtime/learned-script-*.test.ts
bun test connector/learned-tcl-typed-*.test.ts
bun run core/scripts/certify-learned-script-sandbox.ts --profile <pinned-profile-manifest>
bun run core/scripts/certify-self-evolution-m5.ts --database-url <dedicated-m5-postgres>
```

最终实现可调整测试文件拆分，但 certification entry point、profile/input hashes、命令、退出码和 artifact index 必须冻结并由
Reviewer 复跑。临时数据库/OCI root 必须隔离命名；不得 truncate 非 Gate 数据，不得保留 secret、token、项目源码、raw evidence
或 sandbox output 到 Git。

Gate G 退出条件同时满足：

1. §2 privacy decision 已明确并回写权威合同；方案对应的 ACL/promotion tests 全通过；
2. M5-B/C/D/E 各自独立审查 P0=0、P1=0；P2 只有明确 owner/deadline 且不破坏本合同才可延期；
3. sandbox 默认关闭，关闭时只读 Learned Skill 与现有 Pin/Unpin/Archive/Restore/Disable/Enable/Rollback 零回归；
4. Python/TypeScript 只在 certified OCI + pinned Deno/WASI 双层边界运行，无 host fallback、token、network、hardware 或 project write；
5. Tcl 只有 `learned-tcl-typed.v1` 可编译，Connector 永远只见 Core rebound typed operation；普通 `.tcl` 仍只读；
6. supersede、diff、problem-family、historical evidence 在真实 PostgreSQL 下通过 ACL、CAS、幂等、并发、append-only 和资源边界；
7. 全量 tests/typecheck/Web build、migration upgrade/fresh parity、三尺寸浏览器走查和 adversarial matrix 通过；
8. Leader 与独立 Reviewer 都能从 artifact/DB/audit/provenance 逐项复算关键 hash 和状态链。

当前本文状态仍是“冻结候选/待独立评审”。创建此文档、测试绿或实现局部完成均不能单独宣称 Gate G PASS。

## 17. Traceability

| M5 requirement | Contract section | Planned authoritative evidence | Initial state |
|---|---|---|---|
| Privacy scope/promotion/revoke | §2 | R2-01 + R3-01/02 + R4-01/07/08/09 + R5-01/02 publication/pointer/immutable-revision/ABA/clear/all-state-header/cache/package/migration suite | DECISION REQUIRED |
| exact actors/scopes/generation | §3 | R2-10 + R3-03 + R4-03 auth/exact-four-binding/hot-close/reopen matrix | pending |
| run DTO/state/idempotency/CAS | §4–5 | R2-03/04/06 + R3-04 + R4-02 + R5-03/04 + R6-01/02 + R7-01 PG constraints/generic-event/separate-commit-authority/application-version-role attachment/strict DTO tests | pending |
| launch/effect/host fence | §4–6 | R2-02/07 + R3-05 + R4-04 + R5-06 signed key/registration/rotation/boot/ledger/cert/restart evidence | pending |
| output/staging/read | §4–5 | R2-05 + R3-06 + R4-05 + R5-05 ACL/stage-current-lease/rejection/cancel/kill-proof/resource evidence | pending |
| OCI isolation/kill proof | §6 | R2-02/07 pinned profile + cgroup/container/mount provenance | pending |
| Deno/WASI double isolation | §7 | R2-08 graph/broker/ABI/preopen corpus + OS evidence | pending |
| typed Tcl only | §8 | R2-09 + R4-06 + R5-07 + R7-01/02 + R8-01 grammar/application attachment/end-to-end binding-chain/full compilation-handoff-dispatch-ToolRun tuple/response/run-class + captured Connector DTO | pending |
| human supersede | §9 | R3-07 + R4-07 UNIQUE/current-leaf/quarantine-latch/preflight-abort evidence | pending |
| bounded version diff | §10 | R2-13 exact allowlist/DTO/byte-cap/browser tests | pending |
| problem-family trend | §11 | R2-11 + R3-07 + R4-02/10 + R5-08 + R6-02 + R7-01 generic event/unified-six-tuple/attachment-role attribution/Curator DTO/ACL projection tests | pending |
| historical evidence bytes | §12 | R2-12 managed_content integrity/ACL/zero-byte/chunk tests | pending |
| stable errors/retries | §13 | R2-02–12 + R4-03/04/05/06 + R5-01–08 + R6-01/02 + R7-01/02 + R8-01 route code + attachment/full-binding-chain/allowed/zero-mutation contract tests | pending |
| Pin/Unpin/Archive/Restore | §1,§16 | existing Core/Web regression | implemented; reverify |
| independent threat model | §14 | `specs/self-evolution-m5-threat-model-v1.md` threat→control→test traceability + independent review | pending external artifact |
| Gate G | §14–16 | complete artifact index + independent review | not started |
