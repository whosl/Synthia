<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowLeft, ArrowRight, BookOpen, Layers, RefreshCw, ShieldCheck, Sparkles } from "lucide-vue-next";
import type { EvolutionOverviewV1, LearnedSkillSummaryV1 } from "../../api/evolution.ts";
import EvolutionEfficiency from "./EvolutionEfficiency.vue";
import { skillDisplayName, skillVisualState } from "../../domain/evolution-display.ts";

const props = defineProps<{
  overview: EvolutionOverviewV1;
  skills: readonly LearnedSkillSummaryV1[];
  selectedSkillId: string | null;
  truncated: boolean;
  refreshing: boolean;
}>();
const emit = defineEmits<{ select: [skillId: string]; refresh: [] }>();
const page = ref(0);
const pages = computed(() => Math.max(1, Math.ceil(props.skills.length / 6)));
const nodes = computed(() => props.skills.slice(page.value * 6, page.value * 6 + 6));
const attention = computed(() => props.overview.skill_counts.needs_review + props.overview.skill_counts.degraded + props.overview.skill_counts.quarantined);
const total = computed(() => Object.values(props.overview.skill_counts).reduce((sum, count) => sum + count, 0));
const selected = computed(() => props.skills.find((skill) => skill.skill_id === props.selectedSkillId));
const coordinates = [{ x: 22, y: 20 }, { x: 78, y: 20 }, { x: 15, y: 50 }, { x: 85, y: 50 }, { x: 22, y: 80 }, { x: 78, y: 80 }];
watch(() => props.selectedSkillId, (id) => {
  const index = props.skills.findIndex((skill) => skill.skill_id === id);
  if (index >= 0) page.value = Math.floor(index / 6);
}, { immediate: true });
watch(pages, (count) => { page.value = Math.min(page.value, count - 1); });
</script>

<template>
  <section class="evolution-landscape" aria-label="能力星图">
    <div class="landscape-story">
      <p class="landscape-eyebrow"><Sparkles :size="14" /> SYNTHIA · SELF EVOLUTION</p>
      <h2>让经验，<span>成为下一次的能力。</span></h2>
      <p class="landscape-intro">从工程实践中沉淀技能，在真实任务中复用、评价。</p>
      <div class="landscape-status">
        <span :class="{ enabled: overview.rollout_enabled && !overview.learning_paused }"><i />{{ !overview.rollout_enabled ? "学习未开放" : overview.learning_paused ? "学习已暂停" : "学习已开启" }}</span>
        <span>{{ overview.rollout_enabled && overview.learned_skills_enabled ? "技能复用已开启" : "技能复用已关闭" }}</span>
      </div>
      <EvolutionEfficiency :efficiency="overview.efficiency" />
      <div class="landscape-metrics">
        <div><strong>{{ overview.skill_counts.active_observed }}</strong><span>已观察技能</span></div>
        <div :class="{ attention: attention > 0 }"><strong>{{ attention }}</strong><span>需要关注</span></div>
        <div><strong>{{ overview.pending_applications }}</strong><span>调用待评价</span></div>
      </div>
      <p class="landscape-note">已观察表示已有评价记录，效果以各技能的调用证据为准。</p>
    </div>

    <div class="landscape-visual">
      <div class="map-toolbar"><span>能力星图 <small>点击技能查看详情</small></span><button type="button" aria-label="刷新进化数据" :disabled="refreshing" @click="emit('refresh')"><RefreshCw :size="15" :class="{ refreshing }" /></button></div>
      <div class="skill-map">
        <svg viewBox="0 0 600 310" preserveAspectRatio="none" aria-hidden="true">
          <ellipse cx="300" cy="155" rx="188" ry="99" class="map-orbit" />
          <ellipse cx="300" cy="155" rx="218" ry="125" class="map-orbit outer" />
          <line v-for="(skill, index) in nodes" :key="skill.skill_id" x1="300" y1="155" :x2="coordinates[index]!.x * 6" :y2="coordinates[index]!.y * 3.1" :class="['map-link', skillVisualState(skill), { selected: selectedSkillId === skill.skill_id }]" />
        </svg>
        <div class="map-core"><Layers :size="24" :stroke-width="1.25" /><strong>{{ total }}</strong><span>已沉淀技能</span></div>
        <button v-for="(skill, index) in nodes" :key="skill.skill_id" type="button"
          :class="['skill-node', skillVisualState(skill), { selected: selectedSkillId === skill.skill_id }]"
          :style="{ left: `${coordinates[index]!.x}%`, top: `${coordinates[index]!.y}%` }"
          :aria-label="`查看技能：${skillDisplayName(skill.name)}`" :aria-pressed="selectedSkillId === skill.skill_id"
          :title="skill.name" @click="emit('select', skill.skill_id)">
          <span class="node-light" /><strong>{{ skillDisplayName(skill.name) }}</strong><small>v{{ skill.active_version_no ?? "—" }}</small>
        </button>
        <p v-if="!skills.length" class="map-empty">完成实践，积累第一项技能</p>
      </div>
      <div class="map-footer">
        <div class="map-legend"><span class="observed"><i />已观察</span><span class="unproven"><i />待观察</span><span class="attention"><i />需关注</span><span class="inactive"><i />停用</span></div>
        <div class="map-paging"><button type="button" aria-label="上一组技能" :disabled="page === 0" @click="page--"><ArrowLeft :size="13" /></button><span>{{ page + 1 }} / {{ pages }}</span><button type="button" aria-label="下一组技能" :disabled="page + 1 >= pages" @click="page++"><ArrowRight :size="13" /></button></div>
      </div>
      <p class="map-caption">{{ selected ? `正在查看：${skillDisplayName(selected.name)}` : "在实践中积累可复用能力" }}<span v-if="truncated"> · 星图仅展示已加载技能</span></p>
    </div>
    <div class="evolution-cycle" aria-label="自进化机制示意">
      <span><BookOpen :size="16" />实践经验</span><ArrowRight :size="14" /><span><Sparkles :size="16" />提炼技能</span><ArrowRight :size="14" /><span><Layers :size="16" />任务复用</span><ArrowRight :size="14" /><span><ShieldCheck :size="16" />结果评价</span><small>持续积累 · 依据证据改进</small>
    </div>
  </section>
</template>

<style scoped>
.evolution-landscape { display: grid; grid-template-columns: 1fr 1.15fr; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-page); background: var(--surface-panel); }
.landscape-story { padding: 28px; min-width: 0; }
.landscape-eyebrow { display: flex; align-items: center; gap: 8px; margin: 0 0 16px; color: var(--accent); font: 11px/1.5 var(--font-mono); letter-spacing: 1px; }
.landscape-story h2 { margin: 0; font-size: clamp(24px, 2vw, 32px); line-height: 1.4; font-weight: 600; letter-spacing: -1px; }
.landscape-story h2 span { display: block; }
.landscape-intro { color: var(--text-secondary); font-size: 13px; line-height: 1.7; margin: 16px 0; }
.landscape-status { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 12px; color: var(--text-muted); }
.landscape-status span:first-child { display: flex; align-items: center; gap: 6px; }
.landscape-status i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.landscape-status .enabled { color: var(--state-ok); }
.landscape-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--border-subtle); }
.landscape-metrics > div { display: flex; flex-direction: column; gap: 6px; }
.landscape-metrics strong { font: 24px var(--font-mono); }
.landscape-metrics span { color: var(--text-secondary); font-size: 12px; }
.landscape-note { font-size: 12px; color: var(--text-muted); line-height: 1.7; margin: 16px 0 0; }
.landscape-visual { display: flex; flex-direction: column; justify-content: center; min-width: 0; padding: 24px; background: radial-gradient(var(--border-strong) .7px, transparent .7px) 0 0 / 24px 24px, var(--surface-base); }
.map-toolbar { display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: var(--text-secondary); }
.map-toolbar small { font-size: 12px; margin-left: 12px; color: var(--text-muted); }
.map-toolbar button, .map-paging button { display: grid; place-items: center; border: 1px solid var(--border-subtle); background: var(--surface-panel); color: var(--text-secondary); border-radius: 8px; width: 32px; height: 32px; cursor: pointer; }
.map-toolbar button:hover, .map-paging button:hover { border-color: var(--border-strong); background: var(--surface-hover); }
.map-paging button:disabled, .map-toolbar button:disabled { opacity: .35; cursor: default; }
.skill-map { height: 340px; position: relative; margin: 12px 0; }
.skill-map > svg { position: absolute; width: 100%; height: 100%; }
.map-orbit { fill: none; stroke: var(--border-strong); stroke-width: 1; }
.map-orbit.outer { stroke-dasharray: 2 8; opacity: .5; }
.map-link { stroke: currentColor; stroke-width: 1; opacity: .25; }
.map-link.selected { opacity: .85; stroke-width: 2; }
.map-core { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 104px; height: 104px; border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; border: 1px solid var(--border-strong); background: var(--surface-panel); box-shadow: 0 0 0 8px var(--surface-base); }
.map-core svg { color: var(--accent); }
.map-core strong { font: 28px var(--font-mono); }
.map-core span { font-size: 11px; color: var(--text-secondary); }
.skill-node { position: absolute; transform: translate(-50%, -50%); display: grid; grid-template-columns: 6px minmax(0, 1fr); align-items: center; gap: 6px 8px; width: 124px; padding: 12px; text-align: left; background: var(--surface-panel); border: 1px solid var(--border-strong); border-radius: 8px; cursor: pointer; transition: border-color 160ms, background 160ms; }
.skill-node strong { font-size: 12px; font-weight: 500; color: var(--text-primary); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.skill-node small { grid-column: 2; font: 11px var(--font-mono); color: var(--text-muted); }
.node-light, .map-legend i { background: currentColor; border-radius: 50%; width: 6px; height: 6px; }
.skill-node:hover { background: var(--surface-hover); }
.skill-node.selected { border-color: currentColor; background: color-mix(in srgb, currentColor 5%, var(--surface-panel)); }
.observed { color: var(--state-ok); }.unproven { color: var(--state-info); }.attention { color: var(--state-warn); }.inactive { color: var(--text-muted); }
.map-footer { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
.map-legend { display: flex; flex-wrap: wrap; gap: 10px; }
.map-legend span { display: flex; align-items: center; gap: 4px; font-size: 11px; }
.map-paging { display: flex; align-items: center; gap: 8px; font: 11px var(--font-mono); color: var(--text-muted); }
.map-caption { margin: 12px 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; color: var(--text-muted); }
.map-empty { position: absolute; bottom: 0; width: 100%; text-align: center; font-size: 12px; color: var(--text-muted); }
.evolution-cycle { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 20px 28px; border-top: 1px solid var(--border-subtle); font-size: 12px; color: var(--text-secondary); }
.evolution-cycle > span { display: flex; align-items: center; gap: 8px; }
.evolution-cycle > span svg { color: var(--accent); }
.evolution-cycle > svg, .evolution-cycle small { color: var(--text-muted); }
.evolution-cycle small { font-size: 12px; }
.refreshing { animation: spin 1.5s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 1400px) { .evolution-landscape { grid-template-columns: 1fr; }.landscape-story { padding: 24px; }.landscape-story h2 span { display: inline; }.landscape-visual { padding: 24px; }.skill-node { width: 160px; }.landscape-metrics > div { flex-direction: row; align-items: baseline; gap: 12px; }.evolution-cycle small { display: none; } }
@media (max-width: 600px) {
  .landscape-story { padding: 20px; }.landscape-story h2 { font-size: 24px; }.landscape-story h2 span { display: block; }.landscape-eyebrow { font-size: 10px; }.landscape-metrics { gap: 12px; }.landscape-metrics > div { flex-direction: column; gap: 4px; }.landscape-metrics strong { font-size: 24px; }
  .landscape-visual { padding: 20px; }.map-toolbar small { display: none; }
  .skill-map { height: auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 20px 0; }
  .skill-map > svg { display: none; }.map-core { position: static; transform: none; width: auto; height: auto; padding: 12px; border: 0; border-radius: 8px; box-shadow: none; grid-column: 1 / -1; flex-direction: row; gap: 12px; }.map-core span { font-size: 12px; }
  .skill-node { position: static; transform: none; width: 100%; }.map-empty { position: static; grid-column: 1 / -1; }
  .evolution-cycle { padding: 16px; gap: 4px; font-size: 11px; }.evolution-cycle > span svg { display: none; }.evolution-cycle > svg { width: 12px; }
}
</style>
