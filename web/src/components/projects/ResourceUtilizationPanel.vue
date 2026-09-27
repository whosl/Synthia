<script setup lang="ts">
import { computed } from "vue";
import { ArrowUpRight, Cpu } from "lucide-vue-next";
import type { ToolSummaryResources } from "../../api/types.ts";
import { resourceRows } from "../../domain/resource-utilization.ts";
import { formatTime } from "../../util/format-time.ts";

const props = defineProps<{
  resources: ToolSummaryResources | null;
  error?: string;
  recordJobIds: readonly string[];
}>();
const emit = defineEmits<{ records: [jobId: string] }>();
const rows = computed(() => resourceRows(props.resources));
const phase = computed(() => props.resources ? ({ synthesize: "综合结果", implement: "布局布线结果", report_resources: "资源报告" }[props.resources.sourceOperation]) : "等待报告");
const count = (value: number | null) => value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 3 });
</script>

<template>
  <section class="resources-panel" aria-label="器件资源占用">
    <header class="resources-header">
      <div><span class="resources-eyebrow"><Cpu :size="15" /> DEVICE UTILIZATION</span><h2>器件资源占用</h2></div>
      <div class="resource-source"><span class="resource-phase">{{ phase }}</span><code v-if="resources?.device">{{ resources.device }}</code></div>
    </header>
    <div v-if="resources" class="resource-grid">
      <article v-for="row in rows" :key="row.key" class="resource-card" :data-tone="row.tone" :aria-label="`${row.label} 资源占用`">
        <div class="resource-heading"><strong>{{ row.label }}</strong><span>{{ row.percentText }}</span></div>
        <div class="resource-count"><b>{{ count(row.used) }}</b><span>/ {{ count(row.available) }}</span></div>
        <div class="resource-track" role="meter" :aria-label="`${row.label} 占用百分比`" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="row.percent === null ? undefined : row.fill" :aria-valuetext="row.percent === null ? '容量或用量未获取' : row.percentText"><i :style="{ width: `${row.fill}%` }" /></div>
        <p>{{ row.description }}<span v-if="row.used === null"> · 未报告</span><span v-else-if="row.available === null || row.available === 0"> · 容量未获取</span></p>
      </article>
    </div>
    <p v-else class="resource-empty">{{ error ? "资源报告暂时无法读取，请稍后刷新。" : "综合或布局布线生成资源报告后，这里会显示用量与器件占比。" }}</p>
    <footer v-if="resources" class="resource-footer">
      <span>已用 / 可用 · 占比按报告中的器件容量计算<br />{{ formatTime(resources.sourceAt) }} · {{ resources.reportName }} · 此次运行的设计结果</span>
      <button v-if="recordJobIds.includes(resources.sourceJobId)" type="button" @click="emit('records', resources.sourceJobId)">查看运行记录<ArrowUpRight :size="14" /></button>
    </footer>
  </section>
</template>

<style scoped>
.resources-panel { margin-top: 18px; padding: 22px; border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--surface-panel); min-width: 0; }
.resources-header { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 20px; }
.resources-eyebrow { display: flex; align-items: center; gap: 7px; color: var(--text-muted); font: 10px var(--font-mono); letter-spacing: 1px; }
h2 { margin: 8px 0 0; font-size: 16px; font-weight: 550; }
.resource-source { display: flex; align-items: flex-end; flex-direction: column; gap: 7px; min-width: 0; font-size: 11px; color: var(--text-secondary); }
.resource-source code { overflow-wrap: anywhere; font: 11px var(--font-mono); }
.resource-phase { padding: 4px 7px; border-radius: 4px; background: var(--surface-hover); }
.resource-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px 26px; }
.resource-card { min-width: 0; }
.resource-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; font: 12px var(--font-mono); }
.resource-heading strong { font-weight: 550; }.resource-heading > span { color: var(--state-ok); }
.resource-count { display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px; margin: 10px 0; font-family: var(--font-mono); }.resource-count b { font-size: 25px; font-weight: 500; letter-spacing: -1px; }.resource-count > span { font-size: 11px; color: var(--text-muted); }
.resource-track { height: 5px; background: var(--surface-hover); border-radius: 5px; overflow: hidden; }.resource-track i { display: block; height: 100%; border-radius: inherit; background: var(--state-ok); transition: width 300ms ease; }
.resource-card p { margin: 8px 0 0; font-size: 10px; color: var(--text-muted); line-height: 1.6; }
[data-tone=high] .resource-track i { background: var(--state-warn); }[data-tone=high] .resource-heading > span { color: var(--state-warn); }
[data-tone=over] .resource-track i { background: var(--state-danger); }[data-tone=over] .resource-heading > span { color: var(--state-danger); }
[data-tone=unknown] .resource-heading > span { color: var(--text-muted); }
.resource-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; border-top: 1px solid var(--border-subtle); margin-top: 20px; padding-top: 12px; font-size: 10px; color: var(--text-muted); line-height: 1.8; }
.resource-footer button { display: flex; align-items: center; gap: 5px; color: var(--text-secondary); border: 0; background: transparent; cursor: pointer; font-size: 11px; padding: 6px 0; }
.resource-empty { font-size: 12px; line-height: 1.8; color: var(--text-muted); margin: 0; }
@container engineering (min-width: 1150px) { .resource-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 20px; } }
@container engineering (max-width: 600px) { .resources-panel { padding: 16px; }.resource-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }.resources-header { align-items: flex-start; }.resource-count b { font-size: 22px; } }
@container engineering (max-width: 330px) { .resource-grid { grid-template-columns: minmax(0, 1fr); }.resources-header { flex-direction: column; }.resource-source { align-items: flex-start; } }
@media (prefers-reduced-motion: reduce) { .resource-track i { transition: none; } }
</style>
