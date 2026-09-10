<script setup lang="ts">
/**
 * 项目进度摘要 chip（顶栏样式 D）：一行显示「done/total · 当前门 + 状态」，
 * 悬停/点击展开 G0–G4 完整门列。自由/兼容项目（无门链）退化为 muted 占位文案。
 *
 * 受控组件：stageChain 由父级从 Core 流程投影推导传入；点击门行emit
 * select-stage 联动左栏阶段视图。
 */
import { computed } from "vue";
import type { ProcessGateView } from "../../domain/process-profile.ts";
import { currentProcessGate, processProgress, PROCESS_GATE_STATUS_TEXT } from "../../domain/process-profile.ts";
import { useChipPopover } from "../../composables/use-chip-popover.ts";

const props = defineProps<{
  /** G0–G4 门链投影；null 表示当前项目没有正式阶段链。 */
  readonly stageChain: readonly ProcessGateView[] | null;
  /** 没有阶段链时的准确占位文案。 */
  readonly emptyText: string;
}>();

const emit = defineEmits<{ "select-stage": [stageId: string] }>();

const { root, open, onEnter, onLeave, toggle, close } = useChipPopover(() => props.stageChain === null);

const progress = computed(() => (props.stageChain ? processProgress(props.stageChain) : null));
const current = computed(() => currentProcessGate(props.stageChain));
const chipText = computed(() => {
  if (!progress.value) return props.emptyText;
  const base = `${progress.value.done}/${progress.value.total}`;
  return current.value ? `${base} · ${current.value.node.id} ${PROCESS_GATE_STATUS_TEXT[current.value.status]}` : base;
});

function select(stageId: string): void {
  close();
  emit("select-stage", stageId);
}
</script>

<template>
  <div ref="root" class="gchip" @mouseenter="onEnter" @mouseleave="onLeave">
    <button
      type="button"
      class="gchip-pill"
      :class="{ muted: !stageChain }"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="gchip-title">项目进度</span>
      <span class="gchip-text">{{ chipText }}</span>
      <span v-if="stageChain" class="gchip-caret" aria-hidden="true">▾</span>
    </button>

    <div v-if="open && stageChain" class="gchip-pop" role="menu">
      <h4>G0–G4 正式流程</h4>
      <div class="gchip-gates">
        <button
          v-for="entry in stageChain"
          :key="entry.node.id"
          type="button"
          class="gchip-gate"
          :data-state="entry.status"
          @click="select(entry.node.id)"
        >
          <span class="gchip-dot" />
          <span class="gchip-gate-name">{{ entry.node.id }} {{ entry.node.name }}</span>
          <span class="gchip-gate-status">{{ PROCESS_GATE_STATUS_TEXT[entry.status] }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gchip { position: relative; display: inline-flex; min-width: 0; }

.gchip-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 340px;
  padding: 3px 11px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.gchip-pill:hover { border-color: var(--accent); background: var(--accent-subtle); }
.gchip-pill.muted { color: var(--text-muted); cursor: default; }
.gchip-pill.muted:hover { border-color: var(--border-strong); background: transparent; }

.gchip-title { font-weight: 600; }
.gchip-text { overflow: hidden; text-overflow: ellipsis; color: var(--text-secondary); }
.gchip-pill.muted .gchip-text { color: var(--text-muted); }
.gchip-caret { font-size: 9px; color: var(--text-muted); }

.gchip-pop {
  position: absolute;
  top: calc(100% + 10px);
  left: 0;
  z-index: var(--z-dropdown);
  width: 320px;
  padding: 14px 16px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface-raised);
  box-shadow: 0 14px 38px var(--shadow-color);
}
.gchip-pop h4 {
  margin: 0 0 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
}

.gchip-gates { display: flex; flex-direction: column; gap: 4px; }
.gchip-gate {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.gchip-gate:hover { background: var(--surface-hover); }
.gchip-gate-name { flex: none; }
.gchip-gate-status { margin-left: auto; font-size: 11px; color: var(--text-muted); }

.gchip-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border: 2px solid var(--border-strong);
  border-radius: 50%;
}
.gchip-gate[data-state="done"] .gchip-dot { border-color: var(--state-ok); background: var(--state-ok); }
.gchip-gate[data-state="current"] .gchip-dot { border-color: var(--accent); background: var(--accent); }
.gchip-gate[data-state="gated"] .gchip-dot { border-color: var(--state-warn); background: var(--state-warn); }
.gchip-gate[data-state="failed"] .gchip-dot { border-color: var(--state-danger); background: var(--state-danger); }
.gchip-gate[data-state="current"] .gchip-gate-name,
.gchip-gate[data-state="gated"] .gchip-gate-status { color: var(--accent); }
.gchip-gate[data-state="failed"] .gchip-gate-status { color: var(--state-danger); }
</style>
