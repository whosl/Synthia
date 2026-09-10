import { describe, expect, test } from "bun:test";
import { formatToolPayload } from "../src/domain/tool-detail.ts";

describe("formatToolPayload", () => {
  test("空与空对象返回空串（不渲染区块）", () => {
    expect(formatToolPayload("")).toBe("");
    expect(formatToolPayload("   ")).toBe("");
    expect(formatToolPayload("{}")).toBe("");
  });

  test("非 JSON 原样返回（截断尾巴不保证合法）", () => {
    const raw = '{"operation":"simulate","state":"failed","errorCode":"VIVADO_SIMULATION_FAILED","inputs":[{"path":"rtl/i2c_top.v"';
    expect(formatToolPayload(raw)).toBe(raw);
  });

  test("普通 JSON 缩进序列化，短字符串保持引号", () => {
    const out = formatToolPayload('{"path":"rtl/a.v","version":2,"ok":true,"tags":[]}');
    expect(out).toContain('"path": "rtl/a.v"');
    expect(out).toContain('"version": 2');
    expect(out).toContain('"ok": true');
    expect(out).toContain('"tags": []');
  });

  test("长字符串字段走字面块：真实换行 + 缩进", () => {
    const out = formatToolPayload(
      JSON.stringify({ schema: "synthia-workspace-file.v1", content: "line1\nline2\nline3" }),
    );
    expect(out).toContain('"content": |');
    expect(out).toMatch(/ {4}line1\n {4}line2\n {4}line3/);
    expect(out).toContain('"schema": "synthia-workspace-file.v1"');
  });

  test("超长单行字符串也走字面块", () => {
    const long = "x".repeat(200);
    const out = formatToolPayload(JSON.stringify({ content: long }));
    expect(out).toContain('"content": |');
    expect(out).toContain(long);
  });

  test("双重编码：字符串里还是 JSON 时解一层", () => {
    const inner = JSON.stringify({ state: "succeeded", jobId: "job-x" });
    const out = formatToolPayload(JSON.stringify(inner));
    expect(out).toContain('"state": "succeeded"');
    expect(out).toContain('"jobId": "job-x"');
  });

  test("数组与嵌套对象逐层缩进", () => {
    const out = formatToolPayload(
      JSON.stringify({ inputs: [{ path: "a.v", registered: true }, { path: "b.v", registered: false }] }),
    );
    expect(out).toMatch(/"inputs": \[\n {4}\{\n {6}"path": "a\.v"/);
    expect(out).toContain('"registered": true');
  });
});
