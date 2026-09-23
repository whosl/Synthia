<script setup lang="ts">
defineProps<{ expanded?: boolean }>();
</script>

<template>
  <button
    type="button"
    class="project-toolbar-button"
    :aria-expanded="expanded"
  ><slot /></button>
</template>

<style scoped>
.project-toolbar-button {
  display: inline-flex;
  min-width: 0;
  height: 26px;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  padding: 0 11px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}
.project-toolbar-button:hover,
.project-toolbar-button[aria-expanded="true"] {
  border-color: var(--accent);
  background: var(--accent-subtle);
}
.project-toolbar-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
@media (max-width: 700px) {
  .project-toolbar-button { padding: 0 8px; gap: 5px; font-size: 11px; }
}
</style>
