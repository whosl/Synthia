<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ArrowRight,
  Check,
  Inbox,
  RefreshCw,
  Search,
} from "lucide-vue-next";
import { api } from "../api/service.ts";
import { useProjectOverview } from "../composables/use-project-overview.ts";
import { formatActivity } from "../domain/project-overview.ts";
import PageShell from "../components/layout/PageShell.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import Badge from "../components/ui/AppBadge.vue";
import Button from "../components/ui/AppButton.vue";

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
      class="mb-6 flex items-start gap-3 rounded-[10px] border bg-[color-mix(in_srgb,var(--state-warn)_5%,var(--surface-panel))] p-4 leading-[1.7] text-warn [border-color:color-mix(in_srgb,var(--state-warn)_25%,var(--border-subtle))]"
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
          <span
            class="ml-2 inline-flex min-w-[22px] items-center justify-center rounded-[5px] bg-hover px-[5px] py-0.5 text-[11px] text-fg-secondary"
            >{{ visibleReviews.length }}</span
          >
        </h2>
        <label
          class="flex items-center gap-2 rounded-[8px] border border-line bg-panel px-3 text-fg-muted focus-within:border-brand focus-within:outline-2 focus-within:outline-brand-subtle max-[600px]:w-full"
          ><Search :size="16" class="shrink-0" /><input
            v-model="query"
            type="search"
            class="h-9 w-52 min-w-0 border-none bg-transparent text-xs outline-none max-[600px]:w-full"
            aria-label="搜索审批记录"
            placeholder="搜索项目、阶段或提交人…"
        /></label>
      </div>
      <div
        v-if="loading"
        class="flex min-h-[250px] flex-col items-center justify-center rounded-[12px] border border-dashed border-line-strong p-8 text-center"
        role="status"
      >
        正在读取各项目的审批记录…
      </div>
      <div
        v-else-if="error && !reviews.length"
        class="flex min-h-[250px] flex-col items-center justify-center rounded-[12px] border border-dashed border-line-strong p-8 text-center"
      >
        <RefreshCw :size="36" class="mb-2 text-brand" />
        <h3 class="mt-[1em] mb-0 font-medium">暂时无法获取审批记录</h3>
        <p class="my-[1em] leading-[1.7] text-fg-secondary">
          请检查连接后重试。
        </p>
        <Button :loading="refreshing" @click="reload">重新加载</Button>
      </div>
      <div
        v-else-if="!visibleReviews.length"
        class="flex min-h-[250px] flex-col items-center justify-center rounded-[12px] border border-dashed border-line-strong p-8 text-center"
      >
        <Search v-if="query" :size="38" class="mb-2 text-brand" /><Check
          v-else
          :size="38"
          class="mb-2 text-brand"
        />
        <h3 class="mt-[1em] mb-0 font-medium">
          {{
            query
              ? "没有匹配的审批记录"
              : missingReviews.length
                ? "已加载的项目暂无待审批记录"
                : "当前没有待审批记录"
          }}
        </h3>
        <p class="my-[1em] leading-[1.7] text-fg-secondary">
          {{
            query
              ? "试试其他关键词。"
              : missingReviews.length
                ? "请重试加载其他项目，确认完整的待办。"
                : "可以返回项目，继续下一步工程工作。"
          }}
        </p>
        <Button v-if="query" @click="query = ''">清除搜索</Button
        ><router-link v-else to="/projects">返回项目工作台 →</router-link>
      </div>
      <div v-else class="grid gap-3">
        <article
          v-for="item in visibleReviews"
          :key="`${item.project.id}:${item.submission.id}`"
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
      </div>
    </section>
  </PageShell>
</template>
