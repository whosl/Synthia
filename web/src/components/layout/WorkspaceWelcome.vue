<script setup lang="ts">
/**
 * 项目首页（中栏空态）：不是营销 splash，而是「项目主页」——
 * 头部（名称 + 类型/流程/当前门徽章）→ 流程进度（G0–G4 迷你步进器，
 * 仅工程项目有阶段链时渲染）→ 最近动态（真实阶段运行记录；全新项目
 * 退化为一次性新手引导）→ 操作区（主 CTA + 浏览文件 + 示例任务）。
 *
 * 数据全部由 ProjectView 已有 computed 传入（stageChain/processState/
 * toolSummary/EXAMPLE_TASKS），本组件不发起任何请求；阶段文案复用
 * domain/impl-summary 的 STAGE_LABELS，门禁文案复用
 * domain/process-profile 的 PROCESS_GATE_STATUS_TEXT/processProgress。
 * 视觉取舍：去掉旧 splash 的径向光晕与大图标，保持文档式的安静版面。
 */
import { computed } from "vue";
import { CircleCheck, CircleX, Folder, LoaderCircle, Sparkles } from "lucide-vue-next";
import Button from "../ui/AppButton.vue";
import Badge from "../ui/AppBadge.vue";
import type { ProcessStateV1, ToolSummary } from "../../api/types.ts";
import {
  PROCESS_GATE_STATUS_TEXT,
  processProgress,
  type ProcessGateStatus,
  type ProcessGateView,
} from "../../domain/process-profile.ts";
import { STAGE_LABELS } from "../../domain/impl-summary.ts";

const props = withDefaults(
  defineProps<{
    projectName: string;
    engineering: boolean;
    hasAgent: boolean;
    showBrowse: boolean;
    /** 项目类型文案（顶栏项目概览 chip 同源）。 */
    typeLabel?: string;
    /** 流程模板文案（仅工程项目有）。 */
    profileLabel?: string | null;
    /** P4 流程状态；有值时头部显示当前门/已密封徽章。 */
    processState?: ProcessStateV1 | null;
    /** G0–G4 门链投影；null 时整段进度区不渲染。 */
    stageChain?: readonly ProcessGateView[] | null;
    /** 工具摘要；推导「最近动态」行。 */
    summary?: ToolSummary | null;
    /** 示例任务（domain/unified.ts:EXAMPLE_TASKS 同源），仅无 Agent 时展示前三条。 */
    exampleTasks?: readonly string[];
  }>(),
  {
    typeLabel: "",
    profileLabel: null,
    processState: null,
    stageChain: null,
    summary: null,
    exampleTasks: () => [],
  },
);

const emit = defineEmits<{ start: []; browse: []; example: [text: string] }>();

// 头部当前门徽章：「G2 · 设计确认」；流程走完显示「已密封」。
const gateBadge = computed(() => {
  const state = props.processState;
  if (!state) return null;
  if (state.completed) return { text: "已密封", tone: "ok" as const };
  const name = props.stageChain?.find((entry) => entry.node.id === state.currentGate)?.node.name;
  return { text: name ? `${state.currentGate} · ${name}` : state.currentGate, tone: "accent" as const };
});

const progress = computed(() => (props.stageChain?.length ? processProgress(props.stageChain) : null));

const GATE_DOT_CLASS: Record<ProcessGateStatus, string> = {
  done: "border-ok bg-ok",
  current: "animate-pulse border-brand bg-brand",
  gated: "border-warn bg-warn",
  failed: "border-danger bg-danger",
  pending: "border-line-strong",
};

const GATE_LABEL_CLASS: Record<ProcessGateStatus, string> = {
  done: "text-fg-secondary",
  current: "font-medium text-brand",
  gated: "text-warn",
  failed: "text-danger",
  pending: "text-fg-muted",
};

interface ActivityRow {
  readonly key: string;
  readonly label: string;
  readonly state: string;
  readonly at: string;
}

const ACTIVITY_STATE_TEXT: Record<string, string> = {
  running: "运行中",
  submitted: "已提交",
  succeeded: "通过",
  failed: "失败",
};

// 最近动态：有运行时刻（lastAt）的阶段按时间倒序取前四条；码流产出也算一条。
const activityRows = computed<readonly ActivityRow[]>(() => {
  const summary = props.summary;
  if (!summary) return [];
  const rows: ActivityRow[] = summary.stages
    .filter((stage) => stage.lastAt !== null)
    .map((stage) => ({
      key: STAGE_LABELS[stage.operation].key,
      label: STAGE_LABELS[stage.operation].label,
      state: stage.state,
      at: stage.lastAt!,
    }));
  if (summary.bitstream.generated && summary.bitstream.at) {
    rows.push({ key: "bitstream", label: "码流", state: "succeeded", at: summary.bitstream.at });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4);
});

function activityStateText(state: string): string {
  return ACTIVITY_STATE_TEXT[state] ?? state;
}

function activityTone(state: string): string {
  if (state === "succeeded") return "text-ok";
  if (state === "failed") return "text-danger";
  return "text-brand";
}

// 与 VersionBar/RecordsPanel 一致的短时刻格式（MM/DD HH:mm）。
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const visibleExamples = computed(() => props.exampleTasks.slice(0, 3));
</script>
<template>
  <div class="flex h-full min-h-0 overflow-auto">
    <div class="m-auto flex w-full max-w-[720px] flex-col gap-9 px-10 py-12 max-[600px]:gap-7 max-[600px]:px-6">
      <!-- 头部：项目名 + 类型/流程/当前门徽章 -->
      <header class="flex flex-col gap-3">
        <h1 class="m-0 wrap-anywhere text-[22px] leading-[1.45] font-[550] text-fg">{{ projectName }}</h1>
        <div class="flex flex-wrap items-center gap-1.5">
          <Badge v-if="typeLabel" size="sm">{{ typeLabel }}</Badge>
          <Badge v-if="profileLabel" size="sm">{{ profileLabel }}</Badge>
          <Badge v-if="gateBadge" size="sm" :tone="gateBadge.tone">{{ gateBadge.text }}</Badge>
        </div>
      </header>

      <!-- 流程进度：G0–G4 迷你步进器（仅阶段链存在时渲染）；窄屏隐藏门名只留编号 -->
      <section v-if="stageChain && stageChain.length" aria-label="流程进度" class="flex flex-col gap-3">
        <div class="flex items-baseline justify-between">
          <h2 class="m-0 text-[11px] font-semibold tracking-[0.08em] text-fg-muted">流程进度</h2>
          <span v-if="progress" class="font-mono text-[11px] text-fg-muted">{{ progress.done }}/{{ progress.total }}</span>
        </div>
        <ol class="m-0 flex list-none items-center p-0">
          <li
            v-for="(entry, index) in stageChain"
            :key="entry.node.id"
            class="flex min-w-0 items-center"
            :class="index < stageChain.length - 1 ? 'flex-1' : 'flex-none'"
          >
            <span
              class="flex min-w-0 items-center gap-2"
              :title="`${entry.node.id} ${entry.node.name} · ${PROCESS_GATE_STATUS_TEXT[entry.status]}`"
            >
              <span class="size-2.5 flex-none rounded-full border-2" :class="GATE_DOT_CLASS[entry.status]" />
              <span class="whitespace-nowrap text-xs" :class="GATE_LABEL_CLASS[entry.status]"
                >{{ entry.node.id }}<span class="max-[600px]:hidden">&nbsp;{{ entry.node.name }}</span></span
              >
            </span>
            <span
              v-if="index < stageChain.length - 1"
              class="mx-3 h-px min-w-3 flex-1 bg-line max-[600px]:mx-2"
              aria-hidden="true"
            />
          </li>
        </ol>
      </section>

      <!-- 最近动态：真实阶段运行记录；全新项目退化为一次性引导 -->
      <section aria-label="最近动态" class="flex flex-col gap-3">
        <h2 class="m-0 text-[11px] font-semibold tracking-[0.08em] text-fg-muted">{{ activityRows.length ? "最近动态" : "从这里开始" }}</h2>
        <ul v-if="activityRows.length" class="m-0 flex list-none flex-col p-0">
          <li
            v-for="row in activityRows"
            :key="row.key"
            class="flex items-center gap-2.5 border-t border-line py-2 text-xs first:border-t-0"
          >
            <span class="flex flex-none items-center" :class="activityTone(row.state)">
              <LoaderCircle v-if="row.state === 'running' || row.state === 'submitted'" :size="13" class="animate-spin" />
              <CircleCheck v-else-if="row.state === 'succeeded'" :size="13" />
              <CircleX v-else :size="13" />
            </span>
            <span class="text-fg">{{ row.label }}</span>
            <span class="text-fg-muted">{{ activityStateText(row.state) }}</span>
            <span class="ml-auto flex-none font-mono text-[11px] text-fg-muted">{{ formatTime(row.at) }}</span>
          </li>
        </ul>
        <ol v-else class="m-0 flex list-none flex-col gap-2 p-0 text-xs text-fg-secondary">
          <li class="flex items-baseline gap-3"><i class="w-4 flex-none font-mono text-[10px] not-italic text-brand">01</i>明确任务目标</li>
          <li class="flex items-baseline gap-3"><i class="w-4 flex-none font-mono text-[10px] not-italic text-brand">02</i>查看文件与结果</li>
          <li class="flex items-baseline gap-3"><i class="w-4 flex-none font-mono text-[10px] not-italic text-brand">03</i>{{ engineering ? "核对证据并确认" : "验证并继续探索" }}</li>
        </ol>
      </section>

      <!-- 操作区：主 CTA + 浏览文件 + 示例任务（仅尚未建立 Agent 时展示） -->
      <div class="flex flex-col gap-4">
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="primary" @click="emit('start')"
            ><Sparkles :size="16" />{{ hasAgent ? "继续与 Agent 协作" : "开始第一个任务" }}</Button
          ><Button v-if="showBrowse" @click="emit('browse')"><Folder :size="16" />浏览文件</Button>
        </div>
        <div v-if="!hasAgent && visibleExamples.length" class="flex flex-col gap-2">
          <p class="m-0 text-[11px] text-fg-muted">没有头绪时，可以从一个示例任务开始：</p>
          <button
            v-for="task in visibleExamples"
            :key="task"
            type="button"
            class="w-full cursor-pointer rounded-md border border-line bg-transparent px-3 py-2 text-left text-xs leading-[1.6] text-fg-secondary transition-colors duration-150 hover:border-brand hover:bg-brand-subtle hover:text-fg"
            @click="emit('example', task)"
          >{{ task }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
