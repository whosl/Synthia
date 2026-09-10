<script setup lang="ts">
/**
 * 工具调用折叠展示（右栏对话流内的工具条：「▸ vivado synth ✅ 12.4s」一类行）。
 *
 * 四态视觉（spec §2 布局示例）：
 * - pending：准备中，弱化；
 * - running：进行中，强调色 + 加载态；
 * - completed：完成，弱化（对齐 parts.ts 注释「completed 弱化 + 耗时」，避免
 *   已完成的工具条抢占正在发生的事情的注意力）；
 * - error：未通过，危险色 + 可展开查看人话错误说明（errorText）。
 *
 * 耗时用 `domain/parts.ts:toolDurationLabel`（<2s 不展示，弱化噪音）。
 */
import { computed, ref } from "vue";
import { TOOL_STATUS_TEXT, toolDurationLabel, type SynthiaToolPart } from "../../domain/parts.ts";
import Badge from "../ui/AppBadge.vue";

const props = defineProps<{ part: SynthiaToolPart }>();
const emit = defineEmits<{ "open-records": [jobId: string] }>();

const STATUS_GLYPH: Record<SynthiaToolPart["status"], string> = {
  pending: "○",
  running: "◐",
  completed: "✅",
  error: "⚠️",
};

const STATUS_TONE: Record<SynthiaToolPart["status"], "neutral" | "accent" | "ok" | "danger"> = {
  pending: "neutral",
  running: "accent",
  completed: "ok",
  error: "danger",
};

const durationText = computed(() => toolDurationLabel(props.part.durationMs));
const expandable = computed(() => props.part.status === "error" && !!props.part.errorText);
const expanded = ref(false);

function toggle(): void {
  if (!expandable.value) return;
  expanded.value = !expanded.value;
}

function onOpenRecords(): void {
  if (props.part.jobId) emit("open-records", props.part.jobId);
}
</script>

<template>
  <div class="rounded-sm bg-hover" :class="part.status === 'completed' ? 'opacity-72' : ''">
    <div
      class="flex w-full items-center gap-1 px-2 py-1 text-left text-xs text-fg-secondary"
      :class="expandable ? 'cursor-pointer' : 'cursor-default'"
      role="button"
      tabindex="0"
      @click="toggle"
      @keydown.enter="toggle"
      @keydown.space.prevent="toggle"
    >
      <span class="w-[10px] flex-none text-fg-muted" aria-hidden="true">{{ expandable ? (expanded ? "▾" : "▸") : "·" }}</span>
      <span
        class="flex-none"
        :class="part.status === 'running' ? 'inline-block text-brand [animation:tool-call-spin_1.1s_linear_infinite]' : part.status === 'error' ? 'text-danger' : ''"
        aria-hidden="true"
      >{{ STATUS_GLYPH[part.status] }}</span>
      <span class="min-w-0 flex-1 truncate" :class="part.status === 'error' ? 'text-danger' : 'text-fg'">{{ part.title }}</span>
      <Badge :tone="STATUS_TONE[part.status]" variant="dot" size="sm">{{ TOOL_STATUS_TEXT[part.status] }}</Badge>
      <span v-if="durationText" class="flex-none font-mono text-[11px] text-fg-muted">{{ durationText }}</span>
      <button v-if="part.jobId" type="button" class="flex-none cursor-pointer border-none bg-transparent p-0 text-[11px] text-fg-muted hover:text-brand" @click.stop="onOpenRecords">运行记录</button>
    </div>
    <div v-if="expandable && expanded" class="px-2 pb-2 pl-[26px] text-xs leading-[1.4] text-danger">{{ part.errorText }}</div>
  </div>
</template>

<style scoped>
@keyframes tool-call-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
