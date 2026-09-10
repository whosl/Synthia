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
import { viewKey } from "./domain/navigation.ts";
import { initTheme } from "./domain/theme.ts";

const route = useRoute();

onMounted(() => {
  initTheme();
});
</script>

<template>
  <router-view :key="viewKey(route)" />
</template>
