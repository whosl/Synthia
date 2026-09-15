/**
 * 物理实现进度的展示语义（纯函数，供 StageStatusChip 与测试使用）。
 *
 * 弹层行 = validate → simulate → synthesize → implement → 码流 → STA。
 * 状态归约：never/running/succeeded/failed 四类；码流格独立于 implement 格
 * （探索流 stopBeforeBitstream=false 才会有 synthia.bit）；STA 是独立
 * 报告操作（report_sta），不进「最深到达阶段」的管线归纳。
 */

import type { ToolSummary, ToolSummaryStage } from "../api/types.ts";

export type ImplCellState = "never" | "running" | "succeeded" | "failed";

export interface ImplCell {
  readonly key: "validate" | "simulate" | "synthesize" | "implement" | "bitstream" | "sta";
  readonly label: string;
  readonly state: ImplCellState;
  readonly detail: string;
}

export const STAGE_LABELS: Record<ToolSummaryStage["operation"], { key: ImplCell["key"]; label: string }> = {
  validate_sources: { key: "validate", label: "代码校验" },
  simulate: { key: "simulate", label: "仿真" },
  synthesize: { key: "synthesize", label: "综合" },
  implement: { key: "implement", label: "布局布线" },
  report_sta: { key: "sta", label: "STA" },
};

/** 管线进度（最深到达）只归纳这五格；STA 是附属报告操作，不参与。 */
const PIPELINE_KEYS: readonly ImplCell["key"][] = ["validate", "simulate", "synthesize", "implement", "bitstream"];

function stageCell(stage: ToolSummaryStage): ImplCell {
  const meta = STAGE_LABELS[stage.operation];
  const counts = `${stage.succeeded}✓/${stage.failed}✗`;
  const detail = stage.state === "never" ? "未运行" : counts;
  return { key: meta.key, label: meta.label, state: stage.state as ImplCellState, detail };
}

export function implCells(summary: ToolSummary): ImplCell[] {
  const byKey = new Map(summary.stages.map(stage => [STAGE_LABELS[stage.operation].key, stageCell(stage)]));
  const order: ImplCell["key"][] = [...PIPELINE_KEYS, "sta"];
  const bit: ImplCell = summary.bitstream.generated
    ? { key: "bitstream", label: "码流", state: "succeeded", detail: "synthia.bit 已产出" }
    : { key: "bitstream", label: "码流", state: "never", detail: "未生成" };
  // 缺失的阶段（接口向前兼容/构造部分数据）按 never 展示。
  return order.map(key => {
    if (key === "bitstream") return bit;
    if (key === "sta") {
      return byKey.get("sta") ?? { key: "sta", label: "STA", state: "never" as const, detail: "未运行" };
    }
    return byKey.get(key) ?? { key, label: Object.values(STAGE_LABELS).find(m => m.key === key)!.label, state: "never" as const, detail: "未运行" };
  });
}

/** 全流程推进到的最深一格（用于一句话概览）。 */
export function implProgressText(summary: ToolSummary): string {
  const cells = implCells(summary).filter(cell => PIPELINE_KEYS.includes(cell.key));
  const passed = cells.filter(cell => cell.state === "succeeded");
  if (passed.length === 0) return "尚未开始物理实现";
  if (cells.every(cell => cell.state === "succeeded")) return "全流程通过（含码流）";
  const last = passed[passed.length - 1]!;
  return `推进到：${last.label}`;
}

/**
 * 顶栏摘要 chip 的一行文案：最深到达格 + 计数（如「布局布线 4✓」「仿真 4✗」）。
 * 未产出码流（探索流）不算「到达」，避免把合成失败态误报为当前阶段。
 */
/** 管线最深到达格；全部未运行时为 null。chip 文案与 face 状态点共用同一归约。 */
export function implDeepestCell(summary: ToolSummary): ImplCell | null {
  const cells = implCells(summary).filter(cell => PIPELINE_KEYS.includes(cell.key));
  return [...cells]
    .reverse()
    .find(cell => cell.state !== "never" && (cell.key !== "bitstream" || cell.state === "succeeded")) ?? null;
}

export function implChipText(summary: ToolSummary): string {
  const current = implDeepestCell(summary);
  if (!current) return "未开始";
  if (current.state === "running") return `${current.label} · 运行中`;
  if (current.state === "succeeded") {
    return current.key === "bitstream" ? `${current.label} ✓` : `${current.label} ${current.detail.split("/")[0]}`;
  }
  return `${current.label} ${current.detail.split("/")[1] ?? "✗"}`;
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
