<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
import Badge from "../ui/Badge.vue";
import Button from "../ui/Button.vue";

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
  notice: string | null;
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
    class="historical-materials-panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="historical-materials-title"
    tabindex="-1"
    @keydown.esc="emit('close')"
  >
    <header class="historical-materials-head">
      <div>
        <p class="historical-materials-kicker">P2 · 资料治理</p>
        <h2 id="historical-materials-title">历史资料库</h2>
        <p class="historical-materials-subtitle">导入资料先待确认；只有已确认且仍有效的内容可进入默认检索。</p>
      </div>
      <Button variant="ghost" size="sm" aria-label="关闭历史资料库" @click="emit('close')">关闭</Button>
    </header>

    <div v-if="!projectEligible" class="historical-materials-blocked" role="status">
      自由项目暂不接入历史资料库。请复制为工程项目后再导入。
    </div>

    <template v-else>
      <nav class="historical-materials-tabs" aria-label="资料库视图">
        <button type="button" :class="{ 'is-active': tab === 'snapshots' }" @click="tab = 'snapshots'">
          导入快照 <span>{{ snapshots.length }}</span>
        </button>
        <button type="button" :class="{ 'is-active': tab === 'search' }" @click="tab = 'search'">
          默认检索
        </button>
      </nav>

      <div v-if="error" class="historical-materials-error" role="alert">
        <p>{{ error }}</p>
        <Button size="sm" variant="secondary" @click="emit('refresh')">重试</Button>
      </div>
      <p v-if="notice" class="historical-materials-notice" role="status">{{ notice }}</p>

      <section v-if="tab === 'snapshots'" class="historical-materials-content">
        <div class="historical-materials-toolbar">
          <Button size="sm" variant="primary" @click="importOpen = !importOpen">
            {{ importOpen ? "收起导入" : "导入资料" }}
          </Button>
          <Button size="sm" variant="ghost" :disabled="loading" :loading="loading" @click="emit('refresh')">刷新</Button>
        </div>

        <section v-if="importOpen" class="historical-import-form">
          <div class="historical-import-form-head">
            <div>
              <strong>规范化 JSON</strong>
              <span>项目来源可只传 source_project_id + commit；本地目录/ZIP 仍需 files。Core 会再次执行安全检查。</span>
            </div>
            <label class="historical-file-picker">
              选择 JSON
              <input type="file" accept="application/json,.json" @change="onImportFile" />
            </label>
          </div>
          <textarea
            v-model="importText"
            class="historical-import-textarea"
            rows="7"
            spellcheck="false"
            aria-label="资料导入 JSON"
            placeholder='{"source_kind":"project","source_project_id":"legacy-p1","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
          />
          <p v-if="importFileName" class="historical-import-file-name">已读取：{{ importFileName }}</p>
          <p v-if="importError" class="historical-inline-error" role="alert">{{ importError }}</p>
          <div class="historical-import-actions">
            <Button size="sm" variant="secondary" @click="importText = ''; importError = null; importFileName = null">清空</Button>
            <Button size="sm" variant="primary" :disabled="!importText.trim() || operating" :loading="operating" @click="parseAndImport">提交待确认快照</Button>
          </div>
        </section>

        <p v-if="loading && snapshots.length === 0" class="historical-materials-state">正在读取资料快照…</p>
        <p v-else-if="!loading && snapshots.length === 0 && !error" class="historical-materials-state">还没有导入资料。导入后会先进入待确认状态。</p>
        <ul v-else class="historical-snapshot-list">
          <li v-for="snapshot in snapshots" :key="snapshot.id">
            <button
              type="button"
              class="historical-snapshot-row"
              :class="{ 'is-active': selectedSnapshotId === snapshot.id }"
              @click="emit('select-snapshot', snapshot.id)"
            >
              <span class="historical-snapshot-main">
                <strong>{{ snapshot.source_name || snapshot.id }}</strong>
                <small>{{ sourceText(snapshot.source_kind) }} · {{ snapshot.files.length }} 个文件</small>
              </span>
              <Badge :tone="statusTone(snapshot.status)" size="sm">{{ statusText(snapshot.status) }}</Badge>
            </button>
          </li>
        </ul>

        <section v-if="selectedSnapshot" class="historical-material-detail">
          <header class="historical-detail-head">
            <div>
              <h3>{{ selectedSnapshot.source_name || selectedSnapshot.id }}</h3>
              <p>{{ selectedSnapshot.id }} · {{ sourceText(selectedSnapshot.source_kind) }}</p>
            </div>
            <Badge :tone="statusTone(selectedSnapshot.status)">{{ statusText(selectedSnapshot.status) }}</Badge>
          </header>
          <p v-if="selectedSnapshot.failure_reason" class="historical-inline-error">{{ selectedSnapshot.failure_reason }}</p>
          <p class="historical-detail-safety">
            <span :class="selectedSnapshot.valid ? 'is-safe' : 'is-unsafe'">{{ selectedSnapshot.valid ? "内容校验通过" : "内容不可用" }}</span>
            <span>{{ selectedSnapshot.searchable ? "已进入默认检索" : "尚未进入默认检索" }}</span>
          </p>

          <div v-if="selectedSnapshot.files.length > 0" class="historical-files-head">
            <span>文件清单（{{ selectedSnapshot.files.length }}）</span>
            <span v-if="canCopyMaterial(selectedSnapshot)" class="historical-file-selection-actions">
              <button type="button" @click="selectAllFiles">全选</button>
              <button type="button" @click="clearFiles">清除</button>
            </span>
          </div>
          <ul class="historical-file-list">
            <li v-for="file in selectedSnapshot.files" :key="file.id">
              <label class="historical-file-row">
                <input
                  type="checkbox"
                  :checked="selectedFileIds.has(file.id)"
                  :disabled="!canCopyMaterial(selectedSnapshot) || !isSearchableFile(file)"
                  @change="toggleFile(file.id)"
                />
                <span class="historical-file-path">{{ file.path }}</span>
                <small>{{ formatBytes(file.bytes) }}</small>
              </label>
            </li>
          </ul>

          <div v-if="selectedSnapshot.status === 'pending_confirmation'" class="historical-decision-box">
            <p>确认后，这份快照才会被 Agent 默认检索；确认不会把内容直接写入当前项目。</p>
            <div class="historical-decision-actions">
              <Button size="sm" variant="primary" :disabled="operating" :loading="operating" @click="emit('confirm', selectedSnapshot.id)">确认资料</Button>
              <Button size="sm" variant="danger" :disabled="operating" @click="submitDeny">否决</Button>
            </div>
            <input v-model="denyReason" class="historical-deny-input" type="text" aria-label="否决理由（可选）" placeholder="否决理由（可选）" @keydown.enter.prevent="submitDeny" />
          </div>

          <div v-if="canCopyMaterial(selectedSnapshot)" class="historical-copy-box">
            <div class="historical-copy-title">复制选中内容为当前项目候选</div>
            <p>复制会创建新的候选修订，不继承这份历史资料的确认状态。</p>
            <div class="historical-copy-fields">
              <input v-model="copyId" type="text" aria-label="候选标识" placeholder="候选标识，如 pwm-reference" />
              <input v-model="copyName" type="text" aria-label="候选名称" placeholder="候选名称" />
              <select v-model="copyArtifactType" aria-label="候选产物类型">
                <option v-for="option in HISTORICAL_COPY_ARTIFACT_TYPES" :key="option.value" :value="option.value">
                  {{ option.label }}（{{ option.value }}）
                </option>
              </select>
            </div>
            <Button size="sm" variant="primary" :disabled="!copyAllowed || operating" :loading="operating" @click="submitCopy">
              复制 {{ selectedFiles.length }} 个文件为候选
            </Button>
          </div>
        </section>
      </section>

      <section v-else class="historical-materials-content historical-search-content">
        <form class="historical-search-form" @submit.prevent="submitSearch">
          <input v-model="localSearchQuery" type="search" placeholder="搜索已确认且仍有效的资料" aria-label="搜索历史资料" />
          <Button type="submit" size="sm" variant="primary" :disabled="searching" :loading="searching">搜索</Button>
        </form>
        <p class="historical-search-hint">搜索结果只来自 confirmed 且 valid 的资料；待确认/否决/失败内容不会出现在这里。</p>
        <p v-if="searching" class="historical-materials-state">正在搜索…</p>
        <p v-else-if="searchResults.length === 0" class="historical-materials-state">没有可检索结果。确认一份仍有效的资料后再试。</p>
        <ul v-else class="historical-search-list">
          <li v-for="result in searchResults" :key="`${result.snapshot_id}:${result.id}`">
            <button type="button" class="historical-search-row" @click="emit('select-snapshot', result.snapshot_id); tab = 'snapshots'">
              <span>
                <strong>{{ result.path }}</strong>
                <small>{{ result.source_name || result.snapshot_id }} · {{ formatBytes(result.bytes) }}</small>
              </span>
              <span class="historical-search-arrow" aria-hidden="true">→</span>
            </button>
            <p v-if="result.snippet" class="historical-search-snippet">{{ result.snippet }}</p>
          </li>
        </ul>
      </section>
    </template>
  </aside>
</template>

<style scoped>
.historical-materials-panel {
  display: flex;
  flex-direction: column;
  width: min(560px, 96vw);
  height: 100%;
  min-height: 0;
  background: var(--surface-panel);
  color: var(--text-primary);
  box-shadow: 0 0 24px var(--shadow-color);
}

.historical-materials-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  flex: none;
  padding: var(--space-5) var(--space-5) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
}

.historical-materials-kicker {
  margin: 0 0 var(--space-1);
  color: var(--accent);
  font-size: var(--font-size-sm);
  font-weight: 600;
  letter-spacing: 0.04em;
}

.historical-materials-head h2,
.historical-detail-head h3 {
  margin: 0;
  font-size: var(--font-size-lg);
}

.historical-materials-subtitle,
.historical-detail-head p,
.historical-copy-box p,
.historical-decision-box p,
.historical-search-hint {
  margin: var(--space-1) 0 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-list);
}

.historical-materials-blocked,
.historical-materials-error,
.historical-materials-notice {
  margin: var(--space-3) var(--space-5) 0;
  padding: var(--space-3);
  border-radius: var(--radius);
  font-size: var(--font-size-sm);
}

.historical-materials-blocked {
  background: var(--surface-hover);
  color: var(--text-secondary);
}

.historical-materials-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  background: color-mix(in srgb, var(--state-danger) 12%, transparent);
  color: var(--state-danger);
}

.historical-materials-error p {
  margin: 0;
}

.historical-materials-notice {
  background: color-mix(in srgb, var(--state-ok) 12%, transparent);
  color: var(--state-ok);
}

.historical-materials-tabs {
  display: flex;
  gap: var(--space-1);
  flex: none;
  padding: var(--space-2) var(--space-5) 0;
  border-bottom: 1px solid var(--border-subtle);
}

.historical-materials-tabs button {
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: var(--space-2) var(--space-2);
  font-size: var(--font-size-sm);
}

.historical-materials-tabs button:hover,
.historical-materials-tabs button.is-active {
  color: var(--text-primary);
}

.historical-materials-tabs button.is-active {
  border-bottom-color: var(--accent);
}

.historical-materials-tabs span {
  color: var(--text-muted);
  font-size: 11px;
}

.historical-materials-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3) var(--space-5) var(--space-6);
}

.historical-materials-toolbar,
.historical-import-actions,
.historical-decision-actions,
.historical-import-form-head,
.historical-copy-fields,
.historical-search-form {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.historical-materials-toolbar {
  justify-content: space-between;
}

.historical-import-form {
  margin-top: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--surface-base);
}

.historical-import-form-head {
  justify-content: space-between;
  align-items: flex-start;
}

.historical-import-form-head strong,
.historical-import-form-head span {
  display: block;
}

.historical-import-form-head span {
  margin-top: var(--space-1);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.historical-file-picker {
  flex: none;
  color: var(--accent);
  cursor: pointer;
  font-size: var(--font-size-sm);
}

.historical-file-picker input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.historical-import-textarea,
.historical-deny-input,
.historical-copy-fields input,
.historical-copy-fields select,
.historical-search-form input {
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-panel);
  color: var(--text-primary);
}

.historical-import-textarea {
  display: block;
  width: 100%;
  min-height: 120px;
  margin-top: var(--space-2);
  padding: var(--space-2);
  resize: vertical;
  font-family: var(--font-mono);
  font-size: var(--font-size-code);
}

.historical-import-actions {
  justify-content: flex-end;
  margin-top: var(--space-2);
}

.historical-import-file-name,
.historical-inline-error,
.historical-detail-safety {
  margin: var(--space-2) 0 0;
  font-size: var(--font-size-sm);
}

.historical-import-file-name {
  color: var(--text-secondary);
}

.historical-inline-error {
  color: var(--state-danger);
}

.historical-materials-state {
  margin: var(--space-6) 0;
  color: var(--text-muted);
  text-align: center;
  font-size: var(--font-size-sm);
}

.historical-snapshot-list,
.historical-file-list,
.historical-search-list {
  list-style: none;
  margin: var(--space-3) 0 0;
  padding: 0;
}

.historical-snapshot-list {
  display: grid;
  gap: var(--space-1);
}

.historical-snapshot-row,
.historical-search-row {
  display: flex;
  align-items: center;
  width: 100%;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: var(--space-2);
  text-align: left;
}

.historical-snapshot-row:hover,
.historical-search-row:hover,
.historical-snapshot-row.is-active {
  border-color: var(--border-subtle);
  background: var(--surface-hover);
}

.historical-snapshot-main,
.historical-search-row > span:first-child {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.historical-snapshot-main strong,
.historical-search-row strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-base);
}

.historical-snapshot-main small,
.historical-search-row small {
  margin-top: 2px;
  color: var(--text-secondary);
  font-size: 11px;
}

.historical-material-detail {
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.historical-detail-head,
.historical-files-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.historical-detail-safety {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  color: var(--text-secondary);
}

.historical-detail-safety .is-safe {
  color: var(--state-ok);
}

.historical-detail-safety .is-unsafe {
  color: var(--state-danger);
}

.historical-files-head {
  margin-top: var(--space-4);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.historical-file-selection-actions {
  display: inline-flex;
  gap: var(--space-2);
}

.historical-file-selection-actions button {
  border: none;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font-size: var(--font-size-sm);
  padding: 0;
}

.historical-file-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-1) 0;
  font-size: var(--font-size-sm);
}

.historical-file-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--font-size-code);
}

.historical-file-row small {
  flex: none;
  color: var(--text-muted);
}

.historical-decision-box,
.historical-copy-box {
  margin-top: var(--space-4);
  padding: var(--space-3);
  border-radius: var(--radius);
  background: var(--surface-hover);
}

.historical-decision-box p,
.historical-copy-box p {
  margin-top: 0;
}

.historical-decision-actions {
  margin-top: var(--space-2);
}

.historical-deny-input {
  width: 100%;
  margin-top: var(--space-2);
  padding: var(--space-2);
}

.historical-copy-title {
  font-weight: 600;
}

.historical-copy-fields {
  flex-wrap: wrap;
  margin: var(--space-2) 0;
}

.historical-copy-fields input {
  min-width: 0;
  flex: 1 1 140px;
  padding: var(--space-2);
}

.historical-copy-fields select {
  min-width: 0;
  flex: 1 1 220px;
  padding: var(--space-2);
}

.historical-search-form input {
  flex: 1;
  min-width: 0;
  padding: var(--space-2);
}

.historical-search-hint {
  margin-top: var(--space-2);
}

.historical-search-list {
  display: grid;
  gap: var(--space-2);
}

.historical-search-list li {
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
}

.historical-search-arrow {
  flex: none;
  color: var(--accent);
}

.historical-search-snippet {
  margin: 0 var(--space-2);
  overflow: hidden;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 560px) {
  .historical-materials-head {
    padding-inline: var(--space-3);
  }

  .historical-materials-tabs,
  .historical-materials-content {
    padding-inline: var(--space-3);
  }
}
</style>
