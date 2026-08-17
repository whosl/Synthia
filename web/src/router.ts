import type { RouteRecordRaw } from "vue-router";
import { createRouter, createWebHistory } from "vue-router";
import { readToken } from "./stores/auth.ts";
import { LEGACY_ROUTES, unifiedRedirectTarget } from "./domain/unified.ts";

const LoginView = () => import("./views/LoginView.vue");
const ProjectListView = () => import("./views/ProjectListView.vue");
const UnifiedProjectView = () => import("./views/UnifiedProjectView.vue");
const ApprovalsView = () => import("./views/ApprovalsView.vue");
const ApprovalDetailView = () => import("./views/ApprovalDetailView.vue");
const legacyRedirects: RouteRecordRaw[] = LEGACY_ROUTES.map((rule) => ({
  path: rule.path,
  redirect: (to) => {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(to.params)) {
      params[key] = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
    }
    const query: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(to.query)) {
      query[key] = Array.isArray(value) ? (value[0] ?? undefined) : (value ?? undefined);
    }
    return unifiedRedirectTarget(rule, params, query);
  },
}));

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/projects" },
    { path: "/login", name: "login", component: LoginView, meta: { public: true } },
    { path: "/projects", name: "projects", component: ProjectListView },
    // 统一项目页（UI-3 方案 B+就地审批）：总览/工作台/审批/记录收敛为单页
    { path: "/projects/:id", name: "project-unified", component: UnifiedProjectView },
    ...legacyRedirects,
    { path: "/demo/a", name: "demo-a", component: () => import("./views/demos/DemoLayoutA.vue") },
    { path: "/demo/b", name: "demo-b", component: () => import("./views/demos/DemoLayoutB.vue") },
    { path: "/demo/c", name: "demo-c", component: () => import("./views/demos/DemoLayoutC.vue") },
    { path: "/demo/d", name: "demo-d", component: () => import("./views/demos/DemoLayoutD.vue") },
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
