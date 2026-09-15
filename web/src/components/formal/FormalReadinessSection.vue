<script setup lang="ts">
import { computed, ref } from "vue";
import { Check, TriangleAlert, X } from "lucide-vue-next";
import type {
  ProcessStateV1,
  ProjectReadinessRecord,
} from "../../api/types.ts";
import {
  shouldPrepareReadiness,
  type ReadinessPreparationInput,
} from "../../domain/formal-delivery.ts";
import Badge from "../ui/AppBadge.vue";
import Button from "../ui/AppButton.vue";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";

const props = defineProps<{
  readonly state: ProcessStateV1 | null;
  readonly readinessRows: readonly ProjectReadinessRecord[];
  readonly operating: boolean;
  readonly projectTargetPart: string | null;
  readonly dataClassification: string;
  readonly constraintRevisionOptions: readonly { readonly id: string; readonly label: string }[];
  readonly sourceSnapshotOptions: readonly { readonly id: string; readonly label: string }[];
  readonly workspaceReadyForReadiness: boolean;
}>();

const emit = defineEmits<{
  "prepare-readiness": [input: ReadinessPreparationInput];
  "confirm-readiness": [reason: string];
}>();

const PRESENCE_STATE_TEXT = {
  identified: "已识别",
  missing: "尚缺失",
} as const;
const CONSTRAINT_STATE_TEXT = {
  complete: "完整",
  partial: "部分",
  missing: "缺失",
} as const;

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

const currentReadiness = computed(() => props.state?.readiness ?? null);
const latestReadiness = computed(() => props.readinessRows[0] ?? null);
const canConfirmReadiness = computed(() => (
  latestReadiness.value?.state === "ready"
  && latestReadiness.value.status !== "confirmed"
  && !props.operating
));
const readinessCoreChecks = computed(() => latestReadiness.value?.checks ?? latestReadiness.value?.check_results ?? []);

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

function revisionLabels(
  ids: readonly string[],
  options: readonly { readonly id: string; readonly label: string }[],
): string {
  return ids.map((id) => options.find((row) => row.id === id)?.label ?? id).join("、");
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
</script>

<template>
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
          <Check v-if="check.passed" :size="14" aria-hidden="true" class="shrink-0" />
          <TriangleAlert v-else :size="14" aria-hidden="true" class="shrink-0" />
          {{ check.label }}
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
        <Check v-if="check.passed" :size="14" aria-hidden="true" class="shrink-0" />
        <X v-else :size="14" aria-hidden="true" class="shrink-0" />
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
          <Select v-model="targetPartState">
            <SelectTrigger class="w-full">
              <SelectValue>{{ PRESENCE_STATE_TEXT[targetPartState] }}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="identified">已识别</SelectItem>
              <SelectItem value="missing">尚缺失</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label class="grid gap-[5px] text-xs text-fg-secondary">
          目标器件
          <Input v-model="targetPart" :disabled="targetPartState === 'missing'" placeholder="xc7k70tfbv676-1" class="bg-base" />
        </label>
        <label class="grid gap-[5px] text-xs text-fg-secondary">
          板卡状态
          <Select v-model="boardState">
            <SelectTrigger class="w-full">
              <SelectValue>{{ PRESENCE_STATE_TEXT[boardState] }}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="identified">已识别</SelectItem>
              <SelectItem value="missing">尚缺失</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label class="grid gap-[5px] text-xs text-fg-secondary">
          板卡标识
          <Input v-model="boardRef" :disabled="boardState === 'missing'" placeholder="board-kc705-v1" class="bg-base" />
        </label>
      </div>
      <div class="grid grid-cols-3 gap-2 max-[720px]:grid-cols-1">
        <label class="grid content-start gap-[5px] text-xs text-fg-secondary">
          引脚约束
          <Select v-model="pinState">
            <SelectTrigger class="w-full">
              <SelectValue>{{ CONSTRAINT_STATE_TEXT[pinState] }}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="complete">完整</SelectItem>
              <SelectItem value="partial">部分</SelectItem>
              <SelectItem value="missing">缺失</SelectItem>
            </SelectContent>
          </Select>
          <Select v-model="pinRevisionIds" multiple :disabled="pinState === 'missing'">
            <SelectTrigger class="w-full">
              <SelectValue>{{ revisionLabels(pinRevisionIds, constraintRevisionOptions) || "选择约束版本" }}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="row in constraintRevisionOptions" :key="row.id" :value="row.id">{{ row.label }}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label class="grid content-start gap-[5px] text-xs text-fg-secondary">
          电气约束
          <Select v-model="electricalState">
            <SelectTrigger class="w-full">
              <SelectValue>{{ CONSTRAINT_STATE_TEXT[electricalState] }}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="complete">完整</SelectItem>
              <SelectItem value="partial">部分</SelectItem>
              <SelectItem value="missing">缺失</SelectItem>
            </SelectContent>
          </Select>
          <Select v-model="electricalRevisionIds" multiple :disabled="electricalState === 'missing'">
            <SelectTrigger class="w-full">
              <SelectValue>{{ revisionLabels(electricalRevisionIds, constraintRevisionOptions) || "选择约束版本" }}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="row in constraintRevisionOptions" :key="row.id" :value="row.id">{{ row.label }}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label class="grid content-start gap-[5px] text-xs text-fg-secondary">
          时钟约束
          <Select v-model="clockState">
            <SelectTrigger class="w-full">
              <SelectValue>{{ CONSTRAINT_STATE_TEXT[clockState] }}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="complete">完整</SelectItem>
              <SelectItem value="partial">部分</SelectItem>
              <SelectItem value="missing">缺失</SelectItem>
            </SelectContent>
          </Select>
          <Select v-model="clockRevisionIds" multiple :disabled="clockState === 'missing'">
            <SelectTrigger class="w-full">
              <SelectValue>{{ revisionLabels(clockRevisionIds, constraintRevisionOptions) || "选择约束版本" }}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="row in constraintRevisionOptions" :key="row.id" :value="row.id">{{ row.label }}</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>
      <label class="grid gap-[5px] text-xs text-fg-secondary">
        已确认来源资料
        <Select v-model="selectedSourceIds" multiple>
          <SelectTrigger class="w-full">
            <SelectValue>{{ revisionLabels(selectedSourceIds, sourceSnapshotOptions) || "选择来源资料" }}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="row in sourceSnapshotOptions" :key="row.id" :value="row.id">{{ row.label }}</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <div class="grid grid-cols-2 gap-2 max-[720px]:grid-cols-1">
        <label class="grid gap-[5px] text-xs text-fg-secondary">
          数据分类
          <Select v-model="dataClassification">
            <SelectTrigger class="w-full">
              <SelectValue>{{ dataClassification }}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="value in allowedClassifications" :key="value" :value="value">{{ value }}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label class="grid gap-[5px] text-xs text-fg-secondary">
          准备理由
          <Input v-model="readinessReason" class="bg-base" />
        </label>
      </div>
      <label class="grid gap-[5px] text-xs text-fg-secondary">
        数据范围
        <Textarea v-model="dataScopeDescription" rows="2" class="bg-base" />
      </label>
      <p v-if="!workspaceReadyForReadiness" class="my-[1em] rounded-sm bg-warn/12 p-3 text-xs text-warn">Core 尚未返回已登记的 commit 与同源 manifest，不能准备 G0。</p>
      <Button type="submit" variant="primary" class="h-9 w-full font-bold" :disabled="!canPrepareReadiness">
        {{ operating ? "准备中…" : "生成 G0 准备清单" }}
      </Button>
    </form>

    <div v-if="canConfirmReadiness" class="grid gap-3 rounded-md border border-line bg-panel p-3">
      <label class="grid gap-[5px] text-xs text-fg-secondary">
        确认说明
        <Input v-model="confirmReadinessReason" class="bg-base" />
      </label>
      <Button variant="primary" class="h-9 w-full font-bold" :disabled="!confirmReadinessReason.trim()" @click="emit('confirm-readiness', confirmReadinessReason.trim())">人工确认这份 G0 清单</Button>
    </div>
  </section>
</template>
