<script setup lang="ts">
/**
 * 统一项目页 v3（specs/unified-project-page-v3.md）：替换 v2 双栏版。
 * 布局 = 顶部状态带（任务切换器 + 门序列 + 里程碑徽章 + 当前动作，运行记录为展开面板）
 *        + 全宽对话流（准直播 3s 轮询增量渲染，可插话/打断）
 *        + 底部审批抽屉（awaiting 时半屏滑出）。无右栏。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { api } from "../main.ts";
import { readToken } from "../stores/auth.ts";
import {
  approveGateSubmission,
  createTask,
  getGateSubmission,
  getJobEvidence,
  getJobEvidenceContent,
  getProject,
  getRevisionContent,
  getTask,
  listBaselines,
  listGateSubmissions,
  listJobs,
  listTasks,
  rejectGateSubmission,
  sendMessage,
  abortRun,
} from "../api/index.ts";
import type {
  Baseline,
  GateSubmission,
  JobEvidenceContent,
  JobEvidenceManifest,
  JobRunSummary,
  ProjectDetail,
  TaskRunDetail,
  TaskRunSummary,
} from "../api/types.ts";
import {
  BASELINE_KINDS,
  BASELINE_NAMES,
  BASELINE_STATE_TEXT,
  GATES,
  GATE_REVIEW_NAMES,
  GATE_LANE_STATE_TEXT,
  deriveGateLanes,
  type GateId,
  type GateLaneState,
} from "../domain/gates.ts";
import {
  STAGE_NAME_TEXT,
  TASK_STATUS_TEXT,
  createPoller,
  normalizeStageId,
  type Poller,
} from "../domain/tasks.ts";
import { currentAction, actionStartedAt, waitText } from "../domain/band.ts";
import { auditToParts, toolDurationLabel, type SynthiaPart, type SynthiaTextPart } from "../domain/parts.ts";
import { project as projectMarkdown, type Projection } from "../domain/markdown-stream.ts";
import {
  applyStreamEvent,
  subscribeTaskStream,
  type StreamFeedPart,
  type StreamHandle,
  type StreamPhase,
} from "../domain/task-stream.ts";
import {
  EXAMPLE_TASKS,
  approvalButtonLabel,
  approvalMilestoneLine,
  buildApproveBody,
  fetchMemberContent,
  findApprovalSubmission,
  humanizeDecisionError,
  humanizeLoadError,
  jobDurationText,
  jobOperationText,
  JOB_RUN_CLASS_TEXT,
  JOB_STATE_TEXT,
  loadRejectionReason,
  rejectDisabled,
  resolveSnapshotMembers,
  type ApprovalMember,
  type DecisionFailure,
} from "../domain/unified.ts";
import { renderMarkdown } from "../domain/markdown.ts";
import { makeTextSegment, toggleSetKey } from "../domain/reply-segments.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import ReplySegments from "../components/ReplySegments.vue";
import StatusBadge from "../components/StatusBadge.vue";

const route = useRoute();
const projectId = String(route.params.id);

// ── 基础数据与轮询（准直播：3s；终态停）──────────────────────────────

const project = ref<ProjectDetail | null>(null);
const runs = ref<readonly TaskRunSummary[]>([]);
const currentRunId = ref<string | null>(typeof route.query.run === "string" ? route.query.run : null);
const detail = ref<TaskRunDetail | null>(null);
const loading = ref(true);
/** 轮询错误的人话文案（连续失败累积等待提示；关联号只在记录面板）。 */
const loadErrorText = ref<string | null>(null);
const loadErrorStartedAt = ref<number | null>(null);

const submissions = ref<GateSubmission[]>([]);
const baselines = ref<Baseline[]>([]);

let poller: Poller | null = null;
let refreshing = false;
const nowTick = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const [subList, blList, runList] = await Promise.all([
      listGateSubmissions(api, projectId),
      listBaselines(api, projectId),
      listTasks(api, projectId),
    ]);
    submissions.value = subList;
    baselines.value = blList;
    // 任务列表每轮全量刷新：后台任务继续跑，切换器徽章随之更新。
    runs.value = [...runList.runs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    if (currentRunId.value) detail.value = await getTask(api, projectId, currentRunId.value);
    else if (runs.value.length > 0) currentRunId.value = runs.value[0]!.run_id;
    loadErrorText.value = null;
    loadErrorStartedAt.value = null;
  } catch (err) {
    // 人话化（spec §11）：不弹原文错误；记录面板可查关联号。
    loadErrorText.value = humanizeLoadError(err);
    loadErrorStartedAt.value ??= Date.now();
  } finally {
    refreshing = false;
    loading.value = false;
  }
}

/** 轮询错误横幅文案：人话 + 已等待时长 + 重试。 */
const loadErrorBanner = computed(() => {
  if (!loadErrorText.value) return null;
  const waited = loadErrorStartedAt.value !== null ? waitText(Date.now() - loadErrorStartedAt.value) : null;
  return waited ? `${loadErrorText.value}（已持续 ${waited}）` : loadErrorText.value;
});

onMounted(async () => {
  nowTimer = setInterval(() => (nowTick.value = Date.now()), 1000);
  try {
    project.value = await getProject(api, projectId);
  } catch (err) {
    loadErrorText.value = humanizeLoadError(err);
  } finally {
    loading.value = false;
  }
  await refresh();
  poller = createPoller(() => {
    void refresh();
    // 终态且无其他在跑任务 → 停轮询（审批等操作会手动 refresh 重启数据流）。
    const active = runs.value.some((r) => r.status === "running" || r.status === "awaiting_approval");
    return active || detail.value === null || !isWatchStatus(detail.value.status);
  }, 3000);
  // 展开记录面板时按需拉取 jobs。
  watch(recordsOpen, (open) => {
    if (open && jobs.value.length === 0) void loadJobs();
  });
});

function isWatchStatus(status: string): boolean {
  return status === "running" || status === "awaiting_approval";
}

onBeforeUnmount(() => {
  poller?.stop();
  poller = null;
  streamHandle?.close();
  streamHandle = null;
  if (nowTimer) clearInterval(nowTimer);
  nowTimer = null;
});

// ── SSE 订阅生命周期：跟随 currentRunId（fetch 流带 Bearer 头；断线退避重连，3 次失败降级轮询）──

let streamHandle: StreamHandle | null = null;

function openStream(runId: string): void {
  streamHandle?.close();
  streamHandle = null;
  streamFeed.value = [];
  projections.clear();
  streamPhase.value = "connecting";
  streamHandle = subscribeTaskStream(
    `${(import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ""}/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(runId)}/stream`,
    readToken(),
    0,
    {
      onEvent: (ev) => {
        streamFeed.value = applyStreamEvent(streamFeed.value, ev);
        if (ev.type === "done" || ev.type === "status" || ev.type === "reset") void refresh();
      },
      onPhase: (phase) => { streamPhase.value = phase; },
    },
  );
}

watch(currentRunId, (runId) => {
  if (runId) openStream(runId);
}, { immediate: true });

/** 实时连接中断提示（降级纯轮询时显示）。 */
const streamDegradedNotice = computed(() =>
  streamPhase.value === "degraded" ? "实时连接中断，已切换定时刷新" : null,
);

// ── 状态带：门序列 / 里程碑 / 当前动作 ───────────────────────────────

const lanes = computed<Record<GateId, GateLaneState>>(() => deriveGateLanes(submissions.value));

/** 门序列紧凑展示：✅ 已过 / 🟡 等待 / ⬜ 未开始 / ❌ 驳回；hover 中文名。 */
const gateChips = computed(() =>
  GATES.map((gate) => {
    const state = lanes.value[gate];
    const mark = state === "approved" ? "✅" : state === "in_review" ? "🟡" : state === "rejected" ? "❌" : "⬜";
    return { gate, mark, state, title: `${gate} ${GATE_REVIEW_NAMES[gate]} · ${GATE_LANE_STATE_TEXT[state]}` };
  }),
);

/** 每种里程碑取最新一条。 */
const latestBaselines = computed(() => {
  const byKind = new Map<string, Baseline>();
  for (const bl of baselines.value) {
    const prev = byKind.get(bl.kind);
    if (!prev || bl.created_at > prev.created_at) byKind.set(bl.kind, bl);
  }
  return byKind;
});

const milestoneChips = computed(() =>
  BASELINE_KINDS.map((kind) => ({
    kind,
    active: latestBaselines.value.has(kind),
    title: latestBaselines.value.has(kind)
      ? `${kind} ${BASELINE_NAMES[kind]} · ${BASELINE_STATE_TEXT[latestBaselines.value.get(kind)!.state] ?? "已建立"} · ${new Date(latestBaselines.value.get(kind)!.created_at).toLocaleString("zh-CN")}`
      : `${kind} ${BASELINE_NAMES[kind]} · 未建立`,
  })),
);

/** 「当前动作」一句话（v3 §4）：awaiting 高亮 / running 阶段+已用时 / 终态人话。 */
const action = computed(() => {
  if (!detail.value) return null;
  const d = detail.value;
  const lastAuditTs = d.audit.length > 0 ? d.audit[d.audit.length - 1]!.ts : null;
  const startedAt = actionStartedAt(d.status, approvalSub.value?.submitted_at ?? null, lastAuditTs);
  const elapsedMs = startedAt ? nowTick.value - Date.parse(startedAt) : null;
  return currentAction({
    status: d.status,
    stageName: d.current_stage ? (STAGE_NAME_TEXT[normalizeStageId(d.current_stage)] ?? null) : null,
    awaitingReview: d.awaiting_gate ? (GATE_REVIEW_NAMES[d.awaiting_gate as GateId] ?? null) : null,
    elapsedMs: Number.isFinite(elapsedMs as number) ? elapsedMs : null,
  });
});

const runStatusLabel = computed(() => (detail.value ? (TASK_STATUS_TEXT[detail.value.status] ?? detail.value.status) : ""));

/** 切换任务：只换对话流与 SSE 订阅，后台任务继续跑。 */
function switchRun(runId: string): void {
  if (runId === currentRunId.value) return;
  currentRunId.value = runId;
  detail.value = null;
  void refresh().then(() => scrollToBottom(true));
}

// ── 对话流（auditToParts + 底部锚定滚动）────────────────────────────

const auditParts = computed<readonly SynthiaPart[]>(() => (detail.value ? auditToParts(detail.value) : []));

// ── 实时流（SSE）：streaming feed 与轮询 parts 共存（SSE 优先即时渲染，轮询兜底）──

const streamFeed = ref<readonly StreamFeedPart[]>([]);
const streamPhase = ref<StreamPhase>("connecting");
/** 流式 part 投影缓存（id → Projection），代码围栏增量续写不重排。 */
const projections = new Map<string, Projection>();

/** SSE 打开的 text part：渲染为流式 markdown 投影（streaming 时 live 尾块）。 */
const streamingTextParts = computed<readonly SynthiaTextPart[]>(() =>
  streamFeed.value.map((p) => {
    const prev = projections.get(p.id);
    const next = projectMarkdown(prev, p.text, p.state === "streaming");
    projections.set(p.id, next);
    return { kind: "text" as const, id: p.id, role: "agent" as const, state: p.state, text: p.text, segments: null };
  }),
);

/**
 * 合成对话流：轮询 parts（audit 物化）+ 追加流式 text parts。
 * 同 id 冲突时（定稿事件与 audit 的 free_agent_reply 同时到达）以 audit 为准。
 */
const parts = computed<readonly SynthiaPart[]>(() => {
  // Turn-scoped ordering (dsh/opencode semantics): audit parts render in
  // seq order; a LIVE streamed part renders in place of the audit reply it
  // corresponds to, not appended at the end. Match by exact text fingerprint
  // (SSE finalize sp-* vs audit t<seq> share text, not ids).
  const streamedDone = new Set(
    streamFeed.value.filter((s) => s.kind === "text" && s.state === "done").map((s) => s.text.trim()),
  );
  // Streaming (in-flight) parts append at the tail — they have no audit copy yet.
  const liveOnes = streamingTextParts.value.filter((p) => p.state === "streaming");
  const replaced = auditParts.value.map((p) => {
    if (p.kind !== "text" || p.role !== "agent" || p.state !== "done") return p;
    return streamedDone.has(p.text.trim()) ? { ...p, streamedFinal: true } : p;
  });
  // Drop the audit copy when its streamed twin already finalized in place:
  // mark-and-swap — replace audit text part content with the streamed one's.
  const base = replaced.map((p) => {
    if (p.kind === "text" && p.role === "agent" && (p as SynthiaTextPart & { streamedFinal?: boolean }).streamedFinal) {
      const twin = streamFeed.value.find((s) => s.kind === "text" && s.text.trim() === p.text.trim());
      if (twin) return { ...p, id: twin.id, segments: null } as SynthiaPart;
    }
    return p;
  });
  return [...base, ...liveOnes];
});

/** 任务切换器短标签（优先显示任务文案前 18 字）。 */
function taskShortLabel(run: TaskRunSummary): string {
  const d = detail.value;
  const text = run.run_id === d?.run_id && d.task ? d.task : run.run_id;
  return text.length > 18 ? `${text.slice(0, 18)}…` : text;
}

/** SSE 流式 part 的块投影（非流式 part 返回 null 走原渲染）。 */
function streamProjection(part: SynthiaTextPart): Projection | null {
  return streamFeed.value.some((s) => s.id === part.id) ? projections.get(part.id) ?? null : null;
}

/** 展开的工具/门禁卡（error 可展开）。 */
const expandedParts = ref<ReadonlySet<string>>(new Set());
function togglePart(id: string): void {
  expandedParts.value = toggleSetKey(expandedParts.value, id);
}

const feedEl = ref<HTMLElement | null>(null);
/** 用户上滚时暂停自动滚动（距底 > 80px 视为离开底部）。 */
const stickBottom = ref(true);

function onFeedScroll(): void {
  const el = feedEl.value;
  if (!el) return;
  stickBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function scrollToBottom(force = false): void {
  if (!force && !stickBottom.value) return;
  void nextTick(() => {
    const el = feedEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(parts, () => scrollToBottom());

// ── 可插话：发送（默认入队）+「直接插入」（abort + 立即新消息）────────

const messageDraft = ref("");
const sending = ref(false);
const sendErrorText = ref<string | null>(null);

/** 运行中发送 = steer（入队，下一工具间隙生效）；发送后显示「已排队」标记。 */
const queuedNotice = ref<string | null>(null);

async function handleSend(): Promise<void> {
  const text = messageDraft.value.trim();
  if (!text || !currentRunId.value || sending.value) return;
  sending.value = true;
  sendErrorText.value = null;
  try {
    const result = await sendMessage(api, projectId, currentRunId.value, text);
    messageDraft.value = "";
    if (result.steered) queuedNotice.value = text;
    void refresh();
  } catch (err) {
    sendErrorText.value = humanizeDecisionError(err, "发送").text;
  } finally {
    sending.value = false;
  }
}

/** 「直接插入」：abort 当前轮 + 立即以新消息重新 prompt（流内留打断标记卡）。 */
const inserting = ref(false);
async function handleInterruptSend(): Promise<void> {
  const text = messageDraft.value.trim();
  if (!text || !currentRunId.value || inserting.value) return;
  inserting.value = true;
  sendErrorText.value = null;
  try {
    await abortRun(api, projectId, currentRunId.value);
    await sendMessage(api, projectId, currentRunId.value, text);
    messageDraft.value = "";
    queuedNotice.value = null;
    void refresh();
  } catch (err) {
    sendErrorText.value = humanizeDecisionError(err, "发送").text;
  } finally {
    inserting.value = false;
  }
}

function onMessageEnter(e: KeyboardEvent): void {
  if (e.shiftKey) return;
  e.preventDefault();
  void handleSend();
}

const composerRunning = computed(() => detail.value?.status === "running");

// ── 空项目首屏（居中对话框 + 示例任务卡）────────────────────────────

const newTaskText = ref("");
const taskCreating = ref(false);
const taskErrorText = ref<string | null>(null);

function useExample(text: string): void {
  newTaskText.value = text;
}

async function startNewTask(): Promise<void> {
  const task = newTaskText.value.trim();
  if (task.length === 0 || taskCreating.value) return;
  taskCreating.value = true;
  taskErrorText.value = null;
  try {
    const { runId } = await createTask(api, projectId, { task, mode: "agent" }, crypto.randomUUID());
    currentRunId.value = runId;
    newTaskText.value = "";
    await refresh();
  } catch (err) {
    taskErrorText.value = humanizeDecisionError(err, "发送").text;
  } finally {
    taskCreating.value = false;
  }
}

function onNewTaskEnter(e: KeyboardEvent): void {
  if (e.shiftKey) return;
  e.preventDefault();
  void startNewTask();
}

// ── 底部审批抽屉（run awaiting_approval 且 submission in_review）────

const approvalSub = ref<GateSubmission | null>(null);
const members = ref<ApprovalMember[] | null>(null);
const membersResolved = ref(false);
const membersErrorText = ref<string | null>(null);

watch(
  () => [detail.value?.status, detail.value?.awaiting_gate, submissions.value] as const,
  ([status, gate]) => {
    if (status !== "awaiting_approval" || !gate) return;
    const found = findApprovalSubmission(submissions.value, gate);
    if (found && found.id !== approvalSub.value?.id) {
      approvalSub.value = found;
      members.value = null;
      membersResolved.value = false;
      membersErrorText.value = null;
      memberContent.value = new Map();
      expandedMembers.value = new Set();
      rejectReason.value = "";
      rejectionReason.value = null;
      void loadMembers(found);
    }
  },
  { immediate: true },
);

/** 抽屉开合：pending 时滑出；批准/驳回后（state 已决）收起。 */
const drawerOpen = computed(() =>
  detail.value?.status === "awaiting_approval"
  && approvalSub.value !== null
  && approvalSub.value.state === "in_review",
);

/** 已决卡（流内事件卡）：批准 → ✓ + 里程碑行；驳回 → ✗ + 理由。 */
const decidedCard = computed(() => {
  const sub = approvalSub.value;
  if (!sub || drawerOpen.value) return null;
  if (sub.state === "approved") return { kind: "approved" as const, gate: sub.gate };
  if (sub.state === "rejected") return { kind: "rejected" as const, gate: sub.gate };
  return null;
});

const approvalGate = computed(() => approvalSub.value?.gate ?? "");
const approvalReviewName = computed(() => GATE_REVIEW_NAMES[approvalGate.value as GateId] ?? approvalGate.value);
const approveLabel = computed(() => approvalButtonLabel(approvalGate.value));
const milestoneLine = computed(() => approvalMilestoneLine(approvalGate.value));

async function loadMembers(sub: GateSubmission): Promise<void> {
  try {
    const resolved = await resolveSnapshotMembers(api, projectId, sub.snapshot_id);
    if (approvalSub.value?.id !== sub.id) return;
    members.value = resolved;
    membersResolved.value = resolved !== null;
    membersErrorText.value = null;
  } catch (err) {
    if (approvalSub.value?.id !== sub.id) return;
    membersErrorText.value = humanizeLoadError(err);
  }
}

/** 待审产物逐份展开（markdown 阅读区）。 */
interface MemberContent {
  loading: boolean;
  error: string | null;
  html: string | null;
  text: string | null;
}
const expandedMembers = ref<ReadonlySet<string>>(new Set());
const memberContent = ref<Map<string, MemberContent>>(new Map());

async function toggleMember(revisionId: string): Promise<void> {
  expandedMembers.value = toggleSetKey(expandedMembers.value, revisionId);
  if (!expandedMembers.value.has(revisionId) || memberContent.value.has(revisionId)) return;
  const member = members.value?.find((m) => m.revisionId === revisionId);
  if (!member) return;
  memberContent.value = new Map(memberContent.value).set(revisionId, { loading: true, error: null, html: null, text: null });
  try {
    const content = await fetchMemberContent(api, projectId, member);
    memberContent.value = new Map(memberContent.value).set(revisionId, {
      loading: false,
      error: null,
      html: content === null ? null : renderMarkdown(content),
      text: content,
    });
  } catch (err) {
    memberContent.value = new Map(memberContent.value).set(revisionId, {
      loading: false,
      error: humanizeLoadError(err),
      html: null,
      text: null,
    });
  }
}

// 批准 / 驳回（失败人话提示，含 active 基线冲突场景）
const approving = ref(false);
const approveFailure = ref<DecisionFailure | null>(null);
const rejectReason = ref("");
const rejecting = ref(false);
const rejectFailure = ref<DecisionFailure | null>(null);
const rejectionReason = ref<string | null>(null);

async function doApprove(): Promise<void> {
  const sub = approvalSub.value;
  if (!sub || approving.value) return;
  approving.value = true;
  approveFailure.value = null;
  try {
    const full = await getGateSubmission(api, projectId, sub.id);
    await approveGateSubmission(api, projectId, sub.id, await buildApproveBody(full), crypto.randomUUID());
    approvalSub.value = await getGateSubmission(api, projectId, sub.id);
    await refresh(); // 抽屉收起，流内出现已批准事件卡，Agent 自动续跑
  } catch (err) {
    approveFailure.value = humanizeDecisionError(err, "批准");
  } finally {
    approving.value = false;
  }
}

async function doReject(): Promise<void> {
  const sub = approvalSub.value;
  const reason = rejectReason.value.trim();
  if (!sub || rejecting.value || reason.length === 0) return;
  rejecting.value = true;
  rejectFailure.value = null;
  try {
    await rejectGateSubmission(api, projectId, sub.id, reason, crypto.randomUUID());
    approvalSub.value = await getGateSubmission(api, projectId, sub.id);
    rejectionReason.value = (await loadRejectionReason(api, projectId, sub.id)) ?? reason;
    await refresh();
  } catch (err) {
    rejectFailure.value = humanizeDecisionError(err, "驳回");
  } finally {
    rejecting.value = false;
  }
}

// ── 运行记录展开面板（状态带展开项；L3 技术内容仅在此）──────────────

const recordsOpen = ref(false);
const jobs = ref<JobRunSummary[]>([]);
const jobsLoading = ref(false);
const jobsError = ref<unknown>(null);

async function loadJobs(): Promise<void> {
  jobsLoading.value = true;
  jobsError.value = null;
  try {
    jobs.value = await listJobs(api, projectId);
  } catch (err) {
    jobsError.value = err;
  } finally {
    jobsLoading.value = false;
  }
}

function jobBadgeKind(state: string): "ok" | "warn" | "danger" | "accent" | "plain" {
  if (state === "succeeded") return "ok";
  if (["failed", "timeout", "lost", "unknown_effect", "rejected"].includes(state)) return "danger";
  if (["running", "queued", "preparing", "submitted", "cancelling"].includes(state)) return "accent";
  return "plain";
}

const expandedJob = ref<string | null>(null);
const jobEvidence = ref<JobEvidenceManifest | null>(null);
const evidenceLoading = ref(false);
const evidenceError = ref<unknown>(null);

async function toggleJob(jobId: string): Promise<void> {
  if (expandedJob.value === jobId) {
    expandedJob.value = null;
    jobEvidence.value = null;
    evidenceError.value = null;
    return;
  }
  expandedJob.value = jobId;
  jobEvidence.value = null;
  evidenceError.value = null;
  evidenceContent.value = null;
  evidenceLoading.value = true;
  try {
    jobEvidence.value = await getJobEvidence(api, projectId, jobId);
  } catch (err) {
    evidenceError.value = err;
  } finally {
    evidenceLoading.value = false;
  }
}

const evidenceContent = ref<JobEvidenceContent | null>(null);
const evidenceContentLoading = ref(false);
const evidenceContentError = ref<unknown>(null);

async function openEvidence(jobId: string, name: string): Promise<void> {
  evidenceContent.value = null;
  evidenceContentError.value = null;
  evidenceContentLoading.value = true;
  try {
    evidenceContent.value = await getJobEvidenceContent(api, projectId, jobId, name);
  } catch (err) {
    evidenceContentError.value = err;
  } finally {
    evidenceContentLoading.value = false;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

// ── 产物阅读抽屉（对话流产物卡点开右侧滑出）────────────────────────

const readingDoc = ref<{ title: string; html: string | null; loading: boolean; error: string | null } | null>(null);

async function openDoc(docArtifactId: string, docRevisionId: string, title: string): Promise<void> {
  readingDoc.value = { title, html: null, loading: true, error: null };
  try {
    const data = await getRevisionContent(api, projectId, docArtifactId, docRevisionId);
    readingDoc.value = { title, html: renderMarkdown(data.content), loading: false, error: null };
  } catch (err) {
    readingDoc.value = { title, html: null, loading: false, error: humanizeLoadError(err) };
  }
}

/** 交付摘要导出（占位按钮；后端另立切片）。 */
function exportSummary(): void {
  window.alert("《交付摘要》导出功能将在后续切片提供（后端生成服务待接入）。");
}
</script>

<template>
  <div class="v3page">
    <!-- ── 顶部状态带（常驻紧凑；运行记录为展开面板）────────────── -->
    <header class="band" data-component="status-band">
      <div class="band-row">
        <div class="band-project">
          <b>{{ project?.name ?? projectId }}</b>
          <StatusBadge v-if="detail" :kind="action?.tone === 'awaiting' ? 'warn' : action?.tone === 'running' ? 'accent' : action?.tone === 'done' ? 'ok' : action?.tone === 'failed' ? 'danger' : 'plain'" :text="runStatusLabel" />
        </div>

        <!-- 任务切换器：多任务并存，切换只换对话流，后台继续跑 -->
        <label class="band-tasks">
          <span class="muted band-label">任务</span>
          <select class="band-select" :value="currentRunId ?? ''" @change="switchRun(($event.target as HTMLSelectElement).value)">
            <option v-for="run in runs" :key="run.run_id" :value="run.run_id">
              [{{ TASK_STATUS_TEXT[run.status] ?? run.status }}] {{ taskShortLabel(run) }}
            </option>
          </select>
        </label>

        <!-- 门序列 G1-G9（hover 中文名）+ 里程碑徽章 -->
        <div class="band-gates" aria-label="门序列">
          <span v-for="chip in gateChips" :key="chip.gate" class="gate-chip" :class="chip.state" :title="chip.title">{{ chip.gate }}{{ chip.mark }}</span>
        </div>
        <div class="band-milestones" aria-label="里程碑">
          <span v-for="chip in milestoneChips" :key="chip.kind" class="ms-chip" :class="chip.active ? 'active' : 'inactive'" :title="chip.title">
            {{ chip.kind }}{{ chip.active ? "✓" : "○" }}
          </span>
        </div>

        <!-- 当前动作一句话（awaiting 高亮） -->
        <div v-if="action" class="band-action" :class="action.tone">{{ action.text }}</div>

        <!-- 运行记录入口（状态带展开面板；L3 仅在此） -->
        <button class="band-records-btn" type="button" :class="{ on: recordsOpen }" @click="recordsOpen = !recordsOpen">
          运行记录
        </button>
      </div>

      <!-- 展开面板：工具运行 + 证据（L3） -->
      <div v-if="recordsOpen" class="band-records" data-component="records-panel">
        <div class="band-records-head">
          <b>运行记录</b>
          <span class="muted" style="font-size: 12px">技术细节（工具运行、证据、关联号）仅在此面板可见。</span>
          <a class="btn-link" @click.prevent="recordsOpen = false">收起</a>
        </div>
        <ErrorNotice v-if="loadErrorBanner" :error="loadErrorBanner" />
        <div v-if="jobsLoading" class="muted">运行记录加载中…</div>
        <ErrorNotice v-else-if="jobsError" :error="jobsError" />
        <div v-else-if="jobs.length === 0" class="muted">该项目暂无工具运行。</div>
        <div v-for="job in jobs" :key="job.id" class="job-row">
          <div class="job-row-head" @click="toggleJob(job.id)">
            <span class="job-op">{{ jobOperationText(job.operation) }}</span>
            <StatusBadge :text="JOB_STATE_TEXT[job.state] ?? job.state" :kind="jobBadgeKind(job.state)" />
            <span class="muted" style="font-size: 12px">{{ JOB_RUN_CLASS_TEXT[job.runClass] ?? job.runClass }}</span>
            <span v-if="jobDurationText(job.startTime, job.endTime)" class="muted" style="font-size: 12px">
              {{ jobDurationText(job.startTime, job.endTime) }}
            </span>
            <span v-if="job.errorCode" class="job-error mono" :title="job.id">{{ job.errorCode }}</span>
          </div>
          <div v-if="expandedJob === job.id" class="job-detail">
            <div class="muted mono" style="font-size: 11px">{{ job.id }}</div>
            <div v-if="evidenceLoading" class="muted">证据清单加载中…</div>
            <ErrorNotice v-else-if="evidenceError" :error="evidenceError" />
            <template v-else-if="jobEvidence">
              <div v-if="jobEvidence.entries.length === 0" class="muted">该运行无证据条目。</div>
              <table v-else class="data">
                <thead><tr><th>文件</th><th>大小</th><th>SHA-256</th></tr></thead>
                <tbody>
                  <tr v-for="entry in jobEvidence.entries" :key="entry.name">
                    <td><a :title="entry.mediaType" @click.prevent="openEvidence(job.id, entry.name)">{{ entry.name }}</a></td>
                    <td class="muted">{{ formatBytes(entry.sizeBytes) }}</td>
                    <td class="mono muted" style="font-size: 11px">{{ entry.sha256.slice(0, 16) }}…</td>
                  </tr>
                </tbody>
              </table>
            </template>
            <div v-if="evidenceContentLoading" class="muted" style="margin-top: 8px">证据内容加载中…</div>
            <ErrorNotice v-else-if="evidenceContentError" :error="evidenceContentError" />
            <div v-else-if="evidenceContent" class="panel" style="margin-top: 8px; background: #fbfcfd">
              <div class="mono muted" style="font-size: 11px">{{ evidenceContent.name }}{{ evidenceContent.truncated ? "（内容过长已截断）" : "" }}</div>
              <pre class="code-view">{{ evidenceContent.content }}</pre>
            </div>
          </div>
        </div>
      </div>
    </header>

    <!-- ── 全宽对话流 ───────────────────────────────────────────── -->
    <main class="v3main">
      <div v-if="loading" class="muted" style="padding: 32px; text-align: center">加载中…</div>

      <!-- 空项目首屏：居中对话框 + 示例任务卡 -->
      <div v-else-if="runs.length === 0" class="empty-hero">
        <div class="empty-hero-title">开始你的第一个任务</div>
        <p class="muted" style="font-size: 13px; margin: 6px 0 20px">描述工程目标，Synthia 将从需求推进到码流。</p>
        <div v-if="taskErrorText" class="notice error">{{ taskErrorText }}</div>
        <textarea
          v-model="newTaskText"
          class="composer-input empty-hero-input"
          rows="4"
          placeholder="例如：设计一个 UART 收发器，9600 波特率、8N1、100MHz 时钟，完成从需求到码流的 GJB 全流程"
          :disabled="taskCreating"
          @keydown.enter="onNewTaskEnter"
        />
        <button class="composer-send" type="button" :disabled="taskCreating || newTaskText.trim().length === 0" @click="startNewTask">
          {{ taskCreating ? "启动中…" : "启动新任务" }}
        </button>
        <div class="example-cards">
          <button v-for="example in EXAMPLE_TASKS" :key="example" type="button" class="example-card" @click="useExample(example)">
            {{ example }}
          </button>
        </div>
      </div>

      <!-- 有任务：对话流 + 底部输入 -->
      <template v-else>
        <div v-if="streamDegradedNotice" class="notice v3-loaderr" style="background:#fdf6ec;border-color:#e6d3b3">{{ streamDegradedNotice }}</div>
        <div v-if="loadErrorBanner" class="notice error v3-loaderr">{{ loadErrorBanner }}</div>

        <div ref="feedEl" class="feed v3-feed" @scroll.passive="onFeedScroll">
          <template v-for="part in parts" :key="part.id">
            <!-- 用户气泡（右）；Agent 叙述（左，永不折叠） -->
            <div v-if="part.kind === 'text' && part.role === 'user'" class="msg-user feed-msg-user">
              <div>{{ part.text }}</div>
            </div>
            <div v-else-if="part.kind === 'text' && !part.text.trim() && part.state === 'streaming'" class="feed-reply streaming-empty" :data-state="part.state">
              <span class="streaming-cursor" aria-label="生成中">▍</span>
            </div>

            <div v-else-if="part.kind === 'text'" class="feed-reply" :data-state="part.state">
              <template v-if="streamProjection(part) !== null">
                <template v-for="block in streamProjection(part)!.blocks" :key="`${part.id}:${block.raw.length}:${block.mode}`">
                  <div v-if="block.mode === 'code'" class="code-view reply-code">{{ block.src }}</div>
                  <div v-else class="markdown-body feed-text" v-html="renderMarkdown(block.src)"></div>
                </template>
              </template>
              <ReplySegments v-else-if="part.segments" :segments="part.segments" :part-key="part.id" />
              <div v-else class="feed-text">{{ part.text }}</div>
              <span v-if="part.state === 'streaming'" class="streaming-cursor" aria-label="生成中">▍</span>
            </div>

            <!-- 工具条四态：pending 微光+不可展开 / running / completed 弱化+耗时 / error 红可展开 -->
            <div
              v-else-if="part.kind === 'tool'"
              class="tool-bar"
              :class="part.status"
              role="button"
              :tabindex="part.status === 'error' ? 0 : -1"
              :aria-expanded="part.status === 'error' ? expandedParts.has(part.id) : undefined"
              @click="part.status === 'error' && togglePart(part.id)"
              @keydown.enter.prevent="part.status === 'error' && togglePart(part.id)"
            >
              <span class="bar-icon">◆</span>
              <span class="bar-title">{{ part.title }}</span>
              <span v-if="part.status === 'completed'" class="bar-mark">✓</span>
              <span v-else-if="part.status === 'error'" class="bar-mark">✗ {{ expandedParts.has(part.id) ? "收起" : "详情" }}</span>
              <span v-if="part.status === 'pending' || part.status === 'running'" class="bar-mark">{{ part.status === 'pending' ? "准备中" : "运行中" }}</span>
              <span v-if="toolDurationLabel(part.durationMs)" class="bar-duration">{{ toolDurationLabel(part.durationMs) }}</span>
              <div v-if="part.status === 'error' && expandedParts.has(part.id) && part.errorText" class="bar-detail">
                <ReplySegments :segments="[makeTextSegment(`${part.id}-reason`, part.errorText)]" :part-key="`${part.id}-reason`" />
              </div>
            </div>

            <!-- 门禁状态事件卡 -->
            <div v-else-if="part.kind === 'gate'" class="event-card" :class="part.state">
              <span class="event-mark">{{ part.state === "passed" ? "✓" : part.state === "failed" ? "✗" : part.state === "awaiting" ? "⏸" : "…" }}</span>
              <span>{{ part.review }}<template v-if="part.state === 'passed'">已通过</template><template v-else-if="part.state === 'awaiting'">正在等待批准</template><template v-else-if="part.state === 'failed'">未通过</template><template v-else>评审中…</template></span>
            </div>

            <!-- 产物卡（点开右侧抽屉阅读） -->
            <button v-else-if="part.kind === 'doc'" type="button" class="file-card" @click="openDoc(part.doc.artifact_id, part.doc.revision_id, part.title)">
              <span class="bar-icon">▤</span>
              <span class="bar-title">《{{ part.title }}》</span>
              <StatusBadge text="候选" kind="accent" />
              <span class="bar-mark">阅读 →</span>
            </button>

            <!-- 治理事件卡 -->
            <div v-else-if="part.kind === 'governance'" class="event-card muted-card">{{ part.text }}</div>

            <!-- 证据摘要（详情在记录面板） -->
            <div v-else-if="part.kind === 'evidence'" class="tool-bar evidence-bar">
              <span class="bar-icon">▦</span>
              <span class="bar-title">证据链 · {{ part.count }} 项</span>
              <a class="bar-mark" @click.prevent="recordsOpen = true">查看运行记录 →</a>
            </div>

            <!-- 大成功卡 / 失败对话式汇报（无弹窗无按钮组） -->
            <div v-else-if="part.kind === 'lifecycle'" class="terminal-card" :class="part.state">
              <template v-if="part.state === 'succeeded'">
                <div class="terminal-title">🏁 {{ part.text }}</div>
                <div v-if="part.bitstream" class="terminal-meta">
                  码流 {{ part.bitstream.name }} · {{ formatBytes(part.bitstream.sizeBytes) }} · SHA-256 前 16 位 {{ part.bitstream.sha256.slice(0, 16) }}…
                </div>
                <div class="terminal-meta">证据链 {{ part.evidenceCount }} 项（运行记录可查）</div>
                <div class="terminal-actions">
                  <span class="muted" style="font-size: 12px">下载入口即将开放</span>
                  <button class="btn secondary" type="button" @click="exportSummary">导出《交付摘要》</button>
                </div>
              </template>
              <template v-else>
                <div class="terminal-title">{{ part.text }}</div>
                <div class="terminal-meta muted">技术原因与关联号见运行记录。</div>
              </template>
            </div>

            <!-- 提示卡（排队注入 / 回复错误） -->
            <div v-else-if="part.kind === 'note'" class="event-card note-card" :class="part.tone">{{ part.text }}</div>

            <!-- 打断标记卡 -->
            <div v-else-if="part.kind === 'interrupt'" class="event-card interrupt-card">⚡ {{ part.text }}</div>
          </template>

          <!-- 已排队标记（steer 已注入，尚未生效） -->
          <div v-if="queuedNotice" class="event-card note-card queued">已排队：「{{ queuedNotice.length > 40 ? queuedNotice.slice(0, 40) + "…" : queuedNotice }}」将在 Agent 当前工具结束后生效</div>

          <!-- 已决审批事件卡（流内记录；抽屉已收起） -->
          <div v-if="decidedCard?.kind === 'approved'" class="event-card passed">
            ✓ 已批准 {{ GATE_REVIEW_NAMES[decidedCard.gate as GateId] ?? decidedCard.gate }}
            <template v-if="milestoneLine">&nbsp;{{ milestoneLine }}</template>
          </div>
          <div v-else-if="decidedCard?.kind === 'rejected'" class="event-card failed">
            ✗ 已驳回 {{ GATE_REVIEW_NAMES[decidedCard.gate as GateId] ?? decidedCard.gate }}<template v-if="rejectionReason">（理由：{{ rejectionReason }}）</template>
          </div>

          <div v-if="detail && parts.length === 0" class="muted" style="padding: 8px 0">正在启动，暂无进展。</div>
        </div>

        <!-- 底部输入：运行时不锁死；发送=入队；「直接插入」=打断 -->
        <div class="composer v3-composer">
          <textarea
            v-model="messageDraft"
            class="composer-input"
            rows="2"
            :placeholder="composerRunning ? '发送将入队，Agent 在当前工具结束后处理；或点「直接插入」立即打断' : '给 Agent 发消息…'"
            :disabled="sending || inserting"
            @keydown.enter="onMessageEnter"
          />
          <div class="composer-actions">
            <button
              v-if="composerRunning"
              class="btn danger"
              type="button"
              :disabled="inserting || sending || messageDraft.trim().length === 0"
              :title="composerRunning ? '终止当前回复并立即发送新消息（流内留打断标记）' : undefined"
              @click="handleInterruptSend"
            >
              {{ inserting ? "插入中…" : "直接插入" }}
            </button>
            <button class="composer-send" type="button" :disabled="sending || inserting || messageDraft.trim().length === 0" @click="handleSend">
              {{ sending ? "发送中…" : composerRunning ? "入队发送" : "发送" }}
            </button>
          </div>
        </div>
        <div v-if="sendErrorText" class="notice error" style="margin: 0 16px 8px">{{ sendErrorText }}</div>
      </template>
    </main>

    <!-- ── 产物阅读抽屉（右侧滑出）────────────────────────────── -->
    <div v-if="readingDoc" class="drawer right-drawer" role="dialog" aria-label="产物阅读">
      <div class="drawer-head">
        <b>《{{ readingDoc.title }}》</b>
        <a class="btn-link" @click.prevent="readingDoc = null">关闭</a>
      </div>
      <div class="drawer-body">
        <div v-if="readingDoc.loading" class="muted">内容加载中…</div>
        <div v-else-if="readingDoc.error" class="notice error">{{ readingDoc.error }}</div>
        <div v-else-if="readingDoc.html" class="markdown-body" v-html="readingDoc.html"></div>
        <div v-else class="muted">（该产物无内联内容）</div>
      </div>
    </div>
    <div v-if="readingDoc" class="drawer-mask" @click="readingDoc = null"></div>

    <!-- ── 底部审批抽屉（awaiting 时半屏滑出）──────────────────── -->
    <transition name="drawer-slide">
      <div v-if="drawerOpen && approvalSub" class="drawer bottom-drawer" role="dialog" aria-label="审批">
        <div class="drawer-head">
          <b>⏸ {{ approvalReviewName }}等待你批准</b>
          <span class="muted" style="font-size: 12px">
            提交于 {{ approvalSub.submitted_at ? new Date(approvalSub.submitted_at).toLocaleString("zh-CN") : "—" }}
          </span>
        </div>

        <div class="bottom-drawer-body">
          <!-- 待审产物列表：快照成员 → GJB 文档名 → 展开 markdown 阅读区 -->
          <div class="approval-card-section">待审候选产物（{{ members?.length ?? 0 }}，均为候选）</div>
          <div v-if="membersErrorText" class="notice error">{{ membersErrorText }}</div>
          <div v-if="!membersResolved && !membersErrorText" class="muted" style="font-size: 12px">产物清单解析中…</div>
          <template v-else-if="members">
            <div v-for="m in members" :key="m.revisionId" class="approval-doc">
              <div class="approval-doc-head">
                <b>《{{ m.docName }}》</b>
                <span class="badge accent">v{{ m.version ?? "?" }} 候选</span>
                <a class="approval-doc-toggle" @click.prevent="toggleMember(m.revisionId)">
                  {{ expandedMembers.has(m.revisionId) ? "收起" : "展开" }}
                </a>
              </div>
              <div v-if="expandedMembers.has(m.revisionId)" class="approval-doc-body">
                <div v-if="memberContent.get(m.revisionId)?.loading" class="muted">内容加载中…</div>
                <div v-else-if="memberContent.get(m.revisionId)?.error" class="notice error">{{ memberContent.get(m.revisionId)!.error }}</div>
                <div v-else-if="memberContent.get(m.revisionId)?.html" class="markdown-body" v-html="memberContent.get(m.revisionId)!.html"></div>
                <div v-else-if="memberContent.has(m.revisionId)" class="muted">（该产物无内联内容）</div>
                <div v-else class="muted">点击「展开」查看文档内容。</div>
              </div>
            </div>
          </template>

          <!-- 操作区：里程碑文案 + 驳回理由必填；失败人话提示 -->
          <div class="approval-actions">
            <div v-if="approveFailure" class="notice error">
              {{ approveFailure.text }}
              <div v-if="approveFailure.hint" class="muted" style="font-size: 12px; margin-top: 4px">{{ approveFailure.hint }}</div>
            </div>
            <div v-if="rejectFailure" class="notice error">
              {{ rejectFailure.text }}
              <div v-if="rejectFailure.hint" class="muted" style="font-size: 12px; margin-top: 4px">{{ rejectFailure.hint }}</div>
            </div>
            <button class="btn approval-approve-btn" :disabled="approving" @click="doApprove">
              {{ approving ? "提交中…" : approveLabel }}
            </button>
            <div class="approval-reject-row">
              <input
                v-model="rejectReason"
                type="text"
                class="approval-reject-input"
                placeholder="驳回理由（必填）"
                :disabled="rejecting"
                @keydown.enter.prevent="!rejectDisabled(rejectReason) && doReject()"
              />
              <button class="btn danger" :disabled="rejecting || rejectDisabled(rejectReason)" @click="doReject">
                {{ rejecting ? "提交中…" : "驳回" }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>
