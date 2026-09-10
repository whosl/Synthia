<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { X } from "lucide-vue-next";
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
import Badge from "../ui/AppBadge.vue";
import Button from "../ui/AppButton.vue";
import { Skeleton } from "../ui/skeleton";

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
  <aside
    v-if="open"
    class="flex h-full w-[min(720px,94vw)] flex-col bg-panel text-fg shadow-[-12px_0_32px_var(--shadow-color)] max-[720px]:w-screen"
    aria-label="正式流程与交付"
  >
    <header class="flex items-center justify-between gap-3 border-b border-line p-4">
      <div>
        <p class="m-0 text-[11px] font-bold tracking-[0.08em] text-fg-muted uppercase">P4 · 正式工程闭环</p>
        <h2 class="m-0">流程、证据与交付</h2>
      </div>
      <Button variant="ghost" size="sm" class="h-8 w-8 px-0" aria-label="关闭正式流程面板" @click="emit('close')">
        <X :size="20" aria-hidden="true" />
      </Button>
    </header>

    <div class="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
      <Badge v-if="state?.completed" tone="ok" size="sm" class="font-bold">G4 已完成</Badge>
      <Badge v-else-if="state" tone="accent" size="sm" class="font-bold">当前 {{ state.currentGate }}</Badge>
      <Badge v-else size="sm" class="font-bold">状态不可用</Badge>
      <Button variant="ghost" size="sm" class="text-brand hover:text-brand-hover" :disabled="loading" @click="emit('refresh')">刷新事实</Button>
    </div>

    <div v-if="notice" class="mx-4 mt-3 rounded-md bg-brand-subtle p-3 text-xs" role="status">{{ notice }}</div>
    <div v-if="error" class="mx-4 mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-md bg-danger/12 p-3 text-xs text-danger" role="alert">
      <strong>正式能力未就绪</strong>
      <span class="col-start-1">{{ error }}</span>
      <Button
        variant="ghost"
        size="sm"
        class="col-start-2 row-span-2 row-start-1 self-center text-brand hover:text-brand-hover"
        @click="emit('refresh')"
      >
        重试
      </Button>
    </div>

    <div v-if="loading" class="grid gap-3 p-5" aria-live="polite">
      <Skeleton v-for="n in 4" :key="n" class="h-20 rounded-md" />
      <p class="text-center text-fg-muted">正在读取 Core 正式事实…</p>
    </div>

    <div v-else class="grid gap-3 overflow-auto p-4 max-[720px]:p-2">
      <section class="grid min-w-0 gap-3 rounded-lg border border-line bg-base p-4 max-[720px]:p-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="m-0 text-[11px] font-bold tracking-[0.08em] text-fg-muted uppercase">G0–G4</p>
            <h3 class="m-0">{{ profile?.name ?? "工程流程" }}</h3>
          </div>
          <small v-if="workVersion" class="text-fg-muted">工作版本 v{{ workVersion.version }} · {{ workVersion.state === 'released' ? '已发布' : '工作中' }}</small>
        </div>
        <ol v-if="gateChain" class="m-0 grid list-none grid-cols-5 gap-2 p-0 max-[720px]:grid-cols-1">
          <li
            v-for="entry in gateChain"
            :key="entry.node.id"
            class="grid min-w-0 gap-[5px] rounded-md border p-2 max-[720px]:grid-cols-[36px_minmax(0,1fr)_auto] max-[720px]:items-center"
            :class="entry.status === 'current' || entry.status === 'gated' ? 'border-brand' : entry.status === 'failed' ? 'border-danger' : 'border-line'"
          >
            <span class="text-[10px] font-bold text-fg-muted">{{ entry.node.id }}</span>
            <span class="grid gap-[3px]">
              <strong>{{ entry.node.name }}</strong>
              <small class="line-clamp-3 text-[11px] leading-[1.35] text-fg-muted">{{ entry.node.goal }}</small>
            </span>
            <span class="text-[10px] font-bold text-fg-muted">{{ PROCESS_GATE_STATUS_TEXT[entry.status] }}</span>
          </li>
        </ol>
        <p v-else class="m-0 p-4 text-center text-fg-muted">Core 尚未返回可验证的 G0–G4 状态，正式操作保持锁定。</p>
      </section>

      <section class="grid min-w-0 gap-3 rounded-lg border border-line bg-base p-4 max-[720px]:p-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="m-0 text-[11px] font-bold tracking-[0.08em] text-fg-muted uppercase">G0</p>
            <h3 class="m-0">项目准备</h3>
          </div>
          <Badge size="sm" class="font-bold" :tone="currentReadiness?.ready ? 'ok' : 'warn'">
            {{ currentReadiness?.ready ? "已确认" : latestReadiness?.state === "ready" ? "待人工确认" : latestReadiness ? "被阻断" : "尚未评估" }}
          </Badge>
        </div>
        <template v-if="currentReadiness">
          <dl class="m-0 grid grid-cols-2 gap-2 max-[720px]:grid-cols-1">
            <div class="grid min-w-0 gap-[3px] rounded-sm bg-hover p-2">
              <dt class="text-[11px] text-fg-muted">器件</dt>
              <dd class="m-0 overflow-hidden text-ellipsis">{{ currentReadiness.targetPart }}</dd>
            </div>
            <div class="grid min-w-0 gap-[3px] rounded-sm bg-hover p-2">
              <dt class="text-[11px] text-fg-muted">板卡</dt>
              <dd class="m-0 overflow-hidden text-ellipsis">{{ currentReadiness.boardRef }}</dd>
            </div>
            <div class="grid min-w-0 gap-[3px] rounded-sm bg-hover p-2">
              <dt class="text-[11px] text-fg-muted">确认人</dt>
              <dd class="m-0 overflow-hidden text-ellipsis">{{ currentReadiness.confirmedBy?.id ?? "待确认" }}</dd>
            </div>
            <div class="grid min-w-0 gap-[3px] rounded-sm bg-hover p-2">
              <dt class="text-[11px] text-fg-muted">准备记录</dt>
              <dd class="m-0 overflow-hidden text-ellipsis">{{ readinessRows.length }} 版</dd>
            </div>
          </dl>
          <ul class="m-0 grid list-none grid-cols-2 gap-[5px] p-0 max-[720px]:grid-cols-1">
            <li
              v-for="check in readinessChecks"
              :key="check.label"
              class="flex items-center gap-2 rounded-sm bg-hover px-2 py-[7px] text-xs"
              :class="check.passed ? 'text-ok' : 'text-danger'"
            >
              <span aria-hidden="true">{{ check.passed ? "✓" : "!" }}</span>{{ check.label }}
            </li>
          </ul>
          <p v-if="currentReadiness.ready && !currentReadiness.constraintsComplete" class="my-[1em] rounded-sm bg-warn/12 p-3 text-xs text-warn">
            G0 已如实记录，但约束不完整：只能生成试验码流，不能确认正式输入。
          </p>
        </template>
        <p v-else-if="!latestReadiness" class="m-0 p-4 text-center text-fg-muted">尚无 G0 readiness。先如实记录工程配置、来源与工作区。</p>

        <ul v-if="readinessCoreChecks.length" class="m-0 grid list-none grid-cols-2 gap-[5px] p-0 max-[720px]:grid-cols-1">
          <li
            v-for="check in readinessCoreChecks"
            :key="check.code"
            class="flex items-center gap-2 rounded-sm bg-hover px-2 py-[7px] text-xs"
            :class="check.passed ? 'text-ok' : 'text-danger'"
          >
            <span aria-hidden="true">{{ check.passed ? "✓" : "×" }}</span>
            <strong class="flex-1 font-semibold text-fg">{{ check.code }}</strong>
            <small class="text-fg-muted">{{ check.passed ? "通过" : "阻断" }}</small>
          </li>
        </ul>

        <form v-if="shouldPrepareReadiness(state)" class="grid gap-3 rounded-md border border-line bg-panel p-3" @submit.prevent="prepareReadiness">
          <h4 class="m-0">准备新的 G0 清单</h4>
          <p v-if="currentReadiness?.ready" class="my-[1em] rounded-sm bg-warn/12 p-3 text-xs text-warn">
            当前 G0 已完成，但工程约束仍不完整。请形成并确认一版完整 readiness 后再进入正式输入。
          </p>
          <div class="grid grid-cols-2 gap-2 max-[720px]:grid-cols-1">
            <label class="grid gap-[5px] text-xs text-fg-secondary">
              目标器件状态
              <select v-model="targetPartState" class="w-full min-w-0 rounded-sm border border-line-strong bg-base p-[7px] text-fg [font:inherit]">
                <option value="identified">已识别</option>
                <option value="missing">尚缺失</option>
              </select>
            </label>
            <label class="grid gap-[5px] text-xs text-fg-secondary">
              目标器件
              <input v-model="targetPart" :disabled="targetPartState === 'missing'" placeholder="xc7k70tfbv676-1" class="w-full min-w-0 rounded-sm border border-line-strong bg-base p-[7px] text-fg [font:inherit]" />
            </label>
            <label class="grid gap-[5px] text-xs text-fg-secondary">
              板卡状态
              <select v-model="boardState" class="w-full min-w-0 rounded-sm border border-line-strong bg-base p-[7px] text-fg [font:inherit]">
                <option value="identified">已识别</option>
                <option value="missing">尚缺失</option>
              </select>
            </label>
            <label class="grid gap-[5px] text-xs text-fg-secondary">
              板卡标识
              <input v-model="boardRef" :disabled="boardState === 'missing'" placeholder="board-kc705-v1" class="w-full min-w-0 rounded-sm border border-line-strong bg-base p-[7px] text-fg [font:inherit]" />
            </label>
          </div>
          <div class="grid grid-cols-3 gap-2 max-[720px]:grid-cols-1">
            <label class="grid gap-[5px] text-xs text-fg-secondary">
              引脚约束
              <select v-model="pinState" class="w-full min-w-0 rounded-sm border border-line-strong bg-base p-[7px] text-fg [font:inherit]">
                <option value="complete">完整</option>
                <option value="partial">部分</option>
                <option value="missing">缺失</option>
              </select>
              <select v-model="pinRevisionIds" multiple :disabled="pinState === 'missing'" class="min-h-[76px] w-full min-w-0 rounded-sm border border-line-strong bg-base p-[7px] text-fg [font:inherit]">
                <option v-for="row in constraintRevisionOptions" :key="row.id" :value="row.id">{{ row.label }}</option>
              </select>
            </label>
            <label class="grid gap-[5px] text-xs text-fg-secondary">
              电气约束
              <select v-model="electricalState" class="w-full min-w-0 rounded-sm border border-line-strong bg-base p-[7px] text-fg [font:inherit]">
                <option value="complete">完整</option>
                <option value="partial">部分</option>
                <option value="missing">缺失</option>
              </select>
              <select v-model="electricalRevisionIds" multiple :disabled="electricalState === 'missing'" class="min-h-[76px] w-full min-w-0 rounded-sm border border-line-strong bg-base p-[7px] text-fg [font:inherit]">
                <option v-for="row in constraintRevisionOptions" :key="row.id" :value="row.id">{{ row.label }}</option>
              </select>
            </label>
            <label class="grid gap-[5px] text-xs text-fg-secondary">
              时钟约束
              <select v-model="clockState" class="w-full min-w-0 rounded-sm border border-line-strong bg-base p-[7px] text-fg [font:inherit]">
                <option value="complete">完整</option>
                <option value="partial">部分</option>
                <option value="missing">缺失</option>
              </select>
              <select v-model="clockRevisionIds" multiple :disabled="clockState === 'missing'" class="min-h-[76px] w-full min-w-0 rounded-sm border border-line-strong bg-base p-[7px] text-fg [font:inherit]">
                <option v-for="row in constraintRevisionOptions" :key="row.id" :value="row.id">{{ row.label }}</option>
              </select>
            </label>
          </div>
          <label class="grid gap-[5px] text-xs text-fg-secondary">
            已确认来源资料
            <select v-model="selectedSourceIds" multiple class="min-h-[76px] w-full min-w-0 rounded-sm border border-line-strong bg-base p-[7px] text-fg [font:inherit]">
              <option v-for="row in sourceSnapshotOptions" :key="row.id" :value="row.id">{{ row.label }}</option>
            </select>
          </label>
          <div class="grid grid-cols-2 gap-2 max-[720px]:grid-cols-1">
            <label class="grid gap-[5px] text-xs text-fg-secondary">
              数据分类
              <select v-model="dataClassification" class="w-full min-w-0 rounded-sm border border-line-strong bg-base p-[7px] text-fg [font:inherit]">
                <option v-for="value in allowedClassifications" :key="value" :value="value">{{ value }}</option>
              </select>
            </label>
            <label class="grid gap-[5px] text-xs text-fg-secondary">
              准备理由
              <input v-model="readinessReason" class="w-full min-w-0 rounded-sm border border-line-strong bg-base p-[7px] text-fg [font:inherit]" />
            </label>
          </div>
          <label class="grid gap-[5px] text-xs text-fg-secondary">
            数据范围
            <textarea v-model="dataScopeDescription" rows="2" class="w-full min-w-0 rounded-sm border border-line-strong bg-base p-[7px] text-fg [font:inherit]" />
          </label>
          <p v-if="!workspaceReadyForReadiness" class="my-[1em] rounded-sm bg-warn/12 p-3 text-xs text-warn">Core 尚未返回已登记的 commit 与同源 manifest，不能准备 G0。</p>
          <Button type="submit" variant="primary" class="h-9 w-full font-bold" :disabled="!canPrepareReadiness">
            {{ operating ? "准备中…" : "生成 G0 准备清单" }}
          </Button>
        </form>

        <div v-if="canConfirmReadiness" class="grid gap-3 rounded-md border border-line bg-panel p-3">
          <label class="grid gap-[5px] text-xs text-fg-secondary">
            确认说明
            <input v-model="confirmReadinessReason" class="w-full min-w-0 rounded-sm border border-line-strong bg-base p-[7px] text-fg [font:inherit]" />
          </label>
          <Button variant="primary" class="h-9 w-full font-bold" :disabled="!confirmReadinessReason.trim()" @click="emit('confirm-readiness', confirmReadinessReason.trim())">人工确认这份 G0 清单</Button>
        </div>
      </section>

      <section class="grid min-w-0 gap-3 rounded-lg border border-line bg-base p-4 max-[720px]:p-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="m-0 text-[11px] font-bold tracking-[0.08em] text-fg-muted uppercase">正式输入</p>
            <h3 class="m-0">预览并人工确认</h3>
          </div>
          <Badge v-if="approval" tone="ok" size="sm" class="font-bold">已确认</Badge>
          <Badge v-else-if="preview" tone="warn" size="sm" class="font-bold">等待确认</Badge>
        </div>

        <ul v-if="formalInputBlockers.length" class="m-0 grid list-disc gap-1 rounded-sm bg-warn/12 p-3 pl-[30px] text-xs text-warn">
          <li v-for="blocker in formalInputBlockers" :key="blocker">{{ blocker }}</li>
        </ul>

        <Button
          v-if="!preview && !approval"
          variant="primary"
          class="h-9 w-full font-bold"
          :disabled="!canPreview"
          @click="emit('preview-formal')"
        >
          {{ operating ? "正在生成预览…" : "预览正式输入" }}
        </Button>

        <template v-if="preview || approval">
          <dl class="m-0 grid grid-cols-2 gap-2 max-[720px]:grid-cols-1">
            <div class="grid min-w-0 gap-[3px] rounded-sm bg-hover p-2">
              <dt class="text-[11px] text-fg-muted">用途</dt>
              <dd class="m-0 overflow-hidden text-ellipsis">G4 正式交付</dd>
            </div>
            <div class="grid min-w-0 gap-[3px] rounded-sm bg-hover p-2">
              <dt class="text-[11px] text-fg-muted">器件</dt>
              <dd class="m-0 overflow-hidden text-ellipsis">{{ (approval ?? preview)?.target_part }}</dd>
            </div>
            <div class="grid min-w-0 gap-[3px] rounded-sm bg-hover p-2">
              <dt class="text-[11px] text-fg-muted">输入摘要</dt>
              <dd class="m-0 overflow-hidden font-mono text-[11px] text-ellipsis">{{ shortHash((approval ?? preview)?.input_hash) }}</dd>
            </div>
            <div class="grid min-w-0 gap-[3px] rounded-sm bg-hover p-2">
              <dt class="text-[11px] text-fg-muted">前提里程碑</dt>
              <dd class="m-0 overflow-hidden text-ellipsis">{{ (approval ?? preview)?.prerequisite_baseline_id }}</dd>
            </div>
          </dl>
          <div class="grid min-w-0 overflow-auto rounded-md border border-line" role="table" aria-label="正式输入文件">
            <div
              v-for="file in (approval ?? preview)?.files"
              :key="file.revision_id"
              class="grid grid-cols-[minmax(180px,1fr)_100px_72px_130px] gap-2 border-b border-line px-2 py-[7px] text-xs last:border-b-0 max-[720px]:grid-cols-[minmax(0,1fr)_auto]"
              role="row"
            >
              <span class="truncate max-[720px]:col-span-full">{{ file.path }}</span>
              <span>{{ file.role }}</span>
              <span>{{ formatBytes(file.size_bytes) }}</span>
              <span class="font-mono text-[11px] max-[720px]:col-span-full max-[720px]:wrap-anywhere">{{ shortHash(file.sha256) }}</span>
            </div>
          </div>
        </template>

        <template v-if="preview && !approval">
          <label class="flex items-start gap-2 text-xs leading-[1.45] text-fg-secondary">
            <input v-model="acknowledged" type="checkbox" />
            我已核对上述文件、器件、约束和运行用途；确认后任何事实变化都需要重新预览。
          </label>
          <Button variant="primary" class="h-9 w-full font-bold" :disabled="!acknowledged || operating" @click="emit('confirm-formal')">
            {{ operating ? "确认中…" : "确认这份正式输入" }}
          </Button>
        </template>

        <div v-if="approval" class="grid gap-2 rounded-md bg-brand-subtle p-3">
          <p class="m-0 text-xs text-fg-secondary">确认人 {{ approval.confirmed_by }} · {{ formatTime(approval.confirmed_at) }}</p>
          <p class="m-0 text-xs text-fg-secondary">
            {{ state?.completed ? "正式交付已密封" : formalProgress ? formalProgressText[formalProgress.status] : "等待 Runtime 读取确认事实" }}。
            四项正式运行由绑定的主 Runtime 自动编排，避免人工重复提交。
          </p>
          <ol class="m-0 grid list-none gap-1 p-0" aria-label="正式运行进度">
            <li
              v-for="operation in formalOperations"
              :key="operation.id"
              class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-sm border border-line bg-panel px-[9px] py-[7px] text-xs max-[720px]:grid-cols-[minmax(0,1fr)_auto]"
            >
              <span>{{ operation.label }}</span>
              <strong class="text-[11px] text-fg-secondary">{{ formalJobState(operation.id) }}</strong>
              <code v-if="formalProgress?.jobs?.[operation.id]?.job_id" class="text-[10px] text-fg-muted max-[720px]:hidden">{{ shortHash(formalProgress.jobs[operation.id]?.job_id) }}</code>
            </li>
          </ol>
        </div>
      </section>

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
            <span aria-hidden="true">{{ check.status === "passed" ? "✓" : check.status === "failed" ? "×" : "·" }}</span>
            <strong class="flex-1 font-semibold text-fg">{{ check.label }}</strong>
            <small class="text-fg-muted">{{ check.severity === "hard" ? "阻断项" : "提示项" }}</small>
          </li>
        </ul>
        <p v-else class="m-0 p-4 text-center text-fg-muted">尚无 G4 evaluation；任何缺失项都不会被当作通过。</p>
      </section>

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
              <small class="text-fg-muted">{{ formatTime(bitstream.generated_at) }}</small>
            </div>
            <span>{{ formatBytes(bitstream.size_bytes) }}</span>
            <code class="text-[10px] text-fg-muted">{{ shortHash(bitstream.sha256) }}</code>
          </article>
        </div>
        <p v-else class="m-0 p-4 text-center text-fg-muted">尚无码流。试验结果不会被升级或混入正式交付。</p>
      </section>

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
                <dd class="m-0 overflow-hidden text-ellipsis">{{ formatTime(selectedRelease.released_at) }}</dd>
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

      <section class="grid min-w-0 gap-3 rounded-lg border border-line bg-base p-4 max-[720px]:p-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="m-0 text-[11px] font-bold tracking-[0.08em] text-fg-muted uppercase">发布后修改</p>
            <h3 class="m-0">变更请求与新工作版本</h3>
          </div>
        </div>
        <ul v-if="changeRequests.length" class="m-0 grid list-none gap-2 p-0">
          <li v-for="change in changeRequests" :key="change.id" class="flex items-center gap-3 rounded-md border border-line p-2">
            <Badge size="sm" class="font-bold" :tone="change.state === 'open' ? 'warn' : 'ok'">{{ change.state === "open" ? "进行中" : change.state === "released" ? "已发布" : "已撤回" }}</Badge>
            <div class="grid min-w-0 flex-1 gap-[2px]">
              <strong>{{ change.reason }}</strong>
              <small class="text-fg-muted">从 {{ change.impact_gate }} 重跑 · {{ change.affected_paths.length }} 个路径</small>
            </div>
          </li>
        </ul>
        <form v-if="openChangeRequest" class="grid gap-3" @submit.prevent="withdrawChange">
          <label class="grid gap-[5px] text-xs text-fg-secondary">
            撤回原因
            <textarea v-model="withdrawReason" rows="2" placeholder="说明为什么终止本次变更" class="w-full resize-y rounded-sm border border-line-strong bg-panel p-[7px] text-fg [font:inherit]" />
          </label>
          <Button type="submit" variant="ghost" class="w-max rounded-sm border border-brand px-2 text-brand hover:bg-brand-subtle hover:text-brand" :disabled="operating || !withdrawReason.trim()">撤回变更并恢复已发布版本</Button>
        </form>
        <form v-else-if="currentRelease" class="grid gap-3" @submit.prevent="submitChangeRequest">
          <label class="grid gap-[5px] text-xs text-fg-secondary">
            变更原因
            <textarea v-model="changeReason" rows="2" placeholder="说明为什么要修改已发布结果" class="w-full resize-y rounded-sm border border-line-strong bg-panel p-[7px] text-fg [font:inherit]" />
          </label>
          <label class="grid gap-[5px] text-xs text-fg-secondary">
            影响路径
            <textarea v-model="affectedPaths" rows="3" placeholder="每行一个相对路径" class="w-full resize-y rounded-sm border border-line-strong bg-panel p-[7px] text-fg [font:inherit]" />
          </label>
          <label class="grid gap-[5px] text-xs text-fg-secondary">
            最早重跑阶段
            <select v-model="impactGate" class="w-full resize-y rounded-sm border border-line-strong bg-panel p-[7px] text-fg [font:inherit]">
              <option v-for="gate in changeImpactGateOptions()" :key="gate" :value="gate">{{ gate }}</option>
            </select>
          </label>
          <Button type="submit" variant="primary" class="h-9 w-full font-bold" :disabled="operating || !changeReason.trim() || !affectedPaths.trim()">发起变更并创建新工作版本</Button>
        </form>
        <p v-else-if="!currentRelease && changeRequests.length === 0" class="m-0 p-4 text-center text-fg-muted">首个正式版本发布后，所有修改都必须从这里发起。</p>
      </section>
    </div>
  </aside>
</template>
