<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
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
import { SELF_EVOLUTION_FEATURE_ENABLED } from "../domain/feature-flags.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import EvolutionSummary from "../components/evolution/EvolutionSummary.vue";
import LearnedSkillList from "../components/evolution/LearnedSkillList.vue";
import LearnedSkillDetail from "../components/evolution/LearnedSkillDetail.vue";

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

async function refreshAll(): Promise<void> {
  if (!SELF_EVOLUTION_FEATURE_ENABLED) return;
  loading.value = true;
  loadError.value = null;
  notice.value = null;
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
    if (retained) await loadSkill(retained);
    else {
      skillDetail.value = null;
      skillVersion.value = null;
      applications.value = [];
      applicationsTruncated.value = false;
      applicationDetail.value = null;
    }
  } catch (error) {
    loadError.value = error;
  } finally {
    loading.value = false;
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

onMounted(() => {
  if (SELF_EVOLUTION_FEATURE_ENABLED) void refreshAll();
});
</script>

<template>
  <div class="evolution-view">
    <header class="evolution-view-header">
      <div>
        <RouterLink to="/projects" class="evolution-back">← 返回项目列表</RouterLink>
        <h1>进化</h1>
        <p>查看 Synthia 自动沉淀的能力、真实调用证据和 Curator 评价。</p>
      </div>
    </header>

    <section v-if="!SELF_EVOLUTION_FEATURE_ENABLED" class="evolution-gated">
      <h2>Self-evolution 尚未在此 Web 发布中启用</h2>
      <p>页面不会请求 Core。启用明确的 Web feature flag 后，才开放 Learned Skill 观测与控制。</p>
      <RouterLink to="/projects">返回项目列表</RouterLink>
    </section>

    <template v-else>
      <ErrorNotice v-if="loadError" :error="loadError" />
      <div v-if="loading && !overview" class="evolution-loading" role="status">正在从 Core 加载进化事实…</div>

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
          @refresh="refreshAll"
        />

        <p v-if="notice" class="evolution-notice" role="status">{{ notice }}</p>
        <ErrorNotice v-if="operationError" :error="operationError" />

        <div class="evolution-workspace">
          <LearnedSkillList
            :items="skills"
            :selected-skill-id="selectedSkillId"
            :loading="loading"
            :truncated="skillsTruncated"
            @select="loadSkill"
          />
          <div class="evolution-detail-column">
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
</template>

<style scoped>
.evolution-view {
  min-height: 100vh;
  padding: var(--space-5);
  background: var(--surface-base);
  color: var(--text-primary);
}

.evolution-view-header,
.evolution-view > :not(.evolution-view-header) {
  width: min(1500px, 100%);
  margin-right: auto;
  margin-left: auto;
}

.evolution-view-header {
  margin-bottom: var(--space-4);
}

.evolution-view-header h1,
.evolution-view-header p {
  margin: 0;
}

.evolution-view-header h1 {
  margin-top: var(--space-2);
  font-size: 28px;
}

.evolution-view-header p,
.evolution-back {
  color: var(--text-secondary);
}

.evolution-back {
  font-size: var(--font-size-sm);
  text-decoration: none;
}

.evolution-back:hover {
  color: var(--accent);
}

.evolution-workspace {
  display: grid;
  grid-template-columns: minmax(280px, 0.36fr) minmax(0, 1fr);
  gap: var(--space-4);
  margin-top: var(--space-4);
  min-width: 0;
}

.evolution-detail-column {
  display: grid;
  align-content: start;
  gap: var(--space-3);
  min-width: 0;
}

.evolution-loading,
.evolution-gated {
  padding: var(--space-7);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-panel);
  color: var(--text-secondary);
  text-align: center;
}

.evolution-gated h2 {
  margin-top: 0;
  color: var(--text-primary);
}

.evolution-notice {
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--state-ok) 35%, var(--border));
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--state-ok) 10%, var(--surface-panel));
  color: var(--state-ok);
}

@media (max-width: 980px) {
  .evolution-workspace {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  .evolution-view {
    padding: var(--space-3);
  }

  .evolution-view-header h1 {
    font-size: 24px;
  }
}
</style>
