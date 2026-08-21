import { describe, expect, test } from "bun:test";
import type { HistoricalMaterialFile, HistoricalMaterialSnapshot } from "../src/api/types.ts";
import {
  canCopyMaterial,
  DEFAULT_HISTORICAL_COPY_ARTIFACT_TYPE,
  HISTORICAL_COPY_ARTIFACT_TYPES,
  HISTORICAL_STATUS_TEXT,
  isHistoricalCopyArtifactType,
  isSafeMaterialPath,
  isSearchableSnapshot,
  parseMaterialImportPayload,
  selectedMaterialFiles,
} from "../src/domain/historical-materials.ts";
import {
  parseExplicitFeatureFlag,
  shouldShowHistoricalMaterials,
} from "../src/domain/feature-flags.ts";

function snapshot(overrides: Partial<HistoricalMaterialSnapshot> = {}): HistoricalMaterialSnapshot {
  return {
    id: "snap-1",
    snapshot_id: "snap-1",
    project_id: "p1",
    source_kind: "local_directory",
    source_project_id: null,
    source_name: "旧项目资料",
    source_hash: "sha256:abc",
    source_commit: null,
    commit: null,
    status: "pending_confirmation",
    valid: true,
    searchable: false,
    expires_at: null,
    files: [],
    created_at: "2026-08-21T00:00:00Z",
    confirmed_at: null,
    denied_at: null,
    denial_reason: null,
    failure_reason: null,
    ...overrides,
  };
}

function file(id: string, path: string): HistoricalMaterialFile {
  return {
    id,
    file_id: id,
    snapshot_id: "snap-1",
    path,
    bytes: 3,
    size_bytes: 3,
    content_hash: `hash-${id}`,
    media_type: "text/plain",
    valid: true,
    searchable: true,
    created_at: "2026-08-21T00:00:00Z",
  };
}

describe("P2 historical materials domain", () => {
  test("only confirmed and valid searchable snapshots can enter default context", () => {
    expect(isSearchableSnapshot(snapshot())).toBe(false);
    expect(isSearchableSnapshot(snapshot({ status: "confirmed", searchable: false }))).toBe(false);
    expect(isSearchableSnapshot(snapshot({ status: "confirmed", searchable: true, valid: false }))).toBe(false);
    expect(isSearchableSnapshot(snapshot({ status: "confirmed", searchable: true }))).toBe(true);
    expect(canCopyMaterial(snapshot({ status: "denied", searchable: true }))).toBe(false);
  });

  test("parses complete import payload and rejects unsafe paths", () => {
    const parsed = parseMaterialImportPayload(JSON.stringify({
      source_kind: "project",
      source_project_id: "source-p1",
      source_name: "历史 PWM",
      files: [
        { path: "rtl/pwm.v", content: "module pwm; endmodule", media_type: "text/plain" },
      ],
    }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.source_kind).toBe("project");
      expect(parsed.request.files?.[0]).toMatchObject({ path: "rtl/pwm.v", content: "module pwm; endmodule" });
    }

    expect(parseMaterialImportPayload(JSON.stringify({ files: [{ path: "../secret.txt", content: "x" }] }))).toMatchObject({
      ok: false,
    });
    expect(parseMaterialImportPayload(JSON.stringify({ source_kind: "project", files: [{ path: "rtl/a.v", content: "x" }] }))).toMatchObject({
      ok: false,
    });
    expect(parseMaterialImportPayload(JSON.stringify({ source_kind: "project", source_project_id: "source", commit: "not-a-commit", files: [{ path: "rtl/a.v", content: "x" }] }))).toMatchObject({ ok: false });
    expect(parseMaterialImportPayload(JSON.stringify({ source_kind: "local_directory", source_project_id: "source", files: [{ path: "rtl/a.v", content: "x" }] }))).toMatchObject({ ok: false });
    expect(parseMaterialImportPayload(JSON.stringify({ source_kind: "zip", source_hash: "sha256:fake", files: [{ path: "rtl/a.v", content: "x" }] }))).toMatchObject({ ok: false });
  });

  test("project source may delegate files to Core while local and zip remain explicit", () => {
    const parsed = parseMaterialImportPayload(JSON.stringify({
      source_kind: "project",
      source_project_id: "legacy-p1",
      commit: "a".repeat(40),
    }));
    expect(parsed).toEqual({
      ok: true,
      request: {
        source_kind: "project",
        source_project_id: "legacy-p1",
        commit: "a".repeat(40),
      },
    });
    expect(parseMaterialImportPayload(JSON.stringify({ source_kind: "project", source_project_id: "legacy-p1", files: [] }))).toMatchObject({ ok: false });
    expect(parseMaterialImportPayload(JSON.stringify({ source_kind: "local_directory" }))).toMatchObject({ ok: false });
    expect(parseMaterialImportPayload(JSON.stringify({ source_kind: "zip" }))).toMatchObject({ ok: false });
  });

  test("rejects malformed JSON, duplicate paths, and sensitive files", () => {
    expect(parseMaterialImportPayload("not-json")).toMatchObject({ ok: false });
    expect(parseMaterialImportPayload(JSON.stringify({ files: [
      { path: "a.v", content: "x" },
      { path: "a.v", content: "y" },
    ] }))).toMatchObject({ ok: false });
    for (const path of [
      ".env",
      ".env.production",
      "certs/device.pem",
      "keys/id_rsa",
      "keys/id_ed25519",
      "ssh/known_hosts",
      "config/private_key.txt",
      "config/access_token.json",
      "C:/absolute.v",
      "/absolute.v",
      "a/../b.v",
      "rtl\\win.v",
      "sim/wave.vcd",
      "rtl/line\nbreak.v",
      "rtl/delete\u007f.v",
      `${"a".repeat(513)}.v`,
      `${Array.from({ length: 33 }, () => "a").join("/")}.v`,
    ]) {
      expect(isSafeMaterialPath(path), path).toBe(false);
    }
    expect(isSafeMaterialPath("./rtl/top.v")).toBe(true);
    expect(parseMaterialImportPayload(JSON.stringify({ files: [{ path: "./rtl/top.v", content: "x" }] }))).toMatchObject({
      ok: true,
      request: { files: [{ path: "rtl/top.v", content: "x" }] },
    });
  });

  test("enforces the same 500 files, 1 MiB per file, and 16 MiB total limits as Core", () => {
    const tooMany = Array.from({ length: 501 }, (_, index) => ({ path: `doc/${index}.md`, content: "x" }));
    expect(parseMaterialImportPayload(JSON.stringify({ files: tooMany }))).toMatchObject({ ok: false });

    const tooLarge = "x".repeat(1024 * 1024 + 1);
    expect(parseMaterialImportPayload(JSON.stringify({ files: [{ path: "doc/large.md", content: tooLarge }] }))).toMatchObject({ ok: false });

    const oneMiB = "x".repeat(1024 * 1024);
    const totalTooLarge = Array.from({ length: 17 }, (_, index) => ({ path: `doc/chunk-${index}.md`, content: oneMiB }));
    expect(parseMaterialImportPayload(JSON.stringify({ files: totalTooLarge }))).toMatchObject({ ok: false });
  });

  test("selected files preserve source order and filter unsafe paths", () => {
    const files = [
      file("f1", "rtl/a.v"),
      file("f2", "../bad.v"),
      file("f3", "doc/readme.md"),
      { ...file("f4", "doc/invalid.md"), valid: false },
      { ...file("f5", "doc/unsearchable.md"), searchable: false },
    ];
    expect(selectedMaterialFiles(files, new Set(files.map((entry) => entry.id))).map((entry) => entry.id)).toEqual(["f1", "f3"]);
  });

  test("status labels expose every fail-closed state", () => {
    expect(HISTORICAL_STATUS_TEXT).toEqual({
      pending_confirmation: "待确认",
      confirmed: "已确认",
      denied: "已否决",
      failed: "导入失败",
      expired: "已过期",
    });
  });

  test("copy artifact type defaults to a Core-recognized constrained option", () => {
    expect(DEFAULT_HISTORICAL_COPY_ARTIFACT_TYPE).toBe("KNOWLEDGE_ENTRY");
    expect(HISTORICAL_COPY_ARTIFACT_TYPES.map((option) => option.value)).toContain("KNOWLEDGE_ENTRY");
    expect(HISTORICAL_COPY_ARTIFACT_TYPES.every((option) => isHistoricalCopyArtifactType(option.value))).toBe(true);
    expect(isHistoricalCopyArtifactType("HISTORICAL_MATERIAL")).toBe(false);
  });

  test("historical materials feature requires explicit opt-in and an engineering project", () => {
    expect(parseExplicitFeatureFlag("1")).toBe(true);
    for (const value of [undefined, null, "", "0", "true", "TRUE", true, 1]) {
      expect(parseExplicitFeatureFlag(value), String(value)).toBe(false);
    }
    expect(shouldShowHistoricalMaterials(true, "engineering")).toBe(true);
    expect(shouldShowHistoricalMaterials(true, "free")).toBe(false);
    expect(shouldShowHistoricalMaterials(false, "engineering")).toBe(false);
    expect(shouldShowHistoricalMaterials(true, undefined)).toBe(false);
  });
});
