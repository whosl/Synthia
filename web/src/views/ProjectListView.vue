<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import {
  ArrowRight,
  Cpu,
  Folder,
  Inbox,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-vue-next";
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
import Badge from "../components/ui/AppBadge.vue";
import Button from "../components/ui/AppButton.vue";

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

// 门户卡片/列表的共享片段（原 portal.css 的 .stat-card / .empty-state 等）
const statCardClass =
  "flex items-center gap-4 rounded-[12px] border border-line bg-panel p-[22px] text-fg max-[1200px]:gap-3 max-[1200px]:p-[18px] max-[600px]:gap-2 max-[600px]:px-3 max-[600px]:py-3.5";
const statIconClass =
  "grid size-11 shrink-0 place-items-center rounded-[12px] max-[600px]:hidden";
const emptyStateClass =
  "flex min-h-[250px] flex-col items-center justify-center rounded-[12px] border border-dashed border-line-strong p-8 text-center";

function projectCreated(id: string) {
  showCreate.value = false;
  void router.push({ name: "project", params: { id } });
}
</script>

<template>
  <PageShell section="projects">
    <div
      class="mb-8 flex items-center justify-between gap-6 max-[600px]:mb-6 max-[600px]:items-start max-[600px]:gap-3"
    >
      <div>
        <p class="m-0 mb-2.5 text-[10px] font-semibold tracking-[2px] text-brand">
          YOUR WORKSPACE
        </p>
        <h1
          class="m-0 mb-3 text-[clamp(26px,2.8vw,36px)] leading-[1.3] font-semibold tracking-[-1px] max-[600px]:text-[28px]"
        >
          项目工作台<span class="text-brand">.</span>
        </h1>
        <p
          class="m-0 leading-[1.7] text-fg-secondary max-[600px]:max-w-[230px] max-[600px]:text-xs"
        >
          从自由探索到正式交付，在这里继续你的工程。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <Button
          variant="primary"
          class="h-10 gap-2 px-[17px] shadow-[0_4px_10px_color-mix(in_srgb,var(--accent)_15%,transparent)] max-[600px]:h-9 max-[600px]:px-3 max-[600px]:text-xs"
          @click="showCreate = true"
          ><Plus :size="18" />新建项目</Button
        >
      </div>
    </div>

    <div
      class="mb-9 grid grid-cols-3 gap-4 max-[600px]:mb-7 max-[600px]:gap-2"
      aria-label="工作空间概况"
    >
      <div :class="statCardClass">
        <span :class="[statIconClass, 'bg-brand-subtle text-brand']"
          ><Folder :size="22"
        /></span>
        <div>
          <span class="block text-xs text-fg-secondary max-[600px]:text-[10px]"
            >全部项目</span
          ><strong
            class="mt-[5px] block text-[30px] leading-[1.2] font-[550] tabular-nums max-[600px]:text-[26px]"
            >{{ loading ? "—" : rows.length }}</strong
          >
        </div>
        <span
          class="mt-auto ml-auto text-[10px] whitespace-nowrap text-fg-muted max-[1200px]:hidden"
          >工程与探索</span
        >
      </div>
      <router-link :class="[statCardClass, 'hover:border-brand hover:text-fg']" to="/approvals"
        ><span :class="[statIconClass, 'bg-warn/10 text-warn']"
          ><Inbox :size="22"
        /></span>
        <div>
          <span class="block text-xs text-fg-secondary max-[600px]:text-[10px]"
            >等待审批</span
          ><strong
            class="mt-[5px] block text-[30px] leading-[1.2] font-[550] tabular-nums max-[600px]:text-[26px]"
            >{{ loading ? "—" : reviews.length
            }}<small
              v-if="
                !loading &&
                incompleteRows.some((row) =>
                  row.issues.some((issue) => issue.label === '待审批记录'),
                )
              "
              class="pl-0.5 text-[17px]"
              >+</small
            ></strong
          >
        </div>
        <ArrowRight
          :size="18"
          class="ml-auto text-fg-muted max-[600px]:size-3.5"
      /></router-link>
      <div :class="statCardClass">
        <span :class="[statIconClass, 'bg-ok/10 text-ok']"
          ><Sparkles :size="22"
        /></span>
        <div>
          <span class="block text-xs text-fg-secondary max-[600px]:text-[10px]"
            >活跃主任务</span
          ><strong
            class="mt-[5px] block text-[30px] leading-[1.2] font-[550] tabular-nums max-[600px]:text-[26px]"
            >{{ loading ? "—" : activeTasks.length
            }}<small
              v-if="
                !loading &&
                incompleteRows.some((row) =>
                  row.issues.some((issue) => issue.label === '任务状态'),
                )
              "
              class="pl-0.5 text-[17px]"
              >+</small
            ></strong
          >
        </div>
        <span
          class="mt-auto ml-auto text-[10px] whitespace-nowrap text-fg-muted max-[1200px]:hidden"
          >进行中 / 等待确认</span
        >
      </div>
    </div>

    <ErrorNotice v-if="error" :error="error" />
    <div
      v-if="incompleteRows.length"
      class="mb-6 flex items-start gap-3 rounded-[10px] border bg-[color-mix(in_srgb,var(--state-warn)_5%,var(--surface-panel))] p-4 leading-[1.7] text-warn [border-color:color-mix(in_srgb,var(--state-warn)_25%,var(--border-subtle))]"
      role="status"
    >
      <Inbox :size="18" class="mt-[3px] shrink-0" /><span class="flex-1"
        >{{
          incompleteRows.length
        }}
        个项目的部分状态未能加载，以下数量可能不完整。<span
          v-for="row in incompleteRows"
          :key="row.project.id"
          class="block text-[11px] text-fg-secondary"
          >{{ row.project.name }}：{{
            row.issues.map((issue) => issue.label).join("、")
          }}</span
        ></span
      ><Button :loading="refreshing" @click="reload">重试</Button>
    </div>

    <section class="projects-section" aria-labelledby="projects-title">
      <div class="mb-[18px] flex items-center justify-between gap-3">
        <div>
          <h2 id="projects-title" class="m-0 text-[17px] font-semibold">
            我的项目
            <span
              class="ml-2 inline-flex min-w-[22px] items-center justify-center rounded-[5px] bg-hover px-[5px] py-0.5 text-[11px] text-fg-secondary tabular-nums"
              >{{ visibleRows.length }}</span
            >
          </h2>
          <p class="m-0 mt-[5px] text-[11px] text-fg-muted">按最近活动排序</p>
        </div>
        <Button variant="ghost" :loading="refreshing" @click="reload"
          ><RefreshCw :size="16" />刷新</Button
        >
      </div>
      <div
        class="flex items-center justify-between gap-4 pb-4 max-[600px]:flex-col max-[600px]:items-stretch max-[600px]:gap-3"
      >
        <div
          class="flex gap-1 rounded-[8px] border border-line bg-hover/65 p-1 max-[600px]:w-fit"
          role="group"
          aria-label="筛选项目类型"
        >
          <button
            v-for="filter in filters"
            :key="filter.id"
            type="button"
            :aria-pressed="type === filter.id"
            class="cursor-pointer rounded-[5px] border-0 px-3 py-1.5 text-xs whitespace-nowrap"
            :class="
              type === filter.id
                ? 'bg-panel text-fg shadow-[0_1px_4px_var(--shadow-color)]'
                : 'bg-transparent text-fg-secondary'
            "
            @click="type = filter.id"
          >
            {{ filter.label }}
          </button>
        </div>
        <label
          class="flex items-center gap-2 rounded-[8px] border border-line bg-panel px-3 text-fg-muted focus-within:border-brand focus-within:outline-2 focus-within:outline-brand-subtle"
          ><Search :size="17" class="shrink-0" /><input
            v-model="query"
            type="search"
            class="h-9 w-52 min-w-0 border-none bg-transparent text-xs outline-none max-[600px]:w-full"
            aria-label="搜索项目"
            placeholder="搜索项目名称或器件…"
        /></label>
      </div>
      <div
        v-if="loading"
        class="rounded-[12px] border border-line bg-panel"
        role="status"
        aria-label="正在加载项目"
      >
        <div
          v-for="n in 3"
          :key="n"
          class="flex gap-5 border-b border-line p-7"
        >
          <span class="size-11 rounded-[12px] bg-hover" />
          <div class="grid flex-1 gap-2.5">
            <i class="h-3 w-2/5 rounded bg-hover" /><i
              class="h-2 w-[65%] rounded bg-hover"
            />
          </div>
        </div>
        <span class="visually-hidden">正在加载项目…</span>
      </div>
      <div v-else-if="error && !rows.length" :class="emptyStateClass">
        <RefreshCw :size="34" class="mb-2 text-brand" />
        <h3 class="mt-[1em] mb-0 font-medium">项目暂时无法加载</h3>
        <p class="my-[1em] leading-[1.7] text-fg-secondary">
          连接恢复后可以重试。
        </p>
        <Button :loading="refreshing" @click="reload">重新加载</Button>
      </div>
      <div v-else-if="!rows.length" :class="emptyStateClass">
        <Folder :size="40" class="mb-2 text-brand" />
        <h3 class="mt-[1em] mb-0 font-medium">你的第一个项目，从这里开始</h3>
        <p class="my-[1em] leading-[1.7] text-fg-secondary">
          选择自由探索，或按照工程流程推进。
        </p>
        <Button variant="primary" @click="showCreate = true">新建项目</Button>
      </div>
      <div v-else-if="!visibleRows.length" :class="emptyStateClass">
        <Search :size="34" class="mb-2 text-brand" />
        <h3 class="mt-[1em] mb-0 font-medium">没有找到匹配的项目</h3>
        <p class="my-[1em] leading-[1.7] text-fg-secondary">
          试试其他名称、器件，或调整项目类型。
        </p>
        <Button
          @click="
            query = '';
            type = 'all';
          "
          >清除筛选</Button
        >
      </div>
      <div
        v-else
        class="overflow-hidden rounded-[12px] border border-line bg-panel"
      >
        <router-link
          v-for="row in visibleRows"
          :key="row.project.id"
          :to="{ name: 'project', params: { id: row.project.id } }"
          class="grid grid-cols-[46px_minmax(180px,1.5fr)_minmax(150px,1fr)_128px_18px] items-center gap-[18px] border-b border-line px-6 py-[26px] text-fg transition-colors last:border-b-0 hover:bg-[color-mix(in_srgb,var(--accent-subtle)_40%,var(--surface-panel))] hover:text-fg max-[1200px]:grid-cols-[44px_minmax(0,1fr)_155px_18px] max-[1200px]:gap-3.5 max-[1200px]:px-[18px] max-[1200px]:py-[22px] max-[600px]:grid-cols-[38px_minmax(0,1fr)_16px] max-[600px]:gap-3 max-[600px]:px-4 max-[600px]:py-5"
          :aria-label="`进入项目：${row.project.name}`"
        >
          <span
            class="grid size-11 place-items-center rounded-[12px] border border-line bg-base max-[600px]:h-10 max-[600px]:w-9"
            :class="
              projectType(row.project) === 'free' ? 'text-info' : 'text-brand'
            "
            ><component
              :is="projectType(row.project) === 'free' ? Sparkles : Cpu"
              :size="23"
          /></span>
          <div class="min-w-0">
            <h3
              class="m-0 mb-2 truncate text-sm font-[550] max-[600px]:text-[13px] max-[600px]:leading-[1.6] max-[600px]:whitespace-normal"
            >
              {{ row.project.name }}
            </h3>
            <p
              class="m-0 flex flex-wrap gap-x-2.5 gap-y-1.5 text-[11px] text-fg-muted"
            >
              <span>{{ projectTypeText(projectType(row.project)) }}</span
              ><span
                v-if="row.project.target_part"
                class="border-l border-line-strong pl-2.5 font-mono text-[10px]"
                >{{ row.project.target_part }}</span
              ><span v-else class="border-l border-line-strong pl-2.5">{{
                projectType(row.project) === "free"
                  ? "按自己的节奏探索"
                  : processVersionText(row.project)
              }}</span>
            </p>
          </div>
          <div
            class="min-w-0 text-xs text-fg-secondary max-[600px]:col-start-2 max-[600px]:text-[11px]"
          >
            <span>{{ row.stage }}</span>
            <div
              v-if="row.progress"
              class="mt-3 flex w-[110px] gap-1 max-[600px]:mt-2"
              :aria-label="`已完成 ${row.progress.done} / ${row.progress.total} 个阶段`"
            >
              <i
                v-for="n in row.progress.total"
                :key="n"
                class="h-1 flex-1 rounded"
                :class="n <= row.progress.done ? 'bg-brand' : 'bg-line'"
              />
            </div>
            <span v-else class="mt-2 block text-[10px] text-fg-muted max-[600px]:hidden">{{
              row.issues.length ? "部分信息待恢复" : "随时进入工作区"
            }}</span>
          </div>
          <div class="grid justify-items-start gap-[9px] max-[1200px]:hidden">
            <Badge
              size="sm"
              variant="dot"
              :tone="row.project.status === 'active' ? 'ok' : 'neutral'"
              >{{
                PROJECT_STATUS_TEXT[row.project.status] ?? row.project.status
              }}</Badge
            ><time :datetime="row.updatedAt" class="text-[10px] text-fg-muted tabular-nums">{{
              formatActivity(row.updatedAt)
            }}</time>
          </div>
          <ArrowRight
            :size="18"
            class="text-fg-muted max-[600px]:col-start-3 max-[600px]:row-span-2 max-[600px]:row-start-1"
          />
        </router-link>
      </div>
    </section>

    <section
      class="mt-[30px] grid gap-3.5 border-t border-line py-5"
      aria-labelledby="activity-title"
    >
      <div class="flex items-center gap-2.5">
        <span
          class="size-1.5 shrink-0 rounded-full bg-ok shadow-[0_0_0_3px_color-mix(in_srgb,var(--state-ok)_10%,transparent)]"
        />
        <h2 id="activity-title" class="m-0 text-xs font-[550]">正在推进</h2>
      </div>
      <p v-if="loading" class="m-0 text-xs leading-[1.7] text-fg-secondary">
        正在读取任务状态…
      </p>
      <p
        v-else-if="!activeTasks.length"
        class="m-0 text-xs leading-[1.7] text-fg-secondary"
      >
        {{
          incompleteRows.length || error
            ? "已加载的项目中暂无活跃主任务。"
            : "目前没有运行中的主任务，可以进入项目开始新的工作。"
        }}
      </p>
      <div v-else class="flex flex-wrap gap-2.5 max-[600px]:grid">
        <router-link
          v-for="item in activeTasks"
          :key="`${item.project.id}:${item.task.agent_id}`"
          class="flex items-center gap-2.5 rounded-[8px] border border-line bg-panel px-3 py-2.5 text-[11px] text-fg-secondary hover:border-brand"
          :to="{
            name: 'project',
            params: { id: item.project.id },
            query: { run: item.task.agent_id },
          }"
          ><span class="max-[600px]:flex-1">{{ item.project.name }}</span
          ><Badge
            size="sm"
            variant="dot"
            :tone="item.task.status === 'awaiting_approval' ? 'warn' : 'accent'"
            >{{
              item.task.status === "awaiting_approval" ? "等待确认" : "进行中"
            }}</Badge
          ><ArrowRight :size="14"
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
