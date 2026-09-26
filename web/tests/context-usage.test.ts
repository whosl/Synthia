import { describe, expect, test } from "bun:test";
import { contextUsageDisplay } from "../src/domain/context-usage.ts";

describe("context usage presentation", () => {
  test("actual overage is 221%, only ring fill is capped", () => {
    const d = contextUsageDisplay({ prompt_tokens: 442242, context_window: 200000, request_state: "measured", window_source: "default" });
    expect(d.title).toContain("221%");
    expect(d.title).toContain("默认预算，未核实模型上限");
    expect(d.fill).toBe(1);
  });
  test("compacted estimate replaces stale sample during pending and failed requests", () => {
    for (const state of ["pending", "failed"] as const) {
      const d = contextUsageDisplay({ prompt_tokens: 442242, estimated_prompt_tokens: 25000, context_window: 200000, request_state: state, compaction_state: "failed", failure: state === "failed" ? "rate_limit" : null });
      expect(d.fill).toBe(.125);
      expect(d.title).toContain("本次请求输入估算：25,000");
      expect(d.title).toContain("442,242 tokens（不代表当前水位）");
      expect(d.title).toContain("摘要更新失败");
      if (state === "failed") expect(d.title).toContain("额度或速率限制");
    }
  });
  test("old runtime and restored sessions show unknown current usage", () => {
    for (const state of [undefined, "restored", "preparing"] as const) {
      const d = contextUsageDisplay({ prompt_tokens: 442242, context_window: 200000, request_state: state });
      expect(d.tone).toBe("unknown");
      expect(d.title).toContain("当前请求水位未知");
      expect(d.title).not.toContain("221%");
    }
  });
  test("missing usage remains an estimate; invalid numbers never render NaN", () => {
    const d = contextUsageDisplay({ prompt_tokens: 442242, estimated_prompt_tokens: 1234, context_window: 200000, request_state: "unreported" });
    expect(d.title).toContain("模型未回报用量");
    expect(d.title).toContain("本次请求输入估算");
    const invalid = contextUsageDisplay({ prompt_tokens: NaN, estimated_prompt_tokens: -10, context_window: Infinity });
    expect(invalid.tone).toBe("unknown");
    expect(invalid.title).not.toMatch(/NaN|Infinity/);
  });
});
