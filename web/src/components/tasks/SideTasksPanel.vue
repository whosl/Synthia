<script setup lang="ts">
import { computed, ref } from "vue";
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
  canInspectSideTaskResult,
  sideTaskEventText,
} from "../../domain/side-tasks.ts";
import { formatDateTime } from "../../util/format-time.ts";
import Badge from "../ui/AppBadge.vue";
import Button from "../ui/AppButton.vue";
import { Textarea } from "../ui/textarea";
import SideTaskDiffCard from "./SideTaskDiffCard.vue";

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
  /** Kept for the ProjectView call-site contract; the panel always renders embedded in the right Agent pane. */
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

const objective = ref("");
const writePathsText = ref("rtl/pwm_gen.v");
const createError = ref<string | null>(null);

const createDraft = computed(() => buildCreateSideTaskRequest({
  parentTaskId: props.parentTaskId,
  objective: objective.value,
  baseCommit: props.baseCommit,
  writePathsText: writePathsText.value,
}));

const visibleConversationEvents = computed(() => props.events.flatMap((event) => {
  const text = sideTaskEventText(event);
  return text === null ? [] : [{ event, text }];
}));

function submitCreate(): void {
  createError.value = null;
  const parsed = createDraft.value;
  if (!parsed.ok) {
    createError.value = parsed.message;
    return;
  }
  emit("create", parsed.request);
}

function shortCommit(value: string | null): string {
  return value ? value.slice(0, 10) : "—";
}
</script>

<template>
  <aside
    v-if="open"
    class="flex h-full min-h-0 w-full min-w-0 flex-col bg-panel text-fg"
    :class="createOnly ? 'overflow-y-auto' : ''"
    role="region"
    aria-label="探索任务"
  >
    <div
      v-if="error"
      class="mx-5 mt-3 flex items-center justify-between gap-3 rounded-md bg-danger/12 p-3 text-xs text-danger"
      role="alert"
    >
      <span>{{ error }}</span>
      <Button variant="secondary" size="sm" @click="emit('refresh')">重试</Button>
    </div>

    <section v-if="createOnly" class="flex-none p-4">
      <div>
        <strong class="block">添加 Side Agent</strong>
        <small v-if="baseCommit" class="mt-[2px] block text-fg-secondary">绑定主工作区 {{ shortCommit(baseCommit) }}</small>
        <small v-else class="mt-[2px] block text-fg-secondary">缺少可信 Git HEAD，创建已禁用</small>
      </div>

      <form class="mt-3 grid grid-cols-1 gap-3 rounded-md border border-line bg-base p-3" @submit.prevent="submitCreate">
        <label class="flex flex-col gap-1 text-xs text-fg-secondary">
          <span>探索目标</span>
          <Textarea
            v-model="objective"
            class="resize-y"
            rows="3"
            maxlength="2000"
            placeholder="例如：比较两种流水线结构，不改动正式主线"
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-fg-secondary">
          <span>允许写入的精确路径</span>
          <Textarea
            v-model="writePathsText"
            class="resize-y font-mono text-[12.5px]"
            rows="3"
            spellcheck="false"
            placeholder="rtl/pipeline.v&#10;tb/pipeline_tb.sv"
          />
          <small class="text-fg-muted">每行一个文件，最多 32 个；单条最多 512 个 UTF-8 字节、32 层，仅允许 rtl/、tb/、doc/、prj/constr/。doc/ 不得放 HDL，不接受目录或通配符。</small>
        </label>
        <p v-if="createError" class="m-0 text-xs text-danger" role="alert">{{ createError }}</p>
        <div class="flex items-center justify-between gap-3 text-xs text-fg-muted max-[720px]:flex-col max-[720px]:items-start">
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

    <div v-if="!createOnly" class="grid min-h-0 flex-1 grid-cols-1">
      <section class="min-h-0 overflow-y-auto p-3" aria-live="polite">
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
                <time class="text-xs text-fg-muted" :datetime="entry.event.created_at">{{ formatDateTime(entry.event.created_at) }}</time>
              </li>
            </ol>
            <form
              v-if="selectedTask.status === 'awaiting_user' || selectedTask.status === 'running'"
              class="mt-3 grid gap-2"
              @submit.prevent="emit('send-message', messageText)"
            >
              <label class="grid gap-1">
                <span>{{ selectedTask.status === "awaiting_user" ? "补充信息" : "纠偏探索方向" }}</span>
                <Textarea
                  :model-value="messageText"
                  rows="2"
                  maxlength="4000"
                  :disabled="messaging"
                  placeholder="回复 Agent 的问题，或补充本次探索的约束"
                  @update:model-value="emit('update:message-text', $event ?? '')"
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

            <SideTaskDiffCard :diff="diff" :operating="operating" @adopt="emit('adopt', $event)" />
          </template>
        </template>
      </section>
    </div>
  </aside>
</template>
