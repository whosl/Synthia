<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AdoptSideTaskRequest, SideTaskDiff } from "../../api/types.ts";
import { buildSideTaskAdoptionRequest, formatSideTaskHash } from "../../domain/side-tasks.ts";
import Badge from "../ui/AppBadge.vue";
import Button from "../ui/AppButton.vue";
import { Checkbox } from "../ui/checkbox";
import { Textarea } from "../ui/textarea";

const props = defineProps<{
  diff: SideTaskDiff;
  operating: boolean;
}>();

const emit = defineEmits<{
  adopt: [request: AdoptSideTaskRequest];
}>();

const adoptionReason = ref("");
const adoptionError = ref<string | null>(null);
const selectedPaths = ref<Set<string>>(new Set());

const selectableFiles = computed(() => props.diff.files.filter(
  (file) => !file.adopted && file.conflict_reason === null,
));

watch(
  () => props.diff.preview_hash,
  () => {
    selectedPaths.value = new Set();
    adoptionReason.value = "";
    adoptionError.value = null;
  },
);

function togglePath(path: string): void {
  const file = props.diff.files.find((candidate) => candidate.path === path);
  if (!file || file.adopted || file.conflict_reason !== null) return;
  const next = new Set(selectedPaths.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  selectedPaths.value = next;
}

function selectAllAvailable(): void {
  selectedPaths.value = new Set(selectableFiles.value.map((file) => file.path));
}

function submitAdoption(): void {
  adoptionError.value = null;
  const parsed = buildSideTaskAdoptionRequest(
    props.diff,
    selectedPaths.value,
    adoptionReason.value,
    `adopt-${crypto.randomUUID()}`,
  );
  if (!parsed.ok) {
    adoptionError.value = parsed.message;
    return;
  }
  emit("adopt", parsed.request);
}
</script>

<template>
  <section class="mt-5">
    <div class="flex items-end justify-between gap-3">
      <div>
        <h4 class="m-0">文本差异</h4>
        <p class="mt-1 mb-0 text-xs text-fg-secondary">仅选择无冲突、未采纳的文件。任一选中文件冲突时整批不会写入。</p>
      </div>
      <button type="button" class="flex-none cursor-pointer border-0 bg-transparent p-0 text-xs text-brand" @click="selectAllAvailable">选择全部可采纳</button>
    </div>

    <article v-for="file in diff.files" :key="file.path" class="mt-3 overflow-hidden rounded-md border border-line">
      <header class="flex items-center justify-between gap-3 bg-hover px-3 py-2 max-[720px]:flex-col max-[720px]:items-start">
        <div class="flex min-w-0 items-center gap-2">
          <Checkbox
            :model-value="selectedPaths.has(file.path)"
            :disabled="file.adopted || file.conflict_reason !== null || operating"
            :aria-label="`选择 ${file.path}`"
            @update:model-value="togglePath(file.path)"
          />
          <code class="min-w-0 truncate">{{ file.path }}</code>
        </div>
        <span class="flex flex-wrap gap-1">
          <Badge v-if="file.adopted" tone="neutral" size="sm">已采纳</Badge>
          <Badge v-else-if="file.conflict_reason" tone="danger" size="sm">有冲突</Badge>
          <Badge v-else tone="ok" size="sm">可采纳</Badge>
          <Badge tone="neutral" size="sm">{{ file.change_kind === "added" ? "新增" : "修改" }}</Badge>
        </span>
      </header>
      <dl class="m-0 grid grid-cols-3 gap-2 border-t border-line bg-base px-3 py-2 max-[720px]:grid-cols-1">
        <div class="min-w-0">
          <dt class="text-xs text-fg-muted">探索起点哈希</dt>
          <dd class="m-0 mt-[2px]"><code class="wrap-anywhere text-fg-secondary">{{ formatSideTaskHash(file.base_hash) }}</code></dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs text-fg-muted">候选内容哈希</dt>
          <dd class="m-0 mt-[2px]"><code class="wrap-anywhere text-fg-secondary">{{ formatSideTaskHash(file.result_hash) }}</code></dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs text-fg-muted">当前主线哈希</dt>
          <dd class="m-0 mt-[2px]"><code class="wrap-anywhere text-fg-secondary">{{ formatSideTaskHash(file.current_target_hash) }}</code></dd>
        </div>
      </dl>
      <p v-if="file.conflict_reason" class="m-0 bg-danger/9 px-3 py-2 text-xs text-danger">{{ file.conflict_reason }} 此文件不会被选入采纳。</p>
      <pre class="m-0 max-h-[260px] overflow-auto whitespace-pre bg-base p-3 text-fg"><code>{{ file.diff }}</code></pre>
    </article>

    <div class="mt-3 rounded-md bg-hover p-3">
      <label class="flex flex-col gap-1 text-xs text-fg-secondary">
        <span>人工采纳理由</span>
        <Textarea
          v-model="adoptionReason"
          class="resize-y"
          rows="2"
          maxlength="1000"
          :disabled="operating"
          placeholder="说明为什么把这些探索结果带回主工作区"
        />
      </label>
      <p v-if="adoptionError" class="col-span-full m-0 text-xs text-danger max-[720px]:col-auto" role="alert">{{ adoptionError }}</p>
      <div class="mt-2 flex items-center justify-between gap-3 text-xs text-fg-secondary max-[720px]:flex-col max-[720px]:items-start">
        <span>已选择 {{ selectedPaths.size }} / {{ selectableFiles.length }} 个可采纳文件</span>
        <Button
          variant="primary"
          size="sm"
          :disabled="selectedPaths.size === 0 || !adoptionReason.trim() || operating"
          :loading="operating"
          @click="submitAdoption"
        >
          确认人工采纳
        </Button>
      </div>
    </div>
  </section>
</template>
