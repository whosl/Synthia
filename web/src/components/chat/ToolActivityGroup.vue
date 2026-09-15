<script setup lang="ts">
/**
 * 工具活动折叠组（≥2 条连续工具调用的显示层折叠；顺序不变，见
 * domain/chat-groups.ts 与 ChatFeed.vue 头注的铁律补充）。
 *
 * 头部单行：状态点（优先级 error > 进行中 > 全部完成）+「N 项工具活动 · 耗时
 * · N 失败」+ 展开箭头。默认态：全部终态 → 收起；仍有 pending/running → 展开
 * （进行中的工作不藏进折叠里）。用户手动切换后保持，直到组的条目构成（id 序列）
 * 变化——新工具加入或流式重排——才按当前 active 态重置。
 *
 * 展开体原样渲染 ToolCallItem/AgentToolItem，`open-records` 原样向上透传。
 */
import { computed, ref, watch } from "vue";
import { ChevronRight } from "lucide-vue-next";
import type { ToolActivityGroup } from "../../domain/chat-groups.ts";
import { formatDuration } from "../../domain/tasks.ts";
import AgentToolItem from "./AgentToolItem.vue";
import ToolCallItem from "./ToolCallItem.vue";

const props = defineProps<{ group: ToolActivityGroup }>();
const emit = defineEmits<{ "open-records": [jobId: string] }>();

const touched = ref(false);
const expanded = ref(props.group.active);

function toggle(): void {
  touched.value = true;
  expanded.value = !expanded.value;
}

// 条目构成（id 序列）变化 → 丢弃用户选择，按当前 active 态重新决定默认展开。
watch(
  () => props.group.items.map((item) => item.part.id).join(","),
  () => {
    touched.value = false;
    expanded.value = props.group.active;
  },
);

// 全部终态 ↔ 仍有进行中：用户没动过就跟随默认态（做完自动收起降噪，
// 新活进来自动展开）；动过就保持用户的选择，直到条目构成变化。
watch(
  () => props.group.active,
  (active) => {
    if (!touched.value) expanded.value = active;
  },
);

const status = computed<"error" | "active" | "ok">(() =>
  props.group.errors > 0 ? "error" : props.group.active ? "active" : "ok",
);

const durationText = computed(() =>
  props.group.durationMs !== null && props.group.durationMs > 0
    ? formatDuration(props.group.durationMs)
    : null,
);
</script>

<template>
  <div class="flex flex-col gap-1">
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2 rounded-sm border-none bg-hover px-2 py-1 text-left text-xs text-fg-secondary transition-colors duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:text-fg"
      :aria-expanded="expanded"
      @click="toggle"
    >
      <span
        class="h-[7px] w-[7px] flex-none rounded-full"
        :class="status === 'error' ? 'bg-danger' : status === 'active' ? 'animate-pulse bg-brand' : 'bg-ok'"
        aria-hidden="true"
      ></span>
      <span class="min-w-0 flex-1 truncate">
        {{ group.total }} 项工具活动<template v-if="durationText"> · {{ durationText }}</template><template v-if="group.errors > 0"> · {{ group.errors }} 失败</template>
      </span>
      <ChevronRight
        :size="13"
        class="flex-none text-fg-muted transition-transform duration-150"
        :class="expanded ? 'rotate-90' : ''"
        aria-hidden="true"
      />
    </button>

    <div v-if="expanded" class="ml-[7px] flex flex-col gap-1 border-l border-line pl-2">
      <template v-for="item in group.items" :key="item.part.id">
        <ToolCallItem
          v-if="item.part.kind === 'tool'"
          :part="item.part"
          @open-records="emit('open-records', $event)"
        />
        <AgentToolItem v-else :part="item.part" />
      </template>
    </div>
  </div>
</template>
