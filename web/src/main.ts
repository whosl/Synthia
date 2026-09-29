import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router.ts";
import { readToken } from "./stores/auth.ts";
import "./util/uuid-shim.ts";
import "./style.css";
import "./styles/markdown.css";
import "./tailwind.css";
import "./styles/v-astrys.css";

// 离线 mock（`VITE_MOCK=1`）：接管 /api/v1/**，并预置一个假 token 让路由守卫放行。
// 在挂载应用前安装；共享 client 在请求时读取 fetch，SSE 也走同一拦截器。
if (import.meta.env.VITE_MOCK === "1") {
  const { installMockServer } = await import("./mock/server.ts");
  installMockServer();
  if (!readToken()) sessionStorage.setItem("synthia.token", "mock-token");
}

const app = createApp(App);
app.use(createPinia());
app.use(router);
// Keep the HTML skeleton visible until the initial route chunk is ready.
void router.isReady().then(() => {
  app.mount("#app");
}).catch(() => {
  const message = document.getElementById("boot-message");
  if (message) message.textContent = "页面加载失败，请检查网络后刷新重试。";
  const retry = document.getElementById("boot-retry");
  if (retry) retry.hidden = false;
});
