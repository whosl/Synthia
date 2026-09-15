import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const PINS = [
  ["scripts/invoke-m4f-jump-local-receiver-representation-diagnostic-08.ts", "f1f4f2b439914d5bbfb4d6ff44d410ee559d739564fab89f213992f875258893"],
  ["m4f-jump-local-receiver-representation-diagnostic-08.test.ts", "3fe51d0a372ba317eb004ae6e4e62af037c8819ab42df8362efaa546a9097d91"],
  ["scripts/invoke-m4f-jump-local-receiver-representation-parse-gate-08.ts", "dc362b06e366b2907e6d3e19501a6c6bc766e273124bc0eb1751367e91ac87ea"],
  ["m4f-jump-local-receiver-representation-parse-gate-08.test.ts", "f4e88ec95c47b62a5c033fc636cf5152f709403c5647f0e99f69ecadea0432a5"],
  ["scripts/m4f-bound-jump-transport.ts", "ef3c4e7c7b2e4c51ccb69eb3f1b9b2113b82a595264f209cd18980dd1e56b6d9"],
] as const;

describe("M4-F frozen _08 predecessor regression", () => {
  test("keeps all four _08 source/test files and the legacy transport byte-exact", () => {
    for (const [path, expected] of PINS) {
      const bytes = readFileSync(new URL(path, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
    }
  });
});
