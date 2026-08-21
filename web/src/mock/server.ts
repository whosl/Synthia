/**
 * `VITE_MOCK=1` 的离线后端：一层 `fetch` 拦截器。
 *
 * 为什么是拦截 `fetch` 而不是换掉 `api/client.ts`：
 * 对话流的 SSE 走的是 `domain/task-stream.ts` 里的裸 `fetch`（Core 鉴权是 Bearer
 * 头，原生 EventSource 带不了自定义头），不经过 ApiClient。拦 `fetch` 一处就同时
 * 盖住 REST 与 SSE，而且真实的 client 仍在跑——信封解包、401 跳登录这些逻辑照样
 * 被走一遍，不会因为 mock 而绕过。
 *
 * 只接管 `/api/v1/**`，其它请求（Vite HMR、Monaco worker、静态资源）原样放行。
 */

import {
  LIVE_AGENT_ID,
  MOCK_ARTIFACTS,
  MOCK_CONTENT,
  MOCK_LEGACY_PROJECT,
  MOCK_PROCESS_VERSIONS,
  MOCK_PROJECT,
  MOCK_REVISIONS,
  IMPLEMENT_NARRATION,
  IMPLEMENT_NARRATION_TEXT,
  mockJobEvidenceContent,
  mockAgentDetail,
  mockAgents,
  mockState,
  persistCreatedMockProjects,
} from "./data.ts";
import type {
  Artifact,
  ArtifactRevision,
  CopyHistoricalMaterialResult,
  CreateImportSnapshotRequest,
  CreateProjectResult,
  HistoricalMaterialFile,
  HistoricalMaterialSearchResult,
  HistoricalMaterialSnapshot,
  ImportSnapshotFileInput,
  ProcessInstance,
  Project,
  ProjectDetail,
} from "../api/types.ts";
import {
  DEFAULT_HISTORICAL_COPY_ARTIFACT_TYPE,
  isHistoricalCopyArtifactType,
  parseMaterialImportPayload,
} from "../domain/historical-materials.ts";
import { sha256Bytes } from "../util/sha256.ts";

/** 假装有网络：让 loading 态真的能被看见，而不是同步瞬间填满。 */
const LATENCY_MS = 80;
/** SSE 每块文本的间隔（打字机手感）。 */
const DELTA_INTERVAL_MS = 700;
/** 浏览器验收可用同名本地值或 `?mockProcessVersions=error` 验证 UI fail closed。 */
export const MOCK_PROCESS_VERSIONS_MODE_KEY = "synthia.mock.process-versions-mode";
/** `error` makes the P2 library endpoint return 503 for browser fail-closed QA. */
export const MOCK_IMPORT_SNAPSHOTS_MODE_KEY = "synthia.mock.import-snapshots-mode";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function processVersionsMode(): string | null {
  try {
    const queryMode = typeof globalThis.location === "undefined"
      ? null
      : new URLSearchParams(globalThis.location.search).get("mockProcessVersions");
    if (queryMode) return queryMode;
    return typeof globalThis.localStorage === "undefined"
      ? null
      : globalThis.localStorage.getItem(MOCK_PROCESS_VERSIONS_MODE_KEY);
  } catch {
    return null;
  }
}

function importSnapshotsMode(): string | null {
  try {
    const queryMode = typeof globalThis.location === "undefined"
      ? null
      : new URLSearchParams(globalThis.location.search).get("mockMaterials");
    if (queryMode) return queryMode;
    return typeof globalThis.localStorage === "undefined"
      ? null
      : globalThis.localStorage.getItem(MOCK_IMPORT_SNAPSHOTS_MODE_KEY);
  } catch {
    return null;
  }
}

function ok<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify({ data, correlation_id: `mock-${Date.now().toString(36)}` }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ error: { code, message, retryable: false, details: null, correlation_id: "mock" } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function allProjects(): readonly ProjectDetail[] {
  return [...mockState.createdProjects, MOCK_PROJECT, MOCK_LEGACY_PROJECT];
}

function findProject(projectId: string): ProjectDetail | null {
  return allProjects().find((project) => project.id === projectId) ?? null;
}

function projectSummary(project: ProjectDetail): Project {
  const { scope, standard_version, toolchain_profile_ref, ...summary } = project;
  void scope;
  void standard_version;
  void toolchain_profile_ref;
  return summary;
}

function createResult(project: ProjectDetail): CreateProjectResult {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    project_type: project.project_type,
    process_version_id: project.process_version_id,
    process_profile_id: project.process_profile_id,
    process_profile_version: project.process_profile_version,
    process_profile_name: project.process_profile_name,
    target_part: project.target_part,
    process_instances: project.process_instances,
  };
}

function createMockProject(body: unknown): Response {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail(400, "validation", "创建项目请求必须是对象");
  }
  const request = body as Record<string, unknown>;
  const id = typeof request.id === "string" ? request.id.trim() : "";
  const name = typeof request.name === "string" ? request.name.trim() : "";
  if (!id) return fail(400, "validation", "项目 id 必填");
  if (!name) return fail(400, "validation", "项目名称必填");
  if (findProject(id)) return fail(409, "PROJECT_ALREADY_EXISTS_DIFFERENT_PAYLOAD", `项目 ${id} 已存在`);

  const projectType = request.project_type;
  if (projectType !== "free" && projectType !== "engineering") {
    return fail(400, "validation", "project_type 必须是 free 或 engineering");
  }

  const requestedProfile = request.process_profile_id;
  const profile = typeof requestedProfile === "string"
    ? MOCK_PROCESS_VERSIONS.find((version) => version.id === requestedProfile)
    : undefined;
  if (projectType === "engineering" && !profile) {
    return fail(400, "validation", "工程项目必须选择 Core 返回的 active 流程版本");
  }
  if (projectType === "free" && requestedProfile !== undefined && requestedProfile !== null) {
    return fail(400, "validation", "自由项目不能绑定流程版本");
  }

  const rawTargetPart = request.target_part;
  if (rawTargetPart !== undefined && rawTargetPart !== null && typeof rawTargetPart !== "string") {
    return fail(400, "validation", "target_part 必须是字符串或 null");
  }
  const targetPart = typeof rawTargetPart === "string" && rawTargetPart.trim() ? rawTargetPart.trim() : null;
  const createdAt = new Date().toISOString();
  const processInstances: readonly ProcessInstance[] = profile
    ? [{ id: `pi_${id}_G0`, gate_profile_version: profile.id, current_gate: "G0", created_at: createdAt }]
    : [];
  const project: ProjectDetail = {
    id,
    name,
    status: "active",
    data_classification: typeof request.data_classification === "string" ? request.data_classification : "D1",
    created_at: createdAt,
    project_type: projectType,
    process_version_id: profile?.id ?? null,
    process_profile_id: profile?.process_profile_id ?? null,
    process_profile_version: profile?.process_profile_version ?? null,
    process_profile_name: profile?.process_profile_name ?? null,
    target_part: targetPart,
    process_instances: processInstances,
    scope: "",
    standard_version: "GB/T 33781-2017",
    toolchain_profile_ref: null,
  };
  mockState.createdProjects.unshift(project);
  persistCreatedMockProjects();
  return ok(createResult(project), 201);
}

function copyMockProjectAsEngineering(sourceProjectId: string, body: unknown): Response {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail(400, "validation", "复制请求必须是对象");
  }
  const source = findProject(sourceProjectId);
  if (!source) return fail(404, "not_found", `项目 ${sourceProjectId} 不存在`);
  const sourceEligible = source.project_type === "free" || source.process_profile_id === "LEGACY_COMPAT";
  if (!sourceEligible) return fail(409, "PROJECT_COPY_SOURCE_NOT_ELIGIBLE", "只有自由或兼容旧流程项目可以正式化");
  const request = body as Record<string, unknown>;
  const id = typeof request.id === "string" ? request.id.trim() : "";
  const name = typeof request.name === "string" ? request.name.trim() : "";
  if (!id || !name) return fail(400, "validation", "复制目标 id 和名称必填");
  if (findProject(id)) return fail(409, "PROJECT_ALREADY_EXISTS_DIFFERENT_PAYLOAD", `项目 ${id} 已存在`);
  const rawTarget = request.target_part;
  if (rawTarget !== undefined && rawTarget !== null && typeof rawTarget !== "string") {
    return fail(400, "validation", "target_part 必须是字符串或 null");
  }
  const targetPart = rawTarget === undefined ? source.target_part : (typeof rawTarget === "string" && rawTarget.trim() ? rawTarget.trim() : null);
  const createdAt = new Date().toISOString();
  const project: ProjectDetail = {
    id,
    name,
    status: "active",
    data_classification: source.data_classification,
    created_at: createdAt,
    project_type: "engineering",
    process_version_id: "GJB_REF_V1",
    process_profile_id: "GJB_REF_V1",
    process_profile_version: "GJB_REF_V1",
    process_profile_name: "GJB 参考流程 v1",
    target_part: targetPart,
    process_instances: [{ id: `pi_${id}_G0`, gate_profile_version: "GJB_REF_V1", current_gate: "G0", created_at: createdAt }],
    source_relation: {
      source_project_id: sourceProjectId,
      target_project_id: id,
      relation_kind: "copied_as_engineering",
      created_by_type: "human",
      created_by: "mock-user",
      created_at: createdAt,
    },
    scope: source.scope,
    standard_version: source.standard_version,
    toolchain_profile_ref: source.toolchain_profile_ref,
  };
  mockState.createdProjects.unshift(project);
  persistCreatedMockProjects();
  return ok({ ...createResult(project), source_relation: project.source_relation, workspace_content_copied: false }, 201);
}

// ─────────────────────────────────────────────────────────────────────
// P2 历史资料库 mock
// ─────────────────────────────────────────────────────────────────────

function materialSnapshots(projectId: string): HistoricalMaterialSnapshot[] {
  const existing = mockState.importSnapshots[projectId];
  if (existing) return existing;
  const created: HistoricalMaterialSnapshot[] = [];
  mockState.importSnapshots[projectId] = created;
  return created;
}

function mockDigest(seed: string): string {
  return sha256Bytes(new TextEncoder().encode(seed));
}

function canonicalInputHash(files: readonly ImportSnapshotFileInput[]): string {
  return mockDigest(
    [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => `${file.path}:${mockDigest(file.content)}`)
      .join("\n"),
  );
}

function materialFile(snapshotId: string, row: ImportSnapshotFileInput, index: number): HistoricalMaterialFile {
  const contentBytes = new TextEncoder().encode(row.content).byteLength;
  const id = `${snapshotId}:file:${index + 1}`;
  return {
    id,
    file_id: id,
    snapshot_id: snapshotId,
    path: row.path,
    bytes: contentBytes,
    size_bytes: contentBytes,
    content_hash: mockDigest(row.content),
    media_type: row.media_type ?? "text/plain",
    valid: true,
    searchable: false,
    created_at: new Date().toISOString(),
    content: row.content,
  };
}

/** Mock 没有每个项目的真实 Git 工作树；用固定清单模拟 Core 按 commit 读取树。 */
function mockProjectSourceFiles(
  source: ProjectDetail,
  commit: string | undefined,
): readonly ImportSnapshotFileInput[] {
  return [{
    path: "doc/source-project.md",
    media_type: "text/markdown",
    content: [
      `# ${source.name}`,
      "",
      `来源项目：${source.id}`,
      `固定提交：${commit ?? "HEAD"}`,
      "",
      "这是离线 Mock 为 project source 生成的确定性资料清单。",
    ].join("\n"),
  }];
}

/** 与 Core 的 effectiveStatus 一致：到期是读取时事实，不只在创建时固化一次。 */
function effectiveMockImportSnapshot(snapshot: HistoricalMaterialSnapshot): HistoricalMaterialSnapshot {
  const expiresAt = snapshot.expires_at === null ? null : Date.parse(snapshot.expires_at);
  const expired = (snapshot.status === "pending_confirmation" || snapshot.status === "confirmed")
    && expiresAt !== null
    && expiresAt <= Date.now();
  const status = expired ? "expired" : snapshot.status;
  const valid = snapshot.valid && status !== "failed" && status !== "expired";
  const searchable = status === "confirmed" && valid && snapshot.searchable;
  return {
    ...snapshot,
    status,
    valid,
    searchable,
    files: snapshot.files.map((file) => ({
      ...file,
      searchable: searchable && file.valid === true && file.searchable === true,
    })),
  };
}

/** list/detail/create 默认与 Core 一样不下发正文；Mock 内部仍保留正文供搜索/复制。 */
function publicMockImportSnapshot(snapshot: HistoricalMaterialSnapshot): HistoricalMaterialSnapshot {
  const current = effectiveMockImportSnapshot(snapshot);
  return {
    ...current,
    files: current.files.map((file) => {
      const { content, content_base64: contentBase64, ...view } = file;
      void content;
      void contentBase64;
      return view;
    }),
  };
}

function projectArtifacts(projectId: string): readonly Artifact[] {
  const fixture = projectId === MOCK_PROJECT.id ? MOCK_ARTIFACTS : [];
  return [...fixture, ...(mockState.importArtifacts[projectId] ?? [])];
}

function artifactRevisions(projectId: string, artifactId: string): readonly ArtifactRevision[] {
  if (!projectArtifacts(projectId).some((artifact) => artifact.id === artifactId)) return [];
  const fixture = projectId === MOCK_PROJECT.id ? MOCK_REVISIONS[artifactId] ?? [] : [];
  return [...fixture, ...(mockState.importRevisions[artifactId] ?? [])]
    .sort((a, b) => a.version - b.version);
}

function createMockImportSnapshot(projectId: string, body: unknown): Response {
  const parsed = parseMaterialImportPayload(JSON.stringify(body));
  if (!parsed.ok) return fail(400, "validation", parsed.message);
  const request: CreateImportSnapshotRequest = parsed.request;
  const target = findProject(projectId);
  if (!target || target.project_type !== "engineering") {
    return fail(409, "IMPORT_REQUIRES_ENGINEERING_PROJECT", "历史资料只能导入工程项目");
  }
  if (request.source_kind === "project" && !request.source_project_id) {
    return fail(400, "validation", "project 来源必须提供 source_project_id");
  }
  let sourceProject: ProjectDetail | null = null;
  if (request.source_kind === "project") {
    const source = request.source_project_id ? findProject(request.source_project_id) : null;
    if (!source) return fail(404, "not_found", "来源项目不存在");
    if (source.id === projectId) return fail(400, "validation", "来源项目不能与目标项目相同");
    if (source.status !== "active") return fail(409, "SOURCE_PROJECT_NOT_ACTIVE", "来源项目不是 active 状态");
    sourceProject = source;
  }
  const snapshots = materialSnapshots(projectId);
  const id = request.id ?? `import-${projectId}-${crypto.randomUUID().slice(0, 8)}`;
  if (snapshots.some((snapshot) => snapshot.id === id)) return fail(409, "IMPORT_SNAPSHOT_ALREADY_EXISTS", `资料快照 ${id} 已存在`);
  const createdAt = new Date().toISOString();
  const workspaceFiles = sourceProject ? mockProjectSourceFiles(sourceProject, request.commit) : null;
  if (workspaceFiles && request.files && canonicalInputHash(request.files) !== canonicalInputHash(workspaceFiles)) {
    return fail(400, "validation", "project 导入 files 与来源项目固定 commit 清单不匹配");
  }
  const sourceFiles = request.files ?? workspaceFiles ?? [];
  const files = sourceFiles.map((row, index) => materialFile(id, row, index));
  const canonicalSourceHash = canonicalInputHash(sourceFiles);
  if (request.source_hash && request.source_hash !== canonicalSourceHash) {
    return fail(400, "validation", "source_hash 与规范化资料清单不匹配");
  }
  const expiresAt = request.expires_at ? new Date(request.expires_at).toISOString() : null;
  const expired = expiresAt !== null && Date.parse(expiresAt) <= Date.now();
  const snapshot: HistoricalMaterialSnapshot = {
    id,
    snapshot_id: id,
    project_id: projectId,
    source_kind: request.source_kind,
    source_project_id: request.source_project_id ?? null,
    source_name: request.source_name ?? sourceProject?.id ?? request.source_kind,
    source_hash: canonicalSourceHash,
    source_commit: request.commit ?? null,
    commit: request.commit ?? null,
    status: expired ? "expired" : "pending_confirmation",
    valid: !expired,
    searchable: false,
    expires_at: expiresAt,
    files,
    created_at: createdAt,
    confirmed_at: null,
    denied_at: null,
    denial_reason: null,
    failure_reason: null,
  };
  snapshots.unshift(snapshot);
  return ok(publicMockImportSnapshot(snapshot), 201);
}

function findMockImportSnapshot(projectId: string, snapshotId: string): HistoricalMaterialSnapshot | null {
  return materialSnapshots(projectId).find((snapshot) => snapshot.id === snapshotId) ?? null;
}

function updateMockImportSnapshot(projectId: string, snapshotId: string, action: "confirm" | "deny", body: unknown): Response {
  const snapshots = materialSnapshots(projectId);
  const at = snapshots.findIndex((snapshot) => snapshot.id === snapshotId);
  if (at < 0) return fail(404, "not_found", "资料快照不存在");
  const current = effectiveMockImportSnapshot(snapshots[at]!);
  if (current.status !== "pending_confirmation") return fail(409, "IMPORT_SNAPSHOT_STATE_CONFLICT", "资料快照已经完成确认决策");
  const now = new Date().toISOString();
  const next: HistoricalMaterialSnapshot = action === "confirm"
    ? { ...current, status: "confirmed", searchable: current.valid, confirmed_at: now, files: current.files.map((file) => ({ ...file, searchable: file.valid })) }
    : { ...current, status: "denied", searchable: false, denied_at: now, denial_reason: typeof (body as { reason?: unknown } | null)?.reason === "string" ? (body as { reason: string }).reason : null, files: current.files.map((file) => ({ ...file, searchable: false })) };
  snapshots[at] = next;
  return ok(publicMockImportSnapshot(next));
}

function searchMockImportSnapshots(projectId: string, query: string): Response {
  const needle = query.trim().toLowerCase();
  const rows: HistoricalMaterialSearchResult[] = [];
  for (const stored of materialSnapshots(projectId)) {
    const snapshot = effectiveMockImportSnapshot(stored);
    if (snapshot.status !== "confirmed" || !snapshot.valid || !snapshot.searchable) continue;
    for (const file of snapshot.files) {
      if (!file.valid || !file.searchable) continue;
      const haystack = `${file.path}\n${file.content ?? ""}`.toLowerCase();
      if (needle && !haystack.includes(needle)) continue;
      rows.push({
        id: file.id,
        file_id: file.file_id,
        snapshot_id: snapshot.id,
        path: file.path,
        bytes: file.bytes,
        size_bytes: file.size_bytes,
        content_hash: file.content_hash,
        media_type: file.media_type,
        created_at: file.created_at,
        project_id: projectId,
        source_name: snapshot.source_name,
        status: "confirmed",
        source_kind: snapshot.source_kind,
        source_project_id: snapshot.source_project_id,
        source_hash: snapshot.source_hash,
        valid: snapshot.valid,
        searchable: snapshot.searchable,
      });
    }
  }
  return ok({ items: rows, results: rows, query, total: rows.length });
}

function copyMockImportSnapshot(projectId: string, snapshotId: string, body: unknown, idempotencyKey: string | null): Response {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "validation", "复制请求必须是对象");
  const request = body as Record<string, unknown>;
  const fileIds = Array.isArray(request.file_ids) ? request.file_ids.filter((id): id is string => typeof id === "string") : [];
  if (typeof request.id !== "string" || !request.id.trim() || typeof request.name !== "string" || !request.name.trim() || fileIds.length === 0 || new Set(fileIds).size !== fileIds.length) {
    return fail(400, "validation", "复制请求必须包含 id、name 和至少一个 file_id");
  }
  const copyId = request.id.trim();
  const copyName = request.name.trim();
  const artifactType = request.artifact_type ?? DEFAULT_HISTORICAL_COPY_ARTIFACT_TYPE;
  if (!isHistoricalCopyArtifactType(artifactType)) {
    return fail(400, "validation", "artifact_type 必须是历史资料复制支持的合法产物类型");
  }

  const requestHash = mockDigest(JSON.stringify({ copyId, copyName, artifactType, fileIds }));
  const operationKey = idempotencyKey ? `${projectId}\0${snapshotId}\0${idempotencyKey}` : null;
  const previous = operationKey ? mockState.importCopyOperations[operationKey] : undefined;
  if (previous) {
    return previous.requestHash === requestHash
      ? ok(previous.result)
      : fail(409, "IDEMPOTENCY_KEY_REUSED", "同一幂等键不能用于不同复制请求");
  }

  const stored = findMockImportSnapshot(projectId, snapshotId);
  if (!stored) return fail(404, "not_found", "资料快照不存在");
  const snapshot = effectiveMockImportSnapshot(stored);
  if (snapshot.status !== "confirmed" || !snapshot.valid || !snapshot.searchable) {
    return fail(409, "IMPORT_SNAPSHOT_NOT_SEARCHABLE", "只有已确认且仍有效的资料可以复制");
  }
  const selected: HistoricalMaterialFile[] = [];
  for (const fileId of fileIds) {
    const file = snapshot.files.find((candidate) => candidate.id === fileId);
    if (!file || !file.valid || !file.searchable || typeof file.content !== "string") {
      return fail(400, "validation", "file_id 不属于该资料快照、文件已失效或正文不可复制");
    }
    selected.push(file);
  }

  for (const file of selected) {
    const artifactId = `import-${projectId}-${mockDigest(file.path).slice(0, 24)}`;
    const existingArtifact = projectArtifacts(projectId).find((artifact) => artifact.id === artifactId);
    if (existingArtifact && existingArtifact.artifact_type !== artifactType) {
      return fail(409, "IMPORT_ARTIFACT_METADATA_CONFLICT", "同路径候选的产物类型与既有产物不一致");
    }
  }
  const planned = selected.map((file) => {
    const id = `import_rev_${mockDigest(`${projectId}\0${snapshotId}\0${copyId}\0${file.id}`).slice(0, 48)}`;
    const artifactId = `import-${projectId}-${mockDigest(file.path).slice(0, 24)}`;
    const existingArtifact = projectArtifacts(projectId).find((artifact) => artifact.id === artifactId);
    const versions = artifactRevisions(projectId, artifactId);
    return {
      file,
      id,
      artifactId,
      version: versions.reduce((max, revision) => Math.max(max, revision.version), 0) + 1,
      createArtifact: !existingArtifact,
    } as const;
  });
  const existingRevisionIds = new Set([
    ...Object.values(MOCK_REVISIONS).flat().map((revision) => revision.id),
    ...Object.values(mockState.importRevisions).flat().map((revision) => revision.id),
  ]);
  if (planned.some((item) => existingRevisionIds.has(item.id))) {
    return fail(409, "IMPORT_REVISION_ID_CONFLICT", "复制标识已用于同一资料文件，请使用新的候选标识");
  }

  const now = new Date().toISOString();
  const importedArtifacts = mockState.importArtifacts[projectId] ?? (mockState.importArtifacts[projectId] = []);
  for (const item of planned) {
    if (item.createArtifact) importedArtifacts.push({ id: item.artifactId, artifact_type: artifactType, created_at: now });
    const revisionList = mockState.importRevisions[item.artifactId] ?? (mockState.importRevisions[item.artifactId] = []);
    revisionList.push({
      id: item.id,
      version: item.version,
      state: "candidate",
      content_hash: item.file.content_hash,
      content_location: `mock://artifact_revision/${item.id}`,
      title: copyName,
      created_at: now,
    });
    if (typeof item.file.content === "string") mockState.importRevisionContent[item.id] = item.file.content;
  }

  const revisions = planned.map((item) => ({
    id: item.id,
    artifact_id: item.artifactId,
    project_id: projectId,
    version: item.version,
    state: "candidate" as const,
    file_id: item.file.id,
    path: item.file.path,
    content_hash: item.file.content_hash,
  }));
  const result: CopyHistoricalMaterialResult = {
    id: copyId,
    snapshot_id: snapshotId,
    project_id: projectId,
    candidate: true,
    revision_ids: revisions.map((revision) => revision.id),
    copied_files: planned.map((item, index) => ({
      file_id: item.file.id,
      path: item.file.path,
      revision_id: revisions[index]!.id,
      artifact_id: revisions[index]!.artifact_id,
      version: revisions[index]!.version,
    })),
    revisions,
    source_relations: planned.map((item, index) => ({
      id: `import_rel_${mockDigest(revisions[index]!.id).slice(0, 48)}`,
      snapshot_id: snapshotId,
      entry_id: item.file.id,
      target_revision_id: revisions[index]!.id,
      relation_kind: "imported_candidate" as const,
    })),
  };
  if (operationKey) mockState.importCopyOperations[operationKey] = { requestHash, result };
  return ok(result);
}

function sseFrame(event: string, id: number, data: unknown): string {
  return `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 实现阶段的流式叙述。
 *
 * 播完最后一块后把 run 翻成 succeeded 再发 `status`/`done`——顺序反了的话前端会
 * 在 run 还是 running 的时候刷新，成功卡不出来。已完成的 run（或重新订阅的老 run）
 * 只发保活注释，模拟 Core 那边的空闲长连接。
 */
function liveStream(agentId: string, signal: AbortSignal | null | undefined): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let seq = 0;
      const send = (event: string, data: unknown): void => {
        if (stopped) return;
        seq += 1;
        controller.enqueue(encoder.encode(sseFrame(event, seq, data)));
      };
      const wait = (ms: number): Promise<void> =>
        new Promise((resolve) => {
          timer = setTimeout(resolve, ms);
        });

      const partId = `sp-implement-${agentId}`;
      if (agentId === LIVE_AGENT_ID && !mockState.agentBDone) {
        send("part", { part: { kind: "text", id: partId, state: "streaming", text: "" } });
        for (const chunk of IMPLEMENT_NARRATION) {
          await wait(DELTA_INTERVAL_MS);
          if (stopped) return;
          send("delta", { partId, text: chunk });
        }
        await wait(DELTA_INTERVAL_MS);
        if (stopped) return;
        send("part", { part: { kind: "text", id: partId, state: "done", text: IMPLEMENT_NARRATION_TEXT } });
        mockState.agentBDone = true;
        send("status", { status: "succeeded" });
        send("done", { reply: IMPLEMENT_NARRATION_TEXT });
      }

      // 空闲保活：不主动断流，避免前端进入退避重连。
      for (;;) {
        await wait(15_000);
        if (stopped) return;
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }
    },
    cancel() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  });

  signal?.addEventListener("abort", () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

async function route(
  pathname: string,
  method: string,
  body: unknown,
  signal: AbortSignal | null | undefined,
  searchParams: URLSearchParams,
  headers: Headers,
): Promise<Response | null> {
  const seg = pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);

  if (seg.length === 1 && seg[0] === "process-versions" && method === "GET") {
    if (processVersionsMode() === "error") {
      return fail(503, "process_registry_unavailable", "Core 流程注册表暂不可用");
    }
    return ok(MOCK_PROCESS_VERSIONS);
  }

  // /projects
  if (seg.length === 1 && seg[0] === "projects" && method === "GET") {
    return ok(allProjects().map(projectSummary));
  }
  if (seg.length === 1 && seg[0] === "projects" && method === "POST") {
    return createMockProject(body);
  }
  if (seg[0] !== "projects" || seg.length < 2) return null;

  const projectId = seg[1]!;
  const project = findProject(projectId);
  if (!project) return fail(404, "not_found", `项目 ${projectId} 不存在`);
  const fixtureProject = projectId === MOCK_PROJECT.id;
  const rest = seg.slice(2);

  // /projects/:id
  if (rest.length === 0 && method === "GET") return ok(project);

  if (rest.length === 1 && rest[0] === "copy-as-engineering" && method === "POST") {
    return copyMockProjectAsEngineering(projectId, body);
  }

  // /projects/:id/import-snapshots[/:snapshotId[/confirm|deny|copy]]
  // Search is intentionally nested below the project so Core can enforce project
  // scope; it never searches the global database from the browser.
  if (rest[0] === "import-snapshots") {
    if (importSnapshotsMode() === "error") {
      return fail(503, "import_library_unavailable", "Core 历史资料库暂不可用");
    }
    if (rest.length === 1 && method === "GET") {
      return ok(materialSnapshots(projectId).map(publicMockImportSnapshot));
    }
    if (rest.length === 1 && method === "POST") return createMockImportSnapshot(projectId, body);
    if (rest.length === 2 && rest[1] === "search" && method === "GET") {
      return searchMockImportSnapshots(projectId, searchParams.get("q") ?? "");
    }
    if (rest.length === 2 && method === "GET") {
      const snapshot = findMockImportSnapshot(projectId, rest[1]!);
      return snapshot ? ok(publicMockImportSnapshot(snapshot)) : fail(404, "not_found", "资料快照不存在");
    }
    if (rest.length === 3 && (rest[2] === "confirm" || rest[2] === "deny") && method === "POST") {
      return updateMockImportSnapshot(projectId, rest[1]!, rest[2], body);
    }
    if (rest.length === 3 && rest[2] === "copy" && method === "POST") {
      return copyMockImportSnapshot(projectId, rest[1]!, body, headers.get("idempotency-key"));
    }
    return null;
  }

  if (rest[0] === "gate-submissions" && rest.length === 1 && method === "GET") return ok([]);

  // /projects/:id/artifacts[/:aid/revisions[/:rid/content]]
  if (rest[0] === "artifacts") {
    if (rest.length === 1 && method === "GET") return ok(projectArtifacts(projectId));
    const artifactId = rest[1]!;
    const revisions = artifactRevisions(projectId, artifactId);
    if (revisions.length === 0) return fail(404, "not_found", "artifact 不存在");
    if (rest.length === 3 && rest[2] === "revisions" && method === "GET") return ok(revisions);
    if (rest.length === 5 && rest[2] === "revisions" && rest[4] === "content" && method === "GET") {
      const revision = revisions.find((r) => r.id === rest[3]);
      const content = revision ? MOCK_CONTENT[revision.id] ?? mockState.importRevisionContent[revision.id] : undefined;
      if (!revision || content === undefined) return fail(404, "not_found", "修订不存在");
      return ok({ content, content_hash: revision.content_hash });
    }
    return null;
  }

  // /projects/:id/tasks[/:agentId[/message|abort|stream]]
  if (rest[0] === "tasks") {
    if (rest.length === 1) {
      if (method === "GET") return ok({ agents: fixtureProject ? mockAgents() : [] });
      if (method === "POST") {
        if (!fixtureProject) return fail(501, "mock_unsupported", "新建项目的离线 Agent 尚未实现");
        // mock 不真的开新 run：把指令回显到当前活动 run 上，并说明这是离线模式。
        const text = String((body as { task?: unknown } | null)?.task ?? "");
        mockState.extraUserMessages.push({ agentId: LIVE_AGENT_ID, text, ts: new Date().toISOString() });
        return ok({ agentId: LIVE_AGENT_ID });
      }
      return null;
    }
    if (!fixtureProject) return fail(404, "not_found", "run 不存在");
    const agentId = rest[1]!;
    if (rest.length === 2 && method === "GET") {
      const detail = mockAgentDetail(agentId);
      return detail ? ok(detail) : fail(404, "not_found", "run 不存在");
    }
    if (rest.length === 3 && rest[2] === "stream" && method === "GET") return liveStream(agentId, signal);
    if (rest.length === 3 && rest[2] === "message" && method === "POST") {
      const text = String((body as { text?: unknown } | null)?.text ?? "");
      mockState.extraUserMessages.push({ agentId, text, ts: new Date().toISOString() });
      const status = mockAgentDetail(agentId)?.status ?? "idle";
      return ok({ steered: status === "running", status });
    }
    if (rest.length === 3 && rest[2] === "abort" && method === "POST") {
      mockState.agentBDone = true;
      return ok({ aborted: true, status: "interrupted" });
    }
    return null;
  }

  // /projects/:id/jobs/:jobId/evidence/content?name=
  if (rest[0] === "jobs" && rest.length === 4 && rest[2] === "evidence" && rest[3] === "content" && method === "GET") {
    const jobId = rest[1]!;
    const name = searchParams.get("name") ?? "";
    const content = mockJobEvidenceContent(jobId, name);
    if (!content) return fail(404, "not_found", "证据条目不存在或已被清理");
    return ok(content);
  }

  return null;
}

let installed = false;

/**
 * 单次 mock 请求处理。导出后测试可以走与浏览器完全相同的信封/路由逻辑，
 * 同时不必永久替换测试进程的 globalThis.fetch。
 */
export async function mockApiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname, searchParams } = new URL(url, "http://mock.local");
  if (!pathname.startsWith("/api/v1")) return null;

  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  const headers = new Headers(
    init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined),
  );
  let body: unknown = null;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = null;
    }
  }

  // SSE 不加人为延迟：它本来就是长连接。
  const isStream = pathname.endsWith("/stream");
  if (!isStream) await sleep(LATENCY_MS);

  const res = await route(pathname, method, body, init?.signal, searchParams, headers);
  return res ?? fail(404, "not_found", `mock 未实现该端点：${method} ${pathname}`);
}

/** 安装拦截器（幂等）。仅在 `import.meta.env.VITE_MOCK === "1"` 时由 main.ts 调用。 */
export function installMockServer(): void {
  if (installed) return;
  installed = true;

  const realFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await mockApiFetch(input, init);
    return res ?? realFetch(input, init);
  };

  // eslint-disable-next-line no-console
  console.info(
    "[mock] 离线模式已启用：/api/v1/** 由 src/mock 接管。数据是 worker-66 真机 Vivado 产物快照；没有模型后端，对话不会有真回复。",
  );
}
