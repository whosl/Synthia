<script setup lang="ts">
import { computed } from "vue";
import type {
  LearnedSkillControlAction,
  LearnedSkillDetailV1,
  LearnedSkillVersionV1,
  SkillApplicationDetailV1,
  SkillApplicationListItemV1,
} from "../../api/evolution.ts";
import {
  APPLICATION_STATE_TEXT,
  EVALUATION_OUTCOME_TEXT,
  QUALITY_STATE_TEXT,
  QUALITY_STATE_TONE,
  currentEvaluationIds,
  formatEvolutionDuration,
  formatEvolutionTime,
  successRateText,
} from "../../domain/evolution.ts";
import Badge from "../ui/Badge.vue";
import Button from "../ui/Button.vue";

const props = defineProps<{
  detail: LearnedSkillDetailV1 | null;
  version: LearnedSkillVersionV1 | null;
  applications: readonly SkillApplicationListItemV1[];
  applicationsTruncated: boolean;
  application: SkillApplicationDetailV1 | null;
  loading: boolean;
  applicationLoading: boolean;
  operatingAction: LearnedSkillControlAction | null;
  controlReason: string;
  rolloutEnabled: boolean;
}>();

const emit = defineEmits<{
  "select-version": [versionId: string];
  "select-application": [applicationId: string];
  control: [action: LearnedSkillControlAction];
  "update:controlReason": [reason: string];
}>();

const currentEvaluationSet = computed(() => currentEvaluationIds(props.application?.evaluations ?? []));

function onControlReason(event: Event): void {
  emit("update:controlReason", (event.target as HTMLInputElement).value);
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function shortHash(value: string): string {
  return `${value.slice(0, 12)}…`;
}
</script>

<template>
  <main class="learned-skill-detail">
    <div v-if="loading" class="learned-skill-detail-empty" role="status">正在加载 Skill 事实…</div>
    <div v-else-if="!detail" class="learned-skill-detail-empty">从左侧选择一个 Learned Skill 查看版本、资产和真实调用评价。</div>
    <template v-else>
      <header class="learned-skill-detail-head">
        <div>
          <div class="learned-skill-heading-row">
            <h2>{{ detail.name }}</h2>
            <Badge v-if="detail.quality_state" :tone="QUALITY_STATE_TONE[detail.quality_state]">
              {{ QUALITY_STATE_TEXT[detail.quality_state] }}
            </Badge>
            <Badge v-if="!detail.enabled" tone="danger">已禁用</Badge>
            <Badge v-if="detail.pinned" tone="info">Pinned · 自动修改锁定</Badge>
            <Badge v-if="detail.availability_state === 'archived'" tone="warn">Archived · 普通搜索隐藏</Badge>
          </div>
          <p>{{ detail.summary }}</p>
          <p class="learned-skill-applicability">适用参考：{{ detail.applicability_summary }}</p>
        </div>
        <div class="learned-skill-control">
          <label>
            <span>Skill 控制原因</span>
            <input
              :value="controlReason"
              type="text"
              maxlength="500"
              placeholder="说明本次 Pin、状态或可用性变更"
              :disabled="operatingAction !== null"
              @input="onControlReason"
            />
          </label>
          <div class="learned-skill-control-actions">
            <Button
              size="sm"
              :variant="detail.enabled ? 'danger' : 'primary'"
              :loading="operatingAction === (detail.enabled ? 'disable' : 'enable')"
              :disabled="operatingAction !== null || !controlReason.trim() || (!detail.enabled && !rolloutEnabled)"
              @click="emit('control', detail.enabled ? 'disable' : 'enable')"
            >
              {{ detail.enabled ? "禁用此 Skill" : "恢复此 Skill" }}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              :loading="operatingAction === (detail.pinned ? 'unpin' : 'pin')"
              :disabled="operatingAction !== null || !controlReason.trim() || !rolloutEnabled"
              @click="emit('control', detail.pinned ? 'unpin' : 'pin')"
            >
              {{ detail.pinned ? "Unpin" : "Pin" }}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              :loading="operatingAction === (detail.availability_state === 'archived' ? 'restore' : 'archive')"
              :disabled="operatingAction !== null || !controlReason.trim() || !rolloutEnabled"
              @click="emit('control', detail.availability_state === 'archived' ? 'restore' : 'archive')"
            >
              {{ detail.availability_state === "archived" ? "Restore" : "Archive" }}
            </Button>
          </div>
          <small v-if="!rolloutEnabled">
            {{ detail.enabled
              ? "rollout 关闭期间仅保留紧急禁用；Pin/Unpin 与 Archive/Restore 均锁定。"
              : "rollout 关闭期间不能恢复、Pin/Unpin 或 Archive/Restore。" }}
          </small>
        </div>
      </header>

      <section class="learned-skill-metrics" aria-label="Skill 真实调用指标">
        <article>
          <span>局部目标解决率</span>
          <strong>{{ successRateText(detail.metrics) }}</strong>
          <small v-if="detail.metrics.measurement_state === 'unknown'">证据不足，不推断提升</small>
          <small v-else>{{ detail.metrics.success }} 成功 / {{ detail.metrics.evaluated }} 已评价</small>
        </article>
        <article>
          <span>应用与待评价</span>
          <strong>{{ detail.metrics.primary_applied }} / {{ detail.metrics.pending }}</strong>
          <small>primary applied / pending</small>
        </article>
        <article>
          <span>中位处理时间</span>
          <strong>{{ formatEvolutionDuration(detail.metrics.median_duration_ms) }}</strong>
          <small>从 apply 到局部目标关闭</small>
        </article>
        <article>
          <span>人工纠正</span>
          <strong>{{ detail.metrics.human_corrections ?? "未知" }}</strong>
          <small>inconclusive {{ detail.metrics.inconclusive }} 次</small>
        </article>
        <article>
          <span>首次解决问题族</span>
          <strong>{{ detail.metrics.first_solved_problem_families ?? "未知" }}</strong>
          <small>暂无问题族事实时不推断为 0</small>
        </article>
      </section>

      <section class="learned-skill-section">
        <div class="learned-skill-section-head">
          <div>
            <h3>不可变版本与资产</h3>
            <p>
              来源 {{ detail.source_summary.visible_source_count }}/{{ detail.source_summary.source_count }} 可见 ·
              distillation {{ detail.source_summary.distillation_run_id }}
            </p>
          </div>
          <label class="learned-skill-version-select">
            <span>查看版本</span>
            <select
              :value="version?.version.version_id ?? ''"
              @change="emit('select-version', ($event.target as HTMLSelectElement).value)"
            >
              <option
                v-for="item in detail.versions"
                :key="item.version_id"
                :value="item.version_id"
              >
                v{{ item.version_no }} · {{ QUALITY_STATE_TEXT[item.quality_state] }}
              </option>
            </select>
          </label>
        </div>

        <div v-if="!version" class="learned-skill-inline-empty">版本内容加载中…</div>
        <template v-else>
          <div class="learned-skill-version-meta">
            <span>parent：{{ version.version.parent_version_id ?? "首版" }}</span>
            <span :title="version.version.content_manifest_hash">manifest：{{ shortHash(version.version.content_manifest_hash) }}</span>
            <span>扫描：{{ version.version.scan.decision }}（{{ version.version.scan.scanner_version }}）</span>
            <span>{{ formatEvolutionTime(version.version.created_at) }}</span>
          </div>
          <p>{{ version.version.description }}</p>
          <div class="learned-skill-contract-grid">
            <div>
              <h4>适用条件（供 Agent 自由判断）</h4>
              <pre>{{ pretty(version.version.applicability) }}</pre>
            </div>
            <div>
              <h4>局部结果契约</h4>
              <pre>{{ pretty(version.version.outcome_contract) }}</pre>
            </div>
          </div>
          <div class="learned-skill-assets">
            <details v-for="file in version.version.files" :key="file.path" class="learned-skill-asset">
              <summary>
                <span>
                  <strong>{{ file.path }}</strong>
                  <small>{{ file.kind }} · {{ file.language ?? file.media_type }} · {{ file.size_bytes }} B</small>
                </span>
                <code :title="file.sha256">{{ shortHash(file.sha256) }}</code>
              </summary>
              <pre>{{ file.content }}</pre>
            </details>
          </div>
        </template>
      </section>

      <section class="learned-skill-section">
        <div class="learned-skill-section-head">
          <div>
            <h3>真实调用记录</h3>
            <p>只有 primary 且经 Curator 评价的结果进入单 Skill 解决率。</p>
          </div>
          <Badge tone="info">{{ applications.length }} 次可见调用</Badge>
        </div>
        <div v-if="applications.length === 0" class="learned-skill-inline-empty">尚无可见调用；当前指标保持“提升未知”。</div>
        <div v-else class="learned-skill-application-layout">
          <div class="learned-skill-application-list">
            <button
              v-for="item in applications"
              :key="item.application_id"
              type="button"
              :class="{ 'is-selected': application?.application_id === item.application_id }"
              @click="emit('select-application', item.application_id)"
            >
              <span>
                <strong>{{ item.local_goal }}</strong>
                <small>{{ APPLICATION_STATE_TEXT[item.state] }} · {{ formatEvolutionTime(item.started_at) }}</small>
              </span>
              <Badge :tone="item.current_evaluation?.outcome === 'success' ? 'ok' : item.current_evaluation ? 'warn' : 'neutral'" size="sm">
                {{ item.current_evaluation ? EVALUATION_OUTCOME_TEXT[item.current_evaluation.outcome] : "待评价" }}
              </Badge>
            </button>
          </div>

          <div v-if="applicationLoading" class="learned-skill-inline-empty" role="status">正在加载完整评价历史…</div>
          <article v-else-if="application" class="learned-skill-application-detail">
            <header>
              <div>
                <h4>{{ application.local_goal }}</h4>
                <p>
                  项目：{{ application.project_ref === 'redacted' ? "受权限保护" : application.project_ref }} ·
                  任务：{{ application.task_ref === 'redacted' ? "受权限保护" : application.task_ref }}
                </p>
              </div>
              <Badge tone="info">{{ APPLICATION_STATE_TEXT[application.state] }}</Badge>
            </header>
            <dl class="learned-skill-application-facts">
              <div><dt>耗时</dt><dd>{{ formatEvolutionDuration(application.duration_ms) }}</dd></div>
              <div><dt>人工纠正</dt><dd>{{ application.human_corrections ?? "未知" }}</dd></div>
              <div><dt>证据</dt><dd>{{ application.evidence_summary.visible }} 可见 / {{ application.evidence_summary.redacted }} 隐去</dd></div>
              <div><dt>episode</dt><dd>{{ application.episode_ref === 'redacted' ? "受权限保护" : application.episode_ref ?? "尚未绑定" }}</dd></div>
            </dl>
            <p v-if="application.outcome_claim" class="learned-skill-claim">主 Agent 声明（非权威）：{{ application.outcome_claim }}</p>
            <div class="learned-skill-attribution">
              <h5>归因</h5>
              <span v-for="skill in application.skills" :key="`${skill.version_id}:${skill.role}`">
                {{ skill.role === "primary" ? "primary" : "supporting" }} · {{ skill.version_id }} · {{ skill.reason_codes.join(" / ") }}
              </span>
            </div>
            <div class="learned-skill-evaluations">
              <h5>完整 evaluation / supersede 历史</h5>
              <p v-if="application.evaluations.length === 0">尚无评价；本次仍为 pending，不进入成功率。</p>
              <article
                v-for="evaluation in application.evaluations"
                v-else
                :key="evaluation.evaluation_id"
                :class="{ 'is-current': currentEvaluationSet.has(evaluation.evaluation_id) }"
              >
                <header>
                  <Badge :tone="evaluation.outcome === 'success' ? 'ok' : evaluation.outcome === 'inconclusive' ? 'neutral' : 'warn'" size="sm">
                    {{ EVALUATION_OUTCOME_TEXT[evaluation.outcome] }}
                  </Badge>
                  <span>{{ evaluation.evaluator_type === "human" ? "人工" : "Curator" }} · 置信度 {{ Math.round(evaluation.confidence * 100) }}%</span>
                  <Badge v-if="currentEvaluationSet.has(evaluation.evaluation_id)" tone="accent" size="sm">当前评价</Badge>
                </header>
                <p>{{ evaluation.reason }}</p>
                <footer>
                  <span>{{ evaluation.evaluation_id }}</span>
                  <span v-if="evaluation.supersedes_id">supersedes {{ evaluation.supersedes_id }}</span>
                  <span>证据 {{ evaluation.evidence_summary.visible }} 可见 / {{ evaluation.evidence_summary.redacted }} 隐去</span>
                  <span>{{ formatEvolutionTime(evaluation.created_at) }}</span>
                </footer>
              </article>
            </div>
          </article>
        </div>
        <p v-if="applicationsTruncated" class="learned-skill-truncated" role="status">
          当前只显示前 {{ applications.length }} 次可见调用，仍有更多结果未加载。
        </p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.learned-skill-detail {
  display: grid;
  align-content: start;
  gap: var(--space-4);
  min-width: 0;
  min-height: 0;
  padding: var(--space-5);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-panel);
}

.learned-skill-detail h2,
.learned-skill-detail h3,
.learned-skill-detail h4,
.learned-skill-detail h5,
.learned-skill-detail p,
.learned-skill-detail dl,
.learned-skill-detail dd {
  margin: 0;
}

.learned-skill-detail-head,
.learned-skill-heading-row,
.learned-skill-section-head,
.learned-skill-application-detail > header,
.learned-skill-evaluations article header,
.learned-skill-evaluations article footer {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.learned-skill-detail-head,
.learned-skill-section-head,
.learned-skill-application-detail > header {
  justify-content: space-between;
  align-items: flex-start;
}

.learned-skill-detail-head > div:first-child {
  min-width: 0;
}

.learned-skill-heading-row {
  min-width: 0;
  flex-wrap: wrap;
}

.learned-skill-heading-row h2,
.learned-skill-heading-row > * {
  min-width: 0;
  max-width: 100%;
}

.learned-skill-heading-row h2 {
  overflow-wrap: anywhere;
}

.learned-skill-detail-head p,
.learned-skill-section-head p,
.learned-skill-application-detail header p,
.learned-skill-applicability {
  color: var(--text-secondary);
}

.learned-skill-control small,
.learned-skill-truncated {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.learned-skill-truncated {
  margin-top: var(--space-2) !important;
}

.learned-skill-applicability {
  margin-top: var(--space-1) !important;
  font-size: var(--font-size-sm);
}

.learned-skill-control {
  display: grid;
  justify-items: end;
  gap: var(--space-2);
  flex: 0 1 300px;
}

.learned-skill-control-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.learned-skill-control label {
  display: grid;
  gap: var(--space-1);
  width: 100%;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.learned-skill-control input,
.learned-skill-version-select select {
  min-width: 0;
  height: 32px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-base);
  color: var(--text-primary);
}

.learned-skill-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--space-3);
}

.learned-skill-metrics article {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-base);
}

.learned-skill-metrics span,
.learned-skill-metrics small {
  color: var(--text-secondary);
}

.learned-skill-metrics strong {
  font-size: 20px;
}

.learned-skill-section {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  padding-top: var(--space-4);
  border-top: 1px solid var(--border);
}

.learned-skill-version-select {
  display: grid;
  gap: var(--space-1);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.learned-skill-version-meta,
.learned-skill-application-facts,
.learned-skill-attribution {
  display: flex;
  gap: var(--space-2) var(--space-4);
  flex-wrap: wrap;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.learned-skill-contract-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.learned-skill-contract-grid > div,
.learned-skill-application-detail {
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-base);
}

.learned-skill-contract-grid pre,
.learned-skill-asset pre {
  max-width: 100%;
  margin: var(--space-2) 0 0;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.learned-skill-assets {
  display: grid;
  gap: var(--space-2);
}

.learned-skill-asset {
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-base);
}

.learned-skill-asset summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-width: 0;
  cursor: pointer;
}

.learned-skill-asset summary span {
  display: grid;
  min-width: 0;
}

.learned-skill-asset small,
.learned-skill-asset code {
  color: var(--text-secondary);
}

.learned-skill-application-layout {
  display: grid;
  grid-template-columns: minmax(220px, 0.7fr) minmax(0, 1.3fr);
  gap: var(--space-3);
  min-width: 0;
}

.learned-skill-application-list {
  display: grid;
  align-content: start;
  gap: var(--space-2);
}

.learned-skill-application-list button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-base);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.learned-skill-application-list button.is-selected {
  border-color: var(--accent);
  box-shadow: inset 3px 0 0 var(--accent);
}

.learned-skill-application-list button > span:first-child {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.learned-skill-application-list small {
  color: var(--text-secondary);
}

.learned-skill-application-detail {
  display: grid;
  gap: var(--space-3);
}

.learned-skill-application-facts div {
  display: flex;
  gap: var(--space-1);
}

.learned-skill-application-facts dt {
  font-weight: 600;
}

.learned-skill-claim {
  padding: var(--space-2);
  border-left: 3px solid var(--border-strong);
  color: var(--text-secondary);
}

.learned-skill-attribution {
  display: grid;
}

.learned-skill-evaluations {
  display: grid;
  gap: var(--space-2);
}

.learned-skill-evaluations > article {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.learned-skill-evaluations > article.is-current {
  border-color: var(--accent);
}

.learned-skill-evaluations article header,
.learned-skill-evaluations article footer {
  flex-wrap: wrap;
}

.learned-skill-evaluations article footer {
  color: var(--text-secondary);
  font-size: 11px;
}

.learned-skill-inline-empty,
.learned-skill-detail-empty {
  padding: var(--space-5);
  color: var(--text-secondary);
  text-align: center;
}

@media (max-width: 900px) {
  .learned-skill-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .learned-skill-application-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  .learned-skill-detail {
    padding: var(--space-3);
  }

  .learned-skill-detail-head,
  .learned-skill-section-head,
  .learned-skill-application-detail > header,
  .learned-skill-asset summary {
    flex-direction: column;
    align-items: stretch;
  }

  .learned-skill-control {
    justify-items: stretch;
    width: 100%;
    flex-basis: auto;
  }

  .learned-skill-contract-grid {
    grid-template-columns: 1fr;
  }
}
</style>
