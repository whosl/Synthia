<script setup lang="ts">
/**
 * 上下文水位环（会话当前输入规模 / 窗口）。
 *
 * 数据来自 runtime 的实测 usage（promptTokens）；网关还没回报过时显示空环。
 * 窗口未配置（0）时不渲染。水位过 70%（压缩触发线）环变色提醒。
 */
import { computed } from "vue";

const props = defineProps<{
  promptTokens: number | null;
  contextWindow: number;
}>();

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const ratio = computed(() => {
  if (props.promptTokens === null || props.contextWindow <= 0) return null;
  return Math.min(1, props.promptTokens / props.contextWindow);
});

const dashOffset = computed(() => {
  if (ratio.value === null) return CIRCUMFERENCE;
  return CIRCUMFERENCE * (1 - ratio.value);
});

const toneClass = computed(() => {
  if (ratio.value === null) return "unknown";
  if (ratio.value >= 0.7) return "high";
  if (ratio.value >= 0.4) return "mid";
  return "low";
});

const title = computed(() => {
  if (ratio.value === null) return "上下文水位：等待网关回报";
  const used = props.promptTokens ?? 0;
  const pct = Math.round(ratio.value * 100);
  return `上下文水位：${used.toLocaleString()} / ${props.contextWindow.toLocaleString()} tokens（${pct}%）`;
});
</script>

<template>
  <span v-if="contextWindow > 0" class="context-ring" :class="toneClass" :title="title" aria-hidden="true">
    <svg width="18" height="18" viewBox="0 0 18 18">
      <circle class="ring-track" cx="9" cy="9" :r="RADIUS" fill="none" stroke-width="2.5" />
      <circle
        class="ring-fill"
        cx="9"
        cy="9"
        :r="RADIUS"
        fill="none"
        stroke-width="2.5"
        :stroke-dasharray="CIRCUMFERENCE"
        :stroke-dashoffset="dashOffset"
      />
    </svg>
  </span>
</template>

<style scoped>
.context-ring {
  display: inline-flex;
  align-items: center;
  cursor: default;
}

.ring-track {
  stroke: var(--border, #d8cfc4);
}

.ring-fill {
  transform: rotate(-90deg);
  transform-origin: center;
  transition: stroke-dashoffset 0.4s ease;
}

.low .ring-fill {
  stroke: var(--state-ok, #3f7d3a);
}

.mid .ring-fill {
  stroke: var(--accent, #c2571b);
}

.high .ring-fill {
  stroke: var(--state-danger, #b3352c);
}

.unknown .ring-fill {
  stroke: var(--text-muted, #8a837a);
}
</style>
