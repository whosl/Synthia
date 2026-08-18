/**
 * 路由（v4 重写）：/login、/projects、/projects/:id（三栏 ProjectView）。
 *
 * - 旧版单页对话流 UnifiedProjectView 与 demo 布局路由全部收敛掉（D1/D4）；
 * - `/approvals` 第一批仍指向旧审批中心页面（spec D23：跨项目待办 `/inbox` 是
 *   第二批范围，见 spec §3.6/§7 R6），不在本批次改动；
 * - 旧 view 文件不删除，只是不再被路由引用（孤儿文件，留待集成阶段清理）。
 */
import { createRouter, createWebHistory } from "vue-router";
import { readToken } from "./stores/auth.ts";

const LoginView = () => import("./views/LoginView.vue");
const ProjectsView = () => import("./views/ProjectListView.vue");
const ProjectView = () => import("./views/ProjectView.vue");
const ApprovalsView = () => import("./views/ApprovalsView.vue");
const ApprovalDetailView = () => import("./views/ApprovalDetailView.vue");

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/projects" },
    { path: "/login", name: "login", component: LoginView, meta: { public: true } },
    { path: "/projects", name: "projects", component: ProjectsView },
    { path: "/projects/:id", name: "project", component: ProjectView },
    // 第一批仍指向旧审批中心（含其详情页）；第二批并入项目页顶栏可达的 /inbox（spec §3.6）。
    { path: "/approvals", name: "approvals", component: ApprovalsView },
    { path: "/approvals/:projectId/:subId", name: "approval-detail", component: ApprovalDetailView },
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
