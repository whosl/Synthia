<script setup lang="ts">
import { Check, Minus, X } from "lucide-vue-next";
import type { G4CheckRow } from "../../domain/formal-delivery.ts";
import Badge from "../ui/AppBadge.vue";

defineProps<{
  readonly g4Checks: readonly G4CheckRow[];
}>();
</script>

<template>
  <section class="grid min-w-0 gap-3 rounded-lg border border-line bg-base p-4 max-[720px]:p-3">
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="m-0 text-[11px] font-bold tracking-[0.08em] text-fg-muted uppercase">G4</p>
        <h3 class="m-0">Hard checks</h3>
      </div>
      <Badge size="sm" class="font-bold" :tone="g4Checks.length && g4Checks.every((check) => check.status === 'passed') ? 'ok' : 'warn'">
        {{ g4Checks.filter((check) => check.status === 'passed').length }}/{{ g4Checks.length }} 通过
      </Badge>
    </div>
    <ul v-if="g4Checks.length" class="m-0 grid list-none grid-cols-2 gap-[5px] p-0 max-[720px]:grid-cols-1">
      <li
        v-for="check in g4Checks"
        :key="check.code"
        class="flex items-center gap-2 rounded-sm bg-hover px-2 py-[7px] text-xs"
        :class="check.status === 'passed' ? 'text-ok' : check.status === 'failed' ? 'text-danger' : ''"
      >
        <Check v-if="check.status === 'passed'" :size="14" aria-hidden="true" class="shrink-0" />
        <X v-else-if="check.status === 'failed'" :size="14" aria-hidden="true" class="shrink-0" />
        <Minus v-else :size="14" aria-hidden="true" class="shrink-0" />
        <strong class="flex-1 font-semibold text-fg">{{ check.label }}</strong>
        <small class="text-fg-muted">{{ check.severity === "hard" ? "阻断项" : "提示项" }}</small>
      </li>
    </ul>
    <p v-else class="m-0 p-4 text-center text-fg-muted">尚无 G4 evaluation；任何缺失项都不会被当作通过。</p>
  </section>
</template>
