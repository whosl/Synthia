<script setup lang="ts">
defineEmits<{ close: [] }>();
</script>
<template>
  <div class="create-loading" role="status" aria-live="polite" aria-label="正在加载新建项目表单">
    <div><p>正在加载新建项目表单…</p><span /><button type="button" @click="$emit('close')">取消</button></div>
  </div>
</template>
<style scoped>
.create-loading { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; background: #0005; }
.create-loading > div { width: min(420px, 85vw); padding: 32px; border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--surface-panel); color: var(--text-secondary); }
.create-loading p { margin: 0 0 20px; font-size: 14px; }.create-loading span { display: block; height: 120px; border-radius: 8px; background: var(--surface-hover); }
.create-loading button { margin-top: 20px; cursor: pointer; text-decoration: underline; }
</style>
