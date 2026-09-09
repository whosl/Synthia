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
  /** P4 submissions always carry this; null/omitted is legacy read compatibility only. */
  readonly work_version_id?: string | null;
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
  /** P3 创建探索副本时必须绑定的项目当前 Git HEAD。旧 Core 可暂时省略。 */
  readonly head_commit?: string | null;
  /**
   * Core 用与 P4 readiness 完全同源的算法计算的工作区清单摘要。
   * Web 不从 files 反向猜测，因为 Core 的清单还包含 skippedBinary 事实。
   */
  readonly manifest_hash?: string | null;
  /** Preferred explicit P4 response name (compatibly accept manifest_hash above). */
  readonly workspace_manifest_hash?: string | null;
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
  /** P3 Core-owned task identity；兼容窗口内与 agent_id 相同。 */
  readonly task_id?: string;
  readonly project_id: string;
  readonly kind?: "main" | "side";
  /** Project = durable main dialogue; run = legacy/bounded execution history. */
  readonly agent_role?: "project" | "run" | "side";
  readonly status: string;
  readonly current_stage: string | null;
  readonly awaiting_gate: string | null;
  /** P4 Runtime 持久化的正式输入等待态；旧 Runtime 可省略。 */
  readonly formal_input?: TaskFormalInputState | null;
  /** 任务创建时冻结的输入提交；可作为 side task 的可信 base_commit。 */
  readonly base_commit?: string | null;
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

export interface TaskFormalInputState {
  readonly status: "awaiting_input_confirmation" | "running" | "awaiting_gate_approval";
  /** Runtime 为这份 preview 固定的 approval id，Web 确认时必须原样使用。 */
  readonly approval_id: string;
  readonly preview: FormalInputPreviewV1;
  /** Runtime 是四项正式运行的唯一编排者；Web 只展示这些持久化事实。 */
  readonly jobs?: Readonly<Partial<Record<FormalOperationV1, TaskFormalJobStateV1>>>;
}

export interface TaskFormalJobStateV1 {
  readonly job_id: string;
  readonly state: string;
  readonly evidence_manifest_id?: string;
  readonly evidence_manifest_hash?: string;
}

// ─── P3 独立探索任务 / 临时工作区 / 正式采纳 ───────────────────────────────

export type SideTaskStatus =
  | "queued"
  | "running"
  | "awaiting_user"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "fail_closed";

export type SideTaskAdoptionState =
  | "pending"
  | "available"
  | "partially_adopted"
  | "adopted"
  | "discarded";

export type SideTaskWorkspaceState =
  | "provisioning"
  | "active"
  | "sealed"
  | "failed"
  | "released";

export type SideTaskChangeKind = "added" | "modified";

/** task-scope.v1 第一切片固定能力；Web 不允许提交 glob 或升级运行类别。 */
export interface SideTaskAuthorizationScope {
  readonly schema: "task-scope.v1";
  readonly workspace: "isolated";
  readonly read_paths: readonly string[];
  readonly write_paths: readonly string[];
  readonly run_classes: readonly ["exploratory"];
  readonly can_submit_gates: false;
  readonly can_create_milestones: false;
  readonly can_start_formal_runs: false;
}

/** POST /projects/:projectId/tasks 的 side task 请求。 */
export interface CreateSideTaskRequest {
  readonly kind: "side";
  readonly parent_task_id: string;
  readonly objective: string;
  readonly base_commit: string;
  readonly authorization_scope: SideTaskAuthorizationScope;
}

/** Core-owned side task summary/detail；字段缺失时 Web 领域解析器会拒绝整条响应。 */
export interface SideTaskSummary {
  readonly task_id: string;
  readonly project_id: string;
  readonly kind: "side";
  readonly parent_task_id: string;
  readonly workspace_id: string;
  readonly objective: string;
  readonly status: SideTaskStatus;
  readonly input_hash: string;
  readonly output_hash: string | null;
  readonly adoption_state: SideTaskAdoptionState;
  readonly authorization_scope: SideTaskAuthorizationScope;
  readonly base_commit: string | null;
  readonly base_manifest_hash: string | null;
  readonly workspace_state: SideTaskWorkspaceState | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly finished_at: string | null;
  readonly failure_reason: string | null;
}

export type SideTaskConversationEventKind =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "status";

/** Core-owned append-only conversation fact for a main or side task. */
export interface SideTaskConversationEvent {
  readonly id: string;
  readonly sequence: number;
  readonly event_kind: SideTaskConversationEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payload_hash: string;
  readonly actor_type: "human" | "service";
  readonly actor_id: string;
  readonly created_at: string;
}

export interface SideTaskConversationPage {
  readonly task_id: string;
  readonly events: readonly SideTaskConversationEvent[];
  readonly next_after: number;
}

export interface SideTaskTestResult {
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped" | "unknown";
  readonly detail: string | null;
}

export interface SideTaskResultFile {
  readonly path: string;
  readonly change_kind: SideTaskChangeKind;
  readonly base_hash: string | null;
  readonly result_hash: string;
  readonly size_bytes: number;
}

export interface SideTaskResult {
  readonly result_id: string;
  readonly task_id: string;
  readonly workspace_id: string;
  readonly base_commit: string;
  readonly result_commit: string;
  readonly summary: string;
  readonly tests: readonly SideTaskTestResult[];
  readonly files: readonly SideTaskResultFile[];
  readonly output_hash: string;
  readonly created_at: string | null;
}

export interface SideTaskDiffFile {
  readonly path: string;
  readonly change_kind: SideTaskChangeKind;
  readonly base_hash: string | null;
  readonly result_hash: string;
  readonly current_target_hash: string | null;
  readonly diff: string;
  readonly conflict_reason: string | null;
  /** 已被先前人工采纳的路径不可再次选择。 */
  readonly adopted: boolean;
}

export interface SideTaskDiff {
  readonly task_id: string;
  readonly result_id: string;
  readonly preview_hash: string;
  readonly files: readonly SideTaskDiffFile[];
}

export interface SideTaskAdoptionSelection {
  readonly path: string;
  /** 预览时 Core 返回的 side 基线哈希；added 文件必须为 null。 */
  readonly expected_base_hash: string | null;
  /** 预览时 Core 返回的候选结果哈希。 */
  readonly expected_proposed_hash: string;
  /** 预览时主工作区该路径的哈希；文件不存在时为 null。 */
  readonly expected_target_hash: string | null;
}

/** POST /tasks/:taskId/adoptions；选择、预览哈希与理由均进入幂等请求体。 */
export interface AdoptSideTaskRequest {
  readonly adoption_id: string;
  readonly result_id: string;
  readonly files: readonly SideTaskAdoptionSelection[];
  readonly preview_hash: string;
  readonly reason: string;
}

export interface SideTaskAdoptionResult {
  readonly adoption_id: string;
  readonly task_id: string;
  readonly result_id: string;
  readonly status: "applied" | "conflicted" | "failed";
  readonly adopted_paths: readonly string[];
  readonly project_commit_before: string | null;
  readonly project_commit_after: string | null;
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

// ─── P4：Core-owned G0-G4、正式输入、码流与交付 ─────────────────────

export type P4GateId = "G0" | "G1" | "G2" | "G3" | "G4";

export interface ProcessProfileCheckV1 {
  readonly code: string;
  readonly severity: "hard" | "advisory";
}

export interface ProcessProfileNodeV1 {
  readonly id: P4GateId;
  readonly kind: "gate";
  readonly ordinal: number;
  readonly name: string;
  readonly goal: string;
  readonly activities: readonly string[];
  readonly requiredChecks: readonly ProcessProfileCheckV1[];
  readonly milestoneBaseline: "B0" | "B1" | "B2" | null;
}

/** GET /process-versions/:id/profile. This is the only modern UI stage definition. */
export interface ProcessProfileV1 {
  readonly schema: "process-profile.v1";
  readonly id: "GJB_REF_V1";
  readonly version: "GJB_REF_V1";
  readonly name: string;
  readonly nodes: readonly ProcessProfileNodeV1[];
  readonly profileHash: string;
}

export interface ProcessReadinessV1 {
  readonly id: string;
  readonly status: "draft" | "confirmed";
  readonly ready: boolean;
  readonly readinessHash: string;
  readonly targetPart: string;
  readonly boardRef: string;
  readonly workspaceReady: boolean;
  readonly dataScopeRecorded: boolean;
  readonly sourceMaterialsRecorded: boolean;
  readonly pinConstraintsComplete: boolean;
  readonly electricalConstraintsComplete: boolean;
  readonly clockConstraintsComplete: boolean;
  readonly constraintsComplete: boolean;
  readonly toolchainProfileHash: string | null;
  readonly constraintRevisionIds: readonly string[];
  readonly generatedBy: { readonly type: string; readonly id: string };
  readonly confirmedBy: { readonly id: string; readonly at: string } | null;
}

/** GET /projects/:id/process-state exact v1 projection. */
export interface ProcessStateV1 {
  readonly schema: "process-state.v1";
  readonly projectId: string;
  readonly processInstanceId: string;
  readonly profileId: "GJB_REF_V1";
  readonly profileHash: string;
  /** Core-owned active work version, or the latest released version in completed state. */
  readonly workVersionId: string;
  readonly currentGate: P4GateId;
  readonly completed: boolean;
  readonly readiness: ProcessReadinessV1 | null;
}

/** GET /projects/:id/readiness row; Core may expose both naming styles during migration. */
export interface ProjectReadinessRecord {
  readonly id: string;
  readonly project_id?: string;
  readonly projectId?: string;
  readonly process_instance_id?: string;
  readonly process_version_id?: string;
  readonly profile_definition_hash?: string;
  readonly work_version_id?: string;
  readonly workVersionId?: string;
  readonly sequence?: number;
  readonly supersedes_readiness_id?: string | null;
  readonly engineering_config?: EngineeringConfigV1;
  readonly engineering_config_hash?: string;
  readonly source_snapshot_ids?: readonly string[];
  readonly workspace_commit?: string;
  readonly workspace_manifest_hash?: string;
  readonly check_results?: readonly ReadinessCheckV1[];
  readonly checks?: readonly ReadinessCheckV1[];
  readonly state?: "ready" | "blocked";
  readonly status?: "draft" | "confirmed";
  readonly ready?: boolean;
  readonly constraints_complete?: boolean;
  readonly target_part?: string | null;
  readonly board_ref?: string | null;
  readonly workspace_ready?: boolean;
  readonly data_scope_recorded?: boolean;
  readonly source_materials_recorded?: boolean;
  readonly pin_constraints_complete?: boolean;
  readonly electrical_constraints_complete?: boolean;
  readonly clock_constraints_complete?: boolean;
  readonly constraint_revision_ids?: readonly string[];
  readonly toolchain_profile_hash?: string | null;
  readonly confirmed_by?: string | null;
  readonly confirmed_at?: string | null;
  readonly result_hash?: string;
  readonly readiness_hash?: string;
  readonly created_at?: string;
}

export interface ReadinessCheckV1 {
  readonly code: string;
  readonly severity: "hard";
  readonly passed: boolean;
  readonly details: Readonly<Record<string, unknown>>;
}

export type EngineeringPresenceState = "identified" | "missing";
export type EngineeringConstraintState = "complete" | "partial" | "missing";

export interface EngineeringConfigV1 {
  readonly schema: "engineering-config.v1";
  readonly targetPart: {
    readonly value: string | null;
    readonly state: EngineeringPresenceState;
  };
  readonly board: {
    readonly ref: string | null;
    readonly state: EngineeringPresenceState;
  };
  readonly constraints: {
    readonly pin: { readonly state: EngineeringConstraintState; readonly revisionIds: readonly string[] };
    readonly electrical: { readonly state: EngineeringConstraintState; readonly revisionIds: readonly string[] };
    readonly clock: { readonly state: EngineeringConstraintState; readonly revisionIds: readonly string[] };
  };
  readonly dataScope: {
    readonly classification: "D1" | "D2" | "D3" | "D4" | "UNCLASSIFIED";
    readonly description: string;
  };
  readonly sourcePolicy: { readonly confirmedOnly: true };
}

export interface GateCheckItemV1 {
  readonly id: string;
  readonly check_code: string;
  readonly severity: "hard" | "advisory";
  readonly passed: boolean;
  readonly details: Readonly<Record<string, unknown>>;
  readonly evidence_refs: readonly unknown[];
}

export interface GateCheckEvaluationV1 {
  readonly id: string;
  readonly project_id: string;
  readonly work_version_id: string;
  readonly gate_submission_id: string;
  readonly snapshot_id: string;
  readonly profile_hash: string;
  readonly result_hash: string;
  readonly passed: boolean;
  readonly sealed_projection_hash: string | null;
  /** G4 sealed projection 固定的待建 release 身份；其他 gate 为 null。 */
  readonly delivery_release_id: string | null;
  readonly delivery_release_version: number | null;
  readonly supersedes_release_id: string | null;
  readonly evaluated_at: string;
  readonly items: readonly GateCheckItemV1[];
}

export interface FormalInputFileV1 {
  readonly revision_id: string;
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly storage_uri: string;
  readonly role: string;
}

export interface FormalInputPreviewV1 {
  readonly schema: "formal-input-preview.v1";
  readonly work_version_id: string;
  readonly snapshot_id: string;
  readonly readiness_id: string;
  readonly authorized_task_id: string;
  readonly prerequisite_baseline_id: string;
  readonly target_part: string;
  readonly toolchain_profile_hash: string;
  readonly constraints_complete: boolean;
  readonly purpose: "g4_delivery";
  readonly allowed_operations: readonly string[];
  readonly files: readonly FormalInputFileV1[];
  readonly input_hash: string;
  readonly preview_hash: string;
}

export interface FormalInputApprovalV1 extends FormalInputPreviewV1 {
  readonly id: string;
  readonly confirmed_by: string;
  readonly confirmed_at: string;
}

export interface CreateReadinessRequestV1 {
  readonly id: string;
  readonly work_version_id: string;
  readonly engineering_config: EngineeringConfigV1;
  readonly source_snapshot_ids: readonly string[];
  readonly workspace_expected_commit: string;
  readonly workspace_manifest_hash: string;
  readonly reason: string;
}

export interface ConfirmReadinessRequestV1 {
  readonly reason: string;
}

export interface CreateFormalInputPreviewRequestV1 {
  readonly work_version_id: string;
  readonly snapshot_id: string;
  readonly readiness_id: string;
  readonly authorized_task_id: string;
}

export interface ConfirmFormalInputRequestV1 extends CreateFormalInputPreviewRequestV1 {
  readonly id: string;
  readonly purpose: "g4_delivery";
  readonly preview_hash: string;
}

export type FormalOperationV1 = "validate_sources" | "simulate" | "synthesize" | "implement";

export interface CreateFormalJobRequestV1 {
  readonly operation: FormalOperationV1;
  readonly run_class_intent: "formal";
  readonly formal_input_approval_id: string;
}

/** POST /projects/:id/jobs 在 P4 formal 路径的不可变绑定回显。 */
export interface FormalJobBindingV1 {
  readonly jobId: string;
  readonly state: string;
  readonly operation: FormalOperationV1;
  readonly runClass: "formal";
  readonly formalInputApprovalId: string;
  readonly inputSnapshotId: string;
  readonly inputHash: string;
  readonly toolchainProfileHash: string;
  readonly errorCode?: string;
  readonly outputSha256?: string;
}

export interface BitstreamResultV1 {
  readonly id: string;
  readonly project_id: string;
  readonly work_version_id: string;
  readonly tool_run_id: string;
  readonly class: "trial" | "formal";
  readonly formal_input_approval_id: string | null;
  readonly snapshot_id: string | null;
  readonly input_hash: string;
  readonly target_part: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly artifact_classification: "tool_run_evidence";
  readonly usage_classification: "run_class_governed";
  readonly generated_at: string;
}

export type DeliveryReleaseState = "sealed";

export interface DeliveryReleaseSummaryV1 {
  readonly id: string;
  readonly project_id: string;
  readonly version: number;
  readonly supersedes_release_id: string | null;
  readonly work_version_id: string;
  readonly manifest_hash: string;
  readonly item_count: number;
  readonly state: DeliveryReleaseState;
  readonly confirmed_by: string | null;
  readonly released_at: string | null;
}

export interface DeliveryReleaseItemV1 {
  readonly id: string;
  readonly category: "rtl" | "tb" | "constraint" | "document" | "run_result" | "raw_evidence" | "confirmation" | "source" | "bitstream";
  readonly path: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly media_type: string;
}

export interface DeliveryManifestV1 {
  readonly schema: "delivery-manifest.v1";
  readonly project_id: string;
  readonly release_id: string;
  readonly version: number;
  readonly work_version_id: string;
  readonly input_hash: string;
  readonly items: readonly DeliveryReleaseItemV1[];
  readonly manifest_hash: string;
}

export interface DeliveryReleaseDetailV1 extends DeliveryReleaseSummaryV1 {
  readonly formal_input_approval_id: string;
  readonly bitstream_result_id: string;
  readonly gate_check_evaluation_id: string;
  readonly candidate_manifest_hash: string;
  readonly items: readonly DeliveryReleaseItemV1[];
}

export interface DeliveryReleaseContentV1 {
  readonly path: string;
  readonly content: string;
  readonly encoding: "utf8" | "base64";
  readonly media_type: string;
  readonly sha256: string;
  readonly file_name: string;
}

export interface ChangeRequestV1 {
  readonly id: string;
  readonly project_id: string;
  readonly base_delivery_release_id: string;
  readonly project_work_version_id: string;
  readonly reason: string;
  readonly affected_paths: readonly string[];
  readonly impact_gate: Exclude<P4GateId, "G0">;
  readonly state: "open" | "released" | "withdrawn";
  readonly confirmed_by: string;
  readonly confirmed_at: string;
}

export interface CreateChangeRequestV1 {
  readonly id: string;
  readonly work_version_id: string;
  readonly base_delivery_release_id: string;
  readonly reason: string;
  readonly affected_paths: readonly string[];
  readonly impact_gate: Exclude<P4GateId, "G0">;
}

export interface ProjectWorkVersionV1 {
  readonly id: string;
  readonly project_id: string;
  readonly process_instance_id: string;
  readonly version: number;
  readonly origin: "initial" | "change_request";
  readonly change_request_id: string | null;
  readonly base_delivery_release_id: string | null;
  readonly start_gate: P4GateId;
  readonly current_gate: P4GateId;
  readonly state: "working" | "in_review" | "released" | "abandoned";
  readonly created_at: string;
  readonly released_at: string | null;
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
