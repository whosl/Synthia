<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "../main.ts";
import {
  approveGateSubmission,
  getGateSubmission,
  getRevisionContent,
  listArtifacts,
  listEvents,
  listRevisions,
  rejectGateSubmission,
} from "../api/index.ts";
import type {
  ArtifactRevision,
  GateSubmissionDetail,
  RevisionContent,
  SnapshotCreatedPayload,
} from "../api/types.ts";
import {
  GATE_NAMES,
  GATE_TO_BASELINE,
  BASELINE_NAMES,
  isMilestoneGate,
  makeBaselineId,
  REVISION_STATE_TEXT,
  type GateId,
} from "../domain/gates.ts";
import { renderMarkdown } from "../domain/markdown.ts";
import { sha256Hex } from "../util/sha256.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import StatusBadge from "../components/StatusBadge.vue";

interface MemberView {
  readonly revisionId: string;
  readonly artifactId: string | null;
  readonly meta: ArtifactRevision | null;
  readonly content: RevisionContent | null;
  readonly contentMissing: boolean;
  readonly html: string | null;
}

const route = useRoute();
const projectId = String(route.params.projectId);
const subId = String(route.params.subId);

const submission = ref<GateSubmissionDetail | null>(null);
const members = ref<MemberView[]>([]);
const membersResolved = ref(false);
const loading = ref(true);
const loadError = ref<unknown>(null);

// 批准表单
const approverRole = ref("quality");
const approveReason = ref("");
const approving = ref(false);
const approveError = ref<unknown>(null);
const approved = ref(false);

// 驳回表单
const rejectReason = ref("");
const rejecting = ref(false);
const rejectError = ref<unknown>(null);
const rejected = ref(false);

const gate = computed(() => submission.value?.gate ?? "");
const gateName = computed(() => GATE_NAMES[gate.value as GateId] ?? gate.value);
const milestone = computed(() => isMilestoneGate(gate.value));
const baselineKind = computed(() => (milestone.value ? GATE_TO_BASELINE[gate.value]! : null));
const inReview = computed(() => submission.value?.state === "in_review");

/** 批准按钮文案：里程碑门明示将建立的基线。 */
const approveLabel = computed(() =>
  milestone.value && baselineKind.value ? `批准并建立 ${baselineKind.value} 基线` : "批准",
);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    const sub = await getGateSubmission(api, projectId, subId);
    submission.value = sub;

    // 解析快照成员：snapshot.created 事件 payload 携带 memberRevisionIds
    const snapEvents = await listEvents(api, projectId, {
      aggregateType: "configuration_snapshot",
      aggregateId: sub.snapshot_id,
    });
    const created = snapEvents.find((e) => e.event_type === "snapshot.created");
    const payload = created?.payload as SnapshotCreatedPayload | undefined;
    const memberIds = payload && Array.isArray(payload.memberRevisionIds) ? payload.memberRevisionIds : null;
    membersResolved.value = memberIds !== null;

    if (memberIds) {
      // 修订 → 产物 映射（content 端点需要 artifactId）
      const artifacts = await listArtifacts(api, projectId);
      const revIndex = new Map<string, { artifactId: string; meta: ArtifactRevision }>();
      await Promise.all(
        artifacts.map(async (artifact) => {
          const revisions = await listRevisions(api, projectId, artifact.id);
          for (const meta of revisions) revIndex.set(meta.id, { artifactId: artifact.id, meta });
        }),
      );

      members.value = await Promise.all(
        memberIds.map(async (revisionId): Promise<MemberView> => {
          const found = revIndex.get(revisionId);
          if (!found) {
            return { revisionId, artifactId: null, meta: null, content: null, contentMissing: true, html: null };
          }
          try {
            const content = await getRevisionContent(api, projectId, found.artifactId, revisionId);
            return {
              revisionId,
              artifactId: found.artifactId,
              meta: found.meta,
              content,
              contentMissing: false,
              html: renderMarkdown(content.content),
            };
          } catch {
            return { revisionId, artifactId: found.artifactId, meta: found.meta, content: null, contentMissing: true, html: null };
          }
        }),
      );
    }
  } catch (err) {
    loadError.value = err;
  } finally {
    loading.value = false;
  }
}

async function doApprove() {
  const sub = submission.value;
  if (!sub || approving.value) return;
  approving.value = true;
  approveError.value = null;
  try {
    const checkResultsHash = await sha256Hex(JSON.stringify(sub.check_results ?? null));
    await approveGateSubmission(
      api,
      projectId,
      subId,
      {
        configuration_snapshot_id: sub.snapshot_id,
        approved_gate_result_id: `agr-${sub.id}`,
        approver_role: approverRole.value.trim() || "quality",
        check_results_hash: checkResultsHash,
        signed_at: new Date().toISOString(),
        signature_method: "platform_token",
        ...(approveReason.value.trim() ? { reason: approveReason.value.trim() } : {}),
        baseline_id: milestone.value ? makeBaselineId(sub.gate as GateId) : null,
      },
      crypto.randomUUID(),
    );
    approved.value = true;
    await load();
  } catch (err) {
    approveError.value = err;
  } finally {
    approving.value = false;
  }
}

async function doReject() {
  const sub = submission.value;
  const reason = rejectReason.value.trim();
  if (!sub || rejecting.value) return;
  if (reason.length === 0) {
    rejectError.value = new Error("驳回理由必填");
    return;
  }
  rejecting.value = true;
  rejectError.value = null;
  try {
    await rejectGateSubmission(api, projectId, subId, reason, crypto.randomUUID());
    rejected.value = true;
    await load();
  } catch (err) {
    rejectError.value = err;
  } finally {
    rejecting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <h1 class="page-title">
    审批处理
    <span v-if="submission">{{ submission.gate }} {{ gateName }}</span>
  </h1>
  <p class="page-sub mono">
    项目 {{ projectId }} · 提交 {{ subId }}
  </p>

  <ErrorNotice v-if="loadError" :error="loadError" />
  <div v-if="loading" class="muted">加载中…</div>

  <template v-else-if="submission">
    <div v-if="approved" class="notice">
      已批准<template v-if="baselineKind">，并建立 {{ baselineKind }} {{ BASELINE_NAMES[baselineKind] }}</template>。
      <router-link to="/approvals">返回审批中心</router-link>
    </div>
    <div v-if="rejected" class="notice">已驳回。<router-link to="/approvals">返回审批中心</router-link></div>

    <div class="panel">
      <h2>提交信息</h2>
      <table class="data">
        <tbody>
          <tr><th style="width: 140px">门禁</th><td><strong>{{ submission.gate }}</strong> {{ gateName }}
            <StatusBadge v-if="baselineKind" :text="`里程碑门 · ${baselineKind} ${BASELINE_NAMES[baselineKind]}`" kind="accent" />
          </td></tr>
          <tr><th>状态</th><td><StatusBadge :text="submission.state" :kind="inReview ? 'warn' : submission.state === 'approved' ? 'ok' : submission.state === 'rejected' ? 'danger' : 'plain'" /></td></tr>
          <tr><th>提交人</th><td class="mono">{{ submission.submitter_id }}</td></tr>
          <tr><th>提交时间</th><td>{{ submission.submitted_at ? new Date(submission.submitted_at).toLocaleString("zh-CN") : "—" }}</td></tr>
          <tr><th>配置快照</th><td class="mono">{{ submission.snapshot_id }}</td></tr>
          <tr><th>流程实例</th><td class="mono">{{ submission.process_instance_id }}</td></tr>
          <tr v-if="submission.issues.length > 0"><th>遗留问题</th><td>{{ submission.issues.join("；") }}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h2>快照内修订内容（{{ members.length }} 项，均为 Agent 候选产物）</h2>
      <div v-if="!membersResolved" class="notice">未能从事件流解析快照成员（缺少 snapshot.created 事件）。</div>
      <div v-else-if="members.length === 0" class="muted">快照无成员修订。</div>

      <div v-for="m in members" :key="m.revisionId" class="panel" style="background: #fbfcfd">
        <div style="display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap">
          <strong>{{ m.meta?.title || m.revisionId }}</strong>
          <StatusBadge :text="m.meta ? (REVISION_STATE_TEXT[m.meta.state] ?? m.meta.state) : '未知'" :kind="m.meta?.state === 'candidate' ? 'accent' : 'plain'" />
          <span v-if="m.meta" class="muted">v{{ m.meta.version }}</span>
          <span class="mono muted" style="font-size: 11px">{{ m.revisionId }}</span>
        </div>
        <div v-if="m.html" class="markdown-body" style="margin-top: 10px" v-html="m.html"></div>
        <div v-else class="muted" style="margin-top: 8px">（该修订无内联内容{{ m.contentMissing ? "或内容不可用" : "" }}）</div>
        <div v-if="m.meta" class="mono muted" style="font-size: 11px; margin-top: 8px">
          hash {{ m.meta.content_hash.slice(0, 16) }}… · 创建于 {{ new Date(m.meta.created_at).toLocaleString("zh-CN") }}
        </div>
      </div>
    </div>

    <div v-if="inReview && !approved && !rejected" class="panel">
      <h2>批准</h2>
      <ErrorNotice v-if="approveError" :error="approveError" />
      <div class="row-actions">
        <label class="field" style="width: 200px">
          <span>批准角色（须有对应项目角色授权）</span>
          <input v-model="approverRole" type="text" />
        </label>
        <label class="field" style="flex: 1; min-width: 240px">
          <span>批准意见（可选）</span>
          <input v-model="approveReason" type="text" placeholder="记录到批准记录 reason" />
        </label>
        <button class="btn" :disabled="approving" @click="doApprove">
          {{ approving ? "提交中…" : approveLabel }}
        </button>
      </div>
      <p v-if="milestone && baselineKind" class="muted" style="margin: 8px 0 0; font-size: 12px">
        批准后将自动建立 {{ baselineKind }} {{ BASELINE_NAMES[baselineKind] }}（基线 id 形如 bl-{{ gate.toLowerCase() }}-&lt;时间戳&gt;）。
      </p>
    </div>

    <div v-if="inReview && !approved && !rejected" class="panel">
      <h2>驳回</h2>
      <ErrorNotice v-if="rejectError" :error="rejectError" />
      <label class="field">
        <span>驳回理由（必填）</span>
        <textarea v-model="rejectReason" placeholder="说明退回原因，将记录到审批记录与 gate_submission.rejected 事件"></textarea>
      </label>
      <button class="btn danger" :disabled="rejecting || rejectReason.trim().length === 0" @click="doReject">
        {{ rejecting ? "提交中…" : "驳回" }}
      </button>
    </div>

    <div v-else-if="!inReview && !approved && !rejected" class="notice">
      该提交当前状态为 {{ submission.state }}，不在审批中，无法批准或驳回。
    </div>
  </template>
</template>
