<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ArrowRight, Cpu, LoaderCircle, Sparkles } from "lucide-vue-next";
import { listProjects } from "../api/index.ts";
import { ApiError, createClient } from "../api/client.ts";
import { useAuthStore } from "../stores/auth.ts";
import { loginDestination } from "../domain/navigation.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
  <main class="grid min-h-dvh grid-cols-1 min-[801px]:grid-cols-[1.05fr_1fr]">
    <section
      class="flex flex-col border-line bg-panel px-6 py-6 max-[800px]:border-b min-[801px]:border-r min-[801px]:px-16 min-[801px]:pt-12 min-[801px]:pb-9"
      aria-labelledby="story-title"
    >
      <router-link
        to="/projects"
        class="flex items-center gap-2.5 text-[23px] font-[650] tracking-[-0.8px] text-fg hover:text-fg"
      >
        <span
          class="grid h-[42px] w-[38px] place-items-center rounded-xl border border-brand bg-brand-subtle text-brand"
          ><Cpu :size="24" /></span
        ><span
          >Synthia<span
            class="mt-[3px] block text-[8px] font-[550] tracking-[1.1px] text-fg-muted"
            >FPGA ENGINEERING</span
          ></span
        ></router-link
      >
      <div class="my-auto hidden py-16 min-[801px]:block">
        <p class="mb-2.5 text-[10px] font-semibold tracking-[2px] text-brand">
          IDEAS INTO ENGINEERING
        </p>
        <h1
          id="story-title"
          class="my-6 text-[clamp(36px,4vw,58px)] leading-[1.45] font-[550] tracking-[-2px]"
        >
          让想法成形。<br /><span class="text-brand">让工程有据。</span>
        </h1>
        <p class="text-[15px] leading-8 text-fg-secondary">
          与 AI 一起探索、构建和验证。<br />从第一行需求，到可追溯的正式交付。
        </p>
        <div
          class="mt-12 flex border-t border-line pt-6"
          aria-label="需求、设计、实现、交付"
        >
          <span
            v-for="(step, index) in ['需求', '设计', '实现', '交付']"
            :key="step"
            class="grid flex-1 gap-2 text-xs text-fg-secondary"
            ><i class="font-mono text-[10px] not-italic text-brand">{{
              String(index + 1).padStart(2, "0")
            }}</i
            >{{ step }}</span
          >
        </div>
      </div>
      <span class="hidden text-[11px] text-fg-muted min-[801px]:block"
        >一个工作空间，两种工作方式。</span
      >
    </section>
    <section
      class="grid place-items-center px-6 py-12 min-[801px]:p-10"
      aria-labelledby="login-title"
    >
      <form class="grid w-full max-w-[360px] gap-5" @submit.prevent="submit">
        <span
          class="mb-3 grid h-[52px] w-[52px] place-items-center rounded-2xl bg-brand-subtle text-brand"
          ><Sparkles :size="28"
        /></span>
        <p class="text-[10px] font-semibold tracking-[2px] text-brand">
          WELCOME TO SYNTHIA
        </p>
        <h2 id="login-title" class="-mt-2.5 text-3xl font-[550] tracking-[-1px]">
          继续你的工程
        </h2>
        <p class="leading-[1.7] text-fg-secondary">
          使用访问 Token 连接你的工作空间。
        </p>
        <p v-if="route.query.expired" class="leading-[1.6] text-warn" role="status">
          会话已失效。重新登录后将回到刚才的页面。
        </p>
        <ErrorNotice v-if="error" :error="error" />
        <div class="mt-3 grid gap-2">
          <Label for="login-token" class="text-xs">访问 Token</Label>
          <Input
            id="login-token"
            v-model="token"
            type="password"
            autocomplete="off"
            required
            :disabled="pending"
            placeholder="粘贴平台签发的 Token"
            class="h-11"
          />
        </div>
        <Button
          type="submit"
          :disabled="!token.trim() || pending"
          class="h-11 w-full justify-between px-4"
        >
          {{ pending ? "正在验证…" : "进入工作空间" }}
          <LoaderCircle v-if="pending" :size="16" class="animate-spin" />
          <ArrowRight v-else :size="16" />
        </Button>
        <p class="pt-1 text-[11px] leading-[1.9] text-fg-muted">
          Token 仅保存在当前标签页会话中。<br />如需开通访问，请联系你的平台管理员。
        </p>
      </form>
    </section>
  </main>
</template>
