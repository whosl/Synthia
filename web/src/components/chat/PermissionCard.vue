<script setup lang="ts">
/**
 * 权限请求卡（Agent 调用可请求名单内的工具时挂起，等待用户裁决）。
 *
 * pending 态给「允许 / 拒绝」；裁决后原地定稿（已允许/已拒绝 + 原因），留痕在
 * 流里。提交中有乐观中间态（`pending` prop）：点击瞬间进「提交中」，只表诉
 * 正在提交、不提前声称裁决结果——工具是否会跑以服务器确认为准。`locked` 是
 * 别的卡片/开关在提交中（按钮冻结，防点击被 ProjectView 静默吞掉）。红线操作
 * 不会走到这张卡——那些由 runtime 硬拦，与用户意愿无关。
 */
import { computed } from "vue";
import { LoaderCircle } from "lucide-vue-next";
import type { SynthiaPermissionPart } from "../../domain/parts.ts";
import Badge from "../ui/AppBadge.vue";

const props = defineProps<{
  part: SynthiaPermissionPart;
  /** 本卡的裁决正在提交（乐观中间态）。 */
  pending?: boolean;
  /** 其他权限操作进行中——冻结本卡按钮。 */
  locked?: boolean;
}>();

const emit = defineEmits<{
  resolve: [callId: string, allow: boolean];
}>();

const STATE_TEXT: Record<SynthiaPermissionPart["state"], string> = {
  pending: "等待裁决",
  allowed: "已允许",
  denied: "已拒绝",
};

const STATE_TONE: Record<SynthiaPermissionPart["state"], "accent" | "ok" | "danger"> = {
  pending: "accent",
  allowed: "ok",
  denied: "danger",
};

/** 徽章文案：提交中的乐观中间态优先于 part 自身状态。 */
const badgeText = computed(() => (props.pending ? "提交中" : STATE_TEXT[props.part.state]));
const badgeTone = computed(() => (props.pending ? "warn" : STATE_TONE[props.part.state]));

/** 入参预览能解析成 JSON 就缩进展示（runtime 侧已截 800 字符）。 */
const argsText = computed(() => {
  const raw = props.part.argsPreview.trim();
  if (!raw || raw === "{}") return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
});
</script>

<template>
  <!-- 旧 scoped 的 var(--surface, #faf6f0) 里 --surface 从未定义，卡片恒为米色兜底
       （深色主题下是废样式）；这里落到语义令牌 bg-panel，与同区 ApprovalCard 一致。 -->
  <div
    class="rounded-sm border border-line bg-panel px-3 py-2"
    :class="part.state === 'pending' ? 'border-brand' : ''"
  >
    <div class="flex items-center gap-2 text-xs text-fg">
      <span aria-hidden="true">{{ part.state === "pending" ? "🛡" : part.state === "allowed" ? "✓" : "✗" }}</span>
      <span>
        {{ part.state === "pending" ? "权限请求" : "权限裁决" }}：<code>{{ part.tool }}</code>
      </span>
      <Badge :tone="badgeTone" variant="dot" size="sm">{{ badgeText }}</Badge>
    </div>
    <pre v-if="argsText" class="my-2 max-h-[180px] overflow-auto break-words whitespace-pre-wrap text-fg-secondary">{{ argsText }}</pre>
    <span v-if="pending" class="flex items-center gap-1.5 text-xs text-fg-muted"><LoaderCircle :size="12" class="animate-spin" aria-hidden="true" />正在提交裁决…</span>
    <div v-else-if="part.state === 'pending'" class="flex gap-2">
      <button
        type="button"
        :disabled="locked"
        class="cursor-pointer rounded-sm border border-brand bg-transparent px-3.5 py-1 text-xs text-brand disabled:cursor-not-allowed disabled:opacity-50"
        @click="emit('resolve', part.callId, true)"
      >允许</button>
      <button
        type="button"
        :disabled="locked"
        class="cursor-pointer rounded-sm border border-line bg-transparent px-3.5 py-1 text-xs text-danger disabled:cursor-not-allowed disabled:opacity-50"
        @click="emit('resolve', part.callId, false)"
      >拒绝</button>
    </div>
    <div v-else-if="part.reason" class="text-xs text-fg-muted">{{ part.reason }}</div>
  </div>
</template>
