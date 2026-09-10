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
  <div class="chat-composer flex flex-col gap-1 border-t border-line bg-panel px-3 pb-3 pt-2" :class="{ steering: mode === 'steer', sending }">
    <p v-if="mode === 'steer'" class="m-0 text-[11px] text-warn">插一句不保证按顺序生效，将在当前步骤结束后注入</p>

    <div class="flex items-end gap-2">
      <textarea
        ref="textareaEl"
        class="chat-composer-input max-h-[160px] min-h-[30px] min-w-0 flex-1 resize-none overflow-y-auto rounded-md border border-line bg-base p-2 leading-[1.55] text-fg transition-[border-color] duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] placeholder:text-fg-muted focus-visible:border-brand focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-hover disabled:opacity-55"
        :value="modelValue"
        :placeholder="placeholder"
        aria-label="发送给 Agent 的消息"
        :disabled="sending"
        rows="1"
        @input="onInput"
        @keydown="onKeydown"
      />
      <div class="flex flex-none gap-1">
        <Button v-if="canAbort" variant="danger" size="sm" :disabled="sending" title="打断当前回复" @click="emit('abort')">
          ⏹ 打断
        </Button>
        <Button variant="primary" size="sm" :disabled="!sendEnabled" :loading="sending" @click="submit">↑ 发送</Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* steering 态描边必须压过模板里的 focus-visible:border-brand（两个类 + 伪类的
   特异性高于单个变体工具类），与 reset 分层无关，故留在 scoped。
   （.chat-composer-input 同时是 ProjectView 聚焦用的 querySelector 钩子，类名勿动。） */
.chat-composer.steering .chat-composer-input {
  border-color: color-mix(in srgb, var(--state-warn) 45%, var(--border-subtle));
}
</style>
