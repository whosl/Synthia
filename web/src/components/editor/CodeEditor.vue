<script setup lang="ts">
/**
 * 中栏编辑器：Monaco 封装（v4 第一批 §8 步骤 4）。
 *
 * - **动态加载**（spec R4）：monaco-editor 约 300KB，仅在真正需要渲染代码（非
 *   markdown 的文件被打开）时才通过 Vite 动态 import 加载，不在组件顶层 import。
 *   markdown 走 DocPreview（不加载 Monaco），空态/加载态也不加载 Monaco。
 * - **可编辑**：`readonlyReason === null` 时放开编辑并出「保存」按钮，保存即
 *   emit save(正文)，由 ProjectView 写回工作区文件（`PUT workspace/file`）。
 *   只读原因的判定在 ProjectView（它才知道正文是盘上那份还是某一版修订）。
 * - **主题联动**：CodeEditor 是受控组件，直接用 props.theme 判断（见
 *   project-view-contract.ts:CodeEditorProps.theme 注释），深色 vs-dark、浅色 vs。
 * - **生命周期**：组件卸载或切到不需要 Monaco 的状态（无文件/markdown 预览）时
 *   dispose 编辑器实例与 model，避免内存泄漏。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type * as MonacoNamespace from "monaco-editor";
import { EDITOR_READONLY_BANNER } from "../../views/project-view-contract.ts";
import type { CodeEditorEmits, CodeEditorProps } from "../../views/project-view-contract.ts";
import { isDocPreviewLanguage, monacoThemeFor } from "../../domain/editor-state.ts";
import { artifactDocName } from "../../domain/artifacts.ts";
import Badge from "../ui/AppBadge.vue";
import Button from "../ui/AppButton.vue";
import VersionBar from "./VersionBar.vue";
import DocPreview from "./DocPreview.vue";

const props = defineProps<CodeEditorProps>();
const emit = defineEmits<CodeEditorEmits>();

// ─────────────────────────────────────────────────────────────────────
// 显示用派生数据
// ─────────────────────────────────────────────────────────────────────

/** 标题：优先显示当前 run 关联到的路径，无关联时退回产物类型中文名（见契约 FileTreeEntry.path 注释）。 */
const fileTitle = computed(() => {
  const file = props.file;
  if (!file) return "";
  return file.path ?? artifactDocName(file.artifactType);
});

/** markdown 且非对比态 → 走 DocPreview，不加载 Monaco。 */
const markdownEditing = ref(false);
const showDocPreview = computed(() => !props.diffAgainst && isDocPreviewLanguage(props.language) && !markdownEditing.value);

/** 是否需要挂载 Monaco：有文件、不是 DocPreview、内容已加载完成。 */
const needsMonaco = computed(() => !!props.file && props.content !== null && !showDocPreview.value && !props.loading);

/** 可编辑当且仅当没有只读原因，且不在对比态（diff 编辑器两侧都只读）。 */
const editable = computed(() => props.readonlyReason === null && !props.diffAgainst && props.content !== null && !props.loading);

/**
 * 顶部状态条：「v3 · 未登记改动 · 已批准 · 只读」这样一路拼下来。
 *
 * 「未登记改动」只在**正文来自工作区**时才说得出口——看历史版本时盘上确实有改动，
 * 但屏幕上这份不是它，标在这里会让人以为自己正看着那些改动。
 */
const statusText = computed<string | null>(() => {
  const file = props.file;
  if (!file) return null;
  const bits: string[] = [props.activeRevision ? `v${props.activeRevision.version}` : "未登记"];
  if (props.activeRevision && props.contentSource === "workspace" && file.status && file.status !== "registered") {
    bits.push("未登记改动");
  }
  if (props.readonlyReason) bits.push(EDITOR_READONLY_BANNER[props.readonlyReason]);
  return bits.join(" · ");
});

/** 只读或有未登记改动都用 warn——两者都是「屏幕上这份不是登记在册的那份」。 */
const statusTone = computed<"warn" | "neutral">(() =>
  props.readonlyReason || (props.file?.status && props.file.status !== "registered") ? "warn" : "neutral",
);

// ─────────────────────────────────────────────────────────────────────
// Monaco 动态加载 + 生命周期管理
// ─────────────────────────────────────────────────────────────────────

type Monaco = typeof MonacoNamespace;

/** 动态加载的模块缓存（组件生命周期内只加载一次；切换文件不重复拉取 300KB）。 */
let monacoLoadPromise: Promise<Monaco> | null = null;

function loadMonaco(): Promise<Monaco> {
  if (!monacoLoadPromise) {
    monacoLoadPromise = (async () => {
      const [monaco, workerModule] = await Promise.all([
        import("monaco-editor"),
        import("monaco-editor/esm/vs/editor/editor.worker.js?worker"),
      ]);
      // 第一批只读展示，不接语言专属 worker（json 校验等）；通用 editor worker
      // 足够跑基础的分词/布局，避免为每种语言各拉一个 worker chunk 增大体积。
      self.MonacoEnvironment = {
        getWorker: () => new workerModule.default(),
      };
      return monaco;
    })();
  }
  return monacoLoadPromise;
}

const editorHost = ref<HTMLDivElement | null>(null);
const monacoLoading = ref(false);
const monacoError = ref<string | null>(null);
/** 编辑器里的字节与 props.content 已经不同——决定「保存」按钮亮不亮。 */
const dirty = ref(false);
watch(dirty, (value) => emit("dirty-change", value), { flush: "sync" });
watch(() => props.file?.artifactId, () => { markdownEditing.value = false; });

let monacoRef: Monaco | null = null;
let editorInstance: MonacoNamespace.editor.IStandaloneCodeEditor | null = null;
let diffEditorInstance: MonacoNamespace.editor.IStandaloneDiffEditor | null = null;
let currentModel: MonacoNamespace.editor.ITextModel | null = null;
let diffModels: { base: MonacoNamespace.editor.ITextModel; head: MonacoNamespace.editor.ITextModel } | null = null;

function disposeDiffModels(): void {
  if (diffModels) {
    diffModels.base.dispose();
    diffModels.head.dispose();
    diffModels = null;
  }
}

/** 拆卸全部 Monaco 实例与 model（组件卸载、或切到无需 Monaco 的状态时调用）。 */
function disposeEditors(): void {
  dirty.value = false;
  editorInstance?.dispose();
  editorInstance = null;
  diffEditorInstance?.dispose();
  diffEditorInstance = null;
  currentModel?.dispose();
  currentModel = null;
  disposeDiffModels();
}

/** 用当前 props（content/language/diffAgainst）重建/更新已挂载的 Monaco 实例。 */
function renderContent(): void {
  const monaco = monacoRef;
  const host = editorHost.value;
  if (!monaco || !host) return;

  const diff = props.diffAgainst;
  if (diff) {
    editorInstance?.dispose();
    editorInstance = null;
    currentModel?.dispose();
    currentModel = null;
    disposeDiffModels();

    const base = monaco.editor.createModel(diff.baseContent, props.language);
    const head = monaco.editor.createModel(props.content ?? "", props.language);
    diffModels = { base, head };

    if (!diffEditorInstance) {
      diffEditorInstance = monaco.editor.createDiffEditor(host, {
        readOnly: true,
        automaticLayout: true,
        theme: monacoThemeFor(props.theme),
        renderSideBySide: true,
        fontFamily: "var(--font-mono)",
        fontSize: 12.5,
        minimap: { enabled: false },
      });
    }
    diffEditorInstance.setModel({ original: base, modified: head });
    return;
  }

  diffEditorInstance?.dispose();
  diffEditorInstance = null;
  disposeDiffModels();

  const next = props.content ?? "";

  // 盘上的字节和编辑器里已经一模一样了（多半是刚保存成功、编排层把正文回填进来）。
  // 这时重建 model 会把光标弹回第一行——正在改第 300 行的人会当场丢掉位置。
  if (editorInstance && currentModel && currentModel.getValue() === next && currentModel.getLanguageId() === props.language) {
    dirty.value = false;
    return;
  }

  const model = monaco.editor.createModel(next, props.language);
  const previousModel = currentModel;
  currentModel = model;

  if (!editorInstance) {
    editorInstance = monaco.editor.create(host, {
      readOnly: !editable.value || props.saving,
      automaticLayout: true,
      theme: monacoThemeFor(props.theme),
      fontFamily: "var(--font-mono)",
      fontSize: 12.5,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
    // 监听挂在编辑器而不是 model 上：换 model 走的是 onDidChangeModel，不会误报脏。
    editorInstance.onDidChangeModelContent(() => {
      dirty.value = currentModel !== null && currentModel.getValue() !== (props.content ?? "");
    });
    editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => submitSave());
  }
  editorInstance.setModel(model);
  dirty.value = false;
  previousModel?.dispose();
}

/** 首次真正需要渲染代码时才加载 monaco-editor，加载完成后挂到 editorHost 上。 */
async function ensureMonacoMounted(): Promise<void> {
  await nextTick(); // 等 editorHost 的 v-else 分支先渲染出 DOM 节点
  if (!editorHost.value) return;
  monacoLoading.value = true;
  monacoError.value = null;
  try {
    monacoRef = await loadMonaco();
  } catch {
    monacoLoadPromise = null;
    monacoError.value = "编辑器加载失败，请重试。";
    return;
  } finally {
    monacoLoading.value = false;
  }
  // 加载期间用户可能已经切走（关闭文件/切到 markdown），host 不再存在则放弃本次挂载。
  if (!editorHost.value) return;
  renderContent();
}

watch(
  needsMonaco,
  (need) => {
    if (need) {
      void ensureMonacoMounted();
    } else {
      disposeEditors();
    }
  },
  { immediate: true },
);

watch(
  () => [props.content, props.language, props.diffAgainst, props.file?.artifactId] as const,
  () => {
    if (needsMonaco.value && monacoRef) renderContent();
  },
);

watch(
  () => props.theme,
  (theme) => {
    monacoRef?.editor.setTheme(monacoThemeFor(theme));
  },
);

// 只读态可能在文件不变的情况下翻转（agent 跑起来了、这一版刚被批准），所以更新
// 已挂载实例的选项，而不是等下一次 renderContent。
watch(() => [editable.value, props.saving] as const, ([canEdit, saving]) => {
  editorInstance?.updateOptions({ readOnly: !canEdit || saving });
});

onBeforeUnmount(() => {
  disposeEditors();
});

// ─────────────────────────────────────────────────────────────────────
// emits 转发
// ─────────────────────────────────────────────────────────────────────

function onSelectRevision(revisionId: string): void {
  emit("select-revision", revisionId);
}

/**
 * 保存：把编辑器里当前的字节交给编排层写回工作区文件。
 *
 * 不在这里把 dirty 放下——写盘可能失败，提前清掉就等于告诉用户"存好了"。等编排层
 * 把新正文回填进 props.content，renderContent 那条相等分支才会清。
 */
function submitSave(): void {
  if (!editable.value || props.saving || !currentModel) return;
  emit("save", currentModel.getValue());
}
</script>

<template>
  <div class="code-editor">
    <div v-if="!file" class="code-editor-empty">
      <p class="code-editor-empty-title">未打开任何文件</p>
      <p class="code-editor-empty-hint">从左侧文件树选择一个文件开始查看</p>
    </div>

    <template v-else>
      <div class="code-editor-header">
        <div class="code-editor-header-main">
          <span class="code-editor-title" :title="fileTitle">{{ fileTitle }}</span>
          <VersionBar :revisions="file.revisions" :active-revision-id="activeRevision?.id ?? null" @select-revision="onSelectRevision" />
        </div>
        <div class="code-editor-header-status">
          <span v-if="diffAgainst" class="code-editor-diff-tag">
            对比 v{{ diffAgainst.base.version }} → v{{ diffAgainst.head.version }}
            <Button size="sm" variant="ghost" @click="emit('exit-diff')">退出对比</Button>
          </span>
          <template v-else>
            <Badge v-if="statusText" size="sm" :tone="statusTone">{{ statusText }}</Badge>
            <Button v-if="isDocPreviewLanguage(language) && !loading && content !== null && (editable || markdownEditing)" size="sm" :disabled="dirty || saving" @click="markdownEditing = !markdownEditing">{{ markdownEditing ? '预览文档' : '编辑文档' }}</Button>
            <span v-if="dirty" class="dirty-label">未保存</span>
            <Button v-if="editable" size="sm" variant="ghost" :disabled="!dirty || saving" @click="submitSave">
              {{ saving ? "保存中…" : "保存" }}
            </Button>
          </template>
        </div>
      </div>

      <p v-if="saveError" class="code-editor-save-error" role="alert">{{ saveError }}</p>

      <div class="code-editor-body">
        <div v-if="loading" class="code-editor-loading">加载中…</div>
        <div v-else-if="content === null" class="code-editor-loading">无法显示文件内容，请从文件树重新打开以重试。</div>
        <DocPreview v-else-if="showDocPreview" :content="content ?? ''" />
        <div v-else class="code-editor-monaco-wrap">
          <div v-if="monacoError" class="code-editor-loading" role="alert">{{ monacoError }}<Button @click="ensureMonacoMounted">重试</Button></div>
          <div v-else-if="monacoLoading" class="code-editor-loading">正在加载编辑器…</div>
          <div ref="editorHost" class="code-editor-monaco-host" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.code-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-base);
  color: var(--text-primary);
}

.code-editor-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
}

.code-editor-empty-title {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-base);
}

.code-editor-empty-hint {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.code-editor-header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 40px;
  flex-wrap: wrap;
  padding-top: 6px;
  padding-bottom: 6px;
  padding-left: var(--space-3);
  padding-right: var(--space-3);
  background: var(--surface-panel);
  border-bottom: 1px solid var(--border-subtle);
}

.code-editor-header-main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.code-editor-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.code-editor-header-status {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.code-editor-save-error {
  flex: none;
  margin: 0;
  padding: var(--space-1) var(--space-3);
  background: var(--surface-panel);
  border-bottom: 1px solid var(--border-subtle);
  color: var(--state-danger);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-list);
}

.code-editor-diff-tag {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.code-editor-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.code-editor-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.code-editor-monaco-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
}

.code-editor-monaco-wrap .code-editor-loading {
  position: absolute;
  inset: 0;
  background: var(--surface-base);
}

.code-editor-monaco-host {
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.dirty-label { color: var(--state-warn); font-size: 11px; }
.code-editor-monaco-wrap .code-editor-loading { z-index: 1; gap: 12px; }
</style>
