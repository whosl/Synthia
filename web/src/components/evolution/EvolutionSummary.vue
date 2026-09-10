<script setup lang="ts">
import type { CuratorRunV1, EvolutionOverviewV1 } from "../../api/evolution.ts";
import { computed } from "vue";
import {
  canRunCurator,
  canToggleLearnedSkills,
  canToggleLearning,
  formatEvolutionTime,
} from "../../domain/evolution.ts";
import Badge from "../ui/AppBadge.vue";
import Button from "../ui/AppButton.vue";

const props = defineProps<{
  overview: EvolutionOverviewV1;
  reason: string;
  operatingAction: string | null;
  lastManualRun: CuratorRunV1 | null;
}>();

const emit = defineEmits<{
  "update:reason": [reason: string];
  "toggle-learning": [];
  "toggle-skills": [];
  "run-curator": [mode: "run" | "dry_run"];
  refresh: [];
}>();

const reasonMissing = computed(() => props.reason.trim().length === 0);
const operating = computed(() => props.operatingAction !== null);
const learningUnavailable = computed(() => !canToggleLearning(props.overview));
const skillsUnavailable = computed(() => !canToggleLearnedSkills(props.overview));
const curatorUnavailable = computed(() => !canRunCurator(props.overview));

function onReason(event: Event): void {
  emit("update:reason", (event.target as HTMLInputElement).value);
}
</script>

<template>
  <section class="evolution-summary" aria-labelledby="evolution-summary-title">
    <div class="evolution-summary-head">
      <div>
        <p class="evolution-kicker">Self-evolution v1</p>
        <h2 id="evolution-summary-title">能力演进概览</h2>
        <p>Learned Skill 自动沉淀并乐观生效；质量结论只来自 Curator 的真实调用评价。</p>
      </div>
      <div class="evolution-summary-head-actions">
        <Badge :tone="overview.rollout_enabled ? 'ok' : 'danger'">
          {{ overview.rollout_enabled ? "Core 能力已启用" : "Core 能力未启用" }}
        </Badge>
        <Button size="sm" variant="ghost" :disabled="operatingAction !== null" @click="emit('refresh')">刷新</Button>
      </div>
    </div>

    <div class="evolution-stat-grid">
      <article>
        <span>待 Curator 评价</span>
        <strong>{{ overview.pending_applications }}</strong>
        <small>pending application 单独统计</small>
      </article>
      <article>
        <span>已观察 Skill</span>
        <strong>{{ overview.skill_counts.active_observed }}</strong>
        <small>不含待观察与 inconclusive</small>
      </article>
      <article>
        <span>需要关注</span>
        <strong>{{ overview.skill_counts.needs_review + overview.skill_counts.degraded + overview.skill_counts.quarantined }}</strong>
        <small>复核、降级或隔离</small>
      </article>
      <article>
        <span>已禁用 / 归档</span>
        <strong>{{ overview.skill_counts.disabled + overview.skill_counts.archived }}</strong>
        <small>历史事实仍然保留</small>
      </article>
    </div>

    <div class="evolution-control-grid">
      <section class="evolution-control-card">
        <div>
          <h3>学习与使用</h3>
          <p>
            Distiller：<strong>{{ overview.learning_paused ? "已暂停" : "运行中" }}</strong>
            · Learned Skills：<strong>{{ overview.learned_skills_enabled ? "已启用" : "已禁用" }}</strong>
          </p>
        </div>
        <div class="evolution-button-row">
          <Button
            size="sm"
            :variant="overview.learning_paused ? 'primary' : 'danger'"
            :loading="operatingAction === 'settings-learning'"
            :disabled="operating || learningUnavailable || reasonMissing"
            @click="emit('toggle-learning')"
          >
            {{ overview.learning_paused ? "恢复学习" : "暂停学习" }}
          </Button>
          <Button
            size="sm"
            :variant="overview.learned_skills_enabled ? 'danger' : 'primary'"
            :loading="operatingAction === 'settings-skills'"
            :disabled="operating || skillsUnavailable || reasonMissing"
            @click="emit('toggle-skills')"
          >
            {{ overview.learned_skills_enabled ? "禁用 Learned Skills" : "启用 Learned Skills" }}
          </Button>
        </div>
      </section>

      <section class="evolution-control-card">
        <div>
          <h3>Curator</h3>
          <p>上次：{{ formatEvolutionTime(overview.curator.last_run_at) }}</p>
          <p>下次具备资格：{{ formatEvolutionTime(overview.curator.next_eligible_at) }}</p>
        </div>
        <div class="evolution-button-row">
          <Button
            size="sm"
            variant="primary"
            :loading="operatingAction === 'curator-run'"
            :disabled="operating || curatorUnavailable || reasonMissing"
            @click="emit('run-curator', 'run')"
          >
            Run Curator now
          </Button>
          <Button
            size="sm"
            :loading="operatingAction === 'curator-dry_run'"
            :disabled="operating || curatorUnavailable || reasonMissing"
            @click="emit('run-curator', 'dry_run')"
          >
            Dry-run
          </Button>
        </div>
      </section>
    </div>

    <p v-if="!overview.rollout_enabled" class="evolution-rollout-warning" role="note">
      Core rollout 未启用：历史与管理事实仍可读取；仅保留全局和单 Skill 的紧急禁用，恢复学习、重新启用和 Curator 操作均已锁定。
    </p>

    <label class="evolution-reason">
      <span>控制原因（写操作必填）</span>
      <input
        :value="reason"
        type="text"
        maxlength="500"
        placeholder="例如：本周维护窗口，暂停自动提炼"
        :disabled="operatingAction !== null"
        @input="onReason"
      />
    </label>
    <p v-if="reasonMissing" class="evolution-hint">填写原因后才可执行控制操作；失败重试会复用同一请求体和幂等键。</p>
    <p v-if="lastManualRun" class="evolution-run-result" role="status">
      {{ lastManualRun.mode === "run" ? "Curator 已排队" : "Curator dry-run 已完成" }}：{{ lastManualRun.curator_run_id }}
    </p>
    <p class="evolution-schedule-note">
      周期 {{ overview.curator.schedule_days }} 天 · 空闲 {{ overview.curator.idle_hours }} 小时后执行 ·
      每轮最多 {{ overview.curator.max_vivado_jobs }} 个 Vivado 任务 · 最长 {{ overview.curator.max_duration_minutes }} 分钟
    </p>
  </section>
</template>

<style scoped>
.evolution-summary {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-5);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-panel);
}

.evolution-summary-head,
.evolution-summary-head-actions,
.evolution-button-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.evolution-summary-head {
  justify-content: space-between;
  align-items: flex-start;
}

.evolution-summary h2,
.evolution-summary h3,
.evolution-summary p {
  margin: 0;
}

.evolution-summary-head p,
.evolution-control-card p,
.evolution-schedule-note,
.evolution-hint,
.evolution-rollout-warning {
  color: var(--text-secondary);
}

.evolution-rollout-warning {
  padding: var(--space-3);
  border: 1px solid var(--warning-border, var(--border));
  border-radius: var(--radius);
  background: var(--warning-bg, var(--surface-base));
}

.evolution-kicker {
  margin-bottom: var(--space-1) !important;
  color: var(--accent) !important;
  font-size: var(--font-size-sm);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.evolution-stat-grid,
.evolution-control-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
}

.evolution-stat-grid article,
.evolution-control-card {
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-base);
}

.evolution-stat-grid article {
  display: grid;
  gap: var(--space-1);
}

.evolution-stat-grid span,
.evolution-stat-grid small {
  color: var(--text-secondary);
}

.evolution-stat-grid strong {
  font-size: 24px;
  line-height: 1;
}

.evolution-control-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.evolution-control-card {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
}

.evolution-control-card h3 {
  margin-bottom: var(--space-1);
}

.evolution-button-row {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.evolution-reason {
  display: grid;
  gap: var(--space-1);
  font-weight: 600;
}

.evolution-reason input {
  width: 100%;
  min-width: 0;
  height: 34px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-base);
  color: var(--text-primary);
}

.evolution-hint,
.evolution-run-result,
.evolution-schedule-note {
  font-size: var(--font-size-sm);
}

.evolution-run-result {
  color: var(--state-ok);
}

@media (max-width: 900px) {
  .evolution-stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .evolution-control-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  .evolution-summary {
    padding: var(--space-3);
  }

  .evolution-summary-head,
  .evolution-control-card {
    flex-direction: column;
  }

  .evolution-summary-head-actions,
  .evolution-button-row {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
