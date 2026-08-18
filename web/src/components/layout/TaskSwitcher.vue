<script setup lang="ts">
/**
 * 顶栏 · 任务切换器（spec §3.1 末条）。
 *
 * 下拉列出本项目全部 run（run_id 短码 + 状态 + 创建时间），切换到另一 run 后
 * 对话流与阶段条同步换源，其它 run 仍在后台继续跑，不受影响。
 */
import { computed, ref } from "vue";
import type { TaskRunSummary } from "../../api/types.ts";
import { TASK_STATUS_TEXT, isTerminalStatus, shortRunId } from "../../domain/tasks.ts";
import Dropdown from "../ui/Dropdown.vue";
import Badge from "../ui/Badge.vue";

const props = defineProps<{
  readonly runs: readonly TaskRunSummary[];
  readonly currentRun: TaskRunSummary | null;
}>();

const emit = defineEmits<{
  "select-run": [runId: string];
}>();

const open = ref(false);

const runs = computed(() => [...props.runs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));

function statusTone(run: TaskRunSummary): "ok" | "accent" | "warn" | "danger" | "neutral" {
  if (run.status === "succeeded") return "ok";
  if (run.status === "awaiting_approval") return "warn";
  if (run.status === "failed" || run.status === "fail_closed") return "danger";
  if (isTerminalStatus(run.status)) return "neutral";
  return "accent";
}

function statusText(run: TaskRunSummary): string {
  return TASK_STATUS_TEXT[run.status] ?? run.status;
}

function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function onPick(runId: string): void {
  open.value = false;
  if (runId === props.currentRun?.run_id) return;
  emit("select-run", runId);
}
</script>

<template>
  <Dropdown v-model:open="open" align="start" class="task-switcher">
    <template #trigger>
      <button type="button" class="task-switcher-trigger">
        <span v-if="currentRun" class="task-switcher-current">
          <Badge variant="dot" :tone="statusTone(currentRun)">{{ shortRunId(currentRun.run_id) }}</Badge>
          <span class="task-switcher-current-status">{{ statusText(currentRun) }}</span>
        </span>
        <span v-else class="task-switcher-empty">尚无任务</span>
        <span class="task-switcher-caret" aria-hidden="true">▾</span>
      </button>
    </template>

    <div class="task-switcher-menu">
      <div v-if="runs.length === 0" class="task-switcher-menu-empty">本项目还没有任务</div>
      <button
        v-for="run in runs"
        :key="run.run_id"
        type="button"
        class="task-switcher-row"
        :class="{ 'is-current': run.run_id === currentRun?.run_id }"
        role="menuitemradio"
        :aria-checked="run.run_id === currentRun?.run_id"
        @click="onPick(run.run_id)"
      >
        <Badge variant="dot" :tone="statusTone(run)">{{ shortRunId(run.run_id) }}</Badge>
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
