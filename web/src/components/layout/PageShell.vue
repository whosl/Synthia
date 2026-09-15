<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import {
  Cpu,
  Inbox,
  LayoutGrid,
  LogOut,
  Moon,
  Sparkles,
  Sprout,
  Sun,
} from "lucide-vue-next";
import { resolveTheme, toggleTheme } from "../../domain/theme.ts";
import { useAuthStore } from "../../stores/auth.ts";
import { SELF_EVOLUTION_FEATURE_ENABLED } from "../../domain/feature-flags.ts";

defineProps<{ section: "projects" | "approvals" | "evolution" }>();
const router = useRouter();
const auth = useAuthStore();
const theme = ref(
  resolveTheme(
    window.localStorage,
    window.matchMedia("(prefers-color-scheme: dark)"),
  ),
);
const mock = import.meta.env.VITE_MOCK === "1";

// 门户共享的导航/图标按钮样式（原 portal.css 的 .portal-nav a 与 .icon-button）
const navLinkClass =
  "flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors max-[600px]:gap-1.5 max-[600px]:px-[7px] max-[600px]:py-2 max-[600px]:text-[11px]";
const navIdleClass = "text-fg-secondary hover:bg-hover hover:text-fg";
const navSelectedClass =
  "bg-brand-subtle font-semibold text-brand shadow-[inset_2px_0_0_var(--accent)] hover:bg-brand-subtle hover:text-brand";
const iconButtonClass =
  "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-0 bg-transparent text-fg-secondary hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

function switchTheme() {
  theme.value = toggleTheme(theme.value, window.localStorage);
}
function logout() {
  auth.logout();
  void router.push({ name: "login" });
}
</script>

<template>
  <div
    class="grid min-h-dvh grid-cols-[216px_minmax(0,1fr)] max-[1200px]:grid-cols-[188px_minmax(0,1fr)] max-[900px]:grid-cols-1"
  >
    <a
      class="fixed -top-[60px] left-4 z-[300] rounded-[8px] bg-panel p-3 text-brand focus:top-2"
      href="#main-content"
      >跳转到主内容</a
    >
    <aside
      class="sticky top-0 flex h-dvh flex-col border-r border-line bg-panel px-5 pt-8 pb-5 max-[900px]:static max-[900px]:h-auto max-[900px]:flex-row max-[900px]:flex-wrap max-[900px]:items-center max-[900px]:gap-5 max-[900px]:border-r-0 max-[900px]:border-b max-[900px]:px-6 max-[900px]:py-4 max-[600px]:gap-2.5 max-[600px]:px-4 max-[600px]:py-3.5"
    >
      <router-link
        class="flex items-center gap-2.5 text-[23px] font-[650] tracking-[-0.8px] text-fg hover:text-fg max-[600px]:text-[21px]"
        to="/projects"
        aria-label="Synthia 项目首页"
        ><span
          class="grid h-[42px] w-[38px] place-items-center rounded-[12px] border border-brand bg-brand-subtle text-brand"
          ><Cpu :size="23" /></span
        ><span
          >Synthia<span
            class="mt-[3px] block text-[8px] font-[550] tracking-[1.1px] text-fg-muted max-[600px]:text-[7px]"
            >FPGA ENGINEERING</span
          ></span
        ></router-link
      >
      <p
        class="mx-3 mt-12 mb-3 text-[11px] tracking-[1px] text-fg-muted max-[900px]:hidden"
      >
        工作空间
      </p>
      <nav class="grid gap-1 max-[900px]:ml-auto max-[900px]:flex" aria-label="主导航">
        <router-link
          to="/projects"
          :class="[
            navLinkClass,
            section === 'projects' ? navSelectedClass : navIdleClass,
          ]"
          :aria-current="section === 'projects' ? 'page' : undefined"
          ><LayoutGrid :size="16" />项目工作台</router-link
        >
        <router-link
          to="/approvals"
          :class="[
            navLinkClass,
            section === 'approvals' ? navSelectedClass : navIdleClass,
          ]"
          :aria-current="section === 'approvals' ? 'page' : undefined"
          ><Inbox :size="16" />审批中心</router-link
        >
        <router-link
          v-if="SELF_EVOLUTION_FEATURE_ENABLED"
          to="/evolution"
          :class="[
            navLinkClass,
            section === 'evolution' ? navSelectedClass : navIdleClass,
          ]"
          :aria-current="section === 'evolution' ? 'page' : undefined"
          ><Sprout :size="16" />自进化</router-link
        >
      </nav>
      <div
        class="mt-auto px-3 py-[18px] text-fg-secondary max-[900px]:hidden"
      >
        <Sparkles :size="18" class="mb-2.5 text-brand" /><strong
          class="block text-xs font-medium"
          >专注工程，放心探索</strong
        >
        <p class="my-2 text-[11px] leading-[1.8] text-fg-muted">
          用主 Agent 推进项目，让每次确认都有据可查。
        </p>
      </div>
      <div
        class="mt-3 flex items-center gap-[7px] border-t border-line pt-3.5 text-[11px] text-fg-secondary max-[900px]:hidden"
      >
        <span
          class="size-1.5 shrink-0 rounded-full bg-ok shadow-[0_0_0_3px_color-mix(in_srgb,var(--state-ok)_10%,transparent)]"
        />当前会话已连接<button
          type="button"
          :class="[iconButtonClass, 'ml-auto']"
          aria-label="退出登录"
          title="退出登录"
          @click="logout"
        >
          <LogOut :size="18" />
        </button>
      </div>
    </aside>
    <div class="min-w-0">
      <header
        class="flex h-[72px] items-center justify-between border-b border-line px-10 max-[1200px]:px-7 max-[900px]:h-[54px] max-[600px]:px-[18px]"
      >
        <span
          class="flex items-center gap-3.5 text-xs text-fg-muted max-[600px]:gap-2 max-[600px]:text-[11px]"
          >工作空间 <span>/</span>
          <strong class="font-medium text-fg-secondary">{{
            section === "projects"
              ? "项目工作台"
              : section === "evolution"
                ? "自进化"
                : "审批中心"
          }}</strong></span
        >
        <div class="flex items-center gap-4 max-[600px]:gap-2">
          <span
            v-if="mock"
            class="rounded-[5px] border border-line-strong px-[7px] py-[3px] text-[10px] text-fg-secondary"
            >演示数据</span
          ><button
            type="button"
            :class="iconButtonClass"
            :aria-label="theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'"
            @click="switchTheme"
          >
            <Sun v-if="theme === 'dark'" :size="18" /><Moon v-else :size="18" /></button
          ><button
            class="hidden size-8 shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-0 bg-transparent text-fg-secondary hover:bg-hover hover:text-fg max-[900px]:inline-flex"
            type="button"
            aria-label="退出登录"
            @click="logout"
          >
            <LogOut :size="18" />
          </button>
        </div>
      </header>
      <main
        id="main-content"
        class="mx-auto max-w-[1392px] px-10 pt-11 pb-8 max-[1200px]:px-7 max-[1200px]:py-8 max-[900px]:px-6 max-[900px]:py-7 max-[600px]:px-4"
        tabindex="-1"
      >
        <slot />
      </main>
    </div>
  </div>
</template>
