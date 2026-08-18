<script setup lang="ts">
/**
 * 运行记录面板（右侧抽屉；veil/挂载由 ProjectView 控制，见 project-view-contract.ts
 * 顶部「运行记录面板」注释）。ChatFeed 把技术细节压缩掉的 jobId/errorCode/证据
 * 全量清单在这里原样展开——展开态、证据内容可见态都是本地 UI 态，面板每次
 * 由 ProjectView 的 veil v-if 重新挂载，不需要跨刷新保留。
 */
import { nextTick, ref, watch } from "vue";
import type { JobEvidenceContent } from "../../api/types.ts";
import { recordEntryKey, type RecordJob } from "../../domain/records.ts";
import type { RecordEntryContentState, RecordsPanelEmits, RecordsPanelProps } from "../../views/project-view-contract.ts";
import Badge from "../ui/Badge.vue";

const props = defineProps<RecordsPanelProps>();
const emit = defineEmits<RecordsPanelEmits>();

/** VivadoResult 状态原文 → 中文（成功态由 job.ok 单独判断，这里只覆盖非成功值）。 */
const STATUS_TEXT: Readonly<Record<string, string>> = {
  failed: "失败",
  timeout: "超时",
  lost: "丢失",
  unsupported: "不支持",
  unknown_effect: "结果未知",
};

function statusText(job: RecordJob): string {
  return job.ok ? "成功" : (STATUS_TEXT[job.status] ?? job.status);
}

function shortHash(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 12)}…` : sha;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── 卡片展开（本地 UI 态）+ 定位到 focusJobId ──────────────────────────

const expandedIds = ref<Set<string>>(new Set());

function isExpanded(jobId: string): boolean {
  return expandedIds.value.has(jobId);
}

function toggleCard(jobId: string): void {
  const next = new Set(expandedIds.value);
  if (next.has(jobId)) next.delete(jobId);
  else next.add(jobId);
  expandedIds.value = next;
}

const cardEls = new Map<string, Element>();

function setCardEl(jobId: string, el: Element | null): void {
  if (el) cardEls.set(jobId, el);
  else cardEls.delete(jobId);
}

const highlightedJobId = ref<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

async function focusJob(jobId: string): Promise<void> {
  const next = new Set(expandedIds.value);
  next.add(jobId);
  expandedIds.value = next;
  await nextTick();
  cardEls.get(jobId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  highlightedJobId.value = jobId;
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    highlightedJobId.value = null;
  }, 1600);
}

watch(
  () => [props.open, props.focusJobId] as const,
  ([open, jobId]) => {
    if (open && jobId) void focusJob(jobId);
  },
  { immediate: true },
);

// ─── 证据内容惰性加载：面板不发请求，只读 entryContent 回填并本地控制可见态 ──

const visibleEntries = ref<Set<string>>(new Set());

function contentState(jobId: string, name: string): RecordEntryContentState | undefined {
  return props.entryContent[recordEntryKey(jobId, name)];
}

function readyContent(jobId: string, name: string): JobEvidenceContent | null {
  const state = contentState(jobId, name);
  return state?.status === "ready" ? state.content : null;
}

function errorMessage(jobId: string, name: string): string | null {
  const state = contentState(jobId, name);
  return state?.status === "error" ? state.message : null;
}

function isEntryVisible(jobId: string, name: string): boolean {
  return visibleEntries.value.has(recordEntryKey(jobId, name));
}

function setEntryVisible(jobId: string, name: string, visible: boolean): void {
  const key = recordEntryKey(jobId, name);
  const next = new Set(visibleEntries.value);
  if (visible) next.add(key);
  else next.delete(key);
  visibleEntries.value = next;
}

function entryButtonLabel(jobId: string, name: string): string {
  const state = contentState(jobId, name);
  if (!state) return "查看内容";
  if (state.status === "loading") return "加载中…";
  if (state.status === "error") return "重试";
  return isEntryVisible(jobId, name) ? "收起内容" : "查看内容";
}

function onViewEntry(jobId: string, name: string): void {
  const state = contentState(jobId, name);
  if (!state) {
    setEntryVisible(jobId, name, true);
    emit("view-entry", jobId, name);
    return;
  }
  if (state.status === "loading") return;
  if (state.status === "error") {
    setEntryVisible(jobId, name, true);
    emit("view-entry", jobId, name); // 重试
    return;
  }
  setEntryVisible(jobId, name, !isEntryVisible(jobId, name)); // ready：本地切换显隐，不重新拉取
}
</script>

<template>
  <div class="records-panel">
    <div class="records-panel-header">
      <h2 class="records-panel-title">运行记录</h2>
      <button type="button" class="records-panel-close" aria-label="关闭运行记录" @click="emit('close')">✕</button>
    </div>

    <div class="records-panel-scroll">
      <div v-if="jobs.length === 0" class="records-panel-empty">暂无证据记录</div>

      <div
        v-for="job in jobs"
        v-else
        :key="job.jobId"
        :ref="(el) => setCardEl(job.jobId, el as Element | null)"
        class="record-card"
        :class="{ 'is-highlighted': highlightedJobId === job.jobId }"
      >
        <button type="button" class="record-card-header" @click="toggleCard(job.jobId)">
          <span class="record-card-caret" :class="{ 'is-collapsed': !isExpanded(job.jobId) }" aria-hidden="true">▾</span>
          <span class="record-card-title">{{ job.title }} · 第 {{ job.round }} 轮</span>
          <Badge :tone="job.ok ? 'ok' : 'danger'" size="sm">{{ statusText(job) }}</Badge>
          <span v-if="job.errorCode" class="record-card-error-code mono">{{ job.errorCode }}</span>
        </button>

        <div v-if="isExpanded(job.jobId)" class="record-card-body">
          <div class="record-card-meta">
            <span v-if="job.ts">{{ formatTime(job.ts) }}</span>
            <span class="mono">job:{{ job.jobId }}</span>
            <span class="mono">sha256:{{ shortHash(job.inputSha256) }}</span>
          </div>

          <div v-if="job.entries.length === 0" class="record-entries-empty">无证据条目</div>
          <ul v-else class="record-entries">
            <li v-for="entry in job.entries" :key="entry.name" class="record-entry">
              <div class="record-entry-head">
                <span class="record-entry-name mono" :title="entry.name">{{ entry.name }}</span>
                <button
                  type="button"
                  class="record-entry-view"
                  :disabled="contentState(job.jobId, entry.name)?.status === 'loading'"
                  @click="onViewEntry(job.jobId, entry.name)"
                >
                  {{ entryButtonLabel(job.jobId, entry.name) }}
                </button>
              </div>
              <div class="record-entry-meta">
                <span class="record-entry-media">{{ entry.mediaType }}</span>
                <span class="record-entry-size">{{ formatSize(entry.sizeBytes) }}</span>
                <span class="record-entry-hash mono">{{ shortHash(entry.sha256) }}</span>
              </div>

              <div v-if="isEntryVisible(job.jobId, entry.name)" class="record-entry-content">
                <span v-if="contentState(job.jobId, entry.name)?.status === 'loading'" class="record-entry-loading">加载中…</span>
                <span v-else-if="errorMessage(job.jobId, entry.name)" class="record-entry-error">{{ errorMessage(job.jobId, entry.name) }}</span>
                <template v-else-if="readyContent(job.jobId, entry.name)">
                  <pre class="record-entry-pre mono">{{ readyContent(job.jobId, entry.name)!.content }}</pre>
                  <p v-if="readyContent(job.jobId, entry.name)!.truncated" class="record-entry-truncated">内容过长，已截断</p>
                </template>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.records-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-panel);
  color: var(--text-primary);
}

.records-panel-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
}

.records-panel-title {
  flex: 1;
  margin: 0;
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary);
}

.records-panel-close {
  flex: none;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  cursor: pointer;
  padding: var(--space-1);
  line-height: 1;
}

.records-panel-close:hover {
  color: var(--text-primary);
}

.records-panel-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
}

.records-panel-empty {
  margin: auto 0;
  padding: var(--space-6) var(--space-4);
  text-align: center;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.record-card {
  border-radius: var(--radius);
  background: var(--surface-hover);
  transition: background-color var(--duration-slow) var(--ease-out);
}

.record-card.is-highlighted {
  background: var(--accent-subtle);
}

.record-card-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2);
  border: none;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
  text-align: left;
}

.record-card-caret {
  flex: none;
  width: 10px;
  color: var(--text-muted);
  font-size: 10px;
  transition: transform var(--duration) var(--ease-out);
}

.record-card-caret.is-collapsed {
  transform: rotate(-90deg);
}

.record-card-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.record-card-error-code {
  flex: none;
  color: var(--state-danger);
  font-size: 11px;
}

.record-card-body {
  padding: 0 var(--space-2) var(--space-2) calc(var(--space-2) + 18px);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.record-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  color: var(--text-muted);
  font-size: 11px;
}

.record-entries-empty {
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.record-entries {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.record-entry {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--surface-panel);
}

.record-entry-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
}

.record-entry-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: 2px;
}

.record-entry-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.record-entry-media,
.record-entry-size,
.record-entry-hash {
  flex: none;
  color: var(--text-muted);
  font-size: 11px;
}

.record-entry-view {
  flex: none;
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
}

.record-entry-view:hover {
  color: var(--accent-hover);
}

.record-entry-view:disabled {
  color: var(--text-muted);
  cursor: default;
}

.record-entry-content {
  margin-top: var(--space-1);
}

.record-entry-loading {
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.record-entry-error {
  color: var(--state-danger);
  font-size: var(--font-size-sm);
}

.record-entry-pre {
  margin: 0;
  padding: var(--space-2);
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
  background: var(--surface-hover);
  border-radius: var(--radius-sm);
  font-size: 11px;
}

.record-entry-truncated {
  margin: var(--space-1) 0 0;
  color: var(--text-muted);
  font-size: 11px;
}
</style>
