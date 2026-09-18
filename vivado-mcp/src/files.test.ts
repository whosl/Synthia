import { describe, expect, test } from "bun:test";
import { assertSafeRelativePath, assertWorkspaceId, truncateMiddle } from "./files.ts";

describe("assertWorkspaceId", () => {
  test("accepts portable single-segment ids", () => {
    expect(() => assertWorkspaceId("ws-001")).not.toThrow();
    expect(() => assertWorkspaceId("demo")).not.toThrow();
    expect(() => assertWorkspaceId("a")).not.toThrow();
    expect(() => assertWorkspaceId("A9._-z")).not.toThrow();
  });

  test("rejects traversal, separators, and reserved names", () => {
    for (const id of ["", ".", "..", "../x", "a/b", "a\\b", "/abs", "\\abs", "CON", "com1", "nul", "ws.", "ws ", "ws x", "-lead", "包含中文", `x`.repeat(65)]) {
      expect(() => assertWorkspaceId(id)).toThrow("VIVADO_MCP_INVALID_WORKSPACE");
    }
  });
});

describe("assertSafeRelativePath", () => {
  test("accepts multi-segment relative paths", () => {
    for (const path of ["a.rpt", "output/stdout.log", "input/sub/dir/file.dcp", "run.tcl"]) {
      expect(() => assertSafeRelativePath(path)).not.toThrow();
    }
  });

  test("rejects absolute, traversal, and unsafe segments", () => {
    for (const path of ["", "/abs.rpt", "C:/x.rpt", "../escape.rpt", "a/../b.rpt", "a//b.rpt", "a/./b.rpt", "bad|name.rpt", "trailing.", "con"]) {
      expect(() => assertSafeRelativePath(path)).toThrow("VIVADO_MCP_INVALID_PATH");
    }
  });
});

describe("truncateMiddle", () => {
  test("returns input unchanged when within budget", () => {
    const result = truncateMiddle("hello", 1024);
    expect(result.text).toBe("hello");
    expect(result.truncatedBytes).toBe(0);
  });

  test("keeps head and tail with a marker when oversized", () => {
    const text = `head-${"x".repeat(4000)}-tail`;
    const maxBytes = 1024;
    const result = truncateMiddle(text, maxBytes);
    expect(result.truncatedBytes).toBe(Buffer.byteLength(text, "utf8") - maxBytes);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(result.text.startsWith("head-")).toBe(true);
    expect(result.text.endsWith("-tail")).toBe(true);
    expect(result.text).toContain("truncated");
  });
});
