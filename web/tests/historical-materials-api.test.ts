import { describe, expect, test } from "bun:test";
import { createClient } from "../src/api/client.ts";
import {
  confirmImportSnapshot,
  copyHistoricalMaterial,
  createImportSnapshot,
  createProject,
  denyImportSnapshot,
  getImportSnapshot,
  getRevisionContent,
  listArtifacts,
  listImportSnapshots,
  listRevisions,
  searchHistoricalMaterials,
} from "../src/api/index.ts";
import { mockState } from "../src/mock/data.ts";
import { MOCK_IMPORT_SNAPSHOTS_MODE_KEY, mockApiFetch } from "../src/mock/server.ts";
import { sha256Bytes } from "../src/util/sha256.ts";

const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await mockApiFetch(input, init);
  if (!response) throw new Error(`unexpected non-mock request: ${String(input)}`);
  return response;
}) as typeof fetch;

const client = createClient({ fetchImpl: mockFetch });

describe("P2 historical materials mock API", () => {
  test("import → pending → confirm → search → copy candidate", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const created = await createImportSnapshot(client, "p1", {
      id: `import-api-${suffix}`,
      source_kind: "local_directory",
      source_name: "API 测试资料",
      files: [
        { path: "rtl/api_test.v", content: "module api_test; endmodule", media_type: "text/plain" },
      ],
    }, `idem-import-${suffix}`);
    expect(created).toMatchObject({ id: `import-api-${suffix}`, status: "pending_confirmation", valid: true, searchable: false });
    expect(created.files).toHaveLength(1);
    expect(created.files[0]!.content).toBeUndefined();
    expect(created.source_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.files[0]!.content_hash).toBe(sha256Bytes(new TextEncoder().encode("module api_test; endmodule")));

    const pending = await getImportSnapshot(client, "p1", created.id);
    expect(pending.status).toBe("pending_confirmation");
    expect(pending.files[0]!.content).toBeUndefined();
    expect((await listImportSnapshots(client, "p1")).find((snapshot) => snapshot.id === created.id)?.files[0]!.content).toBeUndefined();
    expect(await searchHistoricalMaterials(client, "p1", "api_test.v")).not.toContainEqual(expect.objectContaining({ snapshot_id: created.id }));

    const confirmed = await confirmImportSnapshot(client, "p1", created.id, `idem-confirm-${suffix}`);
    expect(confirmed).toMatchObject({ status: "confirmed", valid: true, searchable: true });
    const results = await searchHistoricalMaterials(client, "p1", "api_test.v");
    expect(results).toContainEqual(expect.objectContaining({ snapshot_id: created.id, path: "rtl/api_test.v", searchable: true }));
    const matched = results.find((result) => result.snapshot_id === created.id);
    expect(matched?.content).toBeUndefined();
    expect(matched?.snippet).toBeUndefined();

    const copied = await copyHistoricalMaterial(client, "p1", created.id, {
      id: `candidate-${suffix}`,
      name: "API 测试候选",
      file_ids: [created.files[0]!.id],
    }, `idem-copy-${suffix}`);
    const expectedRevisionId = `import_rev_${sha256Bytes(new TextEncoder().encode(`p1\0${created.id}\0candidate-${suffix}\0${created.files[0]!.id}`)).slice(0, 48)}`;
    const expectedArtifactId = `import-p1-${sha256Bytes(new TextEncoder().encode("rtl/api_test.v")).slice(0, 24)}`;
    expect(copied).toMatchObject({
      id: `candidate-${suffix}`,
      snapshot_id: created.id,
      project_id: "p1",
      candidate: true,
      revision_ids: [expectedRevisionId],
      copied_files: [{ path: "rtl/api_test.v", revision_id: expectedRevisionId, artifact_id: expectedArtifactId }],
      revisions: [{ id: expectedRevisionId, artifact_id: expectedArtifactId, state: "candidate", path: "rtl/api_test.v", file_id: created.files[0]!.id }],
    });
    expect(copied.revision_ids).not.toContain(`candidate-${suffix}`);

    const replayed = await copyHistoricalMaterial(client, "p1", created.id, {
      id: `candidate-${suffix}`,
      name: "API 测试候选",
      file_ids: [created.files[0]!.id],
    }, `idem-copy-${suffix}`);
    expect(replayed).toEqual(copied);
    await expect(copyHistoricalMaterial(client, "p1", created.id, {
      id: `candidate-${suffix}`,
      name: "同键异体不应成功",
      file_ids: [created.files[0]!.id],
    }, `idem-copy-${suffix}`)).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });

    expect(await listArtifacts(client, "p1")).toContainEqual(expect.objectContaining({ id: expectedArtifactId, artifact_type: "KNOWLEDGE_ENTRY" }));
    expect(await listRevisions(client, "p1", expectedArtifactId)).toContainEqual(expect.objectContaining({ id: expectedRevisionId, version: 1, state: "candidate" }));
    expect(await getRevisionContent(client, "p1", expectedArtifactId, expectedRevisionId)).toEqual({
      content: "module api_test; endmodule",
      content_hash: created.files[0]!.content_hash,
    });

    const secondCopyId = `candidate-v2-${suffix}`;
    const second = await copyHistoricalMaterial(client, "p1", created.id, {
      id: secondCopyId,
      name: "API 测试候选 v2",
      file_ids: [created.files[0]!.id],
    }, `idem-copy-v2-${suffix}`);
    const expectedV2RevisionId = `import_rev_${sha256Bytes(new TextEncoder().encode(`p1\0${created.id}\0${secondCopyId}\0${created.files[0]!.id}`)).slice(0, 48)}`;
    expect(second).toMatchObject({
      revision_ids: [expectedV2RevisionId],
      revisions: [{ id: expectedV2RevisionId, artifact_id: expectedArtifactId, version: 2 }],
    });
    expect((await listRevisions(client, "p1", expectedArtifactId)).map((revision) => revision.version)).toEqual([1, 2]);
  });

  test("project source imports from source_project_id + commit without files", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const created = await createImportSnapshot(client, "p1", {
      id: `import-project-${suffix}`,
      source_kind: "project",
      source_project_id: "legacy-p1",
      commit: "b".repeat(40),
    }, `idem-import-project-${suffix}`);

    expect(created).toMatchObject({
      source_kind: "project",
      source_project_id: "legacy-p1",
      source_commit: "b".repeat(40),
      commit: "b".repeat(40),
      status: "pending_confirmation",
    });
    expect(created.files).toEqual([
      expect.objectContaining({ path: "doc/source-project.md", valid: true, searchable: false }),
    ]);
    expect(created.files[0]!.content).toBeUndefined();
    expect(created.source_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("project source rejects a supplied manifest that differs from the fixed commit", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    await expect(createImportSnapshot(client, "p1", {
      id: `import-project-mismatch-${suffix}`,
      source_kind: "project",
      source_project_id: "legacy-p1",
      commit: "c".repeat(40),
      files: [{ path: "rtl/injected.v", content: "module injected; endmodule" }],
    }, `idem-import-project-mismatch-${suffix}`)).rejects.toMatchObject({ status: 400, code: "validation" });
  });

  test("copy rejects artifact types outside the constrained Core options", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const created = await createImportSnapshot(client, "p1", {
      source_kind: "local_directory",
      files: [{ path: `doc/type-${suffix}.md`, content: "type check" }],
    }, `idem-import-type-${suffix}`);
    await confirmImportSnapshot(client, "p1", created.id, `idem-confirm-type-${suffix}`);

    await expect(copyHistoricalMaterial(client, "p1", created.id, {
      id: `candidate-type-${suffix}`,
      name: "非法类型",
      artifact_type: "HISTORICAL_MATERIAL",
      file_ids: [created.files[0]!.id],
    }, `idem-copy-type-${suffix}`)).rejects.toMatchObject({ status: 400, code: "validation" });
  });

  test("deny is terminal and cannot be copied or searched", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const created = await createImportSnapshot(client, "p1", {
      source_kind: "zip",
      source_name: `待否决-${suffix}`,
      files: [{ path: "doc/notes.md", content: "not approved" }],
    }, `idem-import-deny-${suffix}`);
    const denied = await denyImportSnapshot(client, "p1", created.id, { reason: "来源不明" }, `idem-deny-${suffix}`);
    expect(denied).toMatchObject({ status: "denied", searchable: false, denied_at: expect.any(String) });
    await expect(copyHistoricalMaterial(client, "p1", created.id, {
      id: `candidate-denied-${suffix}`,
      name: "不应复制",
      file_ids: [created.files[0]!.id],
    }, `idem-copy-denied-${suffix}`)).rejects.toMatchObject({ status: 409, code: "IMPORT_SNAPSHOT_NOT_SEARCHABLE" });
    expect(await searchHistoricalMaterials(client, "p1", "not approved")).not.toContainEqual(expect.objectContaining({ snapshot_id: created.id }));
  });

  test("expired snapshots remain invalid, unsearchable, and impossible to copy", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const created = await createImportSnapshot(client, "p1", {
      id: `import-expired-${suffix}`,
      source_kind: "local_directory",
      source_name: `已过期资料-${suffix}`,
      expires_at: "2020-01-01T00:00:00.000Z",
      files: [{ path: "doc/expired.md", content: `expired-${suffix}` }],
    }, `idem-import-expired-${suffix}`);

    expect(created).toMatchObject({
      status: "expired",
      valid: false,
      searchable: false,
      expires_at: "2020-01-01T00:00:00.000Z",
    });
    expect(await searchHistoricalMaterials(client, "p1", suffix)).not.toContainEqual(
      expect.objectContaining({ snapshot_id: created.id }),
    );
    await expect(copyHistoricalMaterial(client, "p1", created.id, {
      id: `candidate-expired-${suffix}`,
      name: "不应复制过期资料",
      file_ids: [created.files[0]!.id],
    }, `idem-copy-expired-${suffix}`)).rejects.toMatchObject({
      status: 409,
      code: "IMPORT_SNAPSHOT_NOT_SEARCHABLE",
    });
  });

  test("expiration is recomputed for pending confirmation, reads, search, and copy", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const pending = await createImportSnapshot(client, "p1", {
      id: `import-expire-pending-${suffix}`,
      source_kind: "local_directory",
      expires_at: "2099-01-01T00:00:00.000Z",
      files: [{ path: `doc/pending-${suffix}.md`, content: `pending-${suffix}` }],
    }, `idem-expire-pending-${suffix}`);
    const snapshots = mockState.importSnapshots.p1!;
    const pendingIndex = snapshots.findIndex((snapshot) => snapshot.id === pending.id);
    snapshots[pendingIndex] = { ...snapshots[pendingIndex]!, expires_at: "2020-01-01T00:00:00.000Z" };
    await expect(confirmImportSnapshot(client, "p1", pending.id, `idem-confirm-expired-${suffix}`)).rejects.toMatchObject({ status: 409 });
    expect(await getImportSnapshot(client, "p1", pending.id)).toMatchObject({ status: "expired", valid: false, searchable: false });

    const confirmed = await createImportSnapshot(client, "p1", {
      id: `import-expire-confirmed-${suffix}`,
      source_kind: "local_directory",
      expires_at: "2099-01-01T00:00:00.000Z",
      files: [{ path: `doc/confirmed-${suffix}.md`, content: `confirmed-${suffix}` }],
    }, `idem-expire-confirmed-${suffix}`);
    await confirmImportSnapshot(client, "p1", confirmed.id, `idem-confirm-before-expiry-${suffix}`);
    const confirmedIndex = snapshots.findIndex((snapshot) => snapshot.id === confirmed.id);
    snapshots[confirmedIndex] = { ...snapshots[confirmedIndex]!, expires_at: "2020-01-01T00:00:00.000Z" };
    expect(await searchHistoricalMaterials(client, "p1", suffix)).not.toContainEqual(expect.objectContaining({ snapshot_id: confirmed.id }));
    await expect(copyHistoricalMaterial(client, "p1", confirmed.id, {
      id: `candidate-after-expiry-${suffix}`,
      name: "不应复制",
      file_ids: [confirmed.files[0]!.id],
    }, `idem-copy-after-expiry-${suffix}`)).rejects.toMatchObject({ status: 409, code: "IMPORT_SNAPSHOT_NOT_SEARCHABLE" });
  });

  test("invalid files remain unsearchable and cannot be copied even in a confirmed snapshot", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const created = await createImportSnapshot(client, "p1", {
      id: `import-invalid-file-${suffix}`,
      source_kind: "local_directory",
      files: [{ path: `doc/invalid-${suffix}.md`, content: `invalid-${suffix}` }],
    }, `idem-import-invalid-file-${suffix}`);
    await confirmImportSnapshot(client, "p1", created.id, `idem-confirm-invalid-file-${suffix}`);
    const snapshots = mockState.importSnapshots.p1!;
    const index = snapshots.findIndex((snapshot) => snapshot.id === created.id);
    const stored = snapshots[index]!;
    snapshots[index] = { ...stored, files: stored.files.map((file) => ({ ...file, valid: false, searchable: true })) };

    expect((await getImportSnapshot(client, "p1", created.id)).files[0]).toMatchObject({ valid: false, searchable: false });
    expect(await searchHistoricalMaterials(client, "p1", suffix)).not.toContainEqual(expect.objectContaining({ snapshot_id: created.id }));
    await expect(copyHistoricalMaterial(client, "p1", created.id, {
      id: `candidate-invalid-file-${suffix}`,
      name: "不应复制失效文件",
      file_ids: [created.files[0]!.id],
    }, `idem-copy-invalid-file-${suffix}`)).rejects.toMatchObject({ status: 400, code: "validation" });
  });

  test("rejects a supplied source hash that does not match the canonical manifest", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const snapshotId = `import-bad-hash-${suffix}`;
    await expect(createImportSnapshot(client, "p1", {
      id: snapshotId,
      source_kind: "local_directory",
      source_hash: "0".repeat(64),
      files: [{ path: "rtl/hash_check.v", content: "module hash_check; endmodule" }],
    }, `idem-import-bad-hash-${suffix}`)).rejects.toMatchObject({
      status: 400,
      code: "validation",
    });
    expect((await listImportSnapshots(client, "p1")).map((snapshot) => snapshot.id)).not.toContain(snapshotId);
  });

  test("snapshots and search results remain isolated across projects", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const firstId = `scope-a-${suffix}`;
    const secondId = `scope-b-${suffix}`;
    for (const id of [firstId, secondId]) {
      await createProject(client, {
        id,
        name: id,
        project_type: "engineering",
        process_profile_id: "GJB_REF_V1",
      }, `idem-create-${id}`);
    }
    const created = await createImportSnapshot(client, firstId, {
      source_kind: "local_directory",
      files: [{ path: "doc/scoped.md", content: `private-${suffix}` }],
    }, `idem-import-${firstId}`);
    await confirmImportSnapshot(client, firstId, created.id, `idem-confirm-${firstId}`);

    expect((await listImportSnapshots(client, firstId)).map((snapshot) => snapshot.id)).toContain(created.id);
    expect(await listImportSnapshots(client, secondId)).toEqual([]);
    expect(await searchHistoricalMaterials(client, firstId, suffix)).toContainEqual(expect.objectContaining({ snapshot_id: created.id }));
    expect(await searchHistoricalMaterials(client, secondId, suffix)).toEqual([]);
    await expect(getImportSnapshot(client, secondId, created.id)).rejects.toMatchObject({ status: 404 });
  });

  test("mock endpoint unavailable keeps the library fail closed", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const fakeStorage: Storage = {
      length: 1,
      clear: () => {},
      getItem: (key) => key === MOCK_IMPORT_SNAPSHOTS_MODE_KEY ? "error" : null,
      key: () => MOCK_IMPORT_SNAPSHOTS_MODE_KEY,
      removeItem: () => {},
      setItem: () => {},
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: fakeStorage });
    try {
      await expect(listImportSnapshots(client, "p1")).rejects.toMatchObject({
        status: 503,
        code: "import_library_unavailable",
      });
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});
