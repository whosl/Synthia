<script setup lang="ts">
/**
 * 物理实现进度卡：validate → simulate → synthesize → implement → 码流 五格
 * 进度 + 最近成功 implement 的时序摘要（WNS/TNS/WHS/约束状态/覆盖时钟），
 * 可展开查看 sta.rpt 原文（经 evidence content API 拉取）。
 *
 * 受控组件：summary 由父级拉取传入；sta.rpt 懒加载由父级注入（保持本组件
 * 不直接持有 API client，便于测试与 mock 模式降级）。
 */
import { computed, ref } from "vue";
import type { ToolSummary } from "../../api/types.ts";
import { implCells, implProgressText, timingStatusTone, formatNs, TIMING_STATUS_LABELS } from "../../domain/impl-summary.ts";

const props = defineProps<{
  summary: ToolSummary;
  /** 懒加载 sta.rpt 原文；缺省时隐藏“查看原文”入口（如 evidence 不可达）。 */
  loadStaReport?: () => Promise<string>;
}>();

const cells = computed(() => implCells(props.summary));
const progressText = computed(() => implProgressText(props.summary));
const tone = computed(() => timingStatusTone(props.summary.timing?.status ?? "unknown"));

const reportOpen = ref(false);
const reportText = ref<string | null>(null);
const reportError = ref<string | null>(null);
const reportLoading = ref(false);
async function toggleReport(): Promise<void> {
  reportOpen.value = !reportOpen.value;
  if (reportOpen.value && reportText.value === null && props.loadStaReport) {
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
</script>

<template>
  <section class="impl-card" aria-label="物理实现进度">
    <header class="impl-card-head">
      <h3>物理实现</h3>
      <span class="impl-progress-text">{{ progressText }}</span>
    </header>

    <ol class="impl-cells">
      <li v-for="cell in cells" :key="cell.key" class="impl-cell" :data-state="cell.state">
        <span class="impl-cell-dot" />
        <span class="impl-cell-label">{{ cell.label }}</span>
        <span class="impl-cell-detail">{{ cell.detail }}</span>
      </li>
    </ol>

    <div v-if="summary.timing" class="impl-timing" :data-tone="tone">
      <div class="impl-metric"><span class="impl-metric-value">{{ formatNs(summary.timing.wns) }}</span><span class="impl-metric-name">WNS (ns)</span></div>
      <div class="impl-metric"><span class="impl-metric-value">{{ formatNs(summary.timing.tns) }}</span><span class="impl-metric-name">TNS (ns)</span></div>
      <div class="impl-metric"><span class="impl-metric-value">{{ formatNs(summary.timing.whs) }}</span><span class="impl-metric-name">WHS (ns)</span></div>
      <div class="impl-metric">
        <span class="impl-metric-value impl-metric-status">{{ TIMING_STATUS_LABELS[summary.timing.status] }}</span>
        <span class="impl-metric-name">时钟：{{ summary.timing.clocks.length > 0 ? summary.timing.clocks.join("、") : "—" }}</span>
      </div>
      <button v-if="loadStaReport" class="impl-report-toggle" type="button" @click="toggleReport">
        {{ reportOpen ? "收起 sta.rpt" : "查看 sta.rpt 原文" }}
      </button>
    </div>
    <p v-else-if="summary.timingError" class="impl-timing-note">时序摘要不可得（{{ summary.timingError }}）——进度不受影响</p>
    <p v-else class="impl-timing-note">尚无成功布局布线的时序数据</p>

    <pre v-if="reportOpen" class="impl-report">{{ reportLoading ? "加载中…" : reportError ? `加载失败：${reportError}` : reportText }}</pre>
  </section>
</template>

<style scoped>
.impl-card { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.impl-card-head { display: flex; align-items: baseline; gap: 10px; }
.impl-card-head h3 { margin: 0; font-size: 12px; color: var(--text-secondary); }
.impl-progress-text { font-size: 11px; color: var(--text-primary); }

.impl-cells { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 0; padding: 0; }
.impl-cell { display: flex; flex-direction: column; gap: 2px; min-width: 86px; padding: 7px 9px; border: 1px solid var(--border); border-radius: 6px; }
.impl-cell-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-secondary); }
.impl-cell[data-state="succeeded"] .impl-cell-dot { background: var(--state-ok); }
.impl-cell[data-state="failed"] .impl-cell-dot { background: var(--state-danger); }
.impl-cell[data-state="running"] .impl-cell-dot { background: var(--state-warn); animation: impl-pulse 1.2s infinite; }
.impl-cell[data-state="succeeded"] { border-color: color-mix(in srgb, var(--state-ok) 35%, var(--border)); }
.impl-cell[data-state="failed"] { border-color: color-mix(in srgb, var(--state-danger) 35%, var(--border)); }
.impl-cell-label { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.impl-cell-detail { font-size: 10px; color: var(--text-secondary); }
@keyframes impl-pulse { 50% { opacity: 0.35; } }

.impl-timing { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; padding-top: 8px; border-top: 1px dashed var(--border); }
.impl-metric { display: flex; flex-direction: column; gap: 1px; }
.impl-metric-value { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text-primary); }
.impl-timing[data-tone="ok"] .impl-metric-value { color: var(--state-ok); }
.impl-timing[data-tone="bad"] .impl-metric-value { color: var(--state-danger); }
.impl-metric-status { font-size: 13px; }
.impl-metric-name { font-size: 10px; color: var(--text-secondary); }
.impl-report-toggle { margin-left: auto; font-size: 11px; padding: 4px 9px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface-hover); color: var(--text-primary); cursor: pointer; }
.impl-report-toggle:hover { border-color: var(--accent); color: var(--accent); }
.impl-timing-note { margin: 0; font-size: 11px; color: var(--text-secondary); }
.impl-report { max-height: 320px; overflow: auto; margin: 0; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-hover); font-size: 11px; line-height: 1.5; white-space: pre; }
</style>
