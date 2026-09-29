<script setup lang="ts">
import { computed, shallowRef, ref, onMounted, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
import {
  LayoutGrid,
  List,
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
import CreateProjectLoading from "../components/projects/CreateProjectLoading.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import Badge from "../components/ui/AppBadge.vue";
import Button from "../components/ui/AppButton.vue";
import { Skeleton } from "../components/ui/skeleton";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";

const router = useRouter();
const createLoadError = ref(false);
const CreateProjectDialog = shallowRef<typeof import("../components/projects/CreateProjectDialog.vue")["default"] | null>(null);
async function openCreate(): Promise<void> {
  createLoadError.value = false;
  showCreate.value = true;
  try {
    CreateProjectDialog.value ??= (await import("../components/projects/CreateProjectDialog.vue")).default;
  } catch {
    createLoadError.value = true;
    showCreate.value = false;
  }
}
const {
  rows,
  loading,
  refreshing,
  detailsLoading,
  error,
  reviews,
  activeTasks,
  incompleteRows,
  reload,
} = useProjectOverview(api, true);
const query = ref("");
const type = ref("all");
const showCreate = ref(false);
const visibleRows = computed(() =>
  filterProjects(rows.value, query.value, type.value === "review" ? "all" : type.value).filter((row) => type.value !== "review" || row.submissions.some((sub) => sub.state === "in_review")),
);
const filters = [
  { id: "all", label: "全部项目" },
  { id: "engineering", label: "工程项目" },
  { id: "free", label: "自由项目" },
  { id: "review", label: "待审批项目" },
];

const layout = ref<"grid" | "list">("grid");
function focusSearch(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || target?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
  if (showCreate.value) return;
  event.preventDefault();
  document.querySelector<HTMLInputElement>('[aria-label="搜索项目"]')?.focus();
}
onMounted(() => window.addEventListener("keydown", focusSearch));
onBeforeUnmount(() => window.removeEventListener("keydown", focusSearch));

function projectCreated(id: string) {
  showCreate.value = false;
  void router.push({ name: "project", params: { id } });
}
</script>

<template>
  <PageShell section="projects">
    <header class="ax-page-heading">
      <div><p class="ax-eyebrow">ENGINEERING WORKSPACE</p><h1>项目工作台</h1><p>继续设计，验证进展，完成下一次交付。</p></div>
      <Button variant="primary" class="h-9 gap-2" @click="openCreate"><Plus :size="16" />新建项目</Button>
    </header>

    <section class="ax-workspace-stats" aria-label="工作空间概况">
      <div class="ax-stat"><span class="ax-stat-icon"><Folder :size="19" /></span><div><span>全部项目</span><strong>{{ loading ? '—' : rows.length }}</strong></div><small>工程与自由探索</small></div>
      <button class="ax-stat ax-stat-action" type="button" :aria-pressed="type === 'review'" @click="type = type === 'review' ? 'all' : 'review'"><span class="ax-stat-icon warning"><Inbox :size="19" /></span><div><span>等待审批</span><strong>{{ detailsLoading ? '—' : reviews.length }}<small v-if="!detailsLoading && incompleteRows.some(row => row.issues.some(issue => issue.label === '待审批记录'))">+</small></strong></div><ArrowRight :size="16" /></button>
      <div class="ax-stat"><span class="ax-stat-icon success"><Sparkles :size="19" /></span><div><span>活跃主任务</span><strong>{{ detailsLoading ? '—' : activeTasks.length }}<small v-if="!detailsLoading && incompleteRows.some(row => row.issues.some(issue => issue.label === '任务状态'))">+</small></strong></div><small>进行中 / 等待确认</small></div>
    </section>

    <ErrorNotice v-if="error" :error="error" />
    <p v-if="createLoadError" role="alert" class="ax-load-notice">新建项目表单加载失败，请检查网络后重试。</p>
    <div v-if="incompleteRows.length" class="ax-load-notice" role="status"><Inbox :size="18" /><div>{{ incompleteRows.length }} 个项目的部分状态未能加载，数量可能不完整。<details><summary>查看详情</summary><p v-for="row in incompleteRows" :key="row.project.id">{{ row.project.name }}：{{ row.issues.map(issue => issue.label).join('、') }}</p></details></div><Button :loading="refreshing" @click="reload">重试</Button></div>

    <section class="projects-section" aria-labelledby="projects-title">
      <div class="ax-section-heading"><div><h2 id="projects-title">我的项目 <span class="ax-count">{{ visibleRows.length }}</span></h2><p>按最近活动排序</p></div><div class="ax-list-controls"><div class="ax-view-toggle" role="group" aria-label="项目显示方式"><button type="button" :aria-pressed="layout === 'grid'" aria-label="卡片视图" @click="layout = 'grid'"><LayoutGrid :size="16" /></button><button type="button" :aria-pressed="layout === 'list'" aria-label="列表视图" @click="layout = 'list'"><List :size="16" /></button></div><Button variant="ghost" :loading="refreshing" @click="reload"><RefreshCw :size="15" />刷新</Button></div></div>
      <div class="ax-project-toolbar">
        <div class="ax-project-filters" role="group" aria-label="筛选项目类型"><button v-for="filter in filters" :key="filter.id" type="button" :aria-pressed="type === filter.id" @click="type = filter.id">{{ filter.label }}</button></div>
        <label class="ax-project-search"><Search :size="16" /><input v-model="query" type="search" aria-label="搜索项目" placeholder="搜索名称或器件…" /><kbd>/</kbd></label>
      </div>
      <div v-if="loading" class="ax-project-grid" role="status" aria-label="正在加载项目"><div v-for="n in 6" :key="n" class="ax-project-skeleton"><Skeleton class="size-10 rounded-xl" /><Skeleton class="h-4 w-3/4" /><Skeleton class="h-3 w-1/2" /></div></div>
      <Empty v-else-if="error && !rows.length" class="min-h-[250px] border"><EmptyHeader><EmptyMedia variant="icon"><RefreshCw :size="20" /></EmptyMedia><EmptyTitle>项目暂时无法加载</EmptyTitle><EmptyDescription>连接恢复后可以重试。</EmptyDescription></EmptyHeader><EmptyContent><Button :loading="refreshing" @click="reload">重新加载</Button></EmptyContent></Empty>
      <Empty v-else-if="!rows.length" class="min-h-[250px] border"><EmptyHeader><EmptyMedia variant="icon"><Folder :size="20" /></EmptyMedia><EmptyTitle>你的第一个项目，从这里开始</EmptyTitle><EmptyDescription>选择自由探索，或按照工程流程推进。</EmptyDescription></EmptyHeader><EmptyContent><Button variant="primary" @click="openCreate">新建项目</Button></EmptyContent></Empty>
      <Empty v-else-if="!visibleRows.length" class="min-h-[250px] border"><EmptyHeader><EmptyMedia variant="icon"><Search :size="20" /></EmptyMedia><EmptyTitle>没有找到匹配的项目</EmptyTitle><EmptyDescription>试试其他名称、器件，或调整项目类型。</EmptyDescription></EmptyHeader><EmptyContent><Button @click="query = ''; type = 'all'">清除筛选</Button></EmptyContent></Empty>
      <div v-else class="ax-project-grid" :class="{ 'is-list': layout === 'list' }">
        <router-link v-for="row in visibleRows" :key="row.project.id" :to="{ name: 'project', params: { id: row.project.id }, query: type === 'review' ? { sub: row.submissions.find(sub => sub.state === 'in_review')?.id } : {} }" class="ax-project-card" :aria-label="`进入项目：${row.project.name}`">
          <div class="ax-card-top"><span class="ax-project-icon" :class="{ exploration: projectType(row.project) === 'free' }"><component :is="projectType(row.project) === 'free' ? Sparkles : Cpu" :size="18" :stroke-width="1.5" /></span><span class="ax-project-type" :class="{ exploration: projectType(row.project) === 'free' }">{{ projectTypeText(projectType(row.project)) }}</span><Badge size="sm" variant="dot" :tone="row.project.status === 'active' ? 'ok' : 'neutral'">{{ PROJECT_STATUS_TEXT[row.project.status] ?? row.project.status }}</Badge></div>
          <div class="ax-card-title"><h3><span>{{ row.project.name }}</span></h3><p><Cpu :size="12" />{{ row.project.target_part || (projectType(row.project) === 'free' ? '尚未指定器件' : processVersionText(row.project)) }}</p></div>
          <div class="ax-card-stage"><span>{{ row.stage }}</span><div v-if="row.progress" class="ax-progress" :aria-label="`已完成 ${row.progress.done} / ${row.progress.total} 个阶段`"><i v-for="n in row.progress.total" :key="n" :class="{ done: n <= row.progress.done }" /></div><span v-else class="ax-card-stage-note">{{ row.issues.length ? '部分信息待恢复' : '自由探索与验证' }}</span></div>
          <footer><time :datetime="row.updatedAt">{{ formatActivity(row.updatedAt) }}</time><span>进入工作区 <ArrowRight :size="14" /></span></footer>
        </router-link>
      </div>
    </section>
    <section class="ax-active-tasks" aria-labelledby="activity-title"><div class="ax-section-heading"><h2 id="activity-title">正在推进</h2><span class="ax-count">{{ detailsLoading ? '—' : activeTasks.length }}</span></div>
      <p v-if="detailsLoading">正在读取任务状态…</p><p v-else-if="!activeTasks.length">{{ incompleteRows.length || error ? '已加载的项目中暂无活跃主任务。' : '目前没有运行中的主任务，可以进入项目开始新的工作。' }}</p>
      <div v-else class="ax-active-grid"><router-link v-for="item in activeTasks" :key="`${item.project.id}:${item.task.agent_id}`" :to="{ name: 'project', params: { id: item.project.id }, query: { run: item.task.agent_id } }"><Sparkles :size="16" /><span>{{ item.project.name }}</span><Badge size="sm" variant="dot" :tone="item.task.status === 'awaiting_approval' ? 'warn' : 'accent'">{{ item.task.status === 'awaiting_approval' ? '等待确认' : '进行中' }}</Badge><ArrowRight :size="14" /></router-link></div>
    </section>
    <component :is="CreateProjectDialog" v-if="showCreate && CreateProjectDialog" @close="showCreate = false" @created="projectCreated" />
    <CreateProjectLoading v-else-if="showCreate" @close="showCreate = false" />
  </PageShell>
</template>
<style scoped>
.ax-workspace-stats { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); margin-bottom:36px; padding:24px 0; border-block:1px solid var(--border-subtle); }
.ax-stat { display:flex; align-items:center; gap:16px; padding:4px 24px; border:0; border-right:1px solid var(--border-subtle); background:transparent; text-align:left; color:var(--text-primary); }.ax-stat:first-child { padding-left:0; }.ax-stat:last-child { border:0; }.ax-stat > div { display:flex; flex-direction:column; gap:8px; }.ax-stat > div > span { font-size:12px; color:var(--text-secondary); }.ax-stat strong { font-size:30px; line-height:32px; font-weight:500; font-variant-numeric:tabular-nums; }.ax-stat strong small { font-size:16px; }.ax-stat > small { margin-left:auto; align-self:flex-end; color:var(--text-muted); font-size:11px; }.ax-stat > svg { margin-left:auto; color:var(--text-muted); }.ax-stat-action { cursor:pointer; border-radius:8px; }.ax-stat-action:hover { background:var(--surface-hover); }.ax-stat-icon { width:44px; height:44px; border-radius:12px; background:var(--surface-panel); color:var(--text-secondary); display:grid; place-items:center; flex:none; }.ax-stat-icon.warning { color:var(--state-warn); }.ax-stat-icon.success { color:var(--state-ok); }
.ax-count { display:inline-grid; place-items:center; min-width:24px; padding:2px 6px; background:var(--surface-hover); color:var(--text-secondary); border-radius:6px; font-size:11px; font-weight:500; margin-left:8px; }.ax-list-controls { display:flex; align-items:center; gap:12px; }.ax-view-toggle { display:flex; padding:3px; border-radius:8px; background:var(--surface-hover); }.ax-view-toggle button { display:grid; place-items:center; width:28px; height:28px; border:0; border-radius:5px; background:transparent; color:var(--text-muted); cursor:pointer; }.ax-view-toggle button[aria-pressed=true] { background:var(--surface-panel); color:var(--text-primary); box-shadow:var(--shadow-low); }
.ax-project-toolbar { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:20px; }.ax-project-filters { display:flex; gap:4px; flex-wrap:wrap; }.ax-project-filters button { padding:8px 12px; border:0; border-radius:8px; background:transparent; color:var(--text-secondary); font-size:12px; cursor:pointer; }.ax-project-filters button[aria-pressed=true] { background:var(--text-primary); color:var(--surface-panel); }.ax-project-filters button:hover:not([aria-pressed=true]) { background:var(--surface-hover); }.ax-project-search { display:flex; gap:8px; align-items:center; padding:0 12px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--surface-panel); color:var(--text-muted); }.ax-project-search:focus-within { border-color:var(--accent); }.ax-project-search input { width:176px; height:36px; min-width:0; border:0; background:transparent; outline:0; font-size:12px; }.ax-project-search kbd { border:1px solid var(--border-subtle); padding:0 4px; border-radius:4px; font-size:10px; }
.ax-project-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }.ax-project-card { min-width:0; padding:16px; border:1px solid var(--border-subtle); border-radius:var(--radius-container); background:var(--surface-panel); color:var(--text-primary); text-decoration:none; transition:border-color var(--duration),box-shadow var(--duration),transform var(--duration); }.ax-project-card:hover { border-color:var(--border-strong); box-shadow:var(--shadow-medium); transform:translateY(-2px); color:var(--text-primary); }.ax-card-top { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; }.ax-project-icon { display:grid; place-items:center; width:32px; height:32px; border-radius:8px; flex:none; background:var(--accent-subtle); color:var(--accent); }.ax-project-icon.exploration { background:color-mix(in srgb,var(--state-info) 8%,transparent); color:var(--state-info); }.ax-project-type { display:inline-flex; vertical-align:middle; margin-right:auto; padding:2px 6px; border-radius:4px; background:var(--accent-subtle); color:var(--accent); font-size:10px; line-height:16px; font-weight:400; letter-spacing:0; white-space:nowrap; }.ax-project-type.exploration { background:color-mix(in srgb,var(--state-info) 8%,transparent); color:var(--state-info); }.ax-card-title h3 { margin:0 0 6px; font-size:14px; line-height:22px; font-weight:600; overflow-wrap:anywhere; }.ax-card-title p { display:flex; gap:6px; align-items:center; margin:0; font:11px/20px var(--font-mono); color:var(--text-muted); overflow-wrap:anywhere; }.ax-card-stage { margin-top:12px; font-size:12px; color:var(--text-secondary); min-height:40px; }.ax-card-stage-note { display:block; font-size:11px; color:var(--text-muted); margin-top:4px; }.ax-progress { display:flex; gap:4px; margin-top:8px; }.ax-progress i { height:4px; border-radius:2px; flex:1; background:var(--surface-hover); }.ax-progress i.done { background:var(--state-ok); }.ax-project-card footer { display:flex; justify-content:space-between; align-items:center; gap:8px; border-top:1px solid var(--border-subtle); margin-top:12px; padding-top:10px; font-size:11px; color:var(--text-muted); }.ax-project-card footer > span { display:flex; gap:6px; align-items:center; color:var(--text-secondary); }.ax-project-skeleton { display:grid; gap:16px; padding:16px; min-height:220px; border-radius:12px; background:var(--surface-panel); }
.ax-project-grid.is-list { grid-template-columns:1fr; gap:8px; }.is-list .ax-project-card { display:grid; grid-template-columns:100px minmax(0,1fr) 160px 160px; gap:16px; align-items:center; padding:12px 16px; }.is-list .ax-card-top { margin:0; flex-direction:column; align-items:flex-start; gap:4px; }.is-list .ax-card-title h3 { min-height:0; margin:4px 0; }.is-list .ax-card-stage { margin:0; }.is-list .ax-project-card footer { border:0; margin:0; padding:0; flex-direction:column; align-items:flex-end; gap:12px; }
.ax-active-tasks { margin-top:36px; padding-top:24px; border-top:1px solid var(--border-subtle); }.ax-active-tasks > p { font-size:12px; color:var(--text-muted); }.ax-active-grid { display:grid; gap:8px; grid-template-columns:repeat(2,minmax(0,1fr)); }.ax-active-grid a { display:flex; align-items:center; gap:12px; padding:16px; border-radius:8px; background:var(--surface-panel); font-size:12px; color:var(--text-secondary); }.ax-active-grid a > span:first-of-type { flex:1; }.ax-load-notice { display:flex; align-items:flex-start; gap:12px; padding:16px; background:color-mix(in srgb,var(--state-warn) 8%,var(--surface-panel)); border-radius:12px; margin-bottom:24px; color:var(--state-warn); font-size:12px; }.ax-load-notice > div { flex:1; }.ax-load-notice details { margin-top:8px; }
@media(max-width:1250px) { .ax-project-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }.ax-stat > small { display:none; }.is-list .ax-project-card { grid-template-columns:76px minmax(0,1fr) 140px; gap:16px; }.is-list .ax-project-card footer { display:none; }.ax-project-toolbar { flex-wrap:wrap; } }
@media(max-width:600px) { .ax-workspace-stats { padding:16px 0; margin-bottom:28px; }.ax-stat { padding:4px 12px; gap:8px; }.ax-stat-icon { display:none; }.ax-stat > div > span { font-size:11px; }.ax-stat strong { font-size:26px; }.ax-stat > svg { display:none; }.ax-project-toolbar { gap:16px; }.ax-project-search { width:100%; }.ax-project-search input { flex:1; }.ax-project-filters button { padding:8px; font-size:11px; }.ax-project-grid { grid-template-columns:1fr; }.ax-project-card { padding:16px; }.ax-card-top { margin-bottom:12px; }.ax-card-title h3 { min-height:0; }.ax-active-grid { grid-template-columns:1fr; }.is-list .ax-project-card { grid-template-columns:64px minmax(0,1fr); padding:16px; }.is-list .ax-card-top :deep([data-slot=badge]),.is-list .ax-card-stage { display:none; } }
</style>
