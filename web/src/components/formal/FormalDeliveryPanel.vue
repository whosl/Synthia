<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type {
  BitstreamResultV1,
  ChangeRequestV1,
  CreateChangeRequestV1,
  DeliveryManifestV1,
  DeliveryReleaseDetailV1,
  DeliveryReleaseSummaryV1,
  FormalInputApprovalV1,
  FormalInputPreviewV1,
  P4GateId,
  ProcessProfileV1,
  ProcessStateV1,
  ProjectReadinessRecord,
  ProjectWorkVersionV1,
  TaskFormalInputState,
} from "../../api/types.ts";
import type { G4CheckRow, ReadinessPreparationInput } from "../../domain/formal-delivery.ts";
import {
  bitstreamClassText,
  changeImpactGateOptions,
  DELIVERY_CATEGORY_TEXT,
  shouldPrepareReadiness,
} from "../../domain/formal-delivery.ts";
import { PROCESS_GATE_STATUS_TEXT, type ProcessGateView } from "../../domain/process-profile.ts";

const props = defineProps<{
  readonly open: boolean;
  readonly loading: boolean;
  readonly operating: boolean;
  readonly error: string | null;
  readonly notice: string | null;
  readonly profile: ProcessProfileV1 | null;
  readonly state: ProcessStateV1 | null;
  readonly gateChain: readonly ProcessGateView[] | null;
  readonly readinessRows: readonly ProjectReadinessRecord[];
  readonly formalInputBlockers: readonly string[];
  readonly preview: FormalInputPreviewV1 | null;
  readonly approval: FormalInputApprovalV1 | null;
  readonly formalProgress: TaskFormalInputState | null;
  readonly g4Checks: readonly G4CheckRow[];
  readonly bitstreams: readonly BitstreamResultV1[];
  readonly releases: readonly DeliveryReleaseSummaryV1[];
  readonly selectedReleaseId: string | null;
  readonly selectedRelease: DeliveryReleaseDetailV1 | null;
  readonly manifest: DeliveryManifestV1 | null;
  readonly changeRequests: readonly ChangeRequestV1[];
  readonly workVersion: ProjectWorkVersionV1 | null;
  readonly projectTargetPart: string | null;
  readonly dataClassification: string;
  readonly constraintRevisionOptions: readonly { readonly id: string; readonly label: string }[];
  readonly sourceSnapshotOptions: readonly { readonly id: string; readonly label: string }[];
  readonly workspaceReadyForReadiness: boolean;
}>();

const emit = defineEmits<{
  close: [];
  refresh: [];
  "prepare-readiness": [input: ReadinessPreparationInput];
  "confirm-readiness": [reason: string];
  "preview-formal": [];
  "confirm-formal": [];
  "select-release": [releaseId: string];
  "download-item": [path: string];
  "download-manifest": [];
  "create-change-request": [body: CreateChangeRequestV1];
  "withdraw-change-request": [changeRequestId: string, reason: string];
}>();

const acknowledged = ref(false);
const changeReason = ref("");
const affectedPaths = ref("");
const impactGate = ref<Exclude<P4GateId, "G0">>("G4");
const withdrawReason = ref("");
const targetPartState = ref<"identified" | "missing">(props.projectTargetPart ? "identified" : "missing");
const targetPart = ref(props.projectTargetPart ?? "");
const boardState = ref<"identified" | "missing">("missing");
const boardRef = ref("");
const pinState = ref<"complete" | "partial" | "missing">("missing");
const electricalState = ref<"complete" | "partial" | "missing">("missing");
const clockState = ref<"complete" | "partial" | "missing">("missing");
const pinRevisionIds = ref<string[]>([]);
const electricalRevisionIds = ref<string[]>([]);
const clockRevisionIds = ref<string[]>([]);
const selectedSourceIds = ref<string[]>([]);
const allowedClassifications = ["D1", "D2", "D3", "D4", "UNCLASSIFIED"] as const;
type DataClassification = (typeof allowedClassifications)[number];
const dataClassification = ref<DataClassification>(
  allowedClassifications.includes(props.dataClassification as DataClassification)
    ? props.dataClassification as DataClassification
    : "D1",
);
const dataScopeDescription = ref("项目源文件与已确认资料");
const readinessReason = ref("初始工程准备检查");
const confirmReadinessReason = ref("已核对工程准备清单");

watch(() => props.preview?.preview_hash, () => {
  acknowledged.value = false;
});

const currentReadiness = computed(() => props.state?.readiness ?? null);
const latestReadiness = computed(() => props.readinessRows[0] ?? null);
const canConfirmReadiness = computed(() => (
  latestReadiness.value?.state === "ready"
  && latestReadiness.value.status !== "confirmed"
  && !props.operating
));
const readinessCoreChecks = computed(() => latestReadiness.value?.checks ?? latestReadiness.value?.check_results ?? []);
const canPreview = computed(() => props.formalInputBlockers.length === 0 && !props.operating);
const currentRelease = computed(() => [...props.releases].sort((a, b) => b.version - a.version)[0] ?? null);
const openChangeRequest = computed(() => props.changeRequests.find((change) => change.state === "open") ?? null);

const readinessChecks = computed(() => {
  const readiness = currentReadiness.value;
  if (!readiness) return [];
  return [
    { label: "工作区已登记", passed: readiness.workspaceReady },
    { label: "数据范围已记录", passed: readiness.dataScopeRecorded },
    { label: "来源资料已记录", passed: readiness.sourceMaterialsRecorded },
    { label: "引脚约束完整", passed: readiness.pinConstraintsComplete },
    { label: "电气约束完整", passed: readiness.electricalConstraintsComplete },
    { label: "时钟约束完整", passed: readiness.clockConstraintsComplete },
  ];
});

function revisionsFor(
  state: "complete" | "partial" | "missing",
  revisionIds: readonly string[],
): readonly string[] {
  return state === "missing" ? [] : [...new Set(revisionIds)];
}

const canPrepareReadiness = computed(() => {
  if (props.operating || !props.workspaceReadyForReadiness || !readinessReason.value.trim() || !dataScopeDescription.value.trim()) return false;
  if (targetPartState.value === "identified" && !targetPart.value.trim()) return false;
  if (boardState.value === "identified" && !boardRef.value.trim()) return false;
  return (
    (pinState.value !== "complete" || pinRevisionIds.value.length > 0)
    && (electricalState.value !== "complete" || electricalRevisionIds.value.length > 0)
    && (clockState.value !== "complete" || clockRevisionIds.value.length > 0)
  );
});

function prepareReadiness(): void {
  if (!canPrepareReadiness.value) return;
  emit("prepare-readiness", {
    engineeringConfig: {
      schema: "engineering-config.v1",
      targetPart: {
        state: targetPartState.value,
        value: targetPartState.value === "identified" ? targetPart.value.trim() : null,
      },
      board: {
        state: boardState.value,
        ref: boardState.value === "identified" ? boardRef.value.trim() : null,
      },
      constraints: {
        pin: { state: pinState.value, revisionIds: revisionsFor(pinState.value, pinRevisionIds.value) },
        electrical: { state: electricalState.value, revisionIds: revisionsFor(electricalState.value, electricalRevisionIds.value) },
        clock: { state: clockState.value, revisionIds: revisionsFor(clockState.value, clockRevisionIds.value) },
      },
      dataScope: { classification: dataClassification.value, description: dataScopeDescription.value.trim() },
      sourcePolicy: { confirmedOnly: true },
    },
    sourceSnapshotIds: [...new Set(selectedSourceIds.value)],
    reason: readinessReason.value.trim(),
  });
}

const formalOperations = [
  { id: "validate_sources" as const, label: "校验源文件" },
  { id: "simulate" as const, label: "正式仿真" },
  { id: "synthesize" as const, label: "正式综合" },
  { id: "implement" as const, label: "正式实现" },
];

const formalProgressText: Readonly<Record<TaskFormalInputState["status"], string>> = {
  awaiting_input_confirmation: "等待人工确认",
  running: "Runtime 正在编排",
  awaiting_gate_approval: "正式检查已完成，等待 G4 批准",
};

function formalJobState(operation: (typeof formalOperations)[number]["id"]): string {
  const state = props.formalProgress?.jobs?.[operation]?.state;
  if (!state) {
    if (props.state?.completed) return "已完成";
    return props.formalProgress?.status === "awaiting_input_confirmation" ? "等待确认" : "等待编排";
  }
  if (state === "succeeded") return "已完成";
  if (state === "failed") return "失败";
  if (state === "cancelled") return "已取消";
  if (state === "timeout") return "超时";
  return "运行中";
}

function shortHash(value: string | null | undefined): string {
  return value ? `${value.slice(0, 10)}…${value.slice(-6)}` : "—";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString("zh-CN", { hour12: false });
}

function submitChangeRequest(): void {
  const release = currentRelease.value;
  const paths = affectedPaths.value.split(/\r?\n|,/).map((path) => path.trim()).filter(Boolean);
  if (!release || !changeReason.value.trim() || paths.length === 0) return;
  emit("create-change-request", {
    id: `cr-${crypto.randomUUID()}`,
    work_version_id: `wv-${crypto.randomUUID()}`,
    base_delivery_release_id: release.id,
    reason: changeReason.value.trim(),
    affected_paths: paths,
    impact_gate: impactGate.value,
  });
}

function withdrawChange(): void {
  const change = openChangeRequest.value;
  const reason = withdrawReason.value.trim();
  if (!change || !reason || props.operating) return;
  emit("withdraw-change-request", change.id, reason);
}
</script>

<template>
  <aside v-if="open" class="formal-panel" aria-label="正式流程与交付">
    <header class="formal-panel-header">
      <div>
        <p class="formal-panel-eyebrow">P4 · 正式工程闭环</p>
        <h2>流程、证据与交付</h2>
      </div>
      <button type="button" class="formal-panel-close" aria-label="关闭正式流程面板" @click="emit('close')">×</button>
    </header>

    <div class="formal-panel-toolbar">
      <span v-if="state?.completed" class="formal-pill tone-ok">G4 已完成</span>
      <span v-else-if="state" class="formal-pill tone-info">当前 {{ state.currentGate }}</span>
      <span v-else class="formal-pill">状态不可用</span>
      <button type="button" class="formal-link" :disabled="loading" @click="emit('refresh')">刷新事实</button>
    </div>

    <div v-if="notice" class="formal-notice" role="status">{{ notice }}</div>
    <div v-if="error" class="formal-error" role="alert">
      <strong>正式能力未就绪</strong>
      <span>{{ error }}</span>
      <button type="button" @click="emit('refresh')">重试</button>
    </div>

    <div v-if="loading" class="formal-loading" aria-live="polite">
      <span v-for="n in 4" :key="n" />
      <p>正在读取 Core 正式事实…</p>
    </div>

    <div v-else class="formal-panel-scroll">
      <section class="formal-section">
        <div class="formal-section-title">
          <div>
            <p>G0–G4</p>
            <h3>{{ profile?.name ?? "工程流程" }}</h3>
          </div>
          <small v-if="workVersion">工作版本 v{{ workVersion.version }} · {{ workVersion.state === 'released' ? '已发布' : '工作中' }}</small>
        </div>
        <ol v-if="gateChain" class="formal-gates">
          <li v-for="entry in gateChain" :key="entry.node.id" :class="`state-${entry.status}`">
            <span class="formal-gate-code">{{ entry.node.id }}</span>
            <span class="formal-gate-copy">
              <strong>{{ entry.node.name }}</strong>
              <small>{{ entry.node.goal }}</small>
            </span>
            <span class="formal-gate-status">{{ PROCESS_GATE_STATUS_TEXT[entry.status] }}</span>
          </li>
        </ol>
        <p v-else class="formal-empty">Core 尚未返回可验证的 G0–G4 状态，正式操作保持锁定。</p>
      </section>

      <section class="formal-section">
        <div class="formal-section-title">
          <div>
            <p>G0</p>
            <h3>项目准备</h3>
          </div>
          <span class="formal-pill" :class="currentReadiness?.ready ? 'tone-ok' : 'tone-warn'">
            {{ currentReadiness?.ready ? "已确认" : latestReadiness?.state === "ready" ? "待人工确认" : latestReadiness ? "被阻断" : "尚未评估" }}
          </span>
        </div>
        <template v-if="currentReadiness">
          <dl class="formal-facts">
            <div><dt>器件</dt><dd>{{ currentReadiness.targetPart }}</dd></div>
            <div><dt>板卡</dt><dd>{{ currentReadiness.boardRef }}</dd></div>
            <div><dt>确认人</dt><dd>{{ currentReadiness.confirmedBy?.id ?? "待确认" }}</dd></div>
            <div><dt>准备记录</dt><dd>{{ readinessRows.length }} 版</dd></div>
          </dl>
          <ul class="formal-check-grid">
            <li v-for="check in readinessChecks" :key="check.label" :class="check.passed ? 'passed' : 'failed'">
              <span aria-hidden="true">{{ check.passed ? "✓" : "!" }}</span>{{ check.label }}
            </li>
          </ul>
          <p v-if="currentReadiness.ready && !currentReadiness.constraintsComplete" class="formal-warning">
            G0 已如实记录，但约束不完整：只能生成试验码流，不能确认正式输入。
          </p>
        </template>
        <p v-else-if="!latestReadiness" class="formal-empty">尚无 G0 readiness。先如实记录工程配置、来源与工作区。</p>

        <ul v-if="readinessCoreChecks.length" class="formal-hard-checks">
          <li v-for="check in readinessCoreChecks" :key="check.code" :class="check.passed ? 'state-passed' : 'state-failed'">
            <span aria-hidden="true">{{ check.passed ? "✓" : "×" }}</span>
            <strong>{{ check.code }}</strong>
            <small>{{ check.passed ? "通过" : "阻断" }}</small>
          </li>
        </ul>

        <form v-if="shouldPrepareReadiness(state)" class="formal-readiness-form" @submit.prevent="prepareReadiness">
          <h4>准备新的 G0 清单</h4>
          <p v-if="currentReadiness?.ready" class="formal-warning">
            当前 G0 已完成，但工程约束仍不完整。请形成并确认一版完整 readiness 后再进入正式输入。
          </p>
          <div class="formal-form-grid">
            <label>目标器件状态<select v-model="targetPartState"><option value="identified">已识别</option><option value="missing">尚缺失</option></select></label>
            <label>目标器件<input v-model="targetPart" :disabled="targetPartState === 'missing'" placeholder="xc7k70tfbv676-1" /></label>
            <label>板卡状态<select v-model="boardState"><option value="identified">已识别</option><option value="missing">尚缺失</option></select></label>
            <label>板卡标识<input v-model="boardRef" :disabled="boardState === 'missing'" placeholder="board-kc705-v1" /></label>
          </div>
          <div class="formal-constraint-grid">
            <label>引脚约束<select v-model="pinState"><option value="complete">完整</option><option value="partial">部分</option><option value="missing">缺失</option></select>
              <select v-model="pinRevisionIds" multiple :disabled="pinState === 'missing'"><option v-for="row in constraintRevisionOptions" :key="row.id" :value="row.id">{{ row.label }}</option></select>
            </label>
            <label>电气约束<select v-model="electricalState"><option value="complete">完整</option><option value="partial">部分</option><option value="missing">缺失</option></select>
              <select v-model="electricalRevisionIds" multiple :disabled="electricalState === 'missing'"><option v-for="row in constraintRevisionOptions" :key="row.id" :value="row.id">{{ row.label }}</option></select>
            </label>
            <label>时钟约束<select v-model="clockState"><option value="complete">完整</option><option value="partial">部分</option><option value="missing">缺失</option></select>
              <select v-model="clockRevisionIds" multiple :disabled="clockState === 'missing'"><option v-for="row in constraintRevisionOptions" :key="row.id" :value="row.id">{{ row.label }}</option></select>
            </label>
          </div>
          <label>已确认来源资料<select v-model="selectedSourceIds" multiple><option v-for="row in sourceSnapshotOptions" :key="row.id" :value="row.id">{{ row.label }}</option></select></label>
          <div class="formal-form-grid">
            <label>数据分类<select v-model="dataClassification"><option v-for="value in allowedClassifications" :key="value" :value="value">{{ value }}</option></select></label>
            <label>准备理由<input v-model="readinessReason" /></label>
          </div>
          <label>数据范围<textarea v-model="dataScopeDescription" rows="2" /></label>
          <p v-if="!workspaceReadyForReadiness" class="formal-warning">Core 尚未返回已登记的 commit 与同源 manifest，不能准备 G0。</p>
          <button type="submit" class="formal-primary" :disabled="!canPrepareReadiness">
            {{ operating ? "准备中…" : "生成 G0 准备清单" }}
          </button>
        </form>

        <div v-if="canConfirmReadiness" class="formal-confirm-readiness">
          <label>确认说明<input v-model="confirmReadinessReason" /></label>
          <button type="button" class="formal-primary" :disabled="!confirmReadinessReason.trim()" @click="emit('confirm-readiness', confirmReadinessReason.trim())">人工确认这份 G0 清单</button>
        </div>
      </section>

      <section class="formal-section">
        <div class="formal-section-title">
          <div>
            <p>正式输入</p>
            <h3>预览并人工确认</h3>
          </div>
          <span v-if="approval" class="formal-pill tone-ok">已确认</span>
          <span v-else-if="preview" class="formal-pill tone-warn">等待确认</span>
        </div>

        <ul v-if="formalInputBlockers.length" class="formal-blockers">
          <li v-for="blocker in formalInputBlockers" :key="blocker">{{ blocker }}</li>
        </ul>

        <button
          v-if="!preview && !approval"
          type="button"
          class="formal-primary"
          :disabled="!canPreview"
          @click="emit('preview-formal')"
        >
          {{ operating ? "正在生成预览…" : "预览正式输入" }}
        </button>

        <template v-if="preview || approval">
          <dl class="formal-facts">
            <div><dt>用途</dt><dd>G4 正式交付</dd></div>
            <div><dt>器件</dt><dd>{{ (approval ?? preview)?.target_part }}</dd></div>
            <div><dt>输入摘要</dt><dd class="mono">{{ shortHash((approval ?? preview)?.input_hash) }}</dd></div>
            <div><dt>前提里程碑</dt><dd>{{ (approval ?? preview)?.prerequisite_baseline_id }}</dd></div>
          </dl>
          <div class="formal-file-table" role="table" aria-label="正式输入文件">
            <div v-for="file in (approval ?? preview)?.files" :key="file.revision_id" class="formal-file-row" role="row">
              <span class="formal-file-path">{{ file.path }}</span>
              <span>{{ file.role }}</span>
              <span>{{ formatBytes(file.size_bytes) }}</span>
              <span class="mono">{{ shortHash(file.sha256) }}</span>
            </div>
          </div>
        </template>

        <template v-if="preview && !approval">
          <label class="formal-ack">
            <input v-model="acknowledged" type="checkbox" />
            我已核对上述文件、器件、约束和运行用途；确认后任何事实变化都需要重新预览。
          </label>
          <button type="button" class="formal-primary" :disabled="!acknowledged || operating" @click="emit('confirm-formal')">
            {{ operating ? "确认中…" : "确认这份正式输入" }}
          </button>
        </template>

        <div v-if="approval" class="formal-operations">
          <p>确认人 {{ approval.confirmed_by }} · {{ formatTime(approval.confirmed_at) }}</p>
          <p>
            {{ state?.completed ? "正式交付已密封" : formalProgress ? formalProgressText[formalProgress.status] : "等待 Runtime 读取确认事实" }}。
            四项正式运行由绑定的主 Runtime 自动编排，避免人工重复提交。
          </p>
          <ol class="formal-operation-progress" aria-label="正式运行进度">
            <li v-for="operation in formalOperations" :key="operation.id">
              <span>{{ operation.label }}</span>
              <strong>{{ formalJobState(operation.id) }}</strong>
              <code v-if="formalProgress?.jobs?.[operation.id]?.job_id">{{ shortHash(formalProgress.jobs[operation.id]?.job_id) }}</code>
            </li>
          </ol>
        </div>
      </section>

      <section class="formal-section">
        <div class="formal-section-title">
          <div><p>G4</p><h3>Hard checks</h3></div>
          <span class="formal-pill" :class="g4Checks.length && g4Checks.every((check) => check.status === 'passed') ? 'tone-ok' : 'tone-warn'">
            {{ g4Checks.filter((check) => check.status === 'passed').length }}/{{ g4Checks.length }} 通过
          </span>
        </div>
        <ul v-if="g4Checks.length" class="formal-hard-checks">
          <li v-for="check in g4Checks" :key="check.code" :class="`state-${check.status}`">
            <span aria-hidden="true">{{ check.status === "passed" ? "✓" : check.status === "failed" ? "×" : "·" }}</span>
            <strong>{{ check.label }}</strong>
            <small>{{ check.severity === "hard" ? "阻断项" : "提示项" }}</small>
          </li>
        </ul>
        <p v-else class="formal-empty">尚无 G4 evaluation；任何缺失项都不会被当作通过。</p>
      </section>

      <section class="formal-section">
        <div class="formal-section-title"><div><p>结果</p><h3>码流分类</h3></div></div>
        <div v-if="bitstreams.length" class="formal-result-list">
          <article v-for="bitstream in bitstreams" :key="bitstream.id">
            <span class="formal-pill" :class="bitstream.class === 'formal' ? 'tone-ok' : 'tone-warn'">
              {{ bitstreamClassText(bitstream.class) }}
            </span>
            <div><strong>{{ bitstream.target_part }}</strong><small>{{ formatTime(bitstream.generated_at) }}</small></div>
            <span>{{ formatBytes(bitstream.size_bytes) }}</span>
            <code>{{ shortHash(bitstream.sha256) }}</code>
          </article>
        </div>
        <p v-else class="formal-empty">尚无码流。试验结果不会被升级或混入正式交付。</p>
      </section>

      <section class="formal-section">
        <div class="formal-section-title"><div><p>交付</p><h3>已密封版本与 manifest</h3></div></div>
        <div v-if="releases.length" class="formal-release-layout">
          <nav class="formal-release-list" aria-label="交付版本">
            <button
              v-for="(release, index) in releases"
              :key="release.id"
              type="button"
              :class="{ selected: release.id === selectedReleaseId }"
              @click="emit('select-release', release.id)"
            >
              <strong>v{{ release.version }}</strong>
              <span>{{ index === 0 ? "当前密封版" : "历史密封版" }}</span>
              <small>{{ release.item_count }} 项</small>
            </button>
          </nav>
          <div v-if="selectedRelease" class="formal-release-detail">
            <button v-if="manifest" type="button" class="formal-secondary" :disabled="operating" @click="emit('download-manifest')">
              下载 delivery-manifest.v1
            </button>
            <dl class="formal-facts">
              <div><dt>清单摘要</dt><dd class="mono">{{ shortHash(selectedRelease.manifest_hash) }}</dd></div>
              <div><dt>确认人</dt><dd>{{ selectedRelease.confirmed_by ?? "待确认" }}</dd></div>
              <div><dt>发布时间</dt><dd>{{ formatTime(selectedRelease.released_at) }}</dd></div>
              <div><dt>清单版本</dt><dd>{{ manifest?.schema ?? "—" }}</dd></div>
            </dl>
            <ul class="formal-delivery-items">
              <li v-for="item in selectedRelease.items" :key="item.id">
                <span class="formal-pill">{{ DELIVERY_CATEGORY_TEXT[item.category] ?? "工程文件" }}</span>
                <span class="formal-delivery-path">{{ item.path }}</span>
                <span>{{ formatBytes(item.size_bytes) }}</span>
                <button type="button" :disabled="operating" @click="emit('download-item', item.path)">下载</button>
              </li>
            </ul>
          </div>
        </div>
        <p v-else class="formal-empty">尚无正式交付版本。只有通过 G4 的正式码流和冻结证据才能进入这里。</p>
      </section>

      <section class="formal-section">
        <div class="formal-section-title"><div><p>发布后修改</p><h3>变更请求与新工作版本</h3></div></div>
        <ul v-if="changeRequests.length" class="formal-change-list">
          <li v-for="change in changeRequests" :key="change.id">
            <span class="formal-pill" :class="change.state === 'open' ? 'tone-warn' : 'tone-ok'">{{ change.state === "open" ? "进行中" : change.state === "released" ? "已发布" : "已撤回" }}</span>
            <div><strong>{{ change.reason }}</strong><small>从 {{ change.impact_gate }} 重跑 · {{ change.affected_paths.length }} 个路径</small></div>
          </li>
        </ul>
        <form v-if="openChangeRequest" class="formal-change-form" @submit.prevent="withdrawChange">
          <label>撤回原因<textarea v-model="withdrawReason" rows="2" placeholder="说明为什么终止本次变更" /></label>
          <button type="submit" class="formal-secondary" :disabled="operating || !withdrawReason.trim()">撤回变更并恢复已发布版本</button>
        </form>
        <form v-else-if="currentRelease" class="formal-change-form" @submit.prevent="submitChangeRequest">
          <label>变更原因<textarea v-model="changeReason" rows="2" placeholder="说明为什么要修改已发布结果" /></label>
          <label>影响路径<textarea v-model="affectedPaths" rows="3" placeholder="每行一个相对路径" /></label>
          <label>最早重跑阶段<select v-model="impactGate"><option v-for="gate in changeImpactGateOptions()" :key="gate" :value="gate">{{ gate }}</option></select></label>
          <button type="submit" class="formal-primary" :disabled="operating || !changeReason.trim() || !affectedPaths.trim()">发起变更并创建新工作版本</button>
        </form>
        <p v-else-if="!currentRelease && changeRequests.length === 0" class="formal-empty">首个正式版本发布后，所有修改都必须从这里发起。</p>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.formal-panel {
  display: flex;
  flex-direction: column;
  width: min(720px, 94vw);
  height: 100%;
  background: var(--surface-panel);
  color: var(--text-primary);
  box-shadow: -12px 0 32px var(--shadow-color);
}

.formal-panel-header,
.formal-panel-toolbar,
.formal-section-title,
.formal-result-list article,
.formal-change-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.formal-panel-header {
  padding: var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}

.formal-panel-header h2,
.formal-section-title h3,
.formal-section-title p,
.formal-panel-eyebrow {
  margin: 0;
}

.formal-panel-eyebrow,
.formal-section-title p {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.formal-panel-close {
  width: 32px;
  height: 32px;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 24px;
}

.formal-panel-toolbar {
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}

.formal-link,
.formal-error button,
.formal-delivery-items button {
  border: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
}

.formal-notice,
.formal-error {
  margin: var(--space-3) var(--space-4) 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
}

.formal-notice {
  background: var(--accent-subtle);
  color: var(--text-primary);
}

.formal-error {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px var(--space-3);
  background: color-mix(in srgb, var(--state-danger) 12%, transparent);
  color: var(--state-danger);
}

.formal-error span {
  grid-column: 1;
}

.formal-error button {
  grid-column: 2;
  grid-row: 1 / 3;
}

.formal-loading {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-5);
}

.formal-loading span {
  height: 80px;
  border-radius: var(--radius-md);
  background: linear-gradient(90deg, var(--surface-hover), var(--surface-raised), var(--surface-hover));
  background-size: 200% 100%;
  animation: formal-shimmer 1.4s infinite;
}

.formal-loading p {
  color: var(--text-muted);
  text-align: center;
}

@keyframes formal-shimmer { to { background-position: -200% 0; } }

.formal-panel-scroll {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  overflow: auto;
}

.formal-section {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-base);
}

.formal-section-title {
  align-items: flex-start;
}

.formal-section-title small {
  color: var(--text-muted);
}

.formal-pill {
  display: inline-flex;
  align-items: center;
  width: max-content;
  padding: 2px 7px;
  border-radius: var(--radius-full);
  background: var(--surface-hover);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}

.formal-pill.tone-ok { background: color-mix(in srgb, var(--state-success) 14%, transparent); color: var(--state-success); }
.formal-pill.tone-warn { background: color-mix(in srgb, var(--state-warning) 14%, transparent); color: var(--state-warning); }
.formal-pill.tone-info { background: var(--accent-subtle); color: var(--accent); }

.formal-gates,
.formal-hard-checks,
.formal-delivery-items,
.formal-blockers,
.formal-change-list,
.formal-result-list,
.formal-check-grid {
  margin: 0;
  padding: 0;
  list-style: none;
}

.formal-gates {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--space-2);
}

.formal-gates li {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.formal-gates li.state-current,
.formal-gates li.state-gated { border-color: var(--accent); }
.formal-gates li.state-failed { border-color: var(--state-danger); }

.formal-gate-code,
.formal-gate-status {
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 700;
}

.formal-gate-copy {
  display: grid;
  gap: 3px;
}

.formal-gate-copy small {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.formal-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
  margin: 0;
}

.formal-facts div {
  display: grid;
  gap: 3px;
  min-width: 0;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
}

.formal-facts dt { color: var(--text-muted); font-size: 11px; }
.formal-facts dd { margin: 0; overflow: hidden; text-overflow: ellipsis; }

.formal-check-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
}

.formal-check-grid li,
.formal-hard-checks li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 7px var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
  font-size: var(--font-size-sm);
}

.formal-check-grid .passed,
.formal-hard-checks .state-passed { color: var(--state-success); }
.formal-check-grid .failed,
.formal-hard-checks .state-failed { color: var(--state-danger); }

.formal-warning,
.formal-blockers {
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--state-warning) 12%, transparent);
  color: var(--state-warning);
  font-size: var(--font-size-sm);
}

.formal-blockers { display: grid; gap: 4px; padding-left: 30px; list-style: disc; }

.formal-primary {
  min-height: 36px;
  padding: 7px var(--space-3);
  border: 0;
  border-radius: var(--radius-md);
  background: var(--accent);
  color: var(--text-on-accent);
  cursor: pointer;
  font-weight: 700;
}

.formal-primary:disabled,
.formal-operations button:disabled { opacity: .45; cursor: not-allowed; }

.formal-secondary {
  width: max-content;
  padding: 6px var(--space-2);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--accent);
  cursor: pointer;
}

.formal-secondary:disabled { opacity: .45; cursor: not-allowed; }

.formal-readiness-form,
.formal-confirm-readiness {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-panel);
}

.formal-readiness-form h4 { margin: 0; }

.formal-form-grid,
.formal-constraint-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.formal-constraint-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }

.formal-readiness-form label,
.formal-confirm-readiness label {
  display: grid;
  gap: 5px;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.formal-readiness-form input,
.formal-readiness-form textarea,
.formal-readiness-form select,
.formal-confirm-readiness input {
  width: 100%;
  min-width: 0;
  padding: 7px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-base);
  color: var(--text-primary);
  font: inherit;
}

.formal-readiness-form select[multiple] { min-height: 76px; }

.formal-file-table {
  display: grid;
  min-width: 0;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.formal-file-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 100px 72px 130px;
  gap: var(--space-2);
  padding: 7px var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12px;
}

.formal-file-row:last-child { border-bottom: 0; }
.formal-file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: var(--font-mono); font-size: 11px; }

.formal-ack {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.45;
}

.formal-operations {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--accent-subtle);
}

.formal-operations p { margin: 0; color: var(--text-secondary); font-size: var(--font-size-sm); }
.formal-operation-progress {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.formal-operation-progress li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-2);
  padding: 7px 9px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-panel);
  font-size: var(--font-size-sm);
}
.formal-operation-progress strong { color: var(--text-secondary); font-size: 11px; }
.formal-operation-progress code { color: var(--text-muted); font-size: 10px; }

.formal-hard-checks {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
}

.formal-hard-checks li strong { flex: 1; color: var(--text-primary); font-weight: 600; }
.formal-hard-checks li small { color: var(--text-muted); }

.formal-result-list,
.formal-change-list { display: grid; gap: var(--space-2); }
.formal-result-list article,
.formal-change-list li { justify-content: flex-start; padding: var(--space-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); }
.formal-result-list article div,
.formal-change-list li div { display: grid; flex: 1; gap: 2px; min-width: 0; }
.formal-result-list article small,
.formal-change-list li small { color: var(--text-muted); }
.formal-result-list article code { color: var(--text-muted); font-size: 10px; }

.formal-release-layout { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: var(--space-3); }
.formal-release-list { display: grid; align-content: start; gap: var(--space-2); }
.formal-release-list button { display: grid; gap: 3px; padding: var(--space-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: transparent; color: var(--text-primary); text-align: left; }
.formal-release-list button.selected { border-color: var(--accent); background: var(--accent-subtle); }
.formal-release-list span,
.formal-release-list small { color: var(--text-muted); font-size: 11px; }
.formal-release-detail { display: grid; gap: var(--space-3); min-width: 0; }
.formal-delivery-items { display: grid; gap: 4px; }
.formal-delivery-items li { display: grid; grid-template-columns: 80px minmax(0, 1fr) 70px auto; align-items: center; gap: var(--space-2); padding: 6px 0; border-bottom: 1px solid var(--border-subtle); font-size: 12px; }
.formal-delivery-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.formal-delivery-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.formal-change-form { display: grid; gap: var(--space-3); }
.formal-change-form label { display: grid; gap: 5px; color: var(--text-secondary); font-size: var(--font-size-sm); }
.formal-change-form textarea,
.formal-change-form select { width: 100%; padding: 7px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-panel); color: var(--text-primary); font: inherit; resize: vertical; }

.formal-empty { margin: 0; padding: var(--space-4); color: var(--text-muted); text-align: center; }

@media (max-width: 720px) {
  .formal-panel { width: 100vw; }
  .formal-panel-scroll { padding: var(--space-2); }
  .formal-section { padding: var(--space-3); }
  .formal-gates { grid-template-columns: 1fr; }
  .formal-gates li { grid-template-columns: 36px minmax(0, 1fr) auto; align-items: center; }
  .formal-gate-code { grid-column: 1; }
  .formal-gate-copy { grid-column: 2; }
  .formal-gate-status { grid-column: 3; }
  .formal-facts,
  .formal-check-grid,
  .formal-hard-checks,
  .formal-form-grid,
  .formal-constraint-grid { grid-template-columns: 1fr; }
  .formal-release-layout { grid-template-columns: 1fr; }
  .formal-release-list { grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); }
  .formal-file-row { grid-template-columns: minmax(0, 1fr) auto; }
  .formal-file-row .formal-file-path,
  .formal-file-row .mono { grid-column: 1 / -1; }
  .formal-file-row .mono { overflow-wrap: anywhere; }
  .formal-delivery-items li { grid-template-columns: 74px minmax(0, 1fr) auto; }
  .formal-delivery-items li > :nth-child(3) { display: none; }
  .formal-operation-progress li { grid-template-columns: minmax(0, 1fr) auto; }
  .formal-operation-progress code { display: none; }
}
</style>
