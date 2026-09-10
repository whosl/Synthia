/**
 * 顶栏摘要 chip 的悬浮面板开关。
 *
 * 交互约定（样式候选 D）：悬停即开、离开即关；点击 chip 钉住（可移开鼠标
 * 阅读面板内容），点外部或 Escape 解除钉住。disabled() 为真（如自由项目
 * 没有门链）时整组交互不可用。
 */
import { computed, onBeforeUnmount, ref, type Ref } from "vue";

export function useChipPopover(disabled: () => boolean = () => false): {
  root: Ref<HTMLElement | null>;
  open: Ref<boolean>;
  pinned: Ref<boolean>;
  onEnter: () => void;
  onLeave: () => void;
  toggle: () => void;
  pin: () => void;
  close: () => void;
} {
  const hovered = ref(false);
  const pinned = ref(false);
  const root = ref<HTMLElement | null>(null);
  const open = computed(() => hovered.value || pinned.value);

  function onEnter(): void {
    if (!disabled()) hovered.value = true;
  }
  function onLeave(): void {
    hovered.value = false;
  }
  function toggle(): void {
    if (!disabled()) pinned.value = !pinned.value;
  }
  function pin(): void {
    if (!disabled()) pinned.value = true;
  }
  function close(): void {
    hovered.value = false;
    pinned.value = false;
  }
  function onDocClick(event: MouseEvent): void {
    if (pinned.value && root.value && !root.value.contains(event.target as Node)) pinned.value = false;
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") close();
  }
  window.addEventListener("click", onDocClick);
  window.addEventListener("keydown", onKey);
  onBeforeUnmount(() => {
    window.removeEventListener("click", onDocClick);
    window.removeEventListener("keydown", onKey);
  });

  return { root, open, pinned, onEnter, onLeave, toggle, pin, close };
}
