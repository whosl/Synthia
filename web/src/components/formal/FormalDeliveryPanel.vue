<script setup lang="ts">
import { computed } from "vue";
import type {
  BitstreamResultV1,
  ChangeRequestV1,
  CreateChangeRequestV1,
  DeliveryManifestV1,
  DeliveryReleaseDetailV1,
  DeliveryReleaseSummaryV1,
  FormalInputApprovalV1,
  FormalInputPreviewV1,
  ProcessProfileV1,
  ProcessStateV1,
  ProjectReadinessRecord,
  ProjectWorkVersionV1,
  TaskFormalInputState,
} from "../../api/types.ts";
import type { G4CheckRow, ReadinessPreparationInput } from "../../domain/formal-delivery.ts";
import type { ProcessGateView } from "../../domain/process-profile.ts";
import PanelHeader from "../panels/PanelHeader.vue";
import { Alert } from "../ui/alert";
import Badge from "../ui/AppBadge.vue";
import Button from "../ui/AppButton.vue";
import { Skeleton } from "../ui/skeleton";
import FormalBitstreamsSection from "./FormalBitstreamsSection.vue";
import FormalChangeRequestSection from "./FormalChangeRequestSection.vue";
import FormalG4ChecksSection from "./FormalG4ChecksSection.vue";
import FormalGateChainSection from "./FormalGateChainSection.vue";
import FormalInputSection from "./FormalInputSection.vue";
import FormalReadinessSection from "./FormalReadinessSection.vue";
import FormalReleaseSection from "./FormalReleaseSection.vue";

const props = defineProps<{
  readonly open: boolean;
  readonly loading: boolean;
  readonly operating: boolean;
  readonly error: string | null;
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

const currentRelease = computed(() => [...props.releases].sort((a, b) => b.version - a.version)[0] ?? null);
</script>

<template>
  <aside
    v-if="open"
    class="flex h-full flex-col bg-panel text-fg"
    aria-label="正式流程与交付"
  >
    <PanelHeader
      eyebrow="P4 · 正式工程闭环"
      title="流程、证据与交付"
      close-label="关闭正式流程面板"
      @close="emit('close')"
    />

    <div class="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
      <Badge v-if="state?.completed" tone="ok" size="sm" class="font-bold">G4 已完成</Badge>
      <Badge v-else-if="state" tone="accent" size="sm" class="font-bold">当前 {{ state.currentGate }}</Badge>
      <Badge v-else size="sm" class="font-bold">状态不可用</Badge>
      <Button variant="ghost" size="sm" class="text-brand hover:text-brand-hover" :disabled="loading" @click="emit('refresh')">刷新事实</Button>
    </div>

    <Alert
      v-if="error"
      variant="destructive"
      class="mx-4 mt-3 grid w-auto grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-md border-transparent bg-danger/12 p-3 text-xs text-danger"
    >
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
    </Alert>

    <div v-if="loading" class="grid gap-3 p-5" aria-live="polite">
      <Skeleton v-for="n in 4" :key="n" class="h-20 rounded-md" />
      <p class="text-center text-fg-muted">正在读取 Core 正式事实…</p>
    </div>

    <div v-else class="grid gap-3 overflow-auto p-4 max-[720px]:p-2">
      <FormalGateChainSection
        :profile="profile"
        :gate-chain="gateChain"
        :work-version="workVersion"
      />
      <FormalReadinessSection
        :state="state"
        :readiness-rows="readinessRows"
        :operating="operating"
        :project-target-part="projectTargetPart"
        :data-classification="dataClassification"
        :constraint-revision-options="constraintRevisionOptions"
        :source-snapshot-options="sourceSnapshotOptions"
        :workspace-ready-for-readiness="workspaceReadyForReadiness"
        @prepare-readiness="emit('prepare-readiness', $event)"
        @confirm-readiness="emit('confirm-readiness', $event)"
      />
      <FormalInputSection
        :state="state"
        :preview="preview"
        :approval="approval"
        :formal-progress="formalProgress"
        :formal-input-blockers="formalInputBlockers"
        :operating="operating"
        @preview-formal="emit('preview-formal')"
        @confirm-formal="emit('confirm-formal')"
      />
      <FormalG4ChecksSection :g4-checks="g4Checks" />
      <FormalBitstreamsSection :bitstreams="bitstreams" />
      <FormalReleaseSection
        :releases="releases"
        :selected-release-id="selectedReleaseId"
        :selected-release="selectedRelease"
        :manifest="manifest"
        :operating="operating"
        @select-release="emit('select-release', $event)"
        @download-item="emit('download-item', $event)"
        @download-manifest="emit('download-manifest')"
      />
      <FormalChangeRequestSection
        :change-requests="changeRequests"
        :current-release="currentRelease"
        :operating="operating"
        @create-change-request="emit('create-change-request', $event)"
        @withdraw-change-request="(changeRequestId, reason) => emit('withdraw-change-request', changeRequestId, reason)"
      />
    </div>
  </aside>
</template>
