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
import Badge from "../ui/AppBadge.vue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";

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
  <DropdownMenu v-model:open="open">
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        class="flex h-[26px] cursor-pointer items-center gap-2 rounded-md border border-line bg-panel px-2 text-xs text-fg hover:bg-hover"
      >
        <span v-if="currentAgent" class="flex items-center gap-1 font-mono">
          <Badge variant="dot" :tone="statusTone(currentAgent)">{{ shortAgentId(currentAgent.agent_id) }}</Badge>
          <span class="font-sans text-fg-muted">{{ statusText(currentAgent) }}</span>
        </span>
        <span v-else class="text-fg-muted">{{ emptyLabel }}</span>
        <span class="text-[10px] text-fg-muted" aria-hidden="true">▾</span>
      </button>
    </DropdownMenuTrigger>

    <DropdownMenuContent align="start" class="max-h-80 min-w-[260px]">
      <DropdownMenuItem as-child :disabled="!allowNewAgent">
        <button
          type="button"
          class="mb-px flex w-full cursor-pointer items-center gap-2 rounded-none border-0 border-b border-line bg-transparent px-2 py-1 text-left text-xs font-semibold text-brand hover:bg-hover disabled:cursor-not-allowed disabled:text-fg-muted disabled:opacity-80"
          :disabled="!allowNewAgent"
          @click="onNew"
        >
          <span class="inline-flex h-4 w-4 items-center justify-center text-[13px]" aria-hidden="true">+</span>
          <span>{{ allowNewAgent ? "开始新对话" : "工程项目暂只保留一个主 Agent" }}</span>
        </button>
      </DropdownMenuItem>
      <div v-if="agents.length === 0" class="p-2 text-xs text-fg-muted">本项目还没有任务</div>
      <DropdownMenuItem v-for="run in agents" :key="run.agent_id" as-child>
        <button
          type="button"
          class="flex cursor-pointer items-center gap-2 rounded-sm border-0 px-2 py-1 text-left text-xs text-fg hover:bg-hover"
          :class="run.agent_id === currentAgent?.agent_id ? 'bg-brand-subtle' : 'bg-transparent'"
          role="menuitemradio"
          :aria-checked="run.agent_id === currentAgent?.agent_id"
          @click="onPick(run.agent_id)"
        >
          <Badge variant="dot" :tone="statusTone(run)">{{ shortAgentId(run.agent_id) }}</Badge>
          <span class="flex-1 text-fg-secondary">{{ statusText(run) }}</span>
          <span class="font-mono text-[11px] text-fg-muted">{{ formatCreatedAt(run.created_at) }}</span>
        </button>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
