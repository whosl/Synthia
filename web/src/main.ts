import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router.ts";
import { createClient } from "./api/client.ts";
import { readToken, clearToken } from "./stores/auth.ts";
import "./style.css";

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
