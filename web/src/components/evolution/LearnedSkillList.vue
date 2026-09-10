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
  <aside class="learned-skill-list" aria-label="Learned Skill 列表">
    <div class="learned-skill-list-head">
      <div>
        <h2>Learned Skills</h2>
        <p>{{ items.length }} 项能力</p>
      </div>
    </div>
    <div v-if="loading" class="learned-skill-empty" role="status">正在加载 Skill…</div>
    <div v-else-if="items.length === 0" class="learned-skill-empty">
      <strong>尚未沉淀 Learned Skill</strong>
      <span>turn / 任务片段封存后，Distiller 可以自动创建第一项能力。</span>
    </div>
    <div v-else class="learned-skill-scroll">
      <button
        v-for="skill in items"
        :key="skill.skill_id"
        type="button"
        class="learned-skill-row"
        :class="{ 'is-selected': selectedSkillId === skill.skill_id }"
        :aria-pressed="selectedSkillId === skill.skill_id"
        @click="emit('select', skill.skill_id)"
      >
        <span class="learned-skill-row-title">
          <strong>{{ skill.name }}</strong>
          <span>v{{ skill.active_version_no ?? "—" }}</span>
        </span>
        <span class="learned-skill-badges">
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
        <span class="learned-skill-summary">{{ skill.summary }}</span>
        <span class="learned-skill-row-metrics">
          <span>解决率 {{ successRateText(skill.metrics) }}</span>
          <span>{{ skill.metrics.pending }} 待评价</span>
          <span>{{ formatEvolutionTime(skill.last_used_at) }}</span>
        </span>
      </button>
      <p v-if="truncated" class="learned-skill-truncated" role="status">
        当前只显示前 {{ items.length }} 项能力，仍有更多结果未加载。
      </p>
    </div>
  </aside>
</template>

<style scoped>
.learned-skill-list {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-panel);
  overflow: hidden;
}

.learned-skill-list-head {
  padding: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.learned-skill-list h2,
.learned-skill-list p {
  margin: 0;
}

.learned-skill-list p {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.learned-skill-scroll {
  display: grid;
  align-content: start;
  overflow: auto;
}

.learned-skill-row {
  display: grid;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-3) var(--space-4);
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.learned-skill-row:hover,
.learned-skill-row.is-selected {
  background: var(--surface-hover);
}

.learned-skill-row.is-selected {
  box-shadow: inset 3px 0 0 var(--accent);
}

.learned-skill-row-title,
.learned-skill-badges,
.learned-skill-row-metrics {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  flex-wrap: wrap;
}

.learned-skill-row-title {
  justify-content: space-between;
}

.learned-skill-row-title span,
.learned-skill-summary,
.learned-skill-row-metrics {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.learned-skill-summary {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.learned-skill-row-metrics {
  justify-content: space-between;
}

.learned-skill-empty {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-4);
  color: var(--text-secondary);
  text-align: center;
}

.learned-skill-truncated {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  text-align: center;
}
</style>
