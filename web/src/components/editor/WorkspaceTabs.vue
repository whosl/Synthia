<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { Activity, FileText, Layers, ShieldCheck, X } from "lucide-vue-next";

const props = defineProps<{
  tabs: readonly { id: string; label: string; description?: string; kind: "overview" | "reviews" | "file" | "waveform"; dirty?: boolean; saving?: boolean; count?: number }[];
  activeId: string;
}>();
const emit = defineEmits<{ select: [id: string]; close: [id: string] }>();
const strip = ref<HTMLElement | null>(null);
watch(() => props.activeId, async () => {
  await nextTick();
  strip.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
});
function navigate(event: KeyboardEvent, index: number): void {
  let target: number;
  if (event.key === "ArrowRight") target = (index + 1) % props.tabs.length;
  else if (event.key === "ArrowLeft") target = (index - 1 + props.tabs.length) % props.tabs.length;
  else if (event.key === "Home") target = 0;
  else if (event.key === "End") target = props.tabs.length - 1;
  else if (event.key === "Delete" && (props.tabs[index]?.kind === "file" || props.tabs[index]?.kind === "waveform")) {
    event.preventDefault();
    emit("close", props.tabs[index]!.id);
    return;
  } else return;
  event.preventDefault();
  emit("select", props.tabs[target]!.id);
  void nextTick(() => strip.value?.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus());
}
</script>

<template>
  <div ref="strip" class="workspace-tabs" role="tablist" aria-label="项目工作区标签">
    <div v-for="(tab, index) in tabs" :key="tab.id" class="workspace-tab" :class="{ active: activeId === tab.id }" @auxclick.middle.prevent="(tab.kind === 'file' || tab.kind === 'waveform') && emit('close', tab.id)">
      <button type="button" role="tab" :aria-selected="activeId === tab.id" :tabindex="activeId === tab.id ? 0 : -1" :title="tab.description ?? tab.label" @click="emit('select', tab.id)" @keydown="navigate($event, index)">
        <component :is="tab.kind === 'overview' ? Layers : tab.kind === 'reviews' ? ShieldCheck : tab.kind === 'waveform' ? Activity : FileText" :size="14" aria-hidden="true" />
        <span class="tab-label">{{ tab.label }}</span>
        <span v-if="tab.count" class="tab-count">{{ tab.count }}</span>
        <span v-if="tab.dirty" class="dirty-dot" aria-label="未保存">●</span>
      </button>
      <button v-if="tab.kind === 'file' || tab.kind === 'waveform'" type="button" class="tab-close" :disabled="tab.saving" :aria-label="`关闭 ${tab.label}`" @click="emit('close', tab.id)"><X :size="13" /></button>
    </div>
  </div>
</template>

<style scoped>
.workspace-tabs { display: flex; flex: none; min-width: 0; overflow-x: auto; gap: 4px; padding: 8px; border-bottom: 1px solid var(--border-subtle); background: var(--surface-panel); scrollbar-width: thin; }
.workspace-tab { display: flex; flex: none; align-items: center; border: 0; border-radius: 8px; color: var(--text-secondary); }
.workspace-tab.active { background: var(--surface-hover); color: var(--text-primary); }
.workspace-tab > button { display: flex; align-items: center; gap: 8px; height: 32px; border-radius: 8px; padding: 0 12px; border: none; background: transparent; color: inherit; cursor: pointer; font-size: 12px; }
.workspace-tab > button:hover { background: var(--surface-hover); }
.workspace-tab > button:focus-visible { outline: 1px solid var(--accent); outline-offset: -3px; }
.tab-label { max-width: 180px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.workspace-tab > .tab-close { width: 26px; padding: 0 5px; margin-right: 3px; }
.tab-close:disabled { opacity: .4; cursor: wait; }
.tab-count { border-radius: 8px; padding: 1px 5px; background: var(--accent-subtle); color: var(--accent); font-size: 10px; }
.dirty-dot { font-size: 8px; color: var(--accent); }
</style>
