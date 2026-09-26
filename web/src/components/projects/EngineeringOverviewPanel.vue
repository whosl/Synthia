<script setup lang="ts">
import { computed, ref } from "vue";
import { Activity, ArrowUpRight, Check, CircuitBoard, Cpu, FileCode2, Layers, Maximize2, ShieldCheck, Sparkles, X } from "lucide-vue-next";
import Button from "../ui/AppButton.vue";
import type { EngineeringOverviewProps } from "../../domain/engineering-overview.ts";
import { formatNs, TIMING_STATUS_LABELS } from "../../domain/impl-summary.ts";
import { overviewStages, OVERVIEW_STATE_LABELS } from "../../domain/engineering-overview.ts";
import { formatTime } from "../../util/format-time.ts";

const props = defineProps<EngineeringOverviewProps & { embedded?: boolean }>();
const emit = defineEmits<{
  close: [];
  expand: [];
  records: [jobId: string | null];
  collaborate: [];
}>();
const selectedKey = ref("simulate");
const stages = computed(() => overviewStages(props.summary));
const selected = computed(() => stages.value.find((stage) => stage.key === selectedKey.value)!);
const running = computed(() => stages.value.some((stage) => stage.state === "running"));
const passed = computed(() => stages.value.filter((stage) => stage.state === "passed").length);
const attention = computed(() => stages.value.filter((stage) => stage.state === "failed").length);
const executions = computed(() => props.summary?.stages.reduce((total, stage) => total + stage.succeeded + stage.failed, 0) ?? null);
const title = computed(() => {
  if (!props.summary) return "等待工程数据";
  if (running.value) return "设计正在验证中";
  if (attention.value) return "发现问题，继续迭代";
  if (passed.value === 4) return "四项验证均已通过";
  if (passed.value) return "设计一步步成为现实";
  return "从一个目标，开始设计";
});
const canViewRecord = computed(() => selected.value.jobId !== null && props.recordJobIds.includes(selected.value.jobId));
const icons = [FileCode2, Activity, Layers, CircuitBoard];
const positions = [{ x: 17, y: 23 }, { x: 83, y: 23 }, { x: 17, y: 77 }, { x: 83, y: 77 }];
const traces = ["M 330 165 H 265 V 76 H 115", "M 330 165 H 395 V 76 H 545", "M 330 165 H 265 V 254 H 115", "M 330 165 H 395 V 254 H 545"];

function showRecord(): void {
  if (!canViewRecord.value || !selected.value.jobId) return;
  emit("records", selected.value.jobId);
}
</script>

<template>
  <div :class="['overview-container', { 'overview-embedded': embedded }]">
      <div class="overview-shell">
        <header class="overview-topbar">
          <span class="overview-brand"><Cpu :size="22" /> SYNTHIA <span>工程全景</span></span>
          <div class="overview-actions">
            <Button size="sm" variant="ghost" @click="emit('records', null)">运行记录</Button>
            <span v-if="mock" class="source-tag">演示数据</span>
            <span v-else class="source-tag">项目实际记录</span>
            <button v-if="embedded" class="close-overview" type="button" aria-label="放大工程全景" @click="emit('expand')"><Maximize2 :size="18" /></button>
            <button v-else class="close-overview" type="button" aria-label="关闭工程全景" @click="emit('close')"><X :size="20" /></button>
          </div>
        </header>

        <div class="overview-body">
          <div class="overview-heading">
            <div>
              <p class="eyebrow">ENGINEERING OVERVIEW</p>
              <h1 class="overview-title">{{ embedded ? "验证概览" : projectName }}</h1>
              <p class="overview-description">设计进展、验证结果与交付证据。</p>
            </div>
            <Button variant="primary" @click="emit('collaborate')"><Sparkles :size="16" />与 Agent 协作<ArrowUpRight :size="15" /></Button>
          </div>

          <div class="overview-main">
            <section class="circuit-panel" aria-label="工程验证全景">
              <div class="panel-heading"><span><span class="status-dot" :class="{ active: running }" />{{ title }}</span><span class="panel-caption">选择节点，查看结果</span></div>
              <div class="circuit-map">
                <svg class="circuit-traces" viewBox="0 0 660 330" preserveAspectRatio="none" aria-hidden="true">
                  <g v-for="(stage, index) in stages" :key="stage.key" :class="['trace', stage.state]">
                    <path :d="traces[index]" />
                    <path v-if="stage.state === 'running'" :d="traces[index]" class="trace-flow" />
                  </g>
                </svg>
                <div class="chip" :class="{ 'chip-active': running }">
                  <div class="chip-pins pins-top" /><div class="chip-pins pins-bottom" /><div class="chip-pins pins-left" /><div class="chip-pins pins-right" />
                  <Cpu :size="30" :stroke-width="1.2" />
                  <strong>FPGA</strong><span>{{ targetPart ? "目标器件" : "待选择器件" }}</span>
                  <div class="chip-grid" aria-hidden="true"><i v-for="n in 24" :key="n" :class="{ lit: n <= passed * 6 }" /></div>
                </div>
                <button v-for="(stage, index) in stages" :key="stage.key" type="button"
                  :class="['circuit-node', stage.state, { selected: selectedKey === stage.key }]"
                  :style="{ left: `${positions[index]!.x}%`, top: `${positions[index]!.y}%` }"
                  :aria-pressed="selectedKey === stage.key" :aria-label="`${stage.label}：${OVERVIEW_STATE_LABELS[stage.state]}`"
                  @click="selectedKey = stage.key">
                  <span class="node-icon"><component :is="icons[index]" :size="21" :stroke-width="1.5" /></span>
                  <span class="node-copy"><small>{{ stage.short }}</small><strong>{{ stage.label }}</strong><span class="node-status"><Check v-if="stage.state === 'passed'" :size="12" />{{ OVERVIEW_STATE_LABELS[stage.state] }}</span></span>
                </button>
              </div>
              <div class="circuit-footer"><span><Cpu :size="14" />{{ targetPart ?? "尚未配置目标器件" }}</span><span class="bitstream-state" :class="{ generated: summary?.bitstream.generated }"><span class="status-dot" />{{ !summary ? "码流状态未知" : summary.bitstream.generated ? "已有码流产出" : "尚未产出码流" }}</span></div>
            </section>

            <aside class="overview-results" aria-label="工程成果">
              <div class="timing-card" :class="summary?.timing?.status ?? 'unknown'">
                <div class="metric-label"><Activity :size="16" />时序余量 <span>WNS</span></div>
                <div class="timing-value">{{ formatNs(summary?.timing?.wns ?? null) }}<small>ns</small></div>
                <strong>{{ summary?.timing ? TIMING_STATUS_LABELS[summary.timing.status] : "等待时序报告" }}</strong>
                <p>{{ summary?.timing?.status === 'met' ? "该报告中的时序检查已达标。" : summary?.timing?.status === 'failed' ? "该报告存在时序违例，需继续优化。" : "以工具报告确认设计的时序表现。" }}</p>
              </div>
              <div class="result-metrics">
                <div><FileCode2 :size="17" /><strong>{{ fileCount ?? "—" }}</strong><span>工作区文件</span></div>
                <div><ShieldCheck :size="17" /><strong>{{ executions ?? "—" }}</strong><span>成功 / 失败运行总数</span></div>
              </div>
              <div class="validation-count"><span>四项检查最近结果</span><strong>{{ summary ? passed : "—" }}<small> / 4 已通过</small></strong><div class="validation-segments" aria-hidden="true"><i v-for="stage in stages" :key="stage.key" :class="stage.state" /></div></div>
            </aside>
          </div>

          <div class="overview-bottom">
            <section class="selected-result" aria-label="所选验证结果">
              <div class="section-label"><Maximize2 :size="14" />验证详情<span :class="['detail-state', selected.state]">{{ OVERVIEW_STATE_LABELS[selected.state] }}</span></div>
              <h3>{{ selected.label }}</h3><p>{{ selected.description }}</p>
              <div v-if="summary" class="result-history"><span>累计通过 <b>{{ selected.succeeded }}</b></span><span>累计失败 <b>{{ selected.failed }}</b></span><span v-if="selected.at">最近运行 {{ formatTime(selected.at) }}</span></div>
              <p v-else class="empty-result">暂未取得验证记录，恢复连接后自动更新。</p>
              <Button v-if="canViewRecord" size="sm" variant="ghost" @click="showRecord">查看原始记录<ArrowUpRight :size="14" /></Button>
            </section>
            <section class="delivery-path" aria-label="正式工程进度">
              <div class="section-label"><ShieldCheck :size="14" />{{ stageChain?.length ? "正式工程进度" : "自由探索" }}</div>
              <template v-if="stageChain?.length">
                <div class="gate-track"><div v-for="entry in stageChain" :key="entry.node.id" :class="['gate-stop', entry.status]"><span><Check v-if="entry.status === 'done'" :size="14" /><template v-else>{{ entry.node.id }}</template></span><strong>{{ entry.node.name }}</strong></div></div>
                <p>{{ processState?.completed ? "正式流程已完成，交付结果已密封。" : "阶段确认与工具验证分别记录，正式交付以审批结果为准。" }}</p>
              </template>
              <template v-else><h3>探索 · 验证 · 迭代</h3><p>按目标自主开展设计与验证。需要正式交付时，可复制为工程项目，进入阶段确认流程。</p><div class="explore-tags"><span>自然语言协作</span><span>工具验证</span><span>版本留痕</span></div></template>
            </section>
          </div>
          <footer class="overview-footnote"><span>各项显示最近一次记录，可能对应不同设计版本；码流产出不代表正式交付。</span><span>{{ summary ? `数据更新 ${formatTime(summary.generatedAt)}` : "等待数据" }}</span></footer>
        </div>
      </div>
  </div>
</template>

<style scoped>
.overview-container { container-type: inline-size; container-name: engineering; min-width: 0; }
.overview-embedded { height: 100%; overflow: auto; }
.overview-embedded .overview-topbar { padding: 12px 20px; }
.overview-embedded .overview-body { padding: 20px; }
.overview-embedded .overview-heading { margin-bottom: 24px; }
.overview-embedded .circuit-map { height: 280px; }
.overview-shell { --signal: var(--state-info); color: var(--text-primary); background: var(--surface-panel); }
.overview-topbar { display: flex; align-items: center; justify-content: space-between; padding: 18px 28px; border-bottom: 1px solid var(--border-subtle); }
.overview-brand { display: flex; align-items: center; gap: 10px; font-weight: 650; letter-spacing: 1px; font-size: 12px; }
.overview-brand svg { color: var(--accent); }
.overview-brand > span { border-left: 1px solid var(--border-strong); padding-left: 14px; margin-left: 4px; font-size: 12px; letter-spacing: 1px; color: var(--text-secondary); font-weight: 400; }
.overview-actions { display: flex; align-items: center; gap: 18px; }
.source-tag { color: var(--text-secondary); font-size: 11px; }
.close-overview { display: grid; place-items: center; width: 30px; height: 30px; background: transparent; color: var(--text-secondary); border: 0; border-radius: 6px; cursor: pointer; }
.close-overview:hover { background: var(--surface-hover); }
.overview-body { padding: 28px; }
.overview-heading { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-bottom: 24px; }
.eyebrow { color: var(--accent); letter-spacing: 2px; font-size: 11px; margin: 0 0 10px; }
.overview-title { font-size: clamp(24px, 3cqw, 32px); line-height: 1.25; letter-spacing: -.7px; margin: 0; overflow-wrap: anywhere; }
.overview-description { color: var(--text-secondary); margin: 10px 0 0; font-size: 13px; }
.overview-main { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 18px; }
.circuit-panel { min-width: 0; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--surface-base); }
.panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 20px 22px; font-size: 12px; }
.panel-heading > span:first-child { display: flex; align-items: center; gap: 9px; }
.panel-caption { color: var(--text-muted); font-size: 10px; }
.status-dot { width: 6px; height: 6px; display: inline-block; border-radius: 50%; background: var(--text-muted); flex-shrink: 0; }
.status-dot.active { background: var(--signal); box-shadow: 0 0 0 4px color-mix(in srgb, var(--signal) 12%, transparent); }
.circuit-map { position: relative; height: 330px; background-image: radial-gradient(var(--border-strong) .7px, transparent .7px); background-size: 18px 18px; }
.circuit-traces { position: absolute; width: 100%; height: 100%; inset: 0; }
.trace { color: var(--border-strong); }
.trace.passed { color: color-mix(in srgb, var(--state-ok) 65%, transparent); }
.trace.failed { color: color-mix(in srgb, var(--state-danger) 65%, transparent); }
.trace.running { color: var(--signal); }
.trace path { fill: none; stroke: currentColor; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.trace .trace-flow { stroke: var(--text-primary); stroke-dasharray: 5 22; animation: signal-flow 2.5s linear infinite; }
.chip { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 132px; height: 154px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; border: 1px solid color-mix(in srgb, var(--signal) 55%, var(--border-subtle)); border-radius: 12px; background: linear-gradient(145deg, var(--surface-raised), var(--surface-base)); box-shadow: 0 0 0 8px var(--surface-panel), 0 0 0 9px var(--border-subtle), 0 18px 45px var(--shadow-color); color: var(--signal); }
.chip > strong { font-size: 25px; letter-spacing: 5px; margin-left: 5px; font-weight: 500; color: var(--text-primary); }
.chip > span { font-size: 10px; color: var(--text-secondary); }
.chip-grid { display: grid; grid-template-columns: repeat(8, 4px); gap: 3px; margin-top: 8px; }
.chip-grid i { width: 4px; height: 4px; background: var(--border-strong); border-radius: 1px; }
.chip-grid i.lit { background: var(--state-ok); }
.chip-active { box-shadow: 0 0 0 8px var(--surface-panel), 0 0 0 9px var(--signal), 0 0 45px color-mix(in srgb, var(--signal) 14%, transparent); }
.chip-pins { position: absolute; background: repeating-linear-gradient(90deg, var(--border-strong) 0 3px, transparent 3px 10px); height: 8px; width: 90px; left: 20px; }
.pins-top { top: -17px; }.pins-bottom { bottom: -17px; }.pins-left { left: -63px; top: 72px; transform: rotate(90deg); }.pins-right { left: 103px; top: 72px; transform: rotate(90deg); }
.circuit-node { position: absolute; transform: translate(-50%, -50%); display: flex; align-items: center; text-align: left; gap: 12px; width: 154px; padding: 15px 13px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface-panel); color: var(--text-secondary); cursor: pointer; transition: border-color 150ms, box-shadow 150ms; }
.circuit-node:hover, .circuit-node.selected { border-color: var(--signal); box-shadow: 0 0 0 3px color-mix(in srgb, var(--signal) 10%, transparent); }
.node-icon { color: var(--text-muted); }.passed .node-icon, .passed .node-status, .detail-state.passed { color: var(--state-ok); }.failed .node-icon, .failed .node-status, .detail-state.failed { color: var(--state-danger); }.running .node-icon, .running .node-status, .detail-state.running { color: var(--signal); }
.node-copy { display: flex; flex-direction: column; gap: 5px; }.node-copy small { font: 10px var(--font-mono); letter-spacing: .5px; color: var(--text-muted); }.node-copy strong { font-size: 13px; color: var(--text-primary); font-weight: 550; }.node-status { display: flex; align-items: center; gap: 4px; font-size: 10px; }
.circuit-footer { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 15px 22px; border-top: 1px solid var(--border-subtle); color: var(--text-secondary); font-size: 11px; }.circuit-footer > span { display: flex; align-items: center; gap: 7px; overflow-wrap: anywhere; }.generated { color: var(--state-ok); }.generated .status-dot { background: var(--state-ok); }
.overview-results { display: flex; flex-direction: column; gap: 14px; }.timing-card { border: 1px solid var(--border-subtle); border-radius: 12px; padding: 22px; background: var(--surface-panel); }.timing-card.met { background: color-mix(in srgb, var(--state-ok) 5%, var(--surface-panel)); }.metric-label { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-secondary); }.metric-label > span { margin-left: auto; font: 10px var(--font-mono); color: var(--text-muted); }.timing-value { font: 48px var(--font-mono); letter-spacing: -3px; margin: 19px 0 12px; white-space: nowrap; }.timing-value small { font-size: 15px; letter-spacing: 0; margin-left: 7px; color: var(--text-muted); }.timing-card.met .timing-value { color: var(--state-ok); }.timing-card.failed .timing-value { color: var(--state-danger); }.timing-card > strong { font-size: 12px; font-weight: 500; }.timing-card p { font-size: 11px; color: var(--text-muted); line-height: 1.7; margin: 7px 0 0; }
.result-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }.result-metrics > div { display: flex; flex-direction: column; align-items: flex-start; gap: 9px; padding: 16px; background: var(--surface-panel); border: 1px solid var(--border-subtle); border-radius: 12px; }.result-metrics svg { color: var(--text-muted); }.result-metrics strong { font: 28px var(--font-mono); }.result-metrics span { font-size: 10px; color: var(--text-secondary); }
.validation-count { padding: 3px 4px; }.validation-count > span { color: var(--text-secondary); font-size: 11px; }.validation-count strong { display: block; font: 23px var(--font-mono); margin: 8px 0; }.validation-count small { font: 11px var(--font-sans); color: var(--text-muted); }.validation-segments { display: flex; gap: 5px; }.validation-segments i { height: 4px; flex: 1; background: var(--border-strong); border-radius: 3px; }.validation-segments .passed { background: var(--state-ok); }.validation-segments .failed { background: var(--state-danger); }.validation-segments .running { background: var(--signal); }
.overview-bottom { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 18px; }.selected-result, .delivery-path { border: 1px solid var(--border-subtle); border-radius: 12px; padding: 20px 22px; background: var(--surface-panel); }.section-label { display: flex; align-items: center; gap: 7px; color: var(--text-muted); font-size: 11px; }.detail-state { margin-left: auto; }.overview-bottom h3 { margin: 14px 0 7px; font-size: 16px; font-weight: 500; }.overview-bottom p { font-size: 12px; color: var(--text-secondary); line-height: 1.8; margin: 6px 0; }.result-history { display: flex; flex-wrap: wrap; gap: 14px; margin: 14px 0 5px; font-size: 10px; color: var(--text-muted); }.result-history b { color: var(--text-primary); font-family: var(--font-mono); margin-left: 5px; }.explore-tags { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 15px; }.explore-tags span { border: 1px solid var(--border-subtle); border-radius: 4px; padding: 4px 7px; font-size: 10px; color: var(--text-secondary); }
.gate-track { display: flex; margin: 20px 0 15px; }.gate-stop { flex: 1; text-align: center; position: relative; min-width: 0; }.gate-stop:not(:last-child)::after { content: ""; position: absolute; top: 13px; left: calc(50% + 17px); width: calc(100% - 34px); height: 1px; background: var(--border-strong); }.gate-stop > span { display: inline-flex; align-items: center; justify-content: center; width: 27px; height: 27px; border: 1px solid var(--border-strong); border-radius: 50%; color: var(--text-muted); font: 10px var(--font-mono); }.gate-stop strong { display: block; margin-top: 8px; font-size: 11px; font-weight: 400; color: var(--text-secondary); padding: 0 3px; }.gate-stop.done > span { color: var(--state-ok); border-color: var(--state-ok); }.gate-stop.current > span { color: var(--accent); border-color: var(--accent); }.gate-stop.gated > span { color: var(--state-warn); border-color: var(--state-warn); }.gate-stop.failed > span { color: var(--state-danger); border-color: var(--state-danger); }
.overview-footnote { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-top: 18px; color: var(--text-muted); font-size: 10px; line-height: 1.6; }
@keyframes signal-flow { to { stroke-dashoffset: -54; } }
@media (prefers-reduced-motion: reduce) { .trace-flow { animation: none !important; } }
@container engineering (max-width: 1000px) { .overview-main { grid-template-columns: minmax(0, 1fr); }.overview-results { display: grid; grid-template-columns: 1.2fr 1fr 1fr; align-items: stretch; }.timing-value { font-size: 36px; margin: 12px 0; }.result-metrics { gap: 8px; }.result-metrics > div { padding: 14px; justify-content: center; }.validation-count { align-self: center; padding: 14px; }.timing-card { padding: 18px; } }
@container engineering (max-width: 600px) { .overview-topbar { padding: 14px 16px; }.overview-body { padding: 18px 14px; }.overview-brand { font-size: 11px; gap: 6px; letter-spacing: 2px; }.overview-brand > span { font-size: 10px; padding-left: 8px; }.overview-actions { gap: 8px; }.source-tag { font-size: 9px; }.overview-heading { align-items: flex-start; flex-direction: column; gap: 14px; }.panel-heading { padding: 16px 12px; }.panel-caption { display: none; }.circuit-map { height: 310px; }.chip { width: 82px; height: 116px; }.chip > strong { font-size: 18px; letter-spacing: 2px; }.chip > svg { width: 22px; }.chip-pins { display: none; }.chip-grid { grid-template-columns: repeat(8, 3px); gap: 2px; }.chip-grid i { width: 3px; height: 3px; }.circuit-node { width: 86px; padding: 10px 6px; gap: 5px; flex-direction: column; text-align: center; }.node-copy { align-items: center; }.node-copy small { display: none; }.node-copy strong { font-size: 11px; }.node-icon svg { width: 17px; height: 17px; }.circuit-footer { padding: 13px 12px; font-size: 9px; }.overview-results { grid-template-columns: 1fr 1fr; gap: 10px; }.timing-card { padding: 14px; }.timing-value { font-size: 32px; }.result-metrics { gap: 8px; }.result-metrics > div { padding: 10px; }.result-metrics strong { font-size: 23px; }.result-metrics span { font-size: 9px; }.validation-count { grid-column: 1 / -1; padding: 8px 4px; }.validation-count strong { display: inline; float: right; margin: 0 0 8px; font-size: 18px; }.validation-segments { clear: both; margin-top: 12px; }.overview-bottom { grid-template-columns: 1fr; }.selected-result, .delivery-path { padding: 18px; }.overview-footnote { font-size: 9px; } }
@container engineering (max-width: 420px) {
  .overview-body { padding: 16px 10px; }
  .overview-brand > span { display: none; }
  .overview-results { grid-template-columns: minmax(0, 1fr); }
  .result-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .overview-bottom { min-width: 0; }
}
@container engineering (max-width: 330px) {
  .circuit-map, .overview-embedded .circuit-map { height: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 12px; }
  .circuit-traces, .chip { display: none; }
  .circuit-node { position: static; transform: none; width: auto; }
}
</style>
