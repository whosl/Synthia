<script setup lang="ts">
/**
 * 右栏对话流（spec §3.5；流式与回合制排序的教训见 v3 `0b6444c`/`8b81173`，
 * 已下沉到 `domain/parts.ts`/`domain/task-stream.ts`，本组件只管按序渲染。
 *
 * 铁律：
 * - `parts` 已经是 ProjectView 按 turn 顺序合并去重后的权威数组，本组件绝不
 *   重新排序/分组（严格回合制）。**显示层折叠不算分组**：连续的工具/Agent 工具
 *   调用条目允许折叠成一个 `ToolActivityGroup`（`domain/chat-groups.ts`），
 *   组内条目顺序与原数组完全一致，只是默认收起已完成的工具噪音；
 * - 流式 token 级追加靠 `:key="item.part.id"` 复用 `MessageItem` 组件实例——
 *   part 内容变但 id 不变时 Vue 只更新该实例的 props，不会整量重渲染整个列表；
 *   折叠组的 key 取首条目 part.id，同组流式追加条目时 key 不变，契约不回归；
 * - 产物卡（`SynthiaDocPart`）点击一律 `open-doc`，在中栏编辑器打开，不弹抽屉；
 *   「查看改动」走 `open-diff`，同样交给中栏 Monaco，流内不渲染行级 diff。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { Sparkles, X } from "lucide-vue-next";
import { buildChatRenderItems, restoreFailedSendDraft } from "../../domain/composer.ts";
import { formatRelativeTime, groupToolActivity } from "../../domain/chat-groups.ts";
import type { GatePartState, SynthiaPart } from "../../domain/parts.ts";
import type { ChatFeedEmits, ChatFeedProps } from "../../views/project-view-contract.ts";
import { TASK_STATUS_TEXT } from "../../domain/tasks.ts";
import Button from "../ui/AppButton.vue";
import Badge from "../ui/AppBadge.vue";
import AgentToolItem from "./AgentToolItem.vue";
import ApprovalCard from "./ApprovalCard.vue";
import ChatComposer from "./ChatComposer.vue";
import CodeCard from "./CodeCard.vue";
import MessageItem from "./MessageItem.vue";
import ReasoningItem from "./ReasoningItem.vue";
import ToolActivityGroup from "./ToolActivityGroup.vue";
import ToolCallItem from "./ToolCallItem.vue";

const props = defineProps<ChatFeedProps>();
const emit = defineEmits<ChatFeedEmits>();

/** 插话消息配对识别（steer 打标），不改变 parts 顺序（见 domain/composer.ts）。 */
const renderItems = computed(() => buildChatRenderItems(props.parts));

/** 显示层折叠：极大连续工具条目段收成活动组（顺序不变，见 domain/chat-groups.ts）。 */
const feedRows = computed(() => groupToolActivity(renderItems.value));

/** 回合分隔线：每条 user 消息（含插话）前一条细线，流首条目不画。 */
function isTurnStart(part: SynthiaPart, rowIndex: number): boolean {
  return rowIndex > 0 && part.kind === "text" && part.role === "user";
}

/** 分隔线上的相对时间（part 无 ts → null，只画细线）。 */
function turnTimeText(part: SynthiaPart): string | null {
  return part.kind === "text" && part.ts ? formatRelativeTime(part.ts) : null;
}

const GATE_STATE_TEXT: Readonly<Record<GatePartState, string>> = {
  evaluating: "评审中",
  awaiting: "等待批准",
  passed: "已通过",
  failed: "未通过",
};
const GATE_STATE_TONE: Readonly<Record<GatePartState, "accent" | "warn" | "ok" | "danger">> = {
  evaluating: "accent",
  awaiting: "warn",
  passed: "ok",
  failed: "danger",
};

function shortHash(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 12)}…` : sha;
}

/**
 * 审批卡里的待审产物：必须把 revisionId 一并透传——快照钉的是提交那一刻的版本，
 * 丢了第二参就会按最新版打开，等于审了 agent 后来改过的内容。
 */
function onOpenApprovalDoc(artifactId: string, revisionId: string): void {
  emit("open-doc", artifactId, revisionId);
}

// ─── 输入草稿：项目按对话持有，组件独立使用时保留本地回退 ───────────────
const localDraft = ref("");
const draft = computed({
  get: () => props.draft ?? localDraft.value,
  set: (value: string) => { localDraft.value = value; emit("update:draft", value); },
});
let pendingSendText: string | null = null;

function fillExample(task: string): void {
  draft.value = task;
}

function onComposerSend(text: string): void {
  pendingSendText = text;
  emit("send", text);
}

watch(
  () => [props.sending, props.sendError] as const,
  ([sending, sendError]) => {
    if (sending || pendingSendText === null) return;
    draft.value = restoreFailedSendDraft(draft.value, pendingSendText, sendError);
    pendingSendText = null;
  },
);

// ─── 自动滚到底；用户手动上滚后不强拉，给「回到最新」按钮 ─────────────────
const scrollEl = ref<HTMLElement | null>(null);
const stickToBottom = ref(true);
const BOTTOM_THRESHOLD_PX = 48;

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
}

function onScroll(): void {
  const el = scrollEl.value;
  if (el) stickToBottom.value = isNearBottom(el);
}

function scrollToBottom(): void {
  const el = scrollEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  stickToBottom.value = true;
}

// parts 每次流式增量都会拿到新数组引用（ProjectView 的 computed），watch 因此
// 在 delta 级别持续触发；只有用户仍「贴底」时才跟着滚，避免打断手动翻阅。
watch(
  () => props.parts,
  () => {
    if (stickToBottom.value) void nextTick(scrollToBottom);
  },
);

onMounted(() => void nextTick(scrollToBottom));
</script>

<template>
  <div class="chat-feed flex h-full min-h-0 flex-col bg-panel">
    <div class="flex min-h-10 items-center justify-between gap-3 border-b border-line px-4 py-2"><span class="flex items-center gap-2 text-xs font-[550]"><Sparkles :size="16" class="text-brand" aria-hidden="true" />主 Agent</span><Badge v-if="agentStatus" :tone="agentStatus === 'running' ? 'accent' : 'neutral'" size="sm">{{ TASK_STATUS_TEXT[agentStatus] ?? agentStatus }}</Badge><Button v-if="closable" variant="ghost" size="sm" aria-label="关闭对话栏" @click="emit('close')"><X :size="16" /></Button></div>
    <div v-if="streamPhase === 'degraded'" class="flex-none bg-warn/14 px-3 py-1 text-center text-xs text-warn">实时连接中断，已切换定时刷新</div>
    <div v-else-if="streamPhase === 'connecting' && parts.length > 0" class="flex-none bg-hover px-3 py-1 text-center text-xs text-fg-muted">正在连接实时更新…</div>

    <div ref="scrollEl" class="min-h-0 flex-1 overflow-y-auto" @scroll="onScroll">
      <!--
        阅读列宽约束（720px）落在滚动容器内的一层：滚动条仍贴栏右缘，
        空态与所有 part 种类都坐在约束里（长行不顶满宽栏，扫视省力）。
        min-h-full 保证内容不足一屏时空态仍能 my-auto 垂直居中。
      -->
      <div class="mx-auto flex min-h-full w-full max-w-[720px] flex-col gap-3 p-3">
        <div v-if="renderItems.length === 0" class="my-auto flex flex-col items-center gap-2 px-4 py-6 text-center">
          <template v-if="composerMode === 'new-task'">
            <p class="m-0 text-[13px] font-semibold text-fg">开始你的第一个任务</p>
            <p class="m-0 max-w-[280px] text-xs leading-[1.4] text-fg-muted">描述要做什么，Agent 会从需求一路推进到产物；也可以直接点一个示例任务填入输入框</p>
            <div class="mt-2 flex w-full flex-col gap-2">
              <button v-for="task in exampleTasks" :key="task" type="button" class="cursor-pointer rounded-md border-none bg-hover px-3 py-2 text-left text-xs text-fg-secondary transition-colors duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-brand-subtle hover:text-fg" @click="fillExample(task)">
                {{ task }}
              </button>
            </div>
          </template>
          <template v-else-if="agentStatus === null">
            <p class="m-0 text-[13px] font-semibold text-fg">正在加载对话…</p>
          </template>
          <template v-else>
            <p class="m-0 text-[13px] font-semibold text-fg">暂无对话记录</p>
          </template>
        </div>

        <template v-else>
          <template v-for="(row, rowIndex) in feedRows" :key="row.id">
            <ToolActivityGroup
              v-if="row.kind === 'tool-group'"
              :group="row.group"
              @open-records="emit('open-records', $event)"
            />

            <template v-else>
              <div v-if="isTurnStart(row.item.part, rowIndex)" class="flex items-center gap-2" aria-hidden="true">
                <span class="h-px flex-1 bg-line"></span>
                <template v-if="turnTimeText(row.item.part)">
                  <span class="flex-none text-[11px] leading-none text-fg-muted">{{ turnTimeText(row.item.part) }}</span>
                  <span class="h-px flex-1 bg-line"></span>
                </template>
              </div>

              <MessageItem v-if="row.item.part.kind === 'text'" :part="row.item.part" :steer="row.item.steer" />

              <ToolCallItem v-else-if="row.item.part.kind === 'tool'" :part="row.item.part" @open-records="emit('open-records', $event)" />

              <ReasoningItem v-else-if="row.item.part.kind === 'reasoning'" :part="row.item.part" />

              <AgentToolItem v-else-if="row.item.part.kind === 'agent_tool'" :part="row.item.part" />

              <div v-else-if="row.item.part.kind === 'gate'" class="flex items-center gap-2 rounded-md bg-hover px-3 py-2">
                <span class="flex-none text-brand" aria-hidden="true">◆</span>
                <span class="min-w-0 flex-1 text-xs text-fg">{{ row.item.part.review }}</span>
                <Badge :tone="GATE_STATE_TONE[row.item.part.state]" size="sm">{{ GATE_STATE_TEXT[row.item.part.state] }}</Badge>
              </div>

              <CodeCard
                v-else-if="row.item.part.kind === 'doc'"
                :segment="null"
                :title="row.item.part.title"
                :artifact-id="row.item.part.doc.artifact_id"
                :diffable="row.item.part.prevRevisionId !== null"
                @open="emit('open-doc', row.item.part.doc.artifact_id, row.item.part.doc.revision_id)"
                @open-diff="emit('open-diff', row.item.part.doc.artifact_id, row.item.part.doc.revision_id)"
              />

              <button
                v-else-if="row.item.part.kind === 'evidence'"
                type="button"
                class="block w-full cursor-pointer rounded-sm border-none bg-transparent px-2 py-1 text-left text-xs text-fg-muted transition-colors duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-brand-subtle hover:text-fg"
                @click="emit('open-records', null)"
              >
                📎 生成了 {{ row.item.part.count }} 项证据 · 查看
              </button>

              <div v-else-if="row.item.part.kind === 'governance'" class="px-2 py-1 text-xs leading-[1.4] text-fg-muted">{{ row.item.part.text }}</div>

              <div v-else-if="row.item.part.kind === 'lifecycle'" class="flex gap-2 rounded-md p-3" :class="row.item.part.state === 'succeeded' ? 'bg-ok/12' : 'bg-danger/10'">
                <span class="flex-none text-[15px]" aria-hidden="true">{{ row.item.part.state === "succeeded" ? "🎉" : "⚠️" }}</span>
                <div class="flex min-w-0 flex-col gap-1">
                  <p class="m-0 text-[13px] font-semibold text-fg">{{ row.item.part.text }}</p>
                  <p v-if="row.item.part.bitstream" class="chat-feed-lifecycle-detail mono m-0 text-fg-secondary">
                    {{ row.item.part.bitstream.name }} · sha256:{{ shortHash(row.item.part.bitstream.sha256) }}
                  </p>
                  <p v-if="row.item.part.evidenceCount > 0" class="m-0 text-xs text-fg-secondary">证据链 {{ row.item.part.evidenceCount }} 项</p>
                </div>
              </div>

              <div v-else-if="row.item.part.kind === 'note'" class="rounded-sm bg-hover px-2 py-1 text-xs leading-[1.4]" :class="row.item.part.tone === 'warn' ? 'text-warn' : row.item.part.tone === 'error' ? 'text-danger' : 'text-fg-secondary'">{{ row.item.part.text }}</div>

              <div v-else-if="row.item.part.kind === 'interrupt'" class="px-2 py-1 text-xs leading-[1.4] text-warn">⏹ {{ row.item.part.text }}</div>
            </template>
          </template>
        </template>
      </div>
    </div>

    <Transition name="chat-feed-jump-fade">
      <div v-if="!stickToBottom && renderItems.length > 0" class="flex flex-none justify-center pb-2">
        <button type="button" class="cursor-pointer rounded-full border border-line-strong bg-raised px-3 py-1 text-xs text-fg-secondary shadow-[0_4px_12px_var(--shadow-color)] hover:bg-hover hover:text-fg" @click="scrollToBottom">回到最新 ↓</button>
      </div>
    </Transition>

    <!--
      就地审批卡刻意放在滚动容器 **外面**：等待批准是当前唯一的阻塞点，
      放进滚动区的话往上翻历史就把它翻走了，用户得先滚回底部才能批。
    -->
    <ApprovalCard
      v-if="approval"
      v-bind="approval"
      @approve="emit('approve')"
      @reject="emit('reject', $event)"
      @open-doc="onOpenApprovalDoc"
    />

    <div v-if="sendError" class="flex-none bg-danger/10 px-3 py-2 text-xs text-danger">{{ sendError }}</div>

    <ChatComposer v-model="draft" :mode="composerMode" :can-abort="canAbort" :sending="sending" @send="onComposerSend" @abort="emit('abort')" />
  </div>
</template>

<style scoped>
/* .mono（未分层全局原子类，12.5px）会压过 utilities 层字号，这里补回 12px。 */
.chat-feed-lifecycle-detail {
  font-size: var(--font-size-sm);
}

/* 「回到最新」条的淡入淡出（Vue Transition 运行时生成的类名，Tailwind 扫描不到）。 */
.chat-feed-jump-fade-enter-active,
.chat-feed-jump-fade-leave-active {
  transition: opacity var(--duration) var(--ease-out);
}

.chat-feed-jump-fade-enter-from,
.chat-feed-jump-fade-leave-to {
  opacity: 0;
}
</style>
