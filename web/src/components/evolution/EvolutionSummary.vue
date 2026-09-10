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
  <section class="grid gap-4 rounded-lg border border-line bg-panel p-5 max-[560px]:p-3" aria-labelledby="evolution-summary-title">
    <div class="flex items-start justify-between gap-2 max-[560px]:flex-col">
      <div>
        <p class="m-0 mb-1 text-xs font-bold tracking-[0.04em] text-brand uppercase">Self-evolution v1</p>
        <h2 id="evolution-summary-title" class="m-0">能力演进概览</h2>
        <p class="m-0 text-fg-secondary">Learned Skill 自动沉淀并乐观生效；质量结论只来自 Curator 的真实调用评价。</p>
      </div>
      <div class="flex items-center gap-2 max-[560px]:w-full max-[560px]:justify-start">
        <Badge :tone="overview.rollout_enabled ? 'ok' : 'danger'">
          {{ overview.rollout_enabled ? "Core 能力已启用" : "Core 能力未启用" }}
        </Badge>
        <Button size="sm" variant="ghost" :disabled="operatingAction !== null" @click="emit('refresh')">刷新</Button>
      </div>
    </div>

    <div class="grid grid-cols-4 gap-3 max-[900px]:grid-cols-2">
      <article class="grid min-w-0 gap-1 rounded-md border border-line bg-base p-3">
        <span class="text-fg-secondary">待 Curator 评价</span>
        <strong class="text-2xl leading-none">{{ overview.pending_applications }}</strong>
        <small class="text-fg-secondary">pending application 单独统计</small>
      </article>
      <article class="grid min-w-0 gap-1 rounded-md border border-line bg-base p-3">
        <span class="text-fg-secondary">已观察 Skill</span>
        <strong class="text-2xl leading-none">{{ overview.skill_counts.active_observed }}</strong>
        <small class="text-fg-secondary">不含待观察与 inconclusive</small>
      </article>
      <article class="grid min-w-0 gap-1 rounded-md border border-line bg-base p-3">
        <span class="text-fg-secondary">需要关注</span>
        <strong class="text-2xl leading-none">{{ overview.skill_counts.needs_review + overview.skill_counts.degraded + overview.skill_counts.quarantined }}</strong>
        <small class="text-fg-secondary">复核、降级或隔离</small>
      </article>
      <article class="grid min-w-0 gap-1 rounded-md border border-line bg-base p-3">
        <span class="text-fg-secondary">已禁用 / 归档</span>
        <strong class="text-2xl leading-none">{{ overview.skill_counts.disabled + overview.skill_counts.archived }}</strong>
        <small class="text-fg-secondary">历史事实仍然保留</small>
      </article>
    </div>

    <div class="grid grid-cols-2 gap-3 max-[900px]:grid-cols-1">
      <section class="flex min-w-0 justify-between gap-3 rounded-md border border-line bg-base p-3 max-[560px]:flex-col">
        <div>
          <h3 class="m-0 mb-1">学习与使用</h3>
          <p class="m-0 text-fg-secondary">
            Distiller：<strong>{{ overview.learning_paused ? "已暂停" : "运行中" }}</strong>
            · Learned Skills：<strong>{{ overview.learned_skills_enabled ? "已启用" : "已禁用" }}</strong>
          </p>
        </div>
        <div class="flex flex-wrap items-center justify-end gap-2 max-[560px]:w-full max-[560px]:justify-start">
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

      <section class="flex min-w-0 justify-between gap-3 rounded-md border border-line bg-base p-3 max-[560px]:flex-col">
        <div>
          <h3 class="m-0 mb-1">Curator</h3>
          <p class="m-0 text-fg-secondary">上次：{{ formatEvolutionTime(overview.curator.last_run_at) }}</p>
          <p class="m-0 text-fg-secondary">下次具备资格：{{ formatEvolutionTime(overview.curator.next_eligible_at) }}</p>
        </div>
        <div class="flex flex-wrap items-center justify-end gap-2 max-[560px]:w-full max-[560px]:justify-start">
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

    <p
      v-if="!overview.rollout_enabled"
      class="m-0 rounded-md border border-[var(--warning-border,var(--border))] bg-[var(--warning-bg,var(--surface-base))] p-3 text-fg-secondary"
      role="note"
    >
      Core rollout 未启用：历史与管理事实仍可读取；仅保留全局和单 Skill 的紧急禁用，恢复学习、重新启用和 Curator 操作均已锁定。
    </p>

    <label class="grid gap-1 font-semibold">
      <span>控制原因（写操作必填）</span>
      <input
        :value="reason"
        type="text"
        maxlength="500"
        placeholder="例如：本周维护窗口，暂停自动提炼"
        :disabled="operatingAction !== null"
        class="h-[34px] w-full min-w-0 rounded-md border border-line-strong bg-base px-2 text-fg"
        @input="onReason"
      />
    </label>
    <p v-if="reasonMissing" class="m-0 text-xs text-fg-secondary">填写原因后才可执行控制操作；失败重试会复用同一请求体和幂等键。</p>
    <p v-if="lastManualRun" class="m-0 text-xs text-ok" role="status">
      {{ lastManualRun.mode === "run" ? "Curator 已排队" : "Curator dry-run 已完成" }}：{{ lastManualRun.curator_run_id }}
    </p>
    <p class="m-0 text-xs text-fg-secondary">
      周期 {{ overview.curator.schedule_days }} 天 · 空闲 {{ overview.curator.idle_hours }} 小时后执行 ·
      每轮最多 {{ overview.curator.max_vivado_jobs }} 个 Vivado 任务 · 最长 {{ overview.curator.max_duration_minutes }} 分钟
    </p>
  </section>
</template>
