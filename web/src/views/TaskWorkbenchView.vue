<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { api } from "../main.ts";
import { getRevisionContent, getTask, listGateSubmissions, sendMessage } from "../api/index.ts";
import type { TaskDocRef, TaskRunDetail } from "../api/types.ts";
import {
  STAGE_NODE_STATUS_TEXT,
  TASK_STATUS_TEXT,
  buildFeed,
  createPoller,
  deriveStageChain,
  formatDuration,
  humanizeReason,
  isTerminalStatus,
  type FeedPart,
  type Poller,
  type StageNodeStatus,
} from "../domain/tasks.ts";
import { GATE_REVIEW_NAMES, type GateId } from "../domain/gates.ts";
import { phaseDocName } from "../domain/artifacts.ts";
import { renderMarkdown } from "../domain/markdown.ts";
import { makeTextSegment, toggleSetKey } from "../domain/reply-segments.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import ReplySegments from "../components/ReplySegments.vue";
import StatusBadge from "../components/StatusBadge.vue";

const route = useRoute();
const projectId = String(route.params.id);
const runId = String(route.params.runId);
const runsPageUrl = `/projects/${projectId}/runs?run=${encodeURIComponent(runId)}`;

const detail = ref<TaskRunDetail | null>(null);
const loading = ref(true);
const error = ref<unknown>(null);
const sending = ref(false);
const sendError = ref<unknown>(null);
const messageDraft = ref("");


// ── 轮询（3s；终态自动停止；页面卸载清理）──────────────────────────────
let poller: Poller | null = null;
let refreshing = false;

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    detail.value = await getTask(api, projectId, runId);
    error.value = null;
  } catch (err) {
    error.value = err;
  } finally {
    refreshing = false;
    loading.value = false;
  }
}

onMounted(async () => {
  await refresh();
  poller = createPoller(() => {
    if (detail.value && isTerminalStatus(detail.value.status)) return false;
    void refresh();
    return true;
  }, 3000);
});

onBeforeUnmount(() => {
  poller?.stop();
  poller = null;
});

// ── 等待批准 → 直达对应审批详情（≤2 次点击验收）─────────────────────────
const approvalUrl = ref<string>("/approvals");

watch(
  () => [detail.value?.status, detail.value?.awaiting_gate] as const,
  async ([status, gate]) => {
    if (status !== "awaiting_approval" || !gate) return;
    try {
      const subs = await listGateSubmissions(api, projectId, "in_review");
      const match = subs.find((s) => s.gate === gate);
      approvalUrl.value = match ? `/approvals/${projectId}/${match.id}` : "/approvals";
    } catch {
      approvalUrl.value = "/approvals";
    }
  },
  { immediate: true },
);

const awaitingReviewName = computed(() =>
  detail.value?.awaiting_gate ? (GATE_REVIEW_NAMES[detail.value.awaiting_gate as GateId] ?? null) : null,
);

// ── 阶段链 ───────────────────────────────────────────────────────────
const chain = computed(() => (detail.value ? deriveStageChain(detail.value) : []));

const NODE_ICON: Readonly<Record<StageNodeStatus, string>> = {
  done: "✓",
  running: "●",
  waiting: "⏸",
  pending: "○",
  failed: "✗",
};

// ── 信息流（opencode 模式：用户气泡 + assistant 流，按时间序不重排）──────
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

// ── 产物预览（《GJB 文档名》+ 候选标签；哈希/修订 ID 只在运行记录页）───────
const CODE_EXTENSIONS = [".v", ".sv", ".vhd", ".vhdl", ".xdc", ".sdc", ".tcl", ".f"];

function docTitle(doc: TaskDocRef): string {
  const file = doc.path.split("/").pop() ?? doc.path;
  return `《${phaseDocName(doc.phase)}》 · ${file}`;
}

const selectedDoc = ref<TaskDocRef | null>(null);
const contentHtml = ref<string | null>(null);
const contentCode = ref<string | null>(null);
const contentLoading = ref(false);
const contentError = ref<unknown>(null);

async function viewDoc(doc: TaskDocRef) {
  selectedDoc.value = doc;
  contentHtml.value = null;
  contentCode.value = null;
  contentLoading.value = true;
  contentError.value = null;
  try {
    const data = await getRevisionContent(api, projectId, doc.artifact_id, doc.revision_id);
    if (CODE_EXTENSIONS.some((ext) => doc.path.toLowerCase().endsWith(ext))) {
      contentCode.value = data.content;
    } else {
      contentHtml.value = renderMarkdown(data.content);
    }
  } catch (err) {
    contentError.value = err;
  } finally {
    contentLoading.value = false;
  }
}

// 自动选中最新产物（首次拿到含 docs 的 detail 时）
watch(detail, (value) => {
  if (!value || selectedDoc.value || value.docs.length === 0) return;
  void viewDoc(value.docs[value.docs.length - 1]!);
});

// ── 对话输入（自由 Agent：发消息/纠偏）──────────────────────────────────
async function handleSend(): Promise<void> {
  const text = messageDraft.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  sendError.value = null;
  try {
    await sendMessage(api, projectId, runId, text);
    messageDraft.value = "";
    // prompt 路径已改 audit；立即刷新以拉取 agent 回复。steer 路径靠 3s 轮询。
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
</script>

<template>
  <h1 class="page-title">
    任务工作台
    <StatusBadge v-if="detail" :kind="statusBadgeKind" :text="TASK_STATUS_TEXT[detail.status] ?? detail.status" style="margin-left: 10px; vertical-align: middle" />
  </h1>
  <p class="page-sub">
    <router-link :to="`/projects/${projectId}/tasks`">← 返回任务列表</router-link>
    <span class="muted"> · 每 3s 自动刷新{{ detail && isTerminalStatus(detail.status) ? "（已结束，停止刷新）" : "" }}</span>
  </p>

  <ErrorNotice v-if="error" :error="error" />
  <div v-if="loading" class="muted">加载中…</div>

  <template v-else-if="detail">
    <!-- 等待批准横幅：一键直达对应审批详情 -->
    <div v-if="detail.status === 'awaiting_approval'" class="notice task-banner-waiting" role="alert">
      ⏸ {{ awaitingReviewName ? `「${awaitingReviewName}」正在等待批准` : "正在等待批准" }}，批准后任务自动继续。
      <router-link :to="approvalUrl"><strong>去审批 →</strong></router-link>
    </div>

    <!-- 失败横幅：人话原因 + 运行记录入口 -->
    <div v-else-if="detail.status === 'failed' || detail.status === 'fail_closed'" class="notice error" role="alert">
      {{ humanizeReason(detail.reason) }}
      <router-link :to="runsPageUrl">查看运行记录 →</router-link>
    </div>

    <!-- 完成横幅 -->
    <div v-else-if="detail.status === 'succeeded'" class="notice task-banner-done">
      ✓ 全流程完成，码流已生成。
      <router-link :to="runsPageUrl">去运行记录页取证据 →</router-link>
    </div>

    <div class="workbench">
      <!-- 左栏：信息流（用户指令气泡 + assistant 流，按时间序不重排） -->
      <div class="panel workbench-left">
        <h2>任务进展</h2>

        <!-- user 消息：右侧蓝色气泡 -->
        <div class="msg-user">
          <div>{{ detail.task || "（指令文本未随任务详情返回）" }}</div>
          <div class="msg-meta">{{ new Date(detail.created_at).toLocaleString("zh-CN") }}</div>
        </div>

        <div v-if="feed.length === 0" class="muted">正在启动，暂无进展。</div>

        <!-- assistant 信息流：贴左，无气泡 -->
        <div class="feed">
          <template v-for="part in feed" :key="part.key">
            <!-- 文本叙述 -->
            <p v-if="part.kind === 'text'" class="feed-text">{{ part.text }}</p>

            <!-- free-agent 用户消息：右侧蓝色气泡（首轮指令见顶部气泡） -->
            <div v-else-if="part.kind === 'user'" class="msg-user feed-msg-user">
              <div>{{ part.text }}</div>
              <div class="msg-meta">{{ new Date(part.ts).toLocaleString("zh-CN") }}</div>
            </div>

            <!-- free-agent 回复：分段渲染，长代码块折叠为代码卡 -->
            <div v-else-if="part.kind === 'reply'" class="feed-reply">
              <ReplySegments :segments="part.segments" :part-key="part.key" />
            </div>

            <!-- 工具调用条：进行中流光 / 成功弱化 / 失败红色可展开 -->
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
                <router-link :to="runsPageUrl">查看运行记录 →</router-link>
              </div>
            </div>

            <!-- 门禁条 -->
            <div
              v-else-if="part.kind === 'gate'"
              class="tool-bar gate-bar"
              :class="[part.state, { expandable: part.state === 'failed' }]"
              @click="part.state === 'failed' && togglePart(part.key)"
            >
              <span class="bar-icon">▲</span>
              <span class="bar-title">{{ part.review }}</span>
              <span class="bar-mark">{{ GATE_BAR_TEXT[part.state] }}</span>
              <div v-if="part.state === 'failed' && expandedParts.has(part.key)" class="bar-detail">
                「{{ part.review }}」未通过，任务已安全停止。技术原因见运行记录。
                <router-link :to="runsPageUrl">查看运行记录 →</router-link>
              </div>
            </div>

            <!-- 产物文件卡：点击在右栏预览 -->
            <a
              v-else-if="part.kind === 'file'"
              href="#"
              class="file-card"
              @click.prevent="viewDoc(part.doc)"
            >
              <span class="bar-icon">▤</span>
              <span class="bar-title">《{{ part.title }}》</span>
              <StatusBadge text="候选" kind="accent" />
            </a>

            <!-- 证据摘要：不内联全文 -->
            <div v-else-if="part.kind === 'evidence'" class="tool-bar evidence-bar">
              <span class="bar-icon">▦</span>
              <span class="bar-title">已收集证据 · {{ part.count }} 项</span>
              <router-link :to="runsPageUrl" class="bar-mark">查看详情 →</router-link>
            </div>

            <!-- 终态卡 -->
            <div v-else-if="part.kind === 'terminal'" class="terminal-card" :class="part.state">
              {{ part.text }}
              <router-link v-if="part.state === 'failed'" :to="runsPageUrl">查看运行记录 →</router-link>
              <router-link v-else :to="runsPageUrl">取证据 →</router-link>
            </div>
          </template>
        </div>
        <!-- 对话输入（自由 Agent：回车发送，Shift+Enter 换行；运行中=纠偏 steer） -->
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
      </div>

      <!-- 中栏：阶段链（门节点中文名，编号 hover 可见） -->
      <div class="panel workbench-mid">
        <h2>阶段链</h2>
        <ol class="stage-chain">
          <li
            v-for="{ node, status } in chain"
            :key="node.id"
            class="stage-node"
            :class="[node.kind, status]"
            :title="node.kind === 'gate' ? node.id : undefined"
          >
            <span class="stage-icon">{{ NODE_ICON[status] }}</span>
            <span class="stage-name">{{ node.name }}</span>
            <span class="stage-status muted">{{ STAGE_NODE_STATUS_TEXT[status] }}</span>
          </li>
        </ol>
      </div>

      <!-- 右栏：产物预览 -->
      <div class="panel workbench-right">
        <h2>产物预览</h2>
        <div v-if="detail.docs.length === 0" class="muted">暂无生成的产物。</div>
        <div v-else class="doc-list">
          <a
            v-for="doc in detail.docs"
            :key="doc.revision_id"
            href="#"
            :class="{ active: selectedDoc?.revision_id === doc.revision_id }"
            @click.prevent="viewDoc(doc)"
          >
            <span>{{ docTitle(doc) }}</span>
            <StatusBadge text="候选" kind="accent" />
          </a>
        </div>

        <div v-if="selectedDoc" class="doc-content">
          <ErrorNotice v-if="contentError" :error="contentError" />
          <div v-if="contentLoading" class="muted">内容加载中…</div>
          <pre v-else-if="contentCode !== null" class="code-view">{{ contentCode }}</pre>
          <div v-else-if="contentHtml !== null" class="markdown-body" v-html="contentHtml"></div>
        </div>
      </div>
    </div>
  </template>
</template>
