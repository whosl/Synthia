<script setup lang="ts">
import { computed } from "vue";
import { Gauge, Repeat2, Info } from "lucide-vue-next";
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
      <span class="efficiency-label">{{ slower ? "累计净增加耗时" : "累计净节省时间" }} <small>估算</small></span>
      <strong class="efficiency-total" data-testid="efficiency-total">{{ efficiencyDuration(efficiency?.net_saved_ms) }}</strong>
    </div>
    <div class="efficiency-comparison">
      <div class="efficiency-facts">
        <div><span><Gauge :size="13" />整体耗时倍率</span><strong>{{ efficiencySpeedup(efficiency?.speedup) }}</strong></div>
        <div><span><Repeat2 :size="13" />可比 / 成功调用</span><strong>{{ coverage }}</strong></div>
      </div>
      <p v-if="!measured" class="efficiency-empty">{{ efficiency ? `已记录 ${efficiency.primary_applications} 次主用调用；缺少可比时长时不推断为零。` : '累计统计暂不可用，请稍后刷新。' }}</p>
    </div>
    <details class="efficiency-method">
      <summary><Info :size="12" />耗时对比与统计口径</summary>
      <div v-if="measured" class="duration-comparison" aria-label="源任务与技能复用耗时对比">
        <div class="duration-row"><span>按源任务估算</span><b>{{ efficiencyDuration(efficiency!.baseline_total_ms) }}</b><div class="duration-track"><i :style="{ width: `${100 * efficiency!.baseline_total_ms! / maximum}%` }" /></div></div>
        <div class="duration-row reused"><span>技能复用实际</span><b>{{ efficiencyDuration(efficiency!.applied_total_ms) }}</b><div class="duration-track"><i :style="{ width: `${100 * efficiency!.applied_total_ms! / maximum}%` }" /></div></div>
      </div>
      <p>{{ measured ? `来自 ${efficiency!.compared_skills} 项技能、${efficiency!.compared_applications} 次可比的成功复用` : '成功调用积累后，展示相对源任务的省时估算。' }}</p>
      <p>统计范围：全部历史版本。</p>
      <p>对每次已有成功评价、且两侧时长完整的主用调用，计算“技能最初源任务的活跃时长 − 本次复用活跃时长”，再求和。更慢的调用也会扣减总省时；辅助技能不重复计数。包含已归档、已禁用技能和旧版本的历史调用。</p>
      <p>两侧都按对话事件间隔计算活跃时长，每段间隔最多计入 10 分钟。倍率为源任务估算总时长 ÷ 复用实际总时长。未成功、待评价、证据不足或时长缺失的调用不计入省时。</p>
      <p>这是相对源任务探索过程的观测估算，并非相同任务的对照实验结果，也不代表人工工时或端到端交付时间。</p>
    </details>
  </section>
</template>

<style scoped>
.efficiency-overview { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 12px 20px; margin-top: 28px; }
.efficiency-label { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; color: var(--text-secondary); font-size: 12px; }
.efficiency-label small { border: 1px solid var(--border-strong); border-radius: 4px; padding: 1px 4px; font-size: 9px; }
.efficiency-total { display: block; margin-top: 9px; color: var(--state-ok); font: 500 clamp(28px, 2.2vw, 36px)/1.3 var(--font-mono); letter-spacing: -1px; overflow-wrap: anywhere; }
.slower .efficiency-total { color: var(--state-warn); }
.efficiency-comparison { min-width: 0; }
.efficiency-facts { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.efficiency-facts span { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; color: var(--text-secondary); font-size: 12px; min-height: 18px; }
.efficiency-facts svg { flex-shrink: 0; }
.efficiency-facts strong { display: block; margin-top: 9px; font: 22px/1.5 var(--font-mono); color: var(--text-primary); overflow-wrap: anywhere; }
.duration-comparison { display: grid; gap: 10px; margin-top: 14px; }
.duration-row { display: grid; grid-template-columns: 1fr auto; gap: 6px; font-size: 12px; color: var(--text-secondary); }
.duration-row b { font-weight: 400; font-variant-numeric: tabular-nums; }
.duration-track { grid-column: 1 / -1; height: 5px; background: var(--surface-hover); border-radius: 4px; overflow: hidden; }
.duration-track i { display: block; height: 100%; border-radius: inherit; background: var(--text-muted); }
.reused .duration-track i { background: var(--state-ok); }
.slower .reused .duration-track i { background: var(--state-warn); }
.efficiency-method { grid-column: 1 / -1; font-size: 12px; color: var(--text-muted); }
.efficiency-method summary { display: flex; align-items: center; gap: 6px; width: fit-content; cursor: pointer; }
.efficiency-method summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.efficiency-method p { line-height: 1.8; }
.efficiency-empty { font-size: 12px; color: var(--text-muted); line-height: 1.8; margin: 8px 0 0; }
@media (min-width: 1401px), (max-width: 600px) {
  .efficiency-overview { grid-template-columns: 1fr; gap: 12px; margin-top: 18px; }
  .efficiency-facts { gap: 16px; }
  .efficiency-facts strong { margin-top: 4px; font-size: 20px; }
}
</style>
