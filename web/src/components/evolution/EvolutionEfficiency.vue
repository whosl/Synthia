<script setup lang="ts">
import { computed } from "vue";
import { Clock3, Gauge, Repeat2, Info } from "lucide-vue-next";
import type { EvolutionEfficiencyV1 } from "../../api/evolution.ts";
import { efficiencyDuration, efficiencySpeedup } from "../../domain/evolution-display.ts";

const props = defineProps<{ efficiency: EvolutionEfficiencyV1 | null | undefined }>();
const measured = computed(() => props.efficiency?.measurement_state === "observed");
const slower = computed(() => (props.efficiency?.net_saved_ms ?? 0) < 0);
const maximum = computed(() => Math.max(props.efficiency?.baseline_total_ms ?? 0, props.efficiency?.applied_total_ms ?? 0, 1));
const coverage = computed(() => props.efficiency ? `${props.efficiency.compared_applications} / ${props.efficiency.successful_applications}` : "—");
</script>

<template>
  <section class="efficiency-overview" :class="{ slower }" aria-label="自进化累计提效">
    <div class="efficiency-primary">
      <p class="efficiency-eyebrow"><Clock3 :size="14" />经验复用，节省了多少时间</p>
      <span class="efficiency-label">{{ slower ? "累计净增加耗时" : "累计净节省时间" }} <small>估算</small></span>
      <strong class="efficiency-total" data-testid="efficiency-total">{{ efficiencyDuration(efficiency?.net_saved_ms) }}</strong>
      <p>{{ measured ? `来自 ${efficiency!.compared_skills} 项技能、${efficiency!.compared_applications} 次可比的成功复用` : '成功调用积累后，展示相对源任务的省时估算。' }}</p>
    </div>
    <div class="efficiency-comparison">
      <div class="efficiency-facts">
        <div><span><Gauge :size="13" />整体耗时倍率</span><strong>{{ efficiencySpeedup(efficiency?.speedup) }}</strong></div>
        <div><span><Repeat2 :size="13" />可比 / 成功调用</span><strong>{{ coverage }}</strong></div>
      </div>
      <div v-if="measured" class="duration-comparison" aria-label="源任务与技能复用耗时对比">
        <div class="duration-row"><span>按源任务估算</span><b>{{ efficiencyDuration(efficiency!.baseline_total_ms) }}</b><div class="duration-track"><i :style="{ width: `${100 * efficiency!.baseline_total_ms! / maximum}%` }" /></div></div>
        <div class="duration-row reused"><span>技能复用实际</span><b>{{ efficiencyDuration(efficiency!.applied_total_ms) }}</b><div class="duration-track"><i :style="{ width: `${100 * efficiency!.applied_total_ms! / maximum}%` }" /></div></div>
      </div>
      <p v-else class="efficiency-empty">{{ efficiency ? `已记录 ${efficiency.primary_applications} 次主用调用；缺少可比时长时不推断为零。` : '累计统计暂不可用，请稍后刷新。' }}</p>
    </div>
    <details class="efficiency-method">
      <summary><Info :size="12" />统计口径 · 全部历史版本</summary>
      <p>对每次已有成功评价、且两侧时长完整的主用调用，计算“技能最初源任务的活跃时长 − 本次复用活跃时长”，再求和。更慢的调用也会扣减总省时；辅助技能不重复计数。包含已归档、已禁用技能和旧版本的历史调用。</p>
      <p>两侧都按对话事件间隔计算活跃时长，每段间隔最多计入 10 分钟。倍率为源任务估算总时长 ÷ 复用实际总时长。未成功、待评价、证据不足或时长缺失的调用不计入省时。</p>
      <p>这是相对源任务探索过程的观测估算，并非相同任务的对照实验结果，也不代表人工工时或端到端交付时间。</p>
    </details>
  </section>
</template>

<style scoped>
.efficiency-overview { display: grid; grid-template-columns: 1fr 1fr; gap: 20px 36px; margin-bottom: 16px; padding: 26px 30px 14px; border: 1px solid var(--border-subtle); border-radius: 12px; background: radial-gradient(ellipse at 5% 0%, color-mix(in srgb, var(--state-ok) 9%, transparent), transparent 60%), var(--surface-panel); }
.efficiency-eyebrow { display: flex; align-items: center; gap: 7px; margin: 0 0 18px; color: var(--text-secondary); font-size: 11px; }
.efficiency-label { display: flex; align-items: center; gap: 8px; color: var(--text-secondary); font-size: 12px; }
.efficiency-label small { border: 1px solid var(--border-strong); border-radius: 4px; padding: 2px 5px; font-size: 9px; }
.efficiency-total { display: block; margin: 12px 0; color: var(--state-ok); font: 500 clamp(26px, 3vw, 40px)/1.25 var(--font-mono); letter-spacing: -1px; overflow-wrap: anywhere; }
.slower .efficiency-total { color: var(--state-warn); }
.efficiency-primary > p:last-child { font-size: 11px; color: var(--text-muted); line-height: 1.7; margin: 0; }
.efficiency-comparison { min-width: 0; }
.efficiency-facts { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 22px; }
.efficiency-facts span { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 11px; }
.efficiency-facts strong { display: block; margin-top: 9px; font: 25px var(--font-mono); color: var(--text-primary); }
.duration-comparison { display: grid; gap: 12px; }
.duration-row { display: grid; grid-template-columns: 1fr auto; gap: 7px; font-size: 10px; color: var(--text-secondary); }
.duration-row b { font-weight: 400; font-variant-numeric: tabular-nums; }
.duration-track { grid-column: 1 / -1; height: 7px; background: var(--surface-hover); border-radius: 4px; overflow: hidden; }
.duration-track i { display: block; height: 100%; border-radius: inherit; background: var(--text-muted); }
.reused .duration-track i { background: var(--state-ok); }
.slower .reused .duration-track i { background: var(--state-warn); }
.efficiency-method { grid-column: 1 / -1; border-top: 1px solid var(--border-subtle); padding-top: 12px; font-size: 10px; color: var(--text-muted); }
.efficiency-method summary { display: flex; align-items: center; gap: 6px; width: fit-content; cursor: pointer; }
.efficiency-method summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.efficiency-method p { max-width: 960px; line-height: 1.8; }
.efficiency-empty { font-size: 12px; color: var(--text-muted); line-height: 1.8; }
@media (max-width: 1100px) { .efficiency-overview { grid-template-columns: 1fr; padding: 22px; gap: 22px; }.efficiency-total { font-size: 34px; } }
@media (max-width: 560px) { .efficiency-overview { padding: 20px 18px 14px; }.efficiency-total { font-size: 28px; }.efficiency-facts { gap: 12px; }.efficiency-facts span { font-size: 10px; } }
</style>
