<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { listProjects } from "../api/index.ts";
import { ApiError, createClient } from "../api/client.ts";
import { useAuthStore } from "../stores/auth.ts";
import { loginDestination } from "../domain/navigation.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import Button from "../components/ui/Button.vue";
import Icon from "../components/ui/Icon.vue";
import "../styles/portal.css";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const token = ref("");
const pending = ref(false);
const error = ref<unknown>(null);

async function submit() {
  if (pending.value) return;
  const value = token.value.trim();
  if (!value) {
    error.value = new Error("请输入访问 Token");
    return;
  }
  pending.value = true;
  error.value = null;
  try {
    await listProjects(createClient({ tokenProvider: () => value }));
    auth.login(value);
    await router.replace(loginDestination(route.query.redirect));
  } catch (cause) {
    error.value =
      cause instanceof ApiError && cause.status === 401
        ? new Error("Token 无效或已过期，请核对后重试")
        : cause;
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-story" aria-labelledby="story-title">
      <router-link class="brand" to="/projects"
        ><span class="brand-mark"><Icon name="chip" :size="24" /></span
        ><span
          >Synthia<span class="brand-caption">FPGA ENGINEERING</span></span
        ></router-link
      >
      <div class="story-body">
        <p class="eyebrow">IDEAS INTO ENGINEERING</p>
        <h1 id="story-title">让想法成形。<br /><span>让工程有据。</span></h1>
        <p>
          与 AI 一起探索、构建和验证。<br />从第一行需求，到可追溯的正式交付。
        </p>
        <div class="flow-visual" aria-label="需求、设计、实现、交付">
          <span
            v-for="(step, index) in ['需求', '设计', '实现', '交付']"
            :key="step"
            ><i>{{ String(index + 1).padStart(2, "0") }}</i
            >{{ step }}</span
          >
        </div>
      </div>
      <span class="login-footnote">一个工作空间，两种工作方式。</span>
    </section>
    <section class="login-access" aria-labelledby="login-title">
      <form class="login-form" @submit.prevent="submit">
        <span class="login-emblem"><Icon name="spark" :size="28" /></span>
        <p class="eyebrow">WELCOME TO SYNTHIA</p>
        <h2 id="login-title">继续你的工程</h2>
        <p class="secondary-text">使用访问 Token 连接你的工作空间。</p>
        <p v-if="route.query.expired" class="form-warning" role="status">
          会话已失效。重新登录后将回到刚才的页面。
        </p>
        <ErrorNotice v-if="error" :error="error" /><label class="form-field"
          ><span>访问 Token</span
          ><input
            v-model="token"
            type="password"
            autocomplete="off"
            required
            :disabled="pending"
            placeholder="粘贴平台签发的 Token" /></label
        ><Button
          type="submit"
          variant="primary"
          :disabled="!token.trim()"
          :loading="pending"
          >{{ pending ? "正在验证…" : "进入工作空间"
          }}<Icon name="arrow" :size="16"
        /></Button>
        <p class="login-note">
          Token 仅保存在当前标签页会话中。<br />如需开通访问，请联系你的平台管理员。
        </p>
      </form>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  min-height: 100dvh;
  display: grid;
  grid-template-columns: 1.05fr 1fr;
}
.login-story {
  padding: 48px 64px 36px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-subtle);
  background: var(--surface-panel);
}
.story-body {
  margin: auto 0;
  padding: 64px 0;
}
.story-body h1 {
  font-size: clamp(36px, 4vw, 58px);
  font-weight: 550;
  letter-spacing: -2px;
  line-height: 1.45;
  margin: 24px 0;
}
.story-body h1 span {
  color: var(--accent);
}
.story-body > p:not(.eyebrow) {
  color: var(--text-secondary);
  font-size: 15px;
  line-height: 2;
}
.flow-visual {
  display: flex;
  margin-top: 48px;
  padding-top: 24px;
  border-top: 1px solid var(--border-subtle);
}
.flow-visual span {
  flex: 1;
  display: grid;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}
.flow-visual i {
  font-family: var(--font-mono);
  color: var(--accent);
  font-size: 10px;
  font-style: normal;
}
.login-footnote {
  font-size: 11px;
  color: var(--text-muted);
}
.login-access {
  display: grid;
  place-items: center;
  padding: 40px;
}
.login-form {
  width: min(100%, 360px);
  display: grid;
  gap: 20px;
}
.login-emblem {
  width: 52px;
  height: 52px;
  border-radius: 16px;
  color: var(--accent);
  display: grid;
  place-items: center;
  background: var(--accent-subtle);
  margin-bottom: 12px;
}
.login-form h2 {
  margin: -10px 0 0;
  font-size: 30px;
  font-weight: 550;
  letter-spacing: -1px;
}
.login-form p {
  margin: 0;
}
.login-form .form-field {
  margin-top: 12px;
}
.login-form :deep(.ui-button) {
  height: 44px;
  justify-content: space-between;
  padding: 0 16px;
}
.login-note {
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.9;
  padding-top: 4px;
}
@media (max-width: 800px) {
  .login-page {
    grid-template-columns: 1fr;
  }
  .login-story {
    padding: 24px;
    border-right: 0;
    border-bottom: 1px solid var(--border-subtle);
  }
  .story-body,
  .login-footnote {
    display: none;
  }
  .login-access {
    padding: 48px 24px;
  }
}
</style>
