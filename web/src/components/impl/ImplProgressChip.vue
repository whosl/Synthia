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
  <div ref="root" class="relative inline-flex min-w-0" @mouseenter="onEnter" @mouseleave="onLeave">
    <button
      type="button"
      class="inline-flex max-w-[300px] cursor-pointer items-center gap-1.5 rounded-full border border-line-strong bg-transparent px-[11px] py-[3px] text-xs whitespace-nowrap text-fg hover:border-brand hover:bg-brand-subtle"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="font-semibold">物理实现</span>
      <span class="truncate text-fg-secondary">{{ chipText }}</span>
      <span class="text-[9px] text-fg-muted" aria-hidden="true">▾</span>
    </button>

    <div
      v-if="open"
      class="absolute top-[calc(100%+10px)] left-0 z-[100] w-[380px] rounded-[10px] border border-line-strong bg-raised px-4 py-3.5 shadow-[0_14px_38px_var(--shadow-color)]"
      role="menu"
    >
      <h4 class="m-0 mb-2.5 text-[11px] font-semibold text-fg-muted">物理实现各阶段</h4>
      <div class="flex flex-col gap-1">
        <div
          v-for="action in RUN_ACTIONS"
          :key="action.key"
          class="group flex items-center gap-2 rounded-md border border-line px-2 py-1.5 data-[state=failed]:border-[color-mix(in_srgb,var(--state-danger)_35%,var(--border-subtle))] data-[state=succeeded]:border-[color-mix(in_srgb,var(--state-ok)_35%,var(--border-subtle))]"
          :data-state="cellByKey.get(action.key)?.state"
        >
          <span
            class="size-[7px] flex-none rounded-full bg-fg-muted group-data-[state=failed]:bg-danger group-data-[state=running]:animate-[ichip-pulse_1.2s_infinite] group-data-[state=running]:bg-warn group-data-[state=succeeded]:bg-ok"
          />
          <span class="flex-none text-xs font-semibold text-fg">{{ cellByKey.get(action.key)?.label }}</span>
          <span class="min-w-0 flex-1 wrap-anywhere text-[10px] text-fg-muted group-data-[state=running]:text-warn">{{ cellByKey.get(action.key)?.detail }}</span>
          <button
            type="button"
            class="flex-none cursor-pointer rounded-[5px] border border-line-strong bg-hover px-2.5 py-[3px] text-[11px] text-fg not-disabled:hover:border-brand not-disabled:hover:text-brand disabled:cursor-default disabled:opacity-55"
            :disabled="isPending(action.key) || isRunning(action.key)"
            @click="emit('run-action', action)"
          >
            {{ isPending(action.key) ? "提交中…" : isRunning(action.key) ? "运行中…" : action.label }}
          </button>
        </div>
      </div>

      <p
        v-if="runError"
        class="m-0 mt-2.5 wrap-anywhere rounded-md border border-[color-mix(in_srgb,var(--state-danger)_45%,var(--border-subtle))] px-2.5 py-2 text-[11px] text-danger"
        role="alert"
      >{{ runError }}</p>

      <div
        v-if="summary.timing"
        class="group/timing mt-2.5 flex flex-wrap items-baseline gap-3 border-t border-dashed border-line pt-2.5"
        :data-tone="tone"
      >
        <span class="text-[10px] text-fg-muted"><b class="mr-[3px] text-sm text-fg tabular-nums group-data-[tone=bad]/timing:text-danger group-data-[tone=ok]/timing:text-ok">{{ formatNs(summary.timing.wns) }}</b> WNS</span>
        <span class="text-[10px] text-fg-muted"><b class="mr-[3px] text-sm text-fg tabular-nums group-data-[tone=bad]/timing:text-danger group-data-[tone=ok]/timing:text-ok">{{ formatNs(summary.timing.tns) }}</b> TNS</span>
        <span class="text-[10px] text-fg-muted"><b class="mr-[3px] text-sm text-fg tabular-nums group-data-[tone=bad]/timing:text-danger group-data-[tone=ok]/timing:text-ok">{{ formatNs(summary.timing.whs) }}</b> WHS</span>
        <span class="text-[11px] text-fg-secondary">{{ TIMING_STATUS_LABELS[summary.timing.status] }}<template v-if="summary.timing.clocks.length > 0"> · {{ summary.timing.clocks.join("、") }}</template></span>
      </div>
      <p v-else-if="summary.timingError" class="m-0 mt-2.5 border-t border-dashed border-line pt-2.5 text-[11px] text-fg-muted">时序摘要不可得（{{ summary.timingError }}）——进度不受影响</p>
      <p v-else class="m-0 mt-2.5 border-t border-dashed border-line pt-2.5 text-[11px] text-fg-muted">尚无成功布局布线的时序数据</p>

      <button
        v-if="loadStaReport"
        type="button"
        class="mt-2.5 cursor-pointer rounded-[5px] border border-line-strong bg-hover px-2.5 py-1 text-[11px] text-fg hover:border-brand hover:text-brand"
        @click="toggleReport"
      >
        {{ reportOpen ? "收起 sta.rpt" : "查看 sta.rpt 原文" }}
      </button>
      <!-- ichip-report：未分层的全局 pre{monospace 12.5px/1.6} 规则优先级高于 Tailwind
           utilities 层，11px/1.5 只能留在 scoped（同 CodeCard 的处置）。 -->
      <pre v-if="reportOpen" class="ichip-report m-0 mt-2.5 max-h-[280px] overflow-auto rounded-md border border-line bg-hover p-2.5 whitespace-pre">{{ reportLoading ? "加载中…" : reportError ? `加载失败：${reportError}` : reportText }}</pre>
    </div>
  </div>
</template>

<style scoped>
/* 运行中圆点的脉冲关键帧：Tailwind 内置 animate-pulse 的节奏/幅度不同，保留原名。 */
@keyframes ichip-pulse {
  50% {
    opacity: 0.35;
  }
}

/* 见模板注释：全局 pre 元素规则未分层，字号/行高留给 scoped。 */
.ichip-report {
  font-size: 11px;
  line-height: 1.5;
}
</style>


