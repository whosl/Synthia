<script setup lang="ts">
import { computed, ref } from "vue";
import { api } from "../api/service.ts";
import { useProjectOverview } from "../composables/use-project-overview.ts";
import { formatActivity } from "../domain/project-overview.ts";
import PageShell from "../components/layout/PageShell.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import StatusBadge from "../components/StatusBadge.vue";
import Button from "../components/ui/AppButton.vue";
import Icon from "../components/ui/Icon.vue";

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
    <div class="page-heading">
      <div>
        <p class="eyebrow">REVIEW & CONTINUE</p>
        <h1>每次确认，都有依据<span class="heading-dot">.</span></h1>
        <p class="secondary-text">
          集中查看待审批提交，进入项目核对快照、证据并作出决定。
        </p>
      </div>
      <Button :loading="refreshing" @click="reload"
        ><Icon name="refresh" :size="16" />刷新</Button
      >
    </div>
    <div class="review-summary">
      <span class="stat-icon tone-amber"><Icon name="inbox" :size="24" /></span>
      <div>
        <strong>{{ loading ? "—" : reviews.length }} 项等待审批</strong>
        <p>
          {{
            missingReviews.length || error
              ? "部分项目尚未加载，待审批数量可能不完整。"
              : "批准或驳回后，项目将按流程继续推进。"
          }}
        </p>
      </div>
    </div>
    <ErrorNotice v-if="error" :error="error" />
    <div v-if="missingReviews.length" class="partial-notice" role="status">
      <Icon name="inbox" /><span
        >以下项目的审批记录未加载，其他项目仍可处理。<span
          v-for="row in missingReviews"
          :key="row.project.id"
          class="partial-detail"
          >{{ row.project.name }}</span
        ></span
      ><Button :loading="refreshing" @click="reload">重试</Button>
    </div>
    <section aria-labelledby="reviews-title">
      <div class="section-heading">
        <h2 id="reviews-title">
          待审批记录
          <span class="count-label">{{ visibleReviews.length }}</span>
        </h2>
        <label class="search-field"
          ><Icon name="search" :size="16" /><input
            v-model="query"
            type="search"
            aria-label="搜索审批记录"
            placeholder="搜索项目、阶段或提交人…"
        /></label>
      </div>
      <div v-if="loading" class="empty-state" role="status">
        正在读取各项目的审批记录…
      </div>
      <div v-else-if="error && !reviews.length" class="empty-state">
        <Icon name="refresh" :size="36" />
        <h3>暂时无法获取审批记录</h3>
        <p>请检查连接后重试。</p>
        <Button :loading="refreshing" @click="reload">重新加载</Button>
      </div>
      <div v-else-if="!visibleReviews.length" class="empty-state">
        <Icon :name="query ? 'search' : 'check'" :size="38" />
        <h3>
          {{
            query
              ? "没有匹配的审批记录"
              : missingReviews.length
                ? "已加载的项目暂无待审批记录"
                : "当前没有待审批记录"
          }}
        </h3>
        <p>
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
      <div v-else class="review-list">
        <article
          v-for="item in visibleReviews"
          :key="`${item.project.id}:${item.submission.id}`"
          class="review-card"
        >
          <span class="stat-icon tone-amber"><Icon name="inbox" /></span>
          <div class="review-body">
            <div class="review-title">
              <h3>{{ item.title }}</h3>
              <StatusBadge text="等待确认" kind="warn" />
            </div>
            <p>{{ item.project.name }}</p>
            <span class="secondary-text"
              >{{ item.submission.submitter_id }} 提交 ·
              {{
                formatActivity(
                  item.submission.submitted_at ?? item.submission.created_at,
                )
              }}</span
            >
          </div>
          <router-link
            class="review-action"
            :to="{
              name: 'project',
              params: { id: item.project.id },
              query: { sub: item.submission.id },
            }"
            >查看并处理<Icon name="arrow" :size="16"
          /></router-link>
        </article>
      </div>
    </section>
  </PageShell>
</template>

<style scoped>
.review-summary {
  display: flex;
  align-items: center;
  gap: 18px;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: var(--surface-panel);
  padding: 24px;
  margin-bottom: 32px;
}
.review-summary strong {
  font-size: 20px;
  font-weight: 550;
}
.review-summary p {
  color: var(--text-secondary);
  margin: 8px 0 0;
  font-size: 12px;
}
.review-list {
  display: grid;
  gap: 12px;
}
.review-card {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 24px;
  border: 1px solid var(--border-subtle);
  background: var(--surface-panel);
  border-radius: 12px;
}
.review-body {
  flex: 1;
  min-width: 0;
}
.review-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.review-title h3 {
  font-weight: 550;
  margin: 0;
  font-size: 15px;
}
.review-body p {
  margin: 8px 0;
}
.review-body > span {
  font-size: 11px;
  overflow-wrap: anywhere;
}
.review-action {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  white-space: nowrap;
}
@media (max-width: 600px) {
  .section-heading {
    flex-wrap: wrap;
  }
  .section-heading .search-field {
    width: 100%;
  }
  .review-card {
    padding: 18px;
    gap: 12px;
    flex-wrap: wrap;
  }
  .review-card > .stat-icon {
    display: none;
  }
  .review-action {
    width: 100%;
    border-top: 1px solid var(--border-subtle);
    padding-top: 14px;
  }
}
</style>
