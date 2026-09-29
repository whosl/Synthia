<script setup lang="ts">
import { computed, ref } from "vue";
import { skillDisplayName } from "../../domain/evolution-display.ts";
import { Sprout } from "lucide-vue-next";
import type { LearnedSkillSummaryV1 } from "../../api/evolution.ts";
import {
  QUALITY_STATE_TEXT,
  QUALITY_STATE_TONE,
  successRateText,
} from "../../domain/evolution.ts";
import Badge from "../ui/AppBadge.vue";
import { Skeleton } from "../ui/skeleton";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";

const props = defineProps<{
  items: readonly LearnedSkillSummaryV1[];
  selectedSkillId: string | null;
  loading: boolean;
  truncated: boolean;
}>();

const query = ref("");
const visibleItems = computed(() => props.items.filter((skill) => `${skill.name} ${skill.summary}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const emit = defineEmits<{ select: [skillId: string] }>();
</script>

<template>
  <aside class="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-panel" aria-label="Learned Skill 列表">
    <div class="border-b border-line p-4">
      <div>
        <h2 class="m-0 text-sm font-semibold">技能库</h2>
        <p class="m-0 text-xs text-fg-secondary">{{ items.length }} 项能力</p>
      </div>
      <input v-model="query" aria-label="搜索技能" placeholder="搜索技能…" class="mt-3 w-full rounded-md border border-line bg-base px-3 py-2 text-xs text-fg" />
    </div>
    <div v-if="loading" class="grid content-start gap-2 p-4" role="status" aria-label="正在加载 Skill">
      <div v-for="n in 4" :key="n" class="grid gap-2 rounded-md border border-line p-3">
        <Skeleton class="h-3 w-1/2" />
        <Skeleton class="h-2 w-3/4" />
      </div>
      <span class="visually-hidden">正在加载 Skill…</span>
    </div>
    <Empty v-else-if="items.length === 0">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Sprout :size="20" /></EmptyMedia>
        <EmptyTitle>尚未沉淀 Learned Skill</EmptyTitle>
        <EmptyDescription>turn / 任务片段封存后，Distiller 可以自动创建第一项能力。</EmptyDescription>
      </EmptyHeader>
    </Empty>
    <div v-else class="grid max-h-[680px] content-start overflow-auto max-[980px]:max-h-[320px]">
      <button
        v-for="skill in visibleItems"
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
          <strong class="line-clamp-2 min-w-0 flex-1 text-xs leading-relaxed" :title="skill.name">{{ skillDisplayName(skill.name) }}</strong>
          <span class="text-xs text-fg-secondary">当前 v{{ skill.active_version_no ?? "—" }}</span>
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
        <span class="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-fg-secondary">
          <span>解决率 {{ successRateText(skill.metrics) }}</span>
          <span>{{ skill.metrics.primary_applied }} 次主用</span>
        </span>
        <span class="text-[10px] text-fg-muted">{{ skill.metrics_scope === 'all_versions' ? '全部版本累计' : '当前版本统计' }}</span>
      </button>
      <p v-if="visibleItems.length === 0" class="p-4 text-xs text-fg-muted">没有匹配的技能</p>
      <p v-if="truncated" class="m-0 px-4 py-3 text-center text-xs text-fg-secondary" role="status">
        当前只显示前 {{ items.length }} 项能力，仍有更多结果未加载。
      </p>
    </div>
  </aside>
</template>
