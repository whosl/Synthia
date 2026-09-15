<script setup lang="ts">
import type { BitstreamResultV1 } from "../../api/types.ts";
import { bitstreamClassText } from "../../domain/formal-delivery.ts";
import { formatDateTime } from "../../util/format-time.ts";
import Badge from "../ui/AppBadge.vue";
import { formatBytes, shortHash } from "./format.ts";

defineProps<{
  readonly bitstreams: readonly BitstreamResultV1[];
}>();
</script>

<template>
  <section class="grid min-w-0 gap-3 rounded-lg border border-line bg-base p-4 max-[720px]:p-3">
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="m-0 text-[11px] font-bold tracking-[0.08em] text-fg-muted uppercase">结果</p>
        <h3 class="m-0">码流分类</h3>
      </div>
    </div>
    <div v-if="bitstreams.length" class="grid gap-2">
      <article v-for="bitstream in bitstreams" :key="bitstream.id" class="flex items-center gap-3 rounded-md border border-line p-2">
        <Badge size="sm" class="font-bold" :tone="bitstream.class === 'formal' ? 'ok' : 'warn'">{{ bitstreamClassText(bitstream.class) }}</Badge>
        <div class="grid min-w-0 flex-1 gap-[2px]">
          <strong>{{ bitstream.target_part }}</strong>
          <small class="text-fg-muted">{{ formatDateTime(bitstream.generated_at) }}</small>
        </div>
        <span>{{ formatBytes(bitstream.size_bytes) }}</span>
        <code class="text-[10px] text-fg-muted">{{ shortHash(bitstream.sha256) }}</code>
      </article>
    </div>
    <p v-else class="m-0 p-4 text-center text-fg-muted">尚无码流。试验结果不会被升级或混入正式交付。</p>
  </section>
</template>
