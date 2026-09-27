/** Parse device totals from Vivado report_utilization, never a guessed part table. */
export interface ResourceMetric {
  readonly key: "lut" | "ff" | "bram" | "dsp" | "io" | "clock";
  readonly label: string;
  readonly sourceLabel: string;
  readonly used: number;
  readonly available: number | null;
  readonly percent: number | null;
}

export interface ResourceUtilization {
  readonly device: string | null;
  readonly design: string | null;
  readonly metrics: readonly ResourceMetric[];
}

const RESOURCES: readonly { key: ResourceMetric["key"]; label: string; aliases: readonly string[] }[] = [
  { key: "lut", label: "LUT", aliases: ["Slice LUTs", "CLB LUTs"] },
  { key: "ff", label: "FF", aliases: ["Register as Flip Flop", "CLB Registers", "Slice Registers"] },
  { key: "bram", label: "BRAM", aliases: ["Block RAM Tile"] },
  { key: "dsp", label: "DSP", aliases: ["DSPs", "DSP48E1", "DSP48E2", "DSP Blocks"] },
  { key: "io", label: "I/O", aliases: ["Bonded IOB", "Bonded IOBs"] },
  { key: "clock", label: "BUFG", aliases: ["BUFGCTRL", "BUFGCE", "BUFG"] },
];

function numberCell(raw: string | undefined): number | null {
  if (!raw || !/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(raw)) return null;
  const value = Number(raw.replaceAll(",", ""));
  return Number.isFinite(value) ? value : null;
}

export function parseResourceUtilization(text: string): ResourceUtilization {
  const rows = new Map<string, { used: number; available: number | null }>();
  let header: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.includes("Used")) {
      header = cells.includes("Available") && (cells[0] === "Site Type" || cells[0] === "Resource") ? cells : null;
      continue;
    }
    if (!header) continue;
    const label = (cells[0] ?? "").replace(/[\s*]+$/, "");
    const used = numberCell(cells[header.indexOf("Used")]);
    const available = numberCell(cells[header.indexOf("Available")]);
    if (used !== null && !rows.has(label)) rows.set(label, { used, available });
  }
  const metrics: ResourceMetric[] = [];
  for (const resource of RESOURCES) {
    const sourceLabel = resource.aliases.find((alias) => rows.has(alias));
    if (!sourceLabel) continue;
    const row = rows.get(sourceLabel)!;
    // FF subrows sometimes omit the total; the enclosing register bank supplies it.
    const available = row.available ?? (sourceLabel === "Register as Flip Flop"
      ? rows.get("CLB Registers")?.available ?? rows.get("Slice Registers")?.available ?? null : null);
    metrics.push({
      key: resource.key,
      label: resource.key === "ff" && sourceLabel !== "Register as Flip Flop" ? "FF / 寄存器" : resource.label,
      sourceLabel,
      used: row.used,
      available,
      percent: available !== null && available > 0 ? row.used / available * 100 : null,
    });
  }
  return {
    device: text.match(/^\s*\|?\s*Device\s*:\s*([^\s|]+)/mi)?.[1] ?? null,
    design: text.match(/^\s*\|?\s*Design\s*:\s*([^\s|]+)/mi)?.[1] ?? null,
    metrics,
  };
}
