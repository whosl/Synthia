<script setup lang="ts">
/**
 * 基础提示气泡（受控展示组件，不含业务逻辑）。
 *
 * 纯 hover/focus 触发，无需父组件管理开合状态（不跨组件共享、不需要跨刷新
 * 保留，属于契约文档里说明的「纯本地 UI 态」，不必提升为 props）。用途：
 * 阶段链节点 hover 显示门编号与门名、工具栏图标按钮的文字说明等。
 */
withDefaults(
  defineProps<{
    text: string;
    placement?: "top" | "bottom" | "left" | "right";
    disabled?: boolean;
  }>(),
  { placement: "top", disabled: false },
);
</script>

<template>
  <span class="ui-tooltip-wrap">
    <slot />
    <span v-if="!disabled" class="ui-tooltip-bubble" :class="`place-${placement}`" role="tooltip">{{ text }}</span>
  </span>
</template>

<style scoped>
.ui-tooltip-wrap {
  position: relative;
  display: inline-flex;
}

.ui-tooltip-bubble {
  position: absolute;
  z-index: var(--z-tooltip);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-list);
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--duration) var(--ease-out),
    transform var(--duration) var(--ease-out);
  box-shadow: 0 4px 12px var(--shadow-color);
}

.ui-tooltip-wrap:hover .ui-tooltip-bubble,
.ui-tooltip-wrap:focus-within .ui-tooltip-bubble {
  opacity: 1;
  visibility: visible;
}

.place-top {
  bottom: calc(100% + var(--space-1));
  left: 50%;
  transform: translate(-50%, 4px);
}

.ui-tooltip-wrap:hover .place-top,
.ui-tooltip-wrap:focus-within .place-top {
  transform: translate(-50%, 0);
}

.place-bottom {
  top: calc(100% + var(--space-1));
  left: 50%;
  transform: translate(-50%, -4px);
}

.ui-tooltip-wrap:hover .place-bottom,
.ui-tooltip-wrap:focus-within .place-bottom {
  transform: translate(-50%, 0);
}

.place-left {
  right: calc(100% + var(--space-1));
  top: 50%;
  transform: translate(4px, -50%);
}

.ui-tooltip-wrap:hover .place-left,
.ui-tooltip-wrap:focus-within .place-left {
  transform: translate(0, -50%);
}

.place-right {
  left: calc(100% + var(--space-1));
  top: 50%;
  transform: translate(-4px, -50%);
}

.ui-tooltip-wrap:hover .place-right,
.ui-tooltip-wrap:focus-within .place-right {
  transform: translate(0, -50%);
}
</style>
