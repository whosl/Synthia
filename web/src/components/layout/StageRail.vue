<script setup lang="ts">
/** Core-owned G0-G4 rail. Node order and copy are supplied by process-profile.v1. */
import { computed, ref } from "vue";
import type { ProcessGateView, ProcessGateStatus } from "../../domain/process-profile.ts";
import {
  currentProcessGate,
  processProgress,
  PROCESS_GATE_STATUS_TEXT,
} from "../../domain/process-profile.ts";
import { Dialog, DialogContent } from "../ui/dialog";

const props = defineProps<{
  readonly stageChain: readonly ProcessGateView[] | null;
  readonly emptyText: string;
}>();

const emit = defineEmits<{ "select-stage": [stageId: string] }>();
const mobileOverlayOpen = ref(false);
const current = computed(() => currentProcessGate(props.stageChain));
const progress = computed(() => props.stageChain ? processProgress(props.stageChain) : { done: 0, total: 0 });

function statusText(status: ProcessGateStatus): string {
  return PROCESS_GATE_STATUS_TEXT[status];
}

function select(stageId: string): void {
  emit("select-stage", stageId);
}
</script>

<template>
  <div class="flex h-full w-full min-w-0 items-center" aria-label="G0 至 G4 工程流程">
    <div v-if="!stageChain" class="text-xs text-fg-muted">{{ emptyText }}</div>
    <template v-else>
      <ol class="m-0 flex w-full min-w-0 list-none items-center p-0 max-[767px]:hidden">
        <li v-for="(entry, index) in stageChain" :key="entry.node.id" class="flex min-w-0 flex-1 items-center">
          <span
            v-if="index > 0"
            class="h-[2px] flex-1 basis-4 bg-line-strong data-[state=done]:bg-ok"
            :data-state="entry.status"
            aria-hidden="true"
          />
          <button
            type="button"
            class="group grid min-w-0 cursor-pointer grid-cols-[auto_auto] grid-rows-[auto_auto] gap-x-[5px] rounded-sm border-0 bg-transparent px-[5px] py-[2px] text-left text-fg-muted hover:bg-hover focus-visible:bg-hover data-[state=current]:text-fg data-[state=done]:text-fg data-[state=failed]:text-danger data-[state=gated]:text-warn"
            :data-state="entry.status"
            :aria-current="entry.status === 'current' || entry.status === 'gated' || entry.status === 'failed' ? 'step' : undefined"
            :title="`${entry.node.id} · ${entry.node.name} · ${statusText(entry.status)}\n${entry.node.goal}`"
            @click="select(entry.node.id)"
          >
            <!--
              状态点配色对齐 ProjectProgressChip 的门语义（done→ok / gated→warn）。
              旧 scoped CSS 写的是 --state-success / --state-warning——这两个变量在
              style.css 里不存在，规则静默失效；这里用现行令牌补上原设计意图。
            -->
            <span
              class="row-span-2 size-[9px] self-center rounded-full border-2 border-line-strong group-data-[state=current]:border-brand group-data-[state=current]:bg-brand group-data-[state=current]:shadow-[0_0_0_3px_var(--accent-subtle)] group-data-[state=done]:border-ok group-data-[state=done]:bg-ok group-data-[state=failed]:border-danger group-data-[state=failed]:bg-danger group-data-[state=gated]:border-warn group-data-[state=gated]:bg-warn"
              aria-hidden="true"
            />
            <span class="text-[10px] leading-none font-bold text-inherit">{{ entry.node.id }}</span>
            <span class="max-w-[92px] truncate text-[11px] leading-[1.2] text-inherit">{{ entry.node.name }}</span>
          </button>
        </li>
      </ol>

      <button
        type="button"
        class="hidden w-full cursor-pointer rounded-sm border border-line bg-hover px-2 py-[5px] text-left text-xs text-fg max-[767px]:block"
        @click="mobileOverlayOpen = true"
      >
        <template v-if="current">
          {{ current.node.id }} {{ current.node.name }} · {{ statusText(current.status) }} · {{ progress.done }}/{{ progress.total }}
        </template>
      </button>

      <!-- 窄屏底部弹层：ui/dialog 提供 portal/焦点圈定/Esc/点外关闭（迁移计划 §4 映射）。 -->
      <Dialog v-model:open="mobileOverlayOpen">
        <DialogContent
          :show-close-button="false"
          aria-label="工程流程详情"
          class="top-auto bottom-0 left-0 max-h-[88vh] w-full max-w-full translate-x-0 translate-y-0 overflow-y-auto rounded-b-none border-0 bg-panel p-4 shadow-none sm:max-w-full"
        >
          <header class="flex items-start justify-between gap-3">
            <div>
              <strong>G0–G4 工程流程</strong>
              <p class="m-0 mt-[3px] text-xs text-fg-muted">{{ progress.done }}/{{ progress.total }} 已完成</p>
            </div>
            <button type="button" class="cursor-pointer border-0 bg-transparent text-brand" @click="mobileOverlayOpen = false">关闭</button>
          </header>
          <ol class="m-0 grid list-none gap-2 p-0">
            <li v-for="entry in stageChain" :key="entry.node.id">
              <button
                type="button"
                class="grid w-full cursor-pointer grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-line bg-base p-3 text-left text-fg data-[state=current]:border-brand data-[state=failed]:border-danger data-[state=gated]:border-brand"
                :data-state="entry.status"
                @click="select(entry.node.id); mobileOverlayOpen = false"
              >
                <span class="text-xs font-bold text-fg-secondary">{{ entry.node.id }}</span>
                <span class="grid min-w-0 gap-[3px]">
                  <strong>{{ entry.node.name }}</strong>
                  <small class="leading-[1.35] text-fg-muted">{{ entry.node.goal }}</small>
                </span>
                <span class="text-xs font-bold text-fg-secondary">{{ statusText(entry.status) }}</span>
              </button>
            </li>
          </ol>
        </DialogContent>
      </Dialog>
    </template>
  </div>
</template>
