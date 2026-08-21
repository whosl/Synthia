<script setup lang="ts">
/**
 * 右栏对话流（spec §3.5；流式与回合制排序的教训见 v3 `0b6444c`/`8b81173`，
 * 已下沉到 `domain/parts.ts`/`domain/task-stream.ts`，本组件只管按序渲染。
 *
 * 铁律：
 * - `parts` 已经是 ProjectView 按 turn 顺序合并去重后的权威数组，本组件绝不
 *   重新排序/分组（严格回合制）；
 * - 流式 token 级追加靠 `:key="item.part.id"` 复用 `MessageItem` 组件实例——
 *   part 内容变但 id 不变时 Vue 只更新该实例的 props，不会整量重渲染整个列表；
 * - 产物卡（`SynthiaDocPart`）点击一律 `open-doc`，在中栏编辑器打开，不弹抽屉；
 *   「查看改动」走 `open-diff`，同样交给中栏 Monaco，流内不渲染行级 diff。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { buildChatRenderItems, restoreFailedSendDraft } from "../../domain/composer.ts";
import type { GatePartState } from "../../domain/parts.ts";
import type { ChatFeedEmits, ChatFeedProps } from "../../views/project-view-contract.ts";
import Badge from "../ui/Badge.vue";
import AgentToolItem from "./AgentToolItem.vue";
import ApprovalCard from "./ApprovalCard.vue";
import ChatComposer from "./ChatComposer.vue";
import CodeCard from "./CodeCard.vue";
import MessageItem from "./MessageItem.vue";
import ReasoningItem from "./ReasoningItem.vue";
import ToolCallItem from "./ToolCallItem.vue";

const props = defineProps<ChatFeedProps>();
const emit = defineEmits<ChatFeedEmits>();

/** 插话消息配对识别（steer 打标），不改变 parts 顺序（见 domain/composer.ts）。 */
const renderItems = computed(() => buildChatRenderItems(props.parts));

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

// ─── 输入草稿：ChatFeed 持有，示例任务「一键填入」需要能写回输入框 ────────
const draft = ref("");
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
  <div class="chat-feed">
    <div v-if="streamPhase === 'degraded'" class="chat-feed-banner tone-warn">实时连接中断，已切换定时刷新</div>
    <div v-else-if="streamPhase === 'connecting' && parts.length > 0" class="chat-feed-banner tone-muted">正在连接实时更新…</div>

    <div ref="scrollEl" class="chat-feed-scroll" @scroll="onScroll">
      <div v-if="renderItems.length === 0" class="chat-feed-empty">
        <template v-if="composerMode === 'new-task'">
          <p class="chat-feed-empty-title">开始你的第一个任务</p>
          <p class="chat-feed-empty-hint">描述要做什么，Agent 会从需求一路推进到产物；也可以直接点一个示例任务填入输入框</p>
          <div class="chat-feed-examples">
            <button v-for="task in exampleTasks" :key="task" type="button" class="chat-feed-example" @click="fillExample(task)">
              {{ task }}
            </button>
          </div>
        </template>
        <template v-else-if="agentStatus === null">
          <p class="chat-feed-empty-title">正在加载对话…</p>
        </template>
        <template v-else>
          <p class="chat-feed-empty-title">暂无对话记录</p>
        </template>
      </div>

      <template v-else>
        <template v-for="item in renderItems" :key="item.part.id">
          <MessageItem v-if="item.part.kind === 'text'" :part="item.part" :steer="item.steer" />

          <ToolCallItem v-else-if="item.part.kind === 'tool'" :part="item.part" @open-records="emit('open-records', $event)" />

          <ReasoningItem v-else-if="item.part.kind === 'reasoning'" :part="item.part" />

          <AgentToolItem v-else-if="item.part.kind === 'agent_tool'" :part="item.part" />

          <div v-else-if="item.part.kind === 'gate'" class="chat-feed-gate">
            <span class="chat-feed-gate-glyph" aria-hidden="true">◆</span>
            <span class="chat-feed-gate-title">{{ item.part.review }}</span>
            <Badge :tone="GATE_STATE_TONE[item.part.state]" size="sm">{{ GATE_STATE_TEXT[item.part.state] }}</Badge>
          </div>

          <CodeCard
            v-else-if="item.part.kind === 'doc'"
            :segment="null"
            :title="item.part.title"
            :artifact-id="item.part.doc.artifact_id"
            :diffable="item.part.prevRevisionId !== null"
            @open="emit('open-doc', item.part.doc.artifact_id, item.part.doc.revision_id)"
            @open-diff="emit('open-diff', item.part.doc.artifact_id, item.part.doc.revision_id)"
          />

          <button
            v-else-if="item.part.kind === 'evidence'"
            type="button"
            class="chat-feed-line chat-feed-evidence muted"
            @click="emit('open-records', null)"
          >
            📎 生成了 {{ item.part.count }} 项证据 · 查看
          </button>

          <div v-else-if="item.part.kind === 'governance'" class="chat-feed-line muted">{{ item.part.text }}</div>

          <div v-else-if="item.part.kind === 'lifecycle'" class="chat-feed-lifecycle" :class="item.part.state">
            <span class="chat-feed-lifecycle-glyph" aria-hidden="true">{{ item.part.state === "succeeded" ? "🎉" : "⚠️" }}</span>
            <div class="chat-feed-lifecycle-body">
              <p class="chat-feed-lifecycle-text">{{ item.part.text }}</p>
              <p v-if="item.part.bitstream" class="chat-feed-lifecycle-detail mono">
                {{ item.part.bitstream.name }} · sha256:{{ shortHash(item.part.bitstream.sha256) }}
              </p>
              <p v-if="item.part.evidenceCount > 0" class="chat-feed-lifecycle-detail">证据链 {{ item.part.evidenceCount }} 项</p>
            </div>
          </div>

          <div v-else-if="item.part.kind === 'note'" class="chat-feed-note" :class="`tone-${item.part.tone}`">{{ item.part.text }}</div>

          <div v-else-if="item.part.kind === 'interrupt'" class="chat-feed-line interrupt">⏹ {{ item.part.text }}</div>
        </template>
      </template>
    </div>

    <Transition name="chat-feed-jump-fade">
      <div v-if="!stickToBottom && renderItems.length > 0" class="chat-feed-jump-bar">
        <button type="button" class="chat-feed-jump" @click="scrollToBottom">回到最新 ↓</button>
      </div>
    </Transition>

    <!--
      就地审批卡刻意放在 .chat-feed-scroll **外面**：等待批准是当前唯一的阻塞点，
      放进滚动区的话往上翻历史就把它翻走了，用户得先滚回底部才能批。
    -->
    <ApprovalCard
      v-if="approval"
      v-bind="approval"
      @approve="emit('approve')"
      @reject="emit('reject', $event)"
      @open-doc="onOpenApprovalDoc"
    />

    <div v-if="sendError" class="chat-feed-error">{{ sendError }}</div>

    <ChatComposer v-model="draft" :mode="composerMode" :can-abort="canAbort" :sending="sending" @send="onComposerSend" @abort="emit('abort')" />
  </div>
</template>

<style scoped>
.chat-feed {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-panel);
}

.chat-feed-banner {
  flex: none;
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-sm);
  text-align: center;
}

.chat-feed-banner.tone-warn {
  background: color-mix(in srgb, var(--state-warn) 14%, transparent);
  color: var(--state-warn);
}

.chat-feed-banner.tone-muted {
  background: var(--surface-hover);
  color: var(--text-muted);
}

.chat-feed-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
}

.chat-feed-empty {
  margin: auto 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-4);
  text-align: center;
}

.chat-feed-empty-title {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--font-size-base);
  font-weight: 600;
}

.chat-feed-empty-hint {
  margin: 0;
  max-width: 280px;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-list);
}

.chat-feed-examples {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  margin-top: var(--space-2);
}

.chat-feed-example {
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius);
  background: var(--surface-hover);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-list);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--duration) var(--ease-out), color var(--duration) var(--ease-out);
}

.chat-feed-example:hover {
  background: var(--accent-subtle);
  color: var(--text-primary);
}

.chat-feed-gate {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius);
  background: var(--surface-hover);
}

.chat-feed-gate-glyph {
  flex: none;
  color: var(--accent);
}

.chat-feed-gate-title {
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.chat-feed-line {
  padding: var(--space-1) var(--space-2);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-list);
}

.chat-feed-line.muted {
  color: var(--text-muted);
}

.chat-feed-evidence {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background-color var(--duration) var(--ease-out), color var(--duration) var(--ease-out);
}

.chat-feed-evidence:hover {
  background: var(--accent-subtle);
  color: var(--text-primary);
}

.chat-feed-line.interrupt {
  color: var(--state-warn);
}

.chat-feed-lifecycle {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius);
}

.chat-feed-lifecycle.succeeded {
  background: color-mix(in srgb, var(--state-ok) 12%, transparent);
}

.chat-feed-lifecycle.failed {
  background: color-mix(in srgb, var(--state-danger) 10%, transparent);
}

.chat-feed-lifecycle-glyph {
  flex: none;
  font-size: var(--font-size-lg);
}

.chat-feed-lifecycle-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.chat-feed-lifecycle-text {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--font-size-base);
  font-weight: 600;
}

.chat-feed-lifecycle-detail {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.chat-feed-note {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-list);
  background: var(--surface-hover);
}

.chat-feed-note.tone-info {
  color: var(--text-secondary);
}

.chat-feed-note.tone-warn {
  color: var(--state-warn);
}

.chat-feed-note.tone-error {
  color: var(--state-danger);
}

.chat-feed-jump-bar {
  flex: none;
  display: flex;
  justify-content: center;
  padding: 0 0 var(--space-2);
}

.chat-feed-jump {
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-full);
  background: var(--surface-raised);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  box-shadow: 0 4px 12px var(--shadow-color);
}

.chat-feed-jump:hover {
  color: var(--text-primary);
  background: var(--surface-hover);
}

.chat-feed-jump-fade-enter-active,
.chat-feed-jump-fade-leave-active {
  transition: opacity var(--duration) var(--ease-out);
}

.chat-feed-jump-fade-enter-from,
.chat-feed-jump-fade-leave-to {
  opacity: 0;
}

.chat-feed-error {
  flex: none;
  padding: var(--space-2) var(--space-3);
  color: var(--state-danger);
  font-size: var(--font-size-sm);
  background: color-mix(in srgb, var(--state-danger) 10%, transparent);
}
</style>
