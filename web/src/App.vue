<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useAuthStore } from "./stores/auth.ts";

const route = useRoute();
const auth = useAuthStore();

const isLogin = computed(() => route.name === "login");
const projectId = computed(() => (route.name === "project-overview" || route.name === "project-artifacts" ? String(route.params.id) : null));
</script>

<template>
  <div v-if="isLogin" class="login-wrap">
    <router-view />
  </div>

  <div v-else class="layout">
    <aside class="sidebar">
      <div class="brand">
        Synthia
        <small>工程治理平台 · UI-1</small>
      </div>
      <nav>
        <router-link to="/projects" :class="{ active: route.name === 'projects' }">项目列表</router-link>
        <router-link v-if="projectId" :to="`/projects/${projectId}`" :class="{ active: route.name === 'project-overview' }">
          项目总览
        </router-link>
        <router-link v-if="projectId" :to="`/projects/${projectId}/artifacts`" :class="{ active: route.name === 'project-artifacts' }">
          产物库
        </router-link>
        <router-link to="/approvals" :class="{ active: route.name === 'approvals' || route.name === 'approval-detail' }">
          审批中心
        </router-link>
      </nav>
      <div class="session">
        <div class="muted" style="color: var(--c-sidebar-fg)">已登录（会话 Token）</div>
        <a href="#" style="color: var(--c-sidebar-fg)" @click.prevent="auth.logout(); $router.push({ name: 'login' })">退出登录</a>
      </div>
    </aside>
    <main class="main">
      <router-view />
    </main>
  </div>
</template>
