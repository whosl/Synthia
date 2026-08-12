<script setup lang="ts">
import { computed } from "vue";
import { ApiError, NetworkError } from "../api/client.ts";

/**
 * 统一错误提示：403 显示「无权限」；其余显示服务端 message + correlation_id。
 */
const props = defineProps<{ error: unknown }>();

const forbidden = computed(() => props.error instanceof ApiError && props.error.status === 403);
const message = computed(() => {
  const err = props.error;
  if (err instanceof ApiError) {
    if (err.status === 403) return "无权限执行此操作（当前 Token 缺少所需 scope 或项目角色）。";
    if (err.status === 401) return "登录已失效，请重新登录。";
    return `${err.message}（${err.code}${err.correlationId ? `，关联号 ${err.correlationId}` : ""}）`;
  }
  if (err instanceof NetworkError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
});
</script>

<template>
  <div class="notice" :class="forbidden ? 'forbidden' : 'error'" role="alert">{{ message }}</div>
</template>
