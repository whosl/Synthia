<script setup lang="ts">
/**
 * 应用按钮（ui/button 的项目化封装，替代已删除的手写 ui/Button.vue）。
 *
 * 保留旧组件的 props 契约（variant: primary/secondary/ghost/danger，size: sm/md，
 * loading），内部映射到 shadcn Button 的 variant 并用 Tailwind 类还原旧视觉：
 * - primary → default（bg-primary = --accent），hover 走 --accent-hover；
 * - secondary/danger 基于 ghost 加描边（避开 outline variant 自带的 dark: 底色覆盖），
 *   danger 的文字/描边用 --state-danger、hover 底色 --accent-subtle；
 * - loading 时前置 LoaderCircle 旋转图标并禁用点击（旧组件的自转 spinner 语义）。
 */
import { computed } from "vue";
import { LoaderCircle } from "lucide-vue-next";
import { Button } from "@/components/ui/button";

const props = withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "ghost" | "danger";
    size?: "sm" | "md";
    disabled?: boolean;
    loading?: boolean;
    type?: "button" | "submit";
  }>(),
  {
    variant: "secondary",
    size: "md",
    disabled: false,
    loading: false,
    type: "button",
  },
);

const shadcnVariant = computed<"default" | "ghost">(() => (props.variant === "primary" ? "default" : "ghost"));

const toneClass = computed(() => {
  switch (props.variant) {
    case "primary":
      return "hover:bg-brand-hover";
    case "secondary":
      return "border border-line-strong bg-panel text-fg";
    case "danger":
      return "border border-line-strong text-danger hover:border-danger hover:bg-brand-subtle hover:text-danger";
    case "ghost":
      return "text-fg-secondary hover:text-fg";
  }
});

const sizeClass = computed(() =>
  props.size === "sm" ? "h-6 gap-1 px-2 text-xs font-normal" : "h-[30px] px-3 text-[13px] font-normal",
);
</script>

<template>
  <Button
    :variant="shadcnVariant"
    :class="[toneClass, sizeClass]"
    :type="type"
    :disabled="disabled || loading"
  >
    <LoaderCircle v-if="loading" class="size-3 animate-spin" aria-hidden="true" />
    <slot />
  </Button>
</template>
