<script setup lang="ts">
/**
 * 基础徽章（受控展示组件，不含业务逻辑）。
 *
 * 只负责「文案/图标 + 语气色」的展示，不理解具体业务状态枚举——业务枚举到
 * tone 的映射由调用方完成，例如：
 * - 产物版本四态（spec §3.2，见 views/project-view-contract.ts:artifactDotState）：
 *   已批准→ok / 候选→info / 已驳回→danger / 已作废→neutral；
 * - 阶段链五态（domain/tasks.ts:StageNodeStatus）：
 *   done→ok / running→accent / waiting→warn / pending→neutral / failed→danger。
 *
 * variant="dot" 时不渲染胶囊底色，只在文案前加一个语气色圆点，用于列表行内联
 * 场景（文件树状态点、阶段链节点）；variant="soft"（默认）渲染浅底胶囊，用于
 * 独立徽章场景（顶栏 run 状态、对话流卡片状态）。
 */
withDefaults(
  defineProps<{
    tone?: "neutral" | "accent" | "ok" | "warn" | "danger" | "info";
    variant?: "soft" | "solid" | "dot";
    size?: "sm" | "md";
  }>(),
  {
    tone: "neutral",
    variant: "soft",
    size: "md",
  },
);
</script>

<template>
  <span class="ui-badge" :class="[`tone-${tone}`, `variant-${variant}`, `size-${size}`]">
    <span v-if="variant === 'dot'" class="ui-badge-dot" aria-hidden="true" />
    <slot />
  </span>
</template>

<style scoped>
.ui-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  border-radius: var(--radius-full);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-list);
  white-space: nowrap;
}

.size-md.variant-soft,
.size-md.variant-solid {
  padding: 1px var(--space-2);
}

.size-sm.variant-soft,
.size-sm.variant-solid {
  padding: 0 var(--space-1);
  font-size: 11px;
}

.variant-dot {
  gap: var(--space-1);
  color: var(--text-secondary);
}

.ui-badge-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: currentColor;
  flex: none;
}

/* soft：浅底 + 语气色文字（默认，独立徽章场景） */
.variant-soft.tone-neutral {
  background: var(--surface-hover);
  color: var(--text-secondary);
}

.variant-soft.tone-accent {
  background: var(--accent-subtle);
  color: var(--accent);
}

.variant-soft.tone-ok {
  background: color-mix(in srgb, var(--state-ok) 16%, transparent);
  color: var(--state-ok);
}

.variant-soft.tone-warn {
  background: color-mix(in srgb, var(--state-warn) 16%, transparent);
  color: var(--state-warn);
}

.variant-soft.tone-danger {
  background: color-mix(in srgb, var(--state-danger) 16%, transparent);
  color: var(--state-danger);
}

.variant-soft.tone-info {
  background: color-mix(in srgb, var(--state-info) 16%, transparent);
  color: var(--state-info);
}

/* solid：实心底，强调力度更高的场景（如里程碑门按钮旁的强提示） */
.variant-solid.tone-neutral {
  background: var(--border-strong);
  color: var(--text-primary);
}

.variant-solid.tone-accent {
  background: var(--accent);
  color: var(--text-on-accent);
}

.variant-solid.tone-ok {
  background: var(--state-ok);
  color: var(--text-on-accent);
}

.variant-solid.tone-warn {
  background: var(--state-warn);
  color: var(--text-on-accent);
}

.variant-solid.tone-danger {
  background: var(--state-danger);
  color: var(--text-on-accent);
}

.variant-solid.tone-info {
  background: var(--state-info);
  color: var(--text-on-accent);
}

/* dot：圆点色随 tone，文字用正常前景色（用于文件树/阶段链等信息密集列表） */
.variant-dot.tone-neutral {
  color: var(--text-muted);
}

.variant-dot.tone-accent {
  color: var(--accent);
}

.variant-dot.tone-ok {
  color: var(--state-ok);
}

.variant-dot.tone-warn {
  color: var(--state-warn);
}

.variant-dot.tone-danger {
  color: var(--state-danger);
}

.variant-dot.tone-info {
  color: var(--state-info);
}
</style>
