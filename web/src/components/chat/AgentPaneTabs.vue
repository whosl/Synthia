<script setup lang="ts">
import type { SideTaskSummary } from "../../api/types.ts";
import { SIDE_TASK_STATUS_TEXT } from "../../domain/side-tasks.ts";

defineProps<{
  activePane: "main" | "new" | string;
  sideAgents: readonly SideTaskSummary[];
  canCreateSideAgent: boolean;
}>();

const emit = defineEmits<{
  select: [pane: "main" | string];
  create: [];
  archive: [taskId: string];
}>();

function shortTitle(task: SideTaskSummary): string {
  const title = task.objective.trim();
  return title.length > 16 ? `${title.slice(0, 16)}…` : title;
}
</script>

<template>
  <div class="flex h-[38px] min-w-0 flex-none items-stretch border-b border-line bg-panel" aria-label="Agent 窗格">
    <div class="agent-pane-tabs-scroll flex min-w-0 flex-1 overflow-x-auto" role="tablist" aria-label="项目 Agent">
      <button
        type="button"
        class="agent-pane-tab is-main inline-flex min-w-0 max-w-[170px] flex-none cursor-pointer items-center gap-1 overflow-hidden border-0 border-r border-line bg-transparent px-2 text-ellipsis whitespace-nowrap"
        :class="{ 'is-active': activePane === 'main' }"
        role="tab"
        :aria-selected="activePane === 'main'"
        @click="emit('select', 'main')"
      >
        <span class="size-[7px] flex-none rounded-full bg-brand" aria-hidden="true" />
        主线
      </button>

      <div
        v-for="agent in sideAgents"
        :key="agent.task_id"
        class="agent-pane-side-tab flex flex-none items-center border-r border-line"
        :class="{ 'is-active': activePane === agent.task_id }"
      >
        <button
          type="button"
          class="agent-pane-tab inline-flex min-w-0 max-w-[170px] cursor-pointer items-center gap-1 overflow-hidden border-0 bg-transparent px-2 text-ellipsis whitespace-nowrap"
          :class="{ 'is-active': activePane === agent.task_id }"
          role="tab"
          :aria-selected="activePane === agent.task_id"
          :title="`${agent.objective} · ${SIDE_TASK_STATUS_TEXT[agent.status]}`"
          @click="emit('select', agent.task_id)"
        >
          <span
            class="size-[7px] flex-none rounded-full"
            :class="agent.status === 'succeeded' ? 'bg-ok' : agent.status === 'failed' || agent.status === 'fail_closed' ? 'bg-danger' : agent.status === 'awaiting_user' ? 'bg-warn' : agent.status === 'cancelled' ? 'bg-fg-muted' : 'bg-brand'"
            aria-hidden="true"
          />
          {{ shortTitle(agent) }}
        </button>
        <button
          type="button"
          class="agent-pane-archive cursor-pointer self-stretch border-0 bg-transparent px-1"
          :aria-label="`归档 Side Agent：${agent.objective}`"
          title="归档窗格（任务记录仍保留）"
          @click.stop="emit('archive', agent.task_id)"
        >×</button>
      </div>
    </div>

    <button
      type="button"
      class="agent-pane-add w-[38px] flex-none cursor-pointer border-0 border-l border-line bg-transparent"
      :class="{ 'is-active': activePane === 'new' }"
      :disabled="!canCreateSideAgent"
      aria-label="添加 Side Agent"
      title="添加 Side Agent"
      @click="emit('create')"
    >＋</button>
  </div>
</template>

<style scoped>
/* 未分层全局 reset 的 button { font: inherit; color: inherit } 优先级高于 Tailwind
   utilities 层：按钮文字色/字号，以及需要与 is-active 保持原层叠顺序的 hover/active
   底色（hover 在后、覆盖 active），只能留在 scoped。 */
.agent-pane-tab,
.agent-pane-add,
.agent-pane-archive {
  color: var(--text-secondary);
}

.agent-pane-tab {
  font-size: var(--font-size-sm);
}

.agent-pane-tab.is-main {
  font-weight: 600;
}

.agent-pane-tab.is-active,
.agent-pane-side-tab.is-active,
.agent-pane-add.is-active {
  background: var(--accent-subtle);
  color: var(--accent);
}

.agent-pane-tab:hover,
.agent-pane-add:hover:not(:disabled),
.agent-pane-archive:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.agent-pane-add {
  font-size: 18px;
  color: var(--accent);
}

.agent-pane-add:disabled {
  color: var(--text-muted);
  cursor: not-allowed;
}

.agent-pane-archive {
  font-size: 14px;
}

/* 全局 * { scrollbar-width: thin } 同为未分层规则，滚动条隐藏也留在 scoped。 */
.agent-pane-tabs-scroll {
  scrollbar-width: none;
}

.agent-pane-tabs-scroll::-webkit-scrollbar {
  display: none;
}
</style>
