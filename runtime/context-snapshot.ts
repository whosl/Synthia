/**
 * Synthia Runtime — project context snapshot for the free-agent system prompt.
 *
 * {@link buildContextSnapshot} queries the governance client for the project's
 * current state — project meta, optional process profile, project-type-aware
 * gate state, each artifact's latest revision, and recent outbox events — and
 * renders a compact Chinese markdown section that the free agent injects into
 * its system prompt. With this, the model can answer "where is the project now?"
 * without calling any tool.
 *
 * Fault tolerance: every query is wrapped individually. If Core is unreachable
 * or a query fails, the corresponding section is rendered with a "获取失败" /
 * "未知" marker and the call still returns a usable (degraded) snapshot — it
 * never throws. Only project state is rendered: no credentials, no event
 * payloads, no inline revision content (the {@link ProjectEventSummary} type
 * does not even carry the payload field).
 */

import type {
  ArtifactRevisionState,
  ArtifactRevisionSummary,
  ArtifactSummary,
  GateId,
  GateSubmissionState,
  GateSubmissionSummary,
  GovernanceClient,
  GjbGate,
  ProjectEventSummary,
  ProjectInfo,
} from "./types.ts";
import { GJB_GATES } from "./types.ts";

/** Number of recent outbox events rendered in the snapshot. */
const RECENT_EVENT_LIMIT = 8;

/** Gate → concise milestone description (grounded in GATE_AFTER_STAGE). */
const GATE_DESCRIPTION: Readonly<Record<GjbGate, string>> = {
  G1: "需求与可行性（立项）",
  G2: "需求规格与行为波形",
  G3: "架构与详细设计",
  G4: "RTL 实现与验证",
};

const GATE_SUBMISSION_STATE_LABEL: Readonly<Record<GateSubmissionState, string>> = {
  preparing: "准备中",
  submitted: "已提交",
  checking: "校验中",
  in_review: "审批中",
  approved: "已批准",
  rejected: "已驳回",
  withdrawn: "已撤回",
};

const REVISION_STATE_LABEL: Readonly<Record<ArtifactRevisionState, string>> = {
  candidate: "候选",
  in_review: "审批中",
  approved: "已批准",
  rejected: "已驳回",
  superseded: "已替代",
  invalidated: "已作废",
};

/** GateSubmission states that mean the submission is still in flight. */
const PENDING_STATES: ReadonlySet<GateSubmissionState> = new Set([
  "preparing",
  "submitted",
  "checking",
  "in_review",
]);

// ---------------------------------------------------------------------------
// Fault-tolerant query wrapper
// ---------------------------------------------------------------------------

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

async function safely<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function failLine(label: string, error: string): string {
  return `- ${label}：获取失败（${error}）`;
}

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

function gateRank(gate: GateId): number {
  const i = GJB_GATES.indexOf(gate as GjbGate);
  return i >= 0 ? i : 99;
}

function shortTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso.length > 16 ? `${iso.slice(0, 16)}…` : iso;
  }
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

function normalizeProjectType(projectType: string | undefined): "free" | "engineering" | null {
  if (projectType === "free" || projectType === "engineering") return projectType;
  return null;
}

function projectTypeLabel(projectType: string | undefined): string {
  const known = normalizeProjectType(projectType);
  if (known === "free") return "自由";
  if (known === "engineering") return "工程";
  return projectType || "未知";
}

function isFreeProject(project: ProjectInfo | null): boolean {
  return normalizeProjectType(project?.projectType) === "free";
}

function shouldRenderGjbFlow(project: ProjectInfo | null): boolean {
  if (normalizeProjectType(project?.projectType) !== "engineering") return false;
  // Missing project facts and LEGACY_COMPAT both fail closed. A transient
  // second Core read must not inject GJB milestones into a resolved free or
  // compatibility session.
  return project?.processVersionId === "GJB_REF_V1" &&
    project.processProfileId === "GJB_REF_V1" &&
    project.processProfileVersion === "GJB_REF_V1" &&
    typeof project.processProfileName === "string" &&
    project.processProfileName.trim().length > 0;
}

function profileLabel(project: ProjectInfo): string | null {
  const parts: string[] = [];
  const profileId = project.processProfileId ?? project.processVersionId;
  if (project.processProfileName) parts.push(project.processProfileName);
  if (profileId && profileId !== project.processProfileName) {
    parts.push(profileId === "LEGACY_COMPAT" ? "兼容旧流程" : profileId);
  }
  if (project.processProfileVersion) parts.push(`v${project.processProfileVersion}`);
  return parts.length > 0 ? parts.join("　") : null;
}

function gateDisplay(gate: string | undefined): string {
  if (!gate) return "未设置";
  if (gate === "G0") return "G0（项目准备）";
  const desc = GATE_DESCRIPTION[gate as GjbGate];
  return desc ? `${gate}（${desc}）` : gate;
}

function firstCurrentGate(project: ProjectInfo | null): string | null {
  return project?.processInstances.find((pi) => pi.currentGate)?.currentGate ?? null;
}

// ---------------------------------------------------------------------------
// Milestone inference (from approved gate submissions; runtime gates G1–G4)
// ---------------------------------------------------------------------------

interface Milestone {
  readonly passed: readonly GjbGate[];
  readonly lastPassed: GjbGate | null;
  readonly next: GjbGate | null;
}

function inferMilestone(submissions: readonly GateSubmissionSummary[]): Milestone {
  const runtimeGates = new Set<string>(GJB_GATES);
  const approved = new Set<GjbGate>();
  for (const sub of submissions) {
    if (sub.state === "approved" && runtimeGates.has(sub.gate)) {
      approved.add(sub.gate as GjbGate);
    }
  }
  // Ordered, de-duplicated by GJB_GATES (G1 < G2 < G3 < G4).
  const passed = GJB_GATES.filter((g) => approved.has(g));
  const lastPassed = passed.length > 0 ? passed[passed.length - 1]! : null;

  let next: GjbGate | null;
  if (lastPassed) {
    const idx = GJB_GATES.indexOf(lastPassed);
    next = idx >= 0 && idx < GJB_GATES.length - 1 ? GJB_GATES[idx + 1]! : null;
  } else {
    next = GJB_GATES[0] ?? null;
  }
  return { passed, lastPassed, next };
}

// ---------------------------------------------------------------------------
// Per-artifact latest revision fetch
// ---------------------------------------------------------------------------

interface ArtifactRow {
  readonly artifact: ArtifactSummary;
  readonly latest: ArtifactRevisionSummary | null;
  readonly error: string | null;
}

function pickLatestRevision(revs: readonly ArtifactRevisionSummary[]): ArtifactRevisionSummary | null {
  if (revs.length === 0) return null;
  let best = revs[0]!;
  for (const r of revs) {
    if (r.version > best.version) best = r;
  }
  return best;
}

async function fetchArtifactRows(
  governance: GovernanceClient,
  projectId: string,
  artifacts: Outcome<readonly ArtifactSummary[]>,
): Promise<{ rows: ArtifactRow[]; error: string | null }> {
  if (!artifacts.ok) return { rows: [], error: artifacts.error };
  const rows: ArtifactRow[] = [];
  for (const artifact of artifacts.value) {
    const revs = await safely(() => governance.listRevisions(projectId, artifact.id));
    if (revs.ok) {
      rows.push({ artifact, latest: pickLatestRevision(revs.value), error: null });
    } else {
      rows.push({ artifact, latest: null, error: revs.error });
    }
  }
  return { rows, error: null };
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderProject(project: Outcome<ProjectInfo>): string[] {
  const lines: string[] = ["### 项目"];
  if (project.ok) {
    const p = project.value;
    const freeProject = isFreeProject(p);
    lines.push(`- 名称：${p.name || "（未命名）"}（${p.id}）`);
    lines.push(
      `- 状态：${p.status || "未知"}　类型：${projectTypeLabel(p.projectType)}　` +
        `密级：${p.dataClassification || "未知"}`,
    );
    const profile = freeProject ? null : profileLabel(p);
    if (profile) lines.push(`- 流程配置：${profile}`);
    const technicalContext: string[] = [];
    if (!freeProject) technicalContext.push(`标准：${p.standardVersion || "未知"}`);
    if (p.targetPart) technicalContext.push(`目标器件：${p.targetPart}`);
    else if (!freeProject) technicalContext.push("目标器件：未指定");
    if (technicalContext.length > 0) lines.push(`- ${technicalContext.join("　")}`);
    const pis = p.processInstances;
    if (pis.length > 0) {
      lines.push(
        `- 流程实例：${pis
          .map((pi) => {
            if (freeProject) return pi.id;
            return `${pi.id}（当前门禁 ${gateDisplay(pi.currentGate)}）`;
          })
          .join("；")}`,
      );
    }
  } else {
    lines.push(failLine("项目元信息", project.error));
  }
  return lines;
}

function renderMilestone(
  milestone: Milestone,
  gateError: string | null,
  currentGate: string | null,
): string[] {
  const lines: string[] = ["### 里程碑"];
  if (gateError) {
    lines.push(failLine("里程碑（门禁提交）", gateError));
    return lines;
  }
  const passedLabel = milestone.passed.length > 0 ? milestone.passed.join("、") : "尚无";
  if (milestone.lastPassed && milestone.next) {
    lines.push(
      `- 已通过门禁：${passedLabel}`,
      `- 当前阶段：${GATE_DESCRIPTION[milestone.lastPassed]}已完成，下一步推进 ${milestone.next}（${GATE_DESCRIPTION[milestone.next]}）`,
    );
  } else if (milestone.lastPassed && !milestone.next) {
    lines.push(`- 已通过全部开发门禁（${passedLabel}）；项目进入确认/释放阶段`);
  } else {
    const first = milestone.next ?? GJB_GATES[0];
    const current = currentGate === "G0" ? "项目准备中（G0）" : "项目起步";
    lines.push(
      `- 已通过门禁：尚无`,
      `- 当前阶段：${current}，下一步推进 ${first}（${first ? GATE_DESCRIPTION[first] : ""}）`,
    );
  }
  return lines;
}

function renderGateSubmissions(submissions: Outcome<readonly GateSubmissionSummary[]>): string[] {
  const lines: string[] = ["### 门禁提交"];
  if (!submissions.ok) {
    lines.push(failLine("门禁提交", submissions.error));
    return lines;
  }
  const subs = [...submissions.value].sort((a, b) => gateRank(a.gate) - gateRank(b.gate));
  const pending = subs.filter((s) => PENDING_STATES.has(s.state));
  const decided = subs.filter((s) => !PENDING_STATES.has(s.state));

  if (pending.length > 0) {
    lines.push("- 待审批门禁提交：");
    for (const s of pending) {
      lines.push(
        `  - ${s.gate}：${GATE_SUBMISSION_STATE_LABEL[s.state] ?? s.state}` +
          (s.submittedAt ? `（提交于 ${shortTime(s.submittedAt)}）` : ""),
      );
    }
  } else {
    lines.push("- 待审批门禁提交：无");
  }
  if (decided.length > 0) {
    lines.push("- 已决策门禁提交：");
    for (const s of decided) {
      lines.push(
        `  - ${s.gate}：${GATE_SUBMISSION_STATE_LABEL[s.state] ?? s.state}` +
          (s.submittedAt ? `（提交于 ${shortTime(s.submittedAt)}）` : ""),
      );
    }
  }
  return lines;
}

function renderArtifacts(rows: ArtifactRow[], listError: string | null): string[] {
  const lines: string[] = ["### 制品清单（各制品最新修订）"];
  if (listError) {
    lines.push(failLine("制品清单", listError));
    return lines;
  }
  if (rows.length === 0) {
    lines.push("- 暂无已登记制品");
    return lines;
  }
  let approved = 0;
  let candidate = 0;
  for (const row of rows) {
    if (row.error) {
      lines.push(`- ${row.artifact.artifactType}（${row.artifact.id}）：修订查询失败（${row.error}）`);
      continue;
    }
    if (!row.latest) {
      lines.push(`- ${row.artifact.artifactType}（${row.artifact.id}）：无修订`);
      continue;
    }
    if (row.latest.state === "approved") approved++;
    else if (row.latest.state === "candidate") candidate++;
    const label = REVISION_STATE_LABEL[row.latest.state] ?? row.latest.state;
    lines.push(
      `- ${row.artifact.artifactType}　v${row.latest.version}　[${label}]　${row.latest.title || "（无标题）"}`,
    );
  }
  lines.push(`- 小计：已批准 ${approved}　候选 ${candidate}　共 ${rows.length} 件制品`);
  return lines;
}

function renderEvents(events: Outcome<readonly ProjectEventSummary[]>): string[] {
  const lines: string[] = ["### 最近活动"];
  if (!events.ok) {
    lines.push(failLine("最近事件", events.error));
    return lines;
  }
  const evs = events.value;
  if (evs.length === 0) {
    lines.push("- 暂无活动记录");
    return lines;
  }
  for (const e of evs) {
    // Note: only event metadata is rendered — never the event payload.
    lines.push(`- ${shortTime(e.occurredAt)}　[${e.aggregateType}] ${e.eventType}（${e.aggregateId}）`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a compact Chinese project-status snapshot suitable for injection into
 * the free agent's system prompt. Queries the governance client for project
 * meta, milestone (inferred from approved G1–G4 gate submissions), gate
 * submission state, the latest revision of every artifact, and recent events.
 *
 * Never throws: on Core being unreachable or any query failing, a degraded
 * snapshot is returned with the failing sections marked. Only project state
 * is rendered.
 */
export async function buildContextSnapshot(
  governance: GovernanceClient,
  projectId: string,
  options: { readonly projectInfo?: ProjectInfo } = {},
): Promise<string> {
  // Session assembly can pin the exact ProjectInfo used to resolve execution
  // mode. In that path we must not perform a second Core project read: a
  // transiently inconsistent response could otherwise inject GJB milestones
  // into an already-resolved free/compatibility session (or remove them from an
  // engineering one). Standalone callers keep the historical live-read default.
  const projectQuery: Promise<Outcome<ProjectInfo>> = options.projectInfo !== undefined
    ? Promise.resolve({ ok: true, value: options.projectInfo })
    : safely(() => governance.getProjectInfo(projectId));
  const [project, submissions, events] = await Promise.all([
    projectQuery,
    safely(() => governance.listGateSubmissions(projectId)),
    safely(() => governance.listEvents(projectId, RECENT_EVENT_LIMIT)),
  ]);

  const artifactsList = await safely(() => governance.listArtifacts(projectId));
  const { rows: artifactRows, error: artifactError } = await fetchArtifactRows(
    governance,
    projectId,
    artifactsList,
  );

  const milestone = submissions.ok
    ? inferMilestone(submissions.value)
    : { passed: [] as readonly GjbGate[], lastPassed: null as GjbGate | null, next: null as GjbGate | null };
  const gateError = submissions.ok ? null : submissions.error;
  const projectInfo = project.ok ? project.value : null;

  const blocks: string[] = ["## 项目状态快照（自动生成，仅项目状态）", ""];
  blocks.push(...renderProject(project));
  if (shouldRenderGjbFlow(projectInfo)) {
    blocks.push(...renderMilestone(milestone, gateError, firstCurrentGate(projectInfo)));
    blocks.push(...renderGateSubmissions(submissions));
  }
  blocks.push(...renderArtifacts(artifactRows, artifactError));
  blocks.push(...renderEvents(events));

  // Degradation banner when every primary query failed (Core most likely down).
  const anyOk = project.ok || submissions.ok || events.ok || artifactsList.ok;
  if (!anyOk) {
    blocks.unshift(
      "⚠️ Core 治理服务当前不可达，以下信息多为未知/获取失败；可在 Core 恢复后重试。",
      "",
    );
  }

  return `${blocks.join("\n").trim()}\n`;
}
