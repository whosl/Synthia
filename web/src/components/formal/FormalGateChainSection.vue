<script setup lang="ts">
import type {
  ProcessProfileV1,
  ProjectWorkVersionV1,
} from "../../api/types.ts";
import {
  PROCESS_GATE_STATUS_TEXT,
  type ProcessGateView,
} from "../../domain/process-profile.ts";

defineProps<{
  readonly profile: ProcessProfileV1 | null;
  readonly gateChain: readonly ProcessGateView[] | null;
  readonly workVersion: ProjectWorkVersionV1 | null;
}>();
</script>

<template>
  <section class="grid min-w-0 gap-3 rounded-lg border border-line bg-base p-4 max-[720px]:p-3">
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="m-0 text-[11px] font-bold tracking-[0.08em] text-fg-muted uppercase">G0–G4</p>
        <h3 class="m-0">{{ profile?.name ?? "工程流程" }}</h3>
      </div>
      <small v-if="workVersion" class="text-fg-muted">工作版本 v{{ workVersion.version }} · {{ workVersion.state === 'released' ? '已发布' : '工作中' }}</small>
    </div>
    <ol v-if="gateChain" class="m-0 grid list-none grid-cols-5 gap-2 p-0 max-[720px]:grid-cols-1">
      <li
        v-for="entry in gateChain"
        :key="entry.node.id"
        class="grid min-w-0 gap-[5px] rounded-md border p-2 max-[720px]:grid-cols-[36px_minmax(0,1fr)_auto] max-[720px]:items-center"
        :class="entry.status === 'current' || entry.status === 'gated' ? 'border-brand' : entry.status === 'failed' ? 'border-danger' : 'border-line'"
      >
        <span class="text-[10px] font-bold text-fg-muted">{{ entry.node.id }}</span>
        <span class="grid gap-[3px]">
          <strong>{{ entry.node.name }}</strong>
          <small class="line-clamp-3 text-[11px] leading-[1.35] text-fg-muted">{{ entry.node.goal }}</small>
        </span>
        <span class="text-[10px] font-bold text-fg-muted">{{ PROCESS_GATE_STATUS_TEXT[entry.status] }}</span>
      </li>
    </ol>
    <p v-else class="m-0 p-4 text-center text-fg-muted">Core 尚未返回可验证的 G0–G4 状态，正式操作保持锁定。</p>
  </section>
</template>
