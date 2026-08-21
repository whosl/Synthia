import { expect, test } from "bun:test";
import { createClient } from "../src/api/client.ts";
import {
  createProject,
  copyProjectAsEngineering,
  getProject,
  listArtifacts,
  listGateSubmissions,
  listProcessVersions,
  listProjects,
  listTasks,
} from "../src/api/index.ts";
import {
  MOCK_CREATED_PROJECTS_STORAGE_KEY,
  parseStoredMockProjects,
} from "../src/mock/data.ts";
import { MOCK_PROCESS_VERSIONS_MODE_KEY, mockApiFetch } from "../src/mock/server.ts";

const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await mockApiFetch(input, init);
  if (!response) throw new Error(`unexpected non-mock request: ${String(input)}`);
  return response;
}) as typeof fetch;

const client = createClient({ fetchImpl: mockFetch });

test("mock 新建项目持久化，整页刷新后仍能恢复详情", async () => {
  const stored = new Map<string, string>();
  const fakeStorage: Storage = {
    get length() { return stored.size; },
    clear: () => stored.clear(),
    getItem: (key) => stored.get(key) ?? null,
    key: (index) => [...stored.keys()][index] ?? null,
    removeItem: (key) => { stored.delete(key); },
    setItem: (key, value) => { stored.set(key, value); },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: fakeStorage });
  try {
    const id = `mock-persist-${crypto.randomUUID().slice(0, 8)}`;
    await createProject(client, {
      id,
      name: "可刷新自由项目",
      project_type: "free",
    }, `idem-${id}`);

    const restored = parseStoredMockProjects(stored.get(MOCK_CREATED_PROJECTS_STORAGE_KEY) ?? null);
    expect(restored.find((project) => project.id === id)).toMatchObject({
      id,
      project_type: "free",
      process_profile_id: null,
      process_instances: [],
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test("mock 可模拟 Core 流程注册表失败", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const fakeStorage: Storage = {
    length: 1,
    clear: () => {},
    getItem: (key) => key === MOCK_PROCESS_VERSIONS_MODE_KEY ? "error" : null,
    key: () => MOCK_PROCESS_VERSIONS_MODE_KEY,
    removeItem: () => {},
    setItem: () => {},
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: fakeStorage });
  try {
    await expect(listProcessVersions(client)).rejects.toMatchObject({
      status: 503,
      code: "process_registry_unavailable",
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test("mock 项目 API 支持流程注册表以及自由/工程项目的创建、列表和打开", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const freeId = `mock-free-${suffix}`;
  const engineeringId = `mock-eng-${suffix}`;

  const versions = await listProcessVersions(client);
  expect(versions).toEqual([
    {
      id: "GJB_REF_V1",
      profile_id: "GJB_REF_V1",
      version: "GJB_REF_V1",
      name: "GJB 参考流程 v1",
      status: "active",
      process_profile_id: "GJB_REF_V1",
      process_profile_version: "GJB_REF_V1",
      process_profile_name: "GJB 参考流程 v1",
    },
  ]);

  await expect(createProject(client, {
    id: `mock-invalid-${suffix}`,
    name: "无效流程工程项目",
    project_type: "engineering",
    process_profile_id: "NOT_REGISTERED",
  }, `idem-invalid-${suffix}`)).rejects.toMatchObject({ status: 400 });

  const free = await createProject(client, {
    id: freeId,
    name: "Mock 自由项目",
    project_type: "free",
  }, `idem-${freeId}`);
  expect(free).toMatchObject({
    id: freeId,
    project_type: "free",
    process_version_id: null,
    process_profile_id: null,
    process_profile_version: null,
    process_profile_name: null,
    target_part: null,
    process_instances: [],
  });

  const engineering = await createProject(client, {
    id: engineeringId,
    name: "Mock 工程项目",
    project_type: "engineering",
    process_profile_id: versions[0]!.id,
    target_part: "xc7a200tsbg484-1",
  }, `idem-${engineeringId}`);
  expect(engineering).toMatchObject({
    id: engineeringId,
    project_type: "engineering",
    process_version_id: "GJB_REF_V1",
    process_profile_id: "GJB_REF_V1",
    process_profile_version: "GJB_REF_V1",
    process_profile_name: "GJB 参考流程 v1",
    target_part: "xc7a200tsbg484-1",
  });
  expect(engineering.process_instances).toHaveLength(1);
  expect(engineering.process_instances[0]).toMatchObject({
    id: `pi_${engineeringId}_G0`,
    gate_profile_version: "GJB_REF_V1",
    current_gate: "G0",
  });

  const projects = await listProjects(client);
  const freeListItem = projects.find((project) => project.id === freeId);
  const engineeringListItem = projects.find((project) => project.id === engineeringId);
  const seed = projects.find((project) => project.id === "p1");
  const legacy = projects.find((project) => project.id === "legacy-p1");
  expect(freeListItem).toMatchObject({ project_type: "free", process_instances: [] });
  expect(engineeringListItem?.process_instances[0]).toMatchObject({
    gate_profile_version: "GJB_REF_V1",
    current_gate: "G0",
  });
  expect(seed).toMatchObject({
    project_type: "engineering",
    process_version_id: "GJB_REF_V1",
    process_profile_id: "GJB_REF_V1",
    process_profile_version: "GJB_REF_V1",
    process_profile_name: "GJB 参考流程 v1",
  });
  expect(seed?.process_instances[0]?.gate_profile_version).toBe("GJB_REF_V1");
  expect(legacy).toMatchObject({
    project_type: "engineering",
    process_version_id: "LEGACY_COMPAT",
    process_profile_id: "LEGACY_COMPAT",
    process_profile_name: "兼容旧流程",
  });

  const [freeDetail, engineeringDetail] = await Promise.all([
    getProject(client, freeId),
    getProject(client, engineeringId),
  ]);
  expect(freeDetail).toMatchObject({ id: freeId, project_type: "free", process_instances: [] });
  expect(engineeringDetail).toMatchObject({ id: engineeringId, project_type: "engineering" });
  expect(engineeringDetail.process_instances).toEqual(engineering.process_instances);

  const [artifacts, tasks, submissions] = await Promise.all([
    listArtifacts(client, engineeringId),
    listTasks(client, engineeringId),
    listGateSubmissions(client, engineeringId),
  ]);
  expect(artifacts).toEqual([]);
  expect(tasks).toEqual({ agents: [] });
  expect(submissions).toEqual([]);
});

test("mock 支持自由项目复制为新的工程项目并保留来源关系", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const sourceId = `mock-copy-source-${suffix}`;
  const targetId = `mock-copy-target-${suffix}`;
  await createProject(client, { id: sourceId, name: "待正式化", project_type: "free" }, `idem-${sourceId}`);
  const copied = await copyProjectAsEngineering(client, sourceId, { id: targetId, name: "正式工程" }, `idem-${targetId}`);
  expect(copied).toMatchObject({
    id: targetId,
    project_type: "engineering",
    process_profile_id: "GJB_REF_V1",
    source_relation: {
      source_project_id: sourceId,
      target_project_id: targetId,
      relation_kind: "copied_as_engineering",
    },
    workspace_content_copied: false,
  });
  expect(copied.process_instances).toHaveLength(1);
});
