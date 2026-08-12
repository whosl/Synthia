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
