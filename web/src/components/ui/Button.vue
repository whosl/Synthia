<script setup lang="ts">
/**
 * 基础按钮（受控展示组件，不含业务逻辑）。
 *
 * - variant 决定视觉权重：primary（强调色实心，页面主操作，如「发送」）/
 *   secondary（描边，次操作，如「取消」）/ ghost（无边框，工具栏/顶栏图标按钮）/
 *   danger（危险操作，如「驳回」「打断」）；
 * - 原生 click 事件通过 Vue attrs 透传冒泡给父组件（无需单独声明 emit：
 *   `<Button @click="...">` 天然生效），符合「props in, 事件出」但避免重复包一层。
 */
withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "ghost" | "danger";
    size?: "sm" | "md";
    disabled?: boolean;
    /** 提交/发送进行中：显示加载态并禁用点击，避免重复提交。 */
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
</script>

<template>
  <button class="ui-button" :class="[`variant-${variant}`, `size-${size}`]" :type="type" :disabled="disabled || loading">
    <span v-if="loading" class="ui-button-spinner" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  border-radius: var(--radius);
  border: 1px solid transparent;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color var(--duration) var(--ease-out),
    border-color var(--duration) var(--ease-out),
    color var(--duration) var(--ease-out);
}

.ui-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.size-md {
  height: 30px;
  padding: 0 var(--space-3);
  font-size: var(--font-size-base);
}

.size-sm {
  height: 24px;
  padding: 0 var(--space-2);
  font-size: var(--font-size-sm);
}

.variant-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-on-accent);
}

.variant-primary:not(:disabled):hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.variant-secondary {
  background: var(--surface-panel);
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.variant-secondary:not(:disabled):hover {
  background: var(--surface-hover);
}

.variant-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-secondary);
}

.variant-ghost:not(:disabled):hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.variant-danger {
  background: transparent;
  border-color: var(--border-strong);
  color: var(--state-danger);
}

.variant-danger:not(:disabled):hover {
  background: var(--accent-subtle);
  border-color: var(--state-danger);
}

.ui-button-spinner {
  width: 12px;
  height: 12px;
  border-radius: var(--radius-full);
  border: 2px solid currentColor;
  border-top-color: transparent;
  opacity: 0.7;
  animation: ui-button-spin 700ms linear infinite;
}

@keyframes ui-button-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
