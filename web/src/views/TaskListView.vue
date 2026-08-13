<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "../main.ts";
import { listTasks } from "../api/index.ts";
import type { TaskRunSummary } from "../api/types.ts";
import { STAGE_NAME_TEXT, TASK_STATUS_TEXT, normalizeStageId, shortRunId } from "../domain/tasks.ts";
import { GATE_REVIEW_NAMES, type GateId } from "../domain/gates.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import StatusBadge from "../components/StatusBadge.vue";

const route = useRoute();
const projectId = String(route.params.id);

const runs = ref<readonly TaskRunSummary[]>([]);
const loading = ref(true);
const error = ref<unknown>(null);

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

function stageText(stage: string | null): string {
  return stage ? (STAGE_NAME_TEXT[normalizeStageId(stage)] ?? stage) : "—";
}

onMounted(async () => {
  try {
    const data = await listTasks(api, projectId);
    runs.value = [...data.runs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  } catch (err) {
    error.value = err;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <h1 class="page-title">任务列表 <span class="mono muted">{{ projectId }}</span></h1>
  <p class="page-sub">Runtime 执行中的任务 run。点击行进入任务工作台。</p>

  <ErrorNotice v-if="error" :error="error" />
  <div v-if="loading" class="muted">加载中…</div>

  <template v-else>
    <div v-if="runs.length === 0" class="panel muted">
      该项目暂无任务。可在 <router-link :to="`/projects/${projectId}`">项目总览</router-link> 点击「新任务」发起。
    </div>

    <div v-else class="panel">
      <table class="data">
        <thead>
          <tr>
            <th>Run</th>
            <th>状态</th>
            <th>当前阶段</th>
            <th>等待门禁</th>
            <th>创建时间</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="run in runs"
            :key="run.run_id"
            style="cursor: pointer"
            @click="$router.push(`/projects/${projectId}/tasks/${run.run_id}`)"
          >
            <td class="mono" :title="run.run_id">{{ shortRunId(run.run_id) }}</td>
            <td>
              <StatusBadge :kind="statusBadgeKind(run.status)" :text="TASK_STATUS_TEXT[run.status] ?? run.status" />
            </td>
            <td>{{ stageText(run.current_stage) }}</td>
            <td>
              <span v-if="run.awaiting_gate" :title="run.awaiting_gate">
                {{ GATE_REVIEW_NAMES[run.awaiting_gate as GateId] ?? run.awaiting_gate }}
              </span>
              <span v-else class="muted">—</span>
            </td>
            <td class="muted" style="white-space: nowrap">{{ new Date(run.created_at).toLocaleString("zh-CN") }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted" style="font-size: 12px; margin: 10px 0 0">共 {{ runs.length }} 个 run。</p>
    </div>
  </template>
</template>
