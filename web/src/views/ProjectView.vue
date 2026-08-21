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
  adoptSideTask,
  approveGateSubmission,
  confirmImportSnapshot,
  copyHistoricalMaterial,
  createImportSnapshot,
  createSideTask,
  createTask,
  denyImportSnapshot,
  getGateSubmission,
  getImportSnapshot,
  getJobEvidenceContent,
  getProject,
  getRevisionContent,
  getSideTask,
  getSideTaskDiff,
  getSideTaskEvents,
  getSideTaskResult,
  getTask,
  getWorkspaceFile,
  getWorkspaceTree,
  listArtifacts,
  listGateSubmissions,
  listImportSnapshots,
  listRevisions,
  listSideTasks,
  listTasks,
  putWorkspaceFile,
  registerWorkspace,
  rejectGateSubmission,
  searchHistoricalMaterials,
  sendMessage,
} from "../api/index.ts";
// ApproveRequest 住在 api/index.ts（请求体形状），不在 api/types.ts（响应体形状）。
import type { ApproveRequest } from "../api/index.ts";
import type {
  AdoptSideTaskRequest,
  Artifact,
  ArtifactRevision,
  CopyHistoricalMaterialRequest,
  CreateImportSnapshotRequest,
  CreateSideTaskRequest,
  GateSubmissionDetail,
  HistoricalMaterialSearchResult,
  HistoricalMaterialSnapshot,
  ProjectDetail,
  SideTaskAdoptionResult,
  SideTaskConversationEvent,
  SideTaskDiff,
  SideTaskResult,
  SideTaskSummary,
  TaskAgentDetail,
  TaskAgentSummary,
  TaskDocRef,
  WorkspaceTree,
} from "../api/types.ts";
import {
  createPoller,
  deriveStageChain,
  isTerminalStatus,
  prepareTaskAbortAttempt,
  resolveMainTaskId,
  type Poller,
  type TaskAbortAttempt,
} from "../domain/tasks.ts";
import { auditToParts, type SynthiaPart, type SynthiaTextPart } from "../domain/parts.ts";
import { buildRecordJobs, recordEntryKey } from "../domain/records.ts";
import {
  applyStreamEvent,
  subscribeTaskStream,
  type StreamFeedPart,
  type StreamHandle,
  type StreamPhase,
} from "../domain/task-stream.ts";
import {
  EXAMPLE_TASKS,
  buildApproveBody,
  deriveApprovalCard,
  findApprovalSubmission,
  humanizeDecisionError,
  humanizeLoadError,
  loadRejectionReason,
  resolveSnapshotMembers,
  shouldFetchSubmission,
  shouldReuseApproveAttempt,
  shouldReuseRejectAttempt,
  type ApprovalMember,
  type DecisionFailure,
} from "../domain/unified.ts";
import { GATE_REVIEW_NAMES, type GateId } from "../domain/gates.ts";
import { buildFileTreeEntries, workspaceEntryPath } from "../domain/file-tree.ts";
import { deriveReadonlyReason } from "../domain/editor-state.ts";
import { resolveTheme, toggleTheme, type Theme } from "../domain/theme.ts";
import { processVersionText, projectType, projectTypeText } from "../domain/project.ts";
import {
  HISTORICAL_MATERIALS_FEATURE_ENABLED,
  SIDE_TASKS_FEATURE_ENABLED,
  shouldShowHistoricalMaterials,
  shouldShowSideTasks,
} from "../domain/feature-flags.ts";
import {
  canInspectSideTaskResult,
  prepareSideTaskAdoptionAttempt,
  prepareSideTaskCreateAttempt,
  shouldPollSideTasks,
  sideTaskErrorText,
  type SideTaskAdoptionAttempt,
  type SideTaskCreateAttempt,
} from "../domain/side-tasks.ts";
import type {
  ApprovalCardProps,
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
import { pickRevision, prevRevisionId } from "./project-view-contract.ts";
import Splitter from "../components/ui/Splitter.vue";
import TopBar from "../components/layout/TopBar.vue";
import FileTree from "../components/tree/FileTree.vue";
import CodeEditor from "../components/editor/CodeEditor.vue";
import ChatFeed from "../components/chat/ChatFeed.vue";
import RecordsPanel from "../components/records/RecordsPanel.vue";
import HistoricalMaterialsPanel from "../components/materials/HistoricalMaterialsPanel.vue";
import SideTasksPanel from "../components/tasks/SideTasksPanel.vue";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const projectId = String(route.params.id);

// ─────────────────────────────────────────────────────────────────────
// 基础数据 + 轮询（3s；无活动 run 时停）
// ─────────────────────────────────────────────────────────────────────

const project = ref<ProjectDetail | null>(null);
const historicalMaterialsEnabled = computed(() => shouldShowHistoricalMaterials(
  HISTORICAL_MATERIALS_FEATURE_ENABLED,
  project.value?.project_type,
));
const sideTasksEnabled = computed(() => shouldShowSideTasks(
  SIDE_TASKS_FEATURE_ENABLED,
  project.value?.project_type,
));
const agents = ref<readonly TaskAgentSummary[]>([]);
const initialRequestedAgentId = typeof route.query.run === "string" ? route.query.run : null;
// Query ids stay untrusted until the main-task list has been loaded.
const currentAgentId = ref<string | null>(null);
let initialRunSelectionPending = true;
/**
 * 用户在任务切换器点了「开始新对话」：composerMode 应强制走 new-task，直到真的
 * 建出新 agent 为止。必须是独立于 currentAgentId 的标记——下面 refresh() 一发现
 * currentAgentId 为空就会回填成最新的那个 agent（哪怕它已经锁死),仅仅把
 * currentAgentId 置空撑不过下一次 3s 轮询。
 */
const forceNewTask = ref(false);
const detail = ref<TaskAgentDetail | null>(null);
const artifacts = ref<readonly Artifact[]>([]);
const revisionsByArtifact = ref<Record<string, readonly ArtifactRevision[]>>({});
/** 磁盘工作区快照（`GET workspace/tree`）；项目还没建出工作区时为 null。 */
const workspace = ref<WorkspaceTree | null>(null);

// ─────────────────────────────────────────────────────────────────────
// P2 历史资料库（按需加载；资料端点不可用时只在抽屉内 fail closed）
// ─────────────────────────────────────────────────────────────────────

const materialsOpen = ref(false);
const materialSnapshots = ref<readonly HistoricalMaterialSnapshot[]>([]);
const materialSelectedId = ref<string | null>(null);
const materialSelected = ref<HistoricalMaterialSnapshot | null>(null);
const materialSearchResults = ref<readonly HistoricalMaterialSearchResult[]>([]);
const materialSearchQuery = ref("");
const materialsLoading = ref(false);
const materialsSearching = ref(false);
const materialsOperating = ref(false);
const materialsError = ref<string | null>(null);
const materialsNotice = ref<string | null>(null);
let materialsRequestSerial = 0;
let materialsNoticeTimer: ReturnType<typeof window.setTimeout> | null = null;

// ─────────────────────────────────────────────────────────────────────
// P3 探索任务（按需加载；与主 Agent/SSE/审批状态完全隔离）
// ─────────────────────────────────────────────────────────────────────

const sideTasksOpen = ref(false);
const sideTasks = ref<readonly SideTaskSummary[]>([]);
const selectedSideTaskId = ref<string | null>(null);
const selectedSideTask = ref<SideTaskSummary | null>(null);
const selectedSideTaskEvents = ref<readonly SideTaskConversationEvent[]>([]);
const selectedSideTaskResult = ref<SideTaskResult | null>(null);
const selectedSideTaskDiff = ref<SideTaskDiff | null>(null);
const sideTasksLoading = ref(false);
const sideTaskDetailLoading = ref(false);
const sideTasksOperating = ref(false);
const sideTaskMessaging = ref(false);
const sideTaskMessageText = ref("");
const sideTaskMessageError = ref<string | null>(null);
const sideTasksError = ref<string | null>(null);
const sideTasksNotice = ref<string | null>(null);
let sideTasksRequestSerial = 0;
let sideTaskDetailSerial = 0;
let sideTasksNoticeTimer: ReturnType<typeof window.setTimeout> | null = null;
let sideTaskPoller: Poller | null = null;
let sideTaskCreateAttempt: SideTaskCreateAttempt | null = null;
let sideTaskAdoptionAttempt: SideTaskAdoptionAttempt | null = null;
let sideTaskMessageAttempt: { readonly taskId: string; readonly text: string; readonly key: string } | null = null;

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

/**
 * 磁盘工作区快照。**失败不抛**：老项目是在工作区这套东西之前建的，盘上根本没有目录，
 * 这时整页仍应照常显示 DB 里的产物，只是没有「改动/登记」这层语义。为此把工作区置空
 * 而不是保留上一次的结果——留着会让树上出现盘上已经不存在的行。
 */
async function loadWorkspace(): Promise<boolean> {
  try {
    workspace.value = await getWorkspaceTree(api, projectId);
    return true;
  } catch {
    workspace.value = null;
    return false;
  }
}

/** 每轮刷新：run 列表 + 当前 run 详情 + 产物/版本（agent 运行期间会不断产出新候选版本）+ 工作区。 */
async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const [taskList] = await Promise.all([listTasks(api, projectId), loadArtifactsAndRevisions(), loadWorkspace()]);
    agents.value = [...taskList.agents]
      .filter((task) => task.kind !== "side")
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const resolvingInitialRun = initialRunSelectionPending;
    const preferredTaskId = resolvingInitialRun ? initialRequestedAgentId : currentAgentId.value;
    currentAgentId.value = forceNewTask.value ? null : resolveMainTaskId(preferredTaskId, agents.value);
    initialRunSelectionPending = false;
    if (resolvingInitialRun && initialRequestedAgentId !== currentAgentId.value) {
      const query = { ...route.query };
      if (currentAgentId.value) query.run = currentAgentId.value;
      else delete query.run;
      void router.replace({ query });
    }
    detail.value = currentAgentId.value ? await getTask(api, projectId, currentAgentId.value) : null;
    loadErrorText.value = null;
    // 就地审批：只在进入等待态且尚未持有该门提交时才真的发请求（见 shouldFetchSubmission）
    void syncApproval();
  } catch (err) {
    loadErrorText.value = humanizeLoadError(err);
  } finally {
    refreshing = false;
  }
}

function clearMaterialsNoticeLater(): void {
  if (materialsNoticeTimer !== null) window.clearTimeout(materialsNoticeTimer);
  materialsNoticeTimer = window.setTimeout(() => {
    materialsNotice.value = null;
    materialsNoticeTimer = null;
  }, 4200);
}

/** 资料操作没有后台自动重试；错误文案必须给手动重试出口，不能声称正在重试。 */
function humanizeMaterialsError(err: unknown): string {
  return humanizeDecisionError(err, "资料操作").text;
}

async function loadMaterialDetail(snapshotId: string): Promise<void> {
  const serial = materialsRequestSerial;
  materialSelectedId.value = snapshotId;
  try {
    const detail = await getImportSnapshot(api, projectId, snapshotId);
    if (serial !== materialsRequestSerial || materialSelectedId.value !== snapshotId) return;
    materialSelected.value = detail;
  } catch (err) {
    if (serial !== materialsRequestSerial) return;
    materialSelected.value = null;
    materialsError.value = humanizeMaterialsError(err);
  }
}

async function loadMaterials(): Promise<void> {
  if (!historicalMaterialsEnabled.value) return;
  const serial = ++materialsRequestSerial;
  materialsLoading.value = true;
  materialsError.value = null;
  try {
    const snapshots = await listImportSnapshots(api, projectId);
    if (serial !== materialsRequestSerial) return;
    materialSnapshots.value = snapshots;
    const selectedId = materialSelectedId.value && snapshots.some((snapshot) => snapshot.id === materialSelectedId.value)
      ? materialSelectedId.value
      : snapshots[0]?.id ?? null;
    materialSelectedId.value = selectedId;
    materialSelected.value = null;
    if (selectedId) await loadMaterialDetail(selectedId);
  } catch (err) {
    if (serial !== materialsRequestSerial) return;
    materialSnapshots.value = [];
    materialSelected.value = null;
    materialsError.value = humanizeMaterialsError(err);
  } finally {
    if (serial === materialsRequestSerial) materialsLoading.value = false;
  }
}

function openMaterials(): void {
  if (!historicalMaterialsEnabled.value) return;
  closeSideTasks();
  materialsOpen.value = true;
  if (materialSnapshots.value.length === 0 && !materialsLoading.value && !materialsError.value) void loadMaterials();
}

function closeMaterials(): void {
  materialsOpen.value = false;
}

function onSelectMaterialSnapshot(snapshotId: string): void {
  materialsError.value = null;
  void loadMaterialDetail(snapshotId);
}

async function onSearchMaterials(query: string): Promise<void> {
  materialSearchQuery.value = query;
  materialsSearching.value = true;
  materialsError.value = null;
  try {
    materialSearchResults.value = await searchHistoricalMaterials(api, projectId, query);
  } catch (err) {
    materialSearchResults.value = [];
    materialsError.value = humanizeMaterialsError(err);
  } finally {
    materialsSearching.value = false;
  }
}

async function onImportMaterials(body: CreateImportSnapshotRequest): Promise<void> {
  if (materialsOperating.value) return;
  materialsOperating.value = true;
  materialsError.value = null;
  materialsNotice.value = null;
  try {
    const created = await createImportSnapshot(api, projectId, body, crypto.randomUUID());
    materialSelectedId.value = created.id;
    materialsNotice.value = "资料已导入，当前处于待确认状态；确认前不会进入 Agent 默认上下文。";
    await loadMaterials();
    clearMaterialsNoticeLater();
  } catch (err) {
    materialsError.value = humanizeMaterialsError(err);
  } finally {
    materialsOperating.value = false;
  }
}

async function onConfirmMaterials(snapshotId: string): Promise<void> {
  if (materialsOperating.value) return;
  materialsOperating.value = true;
  materialsError.value = null;
  try {
    await confirmImportSnapshot(api, projectId, snapshotId, crypto.randomUUID());
    materialsNotice.value = "资料已确认；只有仍有效的文件会进入默认检索。";
    await loadMaterials();
    clearMaterialsNoticeLater();
  } catch (err) {
    materialsError.value = humanizeMaterialsError(err);
  } finally {
    materialsOperating.value = false;
  }
}

async function onDenyMaterials(snapshotId: string, reason: string): Promise<void> {
  if (materialsOperating.value) return;
  materialsOperating.value = true;
  materialsError.value = null;
  try {
    await denyImportSnapshot(api, projectId, snapshotId, reason ? { reason } : {}, crypto.randomUUID());
    materialsNotice.value = "资料已否决，不会进入 Agent 默认上下文。";
    await loadMaterials();
    clearMaterialsNoticeLater();
  } catch (err) {
    materialsError.value = humanizeMaterialsError(err);
  } finally {
    materialsOperating.value = false;
  }
}

async function onCopyMaterials(snapshotId: string, body: CopyHistoricalMaterialRequest): Promise<void> {
  if (materialsOperating.value) return;
  materialsOperating.value = true;
  materialsError.value = null;
  try {
    const result = await copyHistoricalMaterial(api, projectId, snapshotId, body, crypto.randomUUID());
    materialsNotice.value = `已复制 ${result.revisions.length} 个文件为当前项目候选修订；确认状态不会被继承。`;
    // 候选修订已经改变左栏事实，顺手刷新工作区/产物，但不关闭资料抽屉。
    await refresh();
    clearMaterialsNoticeLater();
  } catch (err) {
    materialsError.value = humanizeMaterialsError(err);
  } finally {
    materialsOperating.value = false;
  }
}

const sideTaskParent = computed<TaskAgentSummary | null>(() => {
  const isMainTerminal = (status: string): boolean =>
    isTerminalStatus(status) || status === "cancelled" || status === "aborted";
  const current = agents.value.find((task) => task.agent_id === currentAgentId.value);
  if (current && current.kind !== "side" && !isMainTerminal(current.status)) return current;
  return agents.value.find((task) => task.kind !== "side" && !isMainTerminal(task.status)) ?? null;
});

const sideTaskBaseCommit = computed<string | null>(() =>
  workspace.value?.head_commit ?? sideTaskParent.value?.base_commit ?? null,
);

function clearSideTasksNoticeLater(): void {
  if (sideTasksNoticeTimer !== null) window.clearTimeout(sideTasksNoticeTimer);
  sideTasksNoticeTimer = window.setTimeout(() => {
    sideTasksNotice.value = null;
    sideTasksNoticeTimer = null;
  }, 5200);
}

async function loadSideTaskDetail(taskId: string): Promise<boolean> {
  const serial = ++sideTaskDetailSerial;
  sideTaskDetailLoading.value = true;
  const changedTask = selectedSideTaskId.value !== taskId;
  selectedSideTaskId.value = taskId;
  if (changedTask) {
    selectedSideTask.value = null;
    selectedSideTaskEvents.value = [];
    selectedSideTaskResult.value = null;
    selectedSideTaskDiff.value = null;
  }
  try {
    const [task, conversation] = await Promise.all([
      getSideTask(api, projectId, taskId),
      getSideTaskEvents(api, projectId, taskId),
    ]);
    if (serial !== sideTaskDetailSerial || selectedSideTaskId.value !== taskId) return false;
    if (conversation.task_id !== taskId) throw new Error("Core 返回了其他探索任务的对话事件");
    selectedSideTask.value = task;
    selectedSideTaskEvents.value = conversation.events;
    if (canInspectSideTaskResult(task)) {
      const [result, diff] = await Promise.all([
        getSideTaskResult(api, projectId, taskId),
        getSideTaskDiff(api, projectId, taskId),
      ]);
      if (serial !== sideTaskDetailSerial || selectedSideTaskId.value !== taskId) return false;
      selectedSideTaskResult.value = result;
      selectedSideTaskDiff.value = diff;
    } else {
      selectedSideTaskResult.value = null;
      selectedSideTaskDiff.value = null;
    }
    return true;
  } catch (err) {
    if (serial !== sideTaskDetailSerial) return false;
    if (changedTask) {
      selectedSideTask.value = null;
      selectedSideTaskEvents.value = [];
      selectedSideTaskResult.value = null;
      selectedSideTaskDiff.value = null;
    }
    sideTasksError.value = sideTaskErrorText(err, "加载");
    return false;
  } finally {
    if (serial === sideTaskDetailSerial) sideTaskDetailLoading.value = false;
  }
}

async function loadSideTasks(preferredTaskId?: string): Promise<boolean> {
  if (!sideTasksEnabled.value) return false;
  const serial = ++sideTasksRequestSerial;
  sideTasksLoading.value = true;
  sideTasksError.value = null;
  try {
    const tasks = await listSideTasks(api, projectId);
    if (serial !== sideTasksRequestSerial) return false;
    sideTasks.value = [...tasks].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const selectedId = preferredTaskId && tasks.some((task) => task.task_id === preferredTaskId)
      ? preferredTaskId
      : selectedSideTaskId.value && tasks.some((task) => task.task_id === selectedSideTaskId.value)
        ? selectedSideTaskId.value
        : tasks[0]?.task_id ?? null;
    if (selectedId) return await loadSideTaskDetail(selectedId);
    else {
      selectedSideTaskId.value = null;
      selectedSideTask.value = null;
      selectedSideTaskEvents.value = [];
      selectedSideTaskResult.value = null;
      selectedSideTaskDiff.value = null;
    }
    return true;
  } catch (err) {
    if (serial !== sideTasksRequestSerial) return false;
    // Keep the last trustworthy snapshot visible after a transient refresh failure.
    sideTasksError.value = sideTaskErrorText(err, "加载");
    return false;
  } finally {
    if (serial === sideTasksRequestSerial) sideTasksLoading.value = false;
  }
}

function stopSideTaskPolling(): void {
  sideTaskPoller?.stop();
  sideTaskPoller = null;
}

function syncSideTaskPolling(): void {
  stopSideTaskPolling();
  if (!shouldPollSideTasks(sideTasksOpen.value, sideTasks.value)) return;
  sideTaskPoller = createPoller(() => {
    if (!shouldPollSideTasks(sideTasksOpen.value, sideTasks.value)) return false;
    if (
      !sideTasksLoading.value
      && !sideTaskDetailLoading.value
      && !sideTasksOperating.value
      && !sideTaskMessaging.value
    ) {
      void loadSideTasks(selectedSideTaskId.value ?? undefined);
    }
  }, 3000);
}

watch(
  () => [sideTasksOpen.value, shouldPollSideTasks(sideTasksOpen.value, sideTasks.value)] as const,
  syncSideTaskPolling,
  { flush: "post" },
);

function openSideTasks(): void {
  if (!sideTasksEnabled.value) return;
  closeMaterials();
  recordsOpen.value = false;
  sideTasksOpen.value = true;
  if (sideTasks.value.length === 0 && !sideTasksLoading.value) void loadSideTasks();
}

function closeSideTasks(): void {
  sideTasksOpen.value = false;
  stopSideTaskPolling();
  sideTaskCreateAttempt = null;
  sideTaskAdoptionAttempt = null;
  sideTaskMessageAttempt = null;
  sideTaskMessageText.value = "";
  sideTaskMessageError.value = null;
}

function onSelectSideTask(taskId: string): void {
  sideTasksError.value = null;
  sideTaskAdoptionAttempt = null;
  sideTaskMessageAttempt = null;
  sideTaskMessageText.value = "";
  sideTaskMessageError.value = null;
  void loadSideTaskDetail(taskId);
}

function onCancelSideTaskCreate(): void {
  sideTaskCreateAttempt = null;
}

async function onCreateSideTask(request: CreateSideTaskRequest): Promise<void> {
  if (sideTasksOperating.value) return;
  const attempt = prepareSideTaskCreateAttempt(
    sideTaskCreateAttempt,
    request,
    () => crypto.randomUUID(),
  );
  sideTaskCreateAttempt = attempt;
  sideTasksOperating.value = true;
  sideTasksError.value = null;
  sideTasksNotice.value = null;
  let created: SideTaskSummary;
  try {
    created = await createSideTask(api, projectId, attempt.request, attempt.idempotencyKey);
  } catch (err) {
    // POST 失败时保留完整请求体和幂等键，原样重试。
    sideTasksError.value = sideTaskErrorText(err, "创建");
    sideTasksOperating.value = false;
    return;
  }

  // POST 已明确成功，此后的读取失败不能再表述为“创建失败”。
  sideTaskCreateAttempt = null;
  sideTasksNotice.value = "探索任务已在独立副本中创建；运行和结果不会改变主 Agent 或正式阶段。";
  try {
    const refreshed = await loadSideTasks(created.task_id);
    if (!refreshed) {
      sideTasksNotice.value = "探索任务已创建，但最新状态刷新失败；可点击刷新继续查看，不会重复创建。";
    }
    clearSideTasksNoticeLater();
  } catch {
    sideTasksError.value = "探索任务已创建，但最新状态刷新失败；请手动刷新继续查看。";
  } finally {
    sideTasksOperating.value = false;
  }
}

async function onAdoptSideTask(request: AdoptSideTaskRequest): Promise<void> {
  const taskId = selectedSideTaskId.value;
  if (!taskId || sideTasksOperating.value) return;
  const attempt = prepareSideTaskAdoptionAttempt(sideTaskAdoptionAttempt, taskId, request);
  sideTaskAdoptionAttempt = attempt;
  sideTasksOperating.value = true;
  sideTasksError.value = null;
  sideTasksNotice.value = null;
  let adopted: SideTaskAdoptionResult;
  try {
    adopted = await adoptSideTask(
      api,
      projectId,
      taskId,
      attempt.request,
      attempt.idempotencyKey,
    );
  } catch (err) {
    // POST 失败时保留完整请求体、adoption_id 和幂等键，原样重试。
    sideTasksError.value = sideTaskErrorText(err, "采纳");
    sideTasksOperating.value = false;
    return;
  }

  // POST 已明确成功，此后的读取失败不能再表述为“采纳失败”。
  sideTaskAdoptionAttempt = null;
  sideTasksNotice.value = `已人工采纳 ${adopted.adopted_paths.length} 个文件为候选修订；未选文件仍留在探索结果中。`;
  try {
    // 采纳只刷新 side task、产物与工作区；不触发主任务详情、SSE 或审批同步。
    const [sideRefreshed, artifactsRefresh, workspaceRefreshed] = await Promise.all([
      loadSideTasks(taskId),
      loadArtifactsAndRevisions().then(() => true, () => false),
      loadWorkspace(),
    ]);
    if (!sideRefreshed || !artifactsRefresh || !workspaceRefreshed) {
      sideTasksError.value = "采纳已成功，但部分页面数据刷新失败；请手动刷新确认最新候选修订。";
    }
    clearSideTasksNoticeLater();
  } catch {
    sideTasksError.value = "采纳已成功，但部分页面数据刷新失败；请手动刷新确认最新候选修订。";
  } finally {
    sideTasksOperating.value = false;
  }
}

async function onSendSideTaskMessage(textInput: string): Promise<void> {
  const taskId = selectedSideTaskId.value;
  const task = selectedSideTask.value;
  const text = textInput.trim();
  if (!taskId || !task || !text || sideTaskMessaging.value) return;
  if (task.status !== "running" && task.status !== "awaiting_user") {
    sideTaskMessageError.value = "当前探索任务已结束，不能继续补充消息。";
    return;
  }
  const attempt = sideTaskMessageAttempt?.taskId === taskId && sideTaskMessageAttempt.text === text
    ? sideTaskMessageAttempt
    : { taskId, text, key: crypto.randomUUID() };
  sideTaskMessageAttempt = attempt;
  sideTaskMessaging.value = true;
  sideTaskMessageError.value = null;
  try {
    await sendMessage(api, projectId, taskId, attempt.text, attempt.key);
    sideTaskMessageAttempt = null;
    sideTaskMessageText.value = "";
    sideTasksNotice.value = task.status === "awaiting_user"
      ? "补充信息已发送，探索任务将继续在隔离副本中运行。"
      : "纠偏信息已发送给当前探索任务。";
    await loadSideTasks(taskId);
    clearSideTasksNoticeLater();
  } catch (err) {
    sideTaskMessageError.value = humanizeDecisionError(err, "发送").text;
  } finally {
    sideTaskMessaging.value = false;
  }
}

onMounted(async () => {
  try {
    project.value = await getProject(api, projectId);
  } catch (err) {
    loadErrorText.value = humanizeLoadError(err);
  }
  await refresh();
  // 深链要在 refresh 之后：它需要 agents 已就绪才能找到在等这道门的那个 agent。
  const subId = route.query.sub;
  if (typeof subId === "string" && subId.length > 0) await openSubmissionDeepLink(subId);
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
  if (materialsNoticeTimer !== null) window.clearTimeout(materialsNoticeTimer);
  materialsNoticeTimer = null;
  if (sideTasksNoticeTimer !== null) window.clearTimeout(sideTasksNoticeTimer);
  sideTasksNoticeTimer = null;
  stopSideTaskPolling();
  sideTasksRequestSerial += 1;
  sideTaskDetailSerial += 1;
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
    `${(import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ""}/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(agentId)}/stream?from=turn`,
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
  streamFeed.value
    .filter((p): p is Extract<StreamFeedPart, { kind: "text" }> => p.kind === "text")
    .map((p) => ({ kind: "text" as const, id: p.id, role: "agent" as const, state: p.state, text: p.text, segments: null })),
);

/**
 * 一条 SSE 过程 part（思考/工具调用）→ SynthiaPart。
 *
 * 工具调用**同时**有 audit 来源（runtime 在工具结束时补一条预览记录），刷新后仍可
 * 回看；下面的 parts 合成按 id 去重。思考过程目前仍只有 SSE 这一路——上游网关不转
 * 发 reasoning_content，这条管线在生产里从未触发过，见 specs/agent-stream-benchmark.md
 * §1.3①。
 *
 * TODO(reasoning): 上面这条已拍板挂起（同文档 §4.1），留到多模型适配换上游时一并
 * 解决；管线刻意保留不删。改上游时按 `TODO(reasoning)` 搜索捞全三处改动点。
 */
function toProcessPart(p: StreamFeedPart): SynthiaPart | null {
  if (p.kind === "reasoning") return { kind: "reasoning", id: p.id, state: p.state, text: p.text };
  if (p.kind === "tool") {
    return { kind: "agent_tool", id: p.id, state: p.state, name: p.name, args: p.args, result: p.result };
  }
  return null;
}

/**
 * 合成对话流：audit 物化（轮询，权威来源）+ SSE 流式增量（即时性），严格回合制、
 * 同文本去重（定稿事件与轮询 audit 的 free_agent_reply 同时到达时，以 audit 为
 * 权威内容、但沿用 SSE part 的 id 以复用 DOM，避免重复渲染同一条回复）。
 *
 * 过程卡（思考/工具）按流内真实时序插到「它之后第一条已定稿文本」之前，而不是
 * 统一堆到流尾——堆尾读起来会变成「先给出答案、再去调工具」，与实际发生顺序相反。
 */
const parts = computed<readonly SynthiaPart[]>(() => {
  // 定稿流式文本 → id 列表（按流内先后）。一个流 id 只能被一条 audit 回复认领：
  // 两轮回复文本完全一致时（「查一下 X 的状态」这类问句极常见），若按文本取同一个
  // id，两条 audit 回复会拿到同一个 id——:key 撞车，锚在该 id 上的过程卡也跟着
  // 渲染两遍。
  const twinIds = new Map<string, string[]>();
  for (const s of streamFeed.value) {
    if (s.kind !== "text" || s.state !== "done") continue;
    const key = s.text.trim();
    const ids = twinIds.get(key);
    if (ids) ids.push(s.id);
    else twinIds.set(key, [s.id]);
  }
  const liveOnes = streamingTextParts.value.filter((p) => p.state === "streaming");
  // 从后往前认领：流里只有最近若干轮，最新的流 id 属于最新的那条 audit 回复。
  const settled: SynthiaPart[] = [...auditParts.value];
  for (let i = settled.length - 1; i >= 0; i--) {
    const p = settled[i]!;
    if (p.kind !== "text" || p.role !== "agent" || p.state !== "done") continue;
    const twinId = twinIds.get(p.text.trim())?.pop();
    if (twinId) settled[i] = { ...p, id: twinId };
  }

  // 过程卡按流内顺序攒堆，遇到已定稿文本就锚定在它之前。
  // 工具卡两边都有（audit 一条预览 + SSE 一张实时卡，同一个 callId）：位置以 audit
  // 为准（它带真实 seq，不必靠锚点猜），内容以 SSE 为准（audit 那份是截断预览）。
  const settledIds = new Set(settled.map((p) => p.id));
  const anchored = new Map<string, SynthiaPart[]>();
  let pending: SynthiaPart[] = [];
  for (const p of streamFeed.value) {
    const processPart = toProcessPart(p);
    if (processPart) {
      const at = processPart.kind === "agent_tool" ? settled.findIndex((s) => s.id === processPart.id) : -1;
      if (at >= 0) settled[at] = processPart; // audit 已收录 → 原地换成更全的那份，不再入流
      else pending.push(processPart);
    } else if (p.state === "done" && pending.length > 0) {
      anchored.set(p.id, pending);
      pending = [];
    }
  }

  const out: SynthiaPart[] = [];
  for (const p of settled) {
    const before = anchored.get(p.id);
    if (before) out.push(...before);
    // 产物卡在这里补上一版修订 id（版本链只有 fileTreeEntries 有，auditToParts 填不了）。
    out.push(p.kind === "doc" ? { ...p, prevRevisionId: prevRevisionIdOf(p.doc) } : p);
  }
  // 锚点还没被轮询到的（audit 落后于流），先落尾，下一次轮询到齐后自动归位。
  for (const [id, before] of anchored) {
    if (!settledIds.has(id)) out.push(...before);
  }
  // pending 是本轮尚未跟上文本的过程卡（正在思考 / 工具正在跑），永远在流尾。
  out.push(...pending, ...liveOnes);
  return out;
});

// ─────────────────────────────────────────────────────────────────────
// 文件树统一视图模型（artifact ↔ TaskDocRef 关联，见契约 FileTreeEntry 注释）
// ─────────────────────────────────────────────────────────────────────

const fileTreeEntries = computed<FileTreeEntry[]>(() =>
  buildFileTreeEntries(artifacts.value, revisionsByArtifact.value, detail.value?.docs ?? [], workspace.value?.files ?? []),
);

/**
 * 对话流产物卡的「上一版」修订 id：非 null 时卡上出现「查看改动」，点了跳中栏 diff。
 * 版本链只有 fileTreeEntries 有，`auditToParts` 填不了（audit 里只有当时登记的那一版）。
 *
 * 写成函数声明（会提升）故意放在 fileTreeEntries 之后：上面的 parts 计算调用它，
 * 但函数体只在 parts 求值时才跑，那时 fileTreeEntries 已经初始化了。
 */
function prevRevisionIdOf(doc: TaskDocRef): string | null {
  const entry = fileTreeEntries.value.find((e) => e.artifactId === doc.artifact_id);
  return entry ? prevRevisionId(entry, doc.revision_id) : null;
}

const hasAgent = computed(() => agents.value.length > 0);

// ─────────────────────────────────────────────────────────────────────
// 中栏：当前打开的文件 / 版本 / 内容 / 只读态
// ─────────────────────────────────────────────────────────────────────

const openArtifactId = ref<string | null>(null);
const openRevisionId = ref<string | null>(null);
const fileContent = ref<string | null>(null);
const fileContentLoading = ref(false);
/** 编辑器里这份正文是从哪儿取的，见契约 CodeEditorProps.contentSource。 */
const contentSource = ref<"workspace" | "revision">("revision");
const saving = ref(false);
const saveError = ref<string | null>(null);
const diffAgainst = ref<CodeEditorProps["diffAgainst"]>(null);

const openFileEntry = computed<FileTreeEntry | null>(
  () => (openArtifactId.value ? fileTreeEntries.value.find((e) => e.artifactId === openArtifactId.value) ?? null : null),
);

const activeRevision = computed<ArtifactRevision | null>(() => {
  const entry = openFileEntry.value;
  if (!entry) return null;
  return entry.revisions.find((r) => r.id === openRevisionId.value) ?? entry.latestRevision;
});

/**
 * 只读原因（spec §3.3 三态表 + D19）：已批准 > agent 运行中 > 没有可写的目标。
 *
 * 后两条是新增的、也是最容易被忽略的：**保存只能写工作区文件**。流水线产出的
 * `art-*` 从没落过盘（status 为 null），历史版本的正文也不是盘上那份字节——这两种
 * 情况下放开编辑，用户敲下的字没有任何地方可去，比直接说只读更伤人。
 */
const readonlyReason = computed<EditorReadonlyReason>(() => {
  const entry = openFileEntry.value;
  if (!entry) return null;
  return deriveReadonlyReason(
    {
      revisionState: activeRevision.value?.state ?? null,
      agentStatus: detail.value?.status ?? null,
      inWorkspace: entry.status !== null,
      contentSource: contentSource.value,
    },
    isTerminalStatus,
  );
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
    contentSource.value = "revision";
  } catch (err) {
    fileContent.value = null;
    loadErrorText.value = humanizeLoadError(err);
  } finally {
    fileContentLoading.value = false;
  }
}

/** 读工作区**当前**字节（含还没登记的改动）——文件树点开一个盘上文件走这条路。 */
async function loadWorkspaceContent(path: string): Promise<void> {
  fileContentLoading.value = true;
  try {
    const res = await getWorkspaceFile(api, projectId, path);
    fileContent.value = res.content;
    contentSource.value = "workspace";
  } catch (err) {
    fileContent.value = null;
    loadErrorText.value = humanizeLoadError(err);
  } finally {
    fileContentLoading.value = false;
  }
}

/**
 * 打开文件。默认打开的是**盘上那份**，不是最新那版修订——文件树上标着「已改动」的
 * 行点进来却看见登记在册的旧内容，是在骗人。只有盘上没有这个文件（流水线产出的
 * `art-*`）时才退回读修订。
 *
 * `revisionId` 传了就是钉版本：审批快照钉的是提交那一刻的修订，对话流产物卡钉的是
 * agent 登记那一刻，两者都必须绕开工作区当前字节。传了但在版本列表里找不到（历史
 * 版本已被清理）时回落最新版，总比什么都不打开强。
 */
function openFile(artifactId: string, revisionId?: string): void {
  const entry = fileTreeEntries.value.find((e) => e.artifactId === artifactId);
  if (!entry) return;
  const target = pickRevision(entry, revisionId);
  openArtifactId.value = artifactId;
  openRevisionId.value = target?.id ?? null;
  diffAgainst.value = null;
  saveError.value = null;

  if (!revisionId && entry.status !== null && entry.path) {
    void loadWorkspaceContent(entry.path);
    return;
  }
  if (!target) {
    // 盘上没有、也没有任何修订：`buildFileTreeEntries` 不会造出这样的条目，走到这里
    // 说明数据在两次刷新之间变了。空着比显示上一个文件的正文诚实。
    fileContent.value = null;
    contentSource.value = "revision";
    return;
  }
  void loadRevisionContent(artifactId, target.id);
}

function onSelectRevision(revisionId: string): void {
  if (!openArtifactId.value) return;
  openRevisionId.value = revisionId;
  diffAgainst.value = null;
  saveError.value = null;
  void loadRevisionContent(openArtifactId.value, revisionId);
}

/**
 * 进 diff 模式：head 装进编辑器，base 作为对照。两处调用——版本条上手选两版、
 * 对话流产物卡上的「查看改动」——共用这一份，保证两条路进来的 diff 完全一致。
 */
async function compareRevisions(entry: FileTreeEntry, baseRevisionId: string, headRevisionId: string): Promise<void> {
  const base = entry.revisions.find((r) => r.id === baseRevisionId);
  const head = entry.revisions.find((r) => r.id === headRevisionId);
  if (!base || !head) return;
  openArtifactId.value = entry.artifactId;
  openRevisionId.value = head.id;
  fileContentLoading.value = true;
  try {
    const [baseRes, headRes] = await Promise.all([
      getRevisionContent(api, projectId, entry.artifactId, base.id),
      getRevisionContent(api, projectId, entry.artifactId, head.id),
    ]);
    fileContent.value = headRes.content;
    contentSource.value = "revision";
    diffAgainst.value = { base, baseContent: baseRes.content, head };
  } catch (err) {
    loadErrorText.value = humanizeLoadError(err);
  } finally {
    fileContentLoading.value = false;
  }
}

async function onCompareRevisions(baseRevisionId: string, headRevisionId: string): Promise<void> {
  const entry = openFileEntry.value;
  if (!entry) return;
  await compareRevisions(entry, baseRevisionId, headRevisionId);
}

function onExitDiff(): void {
  diffAgainst.value = null;
}

// ─────────────────────────────────────────────────────────────────────
// 工作区写回与一键登记（内容归 git，治理状态归 PG）
// ─────────────────────────────────────────────────────────────────────

/**
 * 编辑器保存：写回工作区文件，**只落盘不 commit**。
 *
 * 成功后把服务端确认的字节回填进 fileContent——不是多此一举：CodeEditor 靠「盘上
 * 这份与编辑器里这份相同」来放下未保存标记，不回填的话保存按钮会一直亮着。随后刷新
 * 工作区树，让顶栏的待登记计数与这一行的角标跟上。
 */
async function onSave(content: string): Promise<void> {
  const entry = openFileEntry.value;
  if (!entry?.path || saving.value) return;
  saving.value = true;
  saveError.value = null;
  try {
    await putWorkspaceFile(api, projectId, entry.path, content);
    fileContent.value = content;
    contentSource.value = "workspace";
    await loadWorkspace();
  } catch (err) {
    saveError.value = humanizeLoadError(err);
  } finally {
    saving.value = false;
  }
}

const registering = ref(false);
const registerError = ref<string | null>(null);
/**
 * 上一次失败的登记尝试。重试时沿用同一个幂等键：第一次请求可能其实在服务端成功了、
 * 只是响应没回来，换个新键重试就会变成第二次真登记。说明改了则视为另一次登记。
 */
let registerAttempt: { readonly reason: string; readonly key: string } | null = null;

/**
 * 一键登记：把工作区当前全部待登记改动收进**一个** commit，并逐个出候选修订。
 *
 * 登记会改变产物与版本，所以走整轮 refresh 而不只是刷工作区树——新出的修订要进版本
 * 下拉，未登记的行要变成真产物行。
 */
async function onRegister(changeReason: string): Promise<void> {
  if (registering.value) return;
  registering.value = true;
  registerError.value = null;
  const attempt = registerAttempt?.reason === changeReason ? registerAttempt : { reason: changeReason, key: crypto.randomUUID() };
  registerAttempt = attempt;
  try {
    await registerWorkspace(api, projectId, changeReason, attempt.key);
    registerAttempt = null;
    await refresh();
    // 登记不改盘上的字节，但打开的那份从「未登记改动」变成了某一版修订——重开一次让
    // 版本条、只读态、以及未登记文件的合成 id 一起归位。
    if (openArtifactId.value) reopenAfterRegister(openArtifactId.value);
  } catch (err) {
    registerError.value = humanizeLoadError(err);
  } finally {
    registering.value = false;
  }
}

/**
 * 登记后重开当前文件。未登记的行 id 是合成的 `ws:<path>`（见 domain/file-tree.ts），
 * 登记之后它换成了真 artifact id，原来那个 id 在树里已经不存在——按路径找回来。
 */
function reopenAfterRegister(previousId: string): void {
  if (fileTreeEntries.value.some((e) => e.artifactId === previousId)) {
    openFile(previousId);
    return;
  }
  const path = workspaceEntryPath(previousId);
  const moved = path ? fileTreeEntries.value.find((e) => e.path === path) : undefined;
  if (moved) openFile(moved.artifactId);
}

// ─────────────────────────────────────────────────────────────────────
// 顶栏：阶段链 / 当前 run / 任务切换 / 阶段点击联动左栏
// ─────────────────────────────────────────────────────────────────────

const isGjbReferenceProject = computed(() => {
  const value = project.value;
  if (!value || projectType(value) !== "engineering") return false;
  return (value.process_profile_id ?? value.process_version_id) === "GJB_REF_V1";
});
const stageChain = computed(() =>
  detail.value && isGjbReferenceProject.value ? deriveStageChain(detail.value) : null,
);
const stageEmptyText = computed(() => {
  const value = project.value;
  if (!value) return "加载项目…";
  if (projectType(value) === "free") return "自由项目 · 无固定阶段";
  if (!isGjbReferenceProject.value) return "兼容旧流程 · 无新版阶段链";
  const gate = value.process_instances[0]?.current_gate;
  return gate === "G0" ? "G0 · 项目准备" : "尚无任务";
});
const projectTypeLabel = computed(() => (project.value ? projectTypeText(projectType(project.value)) : ""));
const projectProfileLabel = computed(() =>
  project.value && projectType(project.value) === "engineering" ? processVersionText(project.value) : "—",
);
const currentAgent = computed<TaskAgentSummary | null>(() => agents.value.find((r) => r.agent_id === currentAgentId.value) ?? null);

const viewMode = ref<FileTreeViewMode>("path");
const focusStageId = ref<string | null>(null);

function onSelectAgent(agentId: string): void {
  if (agentId === currentAgentId.value) return;
  if (resolveMainTaskId(agentId, agents.value) !== agentId) return;
  currentAgentId.value = agentId;
  detail.value = null;
  openArtifactId.value = null;
  openRevisionId.value = null;
  fileContent.value = null;
  diffAgainst.value = null;
  clearApproval(); // 审批卡是「当前 agent 的当前门」，切 agent 必须整块作废
  void refresh();
}

/**
 * 任务切换器里的「开始新对话」。已有 agent 全部卡在终态/锁死时（如门禁被拒后
 * 硬锁、或批准状态没被session 感知到），这是唯一能继续工作的出口——旧 agent
 * 不受影响，仍留在切换器里可选回去，不是丢弃或撤销它们。
 */
function onNewAgent(): void {
  if (projectType(project.value ?? {}) === "engineering" && agents.value.length > 0) {
    sendError.value = "工程项目只有一个主 Agent；需要并行试验时，请使用顶部的“探索任务”入口。";
    return;
  }
  currentAgentId.value = null;
  detail.value = null;
  openArtifactId.value = null;
  openRevisionId.value = null;
  fileContent.value = null;
  diffAgainst.value = null;
  clearApproval();
  forceNewTask.value = true;
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
  if (agents.value.length === 0 || forceNewTask.value) return "new-task";
  if (detail.value?.status === "running") return "steer";
  return "prompt";
});
const canAbort = computed(() => detail.value?.status === "running");
const sending = ref(false);
const sendError = ref<string | null>(null);
let createMainTaskAttempt: { readonly text: string; readonly key: string } | null = null;
let mainTaskMessageAttempt: { readonly taskId: string; readonly text: string; readonly key: string } | null = null;
let mainTaskAbortAttempt: TaskAbortAttempt | null = null;

watch(currentAgentId, (agentId) => {
  if (mainTaskAbortAttempt && mainTaskAbortAttempt.taskId !== agentId) {
    mainTaskAbortAttempt = null;
  }
});

async function onSend(text: string): Promise<void> {
  if (sending.value) return;
  sending.value = true;
  sendError.value = null;
  try {
    if (composerMode.value === "new-task") {
      if (projectType(project.value ?? {}) === "engineering" && agents.value.length > 0) {
        sendError.value = "工程项目只有一个主 Agent；需要并行试验时，请使用顶部的“探索任务”入口。";
        return;
      }
      const attempt = createMainTaskAttempt?.text === text
        ? createMainTaskAttempt
        : { text, key: crypto.randomUUID() };
      createMainTaskAttempt = attempt;
      const { agentId } = await createTask(api, projectId, { task: attempt.text, mode: "agent" }, attempt.key);
      createMainTaskAttempt = null;
      currentAgentId.value = agentId;
      forceNewTask.value = false;
    } else if (currentAgentId.value) {
      const attempt = mainTaskMessageAttempt?.taskId === currentAgentId.value
        && mainTaskMessageAttempt.text === text
        ? mainTaskMessageAttempt
        : { taskId: currentAgentId.value, text, key: crypto.randomUUID() };
      mainTaskMessageAttempt = attempt;
      await sendMessage(api, projectId, attempt.taskId, attempt.text, attempt.key);
      mainTaskMessageAttempt = null;
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
    const attempt = prepareTaskAbortAttempt(mainTaskAbortAttempt, currentAgentId.value);
    mainTaskAbortAttempt = attempt;
    await abortAgent(api, projectId, attempt.taskId, attempt.idempotencyKey);
    mainTaskAbortAttempt = null;
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
  closeSideTasks();
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
// 就地审批（spec §3.5 step 6）：提交拉取 / 待审产物 / 批准 / 驳回
// ─────────────────────────────────────────────────────────────────────

const submission = ref<GateSubmissionDetail | null>(null);
const approvalMembers = ref<readonly ApprovalMember[] | null>(null);
const approvalMembersError = ref<string | null>(null);
const deciding = ref(false);
const decisionError = ref<DecisionFailure | null>(null);
const rejectionReason = ref<string | null>(null);
/**
 * 深链（`?sub=`）进来、但项目里没有任何 agent 在等这道门时为 true。
 *
 * 正常路径的可见性由 run 状态决定（`deriveApprovalCard`）；可 agent 会话是会丢的
 * （runtime 重启、任务被终止），而服务端那条提交仍然 in_review、仍然可以批。此时
 * 若还按 run 判定就会把卡藏了，用户从待办点进来看到一片空白。这个标记让它退化成
 * 按提交自身状态推导。
 */
const approvalOrphan = ref(false);

/**
 * 一次决策尝试 = 幂等键 **加** 请求体，两者必须一起冻住。
 *
 * `buildApproveBody` 里带了 `signed_at: new Date()` 和 `makeBaselineId(gate, Date.now())`
 * 两个时间戳，重试时重新组装会得到不同的 canonicalRequestHash；服务端对「同键异体」
 * 是直接 409 IDEMPOTENCY_CONFLICT（core/src/services/approval.ts），于是一次本可安全
 * 重放的重试反倒变成硬失败。只提键不冻体等于没做幂等。
 */
interface ApproveAttempt {
  readonly subId: string;
  readonly key: string;
  readonly body: ApproveRequest;
}
interface RejectAttempt {
  readonly subId: string;
  readonly key: string;
  readonly reason: string;
}
let approveAttempt: ApproveAttempt | null = null;
let rejectAttempt: RejectAttempt | null = null;

function clearApproval(): void {
  submission.value = null;
  approvalMembers.value = null;
  approvalMembersError.value = null;
  decisionError.value = null;
  rejectionReason.value = null;
  approvalOrphan.value = false;
  approveAttempt = null;
  rejectAttempt = null;
}

/** 待审产物 = 快照成员修订。失败只写 membersError，不挡审批按钮出现。 */
async function loadApprovalMembers(sub: GateSubmissionDetail): Promise<void> {
  try {
    const members = await resolveSnapshotMembers(api, projectId, sub.snapshot_id);
    if (submission.value?.id !== sub.id) return; // 期间换了提交，旧请求的结果作废
    approvalMembers.value = members ?? [];
    approvalMembersError.value = members === null ? "未能读取本次提交的产物清单。" : null;
  } catch (err) {
    if (submission.value?.id !== sub.id) return;
    approvalMembers.value = [];
    approvalMembersError.value = humanizeLoadError(err);
  }
}

/** 拉取/切换当前待批提交。判据见 `shouldFetchSubmission`（稳定等待期间不重复请求）。 */
async function syncApproval(): Promise<void> {
  const run = detail.value;
  if (!shouldFetchSubmission(run, submission.value)) return;
  try {
    const subs = await listGateSubmissions(api, projectId, "in_review");
    const found = findApprovalSubmission(subs, run!.awaiting_gate!);
    if (!found || submission.value?.id === found.id) return;
    const full = await getGateSubmission(api, projectId, found.id);
    clearApproval(); // 换了一条提交 → 上一条的幂等尝试与错误提示全部作废
    submission.value = full;
    void loadApprovalMembers(full);
  } catch (err) {
    approvalMembersError.value = humanizeLoadError(err);
  }
}

/**
 * `?sub=` 深链：旧的 `/approvals/:projectId/:subId` 重定向过来时走这里（router.ts）。
 *
 * 直接取该提交，并把当前 agent 切到 `awaiting_gate` 与之匹配的那个——否则从待办点
 * 进来会停在默认（最新）agent 上，要批的那张卡根本不在当前上下文里。找不到对应
 * agent（会话已结束/丢失）时标记为孤儿，由 `approvalCardProps` 退化成按提交状态渲染。
 *
 * 只在挂载时跑一次：之后的可见性交给 `syncApproval` + `deriveApprovalCard`。
 */
async function openSubmissionDeepLink(subId: string): Promise<void> {
  try {
    const full = await getGateSubmission(api, projectId, subId);
    const owner = agents.value.find((a) => a.status === "awaiting_approval" && a.awaiting_gate === full.gate);
    if (owner && owner.agent_id !== currentAgentId.value) {
      currentAgentId.value = owner.agent_id;
      detail.value = await getTask(api, projectId, owner.agent_id);
    }
    clearApproval();
    submission.value = full;
    approvalOrphan.value = !owner;
    if (full.state === "rejected") rejectionReason.value = await loadRejectionReason(api, projectId, subId);
    void loadApprovalMembers(full);
  } catch (err) {
    loadErrorText.value = humanizeLoadError(err);
  }
}

/**
 * 决策成功后重新拉一遍提交。
 *
 * 必须拉：本地那份 `state` 还停在 in_review，而 run 已经离开 awaiting_approval，
 * `deriveApprovalCard` 会把这种组合判成 hidden——刚点完批准，卡片当场消失。
 * 拉到 approved/rejected 后它才会渲染成已决卡留在对话里。
 *
 * 不调 resume：runtime 的监视循环发现提交转 approved 会自己 resume
 * （runtime/server.ts），UI 再插一脚只会重复触发。
 */
async function afterDecision(subId: string): Promise<void> {
  try {
    const fresh = await getGateSubmission(api, projectId, subId);
    submission.value = fresh;
    rejectionReason.value = fresh.state === "rejected" ? await loadRejectionReason(api, projectId, subId) : null;
  } catch {
    // 决策本身已成功，回显失败不该报错吓人——下一轮轮询会纠正。
  }
  await refresh();
}

async function onApprove(): Promise<void> {
  const sub = submission.value;
  if (!sub || deciding.value) return;
  deciding.value = true;
  decisionError.value = null;
  try {
    if (!shouldReuseApproveAttempt(approveAttempt, sub.id)) {
      approveAttempt = { subId: sub.id, key: crypto.randomUUID(), body: await buildApproveBody(sub) };
    }
    await approveGateSubmission(api, projectId, sub.id, approveAttempt.body, approveAttempt.key);
    approveAttempt = null;
    await afterDecision(sub.id);
  } catch (err) {
    decisionError.value = humanizeDecisionError(err, "批准");
  } finally {
    deciding.value = false;
  }
}

async function onReject(reason: string): Promise<void> {
  const sub = submission.value;
  if (!sub || deciding.value) return;
  deciding.value = true;
  decisionError.value = null;
  try {
    // 理由进请求体、参与 requestHash：改了理由就必须重铸键，否则同键异体 409。
    if (!shouldReuseRejectAttempt(rejectAttempt, sub.id, reason)) {
      rejectAttempt = { subId: sub.id, key: crypto.randomUUID(), reason };
    }
    await rejectGateSubmission(api, projectId, sub.id, rejectAttempt.reason, rejectAttempt.key);
    rejectAttempt = null;
    await afterDecision(sub.id);
  } catch (err) {
    decisionError.value = humanizeDecisionError(err, "驳回");
  } finally {
    deciding.value = false;
  }
}

const approvalCardProps = computed<ApprovalCardProps | null>(() => {
  const sub = submission.value;
  if (!sub) return null;
  const run = detail.value;
  // 正常路径按 run 状态推导可见性；深链孤儿退化成按提交自身状态推导（见 approvalOrphan）。
  const state = approvalOrphan.value
    ? deriveApprovalCard({ status: "awaiting_approval", awaiting_gate: sub.gate }, sub)
    : run
      ? deriveApprovalCard(run, sub)
      : "hidden";
  if (state === "hidden") return null;
  return {
    state,
    gate: sub.gate,
    review: GATE_REVIEW_NAMES[sub.gate as GateId] ?? sub.gate,
    members: approvalMembers.value,
    membersError: approvalMembersError.value,
    submittedAt: sub.submitted_at,
    deciding: deciding.value,
    decisionError: decisionError.value,
    rejectionReason: rejectionReason.value,
  };
});

// ─────────────────────────────────────────────────────────────────────
// 栏位 props（对齐 project-view-contract.ts，编译期校验字段齐全）
// ─────────────────────────────────────────────────────────────────────

const topBarProps = computed<TopBarProps>(() => ({
  projectName: project.value?.name ?? "",
  stageChain: stageChain.value,
  stageEmptyText: stageEmptyText.value,
  currentAgent: currentAgent.value,
  agents: agents.value,
  allowNewAgent: projectType(project.value ?? {}) === "free" || !agents.value.some((task) => (
    !isTerminalStatus(task.status)
    && task.status !== "cancelled"
    && task.status !== "aborted"
  )),
  theme: theme.value,
  treeDrawerOpen: treeDrawerOpen.value,
  chatOverlayOpen: chatOverlayOpen.value,
}));

const fileTreeProps = computed<FileTreeProps>(() => ({
  entries: fileTreeEntries.value,
  documentContext: isGjbReferenceProject.value ? "gjb" : "generic",
  viewMode: viewMode.value,
  hasAgent: hasAgent.value,
  openArtifactId: openArtifactId.value,
  drawerMode: leftCollapsed.value,
  focusStageId: focusStageId.value,
  pendingCount: workspace.value?.pending_count ?? 0,
  registering: registering.value,
  registerError: registerError.value,
}));

const codeEditorProps = computed<CodeEditorProps>(() => ({
  file: openFileEntry.value,
  activeRevision: activeRevision.value,
  content: fileContent.value,
  contentSource: contentSource.value,
  loading: fileContentLoading.value,
  readonlyReason: readonlyReason.value,
  saving: saving.value,
  saveError: saveError.value,
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
  approval: approvalCardProps.value,
}));

const recordsPanelProps = computed<RecordsPanelProps>(() => ({
  open: recordsOpen.value,
  jobs: recordJobs.value,
  focusJobId: recordsFocusJobId.value,
  entryContent: recordEntryContent.value,
}));

const historicalMaterialsProps = computed(() => ({
  open: materialsOpen.value,
  snapshots: materialSnapshots.value,
  selectedSnapshotId: materialSelectedId.value,
  selectedSnapshot: materialSelected.value,
  searchResults: materialSearchResults.value,
  searchQuery: materialSearchQuery.value,
  loading: materialsLoading.value,
  searching: materialsSearching.value,
  operating: materialsOperating.value,
  error: materialsError.value,
  notice: materialsNotice.value,
  projectEligible: project.value?.project_type === "engineering",
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

function onOpenDoc(artifactId: string, revisionId?: string): void {
  openFile(artifactId, revisionId);
  chatOverlayOpen.value = false;
}

/**
 * 对话流产物卡的「查看改动」：这一版 vs 它的上一版，直接开中栏 Monaco 的 diff。
 * base 在这里现算（而不是让卡片带过来）——版本链在 fileTreeEntries 上，卡片只知道
 * 自己是哪一版。算不出前驱（首版/版本已被清理）时退化成普通打开，不空转。
 */
function onOpenDiff(artifactId: string, revisionId: string): void {
  chatOverlayOpen.value = false;
  const entry = fileTreeEntries.value.find((e) => e.artifactId === artifactId);
  if (!entry) return;
  const base = prevRevisionId(entry, revisionId);
  if (!base) {
    openFile(artifactId, revisionId);
    return;
  }
  void compareRevisions(entry, base, revisionId);
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
        @new-agent="onNewAgent"
        @select-stage="onSelectStage"
        @toggle-theme="onToggleTheme"
        @toggle-tree-drawer="onToggleTreeDrawer"
        @toggle-chat-overlay="onToggleChatOverlay"
        @logout="onLogout"
      />
    </header>
    <div v-if="project" class="project-view-meta" aria-label="项目类型与流程版本">
      <span>{{ projectTypeLabel }}</span>
      <span v-if="projectType(project) === 'engineering'">流程：{{ projectProfileLabel }}</span>
      <span v-if="project.target_part">器件：{{ project.target_part }}</span>
      <div v-if="sideTasksEnabled || historicalMaterialsEnabled" class="project-view-meta-actions">
        <button
          v-if="sideTasksEnabled"
          type="button"
          class="project-view-side-tasks-button"
          :aria-expanded="sideTasksOpen"
          @click="sideTasksOpen ? closeSideTasks() : openSideTasks()"
        >
          探索任务
          <span v-if="sideTasks.length > 0" class="project-view-materials-count">{{ sideTasks.length }}</span>
        </button>
        <button
          v-if="historicalMaterialsEnabled"
          type="button"
          class="project-view-materials-button"
          :aria-expanded="materialsOpen"
          @click="materialsOpen ? closeMaterials() : openMaterials()"
        >
          历史资料
          <span v-if="materialSnapshots.length > 0" class="project-view-materials-count">{{ materialSnapshots.length }}</span>
        </button>
      </div>
    </div>

    <div v-if="loadErrorText" class="project-view-error">{{ loadErrorText }}</div>

    <Splitter
      class="project-view-body"
      storage-key="synthia.splitter"
      :left-collapsed="leftCollapsed"
      :right-collapsed="rightCollapsed"
    >
      <template #left>
        <FileTree
          v-bind="fileTreeProps"
          @update:viewMode="onUpdateViewMode"
          @open-file="onOpenFile"
          @close-drawer="onCloseDrawer"
          @register="onRegister"
        />
      </template>
      <template #center>
        <CodeEditor
          v-bind="codeEditorProps"
          @select-revision="onSelectRevision"
          @compare-revisions="onCompareRevisions"
          @exit-diff="onExitDiff"
          @save="onSave"
        />
      </template>
      <template #right>
        <ChatFeed
          v-bind="chatFeedProps"
          @send="onSend"
          @abort="onAbort"
          @open-doc="onOpenDoc"
          @open-diff="onOpenDiff"
          @open-records="onOpenRecords"
          @approve="onApprove"
          @reject="onReject"
        />
      </template>
    </Splitter>

    <!-- <1024px：文件树抽屉化（spec R3），与 Splitter 内的左栏互斥渲染 -->
    <Transition name="project-view-veil-fade">
      <div v-if="leftCollapsed && treeDrawerOpen" class="project-view-veil" @click.self="onCloseDrawer">
        <div class="project-view-drawer">
          <FileTree
            v-bind="fileTreeProps"
            @update:viewMode="onUpdateViewMode"
            @open-file="onOpenFile"
            @close-drawer="onCloseDrawer"
            @register="onRegister"
          />
        </div>
      </div>
    </Transition>

    <!-- <1280px：对话栏浮层化（spec R3），与 Splitter 内的右栏互斥渲染 -->
    <Transition name="project-view-veil-fade">
      <div v-if="rightCollapsed && chatOverlayOpen" class="project-view-veil project-view-veil-end" @click.self="onToggleChatOverlay">
        <div class="project-view-overlay">
          <ChatFeed
            v-bind="chatFeedProps"
            @send="onSend"
            @abort="onAbort"
            @open-doc="onOpenDoc"
            @open-diff="onOpenDiff"
            @open-records="onOpenRecords"
            @approve="onApprove"
            @reject="onReject"
          />
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

    <Transition name="project-view-veil-fade">
      <div v-if="historicalMaterialsEnabled && materialsOpen" class="project-view-veil project-view-veil-end" @click.self="closeMaterials">
        <HistoricalMaterialsPanel
          v-bind="historicalMaterialsProps"
          @close="closeMaterials"
          @refresh="loadMaterials"
          @select-snapshot="onSelectMaterialSnapshot"
          @search="onSearchMaterials"
          @import="onImportMaterials"
          @confirm="onConfirmMaterials"
          @deny="onDenyMaterials"
          @copy="onCopyMaterials"
        />
      </div>
    </Transition>

    <Transition name="project-view-veil-fade">
      <div v-if="sideTasksEnabled && sideTasksOpen" class="project-view-veil project-view-veil-end" @click.self="closeSideTasks">
        <SideTasksPanel
          :open="sideTasksOpen"
          :tasks="sideTasks"
          :selected-task-id="selectedSideTaskId"
          :selected-task="selectedSideTask"
          :result="selectedSideTaskResult"
          :diff="selectedSideTaskDiff"
          :events="selectedSideTaskEvents"
          :parent-task-id="sideTaskParent?.task_id ?? sideTaskParent?.agent_id ?? null"
          :base-commit="sideTaskBaseCommit"
          :loading="sideTasksLoading"
          :detail-loading="sideTaskDetailLoading"
          :operating="sideTasksOperating"
          :messaging="sideTaskMessaging"
          :message-text="sideTaskMessageText"
          :message-error="sideTaskMessageError"
          :error="sideTasksError"
          :notice="sideTasksNotice"
          @close="closeSideTasks"
          @refresh="loadSideTasks()"
          @select-task="onSelectSideTask"
          @create="onCreateSideTask"
          @cancel-create="onCancelSideTaskCreate"
          @adopt="onAdoptSideTask"
          @update:message-text="sideTaskMessageText = $event"
          @send-message="onSendSideTaskMessage"
        />
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

.project-view-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
  min-height: 28px;
  padding: 0 var(--space-4);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  border-bottom: 1px solid var(--border-subtle);
}

.project-view-meta-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}

.project-view-materials-button,
.project-view-side-tasks-button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  padding: 2px var(--space-2);
  font-size: var(--font-size-sm);
}

.project-view-materials-button:hover,
.project-view-side-tasks-button:hover {
  background: var(--accent-subtle);
}

.project-view-materials-count {
  color: var(--text-secondary);
  font-size: 11px;
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
