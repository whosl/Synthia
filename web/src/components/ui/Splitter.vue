<script setup lang="ts">
/**
 * 三栏拖拽调宽容器（受控展示组件：折叠态由外部 props 控制，宽度是纯 UI 态，
 * 组件内部持有并持久化到 localStorage——拖宽不是业务数据，不必上提给
 * ProjectView，这与契约文档里「纯本地 UI 态」的边界一致）。
 *
 * 布局：`left | center(flex:1) | right`，center 永远占满剩余空间。
 * - leftCollapsed / rightCollapsed 为 true 时，对应栏与其拖拽手柄不占布局空间
 *   （spec R3：<1024px 文件树抽屉化、<1280px 右栏浮层化时，父组件把对应栏
 *   props 传 collapsed=true，并自己在外部渲染抽屉/浮层，不复用这里的拖拽逻辑）。
 * - 宽度持久化 key：`${storageKey}.left` / `${storageKey}.right`。
 */
import { onBeforeUnmount, ref } from "vue";

const props = withDefaults(
  defineProps<{
    storageKey: string;
    leftMin?: number;
    leftMax?: number;
    leftDefault?: number;
    rightMin?: number;
    rightMax?: number;
    rightDefault?: number;
    leftCollapsed?: boolean;
    rightCollapsed?: boolean;
  }>(),
  {
    leftMin: 180,
    leftMax: 420,
    leftDefault: 240,
    rightMin: 280,
    rightMax: 560,
    rightDefault: 380,
    leftCollapsed: false,
    rightCollapsed: false,
  },
);

function readStoredWidth(key: string, min: number, max: number, fallback: number): number {
  const raw = window.localStorage.getItem(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

const leftWidth = ref(readStoredWidth(`${props.storageKey}.left`, props.leftMin, props.leftMax, props.leftDefault));
const rightWidth = ref(readStoredWidth(`${props.storageKey}.right`, props.rightMin, props.rightMax, props.rightDefault));

type DragTarget = "left" | "right" | null;
const dragging = ref<DragTarget>(null);
let dragStartX = 0;
let dragStartWidth = 0;

function beginDrag(target: "left" | "right", ev: PointerEvent): void {
  dragging.value = target;
  dragStartX = ev.clientX;
  dragStartWidth = target === "left" ? leftWidth.value : rightWidth.value;
  window.addEventListener("pointermove", onDrag);
  window.addEventListener("pointerup", endDrag, { once: true });
}

function onDrag(ev: PointerEvent): void {
  if (!dragging.value) return;
  const dx = ev.clientX - dragStartX;
  if (dragging.value === "left") {
    leftWidth.value = Math.min(props.leftMax, Math.max(props.leftMin, dragStartWidth + dx));
  } else {
    // 右栏手柄向左拖是变宽（拖拽方向与宽度变化相反）。
    rightWidth.value = Math.min(props.rightMax, Math.max(props.rightMin, dragStartWidth - dx));
  }
}

function endDrag(): void {
  if (dragging.value === "left") window.localStorage.setItem(`${props.storageKey}.left`, String(leftWidth.value));
  if (dragging.value === "right") window.localStorage.setItem(`${props.storageKey}.right`, String(rightWidth.value));
  dragging.value = null;
  window.removeEventListener("pointermove", onDrag);
}

/** 键盘可达性：手柄聚焦后用方向键微调（无需拖拽也能调宽）。 */
function onHandleKeydown(target: "left" | "right", ev: KeyboardEvent): void {
  const step = ev.shiftKey ? 40 : 8;
  let delta = 0;
  if (ev.key === "ArrowLeft") delta = target === "left" ? -step : step;
  else if (ev.key === "ArrowRight") delta = target === "left" ? step : -step;
  else return;
  ev.preventDefault();
  if (target === "left") {
    leftWidth.value = Math.min(props.leftMax, Math.max(props.leftMin, leftWidth.value + delta));
    window.localStorage.setItem(`${props.storageKey}.left`, String(leftWidth.value));
  } else {
    rightWidth.value = Math.min(props.rightMax, Math.max(props.rightMin, rightWidth.value + delta));
    window.localStorage.setItem(`${props.storageKey}.right`, String(rightWidth.value));
  }
}

onBeforeUnmount(() => {
  window.removeEventListener("pointermove", onDrag);
});
</script>

<template>
  <div class="ui-splitter">
    <div v-if="!leftCollapsed" class="pane pane-left" :style="{ width: `${leftWidth}px` }">
      <slot name="left" />
    </div>
    <div
      v-if="!leftCollapsed"
      class="handle"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      :class="{ dragging: dragging === 'left' }"
      @pointerdown="beginDrag('left', $event)"
      @keydown="onHandleKeydown('left', $event)"
    />
    <div class="pane pane-center">
      <slot name="center" />
    </div>
    <div
      v-if="!rightCollapsed"
      class="handle"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      :class="{ dragging: dragging === 'right' }"
      @pointerdown="beginDrag('right', $event)"
      @keydown="onHandleKeydown('right', $event)"
    />
    <div v-if="!rightCollapsed" class="pane pane-right" :style="{ width: `${rightWidth}px` }">
      <slot name="right" />
    </div>
  </div>
</template>

<style scoped>
.ui-splitter {
  display: flex;
  height: 100%;
  min-height: 0;
}

.pane {
  min-height: 0;
  overflow: hidden;
}

.pane-left,
.pane-right {
  flex: none;
}

.pane-center {
  flex: 1;
  min-width: 0;
}

.handle {
  flex: none;
  width: 5px;
  cursor: col-resize;
  background: transparent;
  position: relative;
}

.handle::after {
  content: "";
  position: absolute;
  inset: 0 2px;
  border-radius: var(--radius-sm);
  transition: background-color var(--duration) var(--ease-out);
}

.handle:hover::after,
.handle.dragging::after {
  background: var(--accent-subtle);
}

.handle:focus-visible {
  outline: none;
}

.handle:focus-visible::after {
  background: var(--accent-subtle);
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}
</style>
