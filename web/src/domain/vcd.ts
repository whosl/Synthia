/** Bounded digital VCD reader. Unknown values and capture limits are never hidden. */
export const MAX_VCD_BYTES = 8 * 1024 * 1024;
export interface VcdChange { time: number; value: string; }
export interface VcdSignal { id: string; name: string; width: number; type: string; changes: VcdChange[]; }
export interface VcdData { signals: VcdSignal[]; endTime: number; timescale: number; unit: string; warnings: string[]; }
export function parseVcd(text: string): VcdData {
  if (text.length > MAX_VCD_BYTES || new TextEncoder().encode(text).length > MAX_VCD_BYTES) throw new Error("波形超过 8 MiB 查看上限");
  const signals: VcdSignal[] = [], scopes: string[] = [], byId = new Map<string, VcdChange[]>();
  const warnings = new Set<string>();
  const tokens = /\S+/g;
  const next = (): string | undefined => tokens.exec(text)?.[0];
  function block(): string[] {
    const words: string[] = [];
    for (let t = next(); t !== undefined; t = next()) {
      if (t === "$end") return words;
      words.push(t);
    }
    throw new Error("VCD 指令不完整，文件可能被截断");
  }
  let time = 0, count = 0, definitions = false, timescale = 1, unit = "", stopped = false;
  for (let token = next(); token !== undefined; token = next()) {
    if (token === "$scope") { const b = block(); if (!b[1]) throw new Error("VCD 层级声明无效"); scopes.push(b[1]); }
    else if (token === "$upscope") { block(); scopes.pop(); }
    else if (token === "$var") {
      const b = block(), width = Number(b[1]), id = b[2];
      if (!id || !b[3] || !Number.isInteger(width) || width < 1 || width > 4096) throw new Error("VCD 信号声明无效或位宽超过 4096");
      if (signals.length >= 4096) throw new Error("信号超过 4096 个，请缩小采集范围");
      const changes = byId.get(id) ?? []; byId.set(id, changes);
      signals.push({ id, name: [...scopes, b.slice(3).join("")].join("."), width, type: b[0]!, changes });
    } else if (token === "$timescale") {
      const match = block().join("").match(/^(1|10|100)(s|ms|us|ns|ps|fs)$/);
      if (!match) throw new Error("VCD 时间单位无效"); timescale = Number(match[1]); unit = match[2]!;
    } else if (token === "$enddefinitions") { block(); definitions = true; }
    else if (token === "$comment") {
      const comment = block().join(" ");
      if (/limit|truncat|dump.*stop/i.test(comment)) { warnings.add("采集达到大小上限，仅显示已记录的时间范围。"); stopped = true; }
    } else if (["$dumpvars", "$dumpall", "$dumpon", "$dumpoff", "$end"].includes(token)) {
      if (token === "$dumpoff") warnings.add("此文件曾暂停采集，暂停区间不能作为完整仿真证据。");
    } else if (token.startsWith("$")) block();
    else if (token.startsWith("#")) {
      if (!/^#\d+$/.test(token)) throw new Error("VCD 时间戳无效");
      const value = Number(token.slice(1));
      if (!Number.isSafeInteger(value) || value < time) throw new Error("VCD 时间戳超出精度或时间顺序无效");
      if (!stopped) time = value;
    } else {
      if (!definitions) throw new Error("缺少 VCD 信号定义");
      let id: string | undefined, value: string;
      if (/^[bBrR]/.test(token)) { value = token.slice(1).toLowerCase(); id = next(); }
      else if (/^[01xXzZ]/.test(token)) { value = token[0]!.toLowerCase(); id = token.slice(1); }
      else throw new Error("包含暂不支持的 VCD 数据类型");
      if (!id || !byId.has(id) || !value || (!/^[01xz]+$/.test(value) && !/^[rR]/.test(token))) throw new Error("VCD 信号值无效或数据被截断");
      if (stopped) continue;
      const changes = byId.get(id)!;
      if (++count > 500_000) throw new Error("波形变化超过 50 万条，请缩短采集窗口");
      if (changes.at(-1)?.time === time) changes[changes.length - 1] = { time, value };
      else if (changes.at(-1)?.value !== value) changes.push({ time, value });
    }
  }
  if (!definitions || !signals.length || !count) throw new Error("文件没有可查看的 VCD 信号数据");
  if (!unit) { unit = "tick"; warnings.add("文件未声明时间单位，时间轴按 tick 显示。"); }
  return { signals, endTime: time, timescale, unit, warnings: [...warnings] };
}
/** Index of last value at or before time, including a same-time update. */
export function changeIndex(changes: readonly VcdChange[], time: number): number {
  let low = 0, high = changes.length;
  while (low < high) { const mid = (low + high) >>> 1; if (changes[mid]!.time <= time) low = mid + 1; else high = mid; }
  return low - 1;
}
export function signalValue(signal: VcdSignal, time: number, radix: "hex" | "bin" | "dec"): string {
  const raw = signal.changes[changeIndex(signal.changes, time)]?.value;
  if (raw === undefined) return "—";
  if (signal.type === "real" || signal.type === "realtime") return raw;
  const value = raw.padStart(signal.width, /^[xz]/.test(raw) ? raw[0] : "0");
  if (radix === "bin" || /[xz]/.test(value)) return value;
  return BigInt(`0b${value}`).toString(radix === "hex" ? 16 : 10).toUpperCase();
}
