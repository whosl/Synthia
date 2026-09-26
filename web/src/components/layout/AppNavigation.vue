<script setup lang="ts">
import { Boxes, Cpu, FolderKanban, Sprout, ArrowUpRight } from "lucide-vue-next";
import { SELF_EVOLUTION_FEATURE_ENABLED } from "../../domain/feature-flags.ts";
defineProps<{ section: "projects" | "evolution" | "workspace"; compact?: boolean }>();
</script>
<template>
  <aside class="ax-navigation" :class="{ compact }">
    <router-link class="ax-brand" to="/projects" aria-label="Synthia 项目首页" title="Synthia 项目首页">
      <span class="ax-brand-mark"><Boxes :size="22" :stroke-width="1.6" /></span>
      <span class="ax-brand-word">synthia<span>工程协作空间</span></span>
    </router-link>
    <div class="ax-nav-workspace"><Cpu :size="16" /><span>FPGA Engineering</span></div>
    <span class="ax-nav-label">工作空间</span>
    <nav aria-label="主导航">
      <router-link to="/projects" :class="{ selected: section !== 'evolution' }" :aria-current="section !== 'evolution' ? 'page' : undefined" title="项目工作台"><FolderKanban :size="19" /><span>项目工作台</span></router-link>
      <router-link v-if="SELF_EVOLUTION_FEATURE_ENABLED" to="/evolution" :class="{ selected: section === 'evolution' }" :aria-current="section === 'evolution' ? 'page' : undefined" title="自进化"><Sprout :size="19" /><span>自进化</span></router-link>
    </nav>
    <div class="ax-nav-footer"><span class="ax-nav-caption">从想法到验证<br />每一步，都有迹可循。</span><span class="ax-version">v-astrys <ArrowUpRight :size="11" /></span></div>
  </aside>
</template>
<style scoped>
.ax-navigation { display:flex; flex:none; flex-direction:column; width:208px; height:100%; min-height:0; padding:28px 16px 20px; border-right:1px solid var(--border-subtle); background:var(--surface-base); }
.ax-brand { display:flex; align-items:center; gap:12px; color:var(--text-primary); text-decoration:none; padding:0 8px; }
.ax-brand-mark { width:36px; height:36px; display:grid; place-items:center; border-radius:12px; background:var(--text-primary); color:var(--surface-panel); flex:none; }
.ax-brand-word { font-size:25px; line-height:28px; font-weight:600; letter-spacing:-1px; }.ax-brand-word > span { display:block; font-size:10px; line-height:20px; letter-spacing:1px; font-weight:400; color:var(--text-muted); }
.ax-nav-workspace { display:flex; gap:8px; align-items:center; margin:32px 4px; padding:12px 8px; border-block:1px solid var(--border-subtle); font-size:11px; color:var(--text-secondary); }
.ax-nav-label { font-size:11px; color:var(--text-muted); padding:0 12px; margin-bottom:12px; }
nav { display:grid; gap:8px; }nav a { display:flex; align-items:center; gap:12px; padding:12px; min-height:44px; border-radius:8px; color:var(--text-secondary); font-size:13px; text-decoration:none; transition:background var(--duration); }nav a:hover { background:var(--surface-hover); color:var(--text-primary); }nav a.selected { background:var(--surface-panel); color:var(--text-primary); font-weight:600; box-shadow:var(--shadow-low); }nav a.selected svg { color:var(--accent); }
.ax-nav-footer { margin-top:auto; padding:20px 12px 0; display:grid; justify-items:start; gap:20px; }.ax-nav-caption { font-size:12px; line-height:1.8; color:var(--text-muted); }.ax-version { gap:6px; }
.compact { width:64px; padding:16px 8px; }.compact .ax-brand { padding:0; justify-content:center; }.compact .ax-brand-word,.compact .ax-nav-label,.compact .ax-nav-workspace,.compact .ax-nav-caption,.compact .ax-nav-footer { display:none; }.compact nav { margin-top:28px; }.compact nav a { justify-content:center; padding:12px; }.compact nav a span { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
@media(max-width:900px) { .ax-navigation:not(.compact) { width:100%; height:auto; flex-direction:row; align-items:center; padding:12px 20px; border-right:0; border-bottom:1px solid var(--border-subtle); gap:20px; }.ax-navigation:not(.compact) .ax-nav-workspace,.ax-navigation:not(.compact) .ax-nav-label,.ax-navigation:not(.compact) .ax-nav-footer { display:none; }.ax-navigation:not(.compact) nav { display:flex; margin-left:auto; }.ax-navigation:not(.compact) .ax-brand-word > span { display:none; } }
@media(max-width:600px) { .ax-navigation:not(.compact) { padding:12px; gap:8px; }.ax-brand-word { font-size:21px; }nav a { gap:6px; font-size:12px; padding:10px 8px; }.ax-brand { gap:8px; padding:0; }.compact { display:none; } }
</style>
