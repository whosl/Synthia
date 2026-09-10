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
  <div
    ref="rootEl"
    class="flex h-full min-h-0 flex-col bg-panel text-fg"
    :class="dragging ? 'cursor-row-resize select-none' : ''"
  >
    <!-- 一键登记横幅：钉在两栏之上，改动分布在哪一栏都看得见。 -->
    <div v-if="pendingCount > 0" class="flex-none border-b border-line bg-brand-subtle px-3 py-2">
      <div class="flex items-center gap-2">
        <span class="flex-1 text-xs text-fg">工作区有 {{ pendingCount }} 个改动</span>
        <button
          type="button"
          class="flex-none cursor-pointer rounded-sm border-0 bg-brand px-2 py-[2px] text-xs text-primary-foreground not-disabled:hover:bg-brand-hover disabled:cursor-default disabled:opacity-60"
          :disabled="registering"
          @click="reasonOpen ? submitRegister() : (reasonOpen = true)"
        >
          {{ registering ? "登记中…" : "登记" }}
        </button>
      </div>

      <div v-if="reasonOpen" class="mt-2 flex items-center gap-2">
        <input
          v-model="reason"
          type="text"
          class="min-w-0 flex-1 rounded-sm border border-line bg-panel px-2 py-[2px] text-xs text-fg focus-visible:border-brand focus-visible:outline-none"
          placeholder="这次改了什么（可留空）"
          :disabled="registering"
          @keydown.enter.prevent="submitRegister"
          @keydown.esc.prevent="reasonOpen = false"
        />
        <button
          type="button"
          class="flex-none cursor-pointer border-0 bg-transparent p-0 text-xs text-fg-secondary"
          :disabled="registering"
          @click="reasonOpen = false"
        >
          取消
        </button>
      </div>

      <!-- 旧 scoped 写的是未定义变量 var(--danger)，颜色静默回落为继承；这里补上语义令牌 --state-danger。 -->
      <p v-if="registerError" class="m-0 mt-2 text-xs leading-[1.4] text-danger">{{ registerError }}</p>
    </div>

    <section class="flex min-h-0 shrink grow-0 flex-col" :style="{ flexBasis: `${sourcePct}%` }">
      <header class="flex flex-none items-baseline gap-2 border-b border-line px-3 pt-2 pb-1">
        <span class="text-xs font-semibold text-fg">源文件</span>
        <span class="ml-auto font-mono text-[11px] text-fg-muted">{{ sourceCount }}</span>
      </header>
      <div class="flex-none px-2 pt-2">
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
      class="flex-none h-[5px] cursor-row-resize bg-line transition-colors duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-brand focus-visible:bg-brand focus-visible:outline-none"
      role="separator"
      aria-orientation="horizontal"
      aria-label="调整源文件与文档产物的分栏高度"
      tabindex="0"
      @pointerdown="beginDrag"
      @keydown.up.prevent="nudge(-4)"
      @keydown.down.prevent="nudge(4)"
    />

    <!-- 下栏吃掉除上栏 flex-basis 之外的全部剩余高度。 -->
    <section class="flex min-h-0 flex-1 flex-col">
      <header class="flex flex-none items-baseline gap-2 border-b border-line px-3 pt-2 pb-1">
        <span class="text-xs font-semibold text-fg">{{ documentContext === "gjb" ? "文档产物" : "文档" }}</span>
        <span v-if="documentContext === 'gjb'" class="text-[11px] tracking-[0.04em] text-fg-muted">GJB 参考</span>
        <span class="ml-auto font-mono text-[11px] text-fg-muted">{{ docCount }}</span>
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

