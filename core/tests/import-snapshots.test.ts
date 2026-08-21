import { describe, expect, test } from "bun:test";
import {
  copyImportSnapshotHandler,
  createImportSnapshotHandler,
  denyImportSnapshotHandler,
  confirmImportSnapshotHandler,
  IMPORT_SNAPSHOT_LIMITS,
  canonicalSourceHash,
  isSensitiveImportPath,
  normalizeImportPath,
  normalizeProvidedFiles,
  preflightProjectTree,
  resolveImportArtifactType,
} from "../src/api/import-handlers.ts";
import { sha256Hex } from "../src/hashing.ts";
import type { RequestContext } from "../src/api/handlers.ts";

describe("P2 import snapshot input safety", () => {
  test("normalizes a UTF-8 manifest and derives stable ids and source hash", () => {
    const files = normalizeProvidedFiles([
      { path: "rtl/z.v", content: "module z; endmodule\n", media_type: "text/x-verilog" },
      { path: "doc/a.md", content: "# A\n" },
    ], "imp_safe");
    expect(files.map((file) => file.id)).toEqual(["imp_safe_file_1", "imp_safe_file_2"]);
    expect(files[0]!.contentHash).toBe(sha256Hex("module z; endmodule\n"));
    expect(files[0]!.sizeBytes).toBe(Buffer.byteLength("module z; endmodule\n"));
    expect(canonicalSourceHash(files)).toBe(canonicalSourceHash([...files].reverse()));
  });

  test("rejects traversal, platform paths, controls, simulation output and secrets", () => {
    for (const path of [
      "../outside.v",
      "rtl/../outside.v",
      "/etc/passwd",
      "C:/secret.txt",
      "rtl\\outside.v",
      "rtl//bad.v",
      "rtl/\0bad.v",
      "sim/run.log",
      ".env",
      "cfg/.env.production",
      "keys/id_ed25519",
      "keys/device.pem",
      "cfg/private-key.txt",
    ]) {
      expect(() => normalizeProvidedFiles([{ path, content: "x" }], "imp_bad")).toThrow();
    }
    expect(normalizeImportPath("./rtl/ok.v")).toBe("rtl/ok.v");
    expect(isSensitiveImportPath("certs/device.p12")).toBe(true);
  });

  test("rejects client ids, binary/base64, invalid entries and duplicate paths", () => {
    for (const file of [
      { id: "chosen", path: "rtl/a.v", content: "a" },
      { file_id: "chosen", path: "rtl/a.v", content: "a" },
      { path: "rtl/a.v", content_base64: "YQ==" },
      { path: "rtl/a.v", bytes: [97] },
      { path: "rtl/a.v", content: "a", valid: false },
    ]) {
      expect(() => normalizeProvidedFiles([file], "imp_bad_shape")).toThrow();
    }
    expect(() => normalizeProvidedFiles([
      { path: "rtl/a.v", content: "a" },
      { path: "rtl/a.v", content: "b" },
    ], "imp_duplicate")).toThrow();
  });

  test("enforces file count, per-file bytes and aggregate expanded bytes", () => {
    expect(() => normalizeProvidedFiles(
      Array.from({ length: IMPORT_SNAPSHOT_LIMITS.maxFiles + 1 }, (_, index) => ({
        path: `doc/${index}.md`,
        content: "x",
      })),
      "imp_count",
    )).toThrow();

    expect(() => normalizeProvidedFiles([{
      path: "doc/large.md",
      content: "x".repeat(IMPORT_SNAPSHOT_LIMITS.maxFileBytes + 1),
    }], "imp_file_size")).toThrow();

    const oneMiB = "x".repeat(IMPORT_SNAPSHOT_LIMITS.maxFileBytes);
    expect(() => normalizeProvidedFiles(
      Array.from({ length: 17 }, (_, index) => ({ path: `doc/${index}.md`, content: oneMiB })),
      "imp_total_size",
    )).toThrow();
  });

  test("verifies client content hashes", () => {
    expect(() => normalizeProvidedFiles([{
      path: "rtl/a.v",
      content: "module a; endmodule\n",
      content_hash: sha256Hex("different"),
    }], "imp_hash")).toThrow("content_hash does not match");
  });

  test("preflights project Git tree limits before blob reads", () => {
    const blob = (path: string, sizeBytes = 1) => ({ path, sizeBytes, objectType: "blob" as const });
    expect(() => preflightProjectTree([
      blob(".gitignore", 10),
      blob("sim/.gitkeep", 0),
      ...Array.from({ length: IMPORT_SNAPSHOT_LIMITS.maxFiles }, (_, index) => blob(`doc/${index}.md`)),
    ])).not.toThrow();
    expect(() => preflightProjectTree(
      Array.from({ length: IMPORT_SNAPSHOT_LIMITS.maxFiles + 1 }, (_, index) => blob(`doc/${index}.md`)),
    )).toThrow("exceeds 500 files");
    expect(() => preflightProjectTree([
      blob("doc/large.md", IMPORT_SNAPSHOT_LIMITS.maxFileBytes + 1),
    ])).toThrow("file exceeds");
    expect(() => preflightProjectTree(
      Array.from({ length: 17 }, (_, index) => blob(`doc/${index}.md`, IMPORT_SNAPSHOT_LIMITS.maxFileBytes)),
    )).toThrow("total bytes");
    expect(() => preflightProjectTree([blob("sim/wave.vcd")])).toThrow("simulation output");
    expect(() => preflightProjectTree([blob("keys/id_ed25519")])).toThrow("sensitive file");
    expect(() => preflightProjectTree([{ path: "vendor/submodule", sizeBytes: null, objectType: "commit" }])).toThrow("unsupported tree entry");
  });

  test("defaults copied material to KNOWLEDGE_ENTRY and rejects unknown artifact types", () => {
    expect(resolveImportArtifactType(undefined)).toBe("KNOWLEDGE_ENTRY");
    expect(resolveImportArtifactType(null)).toBe("KNOWLEDGE_ENTRY");
    expect(resolveImportArtifactType("RTL_SOURCE_SET")).toBe("RTL_SOURCE_SET");
    for (const invalid of ["HISTORICAL_MATERIAL", "", "rtl_source_set", 7]) {
      expect(() => resolveImportArtifactType(invalid)).toThrow("recognized ArtifactType");
    }
  });

  test("all historical-material write handlers fail closed when the feature is off", async () => {
    const context = {
      pool: { query: () => { throw new Error("database must not be reached"); } },
      identity: {
        actorType: "human",
        actorId: "tester",
        userId: "user_tester",
        scopes: ["core:read", "core:write", "core:approve"],
      },
      method: "POST",
      url: new URL("http://core.test/api/v1/projects/p_test/import-snapshots/imp_test/copy"),
      request: new Request("http://core.test/api/v1/projects/p_test/import-snapshots/imp_test/copy", { method: "POST" }),
      params: { projectId: "p_test", snapshotId: "imp_test" },
      body: {},
      correlationId: "corr_test",
      idempotencyKey: "idem_test",
      classification: "D1",
      featureFlags: { historicalMaterials: false },
    } as unknown as RequestContext;

    for (const handler of [
      createImportSnapshotHandler,
      confirmImportSnapshotHandler,
      denyImportSnapshotHandler,
      copyImportSnapshotHandler,
    ]) {
      await expect(handler(context)).rejects.toMatchObject({
        code: "capability_unavailable",
        httpStatus: 503,
        retryable: true,
        details: { feature: "historical_materials" },
      });
    }
  });
});
