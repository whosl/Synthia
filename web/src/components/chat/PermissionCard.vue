<script setup lang="ts">
/**
 * 权限请求卡（Agent 调用可请求名单内的工具时挂起，等待用户裁决）。
 *
 * pending 态给「允许 / 拒绝」；裁决后原地定稿（已允许/已拒绝 + 原因），留痕在
 * 流里。红线操作不会走到这张卡——那些由 runtime 硬拦，与用户意愿无关。
 */
import { computed } from "vue";
import type { SynthiaPermissionPart } from "../../domain/parts.ts";
import Badge from "../ui/AppBadge.vue";

const props = defineProps<{ part: SynthiaPermissionPart }>();

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
  <div class="permission-card" :class="`state-${part.state}`">
    <div class="permission-head">
      <span class="permission-glyph" aria-hidden="true">{{ part.state === "pending" ? "🛡" : part.state === "allowed" ? "✓" : "✗" }}</span>
      <span class="permission-title">
        {{ part.state === "pending" ? "权限请求" : "权限裁决" }}：<code>{{ part.tool }}</code>
      </span>
      <Badge :tone="STATE_TONE[part.state]" variant="dot" size="sm">{{ STATE_TEXT[part.state] }}</Badge>
    </div>
    <pre v-if="argsText" class="permission-args">{{ argsText }}</pre>
    <div v-if="part.state === 'pending'" class="permission-actions">
      <button type="button" class="permission-btn allow" @click="emit('resolve', part.callId, true)">允许</button>
      <button type="button" class="permission-btn deny" @click="emit('resolve', part.callId, false)">拒绝</button>
    </div>
    <div v-else-if="part.reason" class="permission-reason">{{ part.reason }}</div>
  </div>
</template>

<style scoped>
.permission-card {
  border: 1px solid var(--border, #d8cfc4);
  border-radius: var(--radius-sm, 8px);
  background: var(--surface, #faf6f0);
  padding: var(--space-2, 8px) var(--space-3, 12px);
}

.state-pending {
  border-color: var(--accent, #c2571b);
}

.permission-head {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  font-size: var(--font-size-sm, 13px);
  color: var(--text-primary, #2d2a26);
}

.permission-title code {
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-code, 12px);
}

.permission-args {
  margin: var(--space-2, 8px) 0;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-code, 12px);
  color: var(--text-secondary, #5b564f);
}

.permission-actions {
  display: flex;
  gap: var(--space-2, 8px);
}

.permission-btn {
  border-radius: var(--radius-sm, 6px);
  border: 1px solid var(--border, #d8cfc4);
  padding: 4px 14px;
  font-size: var(--font-size-sm, 13px);
  cursor: pointer;
}

.permission-btn.allow {
  border-color: var(--accent, #c2571b);
  color: var(--accent, #c2571b);
}

.permission-btn.deny {
  color: var(--state-danger, #b3352c);
}

.permission-reason {
  color: var(--text-muted, #8a837a);
  font-size: 12px;
}
</style>
