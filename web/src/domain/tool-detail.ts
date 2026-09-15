/**
 * 工具调用入参/结果的展示格式化。
 *
 * 两层尝试：先 JSON.parse（结果常是 JSON 字符串，且可能双重编码——字符串里
 * 还是 JSON），解析成功则用块样式序列化；失败则原样返回（服务端/事件侧截断
 * 过的尾巴本来就不保证是合法 JSON）。
 *
 * 块样式序列化与 JSON.stringify(…, null, 2) 的唯一差别在长字符串：嵌入的
 * 文件正文（workspace_read 的 content、fpga-tb-write 的源码入参）在标准
 * JSON 里是带 \n 转义的单行巨串，横向滚到天荒地老；这里对含换行或超长的
 * 字符串改用 YAML 字面块（`"content": |` + 真实换行 + 缩进），代码体可读。
 * 输出是给人看的展示格式，不保证可解析回原值。
 */

/** 触发块样式的字符串阈值：含真实换行，或单行超过该长度。 */
const BLOCK_MIN_LENGTH = 120;

function isLongText(value: string): boolean {
  return value.includes("\n") || value.length >= BLOCK_MIN_LENGTH;
}

function pad(depth: number): string {
  return "  ".repeat(depth);
}

function stringifyValue(value: unknown, depth: number): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    if (!isLongText(value)) return JSON.stringify(value);
    const lines = value.split("\n");
    return `|\n${lines.map((line) => `${pad(depth + 1)}${line}`).join("\n")}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = value.map((item) => `${pad(depth + 1)}${stringifyValue(item, depth + 1)}`).join(",\n");
    return `[\n${inner}\n${pad(depth)}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const inner = entries
      .map(([key, item]) => `${pad(depth + 1)}${JSON.stringify(key)}: ${stringifyValue(item, depth + 1)}`)
      .join(",\n");
    return `{\n${inner}\n${pad(depth)}}`;
  }
  return JSON.stringify(value);
}

/** 解析一层「字符串里还是 JSON」的双重编码（工具结果常见形态）。 */
function parseMaybeDoubleEncoded(raw: string): unknown {
  const first = JSON.parse(raw) as unknown;
  if (typeof first === "string") {
    const trimmed = first.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return first;
      }
    }
  }
  return first;
}

/** 展示格式化：能解析就块样式序列化，不能就原样（截断内容）。 */
export function formatToolPayload(raw: string): string {
  const text = raw.trim();
  if (!text || text === "{}") return "";
  try {
    return stringifyValue(parseMaybeDoubleEncoded(text), 0);
  } catch {
    return text;
  }
}
