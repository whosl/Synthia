import { describe, expect, test } from "bun:test";
import { resolveJobPart, validatePartPolicy } from "./part-policy.ts";

describe("per-job device policy", () => {
  test("any accepts distinct concrete parts without replacing them", () => {
    expect(resolveJobPart("any", { part: "xc7k70tfbv676-1" })).toBe("xc7k70tfbv676-1");
    expect(resolveJobPart("any", { part: "xc7k160tffg676-2" })).toBe("xc7k160tffg676-2");
    for (const part of [undefined, "", "any", "ANY", "x;exec"]) expect(() => resolveJobPart("any", { part })).toThrow("PART_REQUIRED");
  });
  test("lists, legacy singles and toolchain bindings remain enforced", () => {
    expect(resolveJobPart(["part-a", "part-b"], { part: "part-b" })).toBe("part-b");
    expect(() => resolveJobPart("part-a", { part: "part-b" })).toThrow("PART_NOT_ALLOWED");
    expect(() => resolveJobPart("any", { part: "part-a", toolchain: { part: "part-b" } })).toThrow("FORMAL_BINDING_MISMATCH");
    for (const policy of [[], ["any"], ["part-a", "part-a"], null, 42]) expect(() => validatePartPolicy(policy)).toThrow();
    expect(validatePartPolicy("any")).toBe("any");
  });
});
