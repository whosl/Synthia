import type { TaskContextUsage } from "../api/types.ts";

/** Keep historical measurements separate from an in-flight request's estimate. */
export function contextUsageDisplay(usage: TaskContextUsage) {
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const measured = valid(usage.prompt_tokens) ? usage.prompt_tokens : null;
  const estimate = valid(usage.estimated_prompt_tokens) ? usage.estimated_prompt_tokens : null;
  const state = usage.request_state;
  const currentMeasured = state === "measured" && measured !== null;
  const value = currentMeasured ? measured : estimate;
  const window = valid(usage.context_window) && usage.context_window > 0 ? usage.context_window : null;
  const ratio = value !== null && window !== null ? value / window : null;
  const lines: string[] = [];
  const labels: Record<string, string> = {
    idle: "尚无请求", preparing: "正在准备上下文", pending: "本次请求等待模型回报",
    measured: "最近完成请求的实测输入", unreported: "请求已完成，模型未回报用量",
    failed: "本次请求失败", restored: "历史记录，尚未取得本次请求用量",
  };
  lines.push(labels[state ?? "restored"] ?? labels.restored!);
  if (value !== null) {
    lines.push(`${currentMeasured ? "实测输入" : "本次请求输入估算"}：${value.toLocaleString()}${window === null ? "" : ` / ${window.toLocaleString()}`} tokens${ratio === null ? "" : `（${Math.round(ratio * 100)}%）`}`);
  } else {
    lines.push("当前请求水位未知");
  }
  if (!currentMeasured && measured !== null) lines.push(`上次记录输入：${measured.toLocaleString()} tokens（不代表当前水位）`);
  if (window !== null) lines.push(`窗口：${window.toLocaleString()} tokens · ${usage.window_source === "configured" ? "部署配置值" : usage.window_source === "default" ? "默认预算，未核实模型上限" : "来源未知，旧版未提供"}`);
  if (estimate !== null && !currentMeasured) lines.push("估算按请求字符数计算，包含工具定义及参数，不是模型实测");
  if (usage.compaction_state === "running") lines.push("正在生成上下文摘要");
  if (usage.compaction_state === "applied") lines.push("已应用摘要或截断，估算基于压缩后的请求");
  if (usage.compaction_state === "failed") lines.push("摘要更新失败，沿用已有摘要与截断策略");
  if (usage.failure === "rate_limit") lines.push("请求受到上游额度或速率限制，尚无新实测用量");
  if (usage.failure === "context_limit") lines.push("请求超过上下文预算，需缩小输入或核对窗口配置");
  if (usage.failure === "request_failed") lines.push("请求未成功取得新的用量回报");
  if (usage.measured_at && Number.isFinite(Date.parse(usage.measured_at))) lines.push(`上次实测时间：${new Date(usage.measured_at).toLocaleString()}`);
  return {
    title: lines.join("\n"),
    // Only the ring drawing is capped. The tooltip retains e.g. 221%.
    fill: ratio === null ? 0 : Math.min(1, ratio),
    tone: ratio === null ? "unknown" : ratio >= .7 ? "high" : ratio >= .4 ? "mid" : "low",
  };
}
