/**
 * GET /projects/:projectId/tool-summary — 物理实现进度与时序指标聚合。
 *
 * 面向前端"物理实现进度卡"：一次拉齐 validate → simulate → synthesize →
 * implement（→ 码流）+ report_sta 各阶段最新状态、码流有无，以及最近一次
 * 成功 implement / report_sta 的时序摘要（WNS/TNS/WHS/时序状态/覆盖时钟）。
 *
 * 时序摘要的解析结果落库缓存（tool_timing_metrics，迁移 0014）：每条
 * sta.rpt 只解析一次，之后纯 DB 供给；首次遇到无缓存的作业时经
 * connector 拉 evidence 原文解析并写入。connector 不可用或拉取失败时
 * timing 降级为 null（携带 timingError），端点本身不失败 —— 进度信息
 * 不应因 evidence 通道故障而不可见。
 *
 * 自由项目当前验证严格限定配置与验证链；历史指标独立展示，不能恢复通过状态。
 */
import type { HandlerResult, RequestContext } from "./handlers.ts";
import { readResourceSummary, type ToolSummaryResources } from "./resource-summary.ts";
import { notFoundError } from "./errors.ts";
import { validationInputs } from "../services/validation-inputs.ts";
import { fetchJobEvidenceContent } from "./job-evidence.ts";

export interface ToolSummaryStage {
  readonly operation: "validate_sources" | "simulate" | "synthesize" | "implement" | "report_sta";
  /** 最新一次作业的状态；从未运行过为 "never"。 */
  readonly state: string;
  readonly lastJobId: string | null;
  readonly lastAt: string | null;
  readonly succeeded: number;
  readonly failed: number;
}

export interface ToolSummaryTiming {
  readonly wns: number | null;
  readonly tns: number | null;
  readonly whs: number | null;
  readonly status: "met" | "failed" | "unconstrained" | "unknown";
  readonly clocks: readonly string[];
  readonly sourceJobId: string;
  readonly parsedAt: string;
}

export interface ToolSummary {
  readonly configEpoch?: number;
  readonly validationChainHash?: string | null;
  readonly validationState?: "passed" | "pending";
  readonly projectId: string;
  readonly generatedAt: string;
  readonly stages: readonly ToolSummaryStage[];
  readonly bitstream: { readonly generated: boolean; readonly jobId: string | null; readonly at: string | null };
  readonly timing: ToolSummaryTiming | null;
  readonly timingError?: string;
  readonly resources?: ToolSummaryResources | null;
  readonly resourcesError?: string;
  /** Lifetime records are visible without satisfying the current configuration. */
  readonly history?: {
    readonly runCount: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly timing?: ToolSummaryTiming | null;
    readonly timingSource?: { readonly configEpoch: number | null; readonly at: string };
    readonly timingError?: string;
    readonly resources?: ToolSummaryResources | null;
    readonly resourcesError?: string;
  };
}

/**
 * 解析 sta.rpt 的 Design Timing Summary 行。Vivado 2021.1 的 10 列形态：
 * WNS TNS TNS-fail TNS-end WHS THS THS-fail THS-end WPWS TPWS；短形态
 * （无 hold 列）只取前两列。判定语义与 p4-formal-flow.parseTimingReport
 * 保持一致（met/failed/unconstrained 的触发词相同），但独立实现，避免
 * 牵动 G4 门禁判定。
 */
export function parseStaSummary(text: string): { wns: number | null; tns: number | null; whs: number | null; status: "met" | "failed" | "unconstrained" | "unknown"; clocks: string[] } {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex(line => /\bWNS\(ns\)/.test(line) && /\bTNS\(ns\)/.test(line));
  let wns: number | null = null;
  let tns: number | null = null;
  let whs: number | null = null;
  if (header >= 0) {
    for (const line of lines.slice(header + 1, header + 9)) {
      const values = line.trim().split(/\s+/);
      if (values.length >= 2 && values.every(value => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))) {
        wns = Number(values[0]);
        tns = Number(values[1]);
        if (values.length >= 6) whs = Number(values[4]);
        break;
      }
    }
  }
  const explicitlyFailed = /timing constraints are not met/i.test(text) || /Slack\s*\(VIOLATED\)/.test(text);
  const explicitlyMet = /All user specified timing constraints are met\./i.test(text);
  const unconstrained = /(?:unconstrained paths?|no clocks? found|no timing constraints?)/i.test(text);
  const status: "met" | "failed" | "unconstrained" | "unknown" = explicitlyFailed || (wns !== null && wns < 0)
    ? "failed"
    : explicitlyMet && wns !== null
      ? "met"
      : unconstrained
        ? "unconstrained"
        : "unknown";
  const clocks = [...new Set([
    ...[...text.matchAll(/^\s*(?:Clock|Path Group)\s*:\s*([^\s].*?)\s*$/gim)].map(match => match[1]!.trim()),
    ...[...text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_./:-]*)\s+\{[^}]*\}\s+[\d.]+/gm)].map(match => match[1]!),
  ])].sort();
  return { wns, tns, whs, status, clocks };
}

const OPERATIONS: readonly ToolSummaryStage["operation"][] = ["validate_sources", "simulate", "synthesize", "implement", "report_sta"];

async function readTimingSummary(ctx: RequestContext, projectId: string, sourceJobId: string): Promise<{ timing: ToolSummaryTiming | null; timingError?: string }> {
  const cached = await ctx.pool.query(
    "SELECT wns, tns, whs, status, clocks, parsed_at FROM tool_timing_metrics WHERE job_id = $1 AND project_id = $2",
    [sourceJobId, projectId],
  );
  const row = cached.rows[0];
  if (row) return { timing: {
    wns: row.wns === null ? null : Number(row.wns),
    tns: row.tns === null ? null : Number(row.tns),
    whs: row.whs === null ? null : Number(row.whs),
    status: row.status as ToolSummaryTiming["status"],
    clocks: Array.isArray(row.clocks) ? row.clocks.map(String) : [],
    sourceJobId, parsedAt: row.parsed_at.toISOString(),
  } };
  if (!ctx.connector) return { timing: null, timingError: "connector not configured" };
  try {
    const evidence = await fetchJobEvidenceContent(ctx, projectId, sourceJobId, "sta.rpt", { requireFull: true });
    if (evidence.truncated) throw new Error("truncated timing report");
    const parsed = parseStaSummary(evidence.content);
    await ctx.pool.query(
      `INSERT INTO tool_timing_metrics (job_id, project_id, wns, tns, whs, status, clocks, parsed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT (job_id) DO NOTHING`,
      [sourceJobId, projectId, parsed.wns, parsed.tns, parsed.whs, parsed.status, JSON.stringify(parsed.clocks)],
    );
    return { timing: { ...parsed, sourceJobId, parsedAt: new Date().toISOString() } };
  } catch (error) {
    return { timing: null, timingError: error instanceof Error ? error.message : String(error) };
  }
}

async function requireProjectReadable(ctx: RequestContext, projectId: string): Promise<void> {
  const project = await ctx.pool.query("SELECT id FROM project WHERE id=$1", [projectId]);
  if (project.rows.length === 0) throw notFoundError(`project not found: ${projectId}`);
  if (ctx.identity.scopes.includes("core:admin")) return;
  const access = await ctx.pool.query(
    "SELECT 1 FROM role_assignment WHERE project_id=$1 AND actor_type=$2 AND actor_id=$3 LIMIT 1",
    [projectId, ctx.identity.actorType, ctx.identity.actorId],
  );
  if (access.rows.length === 0) throw notFoundError(`project not found: ${projectId}`);
}

export async function getProjectToolSummaryHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  await requireProjectReadable(ctx, projectId);
  const project = (await ctx.pool.query("SELECT project_type,config_epoch FROM project WHERE id=$1", [projectId])).rows[0];
  const epoch = project.project_type === "free" ? Number(project.config_epoch) : null;
  const chain = epoch === null ? null : (await ctx.pool.query(
    "SELECT validation_chain_hash FROM tool_run WHERE project_id=$1 AND config_epoch=$2 AND validation_chain_hash IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1", [projectId, epoch],
  )).rows[0]?.validation_chain_hash ?? null;

  const latest = await ctx.pool.query(
    `SELECT DISTINCT ON (operation) operation, id AS job_id, state, created_at, end_time,parameters,
            EXTRACT(EPOCH FROM created_at)::text AS created_seconds,EXTRACT(EPOCH FROM COALESCE(end_time,created_at))::text AS end_seconds
       FROM tool_run
      WHERE project_id = $1
        AND ($2::int IS NULL OR (config_epoch=$2 AND validation_chain_hash=$3))
      ORDER BY operation, created_at DESC,id DESC`,
    [projectId, epoch, chain],
  );
  const counts = await ctx.pool.query(
    `SELECT operation,
            count(*) FILTER (WHERE state = 'succeeded') AS ok,
            count(*) FILTER (WHERE state IN ('failed','timeout','lost','unknown_effect')) AS fail
       FROM tool_run
      WHERE project_id = $1
        AND ($2::int IS NULL OR (config_epoch=$2 AND validation_chain_hash=$3))
      GROUP BY operation`,
    [projectId, epoch, chain],
  );
  const countByOperation = new Map(counts.rows.map(row => [
    String(row.operation),
    { ok: Number(row.ok), fail: Number(row.fail) },
  ]));

  const stages: ToolSummaryStage[] = OPERATIONS.map((operation) => {
    const row = latest.rows.find(candidate => String(candidate.operation) === operation) as
      | { job_id: string; state: string; end_time: Date | null; created_at: Date }
      | undefined;
    const count = countByOperation.get(operation) ?? { ok: 0, fail: 0 };
    return {
      operation,
      state: row ? row.state : "never",
      lastJobId: row?.job_id ?? null,
      lastAt: row ? (row.end_time ?? row.created_at).toISOString() : null,
      succeeded: count.ok,
      failed: count.fail,
    };
  });

  // A later simulation/validation invalidates earlier downstream results even
  // with identical source bytes. Require each stage to follow its dependency.
  if (epoch !== null) {
    for (let index = 1; index < 4; index++) {
      const stage = stages[index]!;
      const previous = stages[index - 1]!;
      const row = latest.rows.find(candidate => candidate.operation === stage.operation);
      const dependency = latest.rows.find(candidate => candidate.operation === previous.operation);
      if (stage.state === "succeeded" && (previous.state !== "succeeded" || !dependency
        || Number(row!.created_seconds) < Number(dependency.end_seconds))) {
        stages[index] = { ...stage, state: "stale" };
      }
    }
    const simulation = latest.rows.find(row => row.operation === "simulate");
    if (simulation?.parameters?.sources) {
      const simulationInputs = validationInputs(simulation.parameters.sources, simulation.parameters.top ?? null);
      for (let index = 2; index < 4; index++) {
        const row = latest.rows.find(candidate => candidate.operation === stages[index]!.operation);
        const inputs = row?.parameters?.sources ? validationInputs(row.parameters.sources, row.parameters.top ?? null) : null;
        if (inputs?.tests.length && inputs.testHash !== simulationInputs.testHash) stages[index] = { ...stages[index]!, state: "stale" };
        if (index === 3 && stages[2]!.state === "stale") stages[index] = { ...stages[index]!, state: "stale" };
      }
    }
  }

  const bit = await ctx.pool.query(
    `SELECT id AS job_id, end_time FROM tool_run
      WHERE project_id = $1 AND operation = 'implement' AND state = 'succeeded'
        AND ($2::int IS NULL OR (config_epoch=$2 AND validation_chain_hash=$3))
        AND (evidence::jsonb @> '[{"name":"synthia.bit"}]'::jsonb
          OR evidence::jsonb->'entries' @> '[{"name":"synthia.bit"}]'::jsonb)
      ORDER BY created_at DESC LIMIT 1`,
    [projectId, epoch, chain],
  );
  const bitRow = bit.rows[0] as { job_id: string; end_time: Date | null } | undefined;
  const bitstream = {
    generated: bitRow !== undefined && stages[3]!.state !== "stale",
    jobId: stages[3]!.state === "stale" ? null : bitRow?.job_id ?? null,
    at: stages[3]!.state !== "stale" && bitRow?.end_time ? bitRow.end_time.toISOString() : null,
  };

  let timing: ToolSummaryTiming | null = null;
  let timingError: string | undefined;
  const timingSource = await ctx.pool.query(
    `SELECT id AS job_id FROM tool_run
      WHERE project_id = $1 AND operation IN ('implement','report_sta') AND state = 'succeeded'
        AND ($2::int IS NULL OR (config_epoch=$2 AND validation_chain_hash=$3))
        AND (evidence::jsonb->'entries' @> '[{"name":"sta.rpt"}]'::jsonb
          OR evidence::jsonb @> '[{"name":"sta.rpt"}]'::jsonb)
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [projectId, epoch, chain],
  );
  const sourceJobId = (timingSource.rows[0] as { job_id: string } | undefined)?.job_id;
  if (sourceJobId !== undefined && stages[3]!.state !== "stale") {
    ({ timing, timingError } = await readTimingSummary(ctx, projectId, sourceJobId));
  }

  const resources = stages[2]!.state === "stale" ? { resources: null } : await readResourceSummary(ctx, projectId, epoch, chain);
  const lifetime = (await ctx.pool.query(
    `SELECT count(*) AS total, count(*) FILTER (WHERE state='succeeded') AS ok,
            count(*) FILTER (WHERE state IN ('failed','timeout','lost','unknown_effect')) AS fail
       FROM tool_run WHERE project_id=$1`, [projectId],
  )).rows[0];
  let history: NonNullable<ToolSummary["history"]> = {
    runCount: Number(lifetime?.total ?? 0), succeeded: Number(lifetime?.ok ?? 0), failed: Number(lifetime?.fail ?? 0),
  };
  // Only fetch fallback reports when the current configuration has no metric.
  // Do not rebind legacy NULL epochs or promote old reports into stage results.
  if (epoch !== null && !timing) {
    const historical = (await ctx.pool.query(
      `SELECT id AS job_id, config_epoch, COALESCE(end_time,created_at) AS at FROM tool_run
        WHERE project_id=$1 AND state='succeeded' AND operation IN ('implement','report_sta')
          AND (evidence::jsonb->'entries' @> '[{"name":"sta.rpt"}]'::jsonb
            OR evidence::jsonb @> '[{"name":"sta.rpt"}]'::jsonb)
        ORDER BY created_at DESC, id DESC LIMIT 1`, [projectId],
    )).rows[0];
    if (historical) history = { ...history, ...await readTimingSummary(ctx, projectId, historical.job_id),
      timingSource: { configEpoch: historical.config_epoch, at: historical.at.toISOString() },
    };
  }
  if (epoch !== null && !resources.resources) history = { ...history, ...await readResourceSummary(ctx, projectId) };
  const summary: ToolSummary = {
    ...resources,
    history,
    projectId,
    ...(epoch === null ? {} : { configEpoch: epoch, validationChainHash: chain,
      validationState: stages.slice(0, 4).every((stage) => stage.state === "succeeded") ? "passed" as const : "pending" as const }),
    generatedAt: new Date().toISOString(),
    stages,
    bitstream,
    timing,
    ...(timingError !== undefined ? { timingError } : {}),
  };
  return { status: 200, data: summary };
}
