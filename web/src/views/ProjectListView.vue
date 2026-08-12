<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../main.ts";
import { listProjects } from "../api/index.ts";
import type { Project } from "../api/types.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import StatusBadge from "../components/StatusBadge.vue";

const projects = ref<Project[]>([]);
const loading = ref(true);
const error = ref<unknown>(null);

onMounted(async () => {
  try {
    projects.value = await listProjects(api);
  } catch (err) {
    error.value = err;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <h1 class="page-title">项目列表</h1>
  <p class="page-sub">按创建时间倒序。点击项目进入门禁总览。</p>

  <ErrorNotice v-if="error" :error="error" />
  <div v-if="loading" class="muted">加载中…</div>

  <div v-else class="panel">
    <table class="data" v-if="projects.length > 0">
      <thead>
        <tr>
          <th>项目 ID</th>
          <th>名称</th>
          <th>状态</th>
          <th>数据密级</th>
          <th>创建时间</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in projects" :key="p.id">
          <td class="mono">{{ p.id }}</td>
          <td>{{ p.name }}</td>
          <td><StatusBadge :text="p.status" :kind="p.status === 'active' ? 'ok' : 'plain'" /></td>
          <td>{{ p.data_classification }}</td>
          <td class="muted">{{ new Date(p.created_at).toLocaleString("zh-CN") }}</td>
          <td>
            <router-link :to="`/projects/${p.id}`">总览</router-link>
            ·
            <router-link :to="`/projects/${p.id}/artifacts`">产物库</router-link>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-else class="muted">暂无项目。</div>
  </div>
</template>
