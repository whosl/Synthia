<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "../main.ts";
import { getTask, listTasks } from "../api/index.ts";
import type { TaskRunDetail, TaskRunSummary } from "../api/types.ts";
import {
  TASK_STATUS_TEXT,
  TOOL_OPERATION_TEXT,
  describeAuditEvent,
  isTerminalStatus,
  shortRunId,
} from "../domain/tasks.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import StatusBadge from "../components/StatusBadge.vue";

/**
 * 运行记录（L3 技术页）：唯一允许出现 jobId / SHA-256 / 错误码 / audit 原文的页面。
 * 主页面（工作台/总览/审批中心）一律不展示这些内容。
 */
const route = useRoute();
const projectId = String(route.params.id);

const runs = ref<readonly TaskRunSummary[]>([]);
const loading = ref(true);
const error = ref<unknown>(null);

const selectedRunId = ref<string | null>(typeof route.query.run === "string" ? route.query.run : null);
const detail = ref<TaskRunDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref<unknown>(null);

async function selectRun(runId: string) {
  if (selectedRunId.value === runId && detail.value) return;
  selectedRunId.value = runId;
  detail.value = null;
  detailLoading.value = true;
  detailError.value = null;
  try {
    detail.value = await getTask(api, projectId, runId);
  } catch (err) {
    detailError.value = err;
  } finally {
    detailLoading.value = false;
  }
}

/** 工具运行行：tool_call 类 audit 事件（操作/结果/jobId/错误码/时间）。 */
const toolRuns = computed(() => {
  if (!detail.value) return [];
  return detail.value.audit
    .filter((e) => e.category === "tool_call" && e.action !== "submit threw")
    .map((e) => ({
      key: e.seq,
      ts: e.ts,
      operation: e.phase,
      operationText: TOOL_OPERATION_TEXT[e.phase] ?? e.phase,
      action: e.action,
      result: e.result ?? "—",
      jobId: e.jobId ?? "—",
      errorCode: e.errorCode ?? "—",
    }));
});

/** audit 原始流（seq 升序完整展示）。 */
const rawAudit = computed(() => {
  if (!detail.value) return [];
  return [...detail.value.audit]
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({
      key: e.seq,
      line: `[${e.seq}] ${e.ts} ${describeAuditEvent(e)}${e.jobId ? ` jobId=${e.jobId}` : ""}${e.errorCode ? ` code=${e.errorCode}` : ""}${e.inputSha256 ? ` sha=${e.inputSha256}` : ""}`,
    }));
});

/** 任务总耗时（首末 audit 时间差）。 */
const totalDuration = computed(() => {
  if (!detail.value || detail.value.audit.length < 2) return "—";
  const sorted = [...detail.value.audit].sort((a, b) => a.seq - b.seq);
  const ms = Date.parse(sorted[sorted.length - 1]!.ts) - Date.parse(sorted[0]!.ts);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
});

function statusBadgeKind(status: string): "accent" | "warn" | "ok" | "danger" | "plain" {
  switch (status) {
    case "running": return "accent";
    case "awaiting_approval": return "warn";
    case "succeeded": return "ok";
    case "failed":
    case "fail_closed": return "danger";
    default: return "plain";
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

onMounted(async () => {
  try {
    const data = await listTasks(api, projectId);
    runs.value = [...data.runs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const initial = selectedRunId.value ?? runs.value[0]?.run_id ?? null;
    if (initial) void selectRun(initial);
  } catch (err) {
    error.value = err;
  } finally {
    loading.value = false;
  }
});

const terminalText = computed(() => (detail.value && isTerminalStatus(detail.value.status) ? "（终态）" : ""));
</script>

<template>
  <h1 class="page-title">运行记录 <span class="mono muted">{{ projectId }}</span></h1>
  <p class="page-sub">技术详情页：工具运行、证据清单与 audit 原始流。此页内容是平台内部机制，日常无需关注。</p>

  <ErrorNotice v-if="error" :error="error" />
  <div v-if="loading" class="muted">加载中…</div>

  <template v-else>
    <div class="panel">
      <h2>任务运行</h2>
      <div v-if="runs.length === 0" class="muted">该项目暂无任务运行。</div>
      <table v-else class="data">
        <thead>
          <tr>
            <th>Run</th>
            <th>状态</th>
            <th>当前阶段</th>
            <th>创建时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in runs" :key="run.run_id">
            <td class="mono" :title="run.run_id">{{ shortRunId(run.run_id) }}</td>
            <td>
              <StatusBadge :kind="statusBadgeKind(run.status)" :text="`${TASK_STATUS_TEXT[run.status] ?? run.status}（${run.status}）`" />
            </td>
            <td class="mono">{{ run.current_stage ?? "—" }}</td>
            <td class="muted" style="white-space: nowrap">{{ new Date(run.created_at).toLocaleString("zh-CN") }}</td>
            <td>
              <a href="#" @click.prevent="selectRun(run.run_id)">
                {{ selectedRunId === run.run_id ? "查看中" : "查看记录" }}
              </a>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <template v-if="selectedRunId">
      <ErrorNotice v-if="detailError" :error="detailError" />
      <div v-if="detailLoading" class="muted">记录加载中…</div>

      <template v-else-if="detail">
        <div class="panel">
          <h2>工具运行 <span class="muted" style="font-weight: 400">{{ terminalText }} · 总耗时 {{ totalDuration }}</span></h2>
          <div v-if="toolRuns.length === 0" class="muted">该任务暂无工具运行记录。</div>
          <table v-else class="data">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作</th>
                <th>结果</th>
                <th>jobId</th>
                <th>错误码</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in toolRuns" :key="row.key">
                <td class="muted" style="white-space: nowrap">{{ new Date(row.ts).toLocaleString("zh-CN") }}</td>
                <td>{{ row.operationText }} <span class="mono muted" style="font-size: 11px">{{ row.operation }} · {{ row.action }}</span></td>
                <td class="mono">{{ row.result }}</td>
                <td class="mono">{{ row.jobId }}</td>
                <td class="mono">{{ row.errorCode }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="panel">
          <h2>证据清单</h2>
          <div v-if="detail.evidence.length === 0" class="muted">暂无证据记录。</div>
          <div v-for="ev in detail.evidence" :key="ev.jobId" style="margin-bottom: 14px">
            <div class="mono" style="font-size: 12px; margin-bottom: 4px">
              {{ ev.operation }} · jobId {{ ev.jobId }} · 状态 {{ ev.status }} · 输入 SHA-256 {{ ev.inputSha256 }}
            </div>
            <table class="data" v-if="ev.entries.length > 0">
              <thead>
                <tr>
                  <th>文件名</th>
                  <th>大小</th>
                  <th>SHA-256</th>
                  <th>类型</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in ev.entries" :key="entry.name">
                  <td class="mono">{{ entry.name }}</td>
                  <td>{{ formatBytes(entry.sizeBytes) }}</td>
                  <td class="mono" style="font-size: 11px">{{ entry.sha256 }}</td>
                  <td class="muted">{{ entry.mediaType }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="muted" style="font-size: 12px">（无证据文件）</div>
          </div>
          <div v-if="detail.reason" class="mono" style="font-size: 12px; margin-top: 8px">
            结束原因：{{ detail.reason }}
          </div>
        </div>

        <div class="panel">
          <h2>audit 原始流 <span class="muted" style="font-weight: 400">（{{ rawAudit.length }} 条）</span></h2>
          <pre v-if="rawAudit.length > 0" class="code-view" style="max-height: 480px; overflow-y: auto">{{ rawAudit.map((l) => l.line).join("\n") }}</pre>
          <div v-else class="muted">暂无 audit 记录。</div>
        </div>
      </template>
    </template>
  </template>
</template>
