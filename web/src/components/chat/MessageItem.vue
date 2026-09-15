<script setup lang="ts">
/**
 * 单条文本消息（user 气泡 / agent 叙述）。
 *
 * - role="user"：右侧气泡，纯文本（保留换行，不解析 Markdown，避免用户输入被
 *   当作 HTML/Markdown 注入渲染）；`steer=true` 时带 `↗ 纠偏` 标记
 *   （spec §3.5 D21，标记来自 `domain/composer.ts:buildChatRenderItems` 的配对
 *   识别，本组件只管渲染，不做识别）；`pending=true` 为乐观上屏的发送中
 *   气泡（半透明 + 发送中 spinner，定稿后由真实事件顶替）。
 * - role="agent" 且 state="streaming"：走 `domain/markdown-stream.ts:project`
 *   做增量块投影，token 级追加渲染，不整量重渲染；
 * - role="agent" 且 state="done"：走 `domain/reply-segments.ts:segmentAgentReply`
 *   分段——超过 15 行的代码块折叠为 `CodeCard`（叙述折叠模式，无产物 id，
 *   点击只本地展开/收起），超过 15 行的纯文本用原生 `<details>` 折叠，其余按
 *   Markdown 渲染。
 */
import { computed, ref, watch } from "vue";
import { LoaderCircle } from "lucide-vue-next";
import { renderMarkdown } from "../../domain/markdown.ts";
import { project, type Projection } from "../../domain/markdown-stream.ts";
import { segmentAgentReply, type ReplyCodeSegment } from "../../domain/reply-segments.ts";
import type { SynthiaTextPart } from "../../domain/parts.ts";
import { STEER_BADGE_TEXT } from "../../domain/composer.ts";
import Badge from "../ui/AppBadge.vue";
import CodeCard from "./CodeCard.vue";

const props = defineProps<{
  part: SynthiaTextPart;
  /** 是否为插话（steer）发出的用户消息；非 user 消息恒为 false。 */
  steer?: boolean;
  /** 乐观上屏的发送中气泡（ChatFeed 追加的合成 part）；真实事件落地后消失。 */
  pending?: boolean;
}>();

// ─── 流式：增量 Markdown 块投影（token 级追加，不整量重渲染）───────────
const projection = ref<Projection | undefined>(undefined);
watch(
  () => [props.part.text, props.part.state] as const,
  ([text, state]) => {
    projection.value = project(projection.value, text, state === "streaming");
  },
  { immediate: true },
);

// ─── 定稿：>15 行代码/文本折叠分段 ───────────────────────────────────
const displaySegments = computed(() =>
  props.part.role === "agent" ? (props.part.segments ?? segmentAgentReply(props.part.text)) : [],
);

function codeCardTitle(seg: ReplyCodeSegment): string {
  if (seg.filename) return seg.filename;
  if (seg.language) return `${seg.language} 代码`;
  return "代码片段";
}
</script>

<template>
  <div class="flex items-start gap-2" :class="part.role === 'user' ? 'justify-end' : ''">
    <span v-if="part.role === 'agent'" class="flex-none leading-[1.55]" aria-hidden="true">🤖</span>

    <!--
      88% 宽度上限必须落在消息体这一层，不能落在气泡上：消息体是 shrink-to-fit
      （宽度由气泡内容撑出）的 flex item，气泡上写 max-width:88% 会自我参照——
      百分比在内在尺寸阶段按 none 计算，布局阶段却按「气泡自身 max-content 的
      88%」收紧，于是每条用户消息尾部约 12% 必被折行。放在消息体上则以整行宽度
      （定值）为基准，无环。
    -->
    <div class="message-body flex min-w-0 flex-col gap-2" :class="part.role === 'user' ? 'max-w-[88%] items-end' : 'max-w-full'">
      <div v-if="part.role === 'user'" class="flex max-w-full flex-col gap-1 rounded-md bg-brand-subtle px-3 py-2" :class="pending ? 'opacity-70' : ''">
        <Badge v-if="steer" tone="info" variant="soft" size="sm" class="self-start">{{ STEER_BADGE_TEXT }}</Badge>
        <p class="m-0 whitespace-pre-wrap break-words leading-[1.55] text-fg">{{ part.text }}</p>
      </div>
      <span v-if="pending" class="flex items-center gap-1 self-end text-[11px] leading-none text-fg-muted"><LoaderCircle :size="12" class="animate-spin" aria-hidden="true" />发送中…</span>

      <template v-else>
        <template v-if="part.state === 'streaming'">
          <template v-for="(block, i) in projection?.blocks ?? []" :key="i">
            <div v-if="block.mode === 'code'" class="overflow-hidden rounded-sm bg-hover">
              <div v-if="block.language" class="px-2 py-1 text-[11px] text-fg-muted">{{ block.language }}</div>
              <pre class="mono m-0 overflow-x-auto whitespace-pre p-2 text-fg"><code>{{ block.src }}</code></pre>
            </div>
            <div v-else class="markdown-body leading-[1.55] text-fg" v-html="renderMarkdown(block.src)"></div>
          </template>
          <span class="message-cursor ml-[2px] inline-block h-[1em] w-[6px] bg-brand align-text-bottom [animation:message-cursor-blink_900ms_step-end_infinite]" aria-hidden="true" />
        </template>

        <template v-else>
          <template v-for="seg in displaySegments" :key="seg.id">
            <CodeCard v-if="seg.kind === 'code' && seg.collapsible" :segment="seg" :title="codeCardTitle(seg)" :artifact-id="null" />
            <div v-else-if="seg.kind === 'code'" class="overflow-hidden rounded-sm bg-hover">
              <div v-if="seg.language || seg.filename" class="px-2 py-1 text-[11px] text-fg-muted">{{ seg.filename ?? seg.language }}</div>
              <pre class="mono m-0 overflow-x-auto whitespace-pre p-2 text-fg"><code>{{ seg.code }}</code></pre>
            </div>
            <details v-else-if="seg.collapsible">
              <summary class="cursor-pointer py-1 text-xs text-fg-secondary marker:text-fg-muted">展开全文（{{ seg.lineCount }} 行）</summary>
              <div class="markdown-body leading-[1.55] text-fg" v-html="renderMarkdown(seg.text)"></div>
            </details>
            <div v-else class="markdown-body leading-[1.55] text-fg" v-html="renderMarkdown(seg.text)"></div>
          </template>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 流式光标的闪烁关键帧（Tailwind 无内置步进闪烁动画；message-cursor 类名保留）。
   markdown 排印已并入全局 styles/markdown.css（.message-body .markdown-body 覆写层）。 */
@keyframes message-cursor-blink {
  50% {
    opacity: 0;
  }
}
</style>
