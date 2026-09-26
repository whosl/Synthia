<script setup lang="ts">
import { computed } from "vue";
import type { TaskContextUsage } from "../../api/types.ts";
import { contextUsageDisplay } from "../../domain/context-usage.ts";

const props = defineProps<{ usage: TaskContextUsage }>();
const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const display = computed(() => contextUsageDisplay(props.usage));
const dashOffset = computed(() => CIRCUMFERENCE * (1 - display.value.fill));
</script>

<template>
  <span
    v-if="usage.context_window > 0"
    class="group inline-flex cursor-default items-center"
    :data-tone="display.tone"
    :title="display.title"
    :aria-label="display.title"
    role="img"
    tabindex="0"
  >
    <svg width="18" height="18" viewBox="0 0 18 18">
      <circle class="stroke-line" cx="9" cy="9" :r="RADIUS" fill="none" stroke-width="2.5" />
      <circle
        class="origin-center -rotate-90 transition-[stroke-dashoffset] duration-[400ms] ease-[ease] group-data-[tone=high]:stroke-danger group-data-[tone=low]:stroke-ok group-data-[tone=mid]:stroke-brand group-data-[tone=unknown]:stroke-fg-muted"
        cx="9"
        cy="9"
        :r="RADIUS"
        fill="none"
        stroke-width="2.5"
        :stroke-dasharray="CIRCUMFERENCE"
        :stroke-dashoffset="dashOffset"
      />
    </svg>
  </span>
</template>
