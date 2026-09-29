<script setup lang="ts">
import { computed, ref } from "vue";
import { FileSearch, History } from "lucide-vue-next";
import type {
  LearnedSkillControlAction,
  LearnedSkillDetailV1,
  LearnedSkillVersionV1,
  SkillApplicationDetailV1,
  SkillApplicationListItemV1,
} from "../../api/evolution.ts";
import {
  APPLICATION_STATE_TEXT,
  EVALUATION_OUTCOME_TEXT,
  QUALITY_STATE_TEXT,
  QUALITY_STATE_TONE,
  currentEvaluationIds,
  formatEvolutionDuration,
  formatEvolutionTime,
  successRateText,
} from "../../domain/evolution.ts";
import { efficiencyDuration, efficiencySpeedup, skillDisplayName, skillOutcomeSegments } from "../../domain/evolution-display.ts";
import Badge from "../ui/AppBadge.vue";
import Button from "../ui/AppButton.vue";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import StatCard from "../StatCard.vue";
import ConfirmDialog from "../ConfirmDialog.vue";

const props = defineProps<{
  detail: LearnedSkillDetailV1 | null;
  version: LearnedSkillVersionV1 | null;
  applications: readonly SkillApplicationListItemV1[];
  applicationsTruncated: boolean;
  application: SkillApplicationDetailV1 | null;
  loading: boolean;
  applicationLoading: boolean;
  operatingAction: LearnedSkillControlAction | null;
  controlReason: string;
  rolloutEnabled: boolean;
}>();

const emit = defineEmits<{
  "select-version": [versionId: string];
  "select-application": [applicationId: string];
  control: [action: LearnedSkillControlAction];
  "update:controlReason": [reason: string];
}>();

const activeTab = ref("overview");
const tabs = [{ id: "overview", label: "效果概览" }, { id: "applications", label: "调用证据" }, { id: "version", label: "版本资产" }];
const outcomes = computed(() => props.detail ? skillOutcomeSegments(props.detail.metrics) : []);
const outcomeTotal = computed(() => outcomes.value.reduce((sum, item) => sum + item.count, 0));
function onTabKey(event: KeyboardEvent, index: number): void {
  const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
    : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
    : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
  if (next === null) return;
  event.preventDefault();
  activeTab.value = tabs[next]!.id;
  document.getElementById(`skill-tab-${activeTab.value}`)?.focus();
}
const currentEvaluationSet = computed(() => currentEvaluationIds(props.application?.evaluations ?? []));

// StatCard 的 value 走属性绑定（JS 字符串不能用双引号），测试锁定的原表达式留在 script
const firstSolvedText = computed(() => {
  const detail = props.detail;
  return detail ? detail.metrics.first_solved_problem_families ?? "未知" : "未知";
});

// 提效对照：源轨迹（蒸馏臂）vs success 应用中位（技能臂）；缺任一侧臂显示未知
const efficiencySpeedupText = computed(() => {
  const metrics = props.detail?.metrics;
  if (!metrics || metrics.efficiency_speedup === null || metrics.efficiency_saved_ms === null) {
    return "未知";
  }
  const delta = metrics.efficiency_saved_ms;
  return `${efficiencySpeedup(metrics.efficiency_speedup)} · ${delta < 0 ? "多用" : "省"} ${efficiencyDuration(delta)}`;
});

// disable/archive 改变 Skill 可用性、影响 Agent 检索，需二次确认；enable/restore/pin/unpin 直接执行
const pendingControl = ref<"disable" | "archive" | null>(null);
const controlConfirmText = computed(() => {
  if (!pendingControl.value) return null;
  const name = props.detail?.name ?? "此 Skill";
  return pendingControl.value === "disable"
    ? {
        title: `禁用 Learned Skill「${name}」？`,
        description: "禁用后 Agent 将停止使用它；版本与真实调用历史全部保留，可填写原因后随时恢复。",
        confirmLabel: "确认禁用",
      }
    : {
        title: `Archive「${name}」？`,
        description: "Archive 后普通 Agent 搜索将隐藏它；固定 application 仍可查看和关闭，可稍后 Restore。",
        confirmLabel: "确认 Archive",
      };
});

function requestControl(action: LearnedSkillControlAction): void {
  if (action === "disable" || action === "archive") {
    pendingControl.value = action;
    return;
  }
  emit("control", action);
}

function confirmControl(): void {
  const action = pendingControl.value;
  pendingControl.value = null;
  if (action) emit("control", action);
}

function closeControlConfirm(): void {
  pendingControl.value = null;
}

function onControlReason(value: string | number): void {
  emit("update:controlReason", String(value));
}

function onSelectVersion(value: unknown): void {
  if (typeof value === "string" && value) emit("select-version", value);
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function shortHash(value: string): string {
  return `${value.slice(0, 12)}…`;
}
</script>

<template>
  <main class="skill-detail grid min-h-0 min-w-0 content-start gap-4 rounded-lg border border-line bg-panel p-5 max-[560px]:p-3">
    <div v-if="loading" class="grid content-start gap-3" role="status" aria-label="正在加载 Skill 事实">
      <Skeleton class="h-5 w-1/3" />
      <Skeleton class="h-3 w-2/3" />
      <div class="grid grid-cols-2 gap-3">
        <Skeleton v-for="n in 4" :key="n" class="h-16 rounded-md" />
      </div>
      <span class="visually-hidden">正在加载 Skill 事实…</span>
    </div>
    <Empty v-else-if="!detail">
      <EmptyHeader>
        <EmptyMedia variant="icon"><FileSearch :size="20" /></EmptyMedia>
        <EmptyTitle>尚未选择 Learned Skill</EmptyTitle>
        <EmptyDescription>从左侧选择一个 Learned Skill 查看版本、资产和真实调用评价。</EmptyDescription>
      </EmptyHeader>
    </Empty>
    <template v-else>
      <header class="flex items-start justify-between gap-2 max-[560px]:flex-col max-[560px]:items-stretch">
        <div class="min-w-0">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <h2 class="m-0 min-w-0 max-w-full wrap-anywhere">{{ skillDisplayName(detail.name) }}</h2>
            <Badge v-if="detail.quality_state" class="min-w-0 max-w-full" :tone="QUALITY_STATE_TONE[detail.quality_state]">
              {{ QUALITY_STATE_TEXT[detail.quality_state] }}
            </Badge>
            <Badge v-if="!detail.enabled" class="min-w-0 max-w-full" tone="danger">已禁用</Badge>
            <Badge v-if="detail.pinned" class="min-w-0 max-w-full" tone="info">Pinned · 自动修改锁定</Badge>
            <Badge v-if="detail.availability_state === 'archived'" class="min-w-0 max-w-full" tone="warn">Archived · 普通搜索隐藏</Badge>
          </div>
          <p class="m-0 mt-2 line-clamp-2 text-xs leading-relaxed text-fg-secondary">{{ detail.summary }}</p>
        </div>
        <details class="skill-controls min-w-0 shrink-0 max-[560px]:w-full">
          <summary class="cursor-pointer rounded-md border border-line px-3 py-2 text-xs text-fg-secondary">管理技能</summary>
          <div class="mt-3 grid max-w-[300px] gap-3">
          <label class="grid w-full gap-1 text-xs text-fg-secondary">
            <span>Skill 控制原因</span>
            <Input
              :model-value="controlReason"
              type="text"
              maxlength="500"
              placeholder="说明本次 Pin、状态或可用性变更"
              :disabled="operatingAction !== null"
              class="h-8 bg-base px-2"
              @update:model-value="onControlReason"
            />
          </label>
          <div class="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              :variant="detail.enabled ? 'danger' : 'primary'"
              :loading="operatingAction === (detail.enabled ? 'disable' : 'enable')"
              :disabled="operatingAction !== null || !controlReason.trim() || (!detail.enabled && !rolloutEnabled)"
              @click="requestControl(detail.enabled ? 'disable' : 'enable')"
            >
              {{ detail.enabled ? "禁用此 Skill" : "恢复此 Skill" }}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              :loading="operatingAction === (detail.pinned ? 'unpin' : 'pin')"
              :disabled="operatingAction !== null || !controlReason.trim() || !rolloutEnabled"
              @click="emit('control', detail.pinned ? 'unpin' : 'pin')"
            >
              {{ detail.pinned ? "Unpin" : "Pin" }}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              :loading="operatingAction === (detail.availability_state === 'archived' ? 'restore' : 'archive')"
              :disabled="operatingAction !== null || !controlReason.trim() || !rolloutEnabled"
              @click="requestControl(detail.availability_state === 'archived' ? 'restore' : 'archive')"
            >
              {{ detail.availability_state === "archived" ? "Restore" : "Archive" }}
            </Button>
          </div>
          <small v-if="!rolloutEnabled" class="text-xs text-fg-secondary">
            {{ detail.enabled
              ? "rollout 关闭期间仅保留紧急禁用；Pin/Unpin 与 Archive/Restore 均锁定。"
              : "rollout 关闭期间不能恢复、Pin/Unpin 或 Archive/Restore。" }}
          </small>
        </div>
        </details>
      </header>

      <div class="evolution-tabs" role="tablist" aria-label="技能详情视图">
        <button v-for="(tab, index) in tabs" :id="`skill-tab-${tab.id}`" :key="tab.id" type="button" role="tab" :tabindex="activeTab === tab.id ? 0 : -1" :aria-selected="activeTab === tab.id" :aria-controls="`skill-panel-${tab.id}`" @keydown="onTabKey($event, index)" @click="activeTab = tab.id">{{ tab.label }}</button>
      </div>
      <section v-if="activeTab === 'overview'" id="skill-panel-overview" role="tabpanel" aria-labelledby="skill-tab-overview" class="grid min-w-0 gap-4">
      <p class="m-0 text-xs text-fg-secondary">{{ detail.metrics_scope === 'all_versions' ? `全部版本累计 · ${detail.versions.length} 个版本，升级后保留历史调用效果` : '当前版本统计' }}</p>
      <section class="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1" aria-label="Skill 真实调用指标">
        <StatCard
          label="目标解决率"
          :value="successRateText(detail.metrics)"
          :hint="detail.metrics.measurement_state === 'unknown' ? '证据不足，不推断提升' : `${detail.metrics.success} 成功 / ${detail.metrics.evaluated - detail.metrics.inconclusive} 有效评价`"
        />
        <StatCard
          label="主用 / 待评价"
          :value="`${detail.metrics.primary_applied} / ${detail.metrics.pending}`"
          hint="实际调用记录"
        />
        <StatCard
          label="中位活跃处理时长"
          :value="formatEvolutionDuration(detail.metrics.median_duration_ms)"
          hint="技能应用至关闭，长间隔按上限计入"
        />
        <StatCard
          label="提效对比"
          :value="efficiencySpeedupText"
          :hint="detail.metrics.baseline_duration_ms === null
            ? '源轨迹时长未知'
            : `源轨迹 ${formatEvolutionDuration(detail.metrics.baseline_duration_ms)} → 技能应用中位`"
        />
      </section>
      <div class="outcome-card" aria-label="调用结果分布">
        <div class="outcome-heading"><span>调用结果</span><small>{{ outcomeTotal }} 条已评价或待评价记录</small></div>
        <div v-if="outcomeTotal" class="outcome-bar" aria-hidden="true"><i v-for="item in outcomes.filter(segment => segment.count > 0)" :key="item.key" :class="item.key" :style="{ flex: item.count }" /></div>
        <p v-else class="text-xs text-fg-muted">还没有可评价的调用记录。</p>
        <div class="outcome-legend"><span v-for="item in outcomes" :key="item.key"><i :class="item.key" />{{ item.label }} <b>{{ item.count }}</b></span></div>
        <p v-if="detail.metrics.inconclusive > 0 || detail.metrics.pending > 0" class="mb-0 mt-3 text-[10px] text-fg-muted">证据不足和待评价记录不计入解决率。</p>
      </div>
      <details class="skill-description rounded-md border border-line bg-base p-3">
        <summary class="cursor-pointer text-xs text-fg-secondary">完整能力说明与补充指标</summary>
        <div class="mt-3 grid min-w-0 gap-3 text-xs leading-relaxed">
          <strong class="wrap-anywhere">{{ detail.name }}</strong>
          <p class="m-0 wrap-anywhere text-fg-secondary">{{ detail.summary }}</p>
          <p class="m-0 wrap-anywhere text-fg-secondary">适用参考：{{ detail.applicability_summary }}</p>
          <div class="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
        <StatCard
          label="人工纠正"
          :value="detail.metrics.human_corrections ?? '未知'"
          :hint="`inconclusive ${detail.metrics.inconclusive} 次`"
        />
        <StatCard
          label="首次解决问题族"
          :value="firstSolvedText"
          hint="暂无问题族事实时不推断为 0"
        />
          </div>
        </div>
      </details>
      </section>

      <section v-if="activeTab === 'version'" id="skill-panel-version" role="tabpanel" aria-labelledby="skill-tab-version" class="grid min-w-0 gap-3">
        <div class="flex items-start justify-between gap-2 max-[560px]:flex-col max-[560px]:items-stretch">
          <div>
            <h3 class="m-0">不可变版本与资产</h3>
            <p class="m-0 text-fg-secondary">
              来源 {{ detail.source_summary.visible_source_count }}/{{ detail.source_summary.source_count }} 可见 ·
              distillation {{ detail.source_summary.distillation_run_id }}
            </p>
          </div>
          <label for="skill-version-select" class="grid gap-1 text-xs text-fg-secondary">
            <span>查看版本</span>
            <Select
              :model-value="version?.version.version_id ?? ''"
              @update:model-value="onSelectVersion"
            >
              <SelectTrigger id="skill-version-select" size="sm" class="w-full bg-base">
                <SelectValue placeholder="选择版本" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="item in detail.versions"
                  :key="item.version_id"
                  :value="item.version_id"
                >
                  v{{ item.version_no }} · {{ QUALITY_STATE_TEXT[item.quality_state] }}
                </SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>

        <div v-if="!version" class="grid content-start gap-2" role="status" aria-label="正在加载版本内容">
          <Skeleton class="h-3 w-1/2" />
          <Skeleton class="h-20 rounded-md" />
          <span class="visually-hidden">版本内容加载中…</span>
        </div>
        <template v-else>
          <section v-if="version.version.metrics" class="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1" aria-label="所选版本调用指标">
            <StatCard label="本版本目标解决率" :value="successRateText(version.version.metrics)" :hint="`仅 v${version.version.version_no} · ${version.version.metrics.success} 成功 / ${version.version.metrics.evaluated - version.version.metrics.inconclusive} 有效评价`" />
            <StatCard label="本版本主用 / 待评价" :value="`${version.version.metrics.primary_applied} / ${version.version.metrics.pending}`" hint="全部版本累计效果见概览" />
          </section>
          <p v-else class="m-0 text-xs text-fg-secondary">本版本统计暂不可用。</p>
          <div class="flex flex-wrap gap-x-4 gap-y-2 text-xs text-fg-secondary">
            <span>parent：{{ version.version.parent_version_id ?? "首版" }}</span>
            <span :title="version.version.content_manifest_hash">manifest：{{ shortHash(version.version.content_manifest_hash) }}</span>
            <span>扫描：{{ version.version.scan.decision }}（{{ version.version.scan.scanner_version }}）</span>
            <span>{{ formatEvolutionTime(version.version.created_at) }}</span>
          </div>
          <details class="rounded-md border border-line p-3">
            <summary class="cursor-pointer text-xs text-fg-secondary">版本完整说明</summary>
            <p class="mb-0 mt-3 wrap-anywhere text-xs leading-relaxed text-fg-secondary">{{ version.version.description }}</p>
          </details>
          <details class="rounded-md border border-line p-3">
            <summary class="cursor-pointer text-xs text-fg-secondary">适用条件与结果契约</summary>
          <div class="mt-3 grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
            <div class="min-w-0 rounded-md border border-line bg-base p-3">
              <h4 class="m-0">适用条件（供 Agent 自由判断）</h4>
              <pre class="evolution-code m-0 mt-2 max-h-[280px] max-w-full overflow-auto wrap-anywhere whitespace-pre-wrap rounded-sm bg-panel p-2 text-fg-secondary">{{ pretty(version.version.applicability) }}</pre>
            </div>
            <div class="min-w-0 rounded-md border border-line bg-base p-3">
              <h4 class="m-0">局部结果契约</h4>
              <pre class="evolution-code m-0 mt-2 max-h-[280px] max-w-full overflow-auto wrap-anywhere whitespace-pre-wrap rounded-sm bg-panel p-2 text-fg-secondary">{{ pretty(version.version.outcome_contract) }}</pre>
            </div>
          </div>
          </details>
          <div class="grid gap-2">
            <details
              v-for="file in version.version.files"
              :key="file.path"
              class="min-w-0 rounded-md border border-line bg-base px-3 py-2"
            >
              <summary class="flex min-w-0 cursor-pointer items-center justify-between gap-3 max-[560px]:flex-col max-[560px]:items-stretch">
                <span class="grid min-w-0">
                  <strong>{{ file.path }}</strong>
                  <small class="text-fg-secondary">{{ file.kind }} · {{ file.language ?? file.media_type }} · {{ file.size_bytes }} B</small>
                </span>
                <code class="text-fg-secondary" :title="file.sha256">{{ shortHash(file.sha256) }}</code>
              </summary>
              <pre class="evolution-code m-0 mt-2 max-h-[320px] max-w-full overflow-auto wrap-anywhere whitespace-pre-wrap rounded-sm bg-panel p-2 text-fg-secondary">{{ file.content }}</pre>
            </details>
          </div>
        </template>
      </section>

      <section v-if="activeTab === 'applications'" id="skill-panel-applications" role="tabpanel" aria-labelledby="skill-tab-applications" class="grid min-w-0 gap-3">
        <div class="flex items-start justify-between gap-2 max-[560px]:flex-col max-[560px]:items-stretch">
          <div>
            <h3 class="m-0">真实调用记录</h3>
            <p class="m-0 text-fg-secondary">只有 primary 且经 Curator 评价的结果进入单 Skill 解决率。</p>
          </div>
          <Badge tone="info">{{ applications.length }} 次可见调用</Badge>
        </div>
        <Empty v-if="applications.length === 0">
          <EmptyHeader>
            <EmptyMedia variant="icon"><History :size="20" /></EmptyMedia>
            <EmptyTitle>尚无可见调用</EmptyTitle>
            <EmptyDescription>当前指标保持“提升未知”。</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <div v-else class="grid min-w-0 grid-cols-[minmax(220px,0.7fr)_minmax(0,1.3fr)] gap-3 max-[900px]:grid-cols-1">
          <div class="grid max-h-[540px] content-start gap-2 overflow-auto">
            <button
              v-for="item in applications"
              :key="item.application_id"
              type="button"
              class="flex min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border bg-base p-3 text-left text-fg"
              :class="application?.application_id === item.application_id
                ? 'border-brand shadow-[inset_3px_0_0_var(--accent)]'
                : 'border-line'"
              @click="emit('select-application', item.application_id)"
            >
              <span class="grid min-w-0 gap-1">
                <strong class="line-clamp-2 text-xs leading-relaxed">{{ item.local_goal }}</strong>
                <small class="text-fg-secondary">{{ APPLICATION_STATE_TEXT[item.state] }} · {{ formatEvolutionTime(item.started_at) }}</small>
              </span>
              <Badge :tone="item.current_evaluation?.outcome === 'success' ? 'ok' : item.current_evaluation ? 'warn' : 'neutral'" size="sm">
                {{ item.current_evaluation ? EVALUATION_OUTCOME_TEXT[item.current_evaluation.outcome] : "待评价" }}
              </Badge>
            </button>
          </div>

          <div v-if="applicationLoading" class="grid content-start gap-2" role="status" aria-label="正在加载完整评价历史">
            <Skeleton class="h-3 w-2/5" />
            <Skeleton class="h-24 rounded-md" />
            <span class="visually-hidden">正在加载完整评价历史…</span>
          </div>
          <article v-else-if="application" class="grid min-w-0 gap-3 rounded-md border border-line bg-base p-3">
            <header class="flex items-start justify-between gap-2 max-[560px]:flex-col max-[560px]:items-stretch">
              <div>
                <h4 class="m-0">{{ application.local_goal }}</h4>
                <p class="m-0 text-fg-secondary">
                  项目：{{ application.project_ref === 'redacted' ? "受权限保护" : application.project_ref }} ·
                  任务：{{ application.task_ref === 'redacted' ? "受权限保护" : application.task_ref }}
                </p>
              </div>
              <Badge tone="info">{{ APPLICATION_STATE_TEXT[application.state] }}</Badge>
            </header>
            <dl class="m-0 flex flex-wrap gap-x-4 gap-y-2 text-xs text-fg-secondary">
              <div class="flex gap-1"><dt class="font-semibold">耗时</dt><dd class="m-0">{{ formatEvolutionDuration(application.duration_ms) }}</dd></div>
              <div class="flex gap-1"><dt class="font-semibold">人工纠正</dt><dd class="m-0">{{ application.human_corrections ?? "未知" }}</dd></div>
              <div class="flex gap-1"><dt class="font-semibold">证据</dt><dd class="m-0">{{ application.evidence_summary.visible }} 可见 / {{ application.evidence_summary.redacted }} 隐去</dd></div>
              <div class="flex gap-1"><dt class="font-semibold">episode</dt><dd class="m-0">{{ application.episode_ref === 'redacted' ? "受权限保护" : application.episode_ref ?? "尚未绑定" }}</dd></div>
            </dl>
            <p v-if="application.outcome_claim" class="m-0 border-l-[3px] border-line-strong p-2 text-fg-secondary">主 Agent 声明（非权威）：{{ application.outcome_claim }}</p>
            <div class="grid gap-x-4 gap-y-2 text-xs text-fg-secondary">
              <h5 class="m-0">归因</h5>
              <span v-for="skill in application.skills" :key="`${skill.version_id}:${skill.role}`">
                {{ skill.role === "primary" ? "primary" : "supporting" }} · {{ skill.version_id }} · {{ skill.reason_codes.join(" / ") }}
              </span>
            </div>
            <div class="grid gap-2">
              <h5 class="m-0">完整 evaluation / supersede 历史</h5>
              <p v-if="application.evaluations.length === 0" class="m-0">尚无评价；本次仍为 pending，不进入成功率。</p>
              <article
                v-for="evaluation in application.evaluations"
                v-else
                :key="evaluation.evaluation_id"
                class="grid gap-2 rounded-md border p-3"
                :class="currentEvaluationSet.has(evaluation.evaluation_id) ? 'border-brand' : 'border-line'"
              >
                <header class="flex flex-wrap items-center gap-2">
                  <Badge :tone="evaluation.outcome === 'success' ? 'ok' : evaluation.outcome === 'inconclusive' ? 'neutral' : 'warn'" size="sm">
                    {{ EVALUATION_OUTCOME_TEXT[evaluation.outcome] }}
                  </Badge>
                  <span>{{ evaluation.evaluator_type === "human" ? "人工" : "Curator" }} · 置信度 {{ Math.round(evaluation.confidence * 100) }}%</span>
                  <Badge v-if="currentEvaluationSet.has(evaluation.evaluation_id)" tone="accent" size="sm">当前评价</Badge>
                </header>
                <p class="m-0">{{ evaluation.reason }}</p>
                <footer class="flex flex-wrap items-center gap-2 text-[11px] text-fg-secondary">
                  <span>{{ evaluation.evaluation_id }}</span>
                  <span v-if="evaluation.supersedes_id">supersedes {{ evaluation.supersedes_id }}</span>
                  <span>证据 {{ evaluation.evidence_summary.visible }} 可见 / {{ evaluation.evidence_summary.redacted }} 隐去</span>
                  <span>{{ formatEvolutionTime(evaluation.created_at) }}</span>
                </footer>
              </article>
            </div>
          </article>
        </div>
        <p v-if="applicationsTruncated" class="m-0 mt-2 text-xs text-fg-secondary" role="status">
          当前只显示前 {{ applications.length }} 次可见调用，仍有更多结果未加载。
        </p>
      </section>

      <ConfirmDialog
        :open="pendingControl !== null"
        :title="controlConfirmText?.title ?? ''"
        :description="controlConfirmText?.description ?? ''"
        :confirm-label="controlConfirmText?.confirmLabel ?? ''"
        @update:open="closeControlConfirm"
        @confirm="confirmControl"
      />
    </template>
  </main>
</template>

<style scoped>
.skill-detail { overflow-wrap: anywhere; }
.evolution-tabs { display: flex; gap: 18px; border-bottom: 1px solid var(--border-subtle); }
.evolution-tabs button { border: 0; border-bottom: 2px solid transparent; padding: 10px 2px; background: transparent; color: var(--text-secondary); font-size: 12px; cursor: pointer; }
.evolution-tabs button[aria-selected="true"] { border-bottom-color: var(--accent); color: var(--accent); }
.outcome-card { border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--surface-base); padding: 18px; }
.outcome-heading { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; font-size: 12px; }.outcome-heading small { font-size: 10px; color: var(--text-muted); }
.outcome-bar { display: flex; height: 10px; overflow: hidden; gap: 3px; border-radius: 5px; margin: 20px 0; }.outcome-bar i { min-width: 0; }
.outcome-legend { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 14px; }.outcome-legend span { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--text-secondary); }.outcome-legend i { width: 6px; height: 6px; border-radius: 2px; }.outcome-legend b { font: 12px var(--font-mono); color: var(--text-primary); }
.success { background: var(--state-ok); }.failure { background: var(--state-danger); }.inconclusive { background: var(--text-muted); }.pending { background: var(--state-info); }

/* 同 chat/AgentToolItem 的 .agent-tool-code：未分层全局 pre 规则（font/line-height）
   优先级高于 Tailwind utilities 层，代码块行高留在 scoped。 */
.evolution-code {
  line-height: var(--line-height-list);
}
</style>
