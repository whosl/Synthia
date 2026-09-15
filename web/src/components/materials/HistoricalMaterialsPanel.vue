<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowRight } from "lucide-vue-next";
import type {
  CopyHistoricalMaterialRequest,
  CreateImportSnapshotRequest,
  HistoricalMaterialSearchResult,
  HistoricalMaterialSnapshot,
  ImportSnapshotStatus,
} from "../../api/types.ts";
import {
  DEFAULT_HISTORICAL_COPY_ARTIFACT_TYPE,
  HISTORICAL_COPY_ARTIFACT_TYPES,
  HISTORICAL_STATUS_TEXT,
  HISTORICAL_STATUS_TONE,
  canCopyMaterial,
  isHistoricalCopyArtifactType,
  isSearchableFile,
  parseMaterialImportPayload,
  selectedMaterialFiles,
} from "../../domain/historical-materials.ts";
import type { HistoricalCopyArtifactType } from "../../domain/historical-materials.ts";
import PanelHeader from "../panels/PanelHeader.vue";
import Badge from "../ui/AppBadge.vue";
import Button from "../ui/AppButton.vue";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

const props = defineProps<{
  open: boolean;
  snapshots: readonly HistoricalMaterialSnapshot[];
  selectedSnapshotId: string | null;
  selectedSnapshot: HistoricalMaterialSnapshot | null;
  searchResults: readonly HistoricalMaterialSearchResult[];
  searchQuery: string;
  loading: boolean;
  searching: boolean;
  operating: boolean;
  error: string | null;
  projectEligible: boolean;
}>();

const emit = defineEmits<{
  close: [];
  refresh: [];
  "select-snapshot": [snapshotId: string];
  search: [query: string];
  import: [request: CreateImportSnapshotRequest];
  confirm: [snapshotId: string];
  deny: [snapshotId: string, reason: string];
  copy: [snapshotId: string, request: CopyHistoricalMaterialRequest];
}>();

type PanelTab = "snapshots" | "search";
const tab = ref<PanelTab>("snapshots");
const importOpen = ref(false);
const importText = ref("");
const importError = ref<string | null>(null);
const importFileName = ref<string | null>(null);
const denyReason = ref("");
const copyId = ref("");
const copyName = ref("");
const copyArtifactType = ref<HistoricalCopyArtifactType>(DEFAULT_HISTORICAL_COPY_ARTIFACT_TYPE);
const selectedFileIds = ref<Set<string>>(new Set());
const localSearchQuery = ref(props.searchQuery);
const panelElement = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;

const selectedSnapshot = computed(() => props.selectedSnapshot);
const selectedFiles = computed(() => {
  const files = selectedSnapshot.value?.files ?? [];
  return selectedMaterialFiles(files, selectedFileIds.value);
});
const copyAllowed = computed(() => {
  const snapshot = selectedSnapshot.value;
  return Boolean(
    snapshot
    && canCopyMaterial(snapshot)
    && selectedFiles.value.length > 0
    && copyId.value.trim()
    && copyName.value.trim()
    && isHistoricalCopyArtifactType(copyArtifactType.value),
  );
});
const statusText = (status: ImportSnapshotStatus): string => HISTORICAL_STATUS_TEXT[status] ?? "未知状态";
const statusTone = (status: ImportSnapshotStatus): "neutral" | "ok" | "warn" | "danger" => HISTORICAL_STATUS_TONE[status] ?? "danger";
const sourceText = (kind: HistoricalMaterialSnapshot["source_kind"]): string => {
  if (kind === "project") return "Synthia 项目";
  if (kind === "zip") return "ZIP 快照";
  return "本地目录";
};
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
};

watch(
  () => props.selectedSnapshotId,
  () => {
    selectedFileIds.value = new Set();
    denyReason.value = "";
    copyId.value = "";
    copyName.value = "";
    copyArtifactType.value = DEFAULT_HISTORICAL_COPY_ARTIFACT_TYPE;
  },
);

watch(
  () => props.searchQuery,
  (value) => {
    localSearchQuery.value = value;
  },
);

function toggleFile(fileId: string): void {
  const file = selectedSnapshot.value?.files.find((candidate) => candidate.id === fileId);
  if (!file || !isSearchableFile(file)) return;
  const next = new Set(selectedFileIds.value);
  if (next.has(fileId)) next.delete(fileId);
  else next.add(fileId);
  selectedFileIds.value = next;
}

function selectAllFiles(): void {
  const files = selectedSnapshot.value?.files ?? [];
  selectedFileIds.value = new Set(files.filter(isSearchableFile).map((file) => file.id));
}

function clearFiles(): void {
  selectedFileIds.value = new Set();
}

function submitSearch(): void {
  emit("search", localSearchQuery.value.trim());
}

function parseAndImport(): void {
  importError.value = null;
  const parsed = parseMaterialImportPayload(importText.value);
  if (!parsed.ok) {
    importError.value = parsed.message;
    return;
  }
  emit("import", parsed.request);
}

async function onImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importFileName.value = file.name;
  try {
    importText.value = await file.text();
    importError.value = null;
  } catch {
    importError.value = "无法读取这个文件，请改用粘贴 JSON。";
  } finally {
    input.value = "";
  }
}

function submitDeny(): void {
  const id = props.selectedSnapshotId;
  if (!id || props.operating) return;
  emit("deny", id, denyReason.value.trim());
}

function submitCopy(): void {
  const id = props.selectedSnapshotId;
  if (!id || !copyAllowed.value || props.operating || !isHistoricalCopyArtifactType(copyArtifactType.value)) return;
  emit("copy", id, {
    id: copyId.value.trim(),
    name: copyName.value.trim(),
    artifact_type: copyArtifactType.value,
    file_ids: selectedFiles.value.map((file) => file.id),
  });
}

function updateCopyArtifactType(value: unknown): void {
  if (isHistoricalCopyArtifactType(value)) copyArtifactType.value = value;
}

onMounted(() => {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  void nextTick(() => panelElement.value?.focus());
});

onBeforeUnmount(() => {
  returnFocus?.focus();
  returnFocus = null;
});
</script>

<template>
  <aside
    v-if="open"
    ref="panelElement"
    class="flex h-full min-h-0 flex-col bg-panel text-fg"
    role="dialog"
    aria-modal="true"
    aria-label="历史资料库"
    tabindex="-1"
    @keydown.esc="emit('close')"
  >
    <PanelHeader
      eyebrow="P2 · 资料治理"
      title="历史资料库"
      description="导入资料先待确认；只有已确认且仍有效的内容可进入默认检索。"
      @close="emit('close')"
    />

    <div v-if="!projectEligible" class="mx-5 mt-3 rounded-md bg-hover p-3 text-xs text-fg-secondary" role="status">
      自由项目暂不接入历史资料库。请复制为工程项目后再导入。
    </div>

    <Tabs v-else v-model="tab" class="flex min-h-0 flex-1 flex-col gap-0">
      <TabsList
        variant="line"
        aria-label="资料库视图"
        class="px-5 pt-2 max-[560px]:px-3"
      >
        <TabsTrigger variant="line" value="snapshots">
          导入快照 <span class="text-[11px] text-fg-muted">{{ snapshots.length }}</span>
        </TabsTrigger>
        <TabsTrigger variant="line" value="search">默认检索</TabsTrigger>
      </TabsList>

      <div v-if="error" class="mx-5 mt-3 flex items-center justify-between gap-2 rounded-md bg-danger/12 p-3 text-xs text-danger" role="alert">
        <p class="m-0">{{ error }}</p>
        <Button size="sm" variant="secondary" @click="emit('refresh')">重试</Button>
      </div>

      <TabsContent value="snapshots" as="section" class="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-6 max-[560px]:px-3">
        <div class="flex items-center justify-between gap-2">
          <Button size="sm" variant="primary" @click="importOpen = !importOpen">
            {{ importOpen ? "收起导入" : "导入资料" }}
          </Button>
          <Button size="sm" variant="ghost" :disabled="loading" :loading="loading" @click="emit('refresh')">刷新</Button>
        </div>

        <section v-if="importOpen" class="mt-3 rounded-md border border-line bg-base p-3">
          <div class="flex items-start justify-between gap-2">
            <div>
              <strong class="block">规范化 JSON</strong>
              <span class="mt-1 block text-xs text-fg-secondary">项目来源可只传 source_project_id + commit；本地目录/ZIP 仍需 files。Core 会再次执行安全检查。</span>
            </div>
            <label class="flex-none cursor-pointer text-xs text-brand">
              选择 JSON
              <input type="file" accept="application/json,.json" class="pointer-events-none absolute h-px w-px opacity-0" @change="onImportFile" />
            </label>
          </div>
          <Textarea
            v-model="importText"
            class="mt-2 min-h-[120px] resize-y font-mono text-[12.5px]"
            rows="7"
            spellcheck="false"
            aria-label="资料导入 JSON"
            placeholder='{"source_kind":"project","source_project_id":"legacy-p1","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
          />
          <p v-if="importFileName" class="m-0 mt-2 text-xs text-fg-secondary">已读取：{{ importFileName }}</p>
          <p v-if="importError" class="m-0 mt-2 text-xs text-danger" role="alert">{{ importError }}</p>
          <div class="mt-2 flex items-center justify-end gap-2">
            <Button size="sm" variant="secondary" @click="importText = ''; importError = null; importFileName = null">清空</Button>
            <Button size="sm" variant="primary" :disabled="!importText.trim() || operating" :loading="operating" @click="parseAndImport">提交待确认快照</Button>
          </div>
        </section>

        <p v-if="loading && snapshots.length === 0" class="my-6 text-center text-xs text-fg-muted">正在读取资料快照…</p>
        <p v-else-if="!loading && snapshots.length === 0 && !error" class="my-6 text-center text-xs text-fg-muted">还没有导入资料。导入后会先进入待确认状态。</p>
        <ul v-else class="m-0 mt-3 grid list-none gap-1 p-0">
          <li v-for="snapshot in snapshots" :key="snapshot.id">
            <button
              type="button"
              class="flex w-full cursor-pointer items-center rounded-md border border-transparent bg-transparent p-2 text-left text-fg hover:border-line hover:bg-hover"
              :class="{ 'border-line bg-hover': selectedSnapshotId === snapshot.id }"
              @click="emit('select-snapshot', snapshot.id)"
            >
              <span class="flex min-w-0 flex-1 flex-col">
                <strong class="truncate text-[13px]">{{ snapshot.source_name || snapshot.id }}</strong>
                <small class="mt-0.5 text-[11px] text-fg-secondary">{{ sourceText(snapshot.source_kind) }} · {{ snapshot.files.length }} 个文件</small>
              </span>
              <Badge :tone="statusTone(snapshot.status)" size="sm">{{ statusText(snapshot.status) }}</Badge>
            </button>
          </li>
        </ul>

        <section v-if="selectedSnapshot" class="mt-4 border-t border-line pt-3">
          <header class="flex items-center justify-between gap-2">
            <div>
              <h3 class="m-0 text-[15px]">{{ selectedSnapshot.source_name || selectedSnapshot.id }}</h3>
              <p class="m-0 mt-1 text-xs leading-[1.4] text-fg-secondary">{{ selectedSnapshot.id }} · {{ sourceText(selectedSnapshot.source_kind) }}</p>
            </div>
            <Badge :tone="statusTone(selectedSnapshot.status)">{{ statusText(selectedSnapshot.status) }}</Badge>
          </header>
          <p v-if="selectedSnapshot.failure_reason" class="m-0 mt-2 text-xs text-danger">{{ selectedSnapshot.failure_reason }}</p>
          <p class="m-0 mt-2 flex flex-wrap gap-3 text-xs text-fg-secondary">
            <span :class="selectedSnapshot.valid ? 'text-ok' : 'text-danger'">{{ selectedSnapshot.valid ? "内容校验通过" : "内容不可用" }}</span>
            <span>{{ selectedSnapshot.searchable ? "已进入默认检索" : "尚未进入默认检索" }}</span>
          </p>

          <div v-if="selectedSnapshot.files.length > 0" class="mt-4 flex items-center justify-between gap-2 text-xs text-fg-secondary">
            <span>文件清单（{{ selectedSnapshot.files.length }}）</span>
            <span v-if="canCopyMaterial(selectedSnapshot)" class="inline-flex gap-2">
              <button type="button" class="cursor-pointer border-none bg-transparent p-0 text-xs text-brand" @click="selectAllFiles">全选</button>
              <button type="button" class="cursor-pointer border-none bg-transparent p-0 text-xs text-brand" @click="clearFiles">清除</button>
            </span>
          </div>
          <ul class="m-0 mt-3 list-none p-0">
            <li v-for="file in selectedSnapshot.files" :key="file.id">
              <label class="flex min-w-0 items-center gap-2 py-1 text-xs">
                <Checkbox
                  :model-value="selectedFileIds.has(file.id)"
                  :disabled="!canCopyMaterial(selectedSnapshot) || !isSearchableFile(file)"
                  @update:model-value="toggleFile(file.id)"
                />
                <span class="min-w-0 flex-1 truncate font-mono text-[12.5px]">{{ file.path }}</span>
                <small class="flex-none text-fg-muted">{{ formatBytes(file.bytes) }}</small>
              </label>
            </li>
          </ul>

          <div v-if="selectedSnapshot.status === 'pending_confirmation'" class="mt-4 rounded-md bg-hover p-3">
            <p class="m-0 text-xs leading-[1.4] text-fg-secondary">确认后，这份快照才会被 Agent 默认检索；确认不会把内容直接写入当前项目。</p>
            <div class="mt-2 flex items-center gap-2">
              <Button size="sm" variant="primary" :disabled="operating" :loading="operating" @click="emit('confirm', selectedSnapshot.id)">确认资料</Button>
              <Button size="sm" variant="danger" :disabled="operating" @click="submitDeny">否决</Button>
            </div>
            <Input v-model="denyReason" class="mt-2" type="text" aria-label="否决理由（可选）" placeholder="否决理由（可选）" @keydown.enter.prevent="submitDeny" />
          </div>

          <div v-if="canCopyMaterial(selectedSnapshot)" class="mt-4 rounded-md bg-hover p-3">
            <div class="font-semibold">复制选中内容为当前项目候选</div>
            <p class="m-0 text-xs leading-[1.4] text-fg-secondary">复制会创建新的候选修订，不继承这份历史资料的确认状态。</p>
            <div class="my-2 flex flex-wrap items-center gap-2">
              <Input v-model="copyId" class="min-w-0 flex-[1_1_140px]" type="text" aria-label="候选标识" placeholder="候选标识，如 pwm-reference" />
              <Input v-model="copyName" class="min-w-0 flex-[1_1_140px]" type="text" aria-label="候选名称" placeholder="候选名称" />
              <Select :model-value="copyArtifactType" @update:model-value="updateCopyArtifactType">
                <SelectTrigger class="min-w-0 flex-[1_1_220px]" aria-label="候选产物类型">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="option in HISTORICAL_COPY_ARTIFACT_TYPES" :key="option.value" :value="option.value">
                    {{ option.label }}（{{ option.value }}）
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" variant="primary" :disabled="!copyAllowed || operating" :loading="operating" @click="submitCopy">
              复制 {{ selectedFiles.length }} 个文件为候选
            </Button>
          </div>
        </section>
      </TabsContent>

      <TabsContent value="search" as="section" class="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-6 max-[560px]:px-3">
        <form class="flex items-center gap-2" @submit.prevent="submitSearch">
          <Input v-model="localSearchQuery" class="min-w-0 flex-1" type="search" placeholder="搜索已确认且仍有效的资料" aria-label="搜索历史资料" />
          <Button type="submit" size="sm" variant="primary" :disabled="searching" :loading="searching">搜索</Button>
        </form>
        <p class="m-0 mt-2 text-xs leading-[1.4] text-fg-secondary">搜索结果只来自 confirmed 且 valid 的资料；待确认/否决/失败内容不会出现在这里。</p>
        <p v-if="searching" class="my-6 text-center text-xs text-fg-muted">正在搜索…</p>
        <p v-else-if="searchResults.length === 0" class="my-6 text-center text-xs text-fg-muted">没有可检索结果。确认一份仍有效的资料后再试。</p>
        <ul v-else class="m-0 mt-3 grid list-none gap-2 p-0">
          <li v-for="result in searchResults" :key="`${result.snapshot_id}:${result.id}`" class="border-b border-line pb-2">
            <button
              type="button"
              class="flex w-full cursor-pointer items-center rounded-md border border-transparent bg-transparent p-2 text-left text-fg hover:border-line hover:bg-hover"
              @click="emit('select-snapshot', result.snapshot_id); tab = 'snapshots'"
            >
              <span class="flex min-w-0 flex-1 flex-col">
                <strong class="truncate text-[13px]">{{ result.path }}</strong>
                <small class="mt-0.5 text-[11px] text-fg-secondary">{{ result.source_name || result.snapshot_id }} · {{ formatBytes(result.bytes) }}</small>
              </span>
              <span class="flex-none text-brand" aria-hidden="true"><ArrowRight :size="14" /></span>
            </button>
            <p v-if="result.snippet" class="mx-2 my-0 truncate font-mono text-[11px] text-fg-secondary">{{ result.snippet }}</p>
          </li>
        </ul>
      </TabsContent>
    </Tabs>
  </aside>
</template>
