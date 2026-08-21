<script setup lang="ts">
/**
 * 左栏文件树（spec §3.2）：上下分栏 + 可拖拽分隔条。
 *
 * - **上栏「源文件」**：RTL / 测试台 / 约束等源码，默认按文件路径分组（组内按
 *   完整路径排序）。`ViewSwitcher` 收进这一栏的头部，只管这一栏的分组方式。
 * - **下栏「文档产物」**：其余产物，恒按 GJB 正式文档名分组——「符合 GJB 的
 *   文档都在这儿」，换分组方式没有意义，所以不受 viewMode 影响。
 *
 * 二分与分组逻辑全部委托给 `domain/file-tree.ts:buildSplitFileTree`（纯函数，
 * 测试见 tests/file-tree.test.ts）——本组件只负责渲染、折叠、拖拽分栏高度这类
 * 纯本地 UI 态，不重新实现任何分组规则，也不重新做 artifact↔TaskDocRef 关联
 * （entries 已经是 ProjectView 关联好的统一视图模型，见契约注释）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { FileTreeEmits, FileTreeProps } from "../../views/project-view-contract.ts";
import { buildSplitFileTree, stageFocusGroupKey } from "../../domain/file-tree.ts";
import FileTreeSection from "./FileTreeSection.vue";
import ViewSwitcher from "./ViewSwitcher.vue";

const props = defineProps<FileTreeProps>();
const emit = defineEmits<FileTreeEmits>();

const split = computed(() => buildSplitFileTree(
  props.entries,
  props.viewMode,
  props.hasAgent,
  props.documentContext,
));

function countFiles(groups: { readonly files: readonly unknown[] }[] | readonly { readonly files: readonly unknown[] }[]): number {
  let n = 0;
  for (const g of groups) n += g.files.length;
  return n;
}

const sourceCount = computed(() => countFiles(split.value.source.groups));
const docCount = computed(() => countFiles(split.value.docs.groups));

// ─── 分组展开/折叠（纯本地 UI 态：默认全部展开，不跨刷新保留）───────────────
//
// 键带栏位前缀，两栏的分组 key 互不干扰（见 FileTreeSection.vue 头注释）。

const collapsedGroups = ref<Set<string>>(new Set());

function toggleGroup(prefix: string, key: string): void {
  const full = `${prefix}:${key}`;
  const next = new Set(collapsedGroups.value);
  if (next.has(full)) next.delete(full);
  else next.add(full);
  collapsedGroups.value = next;
}

// ─── 上下分栏高度（纯 UI 态，与 Splitter.vue 一样自持并持久化）──────────────
//
// 存的是**上栏占比**而不是像素：左栏本身可以被 Splitter 拖宽、也会在窄屏变成
// 抽屉，高度像素值换个视口就没意义了。

const SPLIT_STORAGE_KEY = "synthia.filetree.sourcePct";
const SPLIT_MIN_PCT = 20;
const SPLIT_MAX_PCT = 80;

function readStoredPct(): number {
  const raw = window.localStorage.getItem(SPLIT_STORAGE_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, parsed)) : 55;
}

const rootEl = ref<HTMLElement | null>(null);
const sourcePct = ref(readStoredPct());
const dragging = ref(false);

function beginDrag(ev: PointerEvent): void {
  dragging.value = true;
  ev.preventDefault();
  window.addEventListener("pointermove", onDrag);
  window.addEventListener("pointerup", endDrag, { once: true });
}

function onDrag(ev: PointerEvent): void {
  const host = rootEl.value;
  if (!host) return;
  const rect = host.getBoundingClientRect();
  if (rect.height <= 0) return;
  const pct = ((ev.clientY - rect.top) / rect.height) * 100;
  sourcePct.value = Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, pct));
}

function endDrag(): void {
  dragging.value = false;
  window.removeEventListener("pointermove", onDrag);
  window.localStorage.setItem(SPLIT_STORAGE_KEY, String(Math.round(sourcePct.value)));
}

/** 键盘可达：分隔条聚焦后上下键各挪 4%。 */
function nudge(delta: number): void {
  sourcePct.value = Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, sourcePct.value + delta));
  window.localStorage.setItem(SPLIT_STORAGE_KEY, String(Math.round(sourcePct.value)));
}

onBeforeUnmount(() => {
  window.removeEventListener("pointermove", onDrag);
  window.removeEventListener("pointerup", endDrag);
});

// ─── 点击文件：中栏打开 + 抽屉模式下自动收起 ─────────────────────────────

function onOpenFile(artifactId: string): void {
  emit("open-file", artifactId);
  if (props.drawerMode) emit("close-drawer");
}

// ─── 一键登记：把工作区当前全部改动收成一个 commit + N 条候选修订 ────────────
//
// 说明栏默认收起。登记这件事本身要一步可达（横幅上的按钮就是），写理由是可选的
// 第二步——强制填才会逼出「改了点东西」这类没信息量的敷衍理由。

const reasonOpen = ref(false);
const reason = ref("");

function submitRegister(): void {
  if (props.registering) return;
  emit("register", reason.value.trim());
}

// 登记成功后待登记数归零，横幅整条消失；顺手把展开的说明栏收回去，免得下次有改动
// 时它带着上一次的理由弹出来。失败时 pendingCount 不变，输入的字保留着可以重试。
watch(
  () => props.pendingCount,
  (n) => {
    if (n === 0) {
      reasonOpen.value = false;
      reason.value = "";
    }
  },
);

// ─── 顶栏点击阶段节点 → 定位到该阶段（spec §3.1 末条）────────────────────

const highlightedGroupKey = ref<string | null>(null);
const highlightedPhase = ref<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

function clearHighlightLater(): void {
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    highlightedGroupKey.value = null;
    highlightedPhase.value = null;
  }, 1600);
}

/**
 * 定位分两步走：先找同名分组（上栏切到阶段视图时才有），找不到再按行的 phase
 * 找——研制要求 / 结构设计这些阶段的产物在下栏，下栏是按 GJB 文档名分组的，
 * 永远不会有一个叫 `intake` 的分组，只能落到行上。两步都落空（门节点
 * G1/G3/G4 本就不是任何产物的 phase）就静默忽略，不报错。
 */
async function focusStage(stageId: string): Promise<void> {
  const key = stageFocusGroupKey(stageId);
  highlightedGroupKey.value = null;
  highlightedPhase.value = null;

  const next = new Set(collapsedGroups.value);
  for (const prefix of ["source", "docs"]) next.delete(`${prefix}:${key}`);
  collapsedGroups.value = next;
  await nextTick();

  const host = rootEl.value;
  if (!host) return;
  const escaped = CSS.escape(key);
  const groupEl = host.querySelector<HTMLElement>(`[data-group-key="${escaped}"]`);
  if (groupEl) {
    groupEl.scrollIntoView({ behavior: "smooth", block: "start" });
    highlightedGroupKey.value = key;
    clearHighlightLater();
    return;
  }

  const rowEl = host.querySelector<HTMLElement>(`[data-phase="${escaped}"]`);
  if (!rowEl) return;
  rowEl.scrollIntoView({ behavior: "smooth", block: "center" });
  highlightedPhase.value = key;
  clearHighlightLater();
}

watch(
  () => props.focusStageId,
  (stageId) => {
    if (stageId) void focusStage(stageId);
  },
);
watch(
  () => props.viewMode,
  () => {
    if (props.focusStageId) void focusStage(props.focusStageId);
  },
);
</script>

<template>
  <div ref="rootEl" class="filetree" :class="{ 'is-dragging': dragging }">
    <div v-if="pendingCount > 0" class="filetree-register">
      <div class="filetree-register-row">
        <span class="filetree-register-text">工作区有 {{ pendingCount }} 个改动</span>
        <button
          type="button"
          class="filetree-register-action"
          :disabled="registering"
          @click="reasonOpen ? submitRegister() : (reasonOpen = true)"
        >
          {{ registering ? "登记中…" : "登记" }}
        </button>
      </div>

      <div v-if="reasonOpen" class="filetree-register-form">
        <input
          v-model="reason"
          type="text"
          class="filetree-register-input"
          placeholder="这次改了什么（可留空）"
          :disabled="registering"
          @keydown.enter.prevent="submitRegister"
          @keydown.esc.prevent="reasonOpen = false"
        />
        <button type="button" class="filetree-register-cancel" :disabled="registering" @click="reasonOpen = false">
          取消
        </button>
      </div>

      <p v-if="registerError" class="filetree-register-error">{{ registerError }}</p>
    </div>

    <section class="filetree-section" :style="{ flexBasis: `${sourcePct}%` }">
      <header class="filetree-section-head">
        <span class="filetree-section-title">源文件</span>
        <span class="filetree-section-count">{{ sourceCount }}</span>
      </header>
      <div class="filetree-switcher">
        <ViewSwitcher :model-value="viewMode" @update:model-value="emit('update:viewMode', $event)" />
      </div>
      <FileTreeSection
        :result="split.source"
        key-prefix="source"
        :collapsed="collapsedGroups"
        :open-artifact-id="openArtifactId"
        :highlighted-group-key="highlightedGroupKey"
        :highlighted-phase="highlightedPhase"
        offers-view-escape
        @toggle-group="toggleGroup('source', $event)"
        @open-file="onOpenFile"
        @escape-view="emit('update:viewMode', 'type')"
      />
    </section>

    <div
      class="filetree-divider"
      role="separator"
      aria-orientation="horizontal"
      aria-label="调整源文件与文档产物的分栏高度"
      tabindex="0"
      @pointerdown="beginDrag"
      @keydown.up.prevent="nudge(-4)"
      @keydown.down.prevent="nudge(4)"
    />

    <section class="filetree-section filetree-section-docs">
      <header class="filetree-section-head">
        <span class="filetree-section-title">{{ documentContext === "gjb" ? "文档产物" : "文档" }}</span>
        <span v-if="documentContext === 'gjb'" class="filetree-section-hint">GJB 参考</span>
        <span class="filetree-section-count">{{ docCount }}</span>
      </header>
      <FileTreeSection
        :result="split.docs"
        key-prefix="docs"
        :collapsed="collapsedGroups"
        :open-artifact-id="openArtifactId"
        :highlighted-group-key="highlightedGroupKey"
        :highlighted-phase="highlightedPhase"
        :offers-view-escape="false"
        @toggle-group="toggleGroup('docs', $event)"
        @open-file="onOpenFile"
      />
    </section>
  </div>
</template>

<style scoped>
.filetree {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-panel);
  color: var(--text-primary);
}

.filetree.is-dragging {
  user-select: none;
  cursor: row-resize;
}

/* 一键登记横幅：钉在两栏之上，改动分布在哪一栏都看得见。 */
.filetree-register {
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--accent-subtle);
}

.filetree-register-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.filetree-register-text {
  flex: 1;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.filetree-register-action {
  flex: none;
  border: none;
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
  background: var(--accent);
  color: var(--text-on-accent);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.filetree-register-action:hover:not(:disabled) {
  background: var(--accent-hover);
}

.filetree-register-action:disabled {
  opacity: 0.6;
  cursor: default;
}

.filetree-register-form {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.filetree-register-input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
  background: var(--surface-panel);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.filetree-register-input:focus-visible {
  outline: none;
  border-color: var(--accent);
}

.filetree-register-cancel {
  flex: none;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  padding: 0;
}

.filetree-register-error {
  margin: var(--space-2) 0 0;
  color: var(--danger);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-list);
}

.filetree-section {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex-grow: 0;
  flex-shrink: 1;
}

/* 下栏吃掉除上栏 flex-basis 之外的全部剩余高度。 */
.filetree-section-docs {
  flex: 1 1 0;
}

.filetree-section-head {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3) var(--space-1);
  border-bottom: 1px solid var(--border-subtle);
}

.filetree-section-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.filetree-section-hint {
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 0.04em;
}

.filetree-section-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.filetree-switcher {
  flex: none;
  padding: var(--space-2) var(--space-2) 0;
}

.filetree-divider {
  flex: none;
  height: 5px;
  cursor: row-resize;
  background: var(--border-subtle);
  transition: background-color var(--duration) var(--ease-out);
}

.filetree-divider:hover,
.filetree-divider:focus-visible {
  background: var(--accent);
  outline: none;
}
</style>
