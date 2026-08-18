import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router.ts";
import { createClient } from "./api/client.ts";
import { readToken, clearToken } from "./stores/auth.ts";
import "./style.css";

// 离线 mock（`VITE_MOCK=1`）：接管 /api/v1/**，并预置一个假 token 让路由守卫放行。
// 必须在 createClient 之前装好——client 捕获的是当时的 globalThis.fetch。
if (import.meta.env.VITE_MOCK === "1") {
  const { installMockServer } = await import("./mock/server.ts");
  installMockServer();
  if (!readToken()) sessionStorage.setItem("synthia.token", "mock-token");
}

/** 全局 API client：token 来自 sessionStorage；401 清 token 跳登录。 */
export const api = createClient({
  tokenProvider: readToken,
  onUnauthorized: () => {
    clearToken();
    if (router.currentRoute.value.name !== "login") {
      void router.push({ name: "login", query: { expired: "1" } });
    }
  },
});

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount("#app");
