/**
 * GET /projects/:projectId/tool-summary — 物理实现进度与时序指标聚合。
 *
 * 面向前端"物理实现进度卡"：一次拉齐 validate → simulate → synthesize →
 * implement（→ 码流）五个阶段的最新状态、码流有无，以及最近一次成功
 * implement 的时序摘要（WNS/TNS/WHS/时序状态/覆盖时钟）。
 *
 * 时序摘要的解析结果落库缓存（tool_timing_metrics，迁移 0014）：每条
 * sta.rpt 只解析一次，之后纯 DB 供给；首次遇到无缓存的作业时经
 * connector 拉 evidence 原文解析并写入。connector 不可用或拉取失败时
 * timing 降级为 null（携带 timingError），端点本身不失败 —— 进度信息
 * 不应因 evidence 通道故障而不可见。
 *
 * 工程项目与自由项目一视同仁：数据源是 tool_run，与项目类型无关。
 */
import type { HandlerResult, RequestContext } from "./handlers.ts";
import { notFoundError } from "./errors.ts";

export interface ToolSummaryStage {
  readonly operation: "validate_sources" | "simulate" | "synthesize" | "implement";
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
  readonly projectId: string;
  readonly generatedAt: string;
  readonly stages: readonly ToolSummaryStage[];
  readonly bitstream: { readonly generated: boolean; readonly jobId: string | null; readonly at: string | null };
  readonly timing: ToolSummaryTiming | null;
  readonly timingError?: string;
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

const OPERATIONS: readonly ToolSummaryStage["operation"][] = ["validate_sources", "simulate", "synthesize", "implement"];

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

  const latest = await ctx.pool.query(
    `SELECT DISTINCT ON (operation) operation, id AS job_id, state, created_at, end_time
       FROM tool_run
      WHERE project_id = $1
      ORDER BY operation, created_at DESC`,
    [projectId],
  );
  const counts = await ctx.pool.query(
    `SELECT operation,
            count(*) FILTER (WHERE state = 'succeeded') AS ok,
            count(*) FILTER (WHERE state IN ('failed','timeout','lost','unknown_effect')) AS fail
       FROM tool_run
      WHERE project_id = $1
      GROUP BY operation`,
    [projectId],
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

  const bit = await ctx.pool.query(
    `SELECT id AS job_id, end_time FROM tool_run
      WHERE project_id = $1 AND operation = 'implement' AND state = 'succeeded'
        AND evidence::jsonb @> '[{"name":"synthia.bit"}]'::jsonb
      ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  );
  const bitRow = bit.rows[0] as { job_id: string; end_time: Date | null } | undefined;
  const bitstream = {
    generated: bitRow !== undefined,
    jobId: bitRow?.job_id ?? null,
    at: bitRow?.end_time ? bitRow.end_time.toISOString() : null,
  };

  let timing: ToolSummaryTiming | null = null;
  let timingError: string | undefined;
  const timingSource = await ctx.pool.query(
    `SELECT id AS job_id FROM tool_run
      WHERE project_id = $1 AND operation = 'implement' AND state = 'succeeded'
        AND evidence::jsonb->'entries' @> '[{"name":"sta.rpt"}]'::jsonb
      ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  );
  const sourceJobId = (timingSource.rows[0] as { job_id: string } | undefined)?.job_id;
  if (sourceJobId !== undefined) {
    const cached = await ctx.pool.query(
      `SELECT wns, tns, whs, status, clocks, parsed_at
         FROM tool_timing_metrics WHERE job_id = $1 AND project_id = $2`,
      [sourceJobId, projectId],
    );
    const cachedRow = cached.rows[0] as
      | { wns: string | null; tns: string | null; whs: string | null; status: string; clocks: unknown; parsed_at: Date }
      | undefined;
    if (cachedRow) {
      timing = {
        wns: cachedRow.wns === null ? null : Number(cachedRow.wns),
        tns: cachedRow.tns === null ? null : Number(cachedRow.tns),
        whs: cachedRow.whs === null ? null : Number(cachedRow.whs),
        status: cachedRow.status as ToolSummaryTiming["status"],
        clocks: Array.isArray(cachedRow.clocks) ? cachedRow.clocks.map(String) : [],
        sourceJobId,
        parsedAt: cachedRow.parsed_at.toISOString(),
      };
    } else if (!ctx.connector) {
      timingError = "connector not configured";
    } else {
      try {
        const evidence = await ctx.connector.fetchEvidenceContent(projectId, sourceJobId, "sta.rpt");
        const parsed = parseStaSummary(evidence.content);
        timing = {
          wns: parsed.wns, tns: parsed.tns, whs: parsed.whs, status: parsed.status,
          clocks: parsed.clocks, sourceJobId,
          parsedAt: new Date().toISOString(),
        };
        await ctx.pool.query(
          `INSERT INTO tool_timing_metrics (job_id, project_id, wns, tns, whs, status, clocks, parsed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,now())
           ON CONFLICT (job_id) DO NOTHING`,
          [sourceJobId, projectId, parsed.wns, parsed.tns, parsed.whs, parsed.status, JSON.stringify(parsed.clocks)],
        );
      } catch (err) {
        timingError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const summary: ToolSummary = {
    projectId,
    generatedAt: new Date().toISOString(),
    stages,
    bitstream,
    timing,
    ...(timingError !== undefined ? { timingError } : {}),
  };
  return { status: 200, data: summary };
}
