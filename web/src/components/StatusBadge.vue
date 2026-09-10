<script setup lang="ts">
/**
 * 通用状态徽章。kind: ok / warn / danger / accent / plain
 */
defineProps<{
  text: string;
  kind?: "ok" | "warn" | "danger" | "accent" | "plain";
}>();
</script>

<template>
  <span class="badge" :class="kind && kind !== 'plain' ? kind : ''">{{ text }}</span>
</template>

<style scoped>
.badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px; border-radius: 5px; font-size: 10px; font-weight: 500; line-height: 1.4; color: var(--text-secondary); background: var(--surface-hover); white-space: nowrap; }
.badge::before { content: ""; width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
.badge.ok { color: var(--state-ok); background: color-mix(in srgb, var(--state-ok) 9%, transparent); }
.badge.warn { color: var(--state-warn); background: color-mix(in srgb, var(--state-warn) 10%, transparent); }
.badge.danger { color: var(--state-danger); background: color-mix(in srgb, var(--state-danger) 10%, transparent); }
.badge.accent { color: var(--accent); background: var(--accent-subtle); }
</style>
