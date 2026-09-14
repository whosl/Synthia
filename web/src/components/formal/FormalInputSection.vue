<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type {
  FormalInputApprovalV1,
  FormalInputPreviewV1,
  ProcessStateV1,
  TaskFormalInputState,
} from "../../api/types.ts";
import { formatDateTime } from "../../util/format-time.ts";
import Badge from "../ui/AppBadge.vue";
import Button from "../ui/AppButton.vue";
import { Checkbox } from "../ui/checkbox";
import { formatBytes, shortHash } from "./format.ts";

const props = defineProps<{
  readonly state: ProcessStateV1 | null;
  readonly preview: FormalInputPreviewV1 | null;
  readonly approval: FormalInputApprovalV1 | null;
  readonly formalProgress: TaskFormalInputState | null;
  readonly formalInputBlockers: readonly string[];
  readonly operating: boolean;
}>();

const emit = defineEmits<{
  "preview-formal": [];
  "confirm-formal": [];
}>();

const acknowledged = ref(false);

watch(() => props.preview?.preview_hash, () => {
  acknowledged.value = false;
});

const canPreview = computed(() => props.formalInputBlockers.length === 0 && !props.operating);

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
</script>

<template>
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
        <Checkbox v-model="acknowledged" class="mt-[3px]" />
        我已核对上述文件、器件、约束和运行用途；确认后任何事实变化都需要重新预览。
      </label>
      <Button variant="primary" class="h-9 w-full font-bold" :disabled="!acknowledged || operating" @click="emit('confirm-formal')">
        {{ operating ? "确认中…" : "确认这份正式输入" }}
      </Button>
    </template>

    <div v-if="approval" class="grid gap-2 rounded-md bg-brand-subtle p-3">
      <p class="m-0 text-xs text-fg-secondary">确认人 {{ approval.confirmed_by }} · {{ formatDateTime(approval.confirmed_at) }}</p>
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
</template>
