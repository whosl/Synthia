<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { api } from "../main.ts";
import { getRevisionContent, getTask } from "../api/index.ts";
import type { TaskDocRef, TaskRunDetail } from "../api/types.ts";
import {
  STAGE_NODE_STATUS_TEXT,
  TASK_STATUS_TEXT,
  createPoller,
  deriveStageChain,
  describeAuditEvent,
  isTerminalStatus,
  shortRunId,
  type Poller,
  type StageNodeStatus,
} from "../domain/tasks.ts";
import { renderMarkdown } from "../domain/markdown.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import StatusBadge from "../components/StatusBadge.vue";

const route = useRoute();
const projectId = String(route.params.id);
const runId = String(route.params.runId);

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

// ── 阶段链 ───────────────────────────────────────────────────────────
const chain = computed(() =>
  detail.value ? deriveStageChain(detail.value) : [],
);

const NODE_ICON: Readonly<Record<StageNodeStatus, string>> = {
  done: "✓",
  running: "●",
  waiting: "⏸",
  pending: "○",
  failed: "✗",
};

// ── 进展叙述（audit 末尾在前）─────────────────────────────────────────
const narration = computed(() => {
  if (!detail.value) return [];
  return [...detail.value.audit]
    .sort((a, b) => b.seq - a.seq)
    .map((event) => ({ key: event.seq, ts: event.ts, text: describeAuditEvent(event) }));
});

// ── 产物预览 ─────────────────────────────────────────────────────────
const CODE_EXTENSIONS = [".v", ".sv", ".vhd", ".vhdl", ".xdc", ".sdc", ".tcl", ".f"];

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
    任务工作台 <span class="mono muted" :title="runId">{{ shortRunId(runId) }}</span>
    <StatusBadge v-if="detail" :kind="statusBadgeKind" :text="TASK_STATUS_TEXT[detail.status] ?? detail.status" style="margin-left: 10px; vertical-align: middle" />
  </h1>
  <p class="page-sub">
    <router-link :to="`/projects/${projectId}/tasks`">← 返回任务列表</router-link>
    <span class="muted"> · 每 3s 自动刷新{{ detail && isTerminalStatus(detail.status) ? "（已终态，停止刷新）" : "" }}</span>
  </p>

  <ErrorNotice v-if="error" :error="error" />
  <div v-if="loading" class="muted">加载中…</div>

  <template v-else-if="detail">
    <!-- 等待批准横幅 -->
    <div v-if="detail.status === 'awaiting_approval'" class="notice task-banner-waiting" role="alert">
      ⏸ 等待 <strong class="mono">{{ detail.awaiting_gate }}</strong> 人工批准 —— 批准后 Runtime 将自动续跑。
      <router-link to="/approvals">前往审批中心 →</router-link>
    </div>

    <!-- 终态：失败 -->
    <div v-else-if="detail.status === 'failed' || detail.status === 'fail_closed'" class="notice error" role="alert">
      任务{{ TASK_STATUS_TEXT[detail.status] }}<template v-if="detail.reason">：{{ detail.reason }}</template>
    </div>

    <!-- 终态：完成 + 证据清单 -->
    <div v-else-if="detail.status === 'succeeded'" class="notice task-banner-done">
      ✓ 任务已完成。证据清单：
      <ul style="margin: 8px 0 0; padding-left: 20px">
        <li v-for="ev in detail.evidence" :key="ev.jobId" class="mono" style="font-size: 12px">
          {{ ev.operation }} · job {{ ev.jobId }} · 输入 sha256 {{ ev.inputSha256.slice(0, 16) }}… ·
          {{ ev.entries.length }} 个证据文件
        </li>
        <li v-if="detail.evidence.length === 0" class="muted">无证据记录。</li>
      </ul>
    </div>

    <div class="workbench">
      <!-- 左栏：任务指令 + 进展叙述 -->
      <div class="panel workbench-left">
        <h2>任务指令</h2>
        <p v-if="detail.task" style="white-space: pre-wrap; margin: 0 0 16px">{{ detail.task }}</p>
        <p v-else class="muted" style="margin: 0 0 16px">（指令文本未随 run 详情返回）</p>

        <h2>Agent 进展</h2>
        <div v-if="narration.length === 0" class="muted">暂无进展事件。</div>
        <ul v-else class="narration">
          <li v-for="item in narration" :key="item.key">
            <span class="muted" style="font-size: 11px; white-space: nowrap">{{ new Date(item.ts).toLocaleTimeString("zh-CN") }}</span>
            <span>{{ item.text }}</span>
          </li>
        </ul>
      </div>

      <!-- 中栏：阶段链 -->
      <div class="panel workbench-mid">
        <h2>阶段链</h2>
        <ol class="stage-chain">
          <li
            v-for="{ node, status } in chain"
            :key="node.id"
            class="stage-node"
            :class="[node.kind, status]"
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
        <div v-if="detail.docs.length === 0" class="muted">暂无已登记的产物。</div>
        <div v-else class="doc-list">
          <a
            v-for="doc in detail.docs"
            :key="doc.revision_id"
            href="#"
            :class="{ active: selectedDoc?.revision_id === doc.revision_id }"
            @click.prevent="viewDoc(doc)"
          >
            <span class="badge accent">{{ doc.phase }}</span>
            <span class="mono" style="font-size: 12px">{{ doc.path }}</span>
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
