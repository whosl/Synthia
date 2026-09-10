/**
 * `VITE_MOCK=1` 的离线数据源：把 worker-66 真机跑出来的 Vivado 产物
 * （`./vivado-fixture.ts`）编排成 Core API 的响应形状，让三栏项目页在没有
 * Core / Runtime 的情况下也能整页渲染。
 *
 * 哪些是真的、哪些是我编的（重要，别混淆）：
 * - **真的**：jobId、inputSha256、证据条目名/sha256/字节数、四个工具操作的成败
 *   与耗时、RTL/TB/XDC 源码、`synthia.bit` 的 3,011,427 字节与摘要、以及 v1 草稿
 *   被 XSim 判失败这件事本身（`VIVADO_SIMULATION_FAILED`，high=191 vs 期望 64）。
 * - **我编的**：四份中文设计文档的正文、门审查（G1–G4）的时间线、run/revision 的
 *   id 与时间戳、以及 SSE 叙述脚本。没有模型后端在跑，这些没法真机产出。
 *   文档正文的 `content_hash` 是对下面这些字符串真算的 SHA-256（gen 脚本填入），
 *   不是随手编的十六进制。
 *
 * 编排口径严格对齐 `runtime/loop.ts` 的真实行为，不多不少：
 * - 每轮 run 只登记 5 个 artifact（intake / behavior_wave / architecture /
 *   register_spec 四份文档 + RTL_SOURCE_SET），**TB、XDC 和所有 Vivado 报告都不
 *   登记为 artifact**，所以左栏「路径」视图里 `tb/`、`sim/`、`prj/constr/` 三个
 *   分组在当前后端下永远是空的——这是后端事实，不是 mock 偷懒。
 * - artifactId = `art-<stage>-<sha8(agentId:task)>`，因此**不同 run 的产物是不同的
 *   artifact**。项目里两轮 run ⇒ 10 个 artifact，当前选中 run 之外的 5 个没有
 *   docs 可关联，会落进左栏的「未关联当前任务」分组（这是真实边界，留着测它）。
 * - 文档路径取自 `runtime/deps.ts` 的 docPath；RTL 路径为 `rtl/<首个源文件>`。
 *
 * 两轮 run 复用同一批真机作业记录，所以同一个 jobId 会在两轮里各出现一次。
 */

import type {
  Artifact,
  ArtifactRevision,
  CopyHistoricalMaterialResult,
  ProcessVersion,
  ProjectDetail,
  TaskAuditEvent,
  TaskDocRef,
  TaskEvidenceSummary,
  TaskAgentDetail,
  TaskAgentSummary,
  HistoricalMaterialSnapshot,
  SideTaskAdoptionResult,
  SideTaskConversationEvent,
  SideTaskDiff,
  SideTaskResult,
  SideTaskSummary,
} from "../api/types.ts";
import { VIVADO_FIXTURE } from "./vivado-fixture.ts";
import { DOC_INTAKE, DOC_BEHAVIOR, DOC_ARCH, DOC_REG } from "./docs.ts";
import { CONTENT_SHA } from "./content-hashes.ts";
import {
  isSafeSideTaskWritePath,
  parseSideTaskAdoptionResult,
  parseSideTaskConversationPage,
  parseSideTaskDiff,
  parseSideTaskList,
  parseSideTaskResult,
} from "../domain/side-tasks.ts";
import { sha256Bytes } from "../util/sha256.ts";

const FX = VIVADO_FIXTURE as {
  toolchain: { vivadoVersion: string; vivadoPatch: string; part: string; toolchainProfileHash: string; capabilityMapVersion: string };
  jobs: Record<string, { jobId: string; operation: string; status: string; inputSha256: string; errorCode?: string | null; entries: Array<{ name: string; sha256: string; sizeBytes: number; mediaType: string }> }>;
  stdout: Record<string, string>;
  reports: Record<string, string>;
  sources: Record<string, string>;
};

export const PROJECT_ID = "p1";
export const MOCK_PROJECT_HEAD_COMMIT = "1".repeat(40);
const TASK_TEXT = "做一个 8 位 PWM 发生器：占空比可配，复位低有效，跑通仿真并出码流。";

export const MOCK_CREATED_PROJECTS_STORAGE_KEY = "synthia.mock.created-projects.v1";
export const MOCK_P3_STATE_STORAGE_KEY = "synthia.mock.p3-state.v1";
const MOCK_P3_STATE_VERSION = 1;

function isStoredProject(value: unknown): value is ProjectDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const project = value as Record<string, unknown>;
  return (
    typeof project.id === "string" &&
    typeof project.name === "string" &&
    (project.project_type === "free" || project.project_type === "engineering") &&
    Array.isArray(project.process_instances)
  );
}

/** Decode only recognisable project rows so stale/corrupt browser state fails closed. */
export function parseStoredMockProjects(raw: string | null): ProjectDetail[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isStoredProject) : [];
  } catch {
    return [];
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function restoredCreatedProjects(): ProjectDetail[] {
  const storage = browserStorage();
  return storage ? parseStoredMockProjects(storage.getItem(MOCK_CREATED_PROJECTS_STORAGE_KEY)) : [];
}

interface StoredMockOperation<T> {
  readonly requestHash: string;
  readonly result: T;
}

/**
 * Reloadable P3-only mock facts. The envelope version is deliberately separate
 * from the storage key so schema mistakes fail closed instead of partially
 * hydrating an inconsistent task/adoption graph.
 */
export interface StoredMockP3State {
  readonly sideTasks: Record<string, SideTaskSummary[]>;
  readonly sideTaskResults: Record<string, SideTaskResult>;
  readonly sideTaskDiffs: Record<string, SideTaskDiff>;
  readonly sideTaskAdoptions: Record<string, StoredMockOperation<SideTaskAdoptionResult>>;
  readonly sideTaskCreateOperations: Record<string, StoredMockOperation<SideTaskSummary>>;
  readonly sideTaskEvents: Record<string, SideTaskConversationEvent[]>;
  readonly sideTaskMessageOperations: Record<string, StoredMockOperation<{ readonly accepted: true; readonly status: "running" }>>;
  readonly sideTaskPollCounts: Record<string, number>;
  readonly projectHeadCommits: Record<string, string>;
  /** Only artifacts/revisions created by a side-task adoption are stored. */
  readonly adoptionArtifacts: Record<string, Artifact[]>;
  readonly adoptionRevisions: Record<string, ArtifactRevision[]>;
  readonly adoptionRevisionContent: Record<string, string>;
}

interface StoredMockP3Envelope {
  readonly version: typeof MOCK_P3_STATE_VERSION;
  readonly state: StoredMockP3State;
}

const HASH_RE = /^[0-9a-f]{64}$/i;
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function storedObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function storedIsoTime(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function parseStoredSideTasks(value: unknown): Record<string, SideTaskSummary[]> {
  const record = storedObject(value, "sideTasks");
  return Object.fromEntries(Object.entries(record).map(([projectId, rows]) => {
    const tasks = parseSideTaskList(rows);
    if (tasks.some((task) => task.project_id !== projectId)) {
      throw new Error("stored side task belongs to another project");
    }
    return [projectId, tasks];
  }));
}

function parseStoredSideTaskResults(value: unknown): Record<string, SideTaskResult> {
  const record = storedObject(value, "sideTaskResults");
  return Object.fromEntries(Object.entries(record).map(([taskId, row]) => {
    const result = parseSideTaskResult(row);
    if (result.task_id !== taskId) throw new Error("stored side-task result id mismatch");
    return [taskId, result];
  }));
}

function parseStoredSideTaskDiffs(value: unknown): Record<string, SideTaskDiff> {
  const record = storedObject(value, "sideTaskDiffs");
  return Object.fromEntries(Object.entries(record).map(([taskId, row]) => {
    const diff = parseSideTaskDiff(row);
    if (diff.task_id !== taskId) throw new Error("stored side-task diff id mismatch");
    return [taskId, diff];
  }));
}

function parseStoredOperations<T>(
  value: unknown,
  label: string,
  parseResult: (value: unknown) => T,
): Record<string, StoredMockOperation<T>> {
  const record = storedObject(value, label);
  return Object.fromEntries(Object.entries(record).map(([key, raw]) => {
    const operation = storedObject(raw, `${label}.${key}`);
    if (typeof operation.requestHash !== "string" || !HASH_RE.test(operation.requestHash)) {
      throw new Error(`${label}.${key}.requestHash must be a digest`);
    }
    return [key, { requestHash: operation.requestHash.toLowerCase(), result: parseResult(operation.result) }];
  }));
}

function parseStoredEvents(value: unknown): Record<string, SideTaskConversationEvent[]> {
  const record = storedObject(value, "sideTaskEvents");
  return Object.fromEntries(Object.entries(record).map(([taskId, raw]) => {
    if (!Array.isArray(raw)) throw new Error(`sideTaskEvents.${taskId} must be an array`);
    const page = parseSideTaskConversationPage({
      task_id: taskId,
      events: raw,
      next_after: raw.length > 0
        ? storedObject(raw.at(-1), `sideTaskEvents.${taskId}.last`).sequence
        : 0,
    });
    return [taskId, [...page.events]];
  }));
}

function parseStoredCounts(value: unknown): Record<string, number> {
  const record = storedObject(value, "sideTaskPollCounts");
  return Object.fromEntries(Object.entries(record).map(([taskId, count]) => {
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`sideTaskPollCounts.${taskId} must be a non-negative integer`);
    }
    return [taskId, count as number];
  }));
}

function parseStoredCommits(value: unknown): Record<string, string> {
  const record = storedObject(value, "projectHeadCommits");
  return Object.fromEntries(Object.entries(record).map(([projectId, commit]) => {
    if (typeof commit !== "string" || !COMMIT_RE.test(commit)) {
      throw new Error(`projectHeadCommits.${projectId} must be a commit`);
    }
    return [projectId, commit.toLowerCase()];
  }));
}

function parseStoredArtifacts(value: unknown): Record<string, Artifact[]> {
  const record = storedObject(value, "adoptionArtifacts");
  return Object.fromEntries(Object.entries(record).map(([projectId, raw]) => {
    if (!Array.isArray(raw)) throw new Error(`adoptionArtifacts.${projectId} must be an array`);
    const artifacts = raw.map((value, index): Artifact => {
      const row = storedObject(value, `adoptionArtifacts.${projectId}.${index}`);
      if (typeof row.id !== "string" || !row.id.startsWith("side-") || typeof row.artifact_type !== "string") {
        throw new Error("stored adoption artifact is invalid");
      }
      return {
        id: row.id,
        artifact_type: row.artifact_type,
        created_at: storedIsoTime(row.created_at, "adoption artifact created_at"),
      };
    });
    if (new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length) {
      throw new Error("stored adoption artifacts contain duplicate ids");
    }
    return [projectId, artifacts];
  }));
}

function parseStoredRevisions(value: unknown): Record<string, ArtifactRevision[]> {
  const record = storedObject(value, "adoptionRevisions");
  return Object.fromEntries(Object.entries(record).map(([artifactId, raw]) => {
    if (!Array.isArray(raw)) throw new Error(`adoptionRevisions.${artifactId} must be an array`);
    const revisions = raw.map((value, index): ArtifactRevision => {
      const row = storedObject(value, `adoptionRevisions.${artifactId}.${index}`);
      if (
        typeof row.id !== "string" || !row.id.startsWith("side_rev_") ||
        !Number.isSafeInteger(row.version) || (row.version as number) <= 0 ||
        row.state !== "candidate" ||
        typeof row.content_hash !== "string" || !HASH_RE.test(row.content_hash) ||
        typeof row.content_location !== "string" || !isSafeSideTaskWritePath(row.content_location) ||
        (row.title !== undefined && row.title !== null && typeof row.title !== "string")
      ) {
        throw new Error("stored adoption revision is invalid");
      }
      return {
        id: row.id,
        version: row.version as number,
        state: "candidate",
        content_hash: row.content_hash.toLowerCase(),
        content_location: row.content_location,
        title: row.title as string | null | undefined,
        created_at: storedIsoTime(row.created_at, "adoption revision created_at"),
      };
    });
    if (new Set(revisions.map((revision) => revision.id)).size !== revisions.length) {
      throw new Error("stored adoption revisions contain duplicate ids");
    }
    return [artifactId, revisions];
  }));
}

function parseStoredRevisionContent(value: unknown): Record<string, string> {
  const record = storedObject(value, "adoptionRevisionContent");
  return Object.fromEntries(Object.entries(record).map(([revisionId, content]) => {
    if (!revisionId.startsWith("side_rev_") || typeof content !== "string" || new TextEncoder().encode(content).byteLength > 1024 * 1024) {
      throw new Error("stored adoption revision content is invalid");
    }
    return [revisionId, content];
  }));
}

/** Parse a simulated browser-reload snapshot; any malformed field rejects the whole graph. */
export function parseStoredMockP3State(raw: string | null): StoredMockP3State | null {
  if (!raw) return null;
  try {
    const envelope = storedObject(JSON.parse(raw) as unknown, "P3 mock envelope");
    if (envelope.version !== MOCK_P3_STATE_VERSION) return null;
    const state = storedObject(envelope.state, "P3 mock state");
    const parsed: StoredMockP3State = {
      sideTasks: parseStoredSideTasks(state.sideTasks),
      sideTaskResults: parseStoredSideTaskResults(state.sideTaskResults),
      sideTaskDiffs: parseStoredSideTaskDiffs(state.sideTaskDiffs),
      sideTaskAdoptions: parseStoredOperations(
        state.sideTaskAdoptions,
        "sideTaskAdoptions",
        parseSideTaskAdoptionResult,
      ),
      sideTaskCreateOperations: parseStoredOperations(
        state.sideTaskCreateOperations,
        "sideTaskCreateOperations",
        (value) => parseSideTaskList([value])[0]!,
      ),
      sideTaskEvents: parseStoredEvents(state.sideTaskEvents),
      sideTaskMessageOperations: parseStoredOperations(
        state.sideTaskMessageOperations,
        "sideTaskMessageOperations",
        (value) => {
          const result = storedObject(value, "side-task message result");
          if (result.accepted !== true || result.status !== "running") {
            throw new Error("stored side-task message result is invalid");
          }
          return { accepted: true as const, status: "running" as const };
        },
      ),
      sideTaskPollCounts: parseStoredCounts(state.sideTaskPollCounts),
      projectHeadCommits: parseStoredCommits(state.projectHeadCommits),
      adoptionArtifacts: parseStoredArtifacts(state.adoptionArtifacts),
      adoptionRevisions: parseStoredRevisions(state.adoptionRevisions),
      adoptionRevisionContent: parseStoredRevisionContent(state.adoptionRevisionContent),
    };

    const knownTasks = new Set(Object.values(parsed.sideTasks).flat().map((task) => task.task_id));
    for (const [taskId, result] of Object.entries(parsed.sideTaskResults)) {
      if (!knownTasks.has(taskId) || result.task_id !== taskId) throw new Error("orphaned side-task result");
    }
    for (const [taskId, diff] of Object.entries(parsed.sideTaskDiffs)) {
      if (!knownTasks.has(taskId) || !parsed.sideTaskResults[taskId] || diff.result_id !== parsed.sideTaskResults[taskId]!.result_id) {
        throw new Error("orphaned side-task diff");
      }
    }
    for (const taskId of Object.keys(parsed.sideTaskEvents)) {
      if (!knownTasks.has(taskId)) throw new Error("orphaned side-task events");
    }
    for (const revisions of Object.values(parsed.adoptionRevisions)) {
      for (const revision of revisions) {
        const content = parsed.adoptionRevisionContent[revision.id];
        if (content === undefined || sha256Bytes(new TextEncoder().encode(content)) !== revision.content_hash) {
          throw new Error("stored adoption content does not match its sealed hash");
        }
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

function restoredMockP3State(): StoredMockP3State | null {
  const storage = browserStorage();
  return storage ? parseStoredMockP3State(storage.getItem(MOCK_P3_STATE_STORAGE_KEY)) : null;
}

export const MOCK_PROCESS_VERSIONS: readonly ProcessVersion[] = [
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
];

// ─────────────────────────────────────────────────────────────────────
// 项目详情
// ─────────────────────────────────────────────────────────────────────

export const MOCK_PROJECT: ProjectDetail = {
  id: PROJECT_ID,
  name: "PWM 发生器（8 位可配占空比）",
  status: "active",
  data_classification: "internal",
  created_at: "2026-08-14T02:31:00.000Z",
  project_type: "engineering",
  process_version_id: "GJB_REF_V1",
  process_profile_id: "GJB_REF_V1",
  process_profile_version: "GJB_REF_V1",
  process_profile_name: "GJB 参考流程 v1",
  scope: "单模块 RTL，Kintex-7 目标板 smoke 验证",
  standard_version: "GB/T 33781-2017",
  target_part: FX.toolchain.part,
  toolchain_profile_ref: FX.toolchain.toolchainProfileHash,
  process_instances: [
    { id: "pi_p1_G0", gate_profile_version: "GJB_REF_V1", current_gate: "G4", created_at: "2026-08-14T02:31:00.000Z" },
  ],
};

export const MOCK_LEGACY_PROJECT: ProjectDetail = {
  id: "legacy-p1",
  name: "迁移前兼容项目",
  status: "active",
  data_classification: "D1",
  created_at: "2026-08-13T02:31:00.000Z",
  project_type: "engineering",
  process_version_id: "LEGACY_COMPAT",
  process_profile_id: "LEGACY_COMPAT",
  process_profile_version: "LEGACY_COMPAT",
  process_profile_name: "兼容旧流程",
  scope: "",
  standard_version: "GB/T 33781-2017",
  target_part: "xc7vx690tffg1761-2",
  toolchain_profile_ref: null,
  process_instances: [],
};

// ─────────────────────────────────────────────────────────────────────
// 文档正文（手写；没有模型后端可跑，见文件头说明）
// ─────────────────────────────────────────────────────────────────────

const RTL_V2 = FX.sources["pwm_gen.v"]!;
const RTL_V1 = FX.sources["pwm_gen.v@v1"]!;

// ─────────────────────────────────────────────────────────────────────
// artifact / revision（每轮 run 各 5 个 artifact，见文件头口径）
// ─────────────────────────────────────────────────────────────────────

interface DocSpec {
  readonly stage: string;
  readonly artifactType: string;
  readonly path: string;
  readonly title: string;
  readonly content: string;
}

const DOC_SPECS: readonly DocSpec[] = [
  { stage: "intake", artifactType: "DEVELOPMENT_REQUIREMENTS", path: "doc/intake/summary.md", title: "intake document", content: DOC_INTAKE },
  { stage: "behavior_wave", artifactType: "DETAILED_DESIGN", path: "doc/spec/behavior_spec.md", title: "behavior_wave document", content: DOC_BEHAVIOR },
  { stage: "architecture", artifactType: "ARCHITECTURE_DESIGN", path: "doc/arch/module_partition.md", title: "architecture document", content: DOC_ARCH },
  { stage: "register_spec", artifactType: "DETAILED_DESIGN", path: "doc/reg/register_map.md", title: "register_spec document", content: DOC_REG },
];

const RTL_PATH = "rtl/pwm_gen.v";

interface AgentArtifacts {
  readonly artifacts: readonly Artifact[];
  readonly revisions: Readonly<Record<string, readonly ArtifactRevision[]>>;
  readonly content: Readonly<Record<string, string>>;
  readonly docs: readonly TaskDocRef[];
  /** stage → revision_id，audit 的 governance 事件按它拼 action 文本。 */
  readonly revisionByStage: Readonly<Record<string, string>>;
  /** RTL 第一版（草稿）修订 id，供 audit 的第一轮登记事件引用。 */
  readonly rtlDraftRevisionId: string;
}

/**
 * 造一轮 run 的 5 个 artifact。
 *
 * @param suffix        artifactId 的 sha8 位（真实实现里是 sha256(agentId:task) 前 8 位）
 * @param baseTs        产物创建时间基准
 * @param rtlApproved   RTL 最新修订是否已批准（succeeded 的 run 为 true → 编辑器只读）
 */
function buildAgentArtifacts(suffix: string, baseTs: string, rtlApproved: boolean): AgentArtifacts {
  const artifacts: Artifact[] = [];
  const revisions: Record<string, readonly ArtifactRevision[]> = {};
  const content: Record<string, string> = {};
  const docs: TaskDocRef[] = [];
  const revisionByStage: Record<string, string> = {};
  const base = Date.parse(baseTs);
  const at = (offsetSec: number): string => new Date(base + offsetSec * 1000).toISOString();

  DOC_SPECS.forEach((spec, i) => {
    const artifactId = `art-${spec.stage}-${suffix}`;
    const revisionId = `rev-${spec.stage}-${suffix}-1`;
    artifacts.push({ id: artifactId, artifact_type: spec.artifactType, created_at: at(i * 40) });
    revisions[artifactId] = [
      {
        id: revisionId,
        version: 1,
        state: "approved",
        content_hash: CONTENT_SHA[spec.stage]!,
        content_location: spec.path,
        title: spec.title,
        created_at: at(i * 40),
      },
    ];
    content[revisionId] = spec.content;
    docs.push({ phase: spec.stage, path: spec.path, artifact_id: artifactId, revision_id: revisionId });
    revisionByStage[spec.stage] = revisionId;
  });

  // RTL：两版真源码（v1 = 比较符写反的草稿，v2 = 修好的版本）。
  const rtlId = `art-rtl-${suffix}`;
  const rtlRev1 = `rev-rtl-${suffix}-1`;
  const rtlRev2 = `rev-rtl-${suffix}-2`;
  artifacts.push({ id: rtlId, artifact_type: "RTL_SOURCE_SET", created_at: at(200) });
  revisions[rtlId] = [
    { id: rtlRev1, version: 1, state: "superseded", content_hash: CONTENT_SHA.rtl_v1!, content_location: RTL_PATH, title: "RTL top=pwm_gen", created_at: at(200) },
    { id: rtlRev2, version: 2, state: rtlApproved ? "approved" : "candidate", content_hash: CONTENT_SHA.rtl_v2!, content_location: RTL_PATH, title: "RTL top=pwm_gen", created_at: at(340) },
  ];
  content[rtlRev1] = RTL_V1;
  content[rtlRev2] = RTL_V2;
  docs.push({ phase: "rtl_build", path: RTL_PATH, artifact_id: rtlId, revision_id: rtlRev2 });
  revisionByStage.rtl_build = rtlRev2;

  return { artifacts, revisions, content, docs, revisionByStage, rtlDraftRevisionId: rtlRev1 };
}

// ─────────────────────────────────────────────────────────────────────
// audit 事件（形态严格照抄 runtime/loop.ts 的 action 文本）
// ─────────────────────────────────────────────────────────────────────

class AuditBuilder {
  private seq = 0;
  private tsMs: number;
  readonly events: TaskAuditEvent[] = [];

  constructor(startIso: string) {
    this.tsMs = Date.parse(startIso);
  }

  /** 推进 @advanceSec 秒后追加一条事件。 */
  push(advanceSec: number, event: Omit<TaskAuditEvent, "ts" | "seq">): void {
    this.tsMs += advanceSec * 1000;
    this.seq += 1;
    this.events.push({ ts: new Date(this.tsMs).toISOString(), seq: this.seq, ...event });
  }

  get nowIso(): string {
    return new Date(this.tsMs).toISOString();
  }
}

/** 门审查三连（创建快照 → 提交 → 批准）。 */
function gateReview(b: AuditBuilder, gate: string, revisionCount: number): void {
  b.push(2, { category: "gate", phase: "gate_review", action: `${gate}: creating snapshot (${revisionCount} revisions)`, result: "ok" });
  b.push(1, { category: "gate", phase: "gate_review", action: `${gate}: submitting for review`, result: "ok" });
  b.push(4, { category: "gate", phase: "gate_review", action: `${gate}: approved — continuing`, result: "ok" });
}

/** 一次工具调用：权限门 + tool_call（真机 jobId / inputSha256 / 成败 / 耗时）。 */
function toolCall(b: AuditBuilder, jobKey: string, durationSec: number): void {
  const job = FX.jobs[jobKey]!;
  const op = job.operation;
  b.push(1, { category: "gate", phase: op, action: `gate ok (${FX.toolchain.capabilityMapVersion})`, result: "ok" });
  const ok = job.status === "succeeded";
  b.push(durationSec, {
    category: "tool_call",
    phase: op,
    action: ok ? `${op} succeeded` : `${op} ${job.status}`,
    inputSha256: job.inputSha256,
    jobId: job.jobId,
    result: ok ? "ok" : "failed",
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
  });
}

function evidenceOf(jobKey: string): TaskEvidenceSummary {
  const job = FX.jobs[jobKey]!;
  return {
    jobId: job.jobId,
    operation: job.operation,
    status: job.status,
    inputSha256: job.inputSha256,
    entries: job.entries,
  };
}

/**
 * 实现阶段的 Agent 叙述（**手写**，本地没有模型后端）。
 *
 * 拆成小块是给 SSE 逐块吐用的；拼起来的整段同时作为 `free_agent_reply` 落进
 * 已完成 run 的 audit——真实链路里就是这样：SSE 负责即时性，audit 负责权威性，
 * 两边文本一致时前端按文本指纹去重（见 ProjectView 的 parts 合成）。
 */
export const IMPLEMENT_NARRATION: readonly string[] = [
  "综合已经过了，",
  "资源占用很小：",
  "LUT 12 个、FF 17 个，",
  `在 ${FX.toolchain.part} 上基本可以忽略。\n\n`,
  "现在跑实现，",
  "顺序是 opt_design → place_design → route_design，",
  "然后出 DRC / 时序 / 资源三份报告，",
  "最后写比特流。\n\n",
  "约束里我把 NSTD-1 和 UCIO-1 降成了 Warning——",
  "这一轮是 smoke 验证，没有绑定物理引脚，",
  "不降级的话 write_bitstream 会被 DRC 直接挡下来。\n\n",
  "布线完成，时序收敛（WNS 为正），DRC 无 error。",
  "比特流 synthia.bit 已生成，3,011,427 字节。",
];

/** SSE 与 audit 共用的整段叙述文本（两边必须完全一致，否则前端会渲染两遍）。 */
export const IMPLEMENT_NARRATION_TEXT = IMPLEMENT_NARRATION.join("");

/**
 * 造 audit：需求 → G1 → 行为 → G2 → 架构/寄存器 → G3 → RTL 草稿 → 编译检查 →
 * TB → 仿真失败（真机 v1）→ 修复 → RTL v2 → 编译检查 → 仿真通过 → XDC → 综合 →
 * 实现 → G4 → 完成。`stopAfter` 用来把 running 的 run 停在某一步。
 */
function buildAudit(
  startIso: string,
  art: AgentArtifacts,
  stopAfter: "implement-gate" | "loop-succeeded",
): { events: readonly TaskAuditEvent[]; evidence: readonly TaskEvidenceSummary[]; endIso: string } {
  const b = new AuditBuilder(startIso);
  const evidence: TaskEvidenceSummary[] = [];
  const gov = (stage: string, revisionId: string, detail: string): void => {
    b.push(1, { category: "governance", phase: "governance", action: `registered ${stage} artifact: ${revisionId}`, result: "ok", detail });
  };

  b.push(6, { category: "model", phase: "generate_intake", action: "intake doc generated: doc/intake/summary.md", detail: "doc/intake/summary.md", result: "ok" });
  gov("intake", art.revisionByStage.intake!, "type=DEVELOPMENT_REQUIREMENTS path=doc/intake/summary.md");
  gateReview(b, "G1", 1);

  b.push(9, { category: "model", phase: "generate_behavior_wave", action: "behavior/wave doc generated: doc/spec/behavior_spec.md", detail: "doc/spec/behavior_spec.md", result: "ok" });
  gov("behavior_wave", art.revisionByStage.behavior_wave!, "type=DETAILED_DESIGN path=doc/spec/behavior_spec.md");
  gateReview(b, "G2", 2);

  b.push(11, { category: "model", phase: "generate_architecture", action: "architecture doc generated: doc/arch/module_partition.md", detail: "doc/arch/module_partition.md", result: "ok" });
  gov("architecture", art.revisionByStage.architecture!, "type=ARCHITECTURE_DESIGN path=doc/arch/module_partition.md");
  b.push(7, { category: "model", phase: "generate_register_spec", action: "register spec generated: doc/reg/register_map.md", detail: "doc/reg/register_map.md", result: "ok" });
  gov("register_spec", art.revisionByStage.register_spec!, "type=DETAILED_DESIGN path=doc/reg/register_map.md");
  gateReview(b, "G3", 4);

  // 第一轮：草稿 RTL（真机 v1，比较符写反）
  b.push(14, { category: "model", phase: "generate_rtl", action: "rtl generated: pwm_gen.v", detail: "top=pwm_gen", result: "ok" });
  gov("RTL", art.rtlDraftRevisionId, "top=pwm_gen");
  toolCall(b, "validate_sources@v1", 12);
  evidence.push(evidenceOf("validate_sources@v1"));
  b.push(8, { category: "model", phase: "generate_testbench", action: "testbench generated: pwm_gen_tb.v", detail: "top=pwm_gen_tb", result: "ok" });
  toolCall(b, "simulate@v1", 23);
  evidence.push(evidenceOf("simulate@v1"));

  // 修复循环：诊断 → 改 RTL → 重跑
  b.push(2, { category: "tool_call", phase: "repair", action: "diagnostics_fetched=true", result: "ok" });
  b.push(13, { category: "model", phase: "repair", action: "repair round 1 applied", detail: "cnt > duty → cnt < duty", result: "ok" });
  gov("RTL", art.revisionByStage.rtl_build!, "top=pwm_gen");
  toolCall(b, "validate_sources", 13);
  evidence.push(evidenceOf("validate_sources"));
  toolCall(b, "simulate", 32);
  evidence.push(evidenceOf("simulate"));

  b.push(6, { category: "model", phase: "generate_xdc", action: "xdc generated: pwm_gen.xdc", detail: "create_clock 10.000ns", result: "ok" });
  toolCall(b, "synthesize", 24);
  evidence.push(evidenceOf("synthesize"));

  if (stopAfter === "implement-gate") {
    // running 的 run 停在这里：权限门已过 = 工具条 running，叙述正由 SSE 逐字吐出，
    // 所以此时 audit 里还没有对应的 free_agent_reply。
    b.push(1, { category: "gate", phase: "implement", action: `gate ok (${FX.toolchain.capabilityMapVersion})`, result: "ok" });
    return { events: b.events, evidence, endIso: b.nowIso };
  }

  b.push(3, { category: "model", phase: "free_agent", action: "free_agent_reply", detail: IMPLEMENT_NARRATION_TEXT, result: "ok" });
  toolCall(b, "implement", 69);
  evidence.push(evidenceOf("implement"));
  gateReview(b, "G4", 5);
  b.push(1, { category: "loop", phase: "loop", action: "loop succeeded", result: "ok" });
  return { events: b.events, evidence, endIso: b.nowIso };
}

// ─────────────────────────────────────────────────────────────────────
// 两轮 run（老的已完成；新的停在实现阶段，由 SSE 推到完成）
// ─────────────────────────────────────────────────────────────────────

const AGENT_A = "agent-2026081603-8f21ac";
const AGENT_B = "agent-2026081714-3d09be";

const ART_A = buildAgentArtifacts("8f21ac41", "2026-08-16T03:12:00.000Z", true);
const ART_B = buildAgentArtifacts("3d09be07", "2026-08-17T14:03:00.000Z", false);

const AUDIT_A = buildAudit("2026-08-16T03:12:00.000Z", ART_A, "loop-succeeded");
const AUDIT_B_RUNNING = buildAudit("2026-08-17T14:03:00.000Z", ART_B, "implement-gate");
const AUDIT_B_DONE = buildAudit("2026-08-17T14:03:00.000Z", ART_B, "loop-succeeded");

export const MOCK_ARTIFACTS: readonly Artifact[] = [...ART_B.artifacts, ...ART_A.artifacts];

export const MOCK_REVISIONS: Readonly<Record<string, readonly ArtifactRevision[]>> = {
  ...ART_A.revisions,
  ...ART_B.revisions,
};

export const MOCK_CONTENT: Readonly<Record<string, string>> = { ...ART_A.content, ...ART_B.content };

// ─────────────────────────────────────────────────────────────────────
// P2 历史资料库（规范化 JSON 快照；不伪装成真实 Core/Git 导入）
// ─────────────────────────────────────────────────────────────────────

const MOCK_MATERIAL_PENDING_FILES = [
  {
    id: "mat-file-pending-rtl",
    file_id: "mat-file-pending-rtl",
    snapshot_id: "import-snap-pending-p1",
    path: "rtl/pwm_gen.v",
    bytes: 1820,
    size_bytes: 1820,
    content_hash: "1".repeat(64),
    media_type: "text/plain",
    valid: true,
    searchable: false,
    created_at: "2026-08-21T02:00:00.000Z",
    content: RTL_V2,
  },
  {
    id: "mat-file-pending-readme",
    file_id: "mat-file-pending-readme",
    snapshot_id: "import-snap-pending-p1",
    path: "README.md",
    bytes: 540,
    size_bytes: 540,
    content_hash: "2".repeat(64),
    media_type: "text/markdown",
    valid: true,
    searchable: false,
    created_at: "2026-08-21T02:00:00.000Z",
    content: "# 历史 PWM 参考\n\n这是一份待人工确认的资料快照。",
  },
] as const;

const MOCK_MATERIAL_CONFIRMED_FILES = [
  {
    id: "mat-file-confirmed-rtl",
    file_id: "mat-file-confirmed-rtl",
    snapshot_id: "import-snap-confirmed-p1",
    path: "rtl/counter.v",
    bytes: 812,
    size_bytes: 812,
    content_hash: "3".repeat(64),
    media_type: "text/plain",
    valid: true,
    searchable: true,
    created_at: "2026-08-18T04:00:00.000Z",
    content: "module counter(input logic clk, output logic [7:0] q);\n  always_ff @(posedge clk) q <= q + 1'b1;\nendmodule\n",
  },
] as const;

export const MOCK_IMPORT_SNAPSHOTS: readonly HistoricalMaterialSnapshot[] = [
  {
    id: "import-snap-confirmed-p1",
    snapshot_id: "import-snap-confirmed-p1",
    project_id: PROJECT_ID,
    source_kind: "project",
    source_project_id: "legacy-p1",
    source_name: "迁移前兼容项目",
    source_hash: "4".repeat(64),
    source_commit: "a".repeat(40),
    commit: "a".repeat(40),
    status: "confirmed",
    valid: true,
    searchable: true,
    expires_at: null,
    files: MOCK_MATERIAL_CONFIRMED_FILES,
    created_at: "2026-08-18T04:00:00.000Z",
    confirmed_at: "2026-08-18T04:10:00.000Z",
    denied_at: null,
    denial_reason: null,
    failure_reason: null,
  },
  {
    id: "import-snap-pending-p1",
    snapshot_id: "import-snap-pending-p1",
    project_id: PROJECT_ID,
    source_kind: "local_directory",
    source_project_id: null,
    source_name: "本地 PWM 资料目录",
    source_hash: "5".repeat(64),
    source_commit: null,
    commit: null,
    status: "pending_confirmation",
    valid: true,
    searchable: false,
    expires_at: null,
    files: MOCK_MATERIAL_PENDING_FILES,
    created_at: "2026-08-21T02:00:00.000Z",
    confirmed_at: null,
    denied_at: null,
    denial_reason: null,
    failure_reason: null,
  },
];

// ─────────────────────────────────────────────────────────────────────
// P3 探索任务（独立于主 Agent；只有人工采纳才改变项目读模型）
// ─────────────────────────────────────────────────────────────────────

const SIDE_SCOPE = {
  schema: "task-scope.v1",
  workspace: "isolated",
  read_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
  write_paths: ["rtl/pwm_gen.v", "tb/pwm_gen_explore_tb.sv", "doc/arch/exploration.md"],
  run_classes: ["exploratory"],
  can_submit_gates: false,
  can_create_milestones: false,
  can_start_formal_runs: false,
} as const;

const SIDE_SUCCEEDED_ID = "side-pipeline-compare";

const SIDE_RTL_CONTENT = `module pwm_gen (
  input  logic       clk,
  input  logic       rst_n,
  input  logic [7:0] duty,
  output logic       pwm_out
);
  logic [7:0] counter;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      counter <= '0;
      pwm_out <= 1'b0;
    end else begin
      counter <= counter + 1'b1;
      pwm_out <= counter < duty;
    end
  end
endmodule
`;

const SIDE_TB_CONTENT = `module pwm_gen_explore_tb;
  logic clk = 1'b0;
  logic rst_n = 1'b0;
  logic [7:0] duty = 8'd64;
  logic pwm_out;

  always #5 clk = ~clk;
  pwm_gen dut (.*);

  initial begin
    repeat (2) @(posedge clk);
    rst_n = 1'b1;
    repeat (256) @(posedge clk);
    $finish;
  end
endmodule
`;

const SIDE_DOC_CONTENT = `# 流水线探索记录

## 权衡

一级流水线改善关键路径，但输出增加一拍延迟。组合方案保持零拍延迟，适合当前较低目标频率。

## 建议

暂时只采纳探索性 testbench；RTL 方案待主线接口时序确认后再决定。
`;

const SIDE_RTL_HASH = sha256Bytes(new TextEncoder().encode(SIDE_RTL_CONTENT));
const SIDE_TB_HASH = sha256Bytes(new TextEncoder().encode(SIDE_TB_CONTENT));
const SIDE_DOC_HASH = sha256Bytes(new TextEncoder().encode(SIDE_DOC_CONTENT));

/** Full candidate bytes sealed by the mock result; adoption stores these, never a diff snippet. */
export const MOCK_SIDE_TASK_CONTENTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [SIDE_SUCCEEDED_ID]: {
    "rtl/pwm_gen.v": SIDE_RTL_CONTENT,
    "tb/pwm_gen_explore_tb.sv": SIDE_TB_CONTENT,
    "doc/arch/exploration.md": SIDE_DOC_CONTENT,
  },
};

export const MOCK_SIDE_TASKS: readonly SideTaskSummary[] = [
  {
    task_id: "side-counter-width",
    project_id: PROJECT_ID,
    kind: "side",
    parent_task_id: AGENT_B,
    workspace_id: "ws-side-counter-width",
    objective: "比较 8 位与 10 位计数器对资源和时序的影响",
    status: "running",
    input_hash: "a".repeat(64),
    output_hash: null,
    adoption_state: "pending",
    authorization_scope: {
      schema: "task-scope.v1",
      workspace: "isolated",
      read_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
      write_paths: ["rtl/pwm_gen.v"],
      run_classes: ["exploratory"],
      can_submit_gates: false,
      can_create_milestones: false,
      can_start_formal_runs: false,
    },
    base_commit: MOCK_PROJECT_HEAD_COMMIT,
    base_manifest_hash: "2".repeat(64),
    workspace_state: "active",
    created_at: "2026-08-21T03:20:00.000Z",
    updated_at: "2026-08-21T03:23:00.000Z",
    finished_at: null,
    failure_reason: null,
  },
  {
    task_id: SIDE_SUCCEEDED_ID,
    project_id: PROJECT_ID,
    kind: "side",
    parent_task_id: AGENT_B,
    workspace_id: "ws-side-pipeline-compare",
    objective: "比较组合比较器与一级流水线实现，并补充探索性测试",
    status: "succeeded",
    input_hash: "b".repeat(64),
    output_hash: "c".repeat(64),
    adoption_state: "available",
    authorization_scope: SIDE_SCOPE,
    base_commit: MOCK_PROJECT_HEAD_COMMIT,
    base_manifest_hash: "2".repeat(64),
    workspace_state: "sealed",
    created_at: "2026-08-21T02:15:00.000Z",
    updated_at: "2026-08-21T02:22:00.000Z",
    finished_at: "2026-08-21T02:22:00.000Z",
    failure_reason: null,
  },
  {
    task_id: "side-invalid-constraint",
    project_id: PROJECT_ID,
    kind: "side",
    parent_task_id: AGENT_B,
    workspace_id: "ws-side-invalid-constraint",
    objective: "尝试替换正式时序约束（应安全停止）",
    status: "fail_closed",
    input_hash: "d".repeat(64),
    output_hash: null,
    adoption_state: "pending",
    authorization_scope: {
      schema: "task-scope.v1",
      workspace: "isolated",
      read_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
      write_paths: ["prj/constr/top.xdc"],
      run_classes: ["exploratory"],
      can_submit_gates: false,
      can_create_milestones: false,
      can_start_formal_runs: false,
    },
    base_commit: MOCK_PROJECT_HEAD_COMMIT,
    base_manifest_hash: "2".repeat(64),
    workspace_state: "failed",
    created_at: "2026-08-21T01:40:00.000Z",
    updated_at: "2026-08-21T01:41:00.000Z",
    finished_at: "2026-08-21T01:41:00.000Z",
    failure_reason: "探索任务请求了授权范围外的写入，Core 已拒绝并保留审计事实。",
  },
];

export const MOCK_SIDE_TASK_RESULTS: Readonly<Record<string, SideTaskResult>> = {
  [SIDE_SUCCEEDED_ID]: {
    result_id: "result-pipeline-compare",
    task_id: SIDE_SUCCEEDED_ID,
    workspace_id: "ws-side-pipeline-compare",
    base_commit: MOCK_PROJECT_HEAD_COMMIT,
    result_commit: "3".repeat(40),
    summary: "流水线方案改善了关键路径；新增一份探索性 testbench，并记录结构权衡。主工作区尚未发生变化。",
    tests: [
      { name: "bun run check", status: "passed", detail: null },
      { name: "Vivado xsim exploratory", status: "passed", detail: "64/64 个占空比采样通过" },
    ],
    files: [
      {
        path: "rtl/pwm_gen.v",
        change_kind: "modified",
        base_hash: "4".repeat(64),
        result_hash: SIDE_RTL_HASH,
        size_bytes: new TextEncoder().encode(SIDE_RTL_CONTENT).byteLength,
      },
      {
        path: "tb/pwm_gen_explore_tb.sv",
        change_kind: "added",
        base_hash: null,
        result_hash: SIDE_TB_HASH,
        size_bytes: new TextEncoder().encode(SIDE_TB_CONTENT).byteLength,
      },
      {
        path: "doc/arch/exploration.md",
        change_kind: "modified",
        base_hash: "7".repeat(64),
        result_hash: SIDE_DOC_HASH,
        size_bytes: new TextEncoder().encode(SIDE_DOC_CONTENT).byteLength,
      },
    ],
    output_hash: "c".repeat(64),
    created_at: "2026-08-21T02:22:00.000Z",
  },
};

export const MOCK_SIDE_TASK_DIFFS: Readonly<Record<string, SideTaskDiff>> = {
  [SIDE_SUCCEEDED_ID]: {
    task_id: SIDE_SUCCEEDED_ID,
    result_id: "result-pipeline-compare",
    preview_hash: "9".repeat(64),
    files: [
      {
        path: "rtl/pwm_gen.v",
        change_kind: "modified",
        base_hash: "4".repeat(64),
        result_hash: SIDE_RTL_HASH,
        current_target_hash: "f".repeat(64),
        diff: "@@ -18,3 +18,5 @@\n-assign pwm_out = counter < duty;\n+always_ff @(posedge clk)\n+  pwm_out <= counter < duty;",
        conflict_reason: "主工作区中的 rtl/pwm_gen.v 已在探索任务启动后变化。",
        adopted: false,
      },
      {
        path: "tb/pwm_gen_explore_tb.sv",
        change_kind: "added",
        base_hash: null,
        result_hash: SIDE_TB_HASH,
        current_target_hash: null,
        diff: "@@ -0,0 +1,5 @@\n+module pwm_gen_explore_tb;\n+  // exploratory coverage\n+endmodule",
        conflict_reason: null,
        adopted: false,
      },
      {
        path: "doc/arch/exploration.md",
        change_kind: "modified",
        base_hash: "7".repeat(64),
        result_hash: SIDE_DOC_HASH,
        current_target_hash: "7".repeat(64),
        diff: "@@ -3,2 +3,4 @@\n ## 权衡\n+一级流水线改善关键路径，但输出增加一拍延迟。",
        conflict_reason: null,
        adopted: false,
      },
    ],
  },
};

const SUMMARY_A: TaskAgentSummary = {
  agent_id: AGENT_A,
  task_id: AGENT_A,
  project_id: PROJECT_ID,
  kind: "main",
  status: "succeeded",
  current_stage: "implement",
  awaiting_gate: null,
  base_commit: MOCK_PROJECT_HEAD_COMMIT,
  created_at: "2026-08-16T03:12:00.000Z",
};

const DETAIL_A: TaskAgentDetail = {
  ...SUMMARY_A,
  task: TASK_TEXT,
  docs: ART_A.docs,
  audit: AUDIT_A.events,
  evidence: AUDIT_A.evidence,
  reason: null,
};

const SUMMARY_B_RUNNING: TaskAgentSummary = {
  agent_id: AGENT_B,
  task_id: AGENT_B,
  project_id: PROJECT_ID,
  kind: "main",
  status: "running",
  current_stage: "implement",
  awaiting_gate: null,
  base_commit: MOCK_PROJECT_HEAD_COMMIT,
  created_at: "2026-08-17T14:03:00.000Z",
};

const DETAIL_B_RUNNING: TaskAgentDetail = {
  ...SUMMARY_B_RUNNING,
  task: TASK_TEXT,
  docs: ART_B.docs,
  audit: AUDIT_B_RUNNING.events,
  evidence: AUDIT_B_RUNNING.evidence,
  reason: null,
};

const SUMMARY_B_DONE: TaskAgentSummary = { ...SUMMARY_B_RUNNING, status: "succeeded" };

const DETAIL_B_DONE: TaskAgentDetail = {
  ...SUMMARY_B_DONE,
  task: TASK_TEXT,
  docs: ART_B.docs,
  audit: AUDIT_B_DONE.events,
  evidence: AUDIT_B_DONE.evidence,
  reason: null,
};

/**
 * 可变的 mock 运行态：新 run 起初是 running，SSE 脚本播完后翻成 succeeded
 * （前端轮询随即拉到完整 audit + 码流成功卡）。
 */
const restoredP3 = restoredMockP3State();

export const mockState = {
  agentBDone: false,
  /** 通过 mock POST /projects 新建的项目；持久化后整页刷新仍可打开。 */
  createdProjects: restoredCreatedProjects(),
  /** 用户在 mock 里新建/发送的消息，回显进对话流。 */
  extraUserMessages: [] as Array<{ agentId: string; text: string; ts: string }>,
  /** P2 快照按 projectId 隔离；资料默认不跨项目共享。 */
  importSnapshots: { [PROJECT_ID]: [...MOCK_IMPORT_SNAPSHOTS] } as Record<string, HistoricalMaterialSnapshot[]>,
  /** 历史资料复制后真实落入 Mock 产物/修订读模型，供工作台刷新与 v2 验证。 */
  importArtifacts: restoredP3?.adoptionArtifacts ?? {} as Record<string, Artifact[]>,
  importRevisions: restoredP3?.adoptionRevisions ?? {} as Record<string, ArtifactRevision[]>,
  importRevisionContent: restoredP3?.adoptionRevisionContent ?? {} as Record<string, string>,
  /** copy 写操作按 HTTP 幂等键缓存；同键异体 fail closed。 */
  importCopyOperations: {} as Record<string, {
    readonly requestHash: string;
    readonly result: CopyHistoricalMaterialResult;
  }>,
  /** P3 任务事实、密封结果与 diff 均按 project/task 隔离。 */
  sideTasks: restoredP3?.sideTasks ?? { [PROJECT_ID]: MOCK_SIDE_TASKS.map((task) => ({ ...task })) } as Record<string, SideTaskSummary[]>,
  sideTaskResults: restoredP3?.sideTaskResults ?? Object.fromEntries(
    Object.entries(MOCK_SIDE_TASK_RESULTS).map(([taskId, result]) => [taskId, { ...result, files: [...result.files], tests: [...result.tests] }]),
  ) as Record<string, SideTaskResult>,
  sideTaskDiffs: restoredP3?.sideTaskDiffs ?? Object.fromEntries(
    Object.entries(MOCK_SIDE_TASK_DIFFS).map(([taskId, diff]) => [taskId, { ...diff, files: diff.files.map((file) => ({ ...file })) }]),
  ) as Record<string, SideTaskDiff>,
  sideTaskAdoptions: restoredP3?.sideTaskAdoptions ?? {} as Record<string, {
    readonly requestHash: string;
    readonly result: SideTaskAdoptionResult;
  }>,
  sideTaskCreateOperations: restoredP3?.sideTaskCreateOperations ?? {} as Record<string, {
    readonly requestHash: string;
    readonly result: SideTaskSummary;
  }>,
  sideTaskEvents: restoredP3?.sideTaskEvents ?? {} as Record<string, SideTaskConversationEvent[]>,
  sideTaskMessageOperations: restoredP3?.sideTaskMessageOperations ?? {} as Record<string, {
    readonly requestHash: string;
    readonly result: { readonly accepted: true; readonly status: "running" };
  }>,
  sideTaskPollCounts: restoredP3?.sideTaskPollCounts ?? {} as Record<string, number>,
  projectHeadCommits: restoredP3?.projectHeadCommits ?? { [PROJECT_ID]: MOCK_PROJECT_HEAD_COMMIT } as Record<string, string>,
};

export function persistCreatedMockProjects(): void {
  const storage = browserStorage();
  if (!storage) return;
  storage.setItem(MOCK_CREATED_PROJECTS_STORAGE_KEY, JSON.stringify(mockState.createdProjects));
}

function persistedAdoptionArtifacts(): Record<string, Artifact[]> {
  return Object.fromEntries(Object.entries(mockState.importArtifacts).flatMap(([projectId, artifacts]) => {
    const adopted = artifacts.filter((artifact) => artifact.id.startsWith("side-"));
    return adopted.length > 0 ? [[projectId, adopted.map((artifact) => ({ ...artifact }))]] : [];
  }));
}

function persistedAdoptionRevisions(): Record<string, ArtifactRevision[]> {
  return Object.fromEntries(Object.entries(mockState.importRevisions).flatMap(([artifactId, revisions]) => {
    const adopted = revisions.filter((revision) => revision.id.startsWith("side_rev_"));
    return adopted.length > 0 ? [[artifactId, adopted.map((revision) => ({ ...revision }))]] : [];
  }));
}

function p3StateEnvelope(): StoredMockP3Envelope {
  const adoptionRevisions = persistedAdoptionRevisions();
  const revisionIds = new Set(Object.values(adoptionRevisions).flat().map((revision) => revision.id));
  return {
    version: MOCK_P3_STATE_VERSION,
    state: {
      sideTasks: mockState.sideTasks,
      sideTaskResults: mockState.sideTaskResults,
      sideTaskDiffs: mockState.sideTaskDiffs,
      sideTaskAdoptions: mockState.sideTaskAdoptions,
      sideTaskCreateOperations: mockState.sideTaskCreateOperations,
      sideTaskEvents: mockState.sideTaskEvents,
      sideTaskMessageOperations: mockState.sideTaskMessageOperations,
      sideTaskPollCounts: mockState.sideTaskPollCounts,
      projectHeadCommits: mockState.projectHeadCommits,
      adoptionArtifacts: persistedAdoptionArtifacts(),
      adoptionRevisions,
      adoptionRevisionContent: Object.fromEntries(
        Object.entries(mockState.importRevisionContent).filter(([revisionId]) => revisionIds.has(revisionId)),
      ),
    },
  };
}

/** Persist the coherent P3 graph after each successful mock write/state transition. */
export function persistMockP3State(): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(MOCK_P3_STATE_STORAGE_KEY, JSON.stringify(p3StateEnvelope()));
  } catch {
    // Mock persistence must never turn an otherwise valid API response into a failure.
  }
}

/**
 * Apply the same validated snapshot that a fresh page module load consumes.
 * Exported so tests can simulate a full reload without relying on module-cache tricks.
 */
export function restorePersistedMockP3State(): boolean {
  const restored = restoredMockP3State();
  if (!restored) return false;
  mockState.sideTasks = restored.sideTasks;
  mockState.sideTaskResults = restored.sideTaskResults;
  mockState.sideTaskDiffs = restored.sideTaskDiffs;
  mockState.sideTaskAdoptions = restored.sideTaskAdoptions;
  mockState.sideTaskCreateOperations = restored.sideTaskCreateOperations;
  mockState.sideTaskEvents = restored.sideTaskEvents;
  mockState.sideTaskMessageOperations = restored.sideTaskMessageOperations;
  mockState.sideTaskPollCounts = restored.sideTaskPollCounts;
  mockState.projectHeadCommits = restored.projectHeadCommits;
  mockState.importArtifacts = restored.adoptionArtifacts;
  mockState.importRevisions = restored.adoptionRevisions;
  mockState.importRevisionContent = restored.adoptionRevisionContent;
  return true;
}

export const LIVE_AGENT_ID = AGENT_B;

export function mockAgents(): readonly TaskAgentSummary[] {
  return [mockState.agentBDone ? SUMMARY_B_DONE : SUMMARY_B_RUNNING, SUMMARY_A];
}

/**
 * 运行记录面板「查看内容」的离线回填：按 jobId 找到 `FX.jobs` 里的作业，校验
 * `name` 确实是该作业的证据条目之一，正文取 `FX.stdout[operation]`（真机
 * stdout 全文，唯一现成的可读文本源；条目本身如 worker-result.json 的真实字节
 * 未落进本仓库）。找不到作业或条目 → null，路由层据此回 404，对齐真实后端语义。
 */
export function mockJobEvidenceContent(jobId: string, name: string): { name: string; content: string; sha256: string; truncated: boolean; mediaType: string } | null {
  const job = Object.values(FX.jobs).find((j) => j.jobId === jobId);
  if (!job) return null;
  const entry = job.entries.find((e) => e.name === name);
  if (!entry) return null;
  const stdout = (FX.stdout as Record<string, string>)[job.operation];
  return {
    name: entry.name,
    content: stdout ?? `(mock：${job.operation} 无原始 stdout 快照)`,
    sha256: entry.sha256,
    truncated: false,
    mediaType: entry.mediaType,
  };
}

export function mockAgentDetail(agentId: string): TaskAgentDetail | null {
  const base =
    agentId === AGENT_A ? DETAIL_A : agentId === AGENT_B ? (mockState.agentBDone ? DETAIL_B_DONE : DETAIL_B_RUNNING) : null;
  if (!base) return null;
  const extras = mockState.extraUserMessages.filter((m) => m.agentId === agentId);
  if (extras.length === 0) return base;
  const lastSeq = base.audit.reduce((n, e) => Math.max(n, e.seq), 0);
  const appended: TaskAuditEvent[] = [];
  extras.forEach((m, i) => {
    appended.push({
      ts: m.ts,
      seq: lastSeq + i * 2 + 1,
      category: "model",
      phase: "free_agent",
      action: "user_message",
      detail: m.text,
      result: "ok",
    });
    appended.push({
      ts: m.ts,
      seq: lastSeq + i * 2 + 2,
      category: "model",
      phase: "free_agent",
      action: "free_agent_reply",
      detail: MOCK_REPLY_TEXT,
      result: "ok",
    });
  });
  return { ...base, audit: [...base.audit, ...appended] };
}

/** mock 模式下对用户消息的固定回复：明说这里没有模型，别让人误以为是真回答。 */
const MOCK_REPLY_TEXT =
  "（离线 mock 模式）这一页的数据来自 worker-66 的真机 Vivado 产物快照，但**没有模型后端在跑**，" +
  "所以我没法真的回答你这条消息。要看真实对话，需要连上 Core 与 Runtime 后去掉 `VITE_MOCK=1`。";
