<script setup lang="ts">
/**
 * 物理实现摘要 chip（顶栏样式 D）：一行显示「最深到达阶段 + 计数」，悬停/点击
 * 展开五格进度 + 时序摘要；面板内可钉住查看 sta.rpt 原文（evidence content API）。
 *
 * 受控组件：summary 由父级拉取传入；sta.rpt 懒加载由父级注入（保持本组件
 * 不直接持有 API client，便于测试与 mock 模式降级）。
 */
import { computed, ref } from "vue";
import type { ToolSummary } from "../../api/types.ts";
import { implCells, implChipText, timingStatusTone, formatNs, TIMING_STATUS_LABELS } from "../../domain/impl-summary.ts";
import { useChipPopover } from "../../composables/use-chip-popover.ts";

const props = defineProps<{
  summary: ToolSummary;
  /** 懒加载 sta.rpt 原文；缺省时隐藏「查看原文」入口（如 evidence 不可达）。 */
  loadStaReport?: () => Promise<string>;
}>();

const { root, open, onEnter, onLeave, toggle, pin } = useChipPopover();

const cells = computed(() => implCells(props.summary));
const chipText = computed(() => implChipText(props.summary));
const tone = computed(() => timingStatusTone(props.summary.timing?.status ?? "unknown"));

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
      <h4>物理实现五阶段</h4>
      <div class="ichip-cells">
        <div v-for="cell in cells" :key="cell.key" class="ichip-cell" :data-state="cell.state">
          <span class="ichip-dot" />
          <span class="ichip-cell-label">{{ cell.label }}</span>
          <span class="ichip-cell-detail">{{ cell.detail }}</span>
        </div>
      </div>

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

.ichip-cells { display: flex; gap: 6px; }
.ichip-cell {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
}
.ichip-cell[data-state="succeeded"] { border-color: color-mix(in srgb, var(--state-ok) 35%, var(--border-subtle)); }
.ichip-cell[data-state="failed"] { border-color: color-mix(in srgb, var(--state-danger) 35%, var(--border-subtle)); }
.ichip-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); }
.ichip-cell[data-state="succeeded"] .ichip-dot { background: var(--state-ok); }
.ichip-cell[data-state="failed"] .ichip-dot { background: var(--state-danger); }
.ichip-cell[data-state="running"] .ichip-dot { background: var(--state-warn); animation: ichip-pulse 1.2s infinite; }
@keyframes ichip-pulse { 50% { opacity: 0.35; } }
.ichip-cell-label { font-size: 11px; font-weight: 600; color: var(--text-primary); }
.ichip-cell-detail { font-size: 9px; color: var(--text-muted); overflow-wrap: anywhere; }
.ichip-cell:last-child { flex: 1.5; }

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
