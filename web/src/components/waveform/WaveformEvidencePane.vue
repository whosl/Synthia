<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { getJobEvidenceContent } from "../../api/index.ts";
import { api } from "../../api/service.ts";
import { MAX_VCD_BYTES } from "../../domain/vcd.ts";
import WaveformViewer from "./WaveformViewer.vue";
const props = defineProps<{ projectId: string; jobId: string; name: string }>();
const content = ref<string | null>(null), error = ref("");
const truncated = ref(false), loading = ref(false);
let disposed = false;
onBeforeUnmount(() => { disposed = true; });
async function load(): Promise<void> {
  loading.value = true; error.value = "";
  try {
    const result = await getJobEvidenceContent(api, props.projectId, props.jobId, props.name);
    if (disposed) return;
    if (result.content.length > Math.ceil(MAX_VCD_BYTES / 3) * 4) throw new Error("波形超过 8 MiB 查看上限");
    content.value = result.encoding === "base64" ? new TextDecoder().decode(Uint8Array.from(atob(result.content), (c) => c.charCodeAt(0))) : result.content;
    truncated.value = result.truncated;
  } catch (e) { if (!disposed) error.value = e instanceof Error ? e.message : "波形读取失败"; }
  finally { if (!disposed) loading.value = false; }
}
onMounted(() => { void load(); });
</script>
<template>
  <div class="h-full min-h-0">
    <p v-if="loading" class="p-4 text-fg-muted" role="status">正在读取仿真波形…</p>
    <div v-else-if="error" class="p-4"><p role="alert">{{ error }}</p><button type="button" class="mt-2 text-brand" @click="load">重新加载波形</button></div>
    <WaveformViewer v-else-if="content !== null" :content="content" :name="name" :truncated="truncated" :source="`运行 ${jobId} · 只读证据`" />
  </div>
</template>
