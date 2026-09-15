<script setup lang="ts">
/**
 * Agent 工具调用条（free-agent 自身发起的 tool_calls：「▸ ⚙ read_file」）。
 *
 * 与 {@link ToolCallItem} 的区别：那个是流水线阶段工具条（validate_sources /
 * simulate / synthesize / implement，来自 audit，有四态与耗时），这个是 Agent
 * 在对话轮里直接调的任意工具，只来自 SSE 实时流，三态（running/done/error）。
 * 同样不落 audit，本轮结束刷新页面不再重放。
 *
 * 单行密度：状态图标 + 工具名（带 operation 入参时追加具体操作），不带状态
 * 文字徽章；error 默认展开——工具报错是用户唯一需要立刻看到的一种，藏在折叠
 * 里等于没报。
 *
 * 入参与结果由服务端截断至 2000 字符（runtime/free-agent.ts:truncateForStream），
 * 完整内容在会话消息与运行记录里——这条只是「现在正在调什么」的实时可见性。
 */
import { computed, ref, watch } from "vue";
import type { SynthiaAgentToolPart } from "../../domain/parts.ts";
import { formatToolPayload } from "../../domain/tool-detail.ts";

const props = defineProps<{ part: SynthiaAgentToolPart }>();

const STATE_GLYPH: Record<SynthiaAgentToolPart["state"], string> = {
  running: "◐",
  done: "⚙",
  error: "⚠️",
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

/** 入参美化：能解析成 JSON 就块样式展示，否则原样（服务端截断后可能不是合法 JSON）。 */
const argsText = computed(() => formatToolPayload(props.part.args));

/** 结果美化：与入参同一格式化器——工具结果常是（可能双重编码的）JSON 字符串。 */
const resultText = computed(() => {
  if (props.part.result === null) return "";
  return formatToolPayload(props.part.result);
});

/**
 * 头部显示名：带 operation 入参的工具（vivado_run/fpga-sim-run 等）追加具体
 * 操作（「vivado_run: simulate」）。用正则而非 JSON.parse——入参可能被截断，
 * 不是合法 JSON；截断尾巴里 operation 排在前面，照样提得到。
 */
const displayName = computed(() => {
  const name = props.part.name || "工具调用";
  const raw = props.part.args.trim();
  if (!raw) return name;
  const match = raw.match(/"operation"\s*:\s*"([^"]+)"/);
  return match ? `${name}: ${match[1]}` : name;
});
</script>

<template>
  <div class="rounded-sm bg-hover" :class="part.state === 'done' ? 'opacity-72' : ''">
    <div
      class="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left text-xs leading-[1.2] text-fg-secondary"
      role="button"
      tabindex="0"
      @click="toggle"
      @keydown.enter="toggle"
      @keydown.space.prevent="toggle"
    >
      <span class="w-[10px] flex-none text-fg-muted" aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
      <span
        class="flex-none"
        :class="part.state === 'running' ? 'inline-block text-brand [animation:agent-tool-spin_1.1s_linear_infinite]' : part.state === 'error' ? 'text-danger' : ''"
        aria-hidden="true"
      >{{ STATE_GLYPH[part.state] }}</span>
      <span class="min-w-0 flex-1 truncate font-mono text-[12.5px]" :class="part.state === 'error' ? 'text-danger' : 'text-fg'">{{ displayName }}</span>
    </div>
    <div v-if="expanded" class="px-2 pb-2 pl-[22px]">
      <template v-if="argsText">
        <div class="mb-[2px] text-[11px] text-fg-muted">入参</div>
        <pre class="agent-tool-code m-0 mb-1 max-h-[240px] overflow-auto whitespace-pre-wrap break-words text-fg-secondary">{{ argsText }}</pre>
      </template>
      <template v-if="resultText">
        <div class="mb-[2px] text-[11px] text-fg-muted">结果</div>
        <pre class="agent-tool-code m-0 mb-1 max-h-[240px] overflow-auto whitespace-pre-wrap break-words text-fg-secondary">{{ resultText }}</pre>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 未分层全局 pre 规则（font/line-height）优先级高于 Tailwind utilities 层，
   工具负载的 1.4 行高留在 scoped。 */
.agent-tool-code {
  line-height: var(--line-height-list);
}

@keyframes agent-tool-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
