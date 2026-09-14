<script setup lang="ts">
import type { TabsTriggerProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { TabsTriggerVariants } from "."
import { reactiveOmit } from "@vueuse/core"
import { TabsTrigger, useForwardProps } from "reka-ui"
import { cn } from "@/lib/utils"
import { tabsTriggerVariants } from "."

const props = defineProps<TabsTriggerProps & { class?: HTMLAttributes["class"], variant?: TabsTriggerVariants["variant"] }>()

const delegatedProps = reactiveOmit(props, "class", "variant")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <TabsTrigger
    data-slot="tabs-trigger"
    :class="cn(tabsTriggerVariants({ variant }), props.class)"
    v-bind="forwardedProps"
  >
    <slot />
  </TabsTrigger>
</template>
