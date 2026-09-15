<script setup lang="ts">
/**
 * 阶段状态 chip（顶栏唯一样式）：pill 上一颗状态点 + 一行摘要
 * （当前门禁 · 物理实现最深到达），点击/悬停展开完整详情——项目信息、
 * G0–G4 门链（点击联动左栏阶段视图）、物理实现六行（含运行按钮与时序摘要）。
 *
 * 合并自旧「项目概览」与「物理实现」两个 chip：项目类型/器件是静态信息，
 * 不再占顶栏常态面积，收入弹层「项目信息」一节。
 *
 * 状态点语义（Linear 式降噪，色点即健康信号）：
 * danger=门/实现有失败；warn=实现运行中或门禁被门控；brand=有进行中的当前门；
 * ok=门链全部通过；neutral=无门链或无实现记录（自由项目/全新项目）。
 *
 * 受控组件：全部数据由父级传入；本组件不直接持有 API client
 * （sta.rpt 懒加载与作业提交都由父级注入/承接）。
 */
import { computed, ref } from "vue";
import type { ToolSummary } from "../../api/types.ts";
import type { ProcessGateView } from "../../domain/process-profile.ts";
import { currentProcessGate, processProgress, PROCESS_GATE_STATUS_TEXT } from "../../domain/process-profile.ts";
import { implCells, implChipText, implDeepestCell, timingStatusTone, formatNs, TIMING_STATUS_LABELS, type ImplCell } from "../../domain/impl-summary.ts";
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
  /** 项目信息区（类型/流程/器件），来自项目详情。 */
  readonly typeLabel: string;
  readonly profileLabel: string | null;
  readonly targetPart: string | null;
  /** G0–G4 门链投影；null 表示当前项目没有正式阶段链。 */
  readonly stageChain: readonly ProcessGateView[] | null;
  /** 没有阶段链时的准确占位文案。 */
  readonly emptyText: string;
  /** 物理实现摘要；null 表示摘要不可得（旧 Core / mock）或未拉取。 */
  readonly summary: ToolSummary | null;
  /** 懒加载 sta.rpt 原文；缺省时隐藏「查看原文」入口（如 evidence 不可达）。 */
  readonly loadStaReport?: () => Promise<string>;
  /** 提交中/已提交未确认的行 key 集合：按钮转圈禁用。 */
  readonly pendingKeys?: readonly string[];
  /** 上次点击的失败反馈（推导失败/提交失败）；null 隐藏。 */
  readonly runError?: string | null;
}>();

const emit = defineEmits<{
  "select-stage": [stageId: string];
  "run-action": [action: ImplRunAction];
}>();

const { root, open, onEnter, onLeave, toggle, pin, close } = useChipPopover();

const progress = computed(() => (props.stageChain ? processProgress(props.stageChain) : null));
const current = computed(() => currentProcessGate(props.stageChain));
const partText = computed(() => props.targetPart || "未设器件");
const deepest = computed(() => (props.summary ? implDeepestCell(props.summary) : null));

/** pill 面文案：门链当前门 + 实现最深格；两者都没有时退回项目静态信息。 */
const faceText = computed(() => {
  const parts: string[] = [];
  if (current.value) {
    parts.push(
      progress.value && progress.value.done === progress.value.total
        ? `门链 ${progress.value.done}/${progress.value.total}`
        : `${current.value.node.id} ${current.value.node.name}`,
    );
  }
  if (props.summary) parts.push(implChipText(props.summary));
  return parts.length > 0 ? parts.join(" · ") : `${props.typeLabel || "…"} · ${partText.value}`;
});

type FaceTone = "neutral" | "brand" | "ok" | "warn" | "danger";
const faceTone = computed<FaceTone>(() => {
  if (current.value?.status === "failed" || deepest.value?.state === "failed") return "danger";
  if (deepest.value?.state === "running" || current.value?.status === "gated") return "warn";
  if (current.value?.status === "current") return "brand";
  if (progress.value && progress.value.total > 0 && progress.value.done === progress.value.total) return "ok";
  return "neutral";
});
const facePulsing = computed(() => deepest.value?.state === "running");

// ─── 物理实现明细（原 ImplProgressChip 弹层内容） ──────────────────────
const cells = computed(() => (props.summary ? implCells(props.summary) : []));
const cellByKey = computed(() => new Map(cells.value.map(cell => [cell.key, cell])));
const tone = computed(() => timingStatusTone(props.summary?.timing?.status ?? "unknown"));
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

function select(stageId: string): void {
  close();
  emit("select-stage", stageId);
}
</script>

<template>
  <div ref="root" class="relative inline-flex min-w-0" @mouseenter="onEnter" @mouseleave="onLeave">
    <button
      type="button"
      class="inline-flex max-w-[380px] cursor-pointer items-center gap-1.5 rounded-full border border-line-strong bg-transparent px-[11px] py-[3px] text-xs whitespace-nowrap text-fg hover:border-brand hover:bg-brand-subtle"
      :aria-expanded="open"
      @click="toggle"
    >
      <span
        class="size-2 flex-none rounded-full"
        :class="{
          'bg-danger': faceTone === 'danger',
          'bg-warn': faceTone === 'warn',
          'bg-brand': faceTone === 'brand',
          'bg-ok': faceTone === 'ok',
          'bg-fg-muted': faceTone === 'neutral',
          'animate-[schip-pulse_1.2s_infinite]': facePulsing,
        }"
        aria-hidden="true"
      />
      <span class="truncate text-fg-secondary">{{ faceText }}</span>
      <span class="text-[9px] text-fg-muted" aria-hidden="true">▾</span>
    </button>

    <div
      v-if="open"
      class="absolute top-[calc(100%+10px)] left-0 z-[100] w-[400px] rounded-[10px] border border-line-strong bg-raised px-4 py-3.5 shadow-[0_14px_38px_var(--shadow-color)]"
      role="menu"
    >
      <h4 class="m-0 mb-2.5 text-[11px] font-semibold text-fg-muted">项目信息</h4>
      <dl class="m-0 flex flex-col gap-[5px]">
        <div class="flex gap-3 text-xs"><dt class="w-[30px] flex-none text-fg-muted">类型</dt><dd class="m-0 wrap-anywhere text-fg">{{ typeLabel }}</dd></div>
        <div v-if="profileLabel" class="flex gap-3 text-xs"><dt class="w-[30px] flex-none text-fg-muted">流程</dt><dd class="m-0 wrap-anywhere text-fg">{{ profileLabel }}</dd></div>
        <div class="flex gap-3 text-xs"><dt class="w-[30px] flex-none text-fg-muted">器件</dt><dd class="m-0 wrap-anywhere text-fg">{{ partText }}</dd></div>
      </dl>

      <h4 class="m-0 mt-3.5 mb-2.5 border-t border-dashed border-line pt-3 text-[11px] font-semibold text-fg-muted">工程流程</h4>
      <div v-if="stageChain" class="flex flex-col gap-1">
        <button
          v-for="entry in stageChain"
          :key="entry.node.id"
          type="button"
          class="group flex w-full cursor-pointer items-center gap-[9px] rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-xs text-fg hover:bg-hover"
          :data-state="entry.status"
          @click="select(entry.node.id)"
        >
          <span
            class="size-2 flex-none rounded-full border-2 border-line-strong group-data-[state=current]:border-brand group-data-[state=current]:bg-brand group-data-[state=done]:border-ok group-data-[state=done]:bg-ok group-data-[state=failed]:border-danger group-data-[state=failed]:bg-danger group-data-[state=gated]:border-warn group-data-[state=gated]:bg-warn"
          />
          <span class="flex-none tabular-nums group-data-[state=current]:text-brand">{{ entry.node.id }} {{ entry.node.name }}</span>
          <span class="ml-auto text-[11px] text-fg-muted group-data-[state=failed]:text-danger group-data-[state=gated]:text-brand">{{ PROCESS_GATE_STATUS_TEXT[entry.status] }}</span>
        </button>
      </div>
      <p v-else class="m-0 text-xs text-fg-muted">{{ emptyText }}</p>

      <template v-if="summary">
        <h4 class="m-0 mt-3.5 mb-2.5 border-t border-dashed border-line pt-3 text-[11px] font-semibold text-fg-muted">物理实现</h4>
        <div class="flex flex-col gap-1">
          <div
            v-for="action in RUN_ACTIONS"
            :key="action.key"
            class="group flex items-center gap-2 rounded-md border border-line px-2 py-1.5 data-[state=failed]:border-[color-mix(in_srgb,var(--state-danger)_35%,var(--border-subtle))] data-[state=succeeded]:border-[color-mix(in_srgb,var(--state-ok)_35%,var(--border-subtle))]"
            :data-state="cellByKey.get(action.key)?.state"
          >
            <span
              class="size-[7px] flex-none rounded-full bg-fg-muted group-data-[state=failed]:bg-danger group-data-[state=running]:animate-[schip-pulse_1.2s_infinite] group-data-[state=running]:bg-warn group-data-[state=succeeded]:bg-ok"
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
        <!-- schip-report：未分层的全局 pre{monospace 12.5px/1.6} 规则优先级高于 Tailwind
             utilities 层，11px/1.5 只能留在 scoped（同 CodeCard 的处置）。 -->
        <pre v-if="reportOpen" class="schip-report m-0 mt-2.5 max-h-[280px] overflow-auto rounded-md border border-line bg-hover p-2.5 whitespace-pre">{{ reportLoading ? "加载中…" : reportError ? `加载失败：${reportError}` : reportText }}</pre>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 运行中圆点的脉冲关键帧：Tailwind 内置 animate-pulse 的节奏/幅度不同，保留原名节奏。 */
@keyframes schip-pulse {
  50% {
    opacity: 0.35;
  }
}

/* 见模板注释：全局 pre 元素规则未分层，字号/行高留给 scoped。 */
.schip-report {
  font-size: 11px;
  line-height: 1.5;
}
</style>
