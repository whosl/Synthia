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
  <!--
    flex-none —— 卡片在对话栏这个 flex 列里绝不被压缩：它是当前唯一的阻塞点，
    宁可挤滚动区也不能把按钮挤没。产物多时由成员列表的 max-height 兜住。
  -->
  <div
    v-if="state !== 'hidden'"
    class="mx-3 mb-2 flex flex-none flex-col gap-2 rounded-md border bg-panel px-3 py-2"
    :class="[
      state === 'pending' ? 'border-[color-mix(in_srgb,var(--state-warn)_55%,var(--border-strong))]' : 'border-line-strong',
      state === 'pending' ? '' : 'opacity-80',
    ]"
  >
    <div class="flex items-center gap-2">
      <span class="flex-none" :class="state === 'approved' ? 'text-ok' : state === 'rejected' ? 'text-danger' : 'text-warn'" aria-hidden="true">◆</span>
      <span class="text-[13px] font-semibold text-fg" :title="gate">{{ review }}</span>
      <Badge v-if="state === 'pending'" tone="warn" variant="dot" size="sm">等待批准</Badge>
      <Badge v-else-if="state === 'approved'" tone="ok" variant="dot" size="sm">已通过</Badge>
      <Badge v-else tone="danger" variant="dot" size="sm">被驳回</Badge>
      <span v-if="state === 'pending' && waitedText" class="ml-auto text-xs text-fg-muted">{{ waitedText }}</span>
    </div>

    <!-- 已决态：只留一行结论，不再可操作 -->
    <p v-if="state === 'approved' && milestoneLine" class="m-0 text-xs leading-[1.55] text-ok">{{ milestoneLine }}</p>
    <p v-else-if="state === 'rejected'" class="m-0 text-xs leading-[1.55] text-fg-secondary">
      {{ rejectionReason ? `驳回理由：${rejectionReason}` : "已驳回，agent 已停止。" }}
    </p>

    <template v-if="state === 'pending'">
      <!-- 待审产物：点开逐项核对，复用中栏编辑器打开快照当时的版本 -->
      <button type="button" class="approval-members-toggle flex cursor-pointer items-center gap-1 self-start border-none bg-transparent p-0 text-left" @click="membersOpen = !membersOpen">
        <span class="w-[10px] text-fg-muted" aria-hidden="true">{{ membersOpen ? "▾" : "▸" }}</span>
        待审产物 · {{ memberCountText }}
      </button>
      <!-- 快照成员可能几十项，自己滚（max-height），别把对话流挤没 -->
      <div v-if="membersOpen" class="flex max-h-[180px] flex-col gap-[2px] overflow-y-auto pl-[14px]">
        <p v-if="membersError" class="m-0 text-xs text-warn">{{ membersError }}</p>
        <p v-else-if="members === null" class="m-0 text-xs text-fg-muted">正在读取待审产物…</p>
        <p v-else-if="members.length === 0" class="m-0 text-xs text-fg-muted">本次提交没有关联产物。</p>
        <!-- v-for 不能和 v-else 同元素（Vue 3 里 v-if 优先级更高，会读不到 v-for 作用域），故包一层 template -->
        <template v-else>
          <button
            v-for="member in members"
            :key="member.revisionId"
            type="button"
            class="flex items-center gap-1 rounded-sm border-none bg-transparent px-1 py-[2px] text-left"
            :class="member.artifactId ? 'cursor-pointer not-disabled:hover:bg-hover' : 'cursor-not-allowed'"
            :disabled="!member.artifactId"
            :title="member.artifactId ? '在编辑器中打开这一版' : '该产物已不可定位'"
            @click="onMemberClick(member)"
          >
            <span class="truncate text-xs" :class="member.artifactId ? 'text-brand' : 'text-fg-muted'">{{ memberLabel(member) }}</span>
          </button>
        </template>
      </div>

      <div class="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" :disabled="deciding" :loading="deciding" @click="emit('approve')">
          {{ buttonLabel }}
        </Button>
        <Button variant="danger" size="sm" :disabled="deciding" @click="rejectOpen = !rejectOpen">
          ✕ 驳回
        </Button>
      </div>

      <div v-if="rejectOpen" class="flex flex-col gap-1">
        <textarea
          v-model="rejectDraft"
          class="approval-reject-input max-h-[120px] min-h-[48px] w-full resize-none overflow-y-auto rounded-md border border-line bg-base p-2 text-fg placeholder:text-fg-muted focus-visible:border-danger"
          rows="2"
          placeholder="请说明驳回原因，agent 会据此停止本轮（必填）"
          :disabled="deciding"
        />
        <div class="flex justify-end gap-1">
          <Button variant="ghost" size="sm" :disabled="deciding" @click="rejectOpen = false">取消</Button>
          <Button variant="danger" size="sm" :disabled="!canReject || deciding" :loading="deciding" @click="submitReject">
            确认驳回
          </Button>
        </div>
      </div>
    </template>

    <div v-if="decisionError" class="rounded-sm bg-hover p-2">
      <p class="m-0 text-xs text-danger">{{ decisionError.text }}</p>
      <p v-if="decisionError.hint" class="m-0 mt-[2px] text-xs text-fg-muted">{{ decisionError.hint }}</p>
    </div>
  </div>
</template>

<style scoped>
/* 未分层全局 reset 的 button/textarea { font: inherit; color: inherit } 与
   :focus-visible 描边优先级高于 Tailwind utilities 层，这几条只能留在 scoped。 */
.approval-members-toggle {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.approval-members-toggle:hover {
  color: var(--text-primary);
}

.approval-reject-input {
  font-size: var(--font-size-sm);
  line-height: var(--line-height-chat);
}

.approval-reject-input:focus-visible {
  outline: none;
}
</style>
