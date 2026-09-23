import type { ToolSummary } from "../api/types.ts";

export type OverviewState = "unknown" | "idle" | "running" | "passed" | "failed" | "stopped";

const STAGES = [
  { key: "validate_sources", label: "代码检查", description: "检查设计源码，发现语法与编译问题。", short: "CHECK" },
  { key: "simulate", label: "功能仿真", description: "通过测试平台检验设计的实际行为。", short: "SIMULATE" },
  { key: "synthesize", label: "逻辑综合", description: "将设计转换为器件可实现的逻辑电路。", short: "SYNTHESIZE" },
  { key: "implement", label: "布局布线", description: "在目标器件上完成布局、布线与物理实现。", short: "IMPLEMENT" },
] as const;

export const OVERVIEW_STATE_LABELS: Record<OverviewState, string> = {
  unknown: "暂无数据",
  idle: "尚未运行",
  running: "执行中",
  passed: "已通过",
  failed: "需处理",
  stopped: "已停止",
};

export function overviewState(state: string): OverviewState {
  if (state === "succeeded") return "passed";
  if (["submitted", "queued", "preparing", "running", "cancelling"].includes(state)) return "running";
  if (["failed", "timeout", "lost", "unknown_effect", "rejected"].includes(state)) return "failed";
  if (state === "cancelled") return "stopped";
  if (state === "never") return "idle";
  return "unknown";
}

/** Each node describes its latest run, never a same-revision acceptance claim. */
export function overviewStages(summary: ToolSummary | null) {
  return STAGES.map((definition) => {
    const stage = summary?.stages.find((item) => item.operation === definition.key);
    return {
      ...definition,
      state: stage ? overviewState(stage.state) : summary ? "idle" as const : "unknown" as const,
      succeeded: stage?.succeeded ?? 0,
      failed: stage?.failed ?? 0,
      jobId: stage?.lastJobId ?? null,
      at: stage?.lastAt ?? null,
    };
  });
}
