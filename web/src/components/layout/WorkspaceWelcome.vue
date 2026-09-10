<script setup lang="ts">
import { Cpu, Folder, Sparkles } from "lucide-vue-next";
import Button from "../ui/AppButton.vue";
defineProps<{
  projectName: string;
  engineering: boolean;
  hasAgent: boolean;
  showBrowse: boolean;
}>();
const emit = defineEmits<{ start: []; browse: [] }>();
</script>
<template>
  <div
    class="flex h-full min-h-0 flex-col items-center justify-center overflow-auto bg-[radial-gradient(ellipse_at_50%_40%,var(--accent-subtle),transparent_65%)] p-8 text-center max-[600px]:p-6"
  >
    <span
      class="mb-6 grid size-[76px] place-items-center rounded-[24px] border border-line-strong bg-panel text-brand shadow-[0_12px_32px_var(--shadow-color)]"
    ><Cpu :size="38" /></span>
    <p class="text-[9px] tracking-[2px] text-brand">PROJECT WORKSPACE</p>
    <h1
      class="my-3 max-w-[600px] wrap-anywhere text-[clamp(20px,2vw,28px)] leading-[1.5] font-[550]"
    >
      {{ projectName }}
    </h1>
    <p class="text-xs leading-[1.8] text-fg-secondary">
      {{
        !engineering
          ? "描述你的想法，与 Agent 一起探索解决方案。"
          : "与主 Agent 协作，让需求、实现与证据保持一致。"
      }}
    </p>
    <div class="mt-[18px] flex gap-2">
      <Button variant="primary" @click="emit('start')"
        ><Sparkles :size="16" />{{
          hasAgent ? "继续与 Agent 协作" : "开始第一个任务"
        }}</Button
      ><Button v-if="showBrowse" @click="emit('browse')"
        ><Folder :size="16" />浏览文件</Button
      >
    </div>
    <div
      class="mt-12 flex gap-6 border-t border-line pt-6 text-[11px] text-fg-muted max-[600px]:gap-4"
    >
      <span
        ><i class="mb-2.5 block font-mono text-[10px] not-italic text-brand">01</i>明确任务目标</span
      ><span
        ><i class="mb-2.5 block font-mono text-[10px] not-italic text-brand">02</i>查看文件与结果</span
      ><span
        ><i class="mb-2.5 block font-mono text-[10px] not-italic text-brand">03</i>{{ !engineering ? "验证并继续探索" : "核对证据并确认" }}</span
      >
    </div>
  </div>
</template>
