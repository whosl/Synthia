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
  <div class="agent-pane-tabs" aria-label="Agent 窗格">
    <div class="agent-pane-tabs-scroll" role="tablist" aria-label="项目 Agent">
      <button
        type="button"
        class="agent-pane-tab is-main"
        :class="{ 'is-active': activePane === 'main' }"
        role="tab"
        :aria-selected="activePane === 'main'"
        @click="emit('select', 'main')"
      >
        <span class="agent-pane-dot" aria-hidden="true" />
        主线
      </button>

      <div
        v-for="agent in sideAgents"
        :key="agent.task_id"
        class="agent-pane-side-tab"
        :class="{ 'is-active': activePane === agent.task_id }"
      >
        <button
          type="button"
          class="agent-pane-tab"
          role="tab"
          :aria-selected="activePane === agent.task_id"
          :title="`${agent.objective} · ${SIDE_TASK_STATUS_TEXT[agent.status]}`"
          @click="emit('select', agent.task_id)"
        >
          <span class="agent-pane-dot" :class="`is-${agent.status}`" aria-hidden="true" />
          {{ shortTitle(agent) }}
        </button>
        <button
          type="button"
          class="agent-pane-archive"
          :aria-label="`归档 Side Agent：${agent.objective}`"
          title="归档窗格（任务记录仍保留）"
          @click.stop="emit('archive', agent.task_id)"
        >×</button>
      </div>
    </div>

    <button
      type="button"
      class="agent-pane-add"
      :class="{ 'is-active': activePane === 'new' }"
      :disabled="!canCreateSideAgent"
      aria-label="添加 Side Agent"
      title="添加 Side Agent"
      @click="emit('create')"
    >＋</button>
  </div>
</template>

<style scoped>
.agent-pane-tabs {
  display: flex;
  flex: none;
  align-items: stretch;
  min-width: 0;
  height: 38px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-panel);
}

.agent-pane-tabs-scroll {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.agent-pane-tabs-scroll::-webkit-scrollbar {
  display: none;
}

.agent-pane-side-tab {
  display: flex;
  flex: none;
  align-items: center;
  border-right: 1px solid var(--border-subtle);
}

.agent-pane-tab,
.agent-pane-add,
.agent-pane-archive {
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.agent-pane-tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  max-width: 170px;
  padding: 0 var(--space-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-sm);
}

.agent-pane-tab.is-main {
  flex: none;
  border-right: 1px solid var(--border-subtle);
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

.agent-pane-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--accent);
}

.agent-pane-dot.is-succeeded {
  background: var(--state-ok);
}

.agent-pane-dot.is-failed,
.agent-pane-dot.is-fail_closed {
  background: var(--state-danger);
}

.agent-pane-dot.is-awaiting_user {
  background: var(--state-warn);
}

.agent-pane-dot.is-cancelled {
  background: var(--text-muted);
}

.agent-pane-archive {
  align-self: stretch;
  padding: 0 var(--space-1);
  font-size: 14px;
}

.agent-pane-add {
  width: 38px;
  flex: none;
  border-left: 1px solid var(--border-subtle);
  color: var(--accent);
  font-size: 18px;
}

.agent-pane-add:disabled {
  color: var(--text-muted);
  cursor: not-allowed;
}
</style>
