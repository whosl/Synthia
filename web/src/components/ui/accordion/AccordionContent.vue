<script setup lang="ts">
import type { AccordionContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { AccordionContent } from "reka-ui"
import { cn } from "@/lib/utils"

const props = defineProps<AccordionContentProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <AccordionContent
    data-slot="accordion-content"
    v-bind="delegatedProps"
    class="grid grid-rows-[0fr] overflow-hidden text-sm transition-[grid-template-rows] duration-200 ease-out data-[state=open]:grid-rows-[1fr]"
  >
    <div :class="cn('min-h-0 pt-0 pb-4', props.class)">
      <slot />
    </div>
  </AccordionContent>
</template>
