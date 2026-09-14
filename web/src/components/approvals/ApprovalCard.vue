<script setup lang="ts">
/** 审批中心的单条待审批卡片（与 chat/ApprovalCard.vue 无关，那是 run 内联审批卡）。 */
import { ArrowRight, Inbox } from "lucide-vue-next";
import { formatActivity, type PendingReview } from "../../domain/project-overview.ts";
import Badge from "../ui/AppBadge.vue";

defineProps<{ item: PendingReview }>();
</script>

<template>
  <article
    class="flex items-center gap-5 rounded-[12px] border border-line bg-panel p-6 max-[600px]:flex-wrap max-[600px]:gap-3 max-[600px]:p-[18px]"
  >
    <span
      class="grid size-11 shrink-0 place-items-center rounded-[12px] bg-warn/10 text-warn max-[600px]:hidden"
      ><Inbox :size="18"
    /></span>
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-3">
        <h3 class="m-0 text-[15px] font-[550]">{{ item.title }}</h3>
        <Badge size="sm" tone="warn">等待确认</Badge>
      </div>
      <p class="my-2">{{ item.project.name }}</p>
      <span
        class="text-[11px] leading-[1.7] wrap-anywhere text-fg-secondary"
        >{{ item.submission.submitter_id }} 提交 ·
        {{
          formatActivity(
            item.submission.submitted_at ?? item.submission.created_at,
          )
        }}</span
      >
    </div>
    <router-link
      class="flex items-center gap-2 text-xs whitespace-nowrap max-[600px]:w-full max-[600px]:border-t max-[600px]:border-line max-[600px]:pt-3.5"
      :to="{
        name: 'project',
        params: { id: item.project.id },
        query: { sub: item.submission.id },
      }"
      >查看并处理<ArrowRight :size="16"
    /></router-link>
  </article>
</template>
