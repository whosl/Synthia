<script setup lang="ts">
/**
 * 基础下拉菜单（受控展示组件，不含业务逻辑）。
 *
 * 开合状态由父组件持有并通过 `open` prop 控制（v-model:open 惯用法），本组件
 * 只负责：定位菜单、点击外部/按 Esc 时 emit `update:open` 请求关闭。是否响应
 * 该请求由父组件决定（多数场景直接照做）。
 *
 * 用途示例：顶栏任务切换器、文件树视图切换器、编辑器版本选择器。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** 菜单相对触发器的对齐方向。 */
    align?: "start" | "end";
  }>(),
  { align: "start" },
);

const emit = defineEmits<{
  "update:open": [open: boolean];
}>();

const rootEl = ref<HTMLElement | null>(null);

function onDocPointerDown(ev: PointerEvent): void {
  if (!props.open) return;
  const el = rootEl.value;
  if (el && ev.target instanceof Node && !el.contains(ev.target)) {
    emit("update:open", false);
  }
}

function onDocKeydown(ev: KeyboardEvent): void {
  if (props.open && ev.key === "Escape") emit("update:open", false);
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerDown);
  document.addEventListener("keydown", onDocKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerDown);
  document.removeEventListener("keydown", onDocKeydown);
});
</script>

<template>
  <div ref="rootEl" class="ui-dropdown">
    <div class="ui-dropdown-trigger" @click="emit('update:open', !open)">
      <slot name="trigger" />
    </div>
    <Transition name="ui-dropdown-fade">
      <div v-if="open" class="ui-dropdown-menu" :class="`align-${align}`" role="menu">
        <slot />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.ui-dropdown {
  position: relative;
  display: inline-flex;
}

.ui-dropdown-trigger {
  display: inline-flex;
  cursor: pointer;
}

.ui-dropdown-menu {
  position: absolute;
  top: calc(100% + var(--space-1));
  z-index: var(--z-dropdown);
  min-width: 180px;
  padding: var(--space-1);
  background: var(--surface-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  box-shadow: 0 8px 24px var(--shadow-color);
}

.align-start {
  left: 0;
}

.align-end {
  right: 0;
}

.ui-dropdown-fade-enter-active,
.ui-dropdown-fade-leave-active {
  transition:
    opacity var(--duration) var(--ease-out),
    transform var(--duration) var(--ease-out);
}

.ui-dropdown-fade-enter-from,
.ui-dropdown-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
