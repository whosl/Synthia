<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { api } from "../main.ts";
import { getRevisionContent, getTask, listGateSubmissions } from "../api/index.ts";
import type { TaskDocRef, TaskRunDetail } from "../api/types.ts";
import {
  STAGE_NODE_STATUS_TEXT,
  TASK_STATUS_TEXT,
  createPoller,
  deriveStageChain,
  humanizeReason,
  isTerminalStatus,
  narrateAuditEvent,
  type Poller,
  type StageNodeStatus,
} from "../domain/tasks.ts";
import { GATE_REVIEW_NAMES, type GateId } from "../domain/gates.ts";
import { renderMarkdown } from "../domain/markdown.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import StatusBadge from "../components/StatusBadge.vue";

const route = useRoute();
const projectId = String(route.params.id);
const runId = String(route.params.runId);
const runsPageUrl = `/projects/${projectId}/runs?run=${encodeURIComponent(runId)}`;

const detail = ref<TaskRunDetail | null>(null);
const loading = ref(true);
const error = ref<unknown>(null);

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

// ── 对话区：用户指令 + Agent 叙述（完整中文句子，audit 原文禁止出现）─────
const dialogue = computed(() => {
  if (!detail.value) return [];
  return [...detail.value.audit]
    .sort((a, b) => a.seq - b.seq)
    .map((event) => {
      const sentence = narrateAuditEvent(event);
      return sentence ? { key: event.seq, ts: event.ts, text: sentence } : null;
    })
    .filter((item): item is { key: number; ts: string; text: string } => item !== null);
});

// ── 产物预览（标题 + 候选标签；哈希/修订 ID 只在运行记录页）───────────────
const CODE_EXTENSIONS = [".v", ".sv", ".vhd", ".vhdl", ".xdc", ".sdc", ".tcl", ".f"];

const DOC_PHASE_TEXT: Readonly<Record<string, string>> = {
  intake: "需求规格",
  behavior_wave: "行为与波形设计",
  architecture: "架构设计",
  register_spec: "寄存器规格",
  rtl_build: "RTL 代码",
  rtl: "RTL 代码",
  tb: "仿真测试台",
  xdc: "约束文件",
};

function docTitle(doc: TaskDocRef): string {
  const phase = DOC_PHASE_TEXT[doc.phase] ?? "产物文档";
  const file = doc.path.split("/").pop() ?? doc.path;
  return `${phase} · ${file}`;
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
      <!-- 左栏：对话区（用户指令 + Agent 进展叙述） -->
      <div class="panel workbench-left">
        <h2>对话</h2>
        <div v-if="detail.task" class="bubble bubble-user">{{ detail.task }}</div>
        <div v-else class="bubble bubble-user muted">（指令文本未随任务详情返回）</div>

        <div v-if="dialogue.length === 0" class="muted" style="margin-top: 12px">正在启动，暂无进展。</div>
        <div v-for="item in dialogue" :key="item.key" class="bubble bubble-agent">
          <div>{{ item.text }}</div>
          <div class="bubble-meta">
            <span>{{ new Date(item.ts).toLocaleTimeString("zh-CN") }}</span>
            <router-link :to="runsPageUrl">查看详情</router-link>
          </div>
        </div>
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
