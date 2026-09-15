<script setup lang="ts">
/**
 * 抽屉/面板统一头部：eyebrow + 标题 + 可选描述 + 右侧动作槽 + 关闭按钮。
 * 此前四个面板（正式流程/历史资料/探索任务/运行记录）各写一套头部，
 * 关闭按钮有图标、文字、裸 ✕ 三种形态；此处为唯一实现（spec：面板体系统一）。
 */
import { X } from "lucide-vue-next";
import Button from "../ui/AppButton.vue";

defineProps<{
  eyebrow?: string;
  title: string;
  description?: string;
  closeLabel?: string;
}>();

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <header class="flex flex-none items-start justify-between gap-3 border-b border-line px-5 pt-4 pb-3">
    <div class="min-w-0">
      <p v-if="eyebrow" class="m-0 mb-1 text-[11px] font-semibold tracking-[0.08em] text-fg-muted uppercase">{{ eyebrow }}</p>
      <h2 class="m-0 text-[15px] font-semibold text-fg">{{ title }}</h2>
      <p v-if="description" class="m-0 mt-1 text-xs leading-[1.5] text-fg-secondary">{{ description }}</p>
    </div>
    <div class="flex flex-none items-center gap-1">
      <slot name="actions" />
      <Button
        variant="ghost"
        size="sm"
        class="h-8 w-8 px-0"
        :aria-label="closeLabel ?? `关闭${title}`"
        @click="emit('close')"
      >
        <X :size="16" aria-hidden="true" />
      </Button>
    </div>
  </header>
</template>
