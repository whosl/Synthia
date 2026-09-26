<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { Activity, Download, ZoomIn, ZoomOut, Maximize2, ArrowLeft, ArrowRight } from "lucide-vue-next";
import { changeIndex, MAX_VCD_BYTES, signalValue, type VcdData, type VcdSignal } from "../../domain/vcd.ts";

const props = defineProps<{ content: string; name: string; truncated?: boolean; source?: string }>();
const data = shallowRef<VcdData | null>(null);
const error = ref("");
const loading = ref(false);
const search = ref("");
const selected = ref<string[]>([]);
const start = ref(0), span = ref(1), cursor = ref(0);
const radix = ref<"hex" | "bin" | "dec">("hex");
let worker: Worker | null = null;
watch(() => [props.content, props.truncated] as const, ([content, truncated]) => {
  worker?.terminate(); data.value = null; error.value = ""; loading.value = false;
  if (truncated) { error.value = "波形内容被截断，无法可靠显示。请重新获取完整文件。"; return; }
  if (content.length > MAX_VCD_BYTES) { error.value = "波形超过 8 MiB 查看上限"; return; }
  loading.value = true;
  worker = new Worker(new URL("./vcd.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<{ data?: VcdData; error?: string }>) => {
    loading.value = false;
    if (event.data.error) error.value = event.data.error;
    else if (event.data.data) {
      data.value = event.data.data; selected.value = data.value.signals.slice(0, 8).map((s) => s.name);
      start.value = 0; span.value = Math.max(1, data.value.endTime); cursor.value = 0;
    }
    worker?.terminate(); worker = null;
  };
  worker.onerror = () => { loading.value = false; error.value = "波形解析失败，请重新打开文件。"; worker?.terminate(); worker = null; };
  worker.postMessage(content);
}, { immediate: true });
onBeforeUnmount(() => worker?.terminate());
const filtered = computed(() => data.value?.signals.filter((s) => s.name.toLowerCase().includes(search.value.toLowerCase())) ?? []);
const visible = computed(() => data.value?.signals.filter((s) => selected.value.includes(s.name)) ?? []);
const end = computed(() => start.value + span.value);
const duration = computed(() => Math.max(1, data.value?.endTime ?? 1));
function setWindow(left: number, width: number): void {
  span.value = Math.max(1, Math.min(duration.value, width));
  start.value = Math.max(0, Math.min(duration.value - span.value, left));
}
function zoom(factor: number): void {
  const anchor = cursor.value >= start.value && cursor.value <= end.value ? cursor.value : start.value + span.value / 2;
  const ratio = (anchor - start.value) / span.value;
  const width = Math.max(1, Math.min(duration.value, span.value * factor));
  setWindow(anchor - ratio * width, width);
}
function fit(): void { setWindow(0, duration.value); }
function formatTime(value: number): string {
  const scaled = value * (data.value?.timescale ?? 1);
  return `${Number(scaled.toPrecision(7)).toLocaleString("en-US", { maximumFractionDigits: 3 })} ${data.value?.unit ?? ""}`;
}
function toggle(name: string): void {
  selected.value = selected.value.includes(name) ? selected.value.filter((n) => n !== name) : selected.value.length < 24 ? [...selected.value, name] : selected.value;
}
const x = (time: number) => Math.max(0, Math.min(1000, (time - start.value) / span.value * 1000));
function trace(signal: VcdSignal): { path: string; labels: { x: number; text: string }[]; dense: boolean } {
  const changes = signal.changes;
  let index = Math.max(-1, changeIndex(changes, start.value));
  let left = start.value, path = "", count = 0;
  const labels: { x: number; text: string }[] = [];
  const bus = signal.width > 1 || signal.type === "real" || signal.type === "realtime";
  while (left < end.value) {
    if (++count > 2000) return { path: "", labels: [], dense: true };
    const right = Math.min(end.value, changes[index + 1]?.time ?? end.value);
    const raw = changes[index]?.value ?? "x", a = x(left), b = x(right);
    if (bus || /[xz]/.test(raw)) {
      const inset = Math.min(3, (b - a) / 2);
      path += `M${a},17L${a + inset},7H${b - inset}L${b},17L${b - inset},27H${a + inset}Z`;
      if (b - a > 35 && labels.length < 150) labels.push({ x: (a + b) / 2, text: index < 0 ? "—" : signalValue(signal, left, radix.value) });
    } else {
      const y = raw === "1" ? 7 : 27;
      path += `M${a},${y}H${b}`;
      if (right < end.value) path += `M${b},7V27`;
    }
    if (right >= end.value) break;
    left = right; index++;
  }
  return { path, labels, dense: false };
}
const rows = computed(() => visible.value.map((signal) => ({ signal, ...trace(signal) })));
const ticks = computed(() => Array.from({ length: 6 }, (_, i) => ({ x: i * 200, time: start.value + span.value * i / 5 })));
let drag: { x: number; start: number; width: number; moved: boolean } | null = null;
function pointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const element = event.currentTarget as SVGSVGElement;
  drag = { x: event.clientX, start: start.value, width: element.getBoundingClientRect().width, moved: false };
  element.setPointerCapture(event.pointerId);
}
function pointerMove(event: PointerEvent): void {
  if (!drag) return;
  const delta = event.clientX - drag.x;
  if (Math.abs(delta) > 3) drag.moved = true;
  if (drag.moved) setWindow(drag.start - delta / drag.width * span.value, span.value);
}
function pointerUp(event: PointerEvent): void {
  if (!drag) return;
  if (!drag.moved) {
    const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    cursor.value = Math.min(data.value?.endTime ?? 0, Math.max(0, Math.round(start.value + (event.clientX - rect.left) / rect.width * span.value)));
  }
  drag = null;
}
function download(): void {
  const url = URL.createObjectURL(new Blob([props.content], { type: "text/plain" }));
  const a = document.createElement("a"); a.href = url; a.download = props.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <section class="waveform-viewer" aria-label="仿真波形查看器">
    <header class="wave-header"><Activity :size="18" /><strong>{{ name }}</strong><span>仿真波形</span><button type="button" :disabled="truncated" @click="download"><Download :size="14" />下载 VCD</button></header>
    <p v-if="source" class="wave-source">{{ source }}</p>
    <p v-if="loading" class="wave-message" role="status">正在解析波形…</p>
    <p v-else-if="error" class="wave-message error" role="alert">{{ error }}</p>
    <template v-else-if="data">
      <p v-for="warning in data.warnings" :key="warning" class="wave-warning">{{ warning }}</p>
      <div class="wave-controls">
        <button type="button" aria-label="放大时间轴" @click="zoom(0.5)"><ZoomIn :size="15" /></button>
        <button type="button" aria-label="缩小时间轴" @click="zoom(2)"><ZoomOut :size="15" /></button>
        <button type="button" aria-label="显示完整波形" @click="fit"><Maximize2 :size="15" /></button>
        <button type="button" aria-label="向前平移" @click="setWindow(start - span / 2, span)"><ArrowLeft :size="15" /></button>
        <button type="button" aria-label="向后平移" @click="setWindow(start + span / 2, span)"><ArrowRight :size="15" /></button>
        <select v-model="radix" aria-label="信号值进制"><option value="hex">十六进制</option><option value="bin">二进制</option><option value="dec">十进制</option></select>
        <span class="cursor-readout">游标 {{ formatTime(cursor) }}</span>
      </div>
      <details class="signal-picker">
        <summary>选择信号 · {{ selected.length }} / {{ data.signals.length }} <small>最多同时显示 24 条</small></summary>
        <input v-model="search" type="search" aria-label="筛选波形信号" placeholder="搜索信号或层级名称…" />
        <div class="signal-options"><label v-for="signal in filtered" :key="signal.name" :title="signal.name"><input type="checkbox" :checked="selected.includes(signal.name)" :disabled="selected.length >= 24 && !selected.includes(signal.name)" @change="toggle(signal.name)" /><span>{{ signal.name }}</span><small>{{ signal.width }} bit</small></label><p v-if="!filtered.length">没有匹配的信号</p></div>
      </details>
      <div class="wave-scroll">
        <div class="wave-table">
          <div class="wave-row ruler"><span>信号 / 游标值</span><svg viewBox="0 0 1000 30" preserveAspectRatio="none" aria-label="时间轴"><text v-for="tick in ticks" :key="tick.x" :x="tick.x" y="20" :text-anchor="tick.x === 1000 ? 'end' : tick.x === 0 ? 'start' : 'middle'">{{ formatTime(tick.time) }}</text></svg></div>
          <div v-for="row in rows" :key="row.signal.name" class="wave-row">
            <div class="signal-name" :title="row.signal.name"><strong>{{ row.signal.name }}</strong><code>{{ signalValue(row.signal, cursor, radix) }}</code></div>
            <svg viewBox="0 0 1000 34" preserveAspectRatio="none" :aria-label="`${row.signal.name} 波形`" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="drag = null" @wheel.prevent="zoom($event.deltaY > 0 ? 1.4 : 1 / 1.4)">
              <line v-for="tick in ticks" :key="tick.x" :x1="tick.x" :x2="tick.x" y1="0" y2="34" class="wave-grid" />
              <path :d="row.path" class="wave-trace" />
              <text v-if="row.dense" x="500" y="21" text-anchor="middle" class="dense-label">变化密集，请放大时间轴查看</text>
              <text v-for="(label, i) in row.labels" :key="i" :x="label.x" y="21" text-anchor="middle">{{ label.text.length > 14 ? label.text.slice(0, 12) + '…' : label.text }}</text>
              <line v-if="cursor >= start && cursor <= end" :x1="x(cursor)" :x2="x(cursor)" y1="0" y2="34" class="wave-cursor" />
            </svg>
          </div>
          <p v-if="!rows.length" class="wave-message">展开「选择信号」，添加要查看的信号。</p>
        </div>
      </div>
      <footer><span>点击读值 · 拖动平移 · 滚轮缩放</span><span>{{ formatTime(start) }} — {{ formatTime(end) }}</span></footer>
    </template>
  </section>
</template>

<style scoped>
.waveform-viewer { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; overflow: auto; background: var(--surface-base); color: var(--text-primary); font-size: 12px; }
.wave-header { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; padding: 14px 16px 8px; }.wave-header > svg { color: var(--accent); }.wave-header strong { overflow-wrap: anywhere; }.wave-header > span { color: var(--text-muted); font-size: 10px; }.wave-header button { margin-left: auto; }
button, select { display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 6px 8px; border: 1px solid var(--border-subtle); border-radius: 5px; background: var(--surface-panel); color: var(--text-secondary); cursor: pointer; font-size: 11px; }button:hover { border-color: var(--accent); }button:disabled { opacity: .5; cursor: default; }
.wave-source { padding: 0 16px; margin: 0 0 8px; overflow-wrap: anywhere; font-size: 10px; color: var(--text-muted); }.wave-message { padding: 24px; color: var(--text-secondary); }.error { color: var(--state-error); }.wave-warning { margin: 6px 16px; color: var(--state-warn); }
.wave-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; padding: 10px 16px; border-bottom: 1px solid var(--border-subtle); }.cursor-readout { margin-left: auto; color: var(--accent); font: 11px var(--font-mono); }
.signal-picker { padding: 10px 16px; border-bottom: 1px solid var(--border-subtle); }.signal-picker summary { cursor: pointer; color: var(--text-secondary); }.signal-picker small { margin-left: 8px; color: var(--text-muted); font-size: 10px; }.signal-picker > input { width: 100%; box-sizing: border-box; background: var(--surface-panel); border: 1px solid var(--border-subtle); border-radius: 4px; padding: 7px; color: var(--text-primary); margin-top: 10px; }.signal-options { max-height: 180px; overflow: auto; }.signal-options label { display: flex; align-items: center; gap: 6px; padding: 4px 0; font: 10px var(--font-mono); }.signal-options label span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.signal-options small { flex-shrink: 0; margin-left: auto; }
.wave-scroll { min-height: 120px; flex: 1; overflow: auto; }.wave-table { min-width: 580px; }.wave-row { display: grid; grid-template-columns: 170px minmax(0, 1fr); border-bottom: 1px solid var(--border-subtle); min-height: 44px; }.wave-row > svg { width: 100%; height: 44px; touch-action: none; cursor: crosshair; }.ruler { position: sticky; top: 0; z-index: 1; background: var(--surface-panel); min-height: 30px; }.ruler > span { padding: 8px 12px; color: var(--text-muted); font-size: 10px; }.ruler svg { height: 30px; }
.signal-name { min-width: 0; display: grid; gap: 2px; padding: 6px 12px; border-right: 1px solid var(--border-subtle); }.signal-name strong { font: 10px var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.signal-name code { overflow: hidden; text-overflow: ellipsis; color: var(--accent); font: 10px var(--font-mono); }svg text { fill: var(--text-secondary); font: 11px var(--font-mono); }.wave-grid { stroke: var(--border-subtle); stroke-dasharray: 2 4; vector-effect: non-scaling-stroke; }.wave-trace { fill: color-mix(in srgb, var(--state-ok) 6%, transparent); stroke: var(--state-ok); stroke-width: 1.4; vector-effect: non-scaling-stroke; }.wave-cursor { stroke: var(--accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }svg .dense-label { fill: var(--text-muted); }footer { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 9px 16px; color: var(--text-muted); font-size: 10px; border-top: 1px solid var(--border-subtle); }
</style>
