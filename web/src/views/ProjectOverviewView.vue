<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "../main.ts";
import { listBaselines, listEvents, listGateSubmissions } from "../api/index.ts";
import type { Baseline, OutboxEvent } from "../api/types.ts";
import {
  BASELINE_KINDS,
  BASELINE_NAMES,
  BASELINE_STATE_TEXT,
  deriveGateLanes,
  type GateId,
  type GateLaneState,
} from "../domain/gates.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import GateSwimlane from "../components/GateSwimlane.vue";

const route = useRoute();
const projectId = String(route.params.id);

const lanes = ref<Record<GateId, GateLaneState> | null>(null);
const baselines = ref<Baseline[]>([]);
const events = ref<OutboxEvent[]>([]);
const loading = ref(true);
const error = ref<unknown>(null);

/** 每种基线取最新一条（同一 kind 可能被替换过多次）。 */
const latestBaselines = computed(() => {
  const byKind = new Map<string, Baseline>();
  for (const bl of baselines.value) {
    const prev = byKind.get(bl.kind);
    if (!prev || bl.created_at > prev.created_at) byKind.set(bl.kind, bl);
  }
  return byKind;
});

/** 事件流按发生时间倒序，取最近 30 条。 */
const recentEvents = computed(() =>
  [...events.value].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1)).slice(0, 30),
);

onMounted(async () => {
  try {
    const [subs, bls, evts] = await Promise.all([
      listGateSubmissions(api, projectId),
      listBaselines(api, projectId),
      listEvents(api, projectId),
    ]);
    lanes.value = deriveGateLanes(subs);
    baselines.value = bls;
    events.value = evts;
  } catch (err) {
    error.value = err;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <h1 class="page-title">项目总览 <span class="mono muted">{{ projectId }}</span></h1>
  <p class="page-sub">G0~G9 门禁泳道 · 基线徽章 · 最近事件流</p>

  <ErrorNotice v-if="error" :error="error" />
  <div v-if="loading" class="muted">加载中…</div>

  <template v-else-if="lanes">
    <div class="panel">
      <h2>门禁泳道</h2>
      <GateSwimlane :lanes="lanes" />
      <p class="muted" style="margin: 10px 0 0; font-size: 12px">
        状态由门禁提交（gate_submissions）推导：无提交=未开始，in_review=审批中，approved=已批准，rejected=被驳回。
      </p>
    </div>

    <div class="panel">
      <h2>基线（B0~B4）</h2>
      <div class="baseline-strip">
        <div
          v-for="kind in BASELINE_KINDS"
          :key="kind"
          class="baseline-chip"
          :class="latestBaselines.get(kind)?.state === 'active' ? 'active' : 'inactive'"
        >
          <div>
            <span class="kind">{{ kind }}</span>
            <span class="name"> · {{ BASELINE_NAMES[kind] }}</span>
          </div>
          <div class="muted" style="font-size: 12px; margin-top: 2px">
            <template v-if="latestBaselines.get(kind)">
              {{ BASELINE_STATE_TEXT[latestBaselines.get(kind)!.state] ?? latestBaselines.get(kind)!.state }}
              · <span class="mono">{{ latestBaselines.get(kind)!.id }}</span>
            </template>
            <template v-else>未建立</template>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <h2>最近事件</h2>
      <table class="data" v-if="recentEvents.length > 0">
        <thead>
          <tr>
            <th>时间</th>
            <th>事件类型</th>
            <th>聚合</th>
            <th>序号</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="evt in recentEvents" :key="evt.event_id">
            <td class="muted" style="white-space: nowrap">{{ new Date(evt.occurred_at).toLocaleString("zh-CN") }}</td>
            <td class="mono">{{ evt.event_type }}</td>
            <td class="mono muted">{{ evt.aggregate_type }}/{{ evt.aggregate_id }}</td>
            <td>{{ evt.sequence }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="muted">暂无事件。</div>
    </div>
  </template>
</template>
