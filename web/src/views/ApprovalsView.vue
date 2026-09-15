<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  Check,
  Inbox,
  RefreshCw,
  Search,
} from "lucide-vue-next";
import { api } from "../api/service.ts";
import { useProjectOverview } from "../composables/use-project-overview.ts";
import { createPoller, type Poller } from "../domain/tasks.ts";
import PageShell from "../components/layout/PageShell.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import ApprovalCard from "../components/approvals/ApprovalCard.vue";
import Button from "../components/ui/AppButton.vue";
import { Button as UiButton } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";

const { loading, refreshing, error, reviews, incompleteRows, reload } =
  useProjectOverview(api);
const query = ref("");
const visibleReviews = computed(() =>
  reviews.value.filter((item) =>
    `${item.project.name} ${item.title} ${item.submission.submitter_id}`
      .toLocaleLowerCase()
      .includes(query.value.trim().toLocaleLowerCase()),
  ),
);
const missingReviews = computed(() =>
  incompleteRows.value.filter((row) =>
    row.issues.some((issue) => issue.label === "待审批记录"),
  ),
);

// 30s 轻轮询：仅标签页可见时拉取（reload 内部对并发 refreshing 去重）
let poller: Poller | null = null;
onMounted(() => {
  poller = createPoller(() => {
    if (document.visibilityState === "hidden") return;
    void reload();
  }, 30000);
});
onBeforeUnmount(() => {
  poller?.stop();
  poller = null;
});
</script>

<template>
  <PageShell section="approvals">
    <div
      class="mb-8 flex items-center justify-between gap-6 max-[600px]:mb-6 max-[600px]:items-start max-[600px]:gap-3"
    >
      <div>
        <p class="m-0 mb-2.5 text-[10px] font-semibold tracking-[2px] text-brand">
          REVIEW & CONTINUE
        </p>
        <!-- clamp/text-[28px] 为响应式标题排印，无对应字号 token，保留任意值 -->
        <h1
          class="m-0 mb-3 text-[clamp(26px,2.8vw,36px)] leading-[1.3] font-semibold tracking-[-1px] max-[600px]:text-[28px]"
        >
          每次确认，都有依据<span class="text-brand">.</span>
        </h1>
        <p
          class="m-0 leading-[1.7] text-fg-secondary max-[600px]:max-w-[230px] max-[600px]:text-xs"
        >
          集中查看待审批提交，进入项目核对快照、证据并作出决定。
        </p>
      </div>
      <Button :loading="refreshing" @click="reload"
        ><RefreshCw :size="16" />刷新</Button
      >
    </div>
    <!-- rounded-[12px]：圆角刻度 sm=4/md=6/lg=10/xl=14 无 12px 档，保留任意值 -->
    <div
      class="mb-8 flex items-center gap-[18px] rounded-[12px] border border-line bg-panel p-6"
    >
      <span
        class="grid size-11 shrink-0 place-items-center rounded-[12px] bg-warn/10 text-warn"
        ><Inbox :size="24"
      /></span>
      <div>
        <strong class="text-xl font-[550]"
          >{{ loading ? "—" : reviews.length }} 项等待审批</strong
        >
        <p class="m-0 mt-2 text-xs text-fg-secondary">
          {{
            missingReviews.length || error
              ? "部分项目尚未加载，待审批数量可能不完整。"
              : "批准或驳回后，项目将按流程继续推进。"
          }}
        </p>
      </div>
    </div>
    <ErrorNotice v-if="error" :error="error" />
    <div
      v-if="missingReviews.length"
      class="mb-6 flex items-start gap-3 rounded-lg border bg-[color-mix(in_srgb,var(--state-warn)_5%,var(--surface-panel))] p-4 leading-[1.7] text-warn [border-color:color-mix(in_srgb,var(--state-warn)_25%,var(--border-subtle))]"
      role="status"
    >
      <Inbox :size="18" class="mt-[3px] shrink-0" /><span class="flex-1"
        >以下项目的审批记录未加载，其他项目仍可处理。<span
          v-for="row in missingReviews"
          :key="row.project.id"
          class="block text-[11px] text-fg-secondary"
          >{{ row.project.name }}</span
        ></span
      ><Button :loading="refreshing" @click="reload">重试</Button>
    </div>
    <section aria-labelledby="reviews-title">
      <div
        class="mb-[18px] flex items-center justify-between gap-3 max-[600px]:flex-wrap"
      >
        <h2 id="reviews-title" class="m-0 text-[17px] font-semibold">
          待审批记录
          <!-- rounded-[5px]/min-w-[22px]/text-[11px] 等密度微调无 token 档，保留任意值 -->
          <span
            class="ml-2 inline-flex min-w-[22px] items-center justify-center rounded-[5px] bg-hover px-[5px] py-0.5 text-[11px] text-fg-secondary"
            >{{ visibleReviews.length }}</span
          >
        </h2>
        <label
          class="flex items-center gap-2 rounded-[8px] border border-line bg-panel px-3 text-fg-muted focus-within:border-brand focus-within:outline-2 focus-within:outline-brand-subtle max-[600px]:w-full"
          ><Search :size="16" class="shrink-0" /><Input
            v-model="query"
            type="search"
            class="h-9 w-52 min-w-0 border-none bg-transparent px-0 text-xs shadow-none focus-visible:ring-0 max-[600px]:w-full"
            aria-label="搜索审批记录"
            placeholder="搜索项目、阶段或提交人…"
        /></label>
      </div>
      <div
        v-if="loading"
        class="grid gap-3"
        role="status"
        aria-label="正在加载审批记录"
      >
        <div
          v-for="n in 3"
          :key="n"
          class="flex items-center gap-5 rounded-[12px] border border-line bg-panel p-6"
        >
          <Skeleton class="size-11 rounded-[12px]" />
          <div class="grid flex-1 content-start gap-2.5">
            <Skeleton class="h-3 w-2/5" /><Skeleton class="h-2 w-[65%]" />
          </div>
        </div>
        <span class="visually-hidden">正在读取各项目的审批记录…</span>
      </div>
      <Empty v-else-if="error && !reviews.length" class="min-h-[250px] border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><RefreshCw :size="20" /></EmptyMedia>
          <EmptyTitle>暂时无法获取审批记录</EmptyTitle>
          <EmptyDescription>请检查连接后重试。</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button :loading="refreshing" @click="reload">重新加载</Button>
        </EmptyContent>
      </Empty>
      <Empty v-else-if="!visibleReviews.length" class="min-h-[250px] border">
        <EmptyHeader>
          <EmptyMedia variant="icon"
            ><Search v-if="query" :size="20" /><Check v-else :size="20"
          /></EmptyMedia>
          <EmptyTitle>
            {{
              query
                ? "没有匹配的审批记录"
                : missingReviews.length
                  ? "已加载的项目暂无待审批记录"
                  : "当前没有待审批记录"
            }}
          </EmptyTitle>
          <EmptyDescription>
            {{
              query
                ? "试试其他关键词。"
                : missingReviews.length
                  ? "请重试加载其他项目，确认完整的待办。"
                  : "可以返回项目，继续下一步工程工作。"
            }}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button v-if="query" @click="query = ''">清除搜索</Button>
          <UiButton
            v-else
            as-child
            variant="outline"
            class="h-[30px] border-line-strong bg-panel px-3 text-[13px] font-normal text-fg shadow-none hover:bg-hover hover:text-fg"
          >
            <router-link to="/projects">返回项目工作台 →</router-link>
          </UiButton>
        </EmptyContent>
      </Empty>
      <div v-else class="grid gap-3">
        <ApprovalCard
          v-for="item in visibleReviews"
          :key="`${item.project.id}:${item.submission.id}`"
          :item="item"
        />
      </div>
    </section>
  </PageShell>
</template>
