/**
 * util/format-time.ts 行为测试。
 */
import { describe, expect, test } from "bun:test";
import { formatDateTime, formatTime } from "../src/util/format-time.ts";

describe("formatTime（短格式）", () => {
  test("有效 ISO → MM/DD HH:mm 结构（不断言具体钟点，测试环境 TZ 不定）", () => {
    expect(formatTime("2026-09-14T21:05:30+08:00")).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  test("无效输入原样返回", () => {
    expect(formatTime("not-a-date")).toBe("not-a-date");
  });
});

describe("formatDateTime（完整格式）", () => {
  test("有效 ISO → 含年份与时分秒（不断言具体钟点，测试环境 TZ 不定）", () => {
    const out = formatDateTime("2026-09-14T21:05:30+08:00");
    expect(out).toContain("2026");
    expect(out).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  test("null/undefined/空串 → 默认回退 —", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("")).toBe("—");
  });

  test("无效输入 → fallback（可自定义为原值）", () => {
    expect(formatDateTime("junk")).toBe("—");
    expect(formatDateTime("junk", "junk")).toBe("junk");
  });
});
