/** Project workspaces own stage reviews; old approval links remain usable. */
import { createRouter, createWebHashHistory, createWebHistory } from "vue-router";
import { readToken } from "./stores/auth.ts";
import { PLATFORM_PREVIEW } from "./api/platform.ts";
import { routeLoading, routeLoadError } from "./domain/route-loading.ts";
import ProjectsView from "./views/ProjectListView.vue";

const LoginView = () => import("./views/LoginView.vue");
const ProjectView = () => import("./views/ProjectView.vue");
const EvolutionView = () => import("./views/EvolutionView.vue");

export const router = createRouter({
  // 平台预览模式跑在动态子路径下，history 路由的根绝对跳转和刷新都会
  // 逃出预览根；hash 路由对任意托管路径免疫。常规部署保持 history 模式。
  history: PLATFORM_PREVIEW ? createWebHashHistory() : createWebHistory(),
  routes: [
    { path: "/", redirect: "/projects" },
    { path: "/login", name: "login", component: LoginView, meta: { public: true } },
    { path: "/projects", name: "projects", component: ProjectsView },
    { path: "/projects/:id", name: "project", component: ProjectView },
    { path: "/evolution", name: "evolution", component: EvolutionView },
    { path: "/approvals", redirect: "/projects" },
    {
      path: "/approvals/:projectId/:subId",
      name: "approval-detail",
      redirect: (to) => ({ path: `/projects/${to.params.projectId}`, query: { sub: String(to.params.subId) } }),
    },
    { path: "/:pathMatch(.*)*", redirect: "/projects" },
  ],
});

router.beforeEach((to) => {
  routeLoading.value = true;
  routeLoadError.value = "";
  if (to.meta.public) return true;
  if (!readToken()) {
    return { name: "login", query: to.fullPath !== "/projects" ? { redirect: to.fullPath } : {} };
  }
  return true;
});

router.afterEach(() => { routeLoading.value = false; });
router.onError(() => {
  routeLoading.value = false;
  routeLoadError.value = "页面加载失败，请检查网络后重试。";
});
