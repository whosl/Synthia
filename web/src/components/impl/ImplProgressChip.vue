<script setup lang="ts">
/**
 * 物理实现摘要 chip（顶栏样式 D）：pill 一行显示「最深到达阶段 + 计数」，
 * 点击展开六行进度（代码校验/仿真/综合/布局布线/码流/STA，每行
 * 「标签 计数 · 运行按钮」）+ 时序摘要；面板内可钉住查看 sta.rpt 原文。
 *
 * 受控组件：summary 由父级拉取传入；sta.rpt 懒加载与作业提交都由父级注入
 * /承接（本组件不直接持有 API client）。运行按钮 emit run-action，父级
 * 处理参数推导与提交，pendingKeys/runError 回传渲染反馈。
 */
import { computed, ref } from "vue";
import type { ToolSummary } from "../../api/types.ts";
import { implCells, implChipText, timingStatusTone, formatNs, TIMING_STATUS_LABELS, type ImplCell } from "../../domain/impl-summary.ts";
import type { ImplRunAction } from "../../domain/impl-run.ts";
import { useChipPopover } from "../../composables/use-chip-popover.ts";

const RUN_ACTIONS: readonly ImplRunAction[] = [
  { key: "validate", operation: "validate_sources", label: "运行校验" },
  { key: "simulate", operation: "simulate", label: "运行仿真" },
  { key: "synthesize", operation: "synthesize", label: "运行综合" },
  { key: "implement", operation: "implement", stopBeforeBitstream: true, label: "运行布局布线" },
  { key: "bitstream", operation: "implement", stopBeforeBitstream: false, label: "运行生成码流" },
  { key: "sta", operation: "report_sta", label: "运行 STA" },
];

const props = defineProps<{
  summary: ToolSummary;
  /** 懒加载 sta.rpt 原文；缺省时隐藏「查看原文」入口（如 evidence 不可达）。 */
  loadStaReport?: () => Promise<string>;
  /** 提交中/已提交未确认的行 key 集合：按钮转圈禁用。 */
  pendingKeys?: readonly string[];
  /** 上次点击的失败反馈（推导失败/提交失败）；null 隐藏。 */
  runError?: string | null;
}>();

const emit = defineEmits<{ "run-action": [action: ImplRunAction] }>();

const { root, open, onEnter, onLeave, toggle, pin } = useChipPopover();

const cells = computed(() => implCells(props.summary));
const cellByKey = computed(() => new Map(cells.value.map(cell => [cell.key, cell])));
const chipText = computed(() => implChipText(props.summary));
const tone = computed(() => timingStatusTone(props.summary.timing?.status ?? "unknown"));
const pending = computed(() => new Set(props.pendingKeys ?? []));

function isPending(key: ImplCell["key"]): boolean {
  return pending.value.has(key);
}
function isRunning(key: ImplCell["key"]): boolean {
  return cellByKey.value.get(key)?.state === "running";
}

const reportOpen = ref(false);
const reportText = ref<string | null>(null);
const reportError = ref<string | null>(null);
const reportLoading = ref(false);
async function toggleReport(): Promise<void> {
  reportOpen.value = !reportOpen.value;
  if (reportOpen.value) {
    pin(); // 读报告时移开鼠标不收起
    if (reportText.value === null && props.loadStaReport) {
      reportLoading.value = true;
      reportError.value = null;
      try {
        reportText.value = await props.loadStaReport();
      } catch (err) {
        reportError.value = err instanceof Error ? err.message : String(err);
      } finally {
        reportLoading.value = false;
      }
    }
  }
}
</script>

<template>
  <div ref="root" class="ichip" @mouseenter="onEnter" @mouseleave="onLeave">
    <button type="button" class="ichip-pill" :aria-expanded="open" @click="toggle">
      <span class="ichip-title">物理实现</span>
      <span class="ichip-text">{{ chipText }}</span>
      <span class="ichip-caret" aria-hidden="true">▾</span>
    </button>

    <div v-if="open" class="ichip-pop" role="menu">
      <h4>物理实现各阶段</h4>
      <div class="ichip-rows">
        <div v-for="action in RUN_ACTIONS" :key="action.key" class="ichip-row" :data-state="cellByKey.get(action.key)?.state">
          <span class="ichip-dot" />
          <span class="ichip-row-label">{{ cellByKey.get(action.key)?.label }}</span>
          <span class="ichip-row-detail">{{ cellByKey.get(action.key)?.detail }}</span>
          <button
            type="button"
            class="ichip-run"
            :disabled="isPending(action.key) || isRunning(action.key)"
            @click="emit('run-action', action)"
          >
            {{ isPending(action.key) ? "提交中…" : isRunning(action.key) ? "运行中…" : action.label }}
          </button>
        </div>
      </div>

      <p v-if="runError" class="ichip-run-error" role="alert">{{ runError }}</p>

      <div v-if="summary.timing" class="ichip-timing" :data-tone="tone">
        <span class="ichip-metric"><b>{{ formatNs(summary.timing.wns) }}</b> WNS</span>
        <span class="ichip-metric"><b>{{ formatNs(summary.timing.tns) }}</b> TNS</span>
        <span class="ichip-metric"><b>{{ formatNs(summary.timing.whs) }}</b> WHS</span>
        <span class="ichip-status">{{ TIMING_STATUS_LABELS[summary.timing.status] }}<template v-if="summary.timing.clocks.length > 0"> · {{ summary.timing.clocks.join("、") }}</template></span>
      </div>
      <p v-else-if="summary.timingError" class="ichip-note">时序摘要不可得（{{ summary.timingError }}）——进度不受影响</p>
      <p v-else class="ichip-note">尚无成功布局布线的时序数据</p>

      <button v-if="loadStaReport" type="button" class="ichip-report-toggle" @click="toggleReport">
        {{ reportOpen ? "收起 sta.rpt" : "查看 sta.rpt 原文" }}
      </button>
      <pre v-if="reportOpen" class="ichip-report">{{ reportLoading ? "加载中…" : reportError ? `加载失败：${reportError}` : reportText }}</pre>
    </div>
  </div>
</template>

<style scoped>
.ichip { position: relative; display: inline-flex; min-width: 0; }

.ichip-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 300px;
  padding: 3px 11px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.ichip-pill:hover { border-color: var(--accent); background: var(--accent-subtle); }
.ichip-title { font-weight: 600; }
.ichip-text { overflow: hidden; text-overflow: ellipsis; color: var(--text-secondary); }
.ichip-caret { font-size: 9px; color: var(--text-muted); }

.ichip-pop {
  position: absolute;
  top: calc(100% + 10px);
  left: 0;
  z-index: var(--z-dropdown);
  width: 380px;
  padding: 14px 16px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface-raised);
  box-shadow: 0 14px 38px var(--shadow-color);
}
.ichip-pop h4 {
  margin: 0 0 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
}

.ichip-rows { display: flex; flex-direction: column; gap: 4px; }
.ichip-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
}
.ichip-row[data-state="succeeded"] { border-color: color-mix(in srgb, var(--state-ok) 35%, var(--border-subtle)); }
.ichip-row[data-state="failed"] { border-color: color-mix(in srgb, var(--state-danger) 35%, var(--border-subtle)); }
.ichip-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); }
.ichip-row[data-state="succeeded"] .ichip-dot { background: var(--state-ok); }
.ichip-row[data-state="failed"] .ichip-dot { background: var(--state-danger); }
.ichip-row[data-state="running"] .ichip-dot { background: var(--state-warn); animation: ichip-pulse 1.2s infinite; }
@keyframes ichip-pulse { 50% { opacity: 0.35; } }
.ichip-row-label { flex: none; font-size: 12px; font-weight: 600; color: var(--text-primary); }
.ichip-row-detail { flex: 1 1 auto; min-width: 0; font-size: 10px; color: var(--text-muted); overflow-wrap: anywhere; }
.ichip-row[data-state="running"] .ichip-row-detail { color: var(--state-warn); }

.ichip-run {
  flex: none;
  padding: 3px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  background: var(--surface-hover);
  color: var(--text-primary);
  font-size: 11px;
  cursor: pointer;
}
.ichip-run:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ichip-run:disabled { opacity: 0.55; cursor: default; }

.ichip-run-error {
  margin: 10px 0 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--state-danger) 45%, var(--border-subtle));
  border-radius: 6px;
  font-size: 11px;
  color: var(--state-danger);
  overflow-wrap: anywhere;
}

.ichip-timing {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 12px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border-subtle);
}
.ichip-metric { font-size: 10px; color: var(--text-muted); }
.ichip-metric b { margin-right: 3px; font-size: 14px; font-variant-numeric: tabular-nums; color: var(--text-primary); }
.ichip-timing[data-tone="ok"] .ichip-metric b { color: var(--state-ok); }
.ichip-timing[data-tone="bad"] .ichip-metric b { color: var(--state-danger); }
.ichip-status { font-size: 11px; color: var(--text-secondary); }

.ichip-note { margin: 10px 0 0; padding-top: 10px; border-top: 1px dashed var(--border-subtle); font-size: 11px; color: var(--text-muted); }

.ichip-report-toggle {
  margin-top: 10px;
  padding: 4px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  background: var(--surface-hover);
  color: var(--text-primary);
  font-size: 11px;
  cursor: pointer;
}
.ichip-report-toggle:hover { border-color: var(--accent); color: var(--accent); }
.ichip-report {
  max-height: 280px;
  overflow: auto;
  margin: 10px 0 0;
  padding: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--surface-hover);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre;
}
</style>
