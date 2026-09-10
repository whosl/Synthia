import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router.ts";
import { readToken } from "./stores/auth.ts";
import "./util/uuid-shim.ts";
import "./style.css";
import "./tailwind.css";

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
app.mount("#app");
