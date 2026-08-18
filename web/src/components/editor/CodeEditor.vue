<script setup lang="ts">
/**
 * 中栏编辑器：Monaco 封装（v4 第一批 §8 步骤 4，只读骨架）。
 *
 * - **动态加载**（spec R4）：monaco-editor 约 300KB，仅在真正需要渲染代码（非
 *   markdown 的文件被打开）时才通过 Vite 动态 import 加载，不在组件顶层 import。
 *   markdown 走 DocPreview（不加载 Monaco），空态/加载态也不加载 Monaco。
 * - **只读**：第一批 UI 上 readOnly 恒为 true；顶部按 readonlyReason 显示提示条
 *   （只读原因判定逻辑在 domain/editor-state.ts，第二批放开可编辑直接复用）。
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
import Badge from "../ui/Badge.vue";
import Button from "../ui/Button.vue";
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
const showDocPreview = computed(() => !props.diffAgainst && isDocPreviewLanguage(props.language));

/** 是否需要挂载 Monaco：有文件、不是 DocPreview、内容已加载完成。 */
const needsMonaco = computed(() => !!props.file && !showDocPreview.value && !props.loading);

/** 顶部只读提示条文案：「vN」+（可选）「· 原因文案」，无版本时不渲染（见契约注释）。 */
const readonlyBanner = computed<string | null>(() => {
  const rev = props.activeRevision;
  if (!rev) return null;
  const suffix = props.readonlyReason ? ` · ${EDITOR_READONLY_BANNER[props.readonlyReason]}` : "";
  return `v${rev.version}${suffix}`;
});

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

  const model = monaco.editor.createModel(props.content ?? "", props.language);
  const previousModel = currentModel;
  currentModel = model;

  if (!editorInstance) {
    editorInstance = monaco.editor.create(host, {
      // 第一批恒为只读（D19 判定逻辑已就绪，第二批据 readonlyReason===null 放开）。
      readOnly: true,
      automaticLayout: true,
      theme: monacoThemeFor(props.theme),
      fontFamily: "var(--font-mono)",
      fontSize: 12.5,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
  }
  editorInstance.setModel(model);
  previousModel?.dispose();
}

/** 首次真正需要渲染代码时才加载 monaco-editor，加载完成后挂到 editorHost 上。 */
async function ensureMonacoMounted(): Promise<void> {
  await nextTick(); // 等 editorHost 的 v-else 分支先渲染出 DOM 节点
  if (!editorHost.value) return;
  monacoLoading.value = true;
  try {
    monacoRef = await loadMonaco();
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
  () => [props.content, props.language, props.diffAgainst] as const,
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

onBeforeUnmount(() => {
  disposeEditors();
});

// ─────────────────────────────────────────────────────────────────────
// emits 转发
// ─────────────────────────────────────────────────────────────────────

function onSelectRevision(revisionId: string): void {
  emit("select-revision", revisionId);
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
          <Badge v-else-if="readonlyBanner" size="sm" :tone="readonlyReason ? 'warn' : 'neutral'">
            {{ readonlyBanner }}
          </Badge>
        </div>
      </div>

      <div class="code-editor-body">
        <div v-if="loading" class="code-editor-loading">加载中…</div>
        <DocPreview v-else-if="showDocPreview" :content="content ?? ''" />
        <div v-else class="code-editor-monaco-wrap">
          <div v-if="monacoLoading" class="code-editor-loading">正在加载编辑器…</div>
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
  height: 32px;
  padding: 0 var(--space-3);
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
</style>
