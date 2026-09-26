<script setup lang="ts">
import { computed } from "vue";
import { FileText, RefreshCw, ShieldCheck, ArrowUpRight } from "lucide-vue-next";
import type { GateSubmission, GateSubmissionDetail } from "../../api/types.ts";
import type { ApprovalCardProps } from "../../views/project-view-contract.ts";
import type { ApprovalMember } from "../../domain/unified.ts";
import ApprovalCard from "../chat/ApprovalCard.vue";

const props = defineProps<{
  rows: readonly GateSubmission[];
  selected: GateSubmissionDetail | null;
  card: ApprovalCardProps | null;
  members: readonly ApprovalMember[] | null;
  membersError: string | null;
  loading: boolean;
  selecting: boolean;
  error: string | null;
  gateNames: Readonly<Record<string, string>>;
}>();
const emit = defineEmits<{
  select: [id: string]; refresh: []; approve: []; reject: [reason: string];
  "open-doc": [artifactId: string, revisionId: string];
}>();
const sorted = computed(() => [...props.rows].sort((a, b) =>
  Number(b.state === "in_review") - Number(a.state === "in_review") || Date.parse(b.created_at) - Date.parse(a.created_at),
));
const pending = computed(() => props.rows.filter((row) => row.state === "in_review").length);
const states: Record<string, string> = { preparing: "准备中", submitted: "已提交", checking: "检查中", in_review: "待审批", approved: "已批准", rejected: "已驳回", withdrawn: "已撤回" };
function date(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <section class="project-reviews" aria-label="项目阶段审批">
    <header class="review-heading">
      <div><p class="eyebrow">ENGINEERING REVIEW</p><h2>阶段审批 <span v-if="pending">{{ pending }} 项待处理</span></h2><p>核对本次提交的文件与证据，再决定是否进入下一阶段。</p></div>
      <button type="button" class="refresh" :disabled="loading || selecting || card?.deciding" @click="emit('refresh')"><RefreshCw :size="14" />刷新</button>
    </header>
    <p v-if="error" class="review-error" role="alert">{{ error }}</p>
    <p v-if="loading && !rows.length" role="status">正在读取阶段提交…</p>
    <div v-else-if="!rows.length && !error" class="review-empty"><ShieldCheck :size="32" /><h3>暂无阶段提交</h3><p>工程阶段提交审查后，会在这里列出待审文件，并提供批准与驳回操作。</p></div>
    <template v-else>
      <div class="review-list" aria-label="阶段提交记录">
        <button v-for="row in sorted" :key="row.id" type="button" :class="{ selected: selected?.id === row.id }" :disabled="card?.deciding" :aria-pressed="selected?.id === row.id" @click="emit('select', row.id)">
          <span class="review-name">{{ gateNames[row.gate] ?? row.gate }}</span>
          <span class="review-state" :class="row.state">{{ states[row.state] ?? row.state }}</span>
          <time :datetime="row.created_at">{{ date(row.submitted_at ?? row.created_at) }}</time>
        </button>
      </div>
      <p v-if="selecting" role="status">正在读取审批快照…</p>
      <div v-else-if="selected" class="review-detail">
        <div class="review-caption"><h3>{{ gateNames[selected.gate] ?? selected.gate }}</h3><span>提交人 · {{ selected.submitter_id }}</span></div>
        <ApprovalCard v-if="card" :key="selected.id" v-bind="card" :hide-members="true" @approve="emit('approve')" @reject="emit('reject', $event)" />
        <p v-else class="review-note">{{ states[selected.state] ?? selected.state }} · 当前提交不可审批</p>
        <div class="materials-title"><strong>提交快照</strong><span>点击文件，在新标签中核对提交时的版本</span></div>
        <p v-if="membersError" class="review-error" role="alert">{{ membersError }}</p>
        <p v-else-if="members === null" role="status">正在读取快照文件…</p>
        <p v-else-if="!members.length" class="review-note">本次提交没有关联文件。</p>
        <div v-else class="review-materials">
          <button v-for="member in members" :key="member.revisionId" type="button" :disabled="!member.artifactId" :title="member.artifactId ? '打开只读快照' : '该快照文件暂不可定位'" @click="member.artifactId && emit('open-doc', member.artifactId, member.revisionId)">
            <FileText :size="16" /><span>{{ member.docName }}<small>{{ member.version === null ? '版本不可定位' : `v${member.version} · 快照只读` }}</small></span><ArrowUpRight :size="14" />
          </button>
        </div>
      </div>
      <p v-else class="review-note">选择一条阶段提交，查看快照和审批结果。</p>
    </template>
  </section>
</template>

<style scoped>
.project-reviews { height: 100%; overflow: auto; padding: 24px; font-size: 12px; color: var(--text-secondary); }
.review-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 22px; }
.eyebrow { margin: 0 0 8px; font-size: 9px; letter-spacing: 2px; color: var(--accent); }
h2 { margin: 0; font-size: 23px; font-weight: 550; color: var(--text-primary); }
h2 span { display: inline-block; margin-left: 8px; font-size: 11px; color: var(--state-warn); }
p { line-height: 1.8; }
.refresh { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border: 1px solid var(--border-subtle); border-radius: 5px; background: var(--surface-panel); color: var(--text-secondary); cursor: pointer; }
.review-list { display: grid; max-height: 210px; overflow: auto; border: 1px solid var(--border-subtle); border-radius: 8px; }
.review-list button { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; text-align: left; padding: 12px; border: 0; border-bottom: 1px solid var(--border-subtle); background: var(--surface-panel); color: var(--text-secondary); cursor: pointer; font-size: 11px; }
.review-list button:last-child { border-bottom: 0; }
.review-list button.selected { background: var(--accent-subtle); box-shadow: inset 2px 0 var(--accent); }
.review-name { flex: 1; min-width: 90px; color: var(--text-primary); }
.review-state.in_review { color: var(--state-warn); }
.review-state.approved { color: var(--state-ok); }
.review-state.rejected { color: var(--state-danger); }
.review-list time { font-size: 10px; color: var(--text-muted); }
.review-detail { margin-top: 24px; }
.review-caption { display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
h3 { margin: 0; font-size: 14px; color: var(--text-primary); }
.review-caption span { font-size: 10px; overflow-wrap: anywhere; }
.review-detail :deep(.mx-3) { margin-left: 0; margin-right: 0; }
.materials-title { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; margin: 22px 0 12px; }
.materials-title strong { color: var(--text-primary); font-size: 12px; }
.materials-title span { font-size: 10px; }
.review-materials { display: grid; gap: 6px; }
.review-materials button { display: flex; align-items: center; gap: 10px; padding: 12px; background: var(--surface-panel); border: 1px solid var(--border-subtle); border-radius: 6px; color: var(--text-secondary); text-align: left; cursor: pointer; }
.review-materials button span { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--text-primary); }
.review-materials small { display: block; margin-top: 4px; color: var(--text-muted); font-size: 10px; }
button:disabled { opacity: .5; cursor: not-allowed; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.review-empty { display: grid; justify-items: center; padding: 60px 12px; text-align: center; }
.review-empty h3 { margin-top: 16px; }
.review-empty p { max-width: 310px; }
.review-error { color: var(--state-danger); }
.review-note { color: var(--text-muted); }
@media (max-width: 600px) { .project-reviews { padding: 18px 14px; } }
</style>
