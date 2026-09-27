import type { ToolSummaryResources } from "../api/types.ts";

const DEFINITIONS = [
  { key: "lut", label: "LUT", description: "查找表" },
  { key: "ff", label: "FF", description: "触发器 / 寄存器" },
  { key: "bram", label: "BRAM", description: "块存储 · 36 Kb 等效块" },
  { key: "dsp", label: "DSP", description: "运算单元" },
  { key: "io", label: "I/O", description: "输入输出引脚" },
  { key: "clock", label: "BUFG", description: "全局时钟缓冲" },
] as const;

const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function resourcePercent(value: number | null): string {
  if (value === null) return "—";
  if (value > 0 && value < 0.01) return "<0.01%";
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}
export function resourceRows(resources: ToolSummaryResources | null | undefined) {
  return DEFINITIONS.map((definition) => {
    const metric = resources?.metrics.find((item) => item.key === definition.key);
    const used = valid(metric?.used) ? metric.used : null;
    const available = valid(metric?.available) ? metric.available : null;
    const percent = used !== null && available !== null && available > 0 ? used / available * 100 : null;
    return { ...definition, label: metric?.label ?? definition.label, sourceLabel: metric?.sourceLabel,
      used, available, percent, percentText: resourcePercent(percent),
      fill: percent === null ? 0 : Math.min(percent, 100),
      tone: percent === null ? "unknown" : percent > 100 ? "over" : percent >= 80 ? "high" : "normal",
    };
  });
}
