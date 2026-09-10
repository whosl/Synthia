<script setup lang="ts">
import Button from "../ui/AppButton.vue";
import Icon from "../ui/Icon.vue";
defineProps<{
  projectName: string;
  engineering: boolean;
  hasAgent: boolean;
  showBrowse: boolean;
}>();
const emit = defineEmits<{ start: []; browse: [] }>();
</script>
<template>
  <div class="workspace-welcome">
    <span class="welcome-icon"><Icon name="chip" :size="38" /></span>
    <p class="welcome-eyebrow">PROJECT WORKSPACE</p>
    <h1>{{ projectName }}</h1>
    <p>
      {{
        !engineering
          ? "描述你的想法，与 Agent 一起探索解决方案。"
          : "与主 Agent 协作，让需求、实现与证据保持一致。"
      }}
    </p>
    <div class="welcome-actions">
      <Button variant="primary" @click="emit('start')"
        ><Icon name="spark" :size="16" />{{
          hasAgent ? "继续与 Agent 协作" : "开始第一个任务"
        }}</Button
      ><Button v-if="showBrowse" @click="emit('browse')"
        ><Icon name="folder" :size="16" />浏览文件</Button
      >
    </div>
    <div class="welcome-steps">
      <span><i>01</i>明确任务目标</span><span><i>02</i>查看文件与结果</span
      ><span
        ><i>03</i>{{ !engineering ? "验证并继续探索" : "核对证据并确认" }}</span
      >
    </div>
  </div>
</template>
<style scoped>
.workspace-welcome {
  height: 100%;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
  text-align: center;
  background: radial-gradient(
    ellipse at 50% 40%,
    var(--accent-subtle),
    transparent 65%
  );
}
.welcome-icon {
  display: grid;
  place-items: center;
  width: 76px;
  height: 76px;
  border: 1px solid var(--border-strong);
  border-radius: 24px;
  color: var(--accent);
  background: var(--surface-panel);
  margin-bottom: 24px;
  box-shadow: 0 12px 32px var(--shadow-color);
}
.welcome-eyebrow {
  color: var(--accent);
  font-size: 9px;
  letter-spacing: 2px;
}
.workspace-welcome h1 {
  font-size: clamp(20px, 2vw, 28px);
  font-weight: 550;
  max-width: 600px;
  line-height: 1.5;
  margin: 12px 0;
  overflow-wrap: anywhere;
}
.workspace-welcome > p:not(.welcome-eyebrow) {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.8;
}
.welcome-actions {
  display: flex;
  gap: 8px;
  margin-top: 18px;
}
.welcome-actions :deep(.ui-button) {
  height: 36px;
}
.welcome-steps {
  display: flex;
  gap: 24px;
  margin-top: 48px;
  padding-top: 24px;
  border-top: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: 11px;
}
.welcome-steps i {
  display: block;
  color: var(--accent);
  font: 10px var(--font-mono);
  margin-bottom: 10px;
}
@media (max-width: 600px) {
  .welcome-steps {
    gap: 16px;
  }
  .workspace-welcome {
    padding: 24px;
  }
}
</style>
