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
    class="flex h-full min-h-0 flex-col bg-panel text-fg"
    :class="[
      embedded ? 'w-full min-w-0 shadow-none' : 'w-[min(900px,98vw)] shadow-[0_0_24px_var(--shadow-color)] max-[720px]:w-screen',
      createOnly ? 'overflow-y-auto' : '',
    ]"
    :role="embedded ? 'region' : 'dialog'"
    :aria-modal="embedded ? undefined : 'true'"
    aria-labelledby="side-tasks-title"
    tabindex="-1"
    @keydown.esc="embedded ? undefined : emit('close')"
  >
    <header v-if="!embedded" class="flex items-start justify-between gap-3 border-b border-line p-5 max-[720px]:px-3">
      <div>
        <p class="mt-0 mb-1 text-xs font-semibold tracking-[0.04em] text-brand">P3 · 隔离探索</p>
        <h2 id="side-tasks-title" class="m-0">探索任务</h2>
        <p class="mt-1 mb-0 text-xs text-fg-secondary">在项目当前提交的独立副本里试验；结果默认未采纳，不改变主 Agent、阶段或审批。</p>
      </div>
      <Button variant="ghost" size="sm" aria-label="关闭探索任务" @click="emit('close')">关闭</Button>
    </header>

    <div
      v-if="error"
      class="mx-5 mt-3 flex items-center justify-between gap-3 rounded-md bg-danger/12 p-3 text-xs text-danger"
      role="alert"
    >
      <span>{{ error }}</span>
      <Button variant="secondary" size="sm" @click="emit('refresh')">重试</Button>
    </div>

    <section
      v-if="createOnly || !embedded"
      class="flex-none"
      :class="createOnly ? 'p-4' : 'border-b border-line px-5 py-3 max-[720px]:px-3'"
    >
      <div class="flex items-center justify-between gap-3">
        <div>
          <strong class="block">{{ createOnly ? "添加 Side Agent" : "新建隔离探索" }}</strong>
          <small v-if="baseCommit" class="mt-[2px] block text-fg-secondary">绑定主工作区 {{ shortCommit(baseCommit) }}</small>
          <small v-else class="mt-[2px] block text-fg-secondary">缺少可信 Git HEAD，创建已禁用</small>
        </div>
        <Button v-if="!createOnly" size="sm" :variant="createOpen ? 'ghost' : 'primary'" @click="toggleCreate">
          {{ createOpen ? "收起" : "新建探索" }}
        </Button>
      </div>

      <form
        v-if="createOnly || createOpen"
        class="mt-3 grid gap-3 rounded-md border border-line bg-base p-3"
        :class="createOnly ? 'grid-cols-1' : 'grid-cols-2 max-[720px]:grid-cols-1'"
        @submit.prevent="submitCreate"
      >
        <label class="flex flex-col gap-1 text-xs text-fg-secondary">
          <span>探索目标</span>
          <textarea
            v-model="objective"
            class="w-full resize-y rounded-sm border border-line-strong bg-panel p-2 text-fg"
            rows="3"
            maxlength="2000"
            placeholder="例如：比较两种流水线结构，不改动正式主线"
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-fg-secondary">
          <span>允许写入的精确路径</span>
          <textarea
            v-model="writePathsText"
            class="w-full resize-y rounded-sm border border-line-strong bg-panel p-2 font-mono text-[12.5px] text-fg"
            rows="3"
            spellcheck="false"
            placeholder="rtl/pipeline.v&#10;tb/pipeline_tb.sv"
          />
          <small class="text-fg-muted">每行一个文件，最多 32 个；单条最多 512 个 UTF-8 字节、32 层，仅允许 rtl/、tb/、doc/、prj/constr/。doc/ 不得放 HDL，不接受目录或通配符。</small>
        </label>
        <p v-if="createError" class="col-span-full m-0 text-xs text-danger max-[720px]:col-auto" role="alert">{{ createError }}</p>
        <div
          class="col-span-full flex items-center justify-between gap-3 text-xs text-fg-muted max-[720px]:col-auto max-[720px]:flex-col max-[720px]:items-start"
        >
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

    <div
      v-if="!createOnly"
      class="grid min-h-0 flex-1"
      :class="embedded ? 'grid-cols-1' : 'grid-cols-[260px_minmax(0,1fr)] max-[720px]:grid-cols-1'"
    >
      <section
        v-if="!embedded"
        class="min-h-0 overflow-y-auto border-r border-line p-3 max-[720px]:max-h-[190px] max-[720px]:border-r-0 max-[720px]:border-b"
        aria-label="探索任务列表"
      >
        <div class="mb-2 flex items-center justify-between gap-3">
          <strong>任务记录</strong>
          <Button variant="ghost" size="sm" :loading="loading" :disabled="loading" @click="emit('refresh')">刷新</Button>
        </div>
        <p v-if="loading && tasks.length === 0" class="my-4 text-center text-xs text-fg-muted">正在读取探索任务…</p>
        <p v-else-if="!loading && tasks.length === 0" class="my-4 text-center text-xs text-fg-muted">还没有探索任务。新建后会在独立工作区运行。</p>
        <ul v-else class="m-0 grid list-none gap-1 p-0">
          <li v-for="task in tasks" :key="task.task_id">
            <button
              type="button"
              class="flex w-full cursor-pointer flex-col gap-2 rounded-md border bg-transparent p-2 text-left"
              :class="selectedTaskId === task.task_id ? 'border-line bg-hover' : 'border-transparent hover:border-line hover:bg-hover'"
              @click="emit('select-task', task.task_id)"
            >
              <span class="block min-w-0">
                <strong class="min-w-0 line-clamp-2">{{ task.objective }}</strong>
                <small class="mt-1 block min-w-0 text-fg-muted">{{ formatTime(task.created_at) }}</small>
              </span>
              <span class="flex flex-wrap gap-1">
                <Badge :tone="SIDE_TASK_STATUS_TONE[task.status]" size="sm">{{ SIDE_TASK_STATUS_TEXT[task.status] }}</Badge>
                <Badge v-if="task.status === 'succeeded'" :tone="task.adoption_state === 'available' ? 'warn' : 'neutral'" size="sm">
                  {{ SIDE_TASK_ADOPTION_TEXT[task.adoption_state] }}
                </Badge>
              </span>
            </button>
          </li>
        </ul>
      </section>

      <section
        class="min-h-0 overflow-y-auto"
        :class="embedded ? 'p-3' : 'px-5 pt-4 pb-6 max-[720px]:px-3'"
        aria-live="polite"
      >
        <p v-if="!selectedTask" class="my-4 text-center text-xs text-fg-muted">选择一条任务查看结果与差异。</p>
        <template v-else>
          <header class="flex items-start justify-between gap-3">
            <div>
              <h3 class="m-0 text-[15px]">{{ selectedTask.objective }}</h3>
              <p class="mt-1 mb-0 text-xs text-fg-secondary">独立工作区 {{ selectedTask.workspace_id }} · 起点提交 {{ shortCommit(selectedTask.base_commit) }}</p>
            </div>
            <Badge :tone="SIDE_TASK_STATUS_TONE[selectedTask.status]">{{ SIDE_TASK_STATUS_TEXT[selectedTask.status] }}</Badge>
          </header>

          <p
            class="mt-3 mb-0 rounded-md p-3 text-xs"
            :class="selectedTask.adoption_state === 'adopted' ? 'bg-ok/13 text-ok' : 'bg-warn/13 text-warn'"
          >
            {{ SIDE_TASK_ADOPTION_TEXT[selectedTask.adoption_state] }}。未采纳的内容不会进入主工作区或正式阶段。
          </p>

          <section class="my-4 rounded-md border border-line bg-hover p-4" aria-label="探索任务对话">
            <div class="flex items-end justify-between gap-3">
              <div>
                <h4 class="m-0">探索对话</h4>
                <p class="mt-1 mb-0 text-xs text-fg-secondary">内容来自 Core 的持久化事件；刷新或 Runtime 重启后仍可查看。</p>
              </div>
            </div>
            <p v-if="visibleConversationEvents.length === 0" class="my-4 text-center text-xs text-fg-muted">还没有可显示的对话事件。</p>
            <ol v-else class="my-3 grid max-h-[260px] list-none gap-2 overflow-auto p-0">
              <li
                v-for="entry in visibleConversationEvents"
                :key="entry.event.id"
                class="grid gap-1 rounded-sm bg-panel p-3"
                :class="entry.event.event_kind === 'user_message' ? 'border-s-[3px] border-brand' : ''"
              >
                <span class="text-xs text-fg-muted">{{ entry.event.event_kind === "user_message" ? "你" : entry.event.event_kind === "assistant_message" ? "探索 Agent" : "状态" }}</span>
                <p class="m-0 whitespace-pre-wrap wrap-anywhere">{{ entry.text }}</p>
                <time class="text-xs text-fg-muted" :datetime="entry.event.created_at">{{ formatTime(entry.event.created_at) }}</time>
              </li>
            </ol>
            <form
              v-if="selectedTask.status === 'awaiting_user' || selectedTask.status === 'running'"
              class="mt-3 grid gap-2"
              @submit.prevent="emit('send-message', messageText)"
            >
              <label class="grid gap-1">
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
              <p v-if="messageError" class="col-span-full m-0 text-xs text-danger max-[720px]:col-auto" role="alert">{{ messageError }}</p>
              <div class="flex items-center justify-between gap-3">
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

          <div v-if="selectedTask.failure_reason" class="mt-3 rounded-md bg-danger/12 p-3 text-danger" role="status">
            <strong>本次探索未产生可采纳结果</strong>
            <p class="mt-1 mb-0">{{ selectedTask.failure_reason }}</p>
          </div>
          <p v-else-if="!canInspectSideTaskResult(selectedTask)" class="my-4 text-center text-xs text-fg-muted">
            {{ selectedTask.status === "running" || selectedTask.status === "queued" ? "探索仍在隔离工作区运行，面板会自动刷新状态。" : selectedTask.status === "awaiting_user" ? "探索正在等待补充输入，面板会自动刷新状态。" : "当前没有可检查的密封结果。" }}
          </p>
          <p v-else-if="detailLoading" class="my-4 text-center text-xs text-fg-muted">正在校验密封结果与当前主线差异…</p>

          <template v-else-if="result && diff">
            <section class="mt-3 rounded-md bg-hover p-3">
              <div class="flex items-end justify-between gap-3">
                <h4 class="m-0">结果摘要</h4>
                <Badge tone="neutral" size="sm">{{ result.files.length }} 个文件</Badge>
              </div>
              <p class="mt-1 mb-0">{{ result.summary }}</p>
              <ul class="mt-3 mb-0 grid list-none gap-1 p-0">
                <li v-for="test in result.tests" :key="`${test.name}:${test.status}`" class="flex items-center gap-2">
                  <Badge :tone="test.status === 'passed' ? 'ok' : test.status === 'failed' ? 'danger' : 'neutral'" size="sm">
                    {{ test.status }}
                  </Badge>
                  <span>{{ test.name }}</span>
                  <small v-if="test.detail" class="text-fg-muted">{{ test.detail }}</small>
                </li>
              </ul>
            </section>

            <section class="mt-5">
              <div class="flex items-end justify-between gap-3">
                <div>
                  <h4 class="m-0">文本差异</h4>
                  <p class="mt-1 mb-0 text-xs text-fg-secondary">仅选择无冲突、未采纳的文件。任一选中文件冲突时整批不会写入。</p>
                </div>
                <button type="button" class="flex-none cursor-pointer border-0 bg-transparent p-0 text-xs text-brand" @click="selectAllAvailable">选择全部可采纳</button>
              </div>

              <article v-for="file in diff.files" :key="file.path" class="mt-3 overflow-hidden rounded-md border border-line">
                <header class="flex items-center justify-between gap-3 bg-hover px-3 py-2 max-[720px]:flex-col max-[720px]:items-start">
                  <label class="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      :checked="selectedPaths.has(file.path)"
                      :disabled="file.adopted || file.conflict_reason !== null || operating"
                      @change="togglePath(file.path)"
                    />
                    <code class="min-w-0 truncate">{{ file.path }}</code>
                  </label>
                  <span class="flex flex-wrap gap-1">
                    <Badge v-if="file.adopted" tone="neutral" size="sm">已采纳</Badge>
                    <Badge v-else-if="file.conflict_reason" tone="danger" size="sm">有冲突</Badge>
                    <Badge v-else tone="ok" size="sm">可采纳</Badge>
                    <Badge tone="neutral" size="sm">{{ file.change_kind === "added" ? "新增" : "修改" }}</Badge>
                  </span>
                </header>
                <dl class="m-0 grid grid-cols-3 gap-2 border-t border-line bg-base px-3 py-2 max-[720px]:grid-cols-1">
                  <div class="min-w-0">
                    <dt class="text-xs text-fg-muted">探索起点哈希</dt>
                    <dd class="m-0 mt-[2px]"><code class="wrap-anywhere text-fg-secondary">{{ formatSideTaskHash(file.base_hash) }}</code></dd>
                  </div>
                  <div class="min-w-0">
                    <dt class="text-xs text-fg-muted">候选内容哈希</dt>
                    <dd class="m-0 mt-[2px]"><code class="wrap-anywhere text-fg-secondary">{{ formatSideTaskHash(file.result_hash) }}</code></dd>
                  </div>
                  <div class="min-w-0">
                    <dt class="text-xs text-fg-muted">当前主线哈希</dt>
                    <dd class="m-0 mt-[2px]"><code class="wrap-anywhere text-fg-secondary">{{ formatSideTaskHash(file.current_target_hash) }}</code></dd>
                  </div>
                </dl>
                <p v-if="file.conflict_reason" class="m-0 bg-danger/9 px-3 py-2 text-xs text-danger">{{ file.conflict_reason }} 此文件不会被选入采纳。</p>
                <pre class="m-0 max-h-[260px] overflow-auto whitespace-pre bg-base p-3 text-fg"><code>{{ file.diff }}</code></pre>
              </article>

              <div class="mt-3 rounded-md bg-hover p-3">
                <label class="flex flex-col gap-1 text-xs text-fg-secondary">
                  <span>人工采纳理由</span>
                  <textarea
                    v-model="adoptionReason"
                    class="w-full resize-y rounded-sm border border-line-strong bg-panel p-2 text-fg"
                    rows="2"
                    maxlength="1000"
                    :disabled="operating"
                    placeholder="说明为什么把这些探索结果带回主工作区"
                  />
                </label>
                <p v-if="adoptionError" class="col-span-full m-0 text-xs text-danger max-[720px]:col-auto" role="alert">{{ adoptionError }}</p>
                <div class="mt-2 flex items-center justify-between gap-3 text-xs text-fg-secondary max-[720px]:flex-col max-[720px]:items-start">
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
