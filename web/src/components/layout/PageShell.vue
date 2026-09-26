<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { LogOut, Moon, Sun, ChevronRight } from "lucide-vue-next";
import { resolveTheme, toggleTheme } from "../../domain/theme.ts";
import { useAuthStore } from "../../stores/auth.ts";
import AppNavigation from "./AppNavigation.vue";
defineProps<{ section: "projects" | "evolution" }>();
const router = useRouter();
const auth = useAuthStore();
const theme = ref(resolveTheme(window.localStorage, window.matchMedia("(prefers-color-scheme: dark)")));
const mock = import.meta.env.VITE_MOCK === "1";
function switchTheme() { theme.value = toggleTheme(theme.value, window.localStorage); }
function logout() { auth.logout(); void router.push({ name: "login" }); }
</script>
<template>
  <div class="ax-page-shell">
    <a class="ax-skip" href="#main-content">跳转到主内容</a>
    <div class="ax-nav-host"><AppNavigation :section="section" /></div>
    <div class="ax-page-body">
      <header class="ax-page-topbar">
        <div class="ax-breadcrumb"><span>工作空间</span><ChevronRight :size="14" /><strong>{{ section === 'projects' ? '项目工作台' : '自进化' }}</strong></div>
        <div class="ax-page-tools"><span v-if="mock" class="ax-version">演示数据</span><span class="ax-session">已登录</span><button class="ax-icon-button" :aria-label="theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'" @click="switchTheme"><Sun v-if="theme === 'dark'" :size="18" /><Moon v-else :size="18" /></button><button class="ax-icon-button" aria-label="退出登录" @click="logout"><LogOut :size="17" /></button></div>
      </header>
      <main id="main-content" class="ax-page-content" tabindex="-1"><slot /></main>
    </div>
  </div>
</template>
<style scoped>
.ax-page-shell { display:grid; grid-template-columns:208px minmax(0,1fr); min-height:100dvh; }.ax-nav-host { position:sticky; top:0; height:100dvh; }.ax-page-body { min-width:0; }.ax-page-topbar { height:64px; display:flex; align-items:center; justify-content:space-between; padding:0 40px; gap:16px; border-bottom:1px solid var(--border-subtle); }.ax-breadcrumb { display:flex; align-items:center; gap:12px; font-size:12px; color:var(--text-muted); }.ax-breadcrumb strong { color:var(--text-primary); font-weight:500; }.ax-page-tools { display:flex; align-items:center; gap:8px; }.ax-session { font-size:11px; color:var(--text-muted); margin-right:8px; }.ax-page-content { max-width:1512px; padding:40px; margin:0 auto; }.ax-skip { position:fixed; top:-60px; left:20px; padding:12px; background:var(--surface-panel); z-index:300; }.ax-skip:focus { top:8px; }
@media(max-width:1200px) { .ax-page-content { padding:32px 24px; }.ax-page-topbar { padding:0 24px; } }
@media(max-width:900px) { .ax-page-shell { grid-template-columns:minmax(0,1fr); }.ax-nav-host { position:static; height:auto; }.ax-page-topbar { height:52px; } }
@media(max-width:600px) { .ax-page-content { padding:28px 16px; }.ax-page-topbar { padding:0 16px; }.ax-session { display:none; } }
</style>
