<script setup lang="ts">
/**
 * 右栏输入区（spec §3.5，D21）。语义判定完全交给 `domain/composer.ts`，本组件
 * 只管渲染：占位文案随 `mode` 切换、`mode==="steer"` 时的纠偏提示与「⏹ 打断」
 * 按钮、发送/打断进行中的禁用态。是否可发消息（`hasAgent`/`agentStatus` 推导）由
 * ProjectView 通过 `composerMode`/`canAbort` 下发，本组件不重复判定 run 状态。
 *
 * v-model（modelValue）最终由 ProjectView 按对话持有：点击「空态示例任务」时 ChatFeed
 * 能直接把文案填进输入框（`EXAMPLE_TASKS` 注释「可一键填入」——是填入，不是
 * 直接发送），composer 自身不需要关心草稿从哪来。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { canSendText, composerPlaceholder } from "../../domain/composer.ts";
import type { ChatComposerMode } from "../../views/project-view-contract.ts";
import Button from "../ui/AppButton.vue";

const props = defineProps<{
  modelValue: string;
  mode: ChatComposerMode;
  /** 仅 mode==="steer" 时可能为 true（判定权在 ProjectView，本组件照单渲染）。 */
  canAbort: boolean;
  sending: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  send: [text: string];
  abort: [];
}>();

const placeholder = computed(() => composerPlaceholder(props.mode));
const sendEnabled = computed(() => canSendText(props.modelValue, props.sending));

const textareaEl = ref<HTMLTextAreaElement | null>(null);

/** 输入框随内容增高，最多到 160px 后滚动（避免把对话流挤没）。 */
function autoResize(): void {
  const el = textareaEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

watch(() => props.modelValue, () => void nextTick(autoResize));
onMounted(autoResize);

function onInput(ev: Event): void {
  emit("update:modelValue", (ev.target as HTMLTextAreaElement).value);
}

function submit(): void {
  if (!sendEnabled.value) return;
  emit("send", props.modelValue.trim());
  // The workspace clears its draft only after a successful response.
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    submit();
  }
}
</script>

<template>
  <div class="chat-composer" :class="{ steering: mode === 'steer', sending }">
    <p v-if="mode === 'steer'" class="chat-composer-hint">插一句不保证按顺序生效，将在当前步骤结束后注入</p>

    <div class="chat-composer-row">
      <textarea
        ref="textareaEl"
        class="chat-composer-input"
        :value="modelValue"
        :placeholder="placeholder"
        aria-label="发送给 Agent 的消息"
        :disabled="sending"
        rows="1"
        @input="onInput"
        @keydown="onKeydown"
      />
      <div class="chat-composer-actions">
        <Button v-if="canAbort" variant="danger" size="sm" :disabled="sending" title="打断当前回复" @click="emit('abort')">
          ⏹ 打断
        </Button>
        <Button variant="primary" size="sm" :disabled="!sendEnabled" :loading="sending" @click="submit">↑ 发送</Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-composer {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3) var(--space-3);
  background: var(--surface-panel);
  border-top: 1px solid var(--border-subtle);
}

.chat-composer-hint {
  margin: 0;
  color: var(--state-warn);
  font-size: 11px;
}

.chat-composer-row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
}

.chat-composer-input {
  flex: 1;
  min-width: 0;
  min-height: 30px;
  max-height: 160px;
  padding: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--surface-base);
  color: var(--text-primary);
  font-size: var(--font-size-base);
  line-height: var(--line-height-chat);
  resize: none;
  overflow-y: auto;
  transition: border-color var(--duration) var(--ease-out);
}

.chat-composer-input:focus-visible {
  border-color: var(--accent);
  outline: none;
}

.chat-composer-input::placeholder {
  color: var(--text-muted);
}

.chat-composer-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  background: var(--surface-hover);
}

.chat-composer.steering .chat-composer-input {
  border-color: color-mix(in srgb, var(--state-warn) 45%, var(--border-subtle));
}

.chat-composer-actions {
  display: flex;
  flex: none;
  gap: var(--space-1);
}
</style>
