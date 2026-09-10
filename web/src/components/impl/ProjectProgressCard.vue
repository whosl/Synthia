<script setup lang="ts">
/**
 * 项目进度卡：Core 正式流程 G0–G4 门链的紧凑横条（复用 StageRail 渲染），
 * 供页面顶部「项目进度 + 物理实现」进度带使用。自由/兼容项目显示占位文案。
 *
 * 受控组件：stageChain 由父级从 Core 流程投影推导传入。
 */
import { computed } from "vue";
import StageRail from "../layout/StageRail.vue";
import type { ProcessGateView } from "../../domain/process-profile.ts";
import { processProgress } from "../../domain/process-profile.ts";

const props = defineProps<{
  /** G0–G4 门链投影；null 表示当前项目没有正式阶段链（自由/兼容流程）。 */
  readonly stageChain: readonly ProcessGateView[] | null;
  /** 没有阶段链时的准确占位文案。 */
  readonly emptyText: string;
}>();

const emit = defineEmits<{ "select-stage": [stageId: string] }>();

const progress = computed(() => (props.stageChain ? processProgress(props.stageChain) : null));
</script>

<template>
  <section class="project-progress-card" aria-label="项目进度">
    <header class="project-progress-head">
      <h3>项目进度</h3>
      <span v-if="progress" class="project-progress-count">{{ progress.done }}/{{ progress.total }}</span>
    </header>
    <StageRail
      :stage-chain="props.stageChain"
      :empty-text="props.emptyText"
      @select-stage="(id) => emit('select-stage', id)"
    />
  </section>
</template>

<style scoped>
.project-progress-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}

.project-progress-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.project-progress-head h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.project-progress-count {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}
</style>
