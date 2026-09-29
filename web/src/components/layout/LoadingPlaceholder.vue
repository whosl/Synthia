<script setup lang="ts">
withDefaults(defineProps<{ label?: string; workspace?: boolean }>(), {
  label: "正在加载页面…",
  workspace: false,
});
</script>

<template>
  <div class="loading-placeholder" :class="{ workspace }" role="status" aria-live="polite" :aria-label="label" aria-busy="true">
    <p>{{ label }}</p>
    <div class="loading-columns" aria-hidden="true">
      <div v-for="column in 3" :key="column" class="loading-panel">
        <i class="loading-block loading-title" />
        <i v-for="line in 5" :key="line" class="loading-block" :class="{ short: line % 2 === 0 }" />
        <div class="loading-preview" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.loading-placeholder { flex: 1; min-height: 240px; padding: 24px; color: var(--text-secondary); }
.loading-placeholder p { margin: 0 0 20px; font-size: 13px; }
.loading-columns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.workspace .loading-columns { grid-template-columns: minmax(150px, 1fr) minmax(0, 2fr) minmax(150px, 1fr); }
.loading-panel { padding: 20px; border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--surface-panel); }
.loading-block, .loading-preview { display: block; height: 12px; margin-bottom: 16px; border-radius: 5px; background: var(--surface-hover); animation: loading-pulse 1.6s ease-in-out infinite; }
.loading-title { width: 45%; height: 22px; margin-bottom: 28px; }.short { width: 65%; }.loading-preview { height: 140px; margin-top: 30px; margin-bottom: 0; }
@keyframes loading-pulse { 50% { opacity: .4; } }
@media (prefers-reduced-motion: reduce) { .loading-block, .loading-preview { animation: none; } }
@media (max-width: 700px) { .loading-columns, .workspace .loading-columns { grid-template-columns: minmax(0, 1fr); }.loading-panel:not(:first-child) { display: none; } }
</style>
