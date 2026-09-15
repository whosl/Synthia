import type {
  CuratorRunV1,
  EvolutionOverviewV1,
  LearnedSkillControlAction,
  LearnedSkillDetailV1,
  LearnedSkillListV1,
  LearnedSkillSummaryV1,
  LearnedSkillVersionV1,
  SkillApplicationDetailV1,
  SkillApplicationListV1,
} from "../api/evolution.ts";

export const MOCK_EVOLUTION_MODE_KEY = "synthia.mock.evolution-mode";
export const MOCK_EVOLUTION_STATE_KEY = "synthia.mock.evolution-state.v1";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const CREATED_AT = "2026-08-19T08:30:00.000Z";

const observedMetrics = {
  measurement_state: "observed" as const,
  primary_applied: 8,
  evaluated: 6,
  pending: 2,
  inconclusive: 1,
  success: 4,
  applicability_failure: 1,
  execution_failure: 0,
  success_rate: 0.8,
  median_duration_ms: 912_000,
  human_corrections: 1,
  first_solved_problem_families: null,
};

const unknownMetrics = {
  measurement_state: "unknown" as const,
  primary_applied: 1,
  evaluated: 0,
  pending: 1,
  inconclusive: 0,
  success: 0,
  applicability_failure: 0,
  execution_failure: 0,
  success_rate: null,
  median_duration_ms: null,
  human_corrections: null,
  first_solved_problem_families: null,
};

function initialSkills(): LearnedSkillSummaryV1[] {
  return [
    {
      schema: "learned-skill-summary.v1",
      skill_id: "skill-multiple-driver",
      slug: "vivado-multiple-driver-diagnosis",
      name: "Vivado 重复驱动诊断",
      summary: "从综合错误定位重复驱动源，并给出最小修复与复查步骤。",
      applicability_summary: "Vivado 综合；Verilog/SystemVerilog；重复驱动错误族",
      active_version_id: "skill-version-multiple-driver-v2",
      active_version_no: 2,
      quality_state: "active_observed",
      freshness_state: "current",
      availability_state: "available",
      enabled: true,
      pinned: false,
      recommended: true,
      control_revision: 4,
      last_used_at: "2026-08-25T03:20:00.000Z",
      metrics: observedMetrics,
    },
    {
      schema: "learned-skill-summary.v1",
      skill_id: "skill-xdc-clock",
      slug: "xdc-generated-clock-check",
      name: "XDC 派生时钟检查",
      summary: "核对派生时钟约束的源、分频关系和报告覆盖情况。",
      applicability_summary: "Vivado 时序约束；XDC；派生时钟",
      active_version_id: "skill-version-xdc-clock-v1",
      active_version_no: 1,
      quality_state: "active_unproven",
      freshness_state: "current",
      availability_state: "available",
      enabled: true,
      pinned: false,
      recommended: true,
      control_revision: 1,
      last_used_at: "2026-08-24T06:10:00.000Z",
      metrics: unknownMetrics,
    },
  ];
}

const initialOverviewSettings = () => ({
  rollout_enabled: true,
  learning_paused: false,
  learned_skills_enabled: true,
  settings_revision: 3,
});

interface StoredEvolutionStateV1 {
  readonly schema: "mock-evolution-state.v1";
  readonly skills: LearnedSkillSummaryV1[];
  readonly overview_settings: ReturnType<typeof initialOverviewSettings>;
}

function restoreEvolutionState(): StoredEvolutionStateV1 | null {
  try {
    if (typeof globalThis.localStorage === "undefined") return null;
    const raw = globalThis.localStorage.getItem(MOCK_EVOLUTION_STATE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredEvolutionStateV1>;
    if (
      value.schema !== "mock-evolution-state.v1"
      || !Array.isArray(value.skills)
      || typeof value.overview_settings !== "object"
      || value.overview_settings === null
      || value.overview_settings.rollout_enabled !== true
      || typeof value.overview_settings.learning_paused !== "boolean"
      || typeof value.overview_settings.learned_skills_enabled !== "boolean"
      || !Number.isSafeInteger(value.overview_settings.settings_revision)
    ) {
      return null;
    }
    return value as StoredEvolutionStateV1;
  } catch {
    return null;
  }
}

const restoredEvolutionState = restoreEvolutionState();
let skills = restoredEvolutionState?.skills ?? initialSkills();
let overviewSettings = restoredEvolutionState?.overview_settings ?? initialOverviewSettings();

function persistEvolutionState(): void {
  try {
    globalThis.localStorage?.setItem(MOCK_EVOLUTION_STATE_KEY, JSON.stringify({
      schema: "mock-evolution-state.v1",
      skills,
      overview_settings: overviewSettings,
    } satisfies StoredEvolutionStateV1));
  } catch {
    // Mock storage is best-effort; API semantics remain deterministic in memory.
  }
}
const replay = new Map<string, { signature: string; response: unknown }>();
let curatorSequence = 0;

function summary(skillId: string): LearnedSkillSummaryV1 | null {
  return skills.find((skill) => skill.skill_id === skillId) ?? null;
}

function recommended(skill: LearnedSkillSummaryV1): boolean {
  return skill.enabled
    && skill.availability_state === "available"
    && skill.freshness_state === "current"
    && (skill.quality_state === "active_unproven" || skill.quality_state === "active_observed");
}

function counts(): EvolutionOverviewV1["skill_counts"] {
  const result: Record<keyof EvolutionOverviewV1["skill_counts"], number> = {
    active_unproven: 0,
    active_observed: 0,
    needs_review: 0,
    degraded: 0,
    quarantined: 0,
    archived: 0,
    disabled: 0,
  };
  for (const skill of skills) {
    if (skill.availability_state === "archived") result.archived += 1;
    else if (!skill.enabled) result.disabled += 1;
    else if (skill.quality_state) result[skill.quality_state] += 1;
  }
  return result;
}

function overview(): EvolutionOverviewV1 {
  return {
    schema: "evolution-overview.v1",
    ...overviewSettings,
    skill_counts: counts(),
    pending_applications: skills.reduce((total, skill) => total + skill.metrics.pending, 0),
    curator: {
      last_run_at: "2026-08-18T02:00:00.000Z",
      next_eligible_at: "2026-08-25T02:00:00.000Z",
      pending_evaluations: 3,
      schedule_days: 7,
      idle_hours: 2,
      max_vivado_jobs: 3,
      max_duration_minutes: 120,
    },
  };
}

function overviewForMode(mode: string | null): EvolutionOverviewV1 {
  return mode === "disabled" ? { ...overview(), rollout_enabled: false } : overview();
}

const versionSummaries = {
  "skill-multiple-driver": [
    {
      version_id: "skill-version-multiple-driver-v2",
      version_no: 2,
      parent_version_id: "skill-version-multiple-driver-v1",
      quality_state: "active_observed" as const,
      content_manifest_hash: HASH_B,
      created_at: "2026-08-20T09:40:00.000Z",
    },
    {
      version_id: "skill-version-multiple-driver-v1",
      version_no: 1,
      parent_version_id: null,
      quality_state: "degraded" as const,
      content_manifest_hash: HASH_A,
      created_at: CREATED_AT,
    },
  ],
  "skill-xdc-clock": [
    {
      version_id: "skill-version-xdc-clock-v1",
      version_no: 1,
      parent_version_id: null,
      quality_state: "active_unproven" as const,
      content_manifest_hash: HASH_C,
      created_at: "2026-08-24T05:50:00.000Z",
    },
  ],
} as const;

function skillDetail(skillId: string): LearnedSkillDetailV1 | null {
  const skill = summary(skillId);
  const versions = versionSummaries[skillId as keyof typeof versionSummaries];
  if (!skill || !versions) return null;
  return {
    ...skill,
    versions,
    source_summary: {
      distillation_run_id: skillId === "skill-multiple-driver" ? "distill-run-17" : "distill-run-22",
      source_count: skillId === "skill-multiple-driver" ? 2 : 1,
      visible_source_count: 1,
    },
  };
}

function versionDetail(skillId: string, versionId: string): LearnedSkillVersionV1 | null {
  const skill = summary(skillId);
  const version = versionSummaries[skillId as keyof typeof versionSummaries]?.find(
    (candidate) => candidate.version_id === versionId,
  );
  if (!skill || !version) return null;
  const multipleDriver = skillId === "skill-multiple-driver";
  const files = multipleDriver
    ? [
      {
        path: "SKILL.md",
        kind: "instructions",
        language: "markdown",
        sha256: HASH_A,
        size_bytes: 642,
        media_type: "text/markdown",
        content: "# Vivado 重复驱动诊断\n\n定位综合日志中的 net 与层级，再检查 always block、连续赋值和 generate 条件。",
      },
      {
        path: "scripts/find_drivers.py",
        kind: "script",
        language: "python",
        sha256: HASH_B,
        size_bytes: 318,
        media_type: "text/x-python",
        content: "def find_drivers(report: str) -> list[str]:\n    return [line for line in report.splitlines() if 'driver' in line.lower()]\n",
      },
      {
        path: "templates/report_drivers.tcl",
        kind: "template",
        language: "tcl",
        sha256: HASH_C,
        size_bytes: 87,
        media_type: "text/plain",
        content: "report_drc -checks {MDRV-1} -file multiple_drivers.rpt\n",
      },
    ]
    : [
      {
        path: "SKILL.md",
        kind: "instructions",
        language: "markdown",
        sha256: HASH_C,
        size_bytes: 471,
        media_type: "text/markdown",
        content: "# XDC 派生时钟检查\n\n核对 create_generated_clock 的源 pin、分频和时序报告覆盖。",
      },
    ];
  return {
    schema: "learned-skill-version.v1",
    skill,
    version: {
      ...version,
      description: multipleDriver
        ? "按错误对象逐层定位重复驱动，并在修复后确认原错误族消失。"
        : "检查派生时钟约束与 Vivado 时序报告的一致性。",
      applicability: multipleDriver
        ? { toolchain: "Vivado", phase: "synthesis", hdl: ["Verilog", "SystemVerilog"] }
        : { toolchain: "Vivado", phase: "timing", files: ["XDC"] },
      outcome_contract: multipleDriver
        ? { success: "原 multiple-driven net 错误消失", failure: "同一错误指纹仍存在" }
        : { success: "派生时钟均被报告覆盖", inconclusive: "缺少时序报告" },
      files,
      scan: {
        scanner_version: "learned-skill-scanner.v1",
        decision: "allowed",
        findings: [],
      },
    },
  };
}

const applicationDetails: Readonly<Record<string, SkillApplicationDetailV1>> = {
  "application-41": {
    schema: "skill-application-detail.v1",
    application_id: "application-41",
    project_ref: "project-visible-7",
    task_ref: "task-visible-19",
    observation_key: "observation-41",
    episode_ref: "episode-41",
    local_goal: "消除综合阶段的重复驱动错误",
    state: "evaluated",
    started_at: "2026-08-22T01:00:00.000Z",
    closed_at: "2026-08-22T01:16:00.000Z",
    duration_ms: 960_000,
    human_corrections: 1,
    outcome_claim: "原错误已消失，后续综合出现了无关的时序告警。",
    skills: [
      {
        skill_id: "skill-multiple-driver",
        version_id: "skill-version-multiple-driver-v2",
        role: "primary",
        reason_codes: ["matching_error_family", "matching_rtl_structure"],
      },
    ],
    evidence_summary: {
      visible: 2,
      redacted: 1,
      refs: [
        { type: "tool_run", id: "job-visible-9", hash: HASH_A },
        { type: "evidence", id: "synth-log-visible-9", hash: HASH_B },
      ],
    },
    evaluations: [
      {
        evaluation_id: "evaluation-41-a",
        outcome: "execution_failure",
        confidence: 0.66,
        reason: "首次评价把后续无关的时序告警错误归因给了本 Skill。",
        evidence_summary: { visible: 1, redacted: 1, hashes: [HASH_A, HASH_B] },
        supersedes_id: null,
        evaluator_type: "curator",
        evaluator_version: "curator-1.0",
        created_at: "2026-08-25T02:15:00.000Z",
      },
      {
        evaluation_id: "evaluation-41-b",
        outcome: "success",
        confidence: 0.95,
        reason: "原重复驱动指纹已消失；后续时序告警不属于本次局部目标。",
        evidence_summary: { visible: 2, redacted: 1, hashes: [HASH_A, HASH_B, HASH_C] },
        supersedes_id: "evaluation-41-a",
        evaluator_type: "human",
        evaluator_version: "human-review.v1",
        created_at: "2026-08-25T04:00:00.000Z",
      },
    ],
  },
  "application-42": {
    schema: "skill-application-detail.v1",
    application_id: "application-42",
    project_ref: "redacted",
    task_ref: "redacted",
    observation_key: "observation-42",
    episode_ref: "redacted",
    local_goal: "定位综合阶段的多个驱动源",
    state: "pending_evaluation",
    started_at: "2026-08-25T03:20:00.000Z",
    closed_at: "2026-08-25T03:31:00.000Z",
    duration_ms: 660_000,
    human_corrections: 0,
    outcome_claim: "已按建议完成修改并重新综合。",
    skills: [
      {
        skill_id: "skill-multiple-driver",
        version_id: "skill-version-multiple-driver-v2",
        role: "primary",
        reason_codes: ["matching_error_family"],
      },
      {
        skill_id: "skill-xdc-clock",
        version_id: "skill-version-xdc-clock-v1",
        role: "supporting",
        reason_codes: ["post_fix_timing_review"],
      },
    ],
    evidence_summary: { visible: 0, redacted: 2, refs: [] },
    evaluations: [],
  },
};

function applicationList(skillId: string, limit = 50, offset = 0): SkillApplicationListV1 {
  const details = Object.values(applicationDetails).filter((application) =>
    application.skills.some((skill) => skill.skill_id === skillId));
  const page = details.slice(offset, offset + limit);
  return {
    schema: "skill-application-list.v1",
    items: page.map((application) => {
      const current = application.evaluations.at(-1) ?? null;
      return {
        application_id: application.application_id,
        project_ref: application.project_ref,
        task_ref: application.task_ref,
        local_goal: application.local_goal,
        state: application.state,
        started_at: application.started_at,
        closed_at: application.closed_at,
        duration_ms: application.duration_ms,
        human_corrections: application.human_corrections,
        outcome_claim: application.outcome_claim,
        skills: application.skills.map(({ version_id, role }) => ({ version_id, role })),
        current_evaluation: current ? {
          evaluation_id: current.evaluation_id,
          outcome: current.outcome,
          confidence: current.confidence,
          created_at: current.created_at,
        } : null,
      };
    }),
    next_cursor: offset + page.length < details.length ? `mock-application-${offset + page.length}` : null,
  };
}

function mockCursor(value: string | null, prefix: string): number {
  if (!value) return 0;
  const match = new RegExp(`^mock-${prefix}-(\\d+)$`).exec(value);
  return match ? Number(match[1]) : 0;
}

function ok<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify({ data, correlation_id: "mock-evolution" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({
    error: { code, message, retryable: false, details: null, correlation_id: "mock-evolution" },
  }), { status, headers: { "content-type": "application/json" } });
}

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every((key) => allowed.includes(key)) ? row : null;
}

function reason(row: Record<string, unknown>): string | null {
  return typeof row.reason === "string" && row.reason.trim() ? row.reason.trim() : null;
}

function replayOrConflict(
  headers: Headers,
  body: unknown,
  build: () => Response,
): Response {
  const key = headers.get("idempotency-key");
  if (!key) return fail(400, "validation", "Idempotency-Key 必填");
  const signature = JSON.stringify(body);
  const existing = replay.get(key);
  if (existing) {
    return existing.signature === signature
      ? ok(existing.response)
      : fail(409, "IDEMPOTENCY_KEY_REUSED", "同一幂等键不能用于不同请求体");
  }
  const response = build();
  if (response.ok) {
    void response.clone().json().then((envelope: { data: unknown }) => {
      replay.set(key, { signature, response: envelope.data });
    });
  }
  return response;
}

function evolutionMode(searchParams: URLSearchParams): string | null {
  const query = searchParams.get("mockEvolution");
  if (query) return query;
  try {
    const pageQuery = typeof globalThis.location === "undefined"
      ? null
      : new URLSearchParams(globalThis.location.search).get("mockEvolution");
    if (pageQuery) return pageQuery;
    return globalThis.localStorage?.getItem(MOCK_EVOLUTION_MODE_KEY) ?? null;
  } catch {
    return null;
  }
}

export interface MockEvolutionRouteRequest {
  readonly segments: readonly string[];
  readonly method: string;
  readonly body: unknown;
  readonly headers: Headers;
  readonly searchParams: URLSearchParams;
}

export function routeMockEvolution(request: MockEvolutionRouteRequest): Response | null {
  const { segments: seg, method, body, headers, searchParams } = request;
  const mode = evolutionMode(searchParams);
  const evolutionRoute = seg[0] === "evolution" || seg[0] === "learned-skills" || seg[0] === "skill-applications";
  if (!evolutionRoute) return null;
  if (mode === "error") return fail(503, "EVOLUTION_DISABLED", "Core self-evolution 暂不可用");

  if (seg[0] === "evolution" && seg[1] === "overview" && seg.length === 2 && method === "GET") {
    if (mode === "disabled") return ok(overviewForMode(mode));
    if (mode === "empty") return ok({
      ...overview(),
      skill_counts: {
        active_unproven: 0,
        active_observed: 0,
        needs_review: 0,
        degraded: 0,
        quarantined: 0,
        archived: 0,
        disabled: 0,
      },
      pending_applications: 0,
      curator: { ...overview().curator, pending_evaluations: 0 },
    });
    return ok(overview());
  }

  if (seg[0] === "evolution" && seg[1] === "settings" && seg.length === 2 && method === "POST") {
    const row = fields(body, ["learning_paused", "learned_skills_enabled", "expected_revision", "reason"]);
    if (!row || !reason(row) || typeof row.learning_paused !== "boolean" || typeof row.learned_skills_enabled !== "boolean") {
      return fail(400, "validation", "设置请求不符合 evolution v1");
    }
    const learningPaused = row.learning_paused;
    const learnedSkillsEnabled = row.learned_skills_enabled;
    if (
      mode === "disabled"
      && (learningPaused !== overviewSettings.learning_paused || learnedSkillsEnabled !== false)
    ) {
      return fail(503, "EVOLUTION_DISABLED", "rollout 关闭期间只允许紧急禁用 Learned Skills");
    }
    return replayOrConflict(headers, body, () => {
      if (mode === "disabled" && overviewSettings.learned_skills_enabled !== true) {
        return fail(503, "EVOLUTION_DISABLED", "Learned Skills 已紧急禁用，rollout 关闭期间不能切换设置");
      }
      if (row.expected_revision !== overviewSettings.settings_revision) {
        return fail(409, "EVOLUTION_CAS_CONFLICT", "设置已被其他操作更新，请刷新后重试");
      }
      overviewSettings = {
        ...overviewSettings,
        learning_paused: learningPaused,
        learned_skills_enabled: learnedSkillsEnabled,
        settings_revision: overviewSettings.settings_revision + 1,
      };
      persistEvolutionState();
      return ok(overviewForMode(mode));
    });
  }

  if (seg[0] === "evolution" && seg[1] === "curator-runs" && seg.length === 2 && method === "POST") {
    if (mode === "disabled") {
      return fail(503, "EVOLUTION_DISABLED", "rollout 关闭期间不能运行 Curator");
    }
    return replayOrConflict(headers, body, () => {
      const row = fields(body, ["mode", "reason", "manual_key"]);
      if (!row || !reason(row) || (row.mode !== "run" && row.mode !== "dry_run") || typeof row.manual_key !== "string" || !row.manual_key) {
        return fail(400, "validation", "Curator 请求不符合 evolution v1");
      }
      curatorSequence += 1;
      const result: CuratorRunV1 = {
        schema: "curator-run.v1",
        curator_run_id: `curator-run-manual-${curatorSequence}`,
        state: row.mode === "run" ? "queued" : "dry_run_complete",
        mode: row.mode,
        created_at: new Date().toISOString(),
      };
      return ok(result, 201);
    });
  }

  if (seg[0] === "learned-skills" && seg.length === 1 && method === "GET") {
    const limit = Math.max(1, Math.min(100, Number(searchParams.get("limit") ?? "50")));
    const status = searchParams.get("status");
    const filtered = mode === "empty" ? [] : skills.filter((skill) => {
      if (!status) return true;
      if (status === "disabled") return !skill.enabled;
      if (status === "archived") return skill.availability_state === "archived";
      return skill.quality_state === status;
    });
    const offset = mockCursor(searchParams.get("cursor"), "skill");
    const items = filtered.slice(offset, offset + limit);
    const list: LearnedSkillListV1 = {
      schema: "learned-skill-list.v1",
      items,
      next_cursor: offset + items.length < filtered.length ? `mock-skill-${offset + items.length}` : null,
    };
    return ok(list);
  }

  if (seg[0] === "learned-skills" && seg.length >= 2) {
    const skillId = seg[1]!;
    const skill = summary(skillId);
    if (!skill) return fail(404, "not_found", "Learned Skill 不存在");
    if (seg.length === 2 && method === "GET") {
      const detail = skillDetail(skillId);
      return detail ? ok(detail) : fail(404, "not_found", "Learned Skill 不存在");
    }
    if (seg.length === 4 && seg[2] === "versions" && method === "GET") {
      const detail = versionDetail(skillId, seg[3]!);
      return detail ? ok(detail) : fail(404, "not_found", "Skill 版本不存在");
    }
    if (seg.length === 3 && seg[2] === "applications" && method === "GET") {
      const limit = Math.max(1, Math.min(100, Number(searchParams.get("limit") ?? "50")));
      const offset = mockCursor(searchParams.get("cursor"), "application");
      return ok(applicationList(skillId, limit, offset));
    }
    const controlActions = new Set<LearnedSkillControlAction>([
      "pin",
      "unpin",
      "disable",
      "enable",
      "archive",
      "restore",
    ]);
    if (
      seg.length === 3
      && controlActions.has(seg[2] as LearnedSkillControlAction)
      && method === "POST"
    ) {
      const action = seg[2] as LearnedSkillControlAction;
      if (mode === "disabled" && action !== "disable") {
        return fail(503, "EVOLUTION_DISABLED", "rollout 关闭期间只允许紧急禁用 Learned Skill");
      }
      return replayOrConflict(headers, body, () => {
        const row = fields(body, ["expected_control_revision", "reason"]);
        if (
          !row
          || !reason(row)
          || !Number.isSafeInteger(row.expected_control_revision)
          || Number(row.expected_control_revision) < 1
        ) {
          return fail(400, "validation", "Skill 控制请求不符合 evolution v1");
        }
        if (mode === "disabled" && skill.enabled !== true) {
          return fail(503, "EVOLUTION_DISABLED", "Skill 已紧急禁用，不能用新请求制造控制 revision");
        }
        if (row.expected_control_revision !== skill.control_revision) {
          return fail(409, "EVOLUTION_CAS_CONFLICT", "Skill 控制状态已变化，请刷新后重试");
        }
        const projection = {
          ...skill,
          enabled: action === "enable" ? true : action === "disable" ? false : skill.enabled,
          pinned: action === "pin" ? true : action === "unpin" ? false : skill.pinned,
          availability_state: action === "archive"
            ? "archived" as const
            : action === "restore"
              ? "available" as const
              : skill.availability_state,
          control_revision: skill.control_revision + 1,
        };
        const next = { ...projection, recommended: recommended(projection) };
        skills = skills.map((candidate) => candidate.skill_id === skillId ? next : candidate);
        persistEvolutionState();
        return ok(next);
      });
    }
    return null;
  }

  if (seg[0] === "skill-applications" && seg.length === 2 && method === "GET") {
    const detail = applicationDetails[seg[1]!];
    return detail ? ok(detail) : fail(404, "not_found", "Skill application 不存在");
  }

  return null;
}

export function resetMockEvolutionState(): void {
  skills = initialSkills();
  overviewSettings = initialOverviewSettings();
  try {
    globalThis.localStorage?.removeItem(MOCK_EVOLUTION_STATE_KEY);
  } catch {
    // Ignore unavailable browser storage in unit-test runtimes.
  }
  replay.clear();
  curatorSequence = 0;
}

export function mockEvolutionOverview(): EvolutionOverviewV1 {
  return overview();
}
