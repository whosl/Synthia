import { createRouter, createWebHistory } from "vue-router";
import { readToken } from "./stores/auth.ts";

const LoginView = () => import("./views/LoginView.vue");
const ProjectListView = () => import("./views/ProjectListView.vue");
const ProjectOverviewView = () => import("./views/ProjectOverviewView.vue");
const ApprovalsView = () => import("./views/ApprovalsView.vue");
const ApprovalDetailView = () => import("./views/ApprovalDetailView.vue");
const ArtifactsView = () => import("./views/ArtifactsView.vue");

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/projects" },
    { path: "/login", name: "login", component: LoginView, meta: { public: true } },
    { path: "/projects", name: "projects", component: ProjectListView },
    { path: "/projects/:id", name: "project-overview", component: ProjectOverviewView },
    { path: "/projects/:id/artifacts", name: "project-artifacts", component: ArtifactsView },
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
