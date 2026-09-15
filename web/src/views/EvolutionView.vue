<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { Sprout } from "lucide-vue-next";
import { api } from "../api/service.ts";
import {
  createCuratorRun,
  getEvolutionOverview,
  getLearnedSkill,
  getLearnedSkillVersion,
  getSkillApplication,
  listLearnedSkills,
  listSkillApplications,
  setLearnedSkillArchived,
  setLearnedSkillEnabled,
  setLearnedSkillPinned,
  updateEvolutionSettings,
  type CreateCuratorRunRequestV1,
  type CuratorRunV1,
  type EvolutionOverviewV1,
  type LearnedSkillDetailV1,
  type LearnedSkillSummaryV1,
  type LearnedSkillControlAction,
  type LearnedSkillVersionV1,
  type SkillApplicationDetailV1,
  type SkillApplicationListItemV1,
  type SkillControlRequestV1,
  type UpdateEvolutionSettingsRequestV1,
} from "../api/evolution.ts";
import {
  canControlLearnedSkill,
  canRunCurator,
  canToggleLearnedSkills,
  canToggleLearning,
  controlReasonError,
  freezeWriteAttempt,
  type FrozenWriteAttempt,
} from "../domain/evolution.ts";
import { createPoller, type Poller } from "../domain/tasks.ts";
import { SELF_EVOLUTION_FEATURE_ENABLED } from "../domain/feature-flags.ts";
import PageShell from "../components/layout/PageShell.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import EvolutionSummary from "../components/evolution/EvolutionSummary.vue";
import LearnedSkillList from "../components/evolution/LearnedSkillList.vue";
import LearnedSkillDetail from "../components/evolution/LearnedSkillDetail.vue";
import { Button as UiButton } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";

const overview = ref<EvolutionOverviewV1 | null>(null);
const skills = ref<readonly LearnedSkillSummaryV1[]>([]);
const skillsTruncated = ref(false);
const selectedSkillId = ref<string | null>(null);
const skillDetail = ref<LearnedSkillDetailV1 | null>(null);
const skillVersion = ref<LearnedSkillVersionV1 | null>(null);
const applications = ref<readonly SkillApplicationListItemV1[]>([]);
const applicationsTruncated = ref(false);
const applicationDetail = ref<SkillApplicationDetailV1 | null>(null);
const loading = ref(false);
const skillLoading = ref(false);
const applicationLoading = ref(false);
const loadError = ref<unknown>(null);
const detailError = ref<unknown>(null);
const operationError = ref<unknown>(null);
const notice = ref<string | null>(null);
const summaryReason = ref("");
const skillControlReason = ref("");
const operatingAction = ref<string | null>(null);
const operatingSkillAction = ref<LearnedSkillControlAction | null>(null);
const lastManualRun = ref<CuratorRunV1 | null>(null);

let skillLoadSequence = 0;
let applicationLoadSequence = 0;
let settingsAttempt: FrozenWriteAttempt<UpdateEvolutionSettingsRequestV1> | null = null;
let skillControlAttempt: FrozenWriteAttempt<SkillControlRequestV1> | null = null;
let curatorAttempt: FrozenWriteAttempt<CreateCuratorRunRequestV1> | null = null;

function replaceSkill(next: LearnedSkillSummaryV1): void {
  skills.value = skills.value.map((skill) => skill.skill_id === next.skill_id ? next : skill);
  if (skillDetail.value?.skill_id === next.skill_id) {
    skillDetail.value = { ...skillDetail.value, ...next };
  }
}

async function loadApplication(applicationId: string): Promise<void> {
  const sequence = ++applicationLoadSequence;
  applicationLoading.value = true;
  detailError.value = null;
  try {
    const next = await getSkillApplication(api, applicationId);
    if (sequence === applicationLoadSequence) applicationDetail.value = next;
  } catch (error) {
    if (sequence === applicationLoadSequence) {
      applicationDetail.value = null;
      detailError.value = error;
    }
  } finally {
    if (sequence === applicationLoadSequence) applicationLoading.value = false;
  }
}

async function loadSkill(skillId: string): Promise<void> {
  const sequence = ++skillLoadSequence;
  selectedSkillId.value = skillId;
  skillLoading.value = true;
  detailError.value = null;
  skillDetail.value = null;
  skillVersion.value = null;
  applications.value = [];
  applicationsTruncated.value = false;
  applicationDetail.value = null;
  skillControlReason.value = "";
  skillControlAttempt = null;
  try {
    const detail = await getLearnedSkill(api, skillId);
    if (sequence !== skillLoadSequence) return;
    skillDetail.value = detail;
    const versionId = detail.active_version_id ?? detail.versions[0]?.version_id ?? null;
    const [version, applicationPage] = await Promise.all([
      versionId ? getLearnedSkillVersion(api, skillId, versionId) : Promise.resolve(null),
      listSkillApplications(api, skillId, { limit: 50 }),
    ]);
    if (sequence !== skillLoadSequence) return;
    skillVersion.value = version;
    applications.value = applicationPage.items;
    applicationsTruncated.value = applicationPage.next_cursor !== null;
    const firstApplication = applicationPage.items[0]?.application_id;
    if (firstApplication) await loadApplication(firstApplication);
  } catch (error) {
    if (sequence === skillLoadSequence) detailError.value = error;
  } finally {
    if (sequence === skillLoadSequence) skillLoading.value = false;
  }
}

async function refreshAll(background = false): Promise<void> {
  if (!SELF_EVOLUTION_FEATURE_ENABLED) return;
  // 后台轮询不动 loading/notice，避免每 30s 闪骨架屏或清掉操作反馈
  if (!background) {
    loading.value = true;
    loadError.value = null;
    notice.value = null;
  }
  try {
    const [nextOverview, page] = await Promise.all([
      getEvolutionOverview(api),
      listLearnedSkills(api, { limit: 100 }),
    ]);
    overview.value = nextOverview;
    skills.value = page.items;
    skillsTruncated.value = page.next_cursor !== null;
    const retained = selectedSkillId.value && page.items.some((skill) => skill.skill_id === selectedSkillId.value)
      ? selectedSkillId.value
      : page.items[0]?.skill_id ?? null;
    selectedSkillId.value = retained;
    if (background) {
      // 轻轮询只把列表投影合并进当前详情头部，不重取版本与调用记录（详情刷新交给手动刷新/重选）
      const summary = page.items.find((skill) => skill.skill_id === retained);
      if (summary) replaceSkill(summary);
      return;
    }
    if (retained) await loadSkill(retained);
    else {
      skillDetail.value = null;
      skillVersion.value = null;
      applications.value = [];
      applicationsTruncated.value = false;
      applicationDetail.value = null;
    }
  } catch (error) {
    if (!background) loadError.value = error;
  } finally {
    if (!background) loading.value = false;
  }
}

async function selectVersion(versionId: string): Promise<void> {
  const skillId = selectedSkillId.value;
  if (!skillId || !versionId) return;
  detailError.value = null;
  try {
    skillVersion.value = await getLearnedSkillVersion(api, skillId, versionId);
  } catch (error) {
    detailError.value = error;
  }
}

async function updateSettings(kind: "learning" | "skills"): Promise<void> {
  const current = overview.value;
  const reason = summaryReason.value.trim();
  const reasonError = controlReasonError(reason);
  if (!current || reasonError || operatingAction.value) {
    if (reasonError) operationError.value = new Error(reasonError);
    return;
  }
  const actionAllowed = kind === "learning"
    ? canToggleLearning(current)
    : canToggleLearnedSkills(current);
  if (!actionAllowed) {
    operationError.value = new Error("Core rollout 未启用；当前只允许紧急禁用，不能恢复或切换学习状态。");
    return;
  }
  const body: UpdateEvolutionSettingsRequestV1 = {
    learning_paused: kind === "learning" ? !current.learning_paused : current.learning_paused,
    learned_skills_enabled: kind === "skills" ? !current.learned_skills_enabled : current.learned_skills_enabled,
    expected_revision: current.settings_revision,
    reason,
  };
  settingsAttempt = freezeWriteAttempt(settingsAttempt, JSON.stringify(body), body);
  operatingAction.value = `settings-${kind}`;
  operationError.value = null;
  notice.value = null;
  try {
    overview.value = await updateEvolutionSettings(api, settingsAttempt.body, settingsAttempt.idempotencyKey);
    settingsAttempt = null;
    summaryReason.value = "";
    notice.value = kind === "learning"
      ? (overview.value.learning_paused ? "学习已暂停；现有 Skill 仍可使用并记录调用。" : "学习已恢复。")
      : (overview.value.learned_skills_enabled ? "Learned Skills 已重新启用。" : "Learned Skills 已全局禁用；历史事实仍保留。 ");
  } catch (error) {
    operationError.value = error;
  } finally {
    operatingAction.value = null;
  }
}

async function controlSelectedSkill(action: LearnedSkillControlAction): Promise<void> {
  const detail = skillDetail.value;
  const reason = skillControlReason.value.trim();
  const reasonError = controlReasonError(reason);
  if (!detail || reasonError || operatingAction.value) {
    if (reasonError) operationError.value = new Error(reasonError);
    return;
  }
  if (!canControlLearnedSkill(overview.value?.rollout_enabled === true, detail.enabled, action)) {
    operationError.value = new Error("Core rollout 未启用；只能紧急禁用仍在使用的 Skill，Pin/Unpin、Archive/Restore 与恢复均保持锁定。");
    return;
  }
  const body: SkillControlRequestV1 = {
    expected_control_revision: detail.control_revision,
    reason,
  };
  const signature = `${detail.skill_id}:${action}:${JSON.stringify(body)}`;
  skillControlAttempt = freezeWriteAttempt(skillControlAttempt, signature, body);
  operatingAction.value = `skill-control-${action}`;
  operatingSkillAction.value = action;
  operationError.value = null;
  notice.value = null;
  try {
    const next = action === "enable" || action === "disable"
      ? await setLearnedSkillEnabled(
          api,
          detail.skill_id,
          action === "enable",
          skillControlAttempt.body,
          skillControlAttempt.idempotencyKey,
        )
      : action === "pin" || action === "unpin"
        ? await setLearnedSkillPinned(
            api,
            detail.skill_id,
            action === "pin",
            skillControlAttempt.body,
            skillControlAttempt.idempotencyKey,
          )
        : await setLearnedSkillArchived(
            api,
            detail.skill_id,
            action === "archive",
            skillControlAttempt.body,
            skillControlAttempt.idempotencyKey,
          );
    replaceSkill(next);
    skillControlAttempt = null;
    skillControlReason.value = "";
    notice.value = action === "enable"
      ? `已恢复 ${next.name}。`
      : action === "disable"
        ? `已禁用 ${next.name}；版本与调用历史均保留。`
        : action === "pin"
          ? `已 Pin ${next.name}；自动修改已锁定。`
          : action === "unpin"
            ? `已 Unpin ${next.name}；自动治理可再次按合同运行。`
            : action === "archive"
              ? `已 Archive ${next.name}；普通 Agent 搜索将隐藏它，固定 application 仍可查看和关闭。`
              : `已 Restore ${next.name}；它已恢复为可用状态。`;
    try {
      overview.value = await getEvolutionOverview(api);
    } catch {
      // The control write is already committed; a failed projection refresh must not be reported as a failed write.
    }
  } catch (error) {
    operationError.value = error;
  } finally {
    operatingAction.value = null;
    operatingSkillAction.value = null;
  }
}

async function runCurator(mode: "run" | "dry_run"): Promise<void> {
  const current = overview.value;
  const reason = summaryReason.value.trim();
  const reasonError = controlReasonError(reason);
  if (!current || reasonError || operatingAction.value) {
    if (reasonError) operationError.value = new Error(reasonError);
    return;
  }
  if (!canRunCurator(current)) {
    operationError.value = new Error("Core rollout 未启用；Curator run 与 dry-run 均保持锁定。");
    return;
  }
  const signature = `curator:${mode}:${reason}`;
  const body: CreateCuratorRunRequestV1 = curatorAttempt?.signature === signature
    ? curatorAttempt.body
    : { mode, reason, manual_key: crypto.randomUUID() };
  curatorAttempt = freezeWriteAttempt(curatorAttempt, signature, body);
  operatingAction.value = `curator-${mode}`;
  operationError.value = null;
  notice.value = null;
  try {
    lastManualRun.value = await createCuratorRun(api, curatorAttempt.body, curatorAttempt.idempotencyKey);
    curatorAttempt = null;
    summaryReason.value = "";
    notice.value = mode === "run"
      ? "Curator 已排队；正式运行会按预算评价 pending applications。"
      : "Curator dry-run 已完成；没有写 evaluation、Skill 版本或生命周期状态。";
  } catch (error) {
    operationError.value = error;
  } finally {
    operatingAction.value = null;
  }
}

// 30s 轻轮询：仅标签页可见时后台刷新概览与列表；写操作在途时跳过，
// 避免陈旧的 overview 投影覆盖刚提交的写结果
let poller: Poller | null = null;
onMounted(() => {
  if (!SELF_EVOLUTION_FEATURE_ENABLED) return;
  void refreshAll();
  poller = createPoller(() => {
    if (document.visibilityState === "hidden") return;
    if (operatingAction.value !== null) return;
    void refreshAll(true);
  }, 30000);
});
onBeforeUnmount(() => {
  poller?.stop();
  poller = null;
});
</script>

<template>
  <PageShell section="evolution">
    <div class="text-fg">
      <header class="mb-4">
        <h1 class="m-0 text-[28px] max-[560px]:text-2xl">自进化</h1>
        <p class="m-0 text-fg-secondary">查看 Synthia 自动沉淀的能力、真实调用证据和 Curator 评价。</p>
      </header>

    <!-- 宽度由 PageShell 的 max-w-[1392px] 统一约束，不再每层重复 w-[min(1500px,100%)] -->
    <Empty v-if="!SELF_EVOLUTION_FEATURE_ENABLED" class="border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Sprout :size="20" /></EmptyMedia>
        <EmptyTitle>Self-evolution 尚未在此 Web 发布中启用</EmptyTitle>
        <EmptyDescription>页面不会请求 Core。启用明确的 Web feature flag 后，才开放 Learned Skill 观测与控制。</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <UiButton
          as-child
          variant="outline"
          class="h-[30px] border-line-strong bg-panel px-3 text-[13px] font-normal text-fg shadow-none hover:bg-hover hover:text-fg"
        >
          <router-link to="/projects">返回项目列表</router-link>
        </UiButton>
      </EmptyContent>
    </Empty>

    <template v-else>
      <ErrorNotice v-if="loadError" :error="loadError" />
      <div
        v-if="loading && !overview"
        class="grid gap-4"
        role="status"
        aria-label="正在加载进化事实"
      >
        <div class="grid gap-4 rounded-lg border border-line bg-panel p-5">
          <Skeleton class="h-4 w-40" />
          <Skeleton class="h-8 w-3/5" />
          <div class="grid grid-cols-4 gap-3 max-[900px]:grid-cols-2">
            <Skeleton v-for="n in 4" :key="n" class="h-20 rounded-md" />
          </div>
        </div>
        <span class="visually-hidden">正在从 Core 加载进化事实…</span>
      </div>

      <template v-if="overview">
        <EvolutionSummary
          :overview="overview"
          :reason="summaryReason"
          :operating-action="operatingAction"
          :last-manual-run="lastManualRun"
          @update:reason="summaryReason = $event"
          @toggle-learning="updateSettings('learning')"
          @toggle-skills="updateSettings('skills')"
          @run-curator="runCurator"
          @refresh="refreshAll()"
        />

        <p
          v-if="notice"
          class="rounded-md border border-[color-mix(in_srgb,var(--state-ok)_35%,var(--border))] bg-[color-mix(in_srgb,var(--state-ok)_10%,var(--surface-panel))] px-3 py-2 text-ok"
          role="status"
        >{{ notice }}</p>
        <ErrorNotice v-if="operationError" :error="operationError" />

        <div class="mt-4 grid min-w-0 grid-cols-[minmax(280px,0.36fr)_minmax(0,1fr)] gap-4 max-[980px]:grid-cols-1">
          <LearnedSkillList
            :items="skills"
            :selected-skill-id="selectedSkillId"
            :loading="loading"
            :truncated="skillsTruncated"
            @select="loadSkill"
          />
          <div class="grid min-w-0 content-start gap-3">
            <ErrorNotice v-if="detailError" :error="detailError" />
            <LearnedSkillDetail
              :detail="skillDetail"
              :version="skillVersion"
              :applications="applications"
              :applications-truncated="applicationsTruncated"
              :application="applicationDetail"
              :loading="skillLoading"
              :application-loading="applicationLoading"
              :operating-action="operatingSkillAction"
              :control-reason="skillControlReason"
              :rollout-enabled="overview.rollout_enabled"
              @select-version="selectVersion"
              @select-application="loadApplication"
              @control="controlSelectedSkill"
              @update:control-reason="skillControlReason = $event"
            />
          </div>
        </div>
      </template>
    </template>
    </div>
  </PageShell>
</template>
