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
  <div class="tool-call-item" :class="[`status-${part.status}`, { expandable, expanded }]">
    <div
      class="tool-call-header"
      :class="{ 'no-toggle': !expandable }"
      role="button"
      tabindex="0"
      @click="toggle"
      @keydown.enter="toggle"
      @keydown.space.prevent="toggle"
    >
      <span class="tool-call-chevron" aria-hidden="true">{{ expandable ? (expanded ? "▾" : "▸") : "·" }}</span>
      <span class="tool-call-glyph" aria-hidden="true">{{ STATUS_GLYPH[part.status] }}</span>
      <span class="tool-call-title">{{ part.title }}</span>
      <Badge :tone="STATUS_TONE[part.status]" variant="dot" size="sm">{{ TOOL_STATUS_TEXT[part.status] }}</Badge>
      <span v-if="durationText" class="tool-call-duration">{{ durationText }}</span>
      <button v-if="part.jobId" type="button" class="tool-call-records" @click.stop="onOpenRecords">运行记录</button>
    </div>
    <div v-if="expandable && expanded" class="tool-call-detail">{{ part.errorText }}</div>
  </div>
</template>

<style scoped>
.tool-call-item {
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
}

.status-completed {
  opacity: 0.72;
}

.tool-call-header {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
  text-align: left;
}

.tool-call-header.no-toggle {
  cursor: default;
}

.tool-call-chevron {
  flex: none;
  width: 10px;
  color: var(--text-muted);
}

.tool-call-glyph {
  flex: none;
}

.status-running .tool-call-glyph {
  color: var(--accent);
  animation: tool-call-spin 1.1s linear infinite;
  display: inline-block;
}

.status-error .tool-call-glyph {
  color: var(--state-danger);
}

.tool-call-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.status-error .tool-call-title {
  color: var(--state-danger);
}

.tool-call-duration {
  flex: none;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
}

.tool-call-detail {
  padding: 0 var(--space-2) var(--space-2) calc(var(--space-2) + 18px);
  color: var(--state-danger);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-list);
}

.tool-call-records {
  flex: none;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  padding: 0;
}

.tool-call-records:hover {
  color: var(--accent);
}

@keyframes tool-call-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
