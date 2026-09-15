<script setup lang="ts">
/**
 * 统计卡：label + 大数字 + 辅助说明。此前在 EvolutionSummary（4 连）与
 * LearnedSkillDetail（5 连）里同构重复；此处为唯一实现。
 */
defineProps<{
  label: string;
  value: string | number;
  hint?: string;
}>();
</script>

<template>
  <article class="grid min-w-0 gap-1 rounded-md border border-line bg-base p-3">
    <span class="text-xs text-fg-secondary">{{ label }}</span>
    <strong class="text-2xl leading-none tabular-nums">{{ value }}</strong>
    <small v-if="hint" class="text-fg-secondary">{{ hint }}</small>
    <slot />
  </article>
</template>
