<script setup lang="ts">
/**
 * 危险操作二次确认（Archive / 禁用类不可逆写）：标题说清动作对象，
 * 描述说清后果，确认按钮用 danger（应用级 destructive）。确认动作本身
 * 仍由调用方在 confirm 事件里执行，本组件不持有业务语义。
 */
import Button from "./ui/AppButton.vue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

defineProps<{
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
}>();

const emit = defineEmits<{
  confirm: [];
  "update:open": [open: boolean];
}>();
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      class="w-[min(440px,calc(100vw-32px))] gap-0 rounded-xl border-line bg-panel p-6 shadow-[0_24px_80px_var(--shadow-color)]"
    >
      <DialogHeader class="gap-2">
        <DialogTitle class="m-0 text-base leading-[1.5]">{{ title }}</DialogTitle>
        <DialogDescription class="m-0 text-[13px] leading-[1.7] text-fg-secondary">
          {{ description }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter class="mt-5">
        <Button @click="emit('update:open', false)">取消</Button>
        <Button variant="danger" @click="emit('confirm')">{{ confirmLabel }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
