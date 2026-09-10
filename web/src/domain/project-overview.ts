import type { ApiClient } from "../api/client.ts";
import {
  getProcessProfile,
  getProcessState,
  listGateSubmissions,
  listProjects,
  listTasks,
} from "../api/index.ts";
import type {
  GateSubmission,
  ProcessProfileV1,
  Project,
  TaskAgentSummary,
} from "../api/types.ts";
import { GATE_REVIEW_NAMES, type GateId } from "./gates.ts";
import {
  GJB_REF_V1_ID,
  isLegacyCompatProject,
  projectType,
} from "./project.ts";
import {
  currentProcessGate,
  deriveProcessGateChain,
  parseAndVerifyProcessProfile,
  parseProcessState,
  processProgress,
} from "./process-profile.ts";

export interface OverviewIssue {
  readonly label: string;
  readonly error: unknown;
}

export interface ProjectOverview {
  readonly project: Project;
  readonly submissions: readonly GateSubmission[];
  readonly tasks: readonly TaskAgentSummary[];
  readonly issues: readonly OverviewIssue[];
  readonly stage: string;
  readonly gateNames: Readonly<Record<string, string>>;
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly updatedAt: string;
}

export interface PendingReview {
  readonly project: Project;
  readonly submission: GateSubmission;
  readonly title: string;
}

export function pendingReviews(
  rows: readonly ProjectOverview[],
): PendingReview[] {
  return rows
    .flatMap(({ project, submissions, gateNames }) =>
      submissions
        .filter((submission) => submission.state === "in_review")
        .map((submission) => ({
          project,
          submission,
          title:
            gateNames[submission.gate] ??
            ((project.process_profile_id ?? project.process_version_id) ===
            GJB_REF_V1_ID
              ? `${submission.gate} · 阶段审查`
              : (GATE_REVIEW_NAMES[submission.gate as GateId] ??
                submission.gate)),
        })),
    )
    .sort(
      (a, b) =>
        Date.parse(b.submission.submitted_at ?? b.submission.created_at) -
        Date.parse(a.submission.submitted_at ?? a.submission.created_at),
    );
}

export function activeMainTasks(rows: readonly ProjectOverview[]) {
  return rows.flatMap(({ project, tasks }) =>
    tasks
      .filter(
        (task) =>
          task.kind !== "side" &&
          (task.status === "running" || task.status === "awaiting_approval"),
      )
      .map((task) => ({ project, task })),
  );
}

/** Each source fails independently. Missing facts never become an empty successful result. */
export async function loadProjectOverview(
  client: ApiClient,
): Promise<ProjectOverview[]> {
  const projects = await listProjects(client);
  let profilePromise: Promise<ProcessProfileV1> | null = null;
  const profile = () =>
    (profilePromise ??= getProcessProfile(client, GJB_REF_V1_ID).then(
      parseAndVerifyProcessProfile,
    ));
  const rows: ProjectOverview[] = [];
  // Bound cross-project fan-out while allowing independent facts to load together.
  for (let offset = 0; offset < projects.length; offset += 4) {
    rows.push(
      ...(await Promise.all(
        projects
          .slice(offset, offset + 4)
          .map(async (project): Promise<ProjectOverview> => {
            const engineering = projectType(project) === "engineering";
            const modern =
              engineering &&
              (project.process_profile_id ?? project.process_version_id) ===
                GJB_REF_V1_ID;
            const [submissionResult, taskResult, processResult] =
              await Promise.allSettled([
                engineering
                  ? listGateSubmissions(client, project.id)
                  : Promise.resolve([]),
                listTasks(client, project.id),
                modern
                  ? Promise.all([
                      profile(),
                      getProcessState(client, project.id),
                    ])
                  : Promise.resolve(null),
              ]);
            const issues: OverviewIssue[] = [];
            const submissions =
              submissionResult.status === "fulfilled"
                ? submissionResult.value
                : [];
            const tasks =
              taskResult.status === "fulfilled"
                ? taskResult.value.agents.filter((task) => task.kind !== "side")
                : [];
            if (submissionResult.status === "rejected")
              issues.push({
                label: "待审批记录",
                error: submissionResult.reason,
              });
            if (taskResult.status === "rejected")
              issues.push({ label: "任务状态", error: taskResult.reason });
            let stage = engineering
              ? isLegacyCompatProject(project)
                ? "兼容旧流程"
                : "流程状态暂不可用"
              : "自由探索 · 无固定阶段";
            let gateNames: Record<string, string> = {};
            let progress: ProjectOverview["progress"] = null;
            if (modern) {
              try {
                if (processResult.status === "rejected")
                  throw processResult.reason;
                const [definition, rawState] = processResult.value!;
                gateNames = Object.fromEntries(
                  definition.nodes.map((node) => [node.id, node.name]),
                );
                const state = parseProcessState(rawState, project.id);
                const chain = deriveProcessGateChain(definition, state)!;
                const current = currentProcessGate(chain)!;
                stage = state.completed
                  ? "实现与交付已完成"
                  : `${current.node.id} · ${current.node.name}`;
                progress = processProgress(chain);
              } catch (error) {
                issues.push({ label: "正式流程状态", error });
              }
            }
            const dates = [
              project.created_at,
              ...submissions.map((sub) => sub.submitted_at ?? sub.created_at),
              ...tasks.map((task) => task.created_at),
            ];
            const updatedAt = dates.reduce(
              (latest, date) =>
                Date.parse(date) > Date.parse(latest) ? date : latest,
              project.created_at,
            );
            return {
              project,
              submissions,
              tasks,
              issues,
              stage,
              gateNames,
              progress,
              updatedAt,
            };
          }),
      )),
    );
  }
  return rows.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function filterProjects(
  rows: readonly ProjectOverview[],
  query: string,
  type: string,
): ProjectOverview[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(
    ({ project }) =>
      (type === "all" || projectType(project) === type) &&
      (!needle ||
        [project.name, project.id, project.target_part ?? ""].some((value) =>
          value.toLocaleLowerCase().includes(needle),
        )),
  );
}

export function formatActivity(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
