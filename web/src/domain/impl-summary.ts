/**
 * 物理实现进度卡的展示语义（纯函数，供 ImplProgressCard 与测试使用）。
 *
 * 五格进度条 = validate → simulate → synthesize → implement → 码流。
 * 状态归约：never/running/succeeded/failed 四类；码流格独立于 implement 格
 * （formal 流 stopBeforeBitstream=false 才会有 synthia.bit）。
 */
import type { ToolSummary, ToolSummaryStage } from "../api/types.ts";

export type ImplCellState = "never" | "running" | "succeeded" | "failed";

export interface ImplCell {
  readonly key: "validate" | "simulate" | "synthesize" | "implement" | "bitstream";
  readonly label: string;
  readonly state: ImplCellState;
  readonly detail: string;
}

const STAGE_LABELS: Record<ToolSummaryStage["operation"], { key: ImplCell["key"]; label: string }> = {
  validate_sources: { key: "validate", label: "源校验" },
  simulate: { key: "simulate", label: "仿真" },
  synthesize: { key: "synthesize", label: "综合" },
  implement: { key: "implement", label: "布局布线" },
};

function stageCell(stage: ToolSummaryStage): ImplCell {
  const meta = STAGE_LABELS[stage.operation];
  const counts = `${stage.succeeded}✓/${stage.failed}✗`;
  const detail = stage.state === "never" ? "未运行" : counts;
  return { key: meta.key, label: meta.label, state: stage.state as ImplCellState, detail };
}

export function implCells(summary: ToolSummary): ImplCell[] {
  const byKey = new Map(summary.stages.map(stage => [STAGE_LABELS[stage.operation].key, stageCell(stage)]));
  const order: ImplCell["key"][] = ["validate", "simulate", "synthesize", "implement", "bitstream"];
  const bit: ImplCell = summary.bitstream.generated
    ? { key: "bitstream", label: "码流", state: "succeeded", detail: "synthia.bit 已产出" }
    : { key: "bitstream", label: "码流", state: summary.stages.some(s => s.state !== "never") ? "failed" : "never", detail: "未生成（探索流 stopBeforeBitstream）" };
  // 缺失的阶段（接口向前兼容/构造部分数据）按 never 展示。
  return order.map(key => {
    if (key === "bitstream") return bit;
    return byKey.get(key) ?? { key, label: Object.values(STAGE_LABELS).find(m => m.key === key)!.label, state: "never" as const, detail: "未运行" };
  });
}

/** 全流程推进到的最深一格（用于一句话概览）。 */
export function implProgressText(summary: ToolSummary): string {
  const cells = implCells(summary);
  const passed = cells.filter(cell => cell.state === "succeeded");
  if (passed.length === 0) return "尚未开始物理实现";
  if (cells.every(cell => cell.state === "succeeded")) return "全流程通过（含码流）";
  const last = passed[passed.length - 1]!;
  return `推进到：${last.label}`;
}

/** 时序大数字的着色语义：违例红、达标绿、未知灰。 */
export function timingStatusTone(status: ToolSummaryTimingStatus): "ok" | "bad" | "muted" {
  return status === "met" ? "ok" : status === "failed" ? "bad" : "muted";
}
type ToolSummaryTimingStatus = "met" | "failed" | "unconstrained" | "unknown";

/** ns 值展示（带符号、最多 3 位小数）。 */
export function formatNs(value: number | null): string {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${Number(value.toFixed(3))}`;
}

export const TIMING_STATUS_LABELS: Record<ToolSummaryTimingStatus, string> = {
  met: "时序达标",
  failed: "时序违例",
  unconstrained: "未约束",
  unknown: "未知",
};
