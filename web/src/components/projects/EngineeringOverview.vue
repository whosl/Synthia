<script setup lang="ts">
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import EngineeringOverviewPanel from "./EngineeringOverviewPanel.vue";
import type { EngineeringOverviewProps } from "../../domain/engineering-overview.ts";

const props = defineProps<EngineeringOverviewProps & { open: boolean }>();
const emit = defineEmits<{
  "update:open": [open: boolean];
  records: [jobId: string];
  collaborate: [];
}>();

function showRecord(jobId: string): void {
  emit("update:open", false);
  emit("records", jobId);
}

function collaborate(): void {
  emit("update:open", false);
  emit("collaborate");
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="engineering-dialog block max-h-[94dvh] w-[calc(100%-24px)] max-w-[1360px] overflow-y-auto border-line bg-base p-0 sm:max-w-[1360px]" :show-close-button="false">
      <DialogTitle class="visually-hidden">{{ projectName }} · 工程全景</DialogTitle>
      <DialogDescription class="visually-hidden">项目设计、验证与交付进展</DialogDescription>
      <EngineeringOverviewPanel v-bind="props" @close="emit('update:open', false)" @records="showRecord" @collaborate="collaborate" />
    </DialogContent>
  </Dialog>
</template>
