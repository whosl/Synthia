/**
 * 统一项目页领域规则（v4 集成阶段：部分保留——见 spec §5.2）。
 *
 * - 就地审批卡：渲染条件、里程碑/非里程碑文案、批准请求体、驳回理由必填；
 * - 待审产物 = 快照成员修订（snapshot.created payload.memberRevisionIds）；
 * - 记录标签：GET /projects/:id/jobs 的工具运行中文映射（L3 页，允许技术词）。
 *
 * 旧路由重定向（LEGACY_ROUTES / unifiedRedirectTarget）已随 v3 UnifiedProjectView
 * 一并作废并删除——v4 路由结构不再需要旧四路由 → 统一页的重定向规则。
 */

import { ApiError, NetworkError, type ApiClient } from "../api/client.ts";
import {
  getRevisionContent,
  listArtifacts,
  listEvents,
  listRevisions,
} from "../api/index.ts";
import type { ApproveRequest } from "../api/index.ts";
import type { ArtifactRevision, GateSubmission, GateSubmissionDetail, SnapshotCreatedPayload } from "../api/types.ts";
import { sha256Hex } from "../util/sha256.ts";
import {
  BASELINE_NAMES,
  GATE_TO_BASELINE,
  isMilestoneGate,
  makeBaselineId,
  type GateId,
} from "./gates.ts";
import { artifactDocName } from "./artifacts.ts";

// ─── 右栏标签 ─────────────────────────────────────────────────────────

export type UnifiedTab = "flow" | "artifacts" | "records";

export const UNIFIED_TABS: readonly { readonly id: UnifiedTab; readonly label: string }[] = [
  { id: "flow", label: "流程" },
  { id: "artifacts", label: "产物" },
  { id: "records", label: "记录" },
];

/** 查询参数 → 标签（仅接受三个合法值，其余回退「流程」）。 */
export function tabFromQuery(value: unknown): UnifiedTab {
  return value === "artifacts" || value === "records" ? value : "flow";
}

// ─── 就地审批卡（信息流内）───────────────────────────────────────────

export type ApprovalCardState = "hidden" | "pending" | "approved" | "rejected";

/** 在项目提交列表中找该门最新一次提交（created_at 最大）。 */
export function findApprovalSubmission(submissions: readonly GateSubmission[], gate: string): GateSubmission | null {
  const matched = submissions.filter((s) => s.gate === gate);
  if (matched.length === 0) return null;
  return matched.reduce((latest, s) => ((s.created_at ?? "") > (latest.created_at ?? "") ? s : latest));
}

/**
 * 审批卡渲染条件（Contract）：
 * - 无提交 → hidden；
 * - run 未在 awaiting_approval 时只保留已决卡（approved/rejected 作为对话记录），
 *   in_review 的提交不再渲染（等待态以 run 状态为准）；
 * - run awaiting_approval 且提交 in_review → pending；approved/rejected → 已决卡。
 */
export function deriveApprovalCard(
  run: { readonly status: string; readonly awaiting_gate: string | null },
  submission: GateSubmission | null,
): ApprovalCardState {
  if (!submission) return "hidden";
  if (run.awaiting_gate !== null && submission.gate !== run.awaiting_gate) return "hidden";
  switch (submission.state) {
    case "in_review":
      return run.status === "awaiting_approval" ? "pending" : "hidden";
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    default:
      return "hidden"; // preparing/submitted/checking/withdrawn 未进入人工审批
  }
}

/**
 * 是否需要去后端拉当前门的提交（3s 轮询下的去重判据）。
 *
 * 稳定等待期间每 3s 都会跑一次 refresh，若不判据直接拉，一次等待就会放大成几十
 * 个 gate-submissions 请求。已持有同一门的 in_review 提交时直接跳过即可。
 *
 * ⚠️ 返回 false **不等于**「该清空已持有的提交」——`deriveApprovalCard` 刻意把
 * approved/rejected 的卡留作对话记录，决策成功后 run 会立刻离开 awaiting_approval，
 * 此时若顺手把提交清掉，刚点完批准的那张卡会当场消失。调用方只做「拉/不拉」，
 * 可见性交给 deriveApprovalCard。
 */
export function shouldFetchSubmission(
  run: { readonly status: string; readonly awaiting_gate: string | null } | null,
  current: { readonly gate: string; readonly state: string } | null,
): boolean {
  if (!run || run.status !== "awaiting_approval" || !run.awaiting_gate) return false;
  return !(current && current.gate === run.awaiting_gate && current.state === "in_review");
}

/**
 * 一次决策尝试该复用上次的「幂等键 + 请求体」，还是重铸一份？
 *
 * 幂等的单位是**键加体**，不是键。`buildApproveBody` 里带 `signed_at: new Date()`
 * 和 `makeBaselineId(gate, Date.now())` 两个时间戳，重试时重新组装会得到不同的
 * canonicalRequestHash；服务端对「同键异体」直接抛 409 IDEMPOTENCY_CONFLICT
 * （core/src/services/approval.ts），于是一次本可安全重放的重试反而变成硬失败。
 * 所以失败重试必须原样重发同键同体，只有换了提交才重铸。
 *
 * 写成类型谓词（`prev is T`）是为了调用端的 `if (!reuse) prev = {...}` 之后能直接
 * 用 `prev.body`，不必补一个 `!` 断言。
 */
export function shouldReuseApproveAttempt<T extends { readonly subId: string }>(
  prev: T | null,
  subId: string,
): prev is T {
  return prev !== null && prev.subId === subId;
}

/**
 * 驳回同理，但多一个判据：理由进请求体、参与 requestHash，
 * 用户改了理由再提交就是另一个请求体，必须重铸键，否则同样撞 409。
 */
export function shouldReuseRejectAttempt<T extends { readonly subId: string; readonly reason: string }>(
  prev: T | null,
  subId: string,
  reason: string,
): prev is T {
  return prev !== null && prev.subId === subId && prev.reason === reason;
}

/** 里程碑门批准文案：「✓ 批准并建立 B? 里程碑」；非里程碑门：「✓ 批准」。 */
export function approvalButtonLabel(gate: string): string {
  if (!isMilestoneGate(gate)) return "✓ 批准";
  const kind = GATE_TO_BASELINE[gate]!;
  return `✓ 批准并建立 ${kind} ${BASELINE_NAMES[kind]}`;
}

/** 已批准卡第二行文案（仅里程碑门有）：「🏁 已建立 B? 里程碑」。 */
export function approvalMilestoneLine(gate: string): string | null {
  if (!isMilestoneGate(gate)) return null;
  const kind = GATE_TO_BASELINE[gate]!;
  return `🏁 已建立 ${kind} ${BASELINE_NAMES[kind]}`;
}

/** 驳回按钮置灰条件：理由去空白后为空即禁用（必填）。 */
export function rejectDisabled(reason: string): boolean {
  return reason.trim().length === 0;
}

/**
 * 组装批准请求体（与审批中心详情页同构）：
 * - 里程碑门带 baseline_id = bl-<gate小写>-<时间戳>（makeBaselineId）；
 * - check_results_hash = sha256(check_results 的 JSON 序列化)。
 */
export async function buildApproveBody(
  submission: GateSubmissionDetail,
  opts: { readonly reason?: string | null; readonly now?: number } = {},
): Promise<ApproveRequest> {
  const reason = opts.reason?.trim() || null;
  return {
    configuration_snapshot_id: submission.snapshot_id,
    approved_gate_result_id: `agr-${submission.id}`,
    approver_role: "quality",
    check_results_hash: await sha256Hex(JSON.stringify(submission.check_results ?? null)),
    signed_at: new Date().toISOString(),
    signature_method: "platform_token",
    ...(reason ? { reason } : {}),
    baseline_id: isMilestoneGate(submission.gate) ? makeBaselineId(submission.gate as GateId, opts.now) : null,
  };
}

// ─── 待审产物：快照成员修订 ───────────────────────────────────────────

export interface ApprovalMember {
  readonly revisionId: string;
  readonly artifactId: string | null;
  /** GJB 正式文档名（未映射类型 →「工程文档」）。 */
  readonly docName: string;
  readonly version: number | null;
  readonly state: string | null;
  readonly createdAt: string | null;
}

/** snapshot.created 事件 payload → memberRevisionIds（缺失/畸形 → null）。 */
export function memberRevisionIdsFromEvents(
  events: readonly { event_type: string; payload: unknown }[],
): readonly string[] | null {
  const created = events.find((e) => e.event_type === "snapshot.created");
  const payload = created?.payload as SnapshotCreatedPayload | undefined;
  return payload && Array.isArray(payload.memberRevisionIds) ? payload.memberRevisionIds : null;
}

/**
 * 解析快照成员修订：listEvents(configuration_snapshot) → memberRevisionIds，
 * 再经 listArtifacts + listRevisions 映射修订 → 产物（docName 用 GJB 文档名）。
 */
export async function resolveSnapshotMembers(
  client: ApiClient,
  projectId: string,
  snapshotId: string,
): Promise<ApprovalMember[] | null> {
  const events = await listEvents(client, projectId, { aggregateType: "configuration_snapshot", aggregateId: snapshotId });
  const memberIds = memberRevisionIdsFromEvents(events);
  if (memberIds === null) return null;

  const artifacts = await listArtifacts(client, projectId);
  const revIndex = new Map<string, { artifactId: string; artifactType: string; meta: ArtifactRevision }>();
  await Promise.all(
    artifacts.map(async (artifact) => {
      const revisions = await listRevisions(client, projectId, artifact.id);
      for (const meta of revisions) revIndex.set(meta.id, { artifactId: artifact.id, artifactType: artifact.artifact_type, meta });
    }),
  );

  return memberIds.map((revisionId): ApprovalMember => {
    const found = revIndex.get(revisionId);
    return {
      revisionId,
      artifactId: found?.artifactId ?? null,
      docName: found ? artifactDocName(found.artifactType) : "工程文档",
      version: found?.meta.version ?? null,
      state: found?.meta.state ?? null,
      createdAt: found?.meta.created_at ?? null,
    };
  });
}

/** 成员修订内容（展开时按需加载；无产物映射 → null）。 */
export async function fetchMemberContent(client: ApiClient, projectId: string, member: ApprovalMember): Promise<string | null> {
  if (!member.artifactId) return null;
  const data = await getRevisionContent(client, projectId, member.artifactId, member.revisionId);
  return data.content;
}

/** gate_submission.rejected 事件 payload 里的驳回理由（真实状态驱动）。 */
export async function loadRejectionReason(client: ApiClient, projectId: string, subId: string): Promise<string | null> {
  const events = await listEvents(client, projectId, { aggregateType: "gate_submission", aggregateId: subId });
  const rejected = events.find((e) => e.event_type === "gate_submission.rejected");
  const payload = rejected?.payload as { reason?: unknown } | undefined;
  return typeof payload?.reason === "string" && payload.reason.length > 0 ? payload.reason : null;
}

// ─── 记录标签：工具运行中文映射（L3 页，允许技术词）───────────────────

export const JOB_STATE_TEXT: Readonly<Record<string, string>> = {
  submitted: "已提交",
  rejected: "被拒绝",
  queued: "排队中",
  preparing: "准备中",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  cancelling: "取消中",
  cancelled: "已取消",
  timeout: "超时",
  lost: "失联",
  unknown_effect: "结果未知",
};

export const JOB_RUN_CLASS_TEXT: Readonly<Record<string, string>> = {
  exploratory: "探索",
  gate_check: "门禁校验",
  formal: "正式",
};

/** 工具运行操作名 → 中文（vivado_ 前缀剥离后查表；未映射回退原文）。 */
export function jobOperationText(operation: string): string {
  const bare = operation.replace(/^vivado_/, "");
  const table: Readonly<Record<string, string>> = {
    validate_sources: "源文件校验",
    simulate: "仿真",
    synthesize: "综合",
    implement: "实现并生成码流",
    report_drc: "设计规则检查",
    report_sta: "静态时序分析",
    report_resources: "资源报告",
    discover_toolchain: "工具链探测",
    query_parts: "器件查询",
  };
  return table[bare] ?? operation;
}

/** 工具运行耗时（endTime − startTime；缺时间 → null）。 */
export function jobDurationText(startTime: string | null, endTime: string | null): string | null {
  if (!startTime || !endTime) return null;
  const ms = Date.parse(endTime) - Date.parse(startTime);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

// ─── v3 统一项目页：空项目示例 / 错误人话化（spec §6/§11）────────────────

/** 空项目首屏示例任务卡（真实可一键填入的任务文案）。 */
export const EXAMPLE_TASKS: readonly string[] = [
  "设计一个 UART 收发器：9600 波特率、8N1 格式、100MHz 系统时钟，从需求推进到码流",
  "设计一个 8 位 ALU：支持加减与按位逻辑运算，带零/进位/溢出标志位输出",
  "梳理本项目当前的需求与门禁状态，总结进展并给出下一步建议",
  "审查项目现有 RTL 源代码，指出时序与命名问题并给出修改建议",
];

/** 批准/驳回/发送等决策动作失败 → 人话。 */
export type DecisionAction = "批准" | "驳回" | "发送";

export interface DecisionFailure {
  /** 人话原因（主页面展示，不含英文错误码/关联号）。 */
  readonly text: string;
  /** 可操作建议（无则 null）。 */
  readonly hint: string | null;
}

/**
 * 决策动作失败 → 人话（spec §5：批准失败显示人话原因与建议；
 * 关联号与错误码只在记录面板可见，故此处不拼接 err.code/correlationId）。
 * active 基线冲突 = 同一 (project, kind) 已有 active Baseline 的唯一索引冲突
 * （core schema baseline_unique_active_project_kind，409）。
 *
 * 匹配用 `${err.code} ${err.message}`：信封的 code 恒为六个固定值之一
 * （validation/authorization/conflict/...），具体错误码在 message 里。
 */
export function humanizeDecisionError(err: unknown, action: DecisionAction): DecisionFailure {
  if (err instanceof ApiError) {
    const detail = `${err.code} ${err.message}`;
    // 「该提交已不可再处理」的三个码分属不同 HTTP 状态——NOT_REVIEWABLE 是
    // InvariantError，被 core 的 mapServiceError 兜成 400；NOT_REJECTABLE 是
    // conflictApiError，是 409。所以必须在 status 分支之前统一拦下，否则 400
    // 那条（别人已抢先批准，最常见的失败）会落到兜底文案，让人无限重试。
    if (/NOT_REVIEWABLE|NOT_SUBMITTABLE|NOT_REJECTABLE/i.test(detail)) {
      return { text: `该提交已被处理过（状态已变化），${action}未生效。`, hint: "页面将自动刷新至最新状态，请确认结果。" };
    }
    if (err.status === 409) {
      if (/baseline|unique/i.test(detail)) {
        return {
          text: `${action}失败：该项目同类里程碑已经建立过，本次未能重复建立。`,
          hint: "请刷新查看最新的里程碑状态；若确需重新建立，请联系管理员处理后重试。",
        };
      }
      return { text: `该提交状态已变化，${action}未生效。`, hint: null };
    }
    if (err.status === 403) {
      return { text: `当前账号没有${action}权限。`, hint: "请使用具备审批角色的账号操作。" };
    }
    if (err.status === 401) {
      return { text: "登录已失效，请重新登录后再操作。", hint: null };
    }
    if (err.status >= 500) {
      return { text: `服务暂时不可用，${action}未完成。`, hint: "请点击重试；若持续失败，请查看运行记录中的关联号并联系管理员。" };
    }
    return { text: `${action}请求失败，请重试。`, hint: null };
  }
  if (err instanceof NetworkError) {
    return { text: `网络连接失败，${action}未完成。`, hint: "请检查网络后点击重试。" };
  }
  return { text: `${action}请求失败，请重试。`, hint: null };
}

/** 轮询/加载失败 → 人话（spec §11：等待/失败显示人话 + 可操作）。 */
export function humanizeLoadError(err: unknown): string {
  if (err instanceof NetworkError) return "网络连接失败，服务可能暂不可达。";
  if (err instanceof ApiError) {
    if (err.status === 404) return "请求的内容不存在或已被清理。";
    if (err.status === 401) return "登录已失效，请重新登录。";
    if (err.status === 403) return "当前账号无权查看该内容。";
    if (err.status >= 500) return "服务暂时不可用，正在自动重试。";
    return "服务请求失败，正在自动重试。";
  }
  return "服务请求失败，正在自动重试。";
}
