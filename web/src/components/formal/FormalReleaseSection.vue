<script setup lang="ts">
import type {
  DeliveryManifestV1,
  DeliveryReleaseDetailV1,
  DeliveryReleaseSummaryV1,
} from "../../api/types.ts";
import { DELIVERY_CATEGORY_TEXT } from "../../domain/formal-delivery.ts";
import { formatDateTime } from "../../util/format-time.ts";
import Badge from "../ui/AppBadge.vue";
import Button from "../ui/AppButton.vue";
import { formatBytes, shortHash } from "./format.ts";

defineProps<{
  readonly releases: readonly DeliveryReleaseSummaryV1[];
  readonly selectedReleaseId: string | null;
  readonly selectedRelease: DeliveryReleaseDetailV1 | null;
  readonly manifest: DeliveryManifestV1 | null;
  readonly operating: boolean;
}>();

const emit = defineEmits<{
  "select-release": [releaseId: string];
  "download-item": [path: string];
  "download-manifest": [];
}>();
</script>

<template>
  <section class="grid min-w-0 gap-3 rounded-lg border border-line bg-base p-4 max-[720px]:p-3">
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="m-0 text-[11px] font-bold tracking-[0.08em] text-fg-muted uppercase">交付</p>
        <h3 class="m-0">已密封版本与 manifest</h3>
      </div>
    </div>
    <div v-if="releases.length" class="grid grid-cols-[160px_minmax(0,1fr)] gap-3 max-[720px]:grid-cols-1">
      <nav class="grid content-start gap-2 max-[720px]:grid-cols-[repeat(auto-fit,minmax(110px,1fr))]" aria-label="交付版本">
        <button
          v-for="(release, index) in releases"
          :key="release.id"
          type="button"
          class="grid gap-[3px] rounded-md border bg-transparent p-2 text-left text-fg"
          :class="release.id === selectedReleaseId ? 'border-brand bg-brand-subtle' : 'border-line'"
          @click="emit('select-release', release.id)"
        >
          <strong>v{{ release.version }}</strong>
          <span class="text-[11px] text-fg-muted">{{ index === 0 ? "当前密封版" : "历史密封版" }}</span>
          <small class="text-[11px] text-fg-muted">{{ release.item_count }} 项</small>
        </button>
      </nav>
      <div v-if="selectedRelease" class="grid min-w-0 gap-3">
        <Button
          v-if="manifest"
          variant="ghost"
          class="w-max rounded-sm border border-brand px-2 text-brand hover:bg-brand-subtle hover:text-brand"
          :disabled="operating"
          @click="emit('download-manifest')"
        >
          下载 delivery-manifest.v1
        </Button>
        <dl class="m-0 grid grid-cols-2 gap-2 max-[720px]:grid-cols-1">
          <div class="grid min-w-0 gap-[3px] rounded-sm bg-hover p-2">
            <dt class="text-[11px] text-fg-muted">清单摘要</dt>
            <dd class="m-0 overflow-hidden font-mono text-[11px] text-ellipsis">{{ shortHash(selectedRelease.manifest_hash) }}</dd>
          </div>
          <div class="grid min-w-0 gap-[3px] rounded-sm bg-hover p-2">
            <dt class="text-[11px] text-fg-muted">确认人</dt>
            <dd class="m-0 overflow-hidden text-ellipsis">{{ selectedRelease.confirmed_by ?? "待确认" }}</dd>
          </div>
          <div class="grid min-w-0 gap-[3px] rounded-sm bg-hover p-2">
            <dt class="text-[11px] text-fg-muted">发布时间</dt>
            <dd class="m-0 overflow-hidden text-ellipsis">{{ formatDateTime(selectedRelease.released_at) }}</dd>
          </div>
          <div class="grid min-w-0 gap-[3px] rounded-sm bg-hover p-2">
            <dt class="text-[11px] text-fg-muted">清单版本</dt>
            <dd class="m-0 overflow-hidden text-ellipsis">{{ manifest?.schema ?? "—" }}</dd>
          </div>
        </dl>
        <ul class="m-0 grid list-none gap-1 p-0">
          <li
            v-for="item in selectedRelease.items"
            :key="item.id"
            class="grid grid-cols-[80px_minmax(0,1fr)_70px_auto] items-center gap-2 border-b border-line py-1.5 text-xs max-[720px]:grid-cols-[74px_minmax(0,1fr)_auto]"
          >
            <Badge size="sm" class="font-bold">{{ DELIVERY_CATEGORY_TEXT[item.category] ?? "工程文件" }}</Badge>
            <span class="min-w-0 truncate">{{ item.path }}</span>
            <span class="max-[720px]:hidden">{{ formatBytes(item.size_bytes) }}</span>
            <Button
              variant="ghost"
              size="sm"
              class="h-auto px-1 text-brand hover:text-brand-hover"
              :disabled="operating"
              @click="emit('download-item', item.path)"
            >
              下载
            </Button>
          </li>
        </ul>
      </div>
    </div>
    <p v-else class="m-0 p-4 text-center text-fg-muted">尚无正式交付版本。只有通过 G4 的正式码流和冻结证据才能进入这里。</p>
  </section>
</template>
