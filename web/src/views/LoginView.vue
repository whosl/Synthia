<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../main.ts";
import { listProjects } from "../api/index.ts";
import { useAuthStore } from "../stores/auth.ts";
import ErrorNotice from "../components/ErrorNotice.vue";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const token = ref("");
const pending = ref(false);
const error = ref<unknown>(null);

async function submit() {
  const value = token.value.trim();
  if (!value) {
    error.value = new Error("请输入访问 Token");
    return;
  }
  pending.value = true;
  error.value = null;
  try {
    // 先写入临时 Token 验证有效性：GET /api/v1/projects
    auth.login(value);
    await listProjects(api);
    const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/projects";
    await router.push(redirect);
  } catch (err) {
    auth.logout();
    error.value = err;
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="login-card">
    <h1>Synthia 工程治理平台</h1>
    <p class="sub">UI-1 · 登录 / 门禁总览 / 审批中心 / 产物库</p>

    <div v-if="route.query.expired" class="notice">登录已失效，请重新输入 Token。</div>
    <ErrorNotice v-if="error" :error="error" />

    <form @submit.prevent="submit">
      <label class="field">
        <span>访问 Token（Bearer）</span>
        <input v-model="token" type="password" autocomplete="off" placeholder="粘贴平台签发的 Token" />
      </label>
      <button class="btn" type="submit" :disabled="pending" style="width: 100%">
        {{ pending ? "验证中…" : "登录" }}
      </button>
    </form>
    <p class="muted" style="margin-top: 16px; font-size: 12px">
      Token 仅保存在当前会话（sessionStorage），关闭浏览器标签即失效。
    </p>
  </div>
</template>
