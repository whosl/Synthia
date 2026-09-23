<script setup lang="ts">
import { computed, ref } from "vue";
import { ArrowUpRight, Cpu, Layers, ShieldCheck, Sparkles } from "lucide-vue-next";
import type { ProjectOverview } from "../../domain/project-overview.ts";

const props = defineProps<{ rows: readonly ProjectOverview[] }>();
const chosenId = ref("");
const selected = computed(() => props.rows.find((row) => row.project.id === chosenId.value) ?? props.rows[0]);
</script>

<template>
  <section v-if="selected" class="engineering-spotlight" aria-label="工程全景入口">
    <div class="spotlight-copy">
      <p class="spotlight-eyebrow"><span />SYNTHIA · FPGA ENGINEERING</p>
      <h2>让设计的进展，<br />看得见。</h2>
      <p class="spotlight-description">从设计到验证，将工程过程汇聚为可查看的成果。</p>
      <div class="spotlight-selection">
        <label class="visually-hidden" for="spotlight-project">选择全景项目</label>
        <select id="spotlight-project" :value="selected.project.id" @change="chosenId = ($event.target as HTMLSelectElement).value">
          <option v-for="row in rows" :key="row.project.id" :value="row.project.id">{{ row.project.name }}</option>
        </select>
        <router-link :to="{ name: 'project', params: { id: selected.project.id }, query: { overview: '1' } }">进入工程全景<ArrowUpRight :size="16" /></router-link>
      </div>
    </div>
    <div class="spotlight-visual" aria-hidden="true">
      <div class="spotlight-orbit orbit-one" /><div class="spotlight-orbit orbit-two" />
      <div class="spotlight-chip"><Cpu :size="34" :stroke-width="1" /><strong>SYNTHIA</strong><span>FPGA ENGINEERING</span><div><i v-for="n in 16" :key="n" /></div></div>
      <div class="capability capability-design"><Layers :size="17" /><span>设计产出<small>RTL · 约束 · 文档</small></span></div>
      <div class="capability capability-verify"><ShieldCheck :size="17" /><span>工具验证<small>仿真 · 综合 · 实现</small></span></div>
      <div class="capability capability-learn"><Sparkles :size="17" /><span>经验沉淀<small>学习 · 复用 · 评价</small></span></div>
    </div>
  </section>
</template>

<style scoped>
.engineering-spotlight { position: relative; display: grid; grid-template-columns: 1.15fr 1fr; min-height: 285px; margin-bottom: 28px; overflow: hidden; border: 1px solid var(--border-strong); border-radius: 16px; background: radial-gradient(ellipse at 85% 50%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 65%), var(--surface-panel); }
.spotlight-copy { padding: 30px 34px; z-index: 1; min-width: 0; }.spotlight-eyebrow { display: flex; align-items: center; gap: 7px; color: var(--accent); font: 9px var(--font-mono); letter-spacing: 1.5px; margin: 0 0 18px; }.spotlight-eyebrow > span { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }.spotlight-copy h2 { font-size: clamp(24px, 2.7vw, 37px); line-height: 1.35; letter-spacing: -1px; font-weight: 500; margin: 0 0 14px; }.spotlight-description { font-size: 12px; line-height: 1.8; color: var(--text-secondary); margin: 0 0 22px; }
.spotlight-selection { display: flex; flex-wrap: wrap; gap: 10px; }.spotlight-selection select { width: 170px; max-width: 100%; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface-base); color: var(--text-primary); padding: 9px 10px; font-size: 11px; text-overflow: ellipsis; }.spotlight-selection a { display: inline-flex; align-items: center; justify-content: center; gap: 12px; border-radius: 6px; background: var(--accent); color: var(--text-on-accent); padding: 10px 14px; font-size: 12px; font-weight: 550; }.spotlight-selection a:hover { background: var(--accent-hover); }
.spotlight-visual { position: relative; min-height: 285px; background-image: radial-gradient(var(--border-strong) .6px, transparent .6px); background-size: 18px 18px; mask-image: linear-gradient(90deg, transparent, black 15%); }.spotlight-orbit { position: absolute; left: 50%; top: 50%; width: 250px; height: 250px; transform: translate(-50%, -50%) rotate(35deg); border: 1px solid color-mix(in srgb, var(--accent) 15%, var(--border-subtle)); border-radius: 50%; }.orbit-two { width: 335px; height: 335px; border-style: dashed; opacity: .6; }
.spotlight-chip { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%) rotate(-8deg); width: 140px; height: 148px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; border: 1px solid color-mix(in srgb, var(--accent) 60%, var(--border-strong)); border-radius: 15px; background: linear-gradient(145deg, var(--surface-raised), var(--surface-base)); box-shadow: 0 0 0 8px var(--surface-panel), 0 0 0 9px var(--border-strong), 12px 22px 35px var(--shadow-color); color: var(--accent); }.spotlight-chip strong { font-size: 14px; font-weight: 500; letter-spacing: 3px; color: var(--text-primary); }.spotlight-chip > span { font: 6px var(--font-mono); letter-spacing: 1.5px; color: var(--text-muted); }.spotlight-chip > div { display: flex; gap: 3px; }.spotlight-chip i { width: 3px; height: 3px; background: var(--accent); opacity: .5; }
.capability { position: absolute; display: flex; align-items: center; gap: 10px; padding: 11px 13px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface-panel); color: var(--text-secondary); font-size: 11px; box-shadow: 0 8px 25px var(--shadow-color); }.capability small { display: block; color: var(--text-muted); font-size: 8px; margin-top: 5px; }.capability-design { top: 25px; left: 7%; }.capability-verify { right: 5%; top: 43%; }.capability-learn { bottom: 20px; left: 13%; }.capability-design svg { color: var(--accent); }.capability-verify svg { color: var(--state-ok); }.capability-learn svg { color: var(--state-info); }
@media (max-width: 1100px) { .spotlight-copy { padding: 26px; }.capability-verify { right: 2%; }.capability { padding: 9px; gap: 6px; }.spotlight-chip { width: 115px; height: 132px; } }
@media (max-width: 700px) { .engineering-spotlight { grid-template-columns: 1fr; }.spotlight-copy { padding: 24px; }.spotlight-visual { display: none; }.spotlight-copy h2 br { display: none; }.spotlight-selection select { flex: 1; min-width: 0; }.spotlight-selection a { flex-shrink: 0; } }
</style>
