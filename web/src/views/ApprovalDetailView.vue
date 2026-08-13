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
  GATE_REVIEW_NAMES,
  GATE_TO_BASELINE,
  BASELINE_NAMES,
  SUBMISSION_STATE_TEXT,
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
const reviewName = computed(() => GATE_REVIEW_NAMES[gate.value as GateId] ?? gate.value);
const milestone = computed(() => isMilestoneGate(gate.value));
const baselineKind = computed(() => (milestone.value ? GATE_TO_BASELINE[gate.value]! : null));
const baselineName = computed(() => (baselineKind.value ? BASELINE_NAMES[baselineKind.value] : null));
const inReview = computed(() => submission.value?.state === "in_review");
const stateText = computed(() => (submission.value ? (SUBMISSION_STATE_TEXT[submission.value.state] ?? submission.value.state) : ""));

/** 批准按钮文案：里程碑门明示后果（「批准并建立需求里程碑」）。 */
const approveLabel = computed(() =>
  baselineName.value ? `批准并建立${baselineName.value}` : "批准",
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
    <span v-if="submission" :title="submission.gate">· {{ reviewName }}</span>
  </h1>
  <p class="page-sub">
    <router-link to="/approvals">← 返回审批中心</router-link>
    <StatusBadge v-if="submission" :text="stateText" :kind="inReview ? 'warn' : submission.state === 'approved' ? 'ok' : submission.state === 'rejected' ? 'danger' : 'plain'" style="margin-left: 10px" />
  </p>

  <ErrorNotice v-if="loadError" :error="loadError" />
  <div v-if="loading" class="muted">加载中…</div>

  <template v-else-if="submission">
    <div v-if="approved" class="notice task-banner-done">
      ✓ 已批准<template v-if="baselineName">，并建立{{ baselineName }}</template>。
      <router-link to="/approvals">返回审批中心</router-link>
    </div>
    <div v-if="rejected" class="notice">已驳回。<router-link to="/approvals">返回审批中心</router-link></div>

    <div class="approval-layout">
      <!-- 主视觉：待审产物文档（2/3 宽） -->
      <div class="panel approval-docs">
        <h2>待审产物（{{ members.length }} 项，均为候选）</h2>
        <div v-if="!membersResolved" class="notice">未能解析本次提交的产物清单。</div>
        <div v-else-if="members.length === 0" class="muted">本次提交不包含产物。</div>

        <div v-for="m in members" :key="m.revisionId" class="panel" style="background: #fbfcfd">
          <div style="display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap">
            <strong>{{ m.meta?.title || "产物文档" }}</strong>
            <StatusBadge :text="m.meta ? (REVISION_STATE_TEXT[m.meta.state] ?? '候选') : '候选'" :kind="m.meta?.state === 'candidate' ? 'accent' : 'plain'" />
            <span v-if="m.meta" class="muted">v{{ m.meta.version }} · {{ new Date(m.meta.created_at).toLocaleString("zh-CN") }}</span>
          </div>
          <div v-if="m.html" class="markdown-body" style="margin-top: 10px" v-html="m.html"></div>
          <div v-else class="muted" style="margin-top: 8px">（该产物无内联内容{{ m.contentMissing ? "或内容不可用" : "" }}）</div>
        </div>
      </div>

      <!-- 操作区（1/3 宽） -->
      <div>
        <div v-if="inReview && !approved && !rejected" class="panel">
          <h2>批准</h2>
          <ErrorNotice v-if="approveError" :error="approveError" />
          <label class="field">
            <span>批准角色</span>
            <input v-model="approverRole" type="text" />
          </label>
          <label class="field">
            <span>批准意见（可选）</span>
            <textarea v-model="approveReason" rows="2" placeholder="记录到批准记录"></textarea>
          </label>
          <button class="btn" style="width: 100%" :disabled="approving" @click="doApprove">
            {{ approving ? "提交中…" : approveLabel }}
          </button>
          <p v-if="baselineName" class="muted" style="margin: 8px 0 0; font-size: 12px">
            批准后将自动建立{{ baselineName }}，作为后续阶段的输入里程碑。
          </p>
        </div>

        <div v-if="inReview && !approved && !rejected" class="panel">
          <h2>驳回</h2>
          <ErrorNotice v-if="rejectError" :error="rejectError" />
          <label class="field">
            <span>驳回理由（必填）</span>
            <textarea v-model="rejectReason" placeholder="说明退回原因，将记录到审批记录"></textarea>
          </label>
          <button class="btn danger" style="width: 100%" :disabled="rejecting || rejectReason.trim().length === 0" @click="doReject">
            {{ rejecting ? "提交中…" : "驳回" }}
          </button>
        </div>

        <div v-if="!inReview && !approved && !rejected" class="notice">
          该提交当前状态为「{{ stateText }}」，不在等待批准中，无法批准或驳回。
        </div>

        <details class="panel">
          <summary>提交信息 <span class="muted" style="font-size: 12px">（点击展开）</span></summary>
          <table class="data" style="margin-top: 12px">
            <tbody>
              <tr><th style="width: 90px">审查项</th><td>{{ reviewName }}</td></tr>
              <tr><th>提交人</th><td>{{ submission.submitter_id }}</td></tr>
              <tr><th>提交时间</th><td>{{ submission.submitted_at ? new Date(submission.submitted_at).toLocaleString("zh-CN") : "—" }}</td></tr>
              <tr v-if="submission.issues.length > 0"><th>遗留问题</th><td>{{ submission.issues.join("；") }}</td></tr>
            </tbody>
          </table>
        </details>
      </div>
    </div>
  </template>
</template>
