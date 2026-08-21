/**
 * Synthia Core API 契约类型（字段与 Contract 一致，不得私改）。
 */

export type ProjectType = "free" | "engineering";

export interface ProcessInstance {
  readonly id: string;
  readonly gate_profile_version: string;
  readonly current_gate: string;
  readonly created_at: string;
}

/** P1 formalization relation returned for a project copied from a free/legacy source. */
export interface ProjectSourceRelation {
  readonly source_project_id: string;
  readonly target_project_id: string;
  readonly relation_kind: "copied_as_engineering";
  readonly created_by_type: string;
  readonly created_by: string;
  readonly created_at: string;
}

/** GET /api/v1/projects 的列表项。 */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly data_classification: string;
  readonly created_at: string;
  readonly project_type: ProjectType;
  readonly process_version_id: string | null;
  readonly process_profile_id: string | null;
  readonly process_profile_name: string | null;
  readonly process_profile_version: string | null;
  readonly target_part: string | null;
  readonly process_instances: readonly ProcessInstance[];
  readonly source_relation?: ProjectSourceRelation | null;
}

interface CreateProjectRequestBase {
  readonly id: string;
  readonly name: string;
  readonly data_classification?: string;
  readonly target_part?: string | null;
}

/** POST /api/v1/projects 请求；工程项目的流程版本在类型层就是必填项。 */
export type CreateProjectRequest =
  | (CreateProjectRequestBase & {
      readonly project_type: "free";
      readonly process_profile_id?: null;
    })
  | (CreateProjectRequestBase & {
      readonly project_type: "engineering";
      readonly process_profile_id: string;
    });

/** POST /api/v1/projects 响应；Core 不在创建响应中返回列表专用的时间与分类字段。 */
export interface CreateProjectResult {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly project_type: ProjectType;
  readonly process_version_id: string | null;
  readonly process_profile_id: string | null;
  readonly process_profile_name: string | null;
  readonly process_profile_version: string | null;
  readonly target_part: string | null;
  readonly process_instances: readonly ProcessInstance[];
  readonly source_relation?: ProjectSourceRelation | null;
  readonly workspace_content_copied?: boolean;
}

/** POST /projects/:id/copy-as-engineering request. Project configuration is copied by Core. */
export interface CopyProjectAsEngineeringRequest {
  readonly id: string;
  readonly name: string;
  readonly target_part?: string | null;
}

export interface GateSubmission {
  readonly id: string;
  readonly gate: string;
  readonly state: string;
  readonly snapshot_id: string;
  readonly process_instance_id: string;
  readonly submitter_id: string;
  readonly submitted_at: string | null;
  readonly created_at: string;
}

/** GET /projects/:id/gate-submissions/:subId 返回的完整提交（含检查结果与问题）。 */
export interface GateSubmissionDetail extends GateSubmission {
  readonly project_id: string;
  readonly check_results: unknown;
  readonly issues: readonly string[];
}

export interface Baseline {
  readonly id: string;
  readonly project_id: string;
  readonly kind: string;
  readonly state: string;
  readonly approved_gate_result_id: string;
  readonly member_revision_ids: readonly string[];
  readonly created_at: string;
  readonly superseded_by_baseline_id: string | null;
}

export interface OutboxEvent {
  readonly event_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly payload: unknown;
  readonly correlation_id: string;
  readonly classification: string;
  readonly occurred_at: string;
}

export interface Artifact {
  readonly id: string;
  readonly artifact_type: string;
  readonly created_at: string;
}

export interface ArtifactRevision {
  readonly id: string;
  readonly version: number;
  readonly state: string;
  readonly content_hash: string;
  readonly content_location: string;
  readonly title?: string | null;
  readonly created_at: string;
}

export interface RevisionContent {
  readonly content: string;
  readonly content_hash: string;
}

// ─── P2 历史资料库（导入快照 / 确认 / 检索 / 复制）──────────────────────────

/** 导入资料的来源类型。首版不接受 Git 仓库，避免把工作树语义混入固定快照。 */
export type ImportSnapshotSourceKind = "project" | "local_directory" | "zip";

/**
 * 导入快照的治理状态。`valid` 不是状态，而是资料是否仍可作为默认上下文的
 * 独立事实；只有 `confirmed && valid` 才能被搜索和复制为候选。
 */
export type ImportSnapshotStatus = "pending_confirmation" | "confirmed" | "denied" | "failed" | "expired";

/** POST /projects/:id/import-snapshots.files 的规范化 JSON 文件条目。 */
export interface ImportSnapshotFileInput {
  readonly path: string;
  readonly content: string;
  readonly media_type?: string;
}

/** `GET /import-snapshots` 返回的固定快照文件条目。 */
export interface HistoricalMaterialFile {
  readonly id: string;
  readonly file_id: string;
  readonly snapshot_id: string;
  readonly path: string;
  readonly bytes: number;
  readonly size_bytes: number;
  readonly content_hash: string;
  readonly media_type: string;
  readonly valid: boolean;
  readonly searchable: boolean;
  readonly created_at: string;
  /** 待确认快照详情可带正文；列表/搜索通常省略，避免把资料库整包下发。 */
  readonly content?: string;
  readonly content_base64?: string;
}

/** 导入请求；Core 会再次执行路径、敏感文件和大小限制校验。 */
export interface CreateImportSnapshotRequest {
  readonly id?: string;
  readonly source_kind: ImportSnapshotSourceKind;
  readonly source_project_id?: string;
  readonly commit?: string;
  readonly source_name?: string;
  readonly source_hash?: string;
  readonly expires_at?: string | null;
  /** project 来源可由 Core 按 source_project_id + commit 读取固定 Git 树。 */
  readonly files?: readonly ImportSnapshotFileInput[];
}

/** `POST /projects/:id/import-snapshots` 与列表项共用的快照摘要。 */
export interface HistoricalMaterialSnapshot {
  readonly id: string;
  readonly snapshot_id: string;
  readonly project_id: string;
  readonly source_kind: ImportSnapshotSourceKind;
  readonly source_project_id: string | null;
  readonly source_name: string | null;
  readonly source_hash: string;
  readonly source_commit: string | null;
  readonly commit: string | null;
  readonly status: ImportSnapshotStatus;
  readonly valid: boolean;
  readonly searchable: boolean;
  readonly expires_at: string | null;
  readonly files: readonly HistoricalMaterialFile[];
  readonly created_at: string;
  readonly confirmed_at: string | null;
  readonly denied_at: string | null;
  readonly denial_reason: string | null;
  readonly failure_reason: string | null;
}

/** POST /:snapshotId/deny。理由可选，但若填写会进入审计记录。 */
export interface DenyImportSnapshotRequest {
  readonly reason?: string;
}

/** GET /search?q= 的资料条目；只返回 `confirmed && valid` 的结果。 */
export interface HistoricalMaterialSearchResult extends HistoricalMaterialFile {
  readonly project_id: string;
  readonly source_name: string | null;
  readonly status: "confirmed";
  readonly source_kind: ImportSnapshotSourceKind;
  readonly source_project_id: string | null;
  readonly source_hash: string;
  readonly snippet?: string | null;
}

/** Canonical GET /import-snapshots/search response. */
export interface HistoricalMaterialSearchResponse {
  readonly items: readonly HistoricalMaterialSearchResult[];
  readonly results?: readonly HistoricalMaterialSearchResult[];
  readonly query: string;
  readonly total: number;
}

/** POST /:snapshotId/copy 请求；复制后一定生成当前项目的新候选修订。 */
export interface CopyHistoricalMaterialRequest {
  readonly id: string;
  readonly name: string;
  readonly artifact_type?: string;
  readonly file_ids: readonly string[];
}

/** 复制结果；Core 可附带具体 artifact/revision 身份，UI 只展示已复制数量。 */
export interface CopyHistoricalMaterialResult {
  readonly id: string;
  readonly snapshot_id: string;
  readonly project_id: string;
  readonly candidate: true;
  readonly revision_ids: readonly string[];
  readonly copied_files: readonly {
    readonly file_id: string;
    readonly path: string;
    readonly revision_id: string;
    readonly artifact_id: string;
    readonly version: number;
  }[];
  readonly revisions: readonly {
    readonly id: string;
    readonly artifact_id: string;
    readonly project_id: string;
    readonly version: number;
    readonly state: "candidate";
    readonly file_id: string;
    readonly path: string;
    readonly content_hash: string;
  }[];
  readonly source_relations: readonly {
    readonly id: string;
    readonly snapshot_id: string;
    readonly entry_id: string;
    readonly target_revision_id: string;
    readonly relation_kind: "imported_candidate";
  }[];
}

// ─── 磁盘工作区（内容与版本谱系归 git，治理状态归 Postgres）────────────────────

/**
 * 一个工作区文件相对「已登记的最新一版」的处境。
 *
 * - `registered` — 盘上这份字节与 git 里的一致，且已有对应修订；
 * - `dirty` — 已登记过，但盘上被改动过（人在编辑器/vim 里改的，还没点登记）；
 * - `untracked` — 盘上有、git 里没有：刚新建、从没登记过；
 * - `ignored` — `sim/` 下的仿真产物。按 `rules/25` §1 它是**证据不是产物**，
 *   永不登记，也不该出现在待登记计数里。
 */
export type WorkspaceFileStatus = "registered" | "dirty" | "untracked" | "ignored";

/** `GET /projects/:id/workspace/tree` 的一行。artifact 侧字段在文件尚未登记时全为 null。 */
export interface WorkspaceTreeFile {
  readonly path: string;
  readonly status: WorkspaceFileStatus;
  readonly bytes: number;
  readonly modified_at: string;
  readonly artifact_id: string | null;
  readonly revision_id: string | null;
  readonly version: number | null;
  readonly revision_state: string | null;
  readonly content_hash: string | null;
}

export interface WorkspaceTree {
  readonly project_id: string;
  readonly files: readonly WorkspaceTreeFile[];
  /** dirty + untracked 的条数，也就是顶栏「工作区有 N 个改动」里的 N。 */
  readonly pending_count: number;
}

/**
 * `GET /workspace/file` 的响应：工作区**当前**内容（含尚未登记的改动）。
 *
 * `registered` 是拿这份字节的 sha256 与该产物最新一版的 content_hash 比出来的，
 * 不是看 git status——人把文件改坏又改回来时 status 会说 dirty，可字节确实就是登记
 * 的那一版。`commit` 只在 registered 为真时给出。
 */
export interface WorkspaceFileContent {
  readonly path: string;
  readonly content: string;
  readonly content_hash: string;
  readonly registered: boolean;
  readonly artifact_id: string | null;
  readonly revision_id: string | null;
  readonly version: number | null;
  readonly commit: string | null;
}

/** `PUT /workspace/file` 的响应。`changed=false` 表示内容与盘上原样相同，树不必刷新。 */
export interface WorkspaceWriteResult {
  readonly path: string;
  readonly changed: boolean;
  readonly content_hash: string;
}

/** 一键登记后新出的（或本就相同的）一版。 */
export interface WorkspaceRegisteredFile {
  readonly path: string;
  readonly artifact_id: string;
  readonly revision_id: string;
  readonly version: number;
  readonly content_hash: string;
}

/** `POST /workspace/register` 的响应。一次 commit 对应 N 条修订，见 workspace-handlers.ts。 */
export interface WorkspaceRegisterResult {
  readonly commit: string;
  /** 本次 commit 实际收进去的路径（同 key 重放时为空数组）。 */
  readonly committed: readonly string[];
  readonly registered: readonly WorkspaceRegisteredFile[];
  /** 字节与最新一版完全相同、因而没出新版的文件——连同它指向的那一版。 */
  readonly unchanged: readonly WorkspaceRegisteredFile[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

/** snapshot.created 事件 payload（解析快照成员修订）。 */
export interface SnapshotCreatedPayload {
  readonly id: string;
  readonly projectId: string;
  readonly manifestHash: string;
  readonly memberRevisionIds: readonly string[];
}

// ─── 任务工作台（UI-2：Core 代理转发 Runtime，字段与 Contract 一致）─────────────

/** POST /projects/:id/tasks 请求体（process_instance_id 由 Core 懒加载默认流程实例）。 */
export interface CreateTaskRequest {
  readonly task: string;
  readonly part?: string;
  /** "agent" = 自由 Agent 会话（不启动流程循环）；统一项目页「新任务」引导使用。 */
  readonly mode?: "agent";
}

/** POST /projects/:id/tasks 成功响应 data。 */
export interface CreateTaskResult {
  readonly agentId: string;
}

/** GET /projects/:id/tasks 列表项。 */
export interface TaskAgentSummary {
  readonly agent_id: string;
  readonly project_id: string;
  readonly status: string;
  readonly current_stage: string | null;
  readonly awaiting_gate: string | null;
  readonly created_at: string;
}

/** GET /projects/:id/tasks 响应 data。 */
export interface TaskAgentList {
  readonly agents: readonly TaskAgentSummary[];
}

/** 任务产物引用（Runtime 登记产物时透传 artifact_id / revision_id）。 */
export interface TaskDocRef {
  readonly phase: string;
  readonly path: string;
  readonly artifact_id: string;
  readonly revision_id: string;
}

/** Runtime audit 事件（runtime/types.ts AuditEvent 镜像）。 */
export interface TaskAuditEvent {
  readonly ts: string;
  readonly seq: number;
  readonly category: string;
  readonly phase: string;
  readonly action: string;
  readonly inputSha256?: string;
  readonly jobId?: string;
  readonly result?: string;
  readonly errorCode?: string;
  readonly detail?: string;
}

/** 证据清单条目（runtime/types.ts EvidenceSummary 镜像）。 */
export interface TaskEvidenceSummary {
  readonly jobId: string;
  readonly operation: string;
  readonly status: string;
  readonly inputSha256: string;
  readonly entries: ReadonlyArray<{
    readonly name: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly mediaType: string;
  }>;
}

/** GET /projects/:id/tasks/:agentId 响应 data。 */
export interface TaskAgentDetail extends TaskAgentSummary {
  /** 任务指令（Runtime 透传 agent-state.task）。 */
  readonly task?: string;
  readonly docs: readonly TaskDocRef[];
  readonly audit: readonly TaskAuditEvent[];
  readonly evidence: readonly TaskEvidenceSummary[];
  readonly reason?: string | null;
}

/** POST .../message 响应 data（runtime 已改流式，agent 回复不再随此响应返回，走 SSE）。 */
export interface SendMessageResult {
  /** running 会话走 steer 时为 true。 */
  readonly steered?: boolean;
  /** free-agent 会话状态（idle/running/awaiting_approval/completed/cancelled/failed）。 */
  readonly status: string;
}

/** POST .../abort 响应 data。 */
export interface AbortAgentResult {
  readonly aborted: boolean;
  /** 无活动会话时为 null。 */
  readonly status?: string | null;
  readonly reason?: string;
}

// ─── 统一项目页（UI-3：项目详情 + 工具运行记录）────────────────────────────

/** GET /projects/:id 响应 data（getProject：Project 字段 + 流程实例列表）。 */
export interface ProjectDetail extends Project {
  readonly scope: string;
  readonly standard_version: string;
  readonly toolchain_profile_ref: string | null;
}

/** GET /api/v1/process-versions 的可选流程版本。 */
export interface ProcessVersion {
  readonly id: string;
  readonly profile_id: string;
  readonly name: string;
  readonly version: string;
  readonly status: "active";
  readonly process_profile_id: string;
  readonly process_profile_version: string;
  readonly process_profile_name: string;
}

/** GET /projects/:id/jobs 列表项（tool_run 行镜像；startTime/endTime 可为 null）。 */
export interface JobRunSummary {
  readonly id: string;
  readonly operation: string;
  readonly runClass: string;
  readonly state: string;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly errorCode?: string;
}

/** GET /projects/:id/jobs/:jobId/evidence 响应 data（终态任务的冻结证据清单）。 */
export interface JobEvidenceManifest {
  readonly jobId: string;
  readonly entries: ReadonlyArray<{
    readonly name: string;
    readonly uri?: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly mediaType: string;
  }>;
}

/** GET /projects/:id/jobs/:jobId/evidence/content?name= 响应 data。 */
export interface JobEvidenceContent {
  readonly name: string;
  readonly content: string;
  readonly sha256: string;
  readonly truncated: boolean;
  readonly mediaType: string;
}
