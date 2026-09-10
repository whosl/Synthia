<script setup lang="ts">
/**
 * 就地审批卡（spec §3.5 step 6）。钉在输入框上方、滚动容器之外——等待批准是
 * 当前唯一的阻塞点，往上翻历史时它不该滚走。
 *
 * 纯展示组件：不 import `api/index.ts`（见 project-view-contract.ts 开头的架构
 * 约束）。文案与禁用判定全部复用 `domain/unified.ts` 里已单测过的纯函数，本文件
 * 只留三个纯 UI 的 ref（产物展开 / 驳回展开 / 驳回草稿）。
 *
 * 决策后卡片不消失：`deriveApprovalCard` 会把 approved/rejected 继续留在这里当
 * 对话记录，只是换成不可操作的一行结论。
 */
import { computed, ref } from "vue";
import { waitText } from "../../domain/band.ts";
import {
  approvalButtonLabel,
  approvalMilestoneLine,
  rejectDisabled,
  type ApprovalMember,
} from "../../domain/unified.ts";
import type { ApprovalCardProps } from "../../views/project-view-contract.ts";
import Badge from "../ui/AppBadge.vue";
import Button from "../ui/AppButton.vue";

const props = defineProps<ApprovalCardProps>();

const emit = defineEmits<{
  approve: [];
  reject: [reason: string];
  "open-doc": [artifactId: string, revisionId: string];
}>();

const membersOpen = ref(false);
const rejectOpen = ref(false);
const rejectDraft = ref("");

const buttonLabel = computed(() => approvalButtonLabel(props.gate));
const milestoneLine = computed(() => approvalMilestoneLine(props.gate));
const canReject = computed(() => !rejectDisabled(rejectDraft.value));

/** 「已等待 12 分钟」——提交时刻缺失时不显示（宁可不写，也不写个假的）。 */
const waitedText = computed(() => {
  if (!props.submittedAt) return null;
  const ms = Date.now() - Date.parse(props.submittedAt);
  return Number.isFinite(ms) && ms > 0 ? `已等待 ${waitText(ms)}` : null;
});

const memberCountText = computed(() => {
  if (props.members === null) return "加载中…";
  return `${props.members.length} 项`;
});

/** 「需求规格说明 v3」——映射不到产物的成员只剩文档名，版本号省略。 */
function memberLabel(member: ApprovalMember): string {
  return member.version === null ? member.docName : `${member.docName} v${member.version}`;
}

function onMemberClick(member: ApprovalMember): void {
  if (!member.artifactId) return; // 映射不到产物 → 渲染成不可点的灰条
  emit("open-doc", member.artifactId, member.revisionId);
}

function submitReject(): void {
  if (!canReject.value || props.deciding) return;
  emit("reject", rejectDraft.value.trim());
}
</script>

<template>
  <div v-if="state !== 'hidden'" class="approval-card" :class="`state-${state}`">
    <div class="approval-head">
      <span class="approval-glyph" aria-hidden="true">◆</span>
      <span class="approval-title" :title="gate">{{ review }}</span>
      <Badge v-if="state === 'pending'" tone="warn" variant="dot" size="sm">等待批准</Badge>
      <Badge v-else-if="state === 'approved'" tone="ok" variant="dot" size="sm">已通过</Badge>
      <Badge v-else tone="danger" variant="dot" size="sm">被驳回</Badge>
      <span v-if="state === 'pending' && waitedText" class="approval-waited">{{ waitedText }}</span>
    </div>

    <!-- 已决态：只留一行结论，不再可操作 -->
    <p v-if="state === 'approved' && milestoneLine" class="approval-result ok">{{ milestoneLine }}</p>
    <p v-else-if="state === 'rejected'" class="approval-result danger">
      {{ rejectionReason ? `驳回理由：${rejectionReason}` : "已驳回，agent 已停止。" }}
    </p>

    <template v-if="state === 'pending'">
      <!-- 待审产物：点开逐项核对，复用中栏编辑器打开快照当时的版本 -->
      <button type="button" class="approval-members-toggle" @click="membersOpen = !membersOpen">
        <span class="approval-chevron" aria-hidden="true">{{ membersOpen ? "▾" : "▸" }}</span>
        待审产物 · {{ memberCountText }}
      </button>
      <div v-if="membersOpen" class="approval-members">
        <p v-if="membersError" class="approval-members-error">{{ membersError }}</p>
        <p v-else-if="members === null" class="approval-members-empty">正在读取待审产物…</p>
        <p v-else-if="members.length === 0" class="approval-members-empty">本次提交没有关联产物。</p>
        <!-- v-for 不能和 v-else 同元素（Vue 3 里 v-if 优先级更高，会读不到 v-for 作用域），故包一层 template -->
        <template v-else>
          <button
            v-for="member in members"
            :key="member.revisionId"
            type="button"
            class="approval-member"
            :class="{ unlinked: !member.artifactId }"
            :disabled="!member.artifactId"
            :title="member.artifactId ? '在编辑器中打开这一版' : '该产物已不可定位'"
            @click="onMemberClick(member)"
          >
            <span class="approval-member-name">{{ memberLabel(member) }}</span>
          </button>
        </template>
      </div>

      <div class="approval-actions">
        <Button variant="primary" size="sm" :disabled="deciding" :loading="deciding" @click="emit('approve')">
          {{ buttonLabel }}
        </Button>
        <Button variant="danger" size="sm" :disabled="deciding" @click="rejectOpen = !rejectOpen">
          ✕ 驳回
        </Button>
      </div>

      <div v-if="rejectOpen" class="approval-reject">
        <textarea
          v-model="rejectDraft"
          class="approval-reject-input"
          rows="2"
          placeholder="请说明驳回原因，agent 会据此停止本轮（必填）"
          :disabled="deciding"
        />
        <div class="approval-reject-actions">
          <Button variant="ghost" size="sm" :disabled="deciding" @click="rejectOpen = false">取消</Button>
          <Button variant="danger" size="sm" :disabled="!canReject || deciding" :loading="deciding" @click="submitReject">
            确认驳回
          </Button>
        </div>
      </div>
    </template>

    <div v-if="decisionError" class="approval-error">
      <p class="approval-error-text">{{ decisionError.text }}</p>
      <p v-if="decisionError.hint" class="approval-error-hint">{{ decisionError.hint }}</p>
    </div>
  </div>
</template>

<style scoped>
.approval-card {
  /* flex: none —— 卡片在 .chat-feed 这个 flex 列里绝不被压缩：它是当前唯一的
     阻塞点，宁可挤滚动区也不能把按钮挤没。产物多时由下面的 max-height 兜住。 */
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0 var(--space-3) var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-panel);
}

.state-pending {
  border-color: color-mix(in srgb, var(--state-warn) 55%, var(--border-strong));
}

.state-approved,
.state-rejected {
  opacity: 0.8;
}

.approval-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.approval-glyph {
  flex: none;
  color: var(--state-warn);
}

.state-approved .approval-glyph {
  color: var(--state-ok);
}

.state-rejected .approval-glyph {
  color: var(--state-danger);
}

.approval-title {
  color: var(--text-primary);
  font-size: var(--font-size-base);
  font-weight: 600;
}

.approval-waited {
  margin-left: auto;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.approval-result {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-chat);
}

.approval-result.ok {
  color: var(--state-ok);
}

.approval-result.danger {
  color: var(--text-secondary);
}

.approval-members-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.approval-members-toggle:hover {
  color: var(--text-primary);
}

.approval-chevron {
  width: 10px;
  color: var(--text-muted);
}

.approval-members {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* 快照成员可能几十项，自己滚，别把对话流挤没 */
  max-height: 180px;
  overflow-y: auto;
  padding-left: calc(10px + var(--space-1));
}

.approval-members-empty,
.approval-members-error {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.approval-members-error {
  color: var(--state-warn);
}

.approval-member {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-1);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--accent);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.approval-member:not(:disabled):hover {
  background: var(--surface-hover);
}

.approval-member.unlinked {
  color: var(--text-muted);
  cursor: not-allowed;
}

.approval-member-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.approval-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.approval-reject {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.approval-reject-input {
  width: 100%;
  min-height: 48px;
  max-height: 120px;
  padding: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--surface-base);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-chat);
  resize: none;
  overflow-y: auto;
}

.approval-reject-input:focus-visible {
  border-color: var(--state-danger);
  outline: none;
}

.approval-reject-input::placeholder {
  color: var(--text-muted);
}

.approval-reject-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-1);
}

.approval-error {
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
}

.approval-error-text {
  margin: 0;
  color: var(--state-danger);
  font-size: var(--font-size-sm);
}

.approval-error-hint {
  margin: 2px 0 0;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}
</style>
