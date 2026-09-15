<script setup lang="ts">
import type { DialogOverlayProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { DialogOverlay } from "reka-ui"
import { cn } from "@/lib/utils"

const props = defineProps<DialogOverlayProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <DialogOverlay
    data-slot="sheet-overlay"
    v-bind="delegatedProps"
    :class="cn('fixed inset-0 z-[var(--z-overlay)] bg-[#11121680] backdrop-blur-[5px] transition-opacity duration-300 data-[state=closed]:opacity-0', props.class)"
  >
    <slot />
  </DialogOverlay>
</template>
