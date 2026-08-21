<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../main.ts";
import { createProject, listGateSubmissions, listProcessVersions, listProjects, listTasks } from "../api/index.ts";
import type { CreateProjectRequest } from "../api/index.ts";
import type { GateSubmission, ProcessVersion, Project, TaskAgentSummary } from "../api/types.ts";
import {
  GATE_REVIEW_NAMES,
  PROJECT_STATUS_TEXT,
  currentGate,
  deriveGateLanes,
  type GateId,
} from "../domain/gates.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import StatusBadge from "../components/StatusBadge.vue";
import {
  isLegacyCompatProject,
  processVersionText,
  projectType,
  projectTypeText,
  validateCreateProject,
  type ProjectType,
} from "../domain/project.ts";

const router = useRouter();

const projects = ref<Project[]>([]);
const loading = ref(true);
const error = ref<unknown>(null);

/** 每个项目的门禁泳道（推导当前阶段用）。 */
const lanesByProject = ref<Map<string, ReturnType<typeof deriveGateLanes>>>(new Map());
/** 每个项目的最近活动时间（提交/任务/创建时间取最大）。 */
const lastActivityByProject = ref<Map<string, string>>(new Map());

// ── 我的待办 ──────────────────────────────────────────────────────────
interface PendingApproval {
  readonly project: Project;
  readonly submission: GateSubmission;
}
interface ActiveTask {
  readonly project: Project;
  readonly run: TaskAgentSummary;
}

const pendingApprovals = ref<PendingApproval[]>([]);
const activeTasks = ref<ActiveTask[]>([]);

const todoCount = computed(() => pendingApprovals.value.length + activeTasks.value.length);

function reviewName(gate: string): string {
  return GATE_REVIEW_NAMES[gate as GateId] ?? gate;
}

/** 项目当前阶段的人话描述（如「设计审查等待批准」）。 */
function stageText(project: Project): string {
  if (projectType(project) === "free") return "自由探索（无固定阶段）";
  if (isLegacyCompatProject(project)) return "兼容旧流程（无新版阶段）";
  const lanes = lanesByProject.value.get(project.id);
  if (!lanes) return "—";
  const gate = currentGate(lanes);
  if (!gate) return "全部审查已通过";
  const name = GATE_REVIEW_NAMES[gate];
  switch (lanes[gate]) {
    case "in_review": return `${name}等待批准`;
    case "rejected": return `${name}被驳回`;
    default: return `${name}未开始`;
  }
}

function projectTypeLabel(project: Project): string {
  return projectTypeText(projectType(project));
}

function profileLabel(project: Project): string {
  if (projectType(project) === "free") return "—（自由项目）";
  return processVersionText(project);
}

function lastActivity(projectId: string): string | null {
  const ts = lastActivityByProject.value.get(projectId);
  return ts ?? null;
}

onMounted(async () => {
  try {
    const list = await listProjects(api);
    projects.value = list;

    const lanes = new Map<string, ReturnType<typeof deriveGateLanes>>();
    const activity = new Map<string, string>();
    const approvals: PendingApproval[] = [];
    const tasks: ActiveTask[] = [];

    await Promise.all(
      list.map(async (project) => {
        const maxTs = (a: string, b: string | null | undefined) => (b && b > a ? b : a);
        let latest = project.created_at;
        try {
          const [subs, agentList] = await Promise.all([
            projectType(project) === "engineering" ? listGateSubmissions(api, project.id) : Promise.resolve([] as GateSubmission[]),
            listTasks(api, project.id).catch(() => ({ agents: [] as readonly TaskAgentSummary[] })),
          ]);
          lanes.set(project.id, deriveGateLanes(subs));
          for (const sub of subs) {
            latest = maxTs(latest, sub.submitted_at ?? sub.created_at);
            if (sub.state === "in_review") approvals.push({ project, submission: sub });
          }
          for (const run of agentList.agents) {
            latest = maxTs(latest, run.created_at);
            if (run.status === "running" || run.status === "awaiting_approval") {
              tasks.push({ project, run });
            }
          }
        } catch {
          lanes.set(project.id, deriveGateLanes([]));
        }
        activity.set(project.id, latest);
      }),
    );

    lanesByProject.value = lanes;
    lastActivityByProject.value = activity;
    pendingApprovals.value = approvals.sort((a, b) =>
      (a.submission.submitted_at ?? a.submission.created_at) < (b.submission.submitted_at ?? b.submission.created_at) ? 1 : -1,
    );
    activeTasks.value = tasks.sort((a, b) => (a.run.created_at < b.run.created_at ? 1 : -1));
  } catch (err) {
    error.value = err;
  } finally {
    loading.value = false;
  }
});

// ── 新建项目对话框 ─────────────────────────────────────────────────────
const showCreateDialog = ref(false);
const newProjectName = ref("");
const newProjectType = ref<ProjectType | null>(null);
const newProcessProfileId = ref("");
const newProjectPart = ref("");
const processVersions = ref<ProcessVersion[]>([]);
const processVersionsLoading = ref(false);
const processVersionsError = ref<unknown>(null);
const creating = ref(false);
const createError = ref<unknown>(null);

const availableProcessProfileIds = computed(() => processVersions.value.map((version) => version.id));
const createDisabled = computed(() => {
  if (creating.value || !newProjectType.value || !newProjectName.value.trim()) return true;
  if (newProjectType.value === "free") return false;
  return (
    processVersionsLoading.value ||
    processVersionsError.value !== null ||
    !availableProcessProfileIds.value.includes(newProcessProfileId.value)
  );
});

async function loadProcessVersions(): Promise<void> {
  processVersionsLoading.value = true;
  processVersionsError.value = null;
  processVersions.value = [];
  newProcessProfileId.value = "";
  try {
    processVersions.value = await listProcessVersions(api);
  } catch (err) {
    processVersionsError.value = err;
  } finally {
    processVersionsLoading.value = false;
  }
}

function openCreateDialog() {
  newProjectName.value = "";
  newProjectType.value = null;
  newProcessProfileId.value = "";
  newProjectPart.value = "";
  processVersions.value = [];
  processVersionsError.value = null;
  createError.value = null;
  showCreateDialog.value = true;
  void loadProcessVersions();
}

async function submitCreate() {
  const name = newProjectName.value.trim();
  if (creating.value) return;
  const validationError = validateCreateProject({
    name,
    projectType: newProjectType.value,
    processProfileId: newProcessProfileId.value,
    targetPart: newProjectPart.value,
    availableProcessProfileIds: availableProcessProfileIds.value,
  });
  if (validationError) {
    createError.value = new Error(validationError);
    return;
  }
  const selectedType = newProjectType.value;
  if (!selectedType) return;
  const baseRequest = {
    id: `proj-${crypto.randomUUID().slice(0, 8)}`,
    name,
    data_classification: "D1",
    ...(newProjectPart.value.trim() ? { target_part: newProjectPart.value.trim() } : {}),
  };
  const request: CreateProjectRequest = selectedType === "engineering"
    ? { ...baseRequest, project_type: "engineering", process_profile_id: newProcessProfileId.value }
    : { ...baseRequest, project_type: "free" };
  creating.value = true;
  createError.value = null;
  try {
    const project = await createProject(
      api,
      request,
      crypto.randomUUID(),
    );
    showCreateDialog.value = false;
    await router.push(`/projects/${project.id}`);
  } catch (err) {
    createError.value = err;
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <h1 class="page-title">
    项目列表
    <button class="btn" style="float: right" @click="openCreateDialog">新建项目</button>
  </h1>
  <p class="page-sub">我的项目与当前进展。</p>

  <ErrorNotice v-if="error" :error="error" />
  <div v-if="loading" class="muted">加载中…</div>

  <template v-else>
    <!-- 我的待办：等待我批准的审查 + 我正在跑的任务 -->
    <div class="panel todo-panel">
      <h2>我的待办 <span class="muted" style="font-weight: 400">（{{ todoCount }}）</span></h2>
      <div v-if="todoCount === 0" class="muted">现在没有需要你处理的事。</div>
      <ul v-else class="todo-list">
        <li v-for="item in pendingApprovals" :key="item.submission.id">
          <StatusBadge text="待我批准" kind="warn" />
          <router-link :to="`/approvals/${item.project.id}/${item.submission.id}`">
            {{ item.project.name }} · {{ reviewName(item.submission.gate) }}
          </router-link>
          <span class="muted" style="font-size: 12px">
            提交于 {{ new Date(item.submission.submitted_at ?? item.submission.created_at).toLocaleString("zh-CN") }}
          </span>
        </li>
        <li v-for="item in activeTasks" :key="item.run.agent_id">
          <StatusBadge :text="item.run.status === 'awaiting_approval' ? '等待批准' : '进行中'" kind="accent" />
          <router-link :to="`/projects/${item.project.id}?run=${item.run.agent_id}`">
            {{ item.project.name }} · 任务执行中
          </router-link>
          <span class="muted" style="font-size: 12px">
            发起于 {{ new Date(item.run.created_at).toLocaleString("zh-CN") }}
          </span>
        </li>
      </ul>
    </div>

    <div class="panel">
      <table class="data" v-if="projects.length > 0">
        <thead>
          <tr>
            <th>项目名称</th>
            <th>类型</th>
            <th>流程版本</th>
            <th>状态</th>
            <th>当前阶段</th>
            <th>最近活动</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in projects" :key="p.id">
            <td>
              <router-link :to="`/projects/${p.id}`"><strong>{{ p.name }}</strong></router-link>
            </td>
            <td>{{ projectTypeLabel(p) }}</td>
            <td class="muted">{{ profileLabel(p) }}</td>
            <td>
              <StatusBadge :text="PROJECT_STATUS_TEXT[p.status] ?? p.status" :kind="p.status === 'active' ? 'ok' : 'plain'" />
            </td>
            <td>{{ stageText(p) }}</td>
            <td class="muted" style="white-space: nowrap">
              {{ lastActivity(p.id) ? new Date(lastActivity(p.id)!).toLocaleString("zh-CN") : "—" }}
            </td>
            <td>
              <router-link :to="`/projects/${p.id}`">进入项目</router-link>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="muted">暂无项目，点击右上「新建项目」开始。</div>
    </div>
  </template>

  <!-- 新建项目对话框 -->
  <div v-if="showCreateDialog" class="dialog-mask" @click.self="showCreateDialog = false">
    <div class="dialog panel" role="dialog" aria-label="新建项目">
      <h2>新建项目</h2>
      <ErrorNotice v-if="createError" :error="createError" />
      <fieldset class="field project-type-picker" :disabled="creating">
        <legend>项目类型（必选）</legend>
        <label><input v-model="newProjectType" type="radio" value="free" /> 自由项目</label>
        <label><input v-model="newProjectType" type="radio" value="engineering" /> 工程项目</label>
      </fieldset>
      <p v-if="newProjectType === null" class="muted form-hint">请先明确选择自由项目或工程项目。</p>
      <template v-else>
        <p v-if="newProjectType === 'free'" class="muted form-hint">自由项目用于开放探索，只需名称，目标器件可稍后填写。</p>
        <template v-else>
          <div v-if="processVersionsLoading" class="muted" role="status">正在从 Core 加载可用流程版本…</div>
          <div v-else-if="processVersionsError" class="field">
            <ErrorNotice :error="processVersionsError" />
            <p class="form-hint">无法取得 Core 的流程注册表，工程项目暂不可创建。</p>
            <button class="btn secondary" type="button" :disabled="creating" @click="loadProcessVersions">重试加载</button>
          </div>
          <div v-else-if="processVersions.length === 0" class="notice error" role="alert">
            Core 当前没有可用的工程流程版本，工程项目暂不可创建。
          </div>
          <label v-else class="field">
            <span>流程版本（必选）</span>
            <select v-model="newProcessProfileId" :disabled="creating">
              <option disabled value="">请选择 Core 返回的流程版本</option>
              <option v-for="profile in processVersions" :key="profile.id" :value="profile.id">
                {{ profile.name }}（{{ profile.version }}）
              </option>
            </select>
          </label>
          <p class="muted form-hint">流程版本以 Core 注册表为准；器件可以先留空。</p>
        </template>
        <label class="field">
          <span>项目名称（必填）</span>
          <input v-model="newProjectName" type="text" placeholder="如：星载图像处理模块" :disabled="creating" />
        </label>
        <label class="field">
          <span>目标器件（可选）</span>
          <input v-model="newProjectPart" type="text" :disabled="creating" />
        </label>
      </template>
      <div class="row-actions">
        <button class="btn" :disabled="createDisabled" @click="submitCreate">
          {{ creating ? "创建中…" : "创建并进入总览" }}
        </button>
        <button class="btn secondary" :disabled="creating" @click="showCreateDialog = false">取消</button>
      </div>
    </div>
  </div>
</template>
