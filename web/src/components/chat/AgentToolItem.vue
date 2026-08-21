<script setup lang="ts">
/**
 * Agent 工具调用条（free-agent 自身发起的 tool_calls：「▸ ⚙ read_file 完成」）。
 *
 * 与 {@link ToolCallItem} 的区别：那个是流水线阶段工具条（validate_sources /
 * simulate / synthesize / implement，来自 audit，有四态与耗时），这个是 Agent
 * 在对话轮里直接调的任意工具，只来自 SSE 实时流，三态（running/done/error）。
 * 同样不落 audit，本轮结束刷新页面不再重放。
 *
 * 入参与结果由服务端截断至 2000 字符（runtime/free-agent.ts:truncateForStream），
 * 完整内容在会话消息与运行记录里——这条只是「现在正在调什么」的实时可见性。
 */
import { computed, ref, watch } from "vue";
import type { SynthiaAgentToolPart } from "../../domain/parts.ts";
import Badge from "../ui/Badge.vue";

const props = defineProps<{ part: SynthiaAgentToolPart }>();

const STATE_GLYPH: Record<SynthiaAgentToolPart["state"], string> = {
  running: "◐",
  done: "⚙",
  error: "⚠️",
};

const STATE_TONE: Record<SynthiaAgentToolPart["state"], "accent" | "ok" | "danger"> = {
  running: "accent",
  done: "ok",
  error: "danger",
};

const STATE_TEXT: Record<SynthiaAgentToolPart["state"], string> = {
  running: "运行中",
  done: "完成",
  error: "失败",
};

const touched = ref(false);
// 失败默认展开：工具报错是用户唯一需要立刻看到的一种，藏在折叠里等于没报。
const expanded = ref(props.part.state === "error");

watch(
  () => props.part.state,
  (state) => {
    if (!touched.value) expanded.value = state === "error";
  },
);

function toggle(): void {
  touched.value = true;
  expanded.value = !expanded.value;
}

/** 入参美化：能解析成 JSON 就缩进展示，否则原样（服务端截断后可能不是合法 JSON）。 */
const argsText = computed(() => {
  const raw = props.part.args.trim();
  if (!raw || raw === "{}") return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
});
</script>

<template>
  <div class="agent-tool-item" :class="[`state-${part.state}`, { expanded }]">
    <div
      class="agent-tool-header"
      role="button"
      tabindex="0"
      @click="toggle"
      @keydown.enter="toggle"
      @keydown.space.prevent="toggle"
    >
      <span class="agent-tool-chevron" aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
      <span class="agent-tool-glyph" aria-hidden="true">{{ STATE_GLYPH[part.state] }}</span>
      <span class="agent-tool-name">{{ part.name || "工具调用" }}</span>
      <Badge :tone="STATE_TONE[part.state]" variant="dot" size="sm">{{ STATE_TEXT[part.state] }}</Badge>
    </div>
    <div v-if="expanded" class="agent-tool-detail">
      <template v-if="argsText">
        <div class="agent-tool-label">入参</div>
        <pre class="agent-tool-code">{{ argsText }}</pre>
      </template>
      <template v-if="part.result !== null">
        <div class="agent-tool-label">结果</div>
        <pre class="agent-tool-code">{{ part.result }}</pre>
      </template>
    </div>
  </div>
</template>

<style scoped>
.agent-tool-item {
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
}

.state-done {
  opacity: 0.72;
}

.agent-tool-header {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  text-align: left;
}

.agent-tool-chevron {
  flex: none;
  width: 10px;
  color: var(--text-muted);
}

.agent-tool-glyph {
  flex: none;
}

.state-running .agent-tool-glyph {
  color: var(--accent);
  display: inline-block;
  animation: agent-tool-spin 1.1s linear infinite;
}

.state-error .agent-tool-glyph {
  color: var(--state-danger);
}

.agent-tool-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--font-size-code);
}

.state-error .agent-tool-name {
  color: var(--state-danger);
}

.agent-tool-detail {
  padding: 0 var(--space-2) var(--space-2) calc(var(--space-2) + 14px);
}

.agent-tool-label {
  color: var(--text-muted);
  font-size: 11px;
  margin-bottom: 2px;
}

.agent-tool-code {
  margin: 0 0 var(--space-1);
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
  font-size: var(--font-size-code);
  line-height: var(--line-height-list);
  color: var(--text-secondary);
}

@keyframes agent-tool-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
