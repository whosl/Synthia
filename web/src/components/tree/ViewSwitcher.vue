<script setup lang="ts">
/**
 * 左栏视图切换器（路径 / 产物类型 / 阶段），默认「路径」。
 *
 * 纯展示组件：三个分段按钮，当前视图高亮；不理解 FileTreeEntry，只认
 * `FileTreeViewMode` 三个字面量。是否降级（R7）由 FileTree.vue 在下方内容区
 * 处理，这里不阻止切到会降级的视图——用户仍应能主动切过去看到"为什么现在
 * 没有内容"的提示，而不是被按钮禁用挡住。
 */
import type { FileTreeViewMode } from "../../domain/file-tree.ts";

defineProps<{
  modelValue: FileTreeViewMode;
}>();

const emit = defineEmits<{
  "update:modelValue": [mode: FileTreeViewMode];
}>();

const OPTIONS: ReadonlyArray<{ value: FileTreeViewMode; label: string }> = [
  { value: "path", label: "路径" },
  { value: "type", label: "产物类型" },
  { value: "stage", label: "阶段" },
];
</script>

<template>
  <div class="flex gap-[2px] rounded-md bg-hover p-[2px]" role="tablist" aria-label="文件树视图">
    <button
      v-for="opt in OPTIONS"
      :key="opt.value"
      type="button"
      role="tab"
      class="flex-1 cursor-pointer rounded-sm border-0 bg-transparent px-2 py-[3px] text-xs leading-[1.4] whitespace-nowrap transition-[background-color,color] duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]"
      :class="modelValue === opt.value ? 'bg-panel text-fg' : 'text-fg-secondary hover:text-fg'"
      :aria-selected="modelValue === opt.value"
      @click="emit('update:modelValue', opt.value)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>
