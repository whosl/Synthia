<script setup lang="ts">
import type { LearnedSkillSummaryV1 } from "../../api/evolution.ts";
import {
  QUALITY_STATE_TEXT,
  QUALITY_STATE_TONE,
  formatEvolutionTime,
  successRateText,
} from "../../domain/evolution.ts";
import Badge from "../ui/AppBadge.vue";

defineProps<{
  items: readonly LearnedSkillSummaryV1[];
  selectedSkillId: string | null;
  loading: boolean;
  truncated: boolean;
}>();

const emit = defineEmits<{ select: [skillId: string] }>();
</script>

<template>
  <aside class="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-panel" aria-label="Learned Skill 列表">
    <div class="border-b border-line p-4">
      <div>
        <h2 class="m-0">Learned Skills</h2>
        <p class="m-0 text-xs text-fg-secondary">{{ items.length }} 项能力</p>
      </div>
    </div>
    <div v-if="loading" class="grid gap-2 px-4 py-6 text-center text-fg-secondary" role="status">正在加载 Skill…</div>
    <div v-else-if="items.length === 0" class="grid gap-2 px-4 py-6 text-center text-fg-secondary">
      <strong>尚未沉淀 Learned Skill</strong>
      <span>turn / 任务片段封存后，Distiller 可以自动创建第一项能力。</span>
    </div>
    <div v-else class="grid content-start overflow-auto">
      <button
        v-for="skill in items"
        :key="skill.skill_id"
        type="button"
        class="grid w-full cursor-pointer gap-2 border-0 border-b border-line px-4 py-3 text-left text-fg hover:bg-hover"
        :class="selectedSkillId === skill.skill_id
          ? 'bg-hover shadow-[inset_3px_0_0_var(--accent)]'
          : 'bg-transparent'"
        :aria-pressed="selectedSkillId === skill.skill_id"
        @click="emit('select', skill.skill_id)"
      >
        <span class="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <strong>{{ skill.name }}</strong>
          <span class="text-xs text-fg-secondary">v{{ skill.active_version_no ?? "—" }}</span>
        </span>
        <span class="flex min-w-0 flex-wrap items-center gap-2">
          <Badge
            v-if="skill.quality_state"
            size="sm"
            :tone="QUALITY_STATE_TONE[skill.quality_state]"
          >
            {{ QUALITY_STATE_TEXT[skill.quality_state] }}
          </Badge>
          <Badge v-if="!skill.enabled" size="sm" tone="danger">已禁用</Badge>
          <Badge v-if="skill.freshness_state === 'stale'" size="sm" tone="neutral">长期未用</Badge>
        </span>
        <span class="line-clamp-2 text-xs text-fg-secondary">{{ skill.summary }}</span>
        <span class="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-fg-secondary">
          <span>解决率 {{ successRateText(skill.metrics) }}</span>
          <span>{{ skill.metrics.pending }} 待评价</span>
          <span>{{ formatEvolutionTime(skill.last_used_at) }}</span>
        </span>
      </button>
      <p v-if="truncated" class="m-0 px-4 py-3 text-center text-xs text-fg-secondary" role="status">
        当前只显示前 {{ items.length }} 项能力，仍有更多结果未加载。
      </p>
    </div>
  </aside>
</template>
