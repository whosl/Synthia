<script setup lang="ts">
/**
 * 应用徽章（ui/badge 的项目化封装，替代已删除的手写 ui/Badge.vue）。
 *
 * 保留旧组件的 props 契约（tone × variant × size），内部用 Tailwind 类还原旧视觉：
 * - soft（默认）：浅底胶囊——neutral 用 --surface-hover，accent 用 --accent-subtle，
 *   ok/warn/danger/info 用对应 state 色的 15% 透明底（旧实现为 color-mix 16%）；
 * - solid：实心底，文字用 --text-on-accent（text-primary-foreground）；
 * - dot：不渲染胶囊，文案前加 6px 语气色圆点，圆点与文字同色（与旧 CSS 一致，
 *   见文件树状态点 / 阶段链节点 / 任务切换器行）。
 */
import { computed } from "vue";
import { Badge } from "@/components/ui/badge";

type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info";

const props = withDefaults(
  defineProps<{
    tone?: Tone;
    variant?: "soft" | "solid" | "dot";
    size?: "sm" | "md";
  }>(),
  {
    tone: "neutral",
    variant: "soft",
    size: "md",
  },
);

const SOFT_TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-hover text-fg-secondary",
  accent: "bg-brand-subtle text-brand",
  ok: "bg-ok/15 text-ok",
  warn: "bg-warn/15 text-warn",
  danger: "bg-danger/15 text-danger",
  info: "bg-info/15 text-info",
};

const SOLID_TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-line-strong text-fg",
  accent: "bg-brand text-primary-foreground",
  ok: "bg-ok text-primary-foreground",
  warn: "bg-warn text-primary-foreground",
  danger: "bg-danger text-primary-foreground",
  info: "bg-info text-primary-foreground",
};

const DOT_TONE_CLASS: Record<Tone, string> = {
  neutral: "text-fg-muted",
  accent: "text-brand",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  info: "text-info",
};

const toneClass = computed(() => {
  if (props.variant === "dot") return `border-transparent bg-transparent px-0 py-0 ${DOT_TONE_CLASS[props.tone]}`;
  const map = props.variant === "solid" ? SOLID_TONE_CLASS : SOFT_TONE_CLASS;
  return `border-transparent font-normal ${map[props.tone]}`;
});

const sizeClass = computed(() => (props.size === "sm" ? "px-1 py-0 text-[11px]" : ""));
</script>

<template>
  <Badge :class="[toneClass, sizeClass]">
    <span v-if="variant === 'dot'" class="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
    <slot />
  </Badge>
</template>
