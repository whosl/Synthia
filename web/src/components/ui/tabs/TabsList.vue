<script setup lang="ts">
import type { TabsListProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { TabsListVariants } from "."
import { reactiveOmit } from "@vueuse/core"
import { TabsList } from "reka-ui"
import { cn } from "@/lib/utils"
import { tabsListVariants } from "."

const props = defineProps<TabsListProps & { class?: HTMLAttributes["class"], variant?: TabsListVariants["variant"] }>()

const delegatedProps = reactiveOmit(props, "class", "variant")
</script>

<template>
  <TabsList
    data-slot="tabs-list"
    v-bind="delegatedProps"
    :class="cn(tabsListVariants({ variant }), props.class)"
  >
    <slot />
  </TabsList>
</template>
