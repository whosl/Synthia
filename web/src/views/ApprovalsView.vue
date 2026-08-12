<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../main.ts";
import { listGateSubmissions, listProjects } from "../api/index.ts";
import type { GateSubmission, Project } from "../api/types.ts";
import { GATE_NAMES, GATE_TO_BASELINE, isMilestoneGate, type GateId } from "../domain/gates.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import StatusBadge from "../components/StatusBadge.vue";

interface PendingItem {
  readonly project: Project;
  readonly submission: GateSubmission;
}

const items = ref<PendingItem[]>([]);
const loading = ref(true);
const error = ref<unknown>(null);

function gateName(gate: string): string {
  return GATE_NAMES[gate as GateId] ?? gate;
}

onMounted(async () => {
  try {
    // 跨项目聚合：遍历项目拉取 state=in_review 的门禁提交
    const projects = await listProjects(api);
    const grouped = await Promise.all(
      projects.map(async (project) => {
        const subs = await listGateSubmissions(api, project.id, "in_review");
        return subs.map((submission) => ({ project, submission }));
      }),
    );
    items.value = grouped
      .flat()
      .sort((a, b) => ((a.submission.submitted_at ?? a.submission.created_at) < (b.submission.submitted_at ?? b.submission.created_at) ? 1 : -1));
  } catch (err) {
    error.value = err;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <h1 class="page-title">审批中心</h1>
  <p class="page-sub">所有项目中处于「审批中」（in_review）的门禁提交。Agent 产物均为候选，批准/驳回由人类角色执行。</p>

  <ErrorNotice v-if="error" :error="error" />
  <div v-if="loading" class="muted">加载中…</div>

  <div v-else class="panel">
    <table class="data" v-if="items.length > 0">
      <thead>
        <tr>
          <th>项目</th>
          <th>门禁</th>
          <th>里程碑</th>
          <th>提交人</th>
          <th>提交时间</th>
          <th>快照</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="item.submission.id">
          <td>
            {{ item.project.name }}
            <div class="mono muted" style="font-size: 11px">{{ item.project.id }}</div>
          </td>
          <td>
            <strong>{{ item.submission.gate }}</strong> {{ gateName(item.submission.gate) }}
          </td>
          <td>
            <StatusBadge
              v-if="isMilestoneGate(item.submission.gate)"
              :text="`将建 ${GATE_TO_BASELINE[item.submission.gate]} 基线`"
              kind="accent"
            />
            <span v-else class="muted">—</span>
          </td>
          <td class="mono">{{ item.submission.submitter_id }}</td>
          <td class="muted" style="white-space: nowrap">
            {{ item.submission.submitted_at ? new Date(item.submission.submitted_at).toLocaleString("zh-CN") : "—" }}
          </td>
          <td class="mono muted">{{ item.submission.snapshot_id }}</td>
          <td>
            <router-link :to="`/approvals/${item.project.id}/${item.submission.id}`">处理</router-link>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-else class="muted">当前没有待审批的门禁提交。</div>
  </div>
</template>
