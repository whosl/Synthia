<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api/service.ts";
import { useProjectOverview } from "../composables/use-project-overview.ts";
import { filterProjects, formatActivity } from "../domain/project-overview.ts";
import {
  processVersionText,
  projectType,
  projectTypeText,
} from "../domain/project.ts";
import { PROJECT_STATUS_TEXT } from "../domain/gates.ts";
import PageShell from "../components/layout/PageShell.vue";
import CreateProjectDialog from "../components/projects/CreateProjectDialog.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import StatusBadge from "../components/StatusBadge.vue";
import Button from "../components/ui/AppButton.vue";
import Icon from "../components/ui/Icon.vue";

const router = useRouter();
const {
  rows,
  loading,
  refreshing,
  error,
  reviews,
  activeTasks,
  incompleteRows,
  reload,
} = useProjectOverview(api);
const query = ref("");
const type = ref("all");
const showCreate = ref(false);
const visibleRows = computed(() =>
  filterProjects(rows.value, query.value, type.value),
);
const filters = [
  { id: "all", label: "全部项目" },
  { id: "engineering", label: "工程项目" },
  { id: "free", label: "自由项目" },
];
function projectCreated(id: string) {
  showCreate.value = false;
  void router.push({ name: "project", params: { id } });
}
</script>

<template>
  <PageShell section="projects">
    <div class="page-heading">
      <div>
        <p class="eyebrow">YOUR WORKSPACE</p>
        <h1>项目工作台<span class="heading-dot">.</span></h1>
        <p class="secondary-text">从自由探索到正式交付，在这里继续你的工程。</p>
      </div>
      <Button
        variant="primary"
        class="primary-action"
        @click="showCreate = true"
        ><Icon name="plus" />新建项目</Button
      >
    </div>

    <div class="overview-stats" aria-label="工作空间概况">
      <div class="stat-card">
        <span class="stat-icon"><Icon name="folder" :size="22" /></span>
        <div>
          <span class="stat-label">全部项目</span
          ><strong>{{ loading ? "—" : rows.length }}</strong>
        </div>
        <span class="stat-caption">工程与探索</span>
      </div>
      <router-link class="stat-card" to="/approvals"
        ><span class="stat-icon tone-amber"
          ><Icon name="inbox" :size="22"
        /></span>
        <div>
          <span class="stat-label">等待审批</span
          ><strong
            >{{ loading ? "—" : reviews.length
            }}<small
              v-if="
                !loading &&
                incompleteRows.some((row) =>
                  row.issues.some((issue) => issue.label === '待审批记录'),
                )
              "
              >+</small
            ></strong
          >
        </div>
        <Icon name="arrow"
      /></router-link>
      <div class="stat-card">
        <span class="stat-icon tone-green"
          ><Icon name="spark" :size="22"
        /></span>
        <div>
          <span class="stat-label">活跃主任务</span
          ><strong
            >{{ loading ? "—" : activeTasks.length
            }}<small
              v-if="
                !loading &&
                incompleteRows.some((row) =>
                  row.issues.some((issue) => issue.label === '任务状态'),
                )
              "
              >+</small
            ></strong
          >
        </div>
        <span class="stat-caption">进行中 / 等待确认</span>
      </div>
    </div>

    <ErrorNotice v-if="error" :error="error" />
    <div v-if="incompleteRows.length" class="partial-notice" role="status">
      <Icon name="inbox" /><span
        >{{
          incompleteRows.length
        }}
        个项目的部分状态未能加载，以下数量可能不完整。<span
          v-for="row in incompleteRows"
          :key="row.project.id"
          class="partial-detail"
          >{{ row.project.name }}：{{
            row.issues.map((issue) => issue.label).join("、")
          }}</span
        ></span
      ><Button :loading="refreshing" @click="reload">重试</Button>
    </div>

    <section class="projects-section" aria-labelledby="projects-title">
      <div class="section-heading">
        <div>
          <h2 id="projects-title">
            我的项目 <span class="count-label">{{ visibleRows.length }}</span>
          </h2>
          <p>按最近活动排序</p>
        </div>
        <Button variant="ghost" :loading="refreshing" @click="reload"
          ><Icon name="refresh" :size="16" />刷新</Button
        >
      </div>
      <div class="project-toolbar">
        <div class="filter-tabs" role="group" aria-label="筛选项目类型">
          <button
            v-for="filter in filters"
            :key="filter.id"
            type="button"
            :aria-pressed="type === filter.id"
            :class="{ active: type === filter.id }"
            @click="type = filter.id"
          >
            {{ filter.label }}
          </button>
        </div>
        <label class="search-field"
          ><Icon name="search" :size="17" /><input
            v-model="query"
            type="search"
            aria-label="搜索项目"
            placeholder="搜索项目名称或器件…"
        /></label>
      </div>
      <div
        v-if="loading"
        class="skeleton-list"
        role="status"
        aria-label="正在加载项目"
      >
        <div v-for="n in 3" :key="n" class="skeleton-row">
          <span />
          <div><i /><i /></div>
        </div>
        <span class="visually-hidden">正在加载项目…</span>
      </div>
      <div v-else-if="error && !rows.length" class="empty-state">
        <Icon name="refresh" :size="34" />
        <h3>项目暂时无法加载</h3>
        <p>连接恢复后可以重试。</p>
        <Button :loading="refreshing" @click="reload">重新加载</Button>
      </div>
      <div v-else-if="!rows.length" class="empty-state">
        <Icon name="folder" :size="40" />
        <h3>你的第一个项目，从这里开始</h3>
        <p>选择自由探索，或按照工程流程推进。</p>
        <Button variant="primary" @click="showCreate = true">新建项目</Button>
      </div>
      <div v-else-if="!visibleRows.length" class="empty-state">
        <Icon name="search" :size="34" />
        <h3>没有找到匹配的项目</h3>
        <p>试试其他名称、器件，或调整项目类型。</p>
        <Button
          @click="
            query = '';
            type = 'all';
          "
          >清除筛选</Button
        >
      </div>
      <div v-else class="project-list">
        <router-link
          v-for="row in visibleRows"
          :key="row.project.id"
          :to="{ name: 'project', params: { id: row.project.id } }"
          class="project-row"
          :aria-label="`进入项目：${row.project.name}`"
        >
          <span
            class="project-symbol"
            :class="{ free: projectType(row.project) === 'free' }"
            ><Icon
              :name="projectType(row.project) === 'free' ? 'spark' : 'chip'"
              :size="23"
          /></span>
          <div class="project-identity">
            <h3>{{ row.project.name }}</h3>
            <p>
              <span>{{ projectTypeText(projectType(row.project)) }}</span
              ><span v-if="row.project.target_part" class="mono">{{
                row.project.target_part
              }}</span
              ><span v-else>{{
                projectType(row.project) === "free"
                  ? "按自己的节奏探索"
                  : processVersionText(row.project)
              }}</span>
            </p>
          </div>
          <div class="project-stage">
            <span>{{ row.stage }}</span>
            <div
              v-if="row.progress"
              class="stage-progress"
              :aria-label="`已完成 ${row.progress.done} / ${row.progress.total} 个阶段`"
            >
              <i
                v-for="n in row.progress.total"
                :key="n"
                :class="{ done: n <= row.progress.done }"
              />
            </div>
            <span v-else class="project-stage-hint">{{
              row.issues.length ? "部分信息待恢复" : "随时进入工作区"
            }}</span>
          </div>
          <div class="project-activity">
            <StatusBadge
              :text="
                PROJECT_STATUS_TEXT[row.project.status] ?? row.project.status
              "
              :kind="row.project.status === 'active' ? 'ok' : 'plain'"
            /><time :datetime="row.updatedAt">{{
              formatActivity(row.updatedAt)
            }}</time>
          </div>
          <Icon name="arrow" :size="18" />
        </router-link>
      </div>
    </section>

    <section class="activity-strip" aria-labelledby="activity-title">
      <div class="activity-title">
        <span class="session-dot" />
        <h2 id="activity-title">正在推进</h2>
      </div>
      <p v-if="loading" class="secondary-text">正在读取任务状态…</p>
      <p v-else-if="!activeTasks.length" class="secondary-text">
        {{
          incompleteRows.length || error
            ? "已加载的项目中暂无活跃主任务。"
            : "目前没有运行中的主任务，可以进入项目开始新的工作。"
        }}
      </p>
      <div v-else class="activity-links">
        <router-link
          v-for="item in activeTasks"
          :key="`${item.project.id}:${item.task.agent_id}`"
          :to="{
            name: 'project',
            params: { id: item.project.id },
            query: { run: item.task.agent_id },
          }"
          ><span>{{ item.project.name }}</span
          ><StatusBadge
            :text="
              item.task.status === 'awaiting_approval' ? '等待确认' : '进行中'
            "
            :kind="
              item.task.status === 'awaiting_approval' ? 'warn' : 'accent'
            " /><Icon name="arrow" :size="14"
        /></router-link>
      </div>
    </section>
    <CreateProjectDialog
      v-if="showCreate"
      @close="showCreate = false"
      @created="projectCreated"
    />
  </PageShell>
</template>
