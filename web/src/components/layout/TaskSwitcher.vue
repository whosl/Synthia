<script setup lang="ts">
/**
 * 顶栏 · 任务切换器（spec §3.1 末条）。
 *
 * 下拉列出本项目全部 run（agent_id 短码 + 状态 + 创建时间），切换到另一 run 后
 * 对话流与阶段条同步换源，其它 run 仍在后台继续跑，不受影响。
 */
import { computed, ref } from "vue";
import type { TaskAgentSummary } from "../../api/types.ts";
import { TASK_STATUS_TEXT, isTerminalStatus, shortAgentId } from "../../domain/tasks.ts";
import Dropdown from "../ui/Dropdown.vue";
import Badge from "../ui/Badge.vue";

const props = defineProps<{
  readonly agents: readonly TaskAgentSummary[];
  readonly currentAgent: TaskAgentSummary | null;
  readonly allowNewAgent: boolean;
}>();

const emit = defineEmits<{
  "select-agent": [agentId: string];
  "new-agent": [];
}>();

const open = ref(false);

const agents = computed(() => [...props.agents].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));

/**
 * 触发器上没有 currentAgent 时的占位文案。项目里其实有 agent、只是刚点了
 * 「开始新对话」还没发第一条消息（forceNewTask 中间态）时说「尚无任务」是
 * 撒谎——那五个字是为真·空项目写的。
 */
const emptyLabel = computed(() => (props.agents.length > 0 ? "新对话" : "尚无任务"));

function statusTone(run: TaskAgentSummary): "ok" | "accent" | "warn" | "danger" | "neutral" {
  if (run.status === "succeeded") return "ok";
  if (run.status === "awaiting_approval") return "warn";
  if (run.status === "failed" || run.status === "fail_closed") return "danger";
  if (isTerminalStatus(run.status)) return "neutral";
  return "accent";
}

function statusText(run: TaskAgentSummary): string {
  return TASK_STATUS_TEXT[run.status] ?? run.status;
}

function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function onPick(agentId: string): void {
  open.value = false;
  if (agentId === props.currentAgent?.agent_id) return;
  emit("select-agent", agentId);
}

function onNew(): void {
  if (!props.allowNewAgent) return;
  open.value = false;
  emit("new-agent");
}
</script>

<template>
  <Dropdown v-model:open="open" align="start" class="task-switcher">
    <template #trigger>
      <button type="button" class="task-switcher-trigger">
        <span v-if="currentAgent" class="task-switcher-current">
          <Badge variant="dot" :tone="statusTone(currentAgent)">{{ shortAgentId(currentAgent.agent_id) }}</Badge>
          <span class="task-switcher-current-status">{{ statusText(currentAgent) }}</span>
        </span>
        <span v-else class="task-switcher-empty">{{ emptyLabel }}</span>
        <span class="task-switcher-caret" aria-hidden="true">▾</span>
      </button>
    </template>

    <div class="task-switcher-menu">
      <button type="button" class="task-switcher-row task-switcher-new" :disabled="!allowNewAgent" @click="onNew">
        <span class="task-switcher-new-icon" aria-hidden="true">+</span>
        <span>{{ allowNewAgent ? "开始新对话" : "工程项目暂只保留一个主 Agent" }}</span>
      </button>
      <div v-if="agents.length === 0" class="task-switcher-menu-empty">本项目还没有任务</div>
      <button
        v-for="run in agents"
        :key="run.agent_id"
        type="button"
        class="task-switcher-row"
        :class="{ 'is-current': run.agent_id === currentAgent?.agent_id }"
        role="menuitemradio"
        :aria-checked="run.agent_id === currentAgent?.agent_id"
        @click="onPick(run.agent_id)"
      >
        <Badge variant="dot" :tone="statusTone(run)">{{ shortAgentId(run.agent_id) }}</Badge>
        <span class="task-switcher-row-status">{{ statusText(run) }}</span>
        <span class="task-switcher-row-time">{{ formatCreatedAt(run.created_at) }}</span>
      </button>
    </div>
  </Dropdown>
</template>

<style scoped>
.task-switcher-trigger {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 26px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--surface-panel);
  color: var(--text-primary);
  cursor: pointer;
  font-size: var(--font-size-sm);
}

.task-switcher-trigger:hover {
  background: var(--surface-hover);
}

.task-switcher-current {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-family: var(--font-mono);
}

.task-switcher-current-status {
  color: var(--text-muted);
  font-family: var(--font-sans);
}

.task-switcher-empty {
  color: var(--text-muted);
}

.task-switcher-caret {
  color: var(--text-muted);
  font-size: 10px;
}

.task-switcher-menu {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 260px;
  max-height: 320px;
  overflow-y: auto;
}

.task-switcher-menu-empty {
  padding: var(--space-2);
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.task-switcher-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  font-size: var(--font-size-sm);
  text-align: left;
}

.task-switcher-row:hover {
  background: var(--surface-hover);
}

.task-switcher-row.is-current {
  background: var(--accent-subtle);
}

.task-switcher-new {
  color: var(--accent);
  font-weight: 600;
  border-bottom: 1px solid var(--border-subtle);
  border-radius: 0;
  margin-bottom: 1px;
}

.task-switcher-new:disabled {
  color: var(--text-muted);
  cursor: not-allowed;
  opacity: 0.8;
}

.task-switcher-new-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: 13px;
}

.task-switcher-row-status {
  flex: 1;
  color: var(--text-secondary);
}

.task-switcher-row-time {
  color: var(--text-muted);
  font-size: 11px;
  font-family: var(--font-mono);
}
</style>
