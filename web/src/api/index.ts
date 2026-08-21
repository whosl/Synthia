/**
 * Core API 端点函数（路径与字段严格按 Contract）。
 */

import type { ApiClient } from "./client.ts";
import type {
  AbortAgentResult,
  Artifact,
  ArtifactRevision,
  Baseline,
  CreateProjectRequest,
  CreateProjectResult,
  CopyProjectAsEngineeringRequest,
  CreateTaskRequest,
  CreateTaskResult,
  GateSubmission,
  GateSubmissionDetail,
  CreateImportSnapshotRequest,
  CopyHistoricalMaterialRequest,
  CopyHistoricalMaterialResult,
  DenyImportSnapshotRequest,
  HistoricalMaterialSearchResult,
  HistoricalMaterialSearchResponse,
  HistoricalMaterialSnapshot,
  JobEvidenceContent,
  JobEvidenceManifest,
  JobRunSummary,
  OutboxEvent,
  Project,
  ProjectDetail,
  ProcessVersion,
  RevisionContent,
  SendMessageResult,
  TaskAgentDetail,
  TaskAgentList,
  WorkspaceFileContent,
  WorkspaceRegisterResult,
  WorkspaceTree,
  WorkspaceWriteResult,
} from "./types.ts";

const V1 = "/api/v1";

export function listProjects(client: ApiClient): Promise<Project[]> {
  return client<Project[]>(`${V1}/projects`);
}

export type { CreateProjectRequest, CreateProjectResult } from "./types.ts";
export type { CopyProjectAsEngineeringRequest } from "./types.ts";

/** 新建项目（服务端缺省：分类 D1、标准 GB/T 33781-2017；写操作带 Idempotency-Key）。 */
export function createProject(client: ApiClient, body: CreateProjectRequest, idempotencyKey: string): Promise<CreateProjectResult> {
  return client<CreateProjectResult>(`${V1}/projects`, {
    method: "POST",
    body,
    headers: { "idempotency-key": idempotencyKey },
  });
}

/** Core 注册的 active 工程流程版本；调用方必须对加载失败和空列表 fail closed。 */
export function listProcessVersions(client: ApiClient): Promise<ProcessVersion[]> {
  return client<ProcessVersion[]>(`${V1}/process-versions`);
}

/** Formalize a free/legacy project by creating a new engineering project in Core. */
export function copyProjectAsEngineering(
  client: ApiClient,
  sourceProjectId: string,
  body: CopyProjectAsEngineeringRequest,
  idempotencyKey: string,
): Promise<CreateProjectResult> {
  return client<CreateProjectResult>(
    `${V1}/projects/${encodeURIComponent(sourceProjectId)}/copy-as-engineering`,
    {
      method: "POST",
      body,
      headers: { "idempotency-key": idempotencyKey },
    },
  );
}

export function listGateSubmissions(client: ApiClient, projectId: string, state?: string): Promise<GateSubmission[]> {
  const query = state ? `?state=${encodeURIComponent(state)}` : "";
  return client<GateSubmission[]>(`${V1}/projects/${encodeURIComponent(projectId)}/gate-submissions${query}`);
}

export function getGateSubmission(client: ApiClient, projectId: string, subId: string): Promise<GateSubmissionDetail> {
  return client<GateSubmissionDetail>(
    `${V1}/projects/${encodeURIComponent(projectId)}/gate-submissions/${encodeURIComponent(subId)}`,
  );
}

export function listBaselines(client: ApiClient, projectId: string): Promise<Baseline[]> {
  return client<Baseline[]>(`${V1}/projects/${encodeURIComponent(projectId)}/baselines`);
}

export function listEvents(client: ApiClient, projectId: string, filter?: { aggregateType?: string; aggregateId?: string }): Promise<OutboxEvent[]> {
  const params = new URLSearchParams();
  if (filter?.aggregateType) params.set("aggregate_type", filter.aggregateType);
  if (filter?.aggregateId) params.set("aggregate_id", filter.aggregateId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return client<OutboxEvent[]>(`${V1}/projects/${encodeURIComponent(projectId)}/events${query}`);
}

export function listArtifacts(client: ApiClient, projectId: string): Promise<Artifact[]> {
  return client<Artifact[]>(`${V1}/projects/${encodeURIComponent(projectId)}/artifacts`);
}

export function listRevisions(client: ApiClient, projectId: string, artifactId: string): Promise<ArtifactRevision[]> {
  return client<ArtifactRevision[]>(
    `${V1}/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/revisions`,
  );
}

export function getRevisionContent(client: ApiClient, projectId: string, artifactId: string, revId: string): Promise<RevisionContent> {
  return client<RevisionContent>(
    `${V1}/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/revisions/${encodeURIComponent(revId)}/content`,
  );
}

// ─── P2 历史资料库（固定导入快照）────────────────────────────────────────────

/** 列出项目资料快照；默认按创建时间由 Core 返回新到旧。 */
export function listImportSnapshots(client: ApiClient, projectId: string): Promise<HistoricalMaterialSnapshot[]> {
  return client<HistoricalMaterialSnapshot[]>(
    `${V1}/projects/${encodeURIComponent(projectId)}/import-snapshots`,
  );
}

/** 导入已规范化的 JSON 文件集合；Core 负责再次执行安全校验与快照哈希。 */
export function createImportSnapshot(
  client: ApiClient,
  projectId: string,
  body: CreateImportSnapshotRequest,
  idempotencyKey: string,
): Promise<HistoricalMaterialSnapshot> {
  return client<HistoricalMaterialSnapshot>(
    `${V1}/projects/${encodeURIComponent(projectId)}/import-snapshots`,
    { method: "POST", body, headers: { "idempotency-key": idempotencyKey } },
  );
}

/** 查看单个导入快照及其固定文件清单。 */
export function getImportSnapshot(client: ApiClient, projectId: string, snapshotId: string): Promise<HistoricalMaterialSnapshot> {
  return client<HistoricalMaterialSnapshot>(
    `${V1}/projects/${encodeURIComponent(projectId)}/import-snapshots/${encodeURIComponent(snapshotId)}`,
  );
}

/** 人工确认资料快照；确认后才可进入默认检索范围。 */
export function confirmImportSnapshot(
  client: ApiClient,
  projectId: string,
  snapshotId: string,
  idempotencyKey: string,
): Promise<HistoricalMaterialSnapshot> {
  return client<HistoricalMaterialSnapshot>(
    `${V1}/projects/${encodeURIComponent(projectId)}/import-snapshots/${encodeURIComponent(snapshotId)}/confirm`,
    { method: "POST", body: {}, headers: { "idempotency-key": idempotencyKey } },
  );
}

/** 否决资料快照；失败/否决资料永远不会默认进入 Agent 上下文。 */
export function denyImportSnapshot(
  client: ApiClient,
  projectId: string,
  snapshotId: string,
  body: DenyImportSnapshotRequest,
  idempotencyKey: string,
): Promise<HistoricalMaterialSnapshot> {
  return client<HistoricalMaterialSnapshot>(
    `${V1}/projects/${encodeURIComponent(projectId)}/import-snapshots/${encodeURIComponent(snapshotId)}/deny`,
    { method: "POST", body, headers: { "idempotency-key": idempotencyKey } },
  );
}

/** 搜索默认资料范围；Core 只返回 confirmed 且 valid 的文件条目。 */
export function searchHistoricalMaterials(
  client: ApiClient,
  projectId: string,
  query: string,
): Promise<HistoricalMaterialSearchResult[]> {
  const q = query.trim();
  const suffix = q ? `?q=${encodeURIComponent(q)}` : "?q=";
  return client<HistoricalMaterialSearchResponse>(
    `${V1}/projects/${encodeURIComponent(projectId)}/import-snapshots/search${suffix}`,
  ).then((response) => [...response.items]);
}

/** 把已确认资料的选中文件复制为当前项目的新候选修订。 */
export function copyHistoricalMaterial(
  client: ApiClient,
  projectId: string,
  snapshotId: string,
  body: CopyHistoricalMaterialRequest,
  idempotencyKey: string,
): Promise<CopyHistoricalMaterialResult> {
  return client<CopyHistoricalMaterialResult>(
    `${V1}/projects/${encodeURIComponent(projectId)}/import-snapshots/${encodeURIComponent(snapshotId)}/copy`,
    { method: "POST", body, headers: { "idempotency-key": idempotencyKey } },
  );
}

// ─── 磁盘工作区（内容与版本谱系归 git）──────────────────────────────────────

/** 真实盘上的文件树：每个文件带 registered/dirty/untracked/ignored 与对应修订身份。 */
export function getWorkspaceTree(client: ApiClient, projectId: string): Promise<WorkspaceTree> {
  return client<WorkspaceTree>(`${V1}/projects/${encodeURIComponent(projectId)}/workspace/tree`);
}

/** 读工作区**当前**内容（含尚未登记的改动），并告知这份字节是不是某条修订。 */
export function getWorkspaceFile(client: ApiClient, projectId: string, path: string): Promise<WorkspaceFileContent> {
  return client<WorkspaceFileContent>(
    `${V1}/projects/${encodeURIComponent(projectId)}/workspace/file?path=${encodeURIComponent(path)}`,
  );
}

/**
 * 编辑器保存：**只落盘不 commit**，改动随即变成 dirty，等人点【登记】。
 *
 * 不带 Idempotency-Key 是刻意的——服务端这条路不走幂等中间件：工作树里的未登记改动
 * 不是治理状态，PUT 同样内容两次结果相同，受治理的那一刻是 register。
 */
export function putWorkspaceFile(client: ApiClient, projectId: string, path: string, content: string): Promise<WorkspaceWriteResult> {
  return client<WorkspaceWriteResult>(`${V1}/projects/${encodeURIComponent(projectId)}/workspace/file`, {
    method: "PUT",
    body: { path, content },
  });
}

/** 一键登记：把工作区当前全部待登记改动收进**一个** commit，并逐个出候选修订。 */
export function registerWorkspace(
  client: ApiClient,
  projectId: string,
  changeReason: string,
  idempotencyKey: string,
): Promise<WorkspaceRegisterResult> {
  return client<WorkspaceRegisterResult>(`${V1}/projects/${encodeURIComponent(projectId)}/workspace/register`, {
    method: "POST",
    body: changeReason ? { change_reason: changeReason } : {},
    headers: { "idempotency-key": idempotencyKey },
  });
}

export interface ApproveRequest {
  readonly configuration_snapshot_id: string;
  readonly approved_gate_result_id: string;
  readonly approver_role: string;
  readonly check_results_hash: string;
  readonly signed_at: string;
  readonly signature_method: string;
  readonly reason?: string;
  readonly baseline_id: string | null;
}

/** 批准（里程碑门必须带 baseline_id；写操作必须带 Idempotency-Key）。 */
export function approveGateSubmission(client: ApiClient, projectId: string, subId: string, body: ApproveRequest, idempotencyKey: string): Promise<unknown> {
  return client(`${V1}/projects/${encodeURIComponent(projectId)}/gate-submissions/${encodeURIComponent(subId)}/approve`, {
    method: "POST",
    body,
    headers: { "idempotency-key": idempotencyKey },
  });
}

/** 驳回（reason 必填非空；非 in_review 服务端返回 409）。 */
export function rejectGateSubmission(client: ApiClient, projectId: string, subId: string, reason: string, idempotencyKey: string): Promise<unknown> {
  return client(`${V1}/projects/${encodeURIComponent(projectId)}/gate-submissions/${encodeURIComponent(subId)}/reject`, {
    method: "POST",
    body: { reason },
    headers: { "idempotency-key": idempotencyKey },
  });
}

// ─── 任务工作台（UI-2：Core 代理 → Runtime，UI 不直连 Runtime）─────────────────

/** 创建任务（body 只需 {task, part?}；process_instance_id 由 Core 懒加载默认流程实例）。 */
export function createTask(client: ApiClient, projectId: string, body: CreateTaskRequest, idempotencyKey: string): Promise<CreateTaskResult> {
  return client<CreateTaskResult>(`${V1}/projects/${encodeURIComponent(projectId)}/tasks`, {
    method: "POST",
    body,
    headers: { "idempotency-key": idempotencyKey },
  });
}

/** 项目任务列表（Core 已按 project 过滤）。 */
export function listTasks(client: ApiClient, projectId: string): Promise<TaskAgentList> {
  return client<TaskAgentList>(`${V1}/projects/${encodeURIComponent(projectId)}/tasks`);
}

/** 任务详情（Core 校验 project 归属，不匹配 404）。 */
export function getTask(client: ApiClient, projectId: string, agentId: string): Promise<TaskAgentDetail> {
  return client<TaskAgentDetail>(`${V1}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(agentId)}`);
}

// ─── 自由 Agent 对话（spec 001-agent-freedom：发消息/纠偏/终止）────────────────

/**
 * POST /tasks/:agentId/message — 给运行中的自由 Agent 发消息。
 * idle/终态会话走 prompt（新指令/闲聊，返回 reply）；running 会话走 steer（接管/纠偏）。
 */
export function sendMessage(
  client: ApiClient,
  projectId: string,
  agentId: string,
  text: string,
): Promise<SendMessageResult> {
  return client<SendMessageResult>(
    `${V1}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(agentId)}/message`,
    { method: "POST", body: { text } },
  );
}

/** POST /tasks/:agentId/abort — 终止自由 Agent 会话。 */
export function abortAgent(
  client: ApiClient,
  projectId: string,
  agentId: string,
): Promise<AbortAgentResult> {
  return client<AbortAgentResult>(
    `${V1}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(agentId)}/abort`,
    { method: "POST" },
  );
}

// ─── 统一项目页（UI-3：项目详情 + 工具运行记录）────────────────────────────

/** GET /projects/:id — 项目详情（名称等稳定字段）。 */
export function getProject(client: ApiClient, projectId: string): Promise<ProjectDetail> {
  return client<ProjectDetail>(`${V1}/projects/${encodeURIComponent(projectId)}`);
}

/** GET /projects/:id/jobs — 项目工具运行列表（新到旧；记录标签页）。 */
export function listJobs(client: ApiClient, projectId: string, limit?: number): Promise<JobRunSummary[]> {
  const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : "";
  return client<JobRunSummary[]>(`${V1}/projects/${encodeURIComponent(projectId)}/jobs${query}`);
}

/** GET /projects/:id/jobs/:jobId/evidence — 终态任务的冻结证据清单（非终态 404）。 */
export function getJobEvidence(client: ApiClient, projectId: string, jobId: string): Promise<JobEvidenceManifest> {
  return client<JobEvidenceManifest>(
    `${V1}/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/evidence`,
  );
}

/** GET /projects/:id/jobs/:jobId/evidence/content?name= — 单条证据解码内容。 */
export function getJobEvidenceContent(
  client: ApiClient,
  projectId: string,
  jobId: string,
  name: string,
): Promise<JobEvidenceContent> {
  return client<JobEvidenceContent>(
    `${V1}/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/evidence/content?name=${encodeURIComponent(name)}`,
  );
}
