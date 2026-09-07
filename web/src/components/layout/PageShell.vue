<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { resolveTheme, toggleTheme } from "../../domain/theme.ts";
import { useAuthStore } from "../../stores/auth.ts";
import Icon from "../ui/Icon.vue";
import "../../styles/portal.css";

defineProps<{ section: "projects" | "approvals" }>();
const router = useRouter();
const auth = useAuthStore();
const theme = ref(
  resolveTheme(
    window.localStorage,
    window.matchMedia("(prefers-color-scheme: dark)"),
  ),
);
const mock = import.meta.env.VITE_MOCK === "1";
function switchTheme() {
  theme.value = toggleTheme(theme.value, window.localStorage);
}
function logout() {
  auth.logout();
  void router.push({ name: "login" });
}
</script>

<template>
  <div class="portal">
    <a class="skip-link" href="#main-content">跳转到主内容</a>
    <aside class="portal-sidebar">
      <router-link class="brand" to="/projects" aria-label="Synthia 项目首页"
        ><span class="brand-mark"><Icon name="chip" :size="23" /></span
        ><span
          >Synthia<span class="brand-caption">FPGA ENGINEERING</span></span
        ></router-link
      >
      <p class="nav-caption">工作空间</p>
      <nav class="portal-nav" aria-label="主导航">
        <router-link
          to="/projects"
          :class="{ selected: section === 'projects' }"
          :aria-current="section === 'projects' ? 'page' : undefined"
          ><Icon name="grid" />项目工作台</router-link
        >
        <router-link
          to="/approvals"
          :class="{ selected: section === 'approvals' }"
          :aria-current="section === 'approvals' ? 'page' : undefined"
          ><Icon name="inbox" />审批中心</router-link
        >
      </nav>
      <div class="sidebar-note">
        <Icon name="spark" /><strong>专注工程，放心探索</strong>
        <p>用主 Agent 推进项目，让每次确认都有据可查。</p>
      </div>
      <div class="sidebar-bottom">
        <span class="session-dot" />当前会话已连接<button
          type="button"
          class="icon-button"
          aria-label="退出登录"
          title="退出登录"
          @click="logout"
        >
          <Icon name="logout" />
        </button>
      </div>
    </aside>
    <div class="portal-main">
      <header class="portal-header">
        <span class="breadcrumb"
          >工作空间 <span>/</span>
          <strong>{{
            section === "projects" ? "项目工作台" : "审批中心"
          }}</strong></span
        >
        <div class="header-actions">
          <span v-if="mock" class="demo-tag">演示数据</span
          ><button
            type="button"
            class="icon-button"
            :aria-label="theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'"
            @click="switchTheme"
          >
            <Icon :name="theme === 'dark' ? 'sun' : 'moon'" /></button
          ><button
            class="icon-button mobile-logout"
            type="button"
            aria-label="退出登录"
            @click="logout"
          >
            <Icon name="logout" />
          </button>
        </div>
      </header>
      <main id="main-content" class="portal-content" tabindex="-1">
        <slot />
      </main>
    </div>
  </div>
</template>
