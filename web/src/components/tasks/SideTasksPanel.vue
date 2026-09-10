<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  AdoptSideTaskRequest,
  CreateSideTaskRequest,
  SideTaskConversationEvent,
  SideTaskDiff,
  SideTaskResult,
  SideTaskSummary,
} from "../../api/types.ts";
import {
  SIDE_TASK_ADOPTION_TEXT,
  SIDE_TASK_STATUS_TEXT,
  SIDE_TASK_STATUS_TONE,
  buildCreateSideTaskRequest,
  buildSideTaskAdoptionRequest,
  canInspectSideTaskResult,
  formatSideTaskHash,
  sideTaskEventText,
} from "../../domain/side-tasks.ts";
import Badge from "../ui/AppBadge.vue";
import Button from "../ui/AppButton.vue";

const props = defineProps<{
  open: boolean;
  tasks: readonly SideTaskSummary[];
  selectedTaskId: string | null;
  selectedTask: SideTaskSummary | null;
  result: SideTaskResult | null;
  diff: SideTaskDiff | null;
  events: readonly SideTaskConversationEvent[];
  parentTaskId: string | null;
  baseCommit: string | null;
  loading: boolean;
  detailLoading: boolean;
  operating: boolean;
  messaging: boolean;
  messageText: string;
  messageError: string | null;
  error: string | null;
  notice: string | null;
  /** Embedded mode lives inside the right Agent pane instead of a modal drawer. */
  embedded?: boolean;
  /** Render only the Side Agent creation form for the ＋ pane. */
  createOnly?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  refresh: [];
  "select-task": [taskId: string];
  create: [request: CreateSideTaskRequest];
  "cancel-create": [];
  adopt: [request: AdoptSideTaskRequest];
  "update:message-text": [text: string];
  "send-message": [text: string];
}>();

const panelElement = ref<HTMLElement | null>(null);
const createOpen = ref(false);
const objective = ref("");
const writePathsText = ref("rtl/pwm_gen.v");
const createError = ref<string | null>(null);
const adoptionReason = ref("");
const adoptionError = ref<string | null>(null);
const selectedPaths = ref<Set<string>>(new Set());
let returnFocus: HTMLElement | null = null;

const createDraft = computed(() => buildCreateSideTaskRequest({
  parentTaskId: props.parentTaskId,
  objective: objective.value,
  baseCommit: props.baseCommit,
  writePathsText: writePathsText.value,
}));

const selectableFiles = computed(() => props.diff?.files.filter(
  (file) => !file.adopted && file.conflict_reason === null,
) ?? []);

const visibleConversationEvents = computed(() => props.events.flatMap((event) => {
  const text = sideTaskEventText(event);
  return text === null ? [] : [{ event, text }];
}));

watch(
  () => props.diff?.preview_hash ?? null,
  () => {
    selectedPaths.value = new Set();
    adoptionReason.value = "";
    adoptionError.value = null;
  },
);

watch(
  () => props.selectedTaskId,
  () => {
    selectedPaths.value = new Set();
    adoptionReason.value = "";
    adoptionError.value = null;
  },
);

function submitCreate(): void {
  createError.value = null;
  const parsed = createDraft.value;
  if (!parsed.ok) {
    createError.value = parsed.message;
    return;
  }
  emit("create", parsed.request);
}

function toggleCreate(): void {
  createOpen.value = !createOpen.value;
  if (!createOpen.value) emit("cancel-create");
}

function togglePath(path: string): void {
  const file = props.diff?.files.find((candidate) => candidate.path === path);
  if (!file || file.adopted || file.conflict_reason !== null) return;
  const next = new Set(selectedPaths.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  selectedPaths.value = next;
}

function selectAllAvailable(): void {
  selectedPaths.value = new Set(selectableFiles.value.map((file) => file.path));
}

function submitAdoption(): void {
  adoptionError.value = null;
  if (!props.diff) {
    adoptionError.value = "差异预览尚未就绪，请刷新后重试。";
    return;
  }
  const parsed = buildSideTaskAdoptionRequest(
    props.diff,
    selectedPaths.value,
    adoptionReason.value,
    `adopt-${crypto.randomUUID()}`,
  );
  if (!parsed.ok) {
    adoptionError.value = parsed.message;
    return;
  }
  emit("adopt", parsed.request);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value;
}

function shortCommit(value: string | null): string {
  return value ? value.slice(0, 10) : "—";
}

onMounted(() => {
  if (props.embedded) return;
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  void nextTick(() => panelElement.value?.focus());
});

onBeforeUnmount(() => {
  if (props.embedded) return;
  returnFocus?.focus();
  returnFocus = null;
});
</script>

<template>
  <aside
    v-if="open"
    ref="panelElement"
    class="side-tasks-panel"
    :class="{ 'is-embedded': embedded, 'is-create-only': createOnly }"
    :role="embedded ? 'region' : 'dialog'"
    :aria-modal="embedded ? undefined : 'true'"
    aria-labelledby="side-tasks-title"
    tabindex="-1"
    @keydown.esc="embedded ? undefined : emit('close')"
  >
    <header v-if="!embedded" class="side-tasks-head">
      <div>
        <p class="side-tasks-kicker">P3 · 隔离探索</p>
        <h2 id="side-tasks-title">探索任务</h2>
        <p>在项目当前提交的独立副本里试验；结果默认未采纳，不改变主 Agent、阶段或审批。</p>
      </div>
      <Button variant="ghost" size="sm" aria-label="关闭探索任务" @click="emit('close')">关闭</Button>
    </header>

    <div v-if="error" class="side-tasks-alert is-error" role="alert">
      <span>{{ error }}</span>
      <Button variant="secondary" size="sm" @click="emit('refresh')">重试</Button>
    </div>
    <p v-if="notice" class="side-tasks-alert is-notice" role="status">{{ notice }}</p>

    <section v-if="createOnly || !embedded" class="side-create-section">
      <div class="side-create-toolbar">
        <div>
          <strong>{{ createOnly ? "添加 Side Agent" : "新建隔离探索" }}</strong>
          <small v-if="baseCommit">绑定主工作区 {{ shortCommit(baseCommit) }}</small>
          <small v-else class="is-danger">缺少可信 Git HEAD，创建已禁用</small>
        </div>
        <Button v-if="!createOnly" size="sm" :variant="createOpen ? 'ghost' : 'primary'" @click="toggleCreate">
          {{ createOpen ? "收起" : "新建探索" }}
        </Button>
      </div>

      <form v-if="createOnly || createOpen" class="side-create-form" @submit.prevent="submitCreate">
        <label>
          <span>探索目标</span>
          <textarea
            v-model="objective"
            rows="3"
            maxlength="2000"
            placeholder="例如：比较两种流水线结构，不改动正式主线"
          />
        </label>
        <label>
          <span>允许写入的精确路径</span>
          <textarea
            v-model="writePathsText"
            rows="3"
            spellcheck="false"
            placeholder="rtl/pipeline.v&#10;tb/pipeline_tb.sv"
          />
          <small>每行一个文件，最多 32 个；单条最多 512 个 UTF-8 字节、32 层，仅允许 rtl/、tb/、doc/、prj/constr/。doc/ 不得放 HDL，不接受目录或通配符。</small>
        </label>
        <p v-if="createError" class="side-inline-error" role="alert">{{ createError }}</p>
        <div class="side-create-actions">
          <span>父主任务：{{ parentTaskId ?? "不可用" }}</span>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            :disabled="!createDraft.ok || operating"
            :loading="operating"
          >
            创建隔离副本
          </Button>
        </div>
      </form>
    </section>

    <div v-if="!createOnly" class="side-tasks-body" :class="{ 'is-embedded': embedded }">
      <section v-if="!embedded" class="side-task-list-pane" aria-label="探索任务列表">
        <div class="side-pane-title">
          <strong>任务记录</strong>
          <Button variant="ghost" size="sm" :loading="loading" :disabled="loading" @click="emit('refresh')">刷新</Button>
        </div>
        <p v-if="loading && tasks.length === 0" class="side-empty">正在读取探索任务…</p>
        <p v-else-if="!loading && tasks.length === 0" class="side-empty">还没有探索任务。新建后会在独立工作区运行。</p>
        <ul v-else class="side-task-list">
          <li v-for="task in tasks" :key="task.task_id">
            <button
              type="button"
              class="side-task-row"
              :class="{ 'is-active': selectedTaskId === task.task_id }"
              @click="emit('select-task', task.task_id)"
            >
              <span class="side-task-row-main">
                <strong>{{ task.objective }}</strong>
                <small>{{ formatTime(task.created_at) }}</small>
              </span>
              <span class="side-task-row-badges">
                <Badge :tone="SIDE_TASK_STATUS_TONE[task.status]" size="sm">{{ SIDE_TASK_STATUS_TEXT[task.status] }}</Badge>
                <Badge v-if="task.status === 'succeeded'" :tone="task.adoption_state === 'available' ? 'warn' : 'neutral'" size="sm">
                  {{ SIDE_TASK_ADOPTION_TEXT[task.adoption_state] }}
                </Badge>
              </span>
            </button>
          </li>
        </ul>
      </section>

      <section class="side-task-detail-pane" aria-live="polite">
        <p v-if="!selectedTask" class="side-empty">选择一条任务查看结果与差异。</p>
        <template v-else>
          <header class="side-detail-head">
            <div>
              <h3>{{ selectedTask.objective }}</h3>
              <p>独立工作区 {{ selectedTask.workspace_id }} · 起点提交 {{ shortCommit(selectedTask.base_commit) }}</p>
            </div>
            <Badge :tone="SIDE_TASK_STATUS_TONE[selectedTask.status]">{{ SIDE_TASK_STATUS_TEXT[selectedTask.status] }}</Badge>
          </header>

          <p class="side-unadopted" :class="{ 'is-adopted': selectedTask.adoption_state === 'adopted' }">
            {{ SIDE_TASK_ADOPTION_TEXT[selectedTask.adoption_state] }}。未采纳的内容不会进入主工作区或正式阶段。
          </p>

          <section class="side-conversation" aria-label="探索任务对话">
            <div class="side-section-title">
              <div>
                <h4>探索对话</h4>
                <p>内容来自 Core 的持久化事件；刷新或 Runtime 重启后仍可查看。</p>
              </div>
            </div>
            <p v-if="visibleConversationEvents.length === 0" class="side-empty">还没有可显示的对话事件。</p>
            <ol v-else class="side-conversation-list">
              <li
                v-for="entry in visibleConversationEvents"
                :key="entry.event.id"
                :class="`is-${entry.event.event_kind}`"
              >
                <span>{{ entry.event.event_kind === "user_message" ? "你" : entry.event.event_kind === "assistant_message" ? "探索 Agent" : "状态" }}</span>
                <p>{{ entry.text }}</p>
                <time :datetime="entry.event.created_at">{{ formatTime(entry.event.created_at) }}</time>
              </li>
            </ol>
            <form
              v-if="selectedTask.status === 'awaiting_user' || selectedTask.status === 'running'"
              class="side-message-form"
              @submit.prevent="emit('send-message', messageText)"
            >
              <label>
                <span>{{ selectedTask.status === "awaiting_user" ? "补充信息" : "纠偏探索方向" }}</span>
                <textarea
                  :value="messageText"
                  rows="2"
                  maxlength="4000"
                  :disabled="messaging"
                  placeholder="回复 Agent 的问题，或补充本次探索的约束"
                  @input="emit('update:message-text', ($event.target as HTMLTextAreaElement).value)"
                />
              </label>
              <p v-if="messageError" class="side-inline-error" role="alert">{{ messageError }}</p>
              <div class="side-message-actions">
                <small>只影响当前隔离任务，不会切换主对话或正式阶段。</small>
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  :disabled="!messageText.trim() || messaging"
                  :loading="messaging"
                >
                  {{ selectedTask.status === "awaiting_user" ? "发送并继续探索" : "发送纠偏" }}
                </Button>
              </div>
            </form>
          </section>

          <div v-if="selectedTask.failure_reason" class="side-failure" role="status">
            <strong>本次探索未产生可采纳结果</strong>
            <p>{{ selectedTask.failure_reason }}</p>
          </div>
          <p v-else-if="!canInspectSideTaskResult(selectedTask)" class="side-empty">
            {{ selectedTask.status === "running" || selectedTask.status === "queued" ? "探索仍在隔离工作区运行，面板会自动刷新状态。" : selectedTask.status === "awaiting_user" ? "探索正在等待补充输入，面板会自动刷新状态。" : "当前没有可检查的密封结果。" }}
          </p>
          <p v-else-if="detailLoading" class="side-empty">正在校验密封结果与当前主线差异…</p>

          <template v-else-if="result && diff">
            <section class="side-result-card">
              <div class="side-section-title">
                <h4>结果摘要</h4>
                <Badge tone="neutral" size="sm">{{ result.files.length }} 个文件</Badge>
              </div>
              <p>{{ result.summary }}</p>
              <ul class="side-tests">
                <li v-for="test in result.tests" :key="`${test.name}:${test.status}`">
                  <Badge :tone="test.status === 'passed' ? 'ok' : test.status === 'failed' ? 'danger' : 'neutral'" size="sm">
                    {{ test.status }}
                  </Badge>
                  <span>{{ test.name }}</span>
                  <small v-if="test.detail">{{ test.detail }}</small>
                </li>
              </ul>
            </section>

            <section class="side-diff-section">
              <div class="side-section-title">
                <div>
                  <h4>文本差异</h4>
                  <p>仅选择无冲突、未采纳的文件。任一选中文件冲突时整批不会写入。</p>
                </div>
                <button type="button" class="side-link-button" @click="selectAllAvailable">选择全部可采纳</button>
              </div>

              <article v-for="file in diff.files" :key="file.path" class="side-diff-file">
                <header>
                  <label>
                    <input
                      type="checkbox"
                      :checked="selectedPaths.has(file.path)"
                      :disabled="file.adopted || file.conflict_reason !== null || operating"
                      @change="togglePath(file.path)"
                    />
                    <code>{{ file.path }}</code>
                  </label>
                  <span class="side-file-state">
                    <Badge v-if="file.adopted" tone="neutral" size="sm">已采纳</Badge>
                    <Badge v-else-if="file.conflict_reason" tone="danger" size="sm">有冲突</Badge>
                    <Badge v-else tone="ok" size="sm">可采纳</Badge>
                    <Badge tone="neutral" size="sm">{{ file.change_kind === "added" ? "新增" : "修改" }}</Badge>
                  </span>
                </header>
                <dl class="side-file-hashes">
                  <div>
                    <dt>探索起点哈希</dt>
                    <dd><code>{{ formatSideTaskHash(file.base_hash) }}</code></dd>
                  </div>
                  <div>
                    <dt>候选内容哈希</dt>
                    <dd><code>{{ formatSideTaskHash(file.result_hash) }}</code></dd>
                  </div>
                  <div>
                    <dt>当前主线哈希</dt>
                    <dd><code>{{ formatSideTaskHash(file.current_target_hash) }}</code></dd>
                  </div>
                </dl>
                <p v-if="file.conflict_reason" class="side-conflict">{{ file.conflict_reason }} 此文件不会被选入采纳。</p>
                <pre><code>{{ file.diff }}</code></pre>
              </article>

              <div class="side-adoption-box">
                <label>
                  <span>人工采纳理由</span>
                  <textarea
                    v-model="adoptionReason"
                    rows="2"
                    maxlength="1000"
                    :disabled="operating"
                    placeholder="说明为什么把这些探索结果带回主工作区"
                  />
                </label>
                <p v-if="adoptionError" class="side-inline-error" role="alert">{{ adoptionError }}</p>
                <div class="side-adoption-actions">
                  <span>已选择 {{ selectedPaths.size }} / {{ selectableFiles.length }} 个可采纳文件</span>
                  <Button
                    variant="primary"
                    size="sm"
                    :disabled="selectedPaths.size === 0 || !adoptionReason.trim() || operating"
                    :loading="operating"
                    @click="submitAdoption"
                  >
                    确认人工采纳
                  </Button>
                </div>
              </div>
            </section>
          </template>
        </template>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.side-tasks-panel {
  display: flex;
  flex-direction: column;
  width: min(900px, 98vw);
  height: 100%;
  min-height: 0;
  background: var(--surface-panel);
  color: var(--text-primary);
  box-shadow: 0 0 24px var(--shadow-color);
}

.side-tasks-panel.is-embedded {
  width: 100%;
  min-width: 0;
  box-shadow: none;
}

.side-tasks-panel.is-create-only {
  overflow-y: auto;
}

.side-tasks-head,
.side-create-toolbar,
.side-pane-title,
.side-detail-head,
.side-section-title,
.side-diff-file > header,
.side-create-actions,
.side-adoption-actions,
.side-message-actions,
.side-tasks-alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.side-conversation {
  margin: var(--space-4) 0;
  padding: var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--surface-hover);
}

.side-conversation-list {
  display: grid;
  gap: var(--space-2);
  max-height: 260px;
  margin: var(--space-3) 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}

.side-conversation-list li {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--surface-panel);
}

.side-conversation-list li > span,
.side-conversation-list time {
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.side-conversation-list p {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.side-conversation-list .is-user_message {
  border-inline-start: 3px solid var(--accent);
}

.side-message-form {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.side-message-form label {
  display: grid;
  gap: var(--space-1);
}

.side-message-actions {
  align-items: center;
}

.side-tasks-head {
  align-items: flex-start;
  padding: var(--space-5);
  border-bottom: 1px solid var(--border-subtle);
}

.side-tasks-head h2,
.side-detail-head h3,
.side-section-title h4 {
  margin: 0;
}

.side-tasks-kicker {
  margin: 0 0 var(--space-1);
  color: var(--accent);
  font-size: var(--font-size-sm);
  font-weight: 600;
  letter-spacing: 0.04em;
}

.side-tasks-head p:last-child,
.side-detail-head p,
.side-section-title p {
  margin: var(--space-1) 0 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.side-tasks-alert {
  margin: var(--space-3) var(--space-5) 0;
  padding: var(--space-3);
  border-radius: var(--radius);
  font-size: var(--font-size-sm);
}

.side-tasks-alert.is-error,
.side-inline-error,
.side-conflict,
.is-danger {
  color: var(--state-danger);
}

.side-tasks-alert.is-error {
  background: color-mix(in srgb, var(--state-danger) 12%, transparent);
}

.side-tasks-alert.is-notice {
  display: block;
  background: color-mix(in srgb, var(--state-ok) 12%, transparent);
  color: var(--state-ok);
}

.side-create-section {
  flex: none;
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--border-subtle);
}

.side-create-toolbar small,
.side-create-toolbar strong {
  display: block;
}

.side-create-toolbar small {
  margin-top: 2px;
  color: var(--text-secondary);
}

.side-create-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--surface-base);
}

.side-create-form label,
.side-adoption-box label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.side-create-form textarea,
.side-adoption-box textarea {
  width: 100%;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-panel);
  color: var(--text-primary);
  font: inherit;
  padding: var(--space-2);
  resize: vertical;
}

.side-create-form label:nth-child(2) textarea,
.side-diff-file code {
  font-family: var(--font-mono);
  font-size: var(--font-size-code);
}

.side-create-form label small {
  color: var(--text-muted);
}

.side-create-actions,
.side-inline-error {
  grid-column: 1 / -1;
}

.side-create-actions {
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.side-inline-error {
  margin: 0;
  font-size: var(--font-size-sm);
}

.side-tasks-body {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}

.side-tasks-body.is-embedded {
  grid-template-columns: minmax(0, 1fr);
}

.side-tasks-panel.is-embedded .side-task-detail-pane {
  padding: var(--space-3);
}

.side-tasks-panel.is-create-only .side-create-section {
  border-bottom: 0;
  padding: var(--space-4);
}

.side-tasks-panel.is-create-only .side-create-form {
  grid-template-columns: 1fr;
}

.side-tasks-panel.is-create-only .side-create-actions,
.side-tasks-panel.is-create-only .side-inline-error {
  grid-column: auto;
}

.side-task-list-pane,
.side-task-detail-pane {
  min-height: 0;
  overflow-y: auto;
}

.side-task-list-pane {
  border-right: 1px solid var(--border-subtle);
  padding: var(--space-3);
}

.side-pane-title {
  margin-bottom: var(--space-2);
}

.side-task-list {
  display: grid;
  gap: var(--space-1);
  list-style: none;
  margin: 0;
  padding: 0;
}

.side-task-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: var(--space-2);
  text-align: left;
}

.side-task-row:hover,
.side-task-row.is-active {
  border-color: var(--border-subtle);
  background: var(--surface-hover);
}

.side-task-row-main,
.side-task-row-main strong,
.side-task-row-main small {
  display: block;
  min-width: 0;
}

.side-task-row-main strong {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.side-task-row-main small {
  margin-top: var(--space-1);
  color: var(--text-muted);
}

.side-task-row-badges,
.side-file-state {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.side-task-detail-pane {
  padding: var(--space-4) var(--space-5) var(--space-6);
}

.side-detail-head {
  align-items: flex-start;
}

.side-detail-head h3 {
  font-size: var(--font-size-lg);
}

.side-unadopted,
.side-failure,
.side-result-card,
.side-adoption-box {
  margin: var(--space-3) 0 0;
  padding: var(--space-3);
  border-radius: var(--radius);
}

.side-unadopted {
  background: color-mix(in srgb, var(--state-warn) 13%, transparent);
  color: var(--state-warn);
  font-size: var(--font-size-sm);
}

.side-unadopted.is-adopted {
  background: color-mix(in srgb, var(--state-ok) 13%, transparent);
  color: var(--state-ok);
}

.side-failure {
  background: color-mix(in srgb, var(--state-danger) 12%, transparent);
  color: var(--state-danger);
}

.side-failure p,
.side-result-card > p {
  margin: var(--space-1) 0 0;
}

.side-result-card,
.side-adoption-box {
  background: var(--surface-hover);
}

.side-tests {
  display: grid;
  gap: var(--space-1);
  list-style: none;
  margin: var(--space-3) 0 0;
  padding: 0;
}

.side-tests li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.side-tests small {
  color: var(--text-muted);
}

.side-diff-section {
  margin-top: var(--space-5);
}

.side-section-title {
  align-items: flex-end;
}

.side-link-button {
  flex: none;
  border: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  font-size: var(--font-size-sm);
}

.side-diff-file {
  margin-top: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  overflow: hidden;
}

.side-diff-file > header {
  padding: var(--space-2) var(--space-3);
  background: var(--surface-hover);
}

.side-diff-file > header label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.side-diff-file > header code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.side-conflict {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--state-danger) 9%, transparent);
  font-size: var(--font-size-sm);
}

.side-file-hashes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border-subtle);
  background: var(--surface-base);
}

.side-file-hashes div {
  min-width: 0;
}

.side-file-hashes dt {
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.side-file-hashes dd {
  margin: 2px 0 0;
}

.side-file-hashes code {
  overflow-wrap: anywhere;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-size-code);
}

.side-diff-file pre {
  max-height: 260px;
  margin: 0;
  overflow: auto;
  background: var(--surface-base);
  color: var(--text-primary);
  padding: var(--space-3);
  white-space: pre;
}

.side-diff-file pre code {
  font-family: var(--font-mono);
  font-size: var(--font-size-code);
  line-height: var(--line-height-code);
}

.side-adoption-actions {
  margin-top: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.side-empty {
  margin: var(--space-4) 0;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  text-align: center;
}

@media (max-width: 720px) {
  .side-tasks-panel {
    width: 100vw;
  }

  .side-tasks-panel.is-embedded {
    width: 100%;
  }

  .side-tasks-head,
  .side-create-section,
  .side-task-detail-pane {
    padding-inline: var(--space-3);
  }

  .side-create-form,
  .side-tasks-body,
  .side-file-hashes {
    grid-template-columns: 1fr;
  }

  .side-task-list-pane {
    max-height: 190px;
    border-right: 0;
    border-bottom: 1px solid var(--border-subtle);
  }

  .side-create-actions,
  .side-inline-error {
    grid-column: auto;
  }

  .side-create-actions,
  .side-adoption-actions,
  .side-diff-file > header {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
