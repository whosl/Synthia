<script setup lang="ts">
/**
 * 运行记录面板（右侧抽屉；veil/挂载由 ProjectView 控制，见 project-view-contract.ts
 * 顶部「运行记录面板」注释）。ChatFeed 把技术细节压缩掉的 jobId/errorCode/证据
 * 全量清单在这里原样展开——展开态、证据内容可见态都是本地 UI 态，面板每次
 * 由 ProjectView 的 veil v-if 重新挂载，不需要跨刷新保留。
 */
import { nextTick, ref, watch } from "vue";
import type { JobEvidenceContent } from "../../api/types.ts";
import { formatTime } from "../../util/format-time.ts";
import { recordEntryKey, type RecordJob } from "../../domain/records.ts";
import type { RecordEntryContentState, RecordsPanelEmits, RecordsPanelProps } from "../../views/project-view-contract.ts";
import PanelHeader from "../panels/PanelHeader.vue";
import Badge from "../ui/AppBadge.vue";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion";

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── 卡片展开（本地 UI 态，ui/accordion 多选模式）+ 定位到 focusJobId ──────

const expandedIds = ref<string[]>([]);

function isExpanded(jobId: string): boolean {
  return expandedIds.value.includes(jobId);
}

/** ui/accordion 的 update:modelValue 声明是 string | string[] | undefined 并集，
 *  multiple 模式下实际只会是数组，这里收窄后再写回。 */
function onExpandedChange(value: string | string[] | undefined): void {
  expandedIds.value = Array.isArray(value) ? value : [];
}

const cardEls = new Map<string, Element>();

function setCardEl(jobId: string, el: Element | null): void {
  if (el) cardEls.set(jobId, el);
  else cardEls.delete(jobId);
}

const highlightedJobId = ref<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

async function focusJob(jobId: string): Promise<void> {
  if (!isExpanded(jobId)) {
    expandedIds.value = [...expandedIds.value, jobId];
  }
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
  <div class="flex h-full min-h-0 flex-col bg-panel text-fg">
    <PanelHeader title="运行记录" @close="emit('close')" />

    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <div v-if="jobs.length === 0" class="my-auto px-4 py-6 text-center text-xs text-fg-muted">暂无证据记录</div>

      <Accordion
        v-else
        type="multiple"
        :model-value="expandedIds"
        class="records-accordion flex flex-col gap-2"
        @update:model-value="onExpandedChange"
      >
        <div
          v-for="job in jobs"
          :key="job.jobId"
          :ref="(el) => setCardEl(job.jobId, el as Element | null)"
          class="rounded-md bg-hover transition-colors duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
          :class="highlightedJobId === job.jobId ? 'bg-brand-subtle' : ''"
        >
          <AccordionItem :value="job.jobId" class="border-b-0">
            <AccordionTrigger class="w-full cursor-pointer items-center gap-2 border-0 bg-transparent p-2 text-xs font-normal text-fg hover:no-underline">
              <span
                class="w-[10px] flex-none text-[10px] text-fg-muted transition-transform duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]"
                :class="isExpanded(job.jobId) ? '' : '-rotate-90'"
                aria-hidden="true"
              >▾</span>
              <span class="min-w-0 flex-1 truncate">{{ job.title }} · 第 {{ job.round }} 轮</span>
              <Badge :tone="job.ok ? 'ok' : 'danger'" variant="dot" size="sm">{{ statusText(job) }}</Badge>
              <span v-if="job.errorCode" class="flex-none font-mono text-[11px] text-danger">{{ job.errorCode }}</span>
              <template #icon></template>
            </AccordionTrigger>

            <AccordionContent class="flex flex-col gap-2 pr-2 pb-2 pl-[26px]">
              <div class="flex flex-wrap gap-2 text-[11px] text-fg-muted">
                <span v-if="job.ts" class="tabular-nums">{{ formatTime(job.ts) }}</span>
                <span class="mono">job:{{ job.jobId }}</span>
                <span class="mono">sha256:{{ shortHash(job.inputSha256) }}</span>
              </div>

              <div v-if="job.entries.length === 0" class="text-xs text-fg-muted">无证据条目</div>
              <ul v-else class="m-0 flex list-none flex-col gap-1 p-0">
                <li v-for="entry in job.entries" :key="entry.name" class="rounded-sm bg-panel px-2 py-1">
                  <div class="flex items-center gap-2 text-xs">
                    <span class="mono min-w-0 flex-1 truncate text-fg" :title="entry.name">{{ entry.name }}</span>
                    <button
                      type="button"
                      class="flex-none cursor-pointer border-0 bg-transparent p-0 text-[11px] text-brand not-disabled:hover:text-brand-hover disabled:cursor-default disabled:text-fg-muted"
                      :disabled="contentState(job.jobId, entry.name)?.status === 'loading'"
                      @click="onViewEntry(job.jobId, entry.name)"
                    >
                      {{ entryButtonLabel(job.jobId, entry.name) }}
                    </button>
                  </div>
                  <div class="mt-[2px] flex flex-wrap gap-2">
                    <span class="flex-none text-[11px] text-fg-muted">{{ entry.mediaType }}</span>
                    <span class="flex-none text-[11px] text-fg-muted tabular-nums">{{ formatSize(entry.sizeBytes) }}</span>
                    <span class="flex-none font-mono text-[11px] text-fg-muted">{{ shortHash(entry.sha256) }}</span>
                  </div>

                  <div v-if="isEntryVisible(job.jobId, entry.name)" class="mt-1">
                    <span v-if="contentState(job.jobId, entry.name)?.status === 'loading'" class="text-xs text-fg-muted">加载中…</span>
                    <span v-else-if="errorMessage(job.jobId, entry.name)" class="text-xs text-danger">{{ errorMessage(job.jobId, entry.name) }}</span>
                    <template v-else-if="readyContent(job.jobId, entry.name)">
                      <!-- record-entry-pre：未分层的全局 pre{monospace 12.5px} 规则优先级高于
                           Tailwind utilities 层，11px 字号只能留在 scoped（同 CodeCard 的处置）。 -->
                      <pre class="record-entry-pre m-0 max-h-[320px] overflow-auto rounded-sm bg-hover p-2 break-words whitespace-pre-wrap text-fg">{{ readyContent(job.jobId, entry.name)!.content }}</pre>
                      <p v-if="readyContent(job.jobId, entry.name)!.truncated" class="m-0 mt-1 text-[11px] text-fg-muted">内容过长，已截断</p>
                    </template>
                  </div>
                </li>
              </ul>
            </AccordionContent>
          </AccordionItem>
        </div>
      </Accordion>
    </div>
  </div>
</template>

<style scoped>
/* 见模板注释：全局 pre 元素规则未分层，11px 字号留给 scoped。 */
.record-entry-pre {
  font-size: 11px;
}

/* ui/accordion 的 AccordionTrigger 内嵌 reka AccordionHeader（默认渲染 h3）；本仓库
 * 跳过 Tailwind preflight，UA 标题样式（上下 1em 外边距、字号加粗）会穿透进卡片
 * 头部，这里只收回版式项，trigger 本体样式不动。 */
.records-accordion :deep(h3) {
  margin: 0;
  font-size: inherit;
  font-weight: inherit;
  letter-spacing: normal;
}
</style>
