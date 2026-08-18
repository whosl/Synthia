/**
 * 运行记录面板数据层测试（`domain/records.ts:buildRecordJobs`）：
 * - evidence × audit(tool_call) 按 jobId 关联出 ts/errorCode；
 * - 同操作多轮（修复循环）round 按 evidence 数组顺序递增；
 * - 无匹配 audit 事件时容错（ts/errorCode 为 null，不抛错）；
 * - entries 原样透传。
 */
import { describe, expect, test } from "bun:test";
import { buildRecordJobs } from "../src/domain/records.ts";
import { TOOL_BAR_TITLES } from "../src/domain/tasks.ts";
import type { TaskAuditEvent, TaskEvidenceSummary, TaskRunDetail } from "../src/api/types.ts";

// ─── 夹具 ────────────────────────────────────────────────────────────

let seq = 0;
function audit(partial: Partial<TaskAuditEvent> & Pick<TaskAuditEvent, "category" | "phase" | "action">, ts?: string): TaskAuditEvent {
  seq += 1;
  return { ts: ts ?? `2026-08-17T10:00:${String(seq).padStart(2, "0")}Z`, seq, ...partial };
}

function makeDetail(overrides: Partial<TaskRunDetail>): TaskRunDetail {
  seq = 0;
  return {
    run_id: "run-test",
    project_id: "proj-1",
    status: "running",
    current_stage: null,
    awaiting_gate: null,
    created_at: "2026-08-17T10:00:00Z",
    docs: [],
    audit: [],
    evidence: [],
    ...overrides,
  };
}

/** tool_call audit 事件（与 evidence.jobId 关联用）。 */
const toolCall = (jobId: string, op: string, ok: boolean, errorCode?: string, ts?: string): TaskAuditEvent =>
  audit(
    {
      category: "tool_call",
      phase: op,
      action: ok ? `${op} succeeded` : `${op} failed`,
      result: ok ? "ok" : "failed",
      jobId,
      ...(errorCode ? { errorCode } : {}),
    },
    ts,
  );

const evidenceEntry = (overrides: Partial<TaskEvidenceSummary>): TaskEvidenceSummary => ({
  jobId: "job-1",
  operation: "simulate",
  status: "succeeded",
  inputSha256: "a".repeat(64),
  entries: [{ name: "sim.log", sha256: "b".repeat(64), sizeBytes: 10, mediaType: "text/plain" }],
  ...overrides,
});

// ─── 关联与四态 ──────────────────────────────────────────────────────

describe("buildRecordJobs：evidence × audit(tool_call) 按 jobId 关联", () => {
  test("成功证据 + 匹配 audit 事件 → round 1, ok true, errorCode null, ts 取自 audit, title 取自 TOOL_BAR_TITLES", () => {
    const detail = makeDetail({
      evidence: [evidenceEntry({ jobId: "job-1", operation: "simulate", status: "succeeded" })],
      audit: [toolCall("job-1", "simulate", true, undefined, "2026-08-17T10:05:00Z")],
    });
    const jobs = buildRecordJobs(detail);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      jobId: "job-1",
      operation: "simulate",
      title: TOOL_BAR_TITLES.simulate,
      round: 1,
      ok: true,
      errorCode: null,
      ts: "2026-08-17T10:05:00Z",
    });
  });

  test("失败证据 + 匹配 audit 事件 → ok false，errorCode 取自 audit", () => {
    const detail = makeDetail({
      evidence: [evidenceEntry({ jobId: "job-2", operation: "implement", status: "failed" })],
      audit: [toolCall("job-2", "implement", false, "VIVADO_TIMEOUT", "2026-08-17T10:06:00Z")],
    });
    const jobs = buildRecordJobs(detail);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      ok: false,
      errorCode: "VIVADO_TIMEOUT",
      ts: "2026-08-17T10:06:00Z",
      title: TOOL_BAR_TITLES.implement,
    });
  });

  test("同一 operation 两条 evidence（修复循环重试）→ round 按数组顺序 1、2", () => {
    const detail = makeDetail({
      evidence: [
        evidenceEntry({ jobId: "job-3", operation: "simulate", status: "failed" }),
        evidenceEntry({ jobId: "job-4", operation: "simulate", status: "succeeded" }),
      ],
      audit: [
        toolCall("job-3", "simulate", false, "SIM_MISMATCH", "2026-08-17T10:01:00Z"),
        toolCall("job-4", "simulate", true, undefined, "2026-08-17T10:03:00Z"),
      ],
    });
    const jobs = buildRecordJobs(detail);
    expect(jobs.map((j) => j.round)).toEqual([1, 2]);
    expect(jobs.map((j) => j.jobId)).toEqual(["job-3", "job-4"]);
  });

  test("evidence 的 jobId 无匹配 audit 事件 → ts/errorCode 为 null，不抛错", () => {
    const detail = makeDetail({
      evidence: [evidenceEntry({ jobId: "job-orphan", operation: "synthesize", status: "succeeded" })],
      audit: [],
    });
    expect(() => buildRecordJobs(detail)).not.toThrow();
    const jobs = buildRecordJobs(detail);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ ts: null, errorCode: null, ok: true });
  });

  test("entries 原样透传（name/sha256/sizeBytes/mediaType 不变）", () => {
    const entries = [
      { name: "sim.log", sha256: "b".repeat(64), sizeBytes: 123, mediaType: "text/plain" },
      { name: "sim.vcd", sha256: "c".repeat(64), sizeBytes: 456, mediaType: "application/octet-stream" },
    ];
    const detail = makeDetail({
      evidence: [evidenceEntry({ jobId: "job-5", operation: "simulate", entries })],
      audit: [toolCall("job-5", "simulate", true, undefined, "2026-08-17T10:07:00Z")],
    });
    const jobs = buildRecordJobs(detail);
    expect(jobs[0]!.entries).toEqual(entries);
  });
});
