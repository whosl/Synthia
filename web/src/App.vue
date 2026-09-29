<script setup lang="ts">
/**
 * 应用根组件（v4 重写）。
 *
 * - 登录页独占视口（无侧栏）；
 * - 登录后不再有全局侧栏——三栏项目页（ProjectView.vue）自己占满视口，
 *   顶栏内的项目名/任务切换/主题/用户菜单取代了旧版侧栏导航（spec §2）；
 * - 主题在此处初始化一次（domain/theme.ts:initTheme），写入 `<html data-theme>`，
 *   之后的手动切换由 ProjectView 顶栏发起，写回同一份 localStorage 记忆。
 */
import { onMounted } from "vue";
import { useRoute } from "vue-router";
import { Toaster } from "vue-sonner";
import "vue-sonner/style.css";
import { TooltipProvider } from "./components/ui/tooltip";
import { viewKey } from "./domain/navigation.ts";
import { initTheme } from "./domain/theme.ts";
import { routeLoading, routeLoadError } from "./domain/route-loading.ts";

const route = useRoute();
const isEmbedded = window.self !== window.top;
const presentationUrl = `${import.meta.env.BASE_URL}presentation/index.html`;
function reloadPage(): void { window.location.reload(); }

onMounted(() => {
  initTheme();
});
</script>

<template>
  <div v-if="routeLoading" class="route-notice" role="status">正在加载页面…</div>
  <div v-else-if="routeLoadError" class="route-notice" role="alert">{{ routeLoadError }} <button type="button" @click="reloadPage">重新加载</button></div>
  <TooltipProvider>
    <router-view :key="viewKey(route)" />
  </TooltipProvider>
  <a
    v-if="route.name !== 'login' && !isEmbedded"
    :href="presentationUrl"
    class="presentation-entry"
    aria-label="平台展示"
    title="平台展示"
  >?</a>
  <!-- 全局通知（迁移计划 §4：后续阶段把三处 setTimeout 横幅 notice 接到 toast()） -->
  <Toaster
    position="top-right"
    :toast-options="{
      style: {
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-subtle)',
        color: 'var(--text-primary)',
        fontSize: 'var(--font-size-base)',
      },
    }"
  />
</template>

<style scoped>
.presentation-entry { position: fixed; left: max(16px, env(safe-area-inset-left)); bottom: max(16px, env(safe-area-inset-bottom)); z-index: 40; display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid var(--border-subtle); border-radius: 50%; background: var(--surface-panel); color: var(--text-secondary); box-shadow: var(--shadow-low); font-size: 20px; font-weight: 600; text-decoration: none; }
.presentation-entry:hover { color: var(--text-primary); background: var(--surface-hover); }
.presentation-entry:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.route-notice { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 500; padding: 10px 18px; border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--surface-panel); color: var(--text-primary); box-shadow: 0 3px 18px #0002; font-size: 13px; }
.route-notice button { margin-left: 12px; text-decoration: underline; cursor: pointer; }
</style>
