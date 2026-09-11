<script setup lang="ts">
/**
 * 项目概览 chip（顶栏样式 D）：pill 收入「项目类型 · 器件 · 进度摘要」，
 * 点击展开完整项目信息（类型/流程/器件）+ G0–G4 门链进度。自由/兼容项目
 * 没有门链时进度区退化为 muted 占位文案，项目信息区照常展示。
 *
 * 受控组件：stageChain/projectInfo 由父级传入；点击门行 emit select-stage
 * 联动左栏阶段视图。
 */
import { computed } from "vue";
import type { ProcessGateView } from "../../domain/process-profile.ts";
import { currentProcessGate, processProgress, PROCESS_GATE_STATUS_TEXT } from "../../domain/process-profile.ts";
import { useChipPopover } from "../../composables/use-chip-popover.ts";

const props = defineProps<{
  /** 项目信息区（类型/流程/器件），来自项目详情。 */
  readonly typeLabel: string;
  readonly profileLabel: string | null;
  readonly targetPart: string | null;
  /** G0–G4 门链投影；null 表示当前项目没有正式阶段链。 */
  readonly stageChain: readonly ProcessGateView[] | null;
  /** 没有阶段链时的准确占位文案。 */
  readonly emptyText: string;
}>();

const emit = defineEmits<{ "select-stage": [stageId: string] }>();

const { root, open, onEnter, onLeave, toggle, close } = useChipPopover();

const progress = computed(() => (props.stageChain ? processProgress(props.stageChain) : null));
const current = computed(() => currentProcessGate(props.stageChain));
const partText = computed(() => props.targetPart || "未设器件");
const chipText = computed(() => {
  const base = `${props.typeLabel || "…"} · ${partText.value}`;
  if (!progress.value) return base;
  const suffix = current.value
    ? `${progress.value.done}/${progress.value.total} · ${current.value.node.id} ${PROCESS_GATE_STATUS_TEXT[current.value.status]}`
    : `${progress.value.done}/${progress.value.total}`;
  return `${base} · ${suffix}`;
});

function select(stageId: string): void {
  close();
  emit("select-stage", stageId);
}
</script>

<template>
  <div ref="root" class="relative inline-flex min-w-0" @mouseenter="onEnter" @mouseleave="onLeave">
    <button
      type="button"
      class="inline-flex max-w-[380px] cursor-pointer items-center gap-1.5 rounded-full border border-line-strong bg-transparent px-[11px] py-[3px] text-xs whitespace-nowrap text-fg hover:border-brand hover:bg-brand-subtle"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="font-semibold">项目概览</span>
      <span class="truncate text-fg-secondary">{{ chipText }}</span>
      <span class="text-[9px] text-fg-muted" aria-hidden="true">▾</span>
    </button>

    <div
      v-if="open"
      class="absolute top-[calc(100%+10px)] left-0 z-[100] w-[320px] rounded-[10px] border border-line-strong bg-raised px-4 py-3.5 shadow-[0_14px_38px_var(--shadow-color)]"
      role="menu"
    >
      <h4 class="m-0 mb-2.5 text-[11px] font-semibold text-fg-muted">项目信息</h4>
      <dl class="m-0 flex flex-col gap-[5px]">
        <div class="flex gap-3 text-xs"><dt class="w-[30px] flex-none text-fg-muted">类型</dt><dd class="m-0 wrap-anywhere text-fg">{{ typeLabel }}</dd></div>
        <div v-if="profileLabel" class="flex gap-3 text-xs"><dt class="w-[30px] flex-none text-fg-muted">流程</dt><dd class="m-0 wrap-anywhere text-fg">{{ profileLabel }}</dd></div>
        <div class="flex gap-3 text-xs"><dt class="w-[30px] flex-none text-fg-muted">器件</dt><dd class="m-0 wrap-anywhere text-fg">{{ partText }}</dd></div>
      </dl>

      <h4 class="m-0 mt-3.5 mb-2.5 border-t border-dashed border-line pt-3 text-[11px] font-semibold text-fg-muted">项目进度</h4>
      <div v-if="stageChain" class="flex flex-col gap-1">
        <button
          v-for="entry in stageChain"
          :key="entry.node.id"
          type="button"
          class="group flex w-full cursor-pointer items-center gap-[9px] rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-xs text-fg hover:bg-hover"
          :data-state="entry.status"
          @click="select(entry.node.id)"
        >
          <span
            class="size-2 flex-none rounded-full border-2 border-line-strong group-data-[state=current]:border-brand group-data-[state=current]:bg-brand group-data-[state=done]:border-ok group-data-[state=done]:bg-ok group-data-[state=failed]:border-danger group-data-[state=failed]:bg-danger group-data-[state=gated]:border-warn group-data-[state=gated]:bg-warn"
          />
          <span class="flex-none tabular-nums group-data-[state=current]:text-brand">{{ entry.node.id }} {{ entry.node.name }}</span>
          <span class="ml-auto text-[11px] text-fg-muted group-data-[state=failed]:text-danger group-data-[state=gated]:text-brand">{{ PROCESS_GATE_STATUS_TEXT[entry.status] }}</span>
        </button>
      </div>
      <p v-else class="m-0 text-xs text-fg-muted">{{ emptyText }}</p>
    </div>
  </div>
</template>
