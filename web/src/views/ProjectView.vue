<script setup lang="ts">
/**
 * 三栏项目页（v4 架构基线批次）：顶栏 + 文件树 / 编辑器 / 对话三栏，可拖拽调宽。
 *
 * 本文件是四个栏位组件（TopBar / FileTree / CodeEditor / ChatFeed）唯一的数据
 * 编排者：项目详情、run 列表与详情、artifacts/revisions/内容、SSE 订阅全部在
 * 这里持有，四个栏位组件一律受控（见 views/project-view-contract.ts）。
 *
 * 第一批范围（spec §8 步骤 1-5）：不调 gate-submissions / jobs 端点，不做就地
 * 审批与证据面板；四个栏位组件本身是占位实现，真实交互由后续批次接入，本文件
 * 的编排数据已按契约就绪。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../main.ts";
import { readToken, useAuthStore } from "../stores/auth.ts";
import {
  abortAgent,
  createTask,
  getJobEvidenceContent,
  getProject,
  getRevisionContent,
  getTask,
  listArtifacts,
  listRevisions,
  listTasks,
  sendMessage,
} from "../api/index.ts";
import type {
  Artifact,
  ArtifactRevision,
  ProjectDetail,
  TaskAgentDetail,
  TaskAgentSummary,
} from "../api/types.ts";
import { createPoller, deriveStageChain, isTerminalStatus, type Poller } from "../domain/tasks.ts";
import { auditToParts, type SynthiaPart, type SynthiaTextPart } from "../domain/parts.ts";
import { buildRecordJobs, recordEntryKey } from "../domain/records.ts";
import {
  applyStreamEvent,
  subscribeTaskStream,
  type StreamFeedPart,
  type StreamHandle,
  type StreamPhase,
} from "../domain/task-stream.ts";
import { EXAMPLE_TASKS, humanizeDecisionError, humanizeLoadError } from "../domain/unified.ts";
import { buildFileTreeEntries } from "../domain/file-tree.ts";
import { resolveTheme, toggleTheme, type Theme } from "../domain/theme.ts";
import type {
  ChatComposerMode,
  ChatFeedProps,
  CodeEditorProps,
  EditorReadonlyReason,
  FileTreeEntry,
  FileTreeProps,
  FileTreeViewMode,
  RecordEntryContentState,
  RecordsPanelProps,
  TopBarProps,
} from "./project-view-contract.ts";
import Splitter from "../components/ui/Splitter.vue";
import TopBar from "../components/layout/TopBar.vue";
import FileTree from "../components/tree/FileTree.vue";
import CodeEditor from "../components/editor/CodeEditor.vue";
import ChatFeed from "../components/chat/ChatFeed.vue";
import RecordsPanel from "../components/records/RecordsPanel.vue";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const projectId = String(route.params.id);

// ─────────────────────────────────────────────────────────────────────
// 基础数据 + 轮询（3s；无活动 run 时停）
// ─────────────────────────────────────────────────────────────────────

const project = ref<ProjectDetail | null>(null);
const agents = ref<readonly TaskAgentSummary[]>([]);
const currentAgentId = ref<string | null>(typeof route.query.run === "string" ? route.query.run : null);
const detail = ref<TaskAgentDetail | null>(null);
const artifacts = ref<readonly Artifact[]>([]);
const revisionsByArtifact = ref<Record<string, readonly ArtifactRevision[]>>({});

const loading = ref(true);
const loadErrorText = ref<string | null>(null);

let poller: Poller | null = null;
let refreshing = false;

async function loadArtifactsAndRevisions(): Promise<void> {
  const list = await listArtifacts(api, projectId);
  artifacts.value = list;
  const pairs = await Promise.all(
    list.map(async (a) => [a.id, await listRevisions(api, projectId, a.id)] as const),
  );
  revisionsByArtifact.value = Object.fromEntries(pairs);
}

/** 每轮刷新：run 列表 + 当前 run 详情 + 产物/版本（agent 运行期间会不断产出新候选版本）。 */
async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const [taskList] = await Promise.all([listTasks(api, projectId), loadArtifactsAndRevisions()]);
    agents.value = [...taskList.agents].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    if (!currentAgentId.value && agents.value.length > 0) currentAgentId.value = agents.value[0]!.agent_id;
    detail.value = currentAgentId.value ? await getTask(api, projectId, currentAgentId.value) : null;
    loadErrorText.value = null;
  } catch (err) {
    loadErrorText.value = humanizeLoadError(err);
  } finally {
    refreshing = false;
  }
}

onMounted(async () => {
  try {
    project.value = await getProject(api, projectId);
  } catch (err) {
    loadErrorText.value = humanizeLoadError(err);
  }
  await refresh();
  loading.value = false;
  poller = createPoller(() => {
    void refresh();
    const active = agents.value.some((r) => r.status === "running" || r.status === "awaiting_approval");
    // 有其它后台 run 在跑，或当前 run 未知/未到终态 → 继续轮询；否则停。
    return active || detail.value === null || !isTerminalStatus(detail.value.status);
  }, 3000);
});

onBeforeUnmount(() => {
  poller?.stop();
  poller = null;
  streamHandle?.close();
  streamHandle = null;
});

// ─────────────────────────────────────────────────────────────────────
// SSE 订阅（跟随 currentAgentId）+ 对话流合成（audit 物化 + 流式增量，回合制去重）
// ─────────────────────────────────────────────────────────────────────

let streamHandle: StreamHandle | null = null;
const streamFeed = ref<readonly StreamFeedPart[]>([]);
const streamPhase = ref<StreamPhase>("connecting");

function openStream(agentId: string): void {
  streamHandle?.close();
  streamHandle = null;
  streamFeed.value = [];
  streamPhase.value = "connecting";
  streamHandle = subscribeTaskStream(
    `${(import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ""}/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(agentId)}/stream`,
    readToken(),
    0,
    {
      onEvent: (ev) => {
        streamFeed.value = applyStreamEvent(streamFeed.value, ev);
        if (ev.type === "done" || ev.type === "status" || ev.type === "reset") void refresh();
      },
      onPhase: (phase) => {
        streamPhase.value = phase;
      },
    },
  );
}

watch(
  currentAgentId,
  (agentId) => {
    if (agentId) {
      openStream(agentId);
    } else {
      streamHandle?.close();
      streamHandle = null;
      streamFeed.value = [];
    }
  },
  { immediate: true },
);

const auditParts = computed<readonly SynthiaPart[]>(() => (detail.value ? auditToParts(detail.value) : []));

/** SSE 打开的流式文本 part（尚未定稿的部分渲染于流尾，见下方 parts 合成）。 */
const streamingTextParts = computed<readonly SynthiaTextPart[]>(() =>
  streamFeed.value.map((p) => ({ kind: "text" as const, id: p.id, role: "agent" as const, state: p.state, text: p.text, segments: null })),
);

/**
 * 合成对话流：audit 物化（轮询，权威来源）+ SSE 流式增量（即时性），严格回合制、
 * 同文本去重（定稿事件与轮询 audit 的 free_agent_reply 同时到达时，以 audit 为
 * 权威内容、但沿用 SSE part 的 id 以复用 DOM，避免重复渲染同一条回复）。
 */
const parts = computed<readonly SynthiaPart[]>(() => {
  const streamedDoneTextIds = new Map(
    streamFeed.value.filter((s) => s.state === "done").map((s) => [s.text.trim(), s.id] as const),
  );
  const liveOnes = streamingTextParts.value.filter((p) => p.state === "streaming");
  const settled = auditParts.value.map((p) => {
    if (p.kind !== "text" || p.role !== "agent" || p.state !== "done") return p;
    const twinId = streamedDoneTextIds.get(p.text.trim());
    return twinId ? { ...p, id: twinId } : p;
  });
  return [...settled, ...liveOnes];
});

// ─────────────────────────────────────────────────────────────────────
// 文件树统一视图模型（artifact ↔ TaskDocRef 关联，见契约 FileTreeEntry 注释）
// ─────────────────────────────────────────────────────────────────────

const fileTreeEntries = computed<FileTreeEntry[]>(() =>
  buildFileTreeEntries(artifacts.value, revisionsByArtifact.value, detail.value?.docs ?? []),
);

const hasAgent = computed(() => agents.value.length > 0);

// ─────────────────────────────────────────────────────────────────────
// 中栏：当前打开的文件 / 版本 / 内容 / 只读态
// ─────────────────────────────────────────────────────────────────────

const openArtifactId = ref<string | null>(null);
const openRevisionId = ref<string | null>(null);
const fileContent = ref<string | null>(null);
const fileContentLoading = ref(false);
const diffAgainst = ref<CodeEditorProps["diffAgainst"]>(null);

const openFileEntry = computed<FileTreeEntry | null>(
  () => (openArtifactId.value ? fileTreeEntries.value.find((e) => e.artifactId === openArtifactId.value) ?? null : null),
);

const activeRevision = computed<ArtifactRevision | null>(() => {
  const entry = openFileEntry.value;
  if (!entry) return null;
  return entry.revisions.find((r) => r.id === openRevisionId.value) ?? entry.latestRevision;
});

/** 只读原因（spec §3.3 三态表 + D19）：已批准 > agent 运行中 > 可编辑。 */
const readonlyReason = computed<EditorReadonlyReason>(() => {
  const rev = activeRevision.value;
  if (!rev) return null;
  if (rev.state === "approved") return "approved";
  if (detail.value && !isTerminalStatus(detail.value.status)) return "agent-running";
  return null;
});

/** Monaco 语言 id：优先按 docs 路径后缀判断，无路径信息时按产物类型兜底猜测。 */
function inferLanguage(entry: FileTreeEntry | null): string {
  if (!entry) return "plaintext";
  const path = entry.path;
  if (path) {
    if (path.endsWith(".sv") || path.endsWith(".svh")) return "systemverilog";
    if (path.endsWith(".v") || path.endsWith(".vh")) return "verilog";
    if (path.endsWith(".xdc") || path.endsWith(".tcl")) return "tcl";
    if (path.endsWith(".md")) return "markdown";
    if (path.endsWith(".json")) return "json";
    if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  }
  if (entry.artifactType === "RTL_SOURCE_SET") return "verilog";
  if (entry.artifactType === "TB_SOURCE_SET") return "systemverilog";
  if (entry.artifactType === "XDC_CANDIDATE" || entry.artifactType === "CONSTRAINT_DESIGN") return "tcl";
  return "markdown";
}

async function loadRevisionContent(artifactId: string, revisionId: string): Promise<void> {
  fileContentLoading.value = true;
  try {
    const res = await getRevisionContent(api, projectId, artifactId, revisionId);
    fileContent.value = res.content;
  } catch (err) {
    fileContent.value = null;
    loadErrorText.value = humanizeLoadError(err);
  } finally {
    fileContentLoading.value = false;
  }
}

function openFile(artifactId: string): void {
  const entry = fileTreeEntries.value.find((e) => e.artifactId === artifactId);
  if (!entry) return;
  openArtifactId.value = artifactId;
  openRevisionId.value = entry.latestRevision.id;
  diffAgainst.value = null;
  void loadRevisionContent(artifactId, entry.latestRevision.id);
}

function onSelectRevision(revisionId: string): void {
  if (!openArtifactId.value) return;
  openRevisionId.value = revisionId;
  diffAgainst.value = null;
  void loadRevisionContent(openArtifactId.value, revisionId);
}

async function onCompareRevisions(baseRevisionId: string, headRevisionId: string): Promise<void> {
  const entry = openFileEntry.value;
  if (!entry) return;
  const base = entry.revisions.find((r) => r.id === baseRevisionId);
  const head = entry.revisions.find((r) => r.id === headRevisionId);
  if (!base || !head) return;
  openRevisionId.value = head.id;
  fileContentLoading.value = true;
  try {
    const [baseRes, headRes] = await Promise.all([
      getRevisionContent(api, projectId, entry.artifactId, base.id),
      getRevisionContent(api, projectId, entry.artifactId, head.id),
    ]);
    fileContent.value = headRes.content;
    diffAgainst.value = { base, baseContent: baseRes.content, head };
  } catch (err) {
    loadErrorText.value = humanizeLoadError(err);
  } finally {
    fileContentLoading.value = false;
  }
}

function onExitDiff(): void {
  diffAgainst.value = null;
}

// ─────────────────────────────────────────────────────────────────────
// 顶栏：阶段链 / 当前 run / 任务切换 / 阶段点击联动左栏
// ─────────────────────────────────────────────────────────────────────

const stageChain = computed(() => (detail.value ? deriveStageChain(detail.value) : null));
const currentAgent = computed<TaskAgentSummary | null>(() => agents.value.find((r) => r.agent_id === currentAgentId.value) ?? null);

const viewMode = ref<FileTreeViewMode>("path");
const focusStageId = ref<string | null>(null);

function onSelectAgent(agentId: string): void {
  if (agentId === currentAgentId.value) return;
  currentAgentId.value = agentId;
  detail.value = null;
  openArtifactId.value = null;
  openRevisionId.value = null;
  fileContent.value = null;
  diffAgainst.value = null;
  void refresh();
}

function onSelectStage(stageId: string): void {
  viewMode.value = "stage";
  focusStageId.value = stageId;
}

function onLogout(): void {
  auth.logout();
  void router.push({ name: "login" });
}

// ─────────────────────────────────────────────────────────────────────
// 主题（App.vue 已在启动时 initTheme 写入 DOM；这里持有可切换的响应式状态）
// ─────────────────────────────────────────────────────────────────────

const theme = ref<Theme>(resolveTheme(window.localStorage, window.matchMedia("(prefers-color-scheme: dark)")));

function onToggleTheme(): void {
  theme.value = toggleTheme(theme.value, window.localStorage);
}

// ─────────────────────────────────────────────────────────────────────
// 响应式降级（spec R3）：<1280px 右栏浮层化，<1024px 左栏抽屉化
// ─────────────────────────────────────────────────────────────────────

const viewportWidth = ref(window.innerWidth);
function onResize(): void {
  viewportWidth.value = window.innerWidth;
}
onMounted(() => window.addEventListener("resize", onResize));
onBeforeUnmount(() => window.removeEventListener("resize", onResize));

const leftCollapsed = computed(() => viewportWidth.value < 1024);
const rightCollapsed = computed(() => viewportWidth.value < 1280);
const treeDrawerOpen = ref(false);
const chatOverlayOpen = ref(false);

// ─────────────────────────────────────────────────────────────────────
// 右栏：发言模式 / 发送 / 打断
// ─────────────────────────────────────────────────────────────────────

const composerMode = computed<ChatComposerMode>(() => {
  if (agents.value.length === 0) return "new-task";
  if (detail.value?.status === "running") return "steer";
  return "prompt";
});
const canAbort = computed(() => detail.value?.status === "running");
const sending = ref(false);
const sendError = ref<string | null>(null);

async function onSend(text: string): Promise<void> {
  if (sending.value) return;
  sending.value = true;
  sendError.value = null;
  try {
    if (composerMode.value === "new-task") {
      const { agentId } = await createTask(api, projectId, { task: text, mode: "agent" }, crypto.randomUUID());
      currentAgentId.value = agentId;
    } else if (currentAgentId.value) {
      await sendMessage(api, projectId, currentAgentId.value, text);
    }
    await refresh();
  } catch (err) {
    sendError.value = humanizeDecisionError(err, "发送").text;
  } finally {
    sending.value = false;
  }
}

async function onAbort(): Promise<void> {
  if (!currentAgentId.value || sending.value) return;
  sending.value = true;
  sendError.value = null;
  try {
    await abortAgent(api, projectId, currentAgentId.value);
    await refresh();
  } catch (err) {
    sendError.value = humanizeLoadError(err);
  } finally {
    sending.value = false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 运行记录面板：从当前 run 详情按 jobId 关联出 job 列表，证据内容惰性拉取
// ─────────────────────────────────────────────────────────────────────

const recordsOpen = ref(false);
const recordsFocusJobId = ref<string | null>(null);
const recordEntryContent = ref<Record<string, RecordEntryContentState>>({});

const recordJobs = computed(() => (detail.value ? buildRecordJobs(detail.value) : []));

function onOpenRecords(jobId: string | null): void {
  recordsFocusJobId.value = jobId;
  recordsOpen.value = true;
}

function onCloseRecords(): void {
  recordsOpen.value = false;
}

async function onViewRecordEntry(jobId: string, name: string): Promise<void> {
  const key = recordEntryKey(jobId, name);
  if (recordEntryContent.value[key]?.status === "ready") return;
  recordEntryContent.value = { ...recordEntryContent.value, [key]: { status: "loading" } };
  try {
    const content = await getJobEvidenceContent(api, projectId, jobId, name);
    recordEntryContent.value = { ...recordEntryContent.value, [key]: { status: "ready", content } };
  } catch (err) {
    recordEntryContent.value = { ...recordEntryContent.value, [key]: { status: "error", message: humanizeLoadError(err) } };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 栏位 props（对齐 project-view-contract.ts，编译期校验字段齐全）
// ─────────────────────────────────────────────────────────────────────

const topBarProps = computed<TopBarProps>(() => ({
  projectName: project.value?.name ?? "",
  stageChain: stageChain.value,
  currentAgent: currentAgent.value,
  agents: agents.value,
  theme: theme.value,
  treeDrawerOpen: treeDrawerOpen.value,
  chatOverlayOpen: chatOverlayOpen.value,
}));

const fileTreeProps = computed<FileTreeProps>(() => ({
  entries: fileTreeEntries.value,
  viewMode: viewMode.value,
  hasAgent: hasAgent.value,
  openArtifactId: openArtifactId.value,
  drawerMode: leftCollapsed.value,
  focusStageId: focusStageId.value,
}));

const codeEditorProps = computed<CodeEditorProps>(() => ({
  file: openFileEntry.value,
  activeRevision: activeRevision.value,
  content: fileContent.value,
  loading: fileContentLoading.value,
  readonlyReason: readonlyReason.value,
  language: inferLanguage(openFileEntry.value),
  theme: theme.value,
  diffAgainst: diffAgainst.value,
}));

const chatFeedProps = computed<ChatFeedProps>(() => ({
  parts: parts.value,
  agentStatus: detail.value?.status ?? null,
  streamPhase: streamPhase.value,
  composerMode: composerMode.value,
  canAbort: canAbort.value,
  sending: sending.value,
  sendError: sendError.value,
  exampleTasks: EXAMPLE_TASKS,
}));

const recordsPanelProps = computed<RecordsPanelProps>(() => ({
  open: recordsOpen.value,
  jobs: recordJobs.value,
  focusJobId: recordsFocusJobId.value,
  entryContent: recordEntryContent.value,
}));

function onOpenFile(artifactId: string): void {
  openFile(artifactId);
}

function onCloseDrawer(): void {
  treeDrawerOpen.value = false;
}

function onUpdateViewMode(mode: FileTreeViewMode): void {
  viewMode.value = mode;
}

function onOpenDoc(artifactId: string): void {
  openFile(artifactId);
  chatOverlayOpen.value = false;
}

function onToggleTreeDrawer(): void {
  treeDrawerOpen.value = !treeDrawerOpen.value;
}

function onToggleChatOverlay(): void {
  chatOverlayOpen.value = !chatOverlayOpen.value;
}
</script>

<template>
  <div class="project-view">
    <header class="project-view-topbar">
      <TopBar
        v-bind="topBarProps"
        @select-agent="onSelectAgent"
        @select-stage="onSelectStage"
        @toggle-theme="onToggleTheme"
        @toggle-tree-drawer="onToggleTreeDrawer"
        @toggle-chat-overlay="onToggleChatOverlay"
        @logout="onLogout"
      />
    </header>

    <div v-if="loadErrorText" class="project-view-error">{{ loadErrorText }}</div>

    <Splitter
      class="project-view-body"
      storage-key="synthia.splitter"
      :left-collapsed="leftCollapsed"
      :right-collapsed="rightCollapsed"
    >
      <template #left>
        <FileTree v-bind="fileTreeProps" @update:viewMode="onUpdateViewMode" @open-file="onOpenFile" @close-drawer="onCloseDrawer" />
      </template>
      <template #center>
        <CodeEditor
          v-bind="codeEditorProps"
          @select-revision="onSelectRevision"
          @compare-revisions="onCompareRevisions"
          @exit-diff="onExitDiff"
        />
      </template>
      <template #right>
        <ChatFeed v-bind="chatFeedProps" @send="onSend" @abort="onAbort" @open-doc="onOpenDoc" @open-records="onOpenRecords" />
      </template>
    </Splitter>

    <!-- <1024px：文件树抽屉化（spec R3），与 Splitter 内的左栏互斥渲染 -->
    <Transition name="project-view-veil-fade">
      <div v-if="leftCollapsed && treeDrawerOpen" class="project-view-veil" @click.self="onCloseDrawer">
        <div class="project-view-drawer">
          <FileTree v-bind="fileTreeProps" @update:viewMode="onUpdateViewMode" @open-file="onOpenFile" @close-drawer="onCloseDrawer" />
        </div>
      </div>
    </Transition>

    <!-- <1280px：对话栏浮层化（spec R3），与 Splitter 内的右栏互斥渲染 -->
    <Transition name="project-view-veil-fade">
      <div v-if="rightCollapsed && chatOverlayOpen" class="project-view-veil project-view-veil-end" @click.self="onToggleChatOverlay">
        <div class="project-view-overlay">
          <ChatFeed v-bind="chatFeedProps" @send="onSend" @abort="onAbort" @open-doc="onOpenDoc" @open-records="onOpenRecords" />
        </div>
      </div>
    </Transition>

    <!-- 运行记录抽屉：任意视口宽度可开合，不与左右栏的响应式降级绑定 -->
    <Transition name="project-view-veil-fade">
      <div v-if="recordsOpen" class="project-view-veil project-view-veil-end" @click.self="onCloseRecords">
        <div class="project-view-overlay">
          <RecordsPanel v-bind="recordsPanelProps" @close="onCloseRecords" @view-entry="onViewRecordEntry" />
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.project-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 0;
  background: var(--surface-base);
  color: var(--text-primary);
}

.project-view-topbar {
  flex: none;
  height: var(--topbar-height);
  background: var(--surface-panel);
  border-bottom: 1px solid var(--border-subtle);
}

.project-view-error {
  flex: none;
  padding: var(--space-2) var(--space-4);
  background: color-mix(in srgb, var(--state-danger) 12%, transparent);
  color: var(--state-danger);
  font-size: var(--font-size-sm);
}

.project-view-body {
  flex: 1;
  min-height: 0;
}

.project-view-veil {
  position: fixed;
  inset: 0;
  z-index: var(--z-drawer);
  display: flex;
  background: rgba(0, 0, 0, 0.35);
}

.project-view-veil-end {
  justify-content: flex-end;
  z-index: var(--z-overlay);
}

.project-view-drawer,
.project-view-overlay {
  height: 100%;
  background: var(--surface-panel);
  box-shadow: 0 0 24px var(--shadow-color);
  overflow: hidden;
}

.project-view-drawer {
  width: min(320px, 86vw);
}

.project-view-overlay {
  width: min(380px, 92vw);
}

.project-view-veil-fade-enter-active,
.project-view-veil-fade-leave-active {
  transition: opacity var(--duration) var(--ease-out);
}

.project-view-veil-fade-enter-from,
.project-view-veil-fade-leave-to {
  opacity: 0;
}
</style>
