<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { api } from "../main.ts";
import {
  approveGateSubmission,
  createTask,
  getGateSubmission,
  getJobEvidence,
  getJobEvidenceContent,
  getProject,
  getRevisionContent,
  getTask,
  listArtifacts,
  listBaselines,
  listGateSubmissions,
  listJobs,
  listRevisions,
  listTasks,
  rejectGateSubmission,
  sendMessage,
} from "../api/index.ts";
import type {
  Artifact,
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
  GATE_REVIEW_NAMES,
  BASELINE_KINDS,
  BASELINE_NAMES,
  BASELINE_STATE_TEXT,
  REVISION_STATE_TEXT,
  currentGate,
  deriveGateLanes,
  type GateId,
  type GateLaneState,
} from "../domain/gates.ts";
import {
  TASK_STATUS_TEXT,
  buildFeed,
  createPoller,
  formatDuration,
  type FeedPart,
  type Poller,
} from "../domain/tasks.ts";
import {
  artifactDocName,
  artifactGroupName,
  ARTIFACT_GROUP_ORDER,
} from "../domain/artifacts.ts";
import {
  JOB_RUN_CLASS_TEXT,
  JOB_STATE_TEXT,
  UNIFIED_TABS,
  approvalButtonLabel,
  approvalMilestoneLine,
  buildApproveBody,
  deriveApprovalCard,
  fetchMemberContent,
  findApprovalSubmission,
  jobDurationText,
  jobOperationText,
  loadRejectionReason,
  rejectDisabled,
  resolveSnapshotMembers,
  tabFromQuery,
  type ApprovalMember,
  type UnifiedTab,
} from "../domain/unified.ts";
import { renderMarkdown } from "../domain/markdown.ts";
import { makeTextSegment, toggleSetKey } from "../domain/reply-segments.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import GateSwimlane from "../components/GateSwimlane.vue";
import ReplySegments from "../components/ReplySegments.vue";
import StatusBadge from "../components/StatusBadge.vue";

/**
 * 统一项目页（UI-3 方案 B+就地审批）：
 * 左栏 60% 对话工作台（信息流 + 就地审批卡 + 消息输入/新任务引导），
 * 右栏 40% 三标签（流程 G0~G9 + B0~B4 / 产物 GJB 分组 / 记录 jobs+证据）。
 */
const route = useRoute();
const projectId = String(route.params.id);

// ── 基础数据 ─────────────────────────────────────────────────────────

const project = ref<ProjectDetail | null>(null);
const runs = ref<readonly TaskRunSummary[]>([]);
const currentRunId = ref<string | null>(typeof route.query.run === "string" ? route.query.run : null);
const detail = ref<TaskRunDetail | null>(null);
const loading = ref(true);
const error = ref<unknown>(null);

// ── 右栏标签与数据 ───────────────────────────────────────────────────

const tab = ref<UnifiedTab>(tabFromQuery(route.query.tab));
const submissions = ref<GateSubmission[]>([]);
const baselines = ref<Baseline[]>([]);
const artifacts = ref<Artifact[]>([]);
const jobs = ref<JobRunSummary[]>([]);

const lanes = computed<Record<GateId, GateLaneState>>(() => deriveGateLanes(submissions.value));

/** 每种里程碑取最新一条（同 kind 可能被替换多次）。 */
const latestBaselines = computed(() => {
  const byKind = new Map<string, Baseline>();
  for (const bl of baselines.value) {
    const prev = byKind.get(bl.kind);
    if (!prev || bl.created_at > prev.created_at) byKind.set(bl.kind, bl);
  }
  return byKind;
});

// ── 刷新与轮询（3s）─────────────────────────────────────────────────

let poller: Poller | null = null;
let refreshing = false;

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const [subList, blList] = await Promise.all([
      listGateSubmissions(api, projectId),
      listBaselines(api, projectId),
    ]);
    submissions.value = subList;
    baselines.value = blList;
    if (currentRunId.value) detail.value = await getTask(api, projectId, currentRunId.value);
    if (tab.value === "artifacts") artifacts.value = await listArtifacts(api, projectId);
    if (tab.value === "records") jobs.value = await listJobs(api, projectId);
    error.value = null;
  } catch (err) {
    error.value = err;
  } finally {
    refreshing = false;
    loading.value = false;
  }
}

onMounted(async () => {
  try {
    const [proj, runList] = await Promise.all([getProject(api, projectId), listTasks(api, projectId)]);
    project.value = proj;
    runs.value = [...runList.runs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    if (!currentRunId.value) currentRunId.value = runs.value[0]?.run_id ?? null;
  } catch (err) {
    error.value = err;
  } finally {
    loading.value = false;
  }
  await refresh();
  poller = createPoller(() => {
    void refresh();
    return true;
  }, 3000);
});

onBeforeUnmount(() => {
  poller?.stop();
  poller = null;
});

/** 切标签时按需补拉该标签数据（记录/产物只在激活时轮询）。 */
watch(tab, () => void refresh());

// ── 左栏：信息流（复用 buildFeed：user 气泡 + reply 叙述 + 工具/门禁/文件卡）──

const feed = computed<FeedPart[]>(() => (detail.value ? buildFeed(detail.value) : []));

/** 失败工具条/门禁条的展开状态。 */
const expandedParts = ref<ReadonlySet<string>>(new Set());

function togglePart(key: string) {
  expandedParts.value = toggleSetKey(expandedParts.value, key);
}

const GATE_BAR_TEXT: Readonly<Record<string, string>> = {
  evaluating: "评估中…",
  passed: "已通过",
  failed: "未通过",
  awaiting: "等待人工批准",
};

const statusBadgeKind = computed<"accent" | "warn" | "ok" | "danger" | "plain">(() => {
  switch (detail.value?.status) {
    case "running": return "accent";
    case "awaiting_approval": return "warn";
    case "succeeded": return "ok";
    case "failed":
    case "fail_closed": return "danger";
    default: return "plain";
  }
});

// ── 就地审批卡（信息流内，真实 state 驱动）──────────────────────────

const approvalSub = ref<GateSubmission | null>(null);

/** 待审产物 = 快照成员修订（snapshot.created payload.memberRevisionIds）。 */
const members = ref<ApprovalMember[] | null>(null);
const membersResolved = ref(false);
const membersError = ref<unknown>(null);

/** run 进入 awaiting 时绑定该门最新提交；离开后保留已决卡作为对话记录。
 *  同时依赖 submissions（轮询替换）：run 先变 awaiting、提交列表后到时也能补绑。 */
watch(
  () => [detail.value?.status, detail.value?.awaiting_gate, submissions.value] as const,
  ([status, gate]) => {
    if (status !== "awaiting_approval" || !gate) return;
    const found = findApprovalSubmission(submissions.value, gate);
    if (found && found.id !== approvalSub.value?.id) {
      approvalSub.value = found;
      members.value = null;
      membersResolved.value = false;
      membersError.value = null;
      memberContent.value = new Map();
      rejectReason.value = "";
      rejectionReason.value = null;
      void loadMembers(found);
    }
  },
  { immediate: true },
);

const cardState = computed(() =>
  deriveApprovalCard(
    { status: detail.value?.status ?? "", awaiting_gate: detail.value?.awaiting_gate ?? null },
    approvalSub.value,
  ),
);

const approvalGate = computed(() => approvalSub.value?.gate ?? "");
const approvalReviewName = computed(() => GATE_REVIEW_NAMES[approvalGate.value as GateId] ?? approvalGate.value);
const approveLabel = computed(() => approvalButtonLabel(approvalGate.value));
const milestoneLine = computed(() => approvalMilestoneLine(approvalGate.value));
/** 成员修订展开内容（按需加载 revision content）。 */
interface MemberContent {
  loading: boolean;
  error: unknown;
  html: string | null;
  text: string | null;
}
const expandedMembers = ref<ReadonlySet<string>>(new Set());
const memberContent = ref<Map<string, MemberContent>>(new Map());

async function loadMembers(sub: GateSubmission) {
  try {
    const resolved = await resolveSnapshotMembers(api, projectId, sub.snapshot_id);
    if (approvalSub.value?.id !== sub.id) return;
    members.value = resolved;
    membersResolved.value = resolved !== null;
    membersError.value = null;
  } catch (err) {
    if (approvalSub.value?.id !== sub.id) return;
    membersError.value = err;
  }
}

async function toggleMember(revisionId: string) {
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
    memberContent.value = new Map(memberContent.value).set(revisionId, { loading: false, error: err, html: null, text: null });
  }
}

// 批准/驳回
const approving = ref(false);
const approveError = ref<unknown>(null);
const rejectReason = ref("");
const rejecting = ref(false);
const rejectError = ref<unknown>(null);
const rejectionReason = ref<string | null>(null);

async function doApprove(): Promise<void> {
  const sub = approvalSub.value;
  if (!sub || approving.value) return;
  approving.value = true;
  approveError.value = null;
  try {
    const full = await getGateSubmission(api, projectId, sub.id);
    await approveGateSubmission(api, projectId, sub.id, await buildApproveBody(full), crypto.randomUUID());
    approvalSub.value = await getGateSubmission(api, projectId, sub.id);
    await refresh();
  } catch (err) {
    approveError.value = err;
  } finally {
    approving.value = false;
  }
}

async function doReject(): Promise<void> {
  const sub = approvalSub.value;
  const reason = rejectReason.value.trim();
  if (!sub || rejecting.value || reason.length === 0) return;
  rejecting.value = true;
  rejectError.value = null;
  try {
    await rejectGateSubmission(api, projectId, sub.id, reason, crypto.randomUUID());
    approvalSub.value = await getGateSubmission(api, projectId, sub.id);
    rejectionReason.value = (await loadRejectionReason(api, projectId, sub.id)) ?? reason;
    await refresh();
  } catch (err) {
    rejectError.value = err;
  } finally {
    rejecting.value = false;
  }
}

// ── 对话输入（POST /projects/:id/tasks/:runId/message）与新任务引导 ────

const messageDraft = ref("");
const sending = ref(false);
const sendError = ref<unknown>(null);

async function handleSend(): Promise<void> {
  const text = messageDraft.value.trim();
  if (!text || !currentRunId.value || sending.value) return;
  sending.value = true;
  sendError.value = null;
  try {
    await sendMessage(api, projectId, currentRunId.value, text);
    messageDraft.value = "";
    void refresh();
  } catch (err) {
    sendError.value = err;
  } finally {
    sending.value = false;
  }
}

function onMessageEnter(e: KeyboardEvent): void {
  if (e.shiftKey) return; // Shift+Enter 换行
  e.preventDefault();
  void handleSend();
}

/** 无任务时「新任务」引导（mode=agent：自由 Agent 会话）。 */
const newTaskText = ref("");
const taskCreating = ref(false);
const taskError = ref<unknown>(null);

async function startNewTask(): Promise<void> {
  const task = newTaskText.value.trim();
  if (task.length === 0 || taskCreating.value) return;
  taskCreating.value = true;
  taskError.value = null;
  try {
    const { runId } = await createTask(api, projectId, { task, mode: "agent" }, crypto.randomUUID());
    currentRunId.value = runId;
    newTaskText.value = "";
    const runList = await listTasks(api, projectId);
    runs.value = [...runList.runs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    await refresh();
  } catch (err) {
    taskError.value = err;
  } finally {
    taskCreating.value = false;
  }
}

// ── 产物标签：GJB 文档名分组 + 预览 ───────────────────────────────────

const artifactGroups = computed(() =>
  ARTIFACT_GROUP_ORDER.map((group) => ({
    group,
    items: artifacts.value.filter((a) => artifactGroupName(a.artifact_type) === group),
  })).filter((g) => g.items.length > 0),
);

interface ArtifactPreview {
  loading: boolean;
  error: unknown;
  html: string | null;
  meta: string | null;
}
const previewedArtifact = ref<string | null>(null);
const artifactPreview = ref<ArtifactPreview | null>(null);

async function toggleArtifactPreview(artifactId: string) {
  if (previewedArtifact.value === artifactId) {
    previewedArtifact.value = null;
    artifactPreview.value = null;
    return;
  }
  previewedArtifact.value = artifactId;
  artifactPreview.value = { loading: true, error: null, html: null, meta: null };
  try {
    const revisions = await listRevisions(api, projectId, artifactId);
    const latest = [...revisions].sort((a, b) => b.version - a.version)[0];
    if (!latest) {
      artifactPreview.value = { loading: false, error: null, html: null, meta: "无版本" };
      return;
    }
    const content = await getRevisionContent(api, projectId, artifactId, latest.id);
    artifactPreview.value = {
      loading: false,
      error: null,
      html: renderMarkdown(content.content),
      meta: `v${latest.version} · ${REVISION_STATE_TEXT[latest.state] ?? "候选"} · ${new Date(latest.created_at).toLocaleString("zh-CN")}`,
    };
  } catch (err) {
    artifactPreview.value = { loading: false, error: err, html: null, meta: null };
  }
}

// ── 记录标签：GET /projects/:id/jobs 列表 + 按需证据 ──────────────────

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

async function toggleJob(jobId: string) {
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

async function openEvidence(jobId: string, name: string) {
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

</script>

<template>
  <div class="unified">
    <!-- 左栏 60%：对话工作台 -->
    <section class="unified-left">
      <div class="unified-left-head">
        <b>{{ project?.name ?? projectId }}</b>
        <StatusBadge
          v-if="detail"
          :kind="statusBadgeKind"
          :text="TASK_STATUS_TEXT[detail.status] ?? detail.status"
        />
        <span class="muted" style="font-size: 12px">每 3s 自动刷新</span>
      </div>

      <ErrorNotice v-if="error" :error="error" />
      <div v-if="loading" class="muted" style="padding: 16px">加载中…</div>

      <!-- 无任务：新任务引导（mode=agent） -->
      <div v-else-if="runs.length === 0" class="onboarding">
        <div class="onboarding-title">这个项目还没有任务</div>
        <p class="muted" style="font-size: 13px">输入你的工程目标，Synthia 将以自由 Agent 模式从需求推进到码流。</p>
        <ErrorNotice v-if="taskError" :error="taskError" />
        <textarea
          v-model="newTaskText"
          class="composer-input"
          rows="3"
          placeholder="例如：设计一个 UART 收发器，9600 波特率、8N1、100MHz 时钟，完成从需求到码流的 GJB 全流程"
          :disabled="taskCreating"
        />
        <button class="composer-send" type="button" :disabled="taskCreating || newTaskText.trim().length === 0" @click="startNewTask">
          {{ taskCreating ? "启动中…" : "启动新任务" }}
        </button>
      </div>

      <!-- 有任务：信息流 + 就地审批卡 + 消息输入 -->
      <template v-else>
        <div class="unified-feed">
          <!-- 首轮指令气泡 -->
          <div v-if="detail?.task" class="msg-user">
            <div>{{ detail.task }}</div>
            <div v-if="detail" class="msg-meta">{{ new Date(detail.created_at).toLocaleString("zh-CN") }}</div>
          </div>
          <div v-if="detail && feed.length === 0 && detail.status !== 'awaiting_approval'" class="muted">正在启动，暂无进展。</div>

          <!-- assistant 信息流 -->
          <div class="feed">
            <template v-for="part in feed" :key="part.key">
              <p v-if="part.kind === 'text'" class="feed-text">{{ part.text }}</p>

              <div v-else-if="part.kind === 'user'" class="msg-user feed-msg-user">
                <div>{{ part.text }}</div>
                <div class="msg-meta">{{ new Date(part.ts).toLocaleString("zh-CN") }}</div>
              </div>

              <div v-else-if="part.kind === 'reply'" class="feed-reply">
                <ReplySegments :segments="part.segments" :part-key="part.key" />
              </div>

              <div
                v-else-if="part.kind === 'tool'"
                class="tool-bar"
                :class="[part.state, { expandable: part.state === 'failed' }]"
                @click="part.state === 'failed' && togglePart(part.key)"
              >
                <span class="bar-icon">◆</span>
                <span class="bar-title">{{ part.title }}</span>
                <span v-if="part.state === 'ok'" class="bar-mark">✓</span>
                <span v-else-if="part.state === 'failed'" class="bar-mark">✗ {{ expandedParts.has(part.key) ? "收起" : "详情" }}</span>
                <span v-if="part.durationMs !== null" class="bar-duration">{{ formatDuration(part.durationMs) }}</span>
                <div v-if="part.state === 'failed' && expandedParts.has(part.key) && part.reason" class="bar-detail">
                  <ReplySegments :segments="[makeTextSegment(`${part.key}-reason`, part.reason)]" :part-key="`${part.key}-reason`" />
                </div>
              </div>

              <div
                v-else-if="part.kind === 'gate'"
                class="tool-bar gate-bar"
                :class="[part.state, { expandable: part.state === 'failed' }]"
                @click="part.state === 'failed' && togglePart(part.key)"
              >
                <span class="bar-icon">▲</span>
                <span class="bar-title">{{ part.review }}</span>
                <span class="bar-mark">{{ GATE_BAR_TEXT[part.state] }}</span>
              </div>

              <div
                v-else-if="part.kind === 'file'"
                class="file-card"
                @click="part.doc.artifact_id && toggleArtifactPreview(part.doc.artifact_id); tab = 'artifacts'"
              >
                <span class="bar-icon">▤</span>
                <span class="bar-title">《{{ part.title }}》</span>
                <StatusBadge text="候选" kind="accent" />
              </div>

              <div v-else-if="part.kind === 'evidence'" class="tool-bar evidence-bar">
                <span class="bar-icon">▦</span>
                <span class="bar-title">已收集证据 · {{ part.count }} 项</span>
                <a class="bar-mark" @click.prevent="tab = 'records'">查看详情 →</a>
              </div>

              <div v-else-if="part.kind === 'terminal'" class="terminal-card" :class="part.state">
                {{ part.text }}
              </div>
            </template>
          </div>

          <!-- 就地审批卡（信息流内） -->
          <div v-if="cardState === 'pending' && approvalSub" class="approval-card pending">
            <div class="approval-card-title">
              ⏸ <b>{{ approvalReviewName }}等待你批准</b>
              <span class="muted approval-card-sub">提交于 {{ approvalSub.submitted_at ? new Date(approvalSub.submitted_at).toLocaleString("zh-CN") : "—" }}</span>
            </div>

            <div class="approval-card-section">待审候选产物（{{ members?.length ?? 0 }}）</div>
            <ErrorNotice v-if="membersError" :error="membersError" />
            <div v-if="!membersResolved && !membersError" class="muted" style="font-size: 12px">产物清单解析中…</div>
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
                  <ErrorNotice v-else-if="memberContent.get(m.revisionId)?.error" :error="memberContent.get(m.revisionId)!.error" />
                  <div v-else-if="memberContent.get(m.revisionId)?.html" class="markdown-body" v-html="memberContent.get(m.revisionId)!.html"></div>
                  <div v-else-if="memberContent.has(m.revisionId)" class="muted">（该产物无内联内容）</div>
                  <div v-else class="muted">点击「展开」查看文档内容。</div>
                </div>
              </div>
            </template>

            <div class="approval-actions">
              <ErrorNotice v-if="approveError" :error="approveError" />
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
                <button
                  class="btn danger"
                  :disabled="rejecting || rejectDisabled(rejectReason)"
                  @click="doReject"
                >
                  {{ rejecting ? "提交中…" : "驳回" }}
                </button>
              </div>
              <ErrorNotice v-if="rejectError" :error="rejectError" />
            </div>
          </div>

          <!-- 已批准卡（真实 state：submission.state === approved） -->
          <div v-else-if="cardState === 'approved'" class="approval-card approved">
            <div class="approval-card-title">✓ 已批准 {{ approvalReviewName }}</div>
            <div v-if="milestoneLine" class="approval-card-milestone">{{ milestoneLine }}</div>
          </div>

          <!-- 已驳回卡（真实 state：submission.state === rejected + 理由） -->
          <div v-else-if="cardState === 'rejected'" class="approval-card rejected">
            <div class="approval-card-title">✗ 已驳回 {{ approvalReviewName }}</div>
            <div v-if="rejectionReason" class="muted" style="font-size: 12px; margin-top: 4px">理由：{{ rejectionReason }}</div>
            <div class="muted" style="font-size: 12px">提交已退回，Agent 可修改后重新提交。</div>
          </div>
        </div>

        <!-- 底部消息输入 -->
        <div class="composer">
          <textarea
            v-model="messageDraft"
            class="composer-input"
            rows="2"
            :placeholder="detail?.status === 'running' ? '给 Agent 发消息纠偏…（运行中将注入上下文）' : '给 Agent 发消息…'"
            :disabled="sending"
            @keydown.enter="onMessageEnter"
          />
          <button class="composer-send" type="button" :disabled="sending || !messageDraft.trim()" @click="handleSend">
            {{ sending ? "发送中…" : "发送" }}
          </button>
        </div>
        <ErrorNotice v-if="sendError" :error="sendError" />
      </template>
    </section>

    <!-- 右栏 40%：三标签 -->
    <section class="unified-right">
      <div class="unified-tabs" role="tablist">
        <button
          v-for="t in UNIFIED_TABS"
          :key="t.id"
          type="button"
          role="tab"
          :class="{ on: tab === t.id }"
          @click="tab = t.id"
        >
          {{ t.label }}
        </button>
      </div>

      <div class="unified-tab-body">
        <!-- 流程：G0~G9 状态 + B0~B4 里程碑徽章 -->
        <template v-if="tab === 'flow'">
          <div class="unified-pane-title">阶段门（悬停查看编号）</div>
          <GateSwimlane :lanes="lanes" />
          <p class="muted" style="font-size: 12px; margin: 8px 0 16px">
            当前门：{{ currentGate(lanes) ? `${GATE_REVIEW_NAMES[currentGate(lanes)!]}（${currentGate(lanes)}）` : "全部通过，项目已交付" }}
          </p>
          <div class="unified-pane-title">里程碑</div>
          <div class="baseline-strip" style="flex-direction: column; align-items: flex-start; gap: 6px">
            <div
              v-for="kind in BASELINE_KINDS"
              :key="kind"
              class="baseline-chip"
              :class="latestBaselines.has(kind) ? 'active' : 'inactive'"
            >
              <span class="kind">{{ kind }}</span>
              <span class="name">{{ BASELINE_NAMES[kind] }}</span>
              <span v-if="latestBaselines.get(kind)" class="muted" style="font-size: 11px">
                {{ BASELINE_STATE_TEXT[latestBaselines.get(kind)!.state] ?? "已建立" }} ·
                {{ new Date(latestBaselines.get(kind)!.created_at).toLocaleString("zh-CN") }}
              </span>
            </div>
          </div>
        </template>

        <!-- 产物：GJB 文档名分组 + 预览 -->
        <template v-else-if="tab === 'artifacts'">
          <div v-if="artifactGroups.length === 0" class="muted">该项目暂无产物。</div>
          <div v-for="group in artifactGroups" :key="group.group" class="artifact-group">
            <div class="unified-pane-title">{{ group.group }}（{{ group.items.length }}）</div>
            <div v-for="a in group.items" :key="a.id" class="artifact-row">
              <div class="artifact-row-head">
                <b style="font-size: 13px">《{{ artifactDocName(a.artifact_type) }}》</b>
                <a @click.prevent="toggleArtifactPreview(a.id)">
                  {{ previewedArtifact === a.id ? "收起预览" : "预览" }}
                </a>
              </div>
              <div class="muted" style="font-size: 12px">{{ new Date(a.created_at).toLocaleString("zh-CN") }}</div>
              <div v-if="previewedArtifact === a.id" class="artifact-preview">
                <div v-if="artifactPreview?.loading" class="muted">加载中…</div>
                <ErrorNotice v-else-if="artifactPreview?.error" :error="artifactPreview.error" />
                <template v-else>
                  <div v-if="artifactPreview?.meta" class="muted" style="font-size: 12px; margin-bottom: 6px">{{ artifactPreview.meta }}</div>
                  <div v-if="artifactPreview?.html" class="markdown-body" v-html="artifactPreview.html"></div>
                </template>
              </div>
            </div>
          </div>
        </template>

        <!-- 记录：GET /projects/:id/jobs + 按需证据内容（L3 技术页） -->
        <template v-else>
          <div class="muted" style="font-size: 12px; margin-bottom: 8px">
            技术详情：工具运行与证据。此页内容是平台内部机制，日常无需关注。
          </div>
          <div v-if="jobs.length === 0" class="muted">该项目暂无工具运行。</div>
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
                  <thead>
                    <tr><th>文件</th><th>大小</th><th>SHA-256</th></tr>
                  </thead>
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
        </template>
      </div>
    </section>
  </div>
</template>
