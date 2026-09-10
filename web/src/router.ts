/**
 * 路由（v4 重写）：/login、/projects、/projects/:id（三栏 ProjectView）。
 *
 * - 旧版单页对话流 UnifiedProjectView 与 demo 布局路由全部收敛掉（D1/D4）；
 * - 审批详情页已随「就地审批」（第二批 step 6）退休，旧链接改重定向到项目页的
 *   `?sub=` 深链；`/approvals` 列表页仍留着，等 step 9 的 `/inbox` 一起换掉
 *   （spec D23：跨项目待办见 §3.6/§7 R6）；
 * - 旧 view 文件不删除，只是不再被路由引用（孤儿文件，留待集成阶段清理）。
 */
import { createRouter, createWebHistory } from "vue-router";
import { readToken } from "./stores/auth.ts";

const LoginView = () => import("./views/LoginView.vue");
const ProjectsView = () => import("./views/ProjectListView.vue");
const ProjectView = () => import("./views/ProjectView.vue");
const ApprovalsView = () => import("./views/ApprovalsView.vue");
const EvolutionView = () => import("./views/EvolutionView.vue");

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/projects" },
    { path: "/login", name: "login", component: LoginView, meta: { public: true } },
    { path: "/projects", name: "projects", component: ProjectsView },
    { path: "/projects/:id", name: "project", component: ProjectView },
    { path: "/evolution", name: "evolution", component: EvolutionView },
    // 列表页第二批并入项目页顶栏可达的 /inbox（spec §3.6）；详情页已被就地审批取代。
    { path: "/approvals", name: "approvals", component: ApprovalsView },
    {
      path: "/approvals/:projectId/:subId",
      name: "approval-detail",
      redirect: (to) => ({ path: `/projects/${to.params.projectId}`, query: { sub: String(to.params.subId) } }),
    },
    { path: "/:pathMatch(.*)*", redirect: "/projects" },
  ],
});

router.beforeEach((to) => {
  if (to.meta.public) return true;
  if (!readToken()) {
    return { name: "login", query: to.fullPath !== "/projects" ? { redirect: to.fullPath } : {} };
  }
  return true;
});
