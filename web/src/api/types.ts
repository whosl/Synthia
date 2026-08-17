/**
 * Synthia Core API 契约类型（字段与 Contract 一致，不得私改）。
 */

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly data_classification: string;
  readonly created_at: string;
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
  readonly runId: string;
}

/** GET /projects/:id/tasks 列表项。 */
export interface TaskRunSummary {
  readonly run_id: string;
  readonly project_id: string;
  readonly status: string;
  readonly current_stage: string | null;
  readonly awaiting_gate: string | null;
  readonly created_at: string;
}

/** GET /projects/:id/tasks 响应 data。 */
export interface TaskRunList {
  readonly runs: readonly TaskRunSummary[];
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

/** GET /projects/:id/tasks/:runId 响应 data。 */
export interface TaskRunDetail extends TaskRunSummary {
  /** 任务指令（Runtime 透传 run-state.task）。 */
  readonly task?: string;
  readonly docs: readonly TaskDocRef[];
  readonly audit: readonly TaskAuditEvent[];
  readonly evidence: readonly TaskEvidenceSummary[];
  readonly reason?: string | null;
}

/** POST .../message 响应 data（idle/终态 → prompt 返回 reply；running → steer 返回 steered）。 */
export interface SendMessageResult {
  /** prompt 返回的 agent 文本（steer 路径无）。 */
  readonly reply?: string;
  /** running 会话走 steer 时为 true。 */
  readonly steered?: boolean;
  /** free-agent 会话状态（idle/running/awaiting_approval/completed/cancelled/failed）。 */
  readonly status: string;
}

/** POST .../abort 响应 data。 */
export interface AbortRunResult {
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
  readonly target_part: string;
  readonly toolchain_profile_ref: string | null;
  readonly process_instances: ReadonlyArray<{
    readonly id: string;
    readonly gate_profile_version: string;
    readonly current_gate: string;
    readonly created_at: string;
  }>;
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
