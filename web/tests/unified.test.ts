import { describe, expect, test } from "bun:test";
import type { ApiClient } from "../src/api/client.ts";
import {
  approveGateSubmission,
  getGateSubmission,
  rejectGateSubmission,
} from "../src/api/index.ts";
import type { GateSubmission, GateSubmissionDetail, OutboxEvent } from "../src/api/types.ts";
import {
  approvalButtonLabel,
  approvalMilestoneLine,
  buildApproveBody,
  deriveApprovalCard,
  findApprovalSubmission,
  jobDurationText,
  jobOperationText,
  LEGACY_ROUTES,
  memberRevisionIdsFromEvents,
  rejectDisabled,
  resolveSnapshotMembers,
  unifiedRedirectTarget,
} from "../src/domain/unified.ts";

// ─── 测试夹具 ─────────────────────────────────────────────────────────

function sub(overrides: Partial<GateSubmission> & Pick<GateSubmission, "id" | "gate" | "state">): GateSubmission {
  return {
    snapshot_id: "snap-1",
    process_instance_id: "pi-1",
    submitter_id: "agent",
    submitted_at: "2026-08-17T10:00:00Z",
    created_at: "2026-08-17T10:00:00Z",
    ...overrides,
  };
}

function subDetail(overrides: Partial<GateSubmissionDetail>): GateSubmissionDetail {
  return {
    ...sub({ id: "sub-1", gate: "G3", state: "in_review", ...overrides }),
    project_id: "p1",
    check_results: { checks: [] },
    issues: [],
    ...overrides,
  };
}

/** 按 URL 前缀分发的假 client（记录调用，模拟 Core API）。 */
function fakeClient(routes: ReadonlyArray<readonly [string, (init?: { body?: unknown }) => unknown]>) {
  const calls: { path: string; body?: unknown }[] = [];
  const client = (async (path: string, init?: { body?: unknown }) => {
    calls.push({ path, body: init?.body });
    const hit = routes.find(([prefix]) => path.startsWith(prefix));
    if (!hit) throw new Error(`no fake route for ${path}`);
    return hit[1]!(init);
  }) as unknown as ApiClient;
  return { client, calls };
}

// ─── 旧路由重定向 ─────────────────────────────────────────────────────

describe("旧四路由重定向到统一项目页", () => {
  test("路由表覆盖四个旧路径", () => {
    expect(LEGACY_ROUTES.map((r) => r.path)).toEqual([
      "/projects/:id/artifacts",
      "/projects/:id/tasks",
      "/projects/:id/tasks/:runId",
      "/projects/:id/runs",
    ]);
  });

  test("产物库 → 统一页产物标签", () => {
    const rule = LEGACY_ROUTES[0]!;
    expect(unifiedRedirectTarget(rule, { id: "p1" })).toEqual({ path: "/projects/p1", query: { tab: "artifacts" } });
  });

  test("任务列表 → 统一页（默认流程标签）", () => {
    const rule = LEGACY_ROUTES[1]!;
    expect(unifiedRedirectTarget(rule, { id: "p1" })).toEqual({ path: "/projects/p1", query: {} });
  });

  test("任务工作台 → 统一页并携带 run 查询参数", () => {
    const rule = LEGACY_ROUTES[2]!;
    expect(unifiedRedirectTarget(rule, { id: "p1", runId: "run-abc" })).toEqual({
      path: "/projects/p1",
      query: { run: "run-abc" },
    });
  });

  test("运行记录 → 统一页记录标签，且保留原 run 查询参数", () => {
    const rule = LEGACY_ROUTES[3]!;
    expect(unifiedRedirectTarget(rule, { id: "p1" }, { run: "run-xyz" })).toEqual({
      path: "/projects/p1",
      query: { tab: "records", run: "run-xyz" },
    });
    expect(unifiedRedirectTarget(rule, { id: "p1" })).toEqual({ path: "/projects/p1", query: { tab: "records" } });
  });
});

// ─── 审批卡渲染条件 ───────────────────────────────────────────────────

describe("审批卡渲染条件（run awaiting + 提交状态驱动）", () => {
  const awaiting = { status: "awaiting_approval", awaiting_gate: "G3" };

  test("run 非 awaiting：不渲染任何卡", () => {
    expect(deriveApprovalCard({ status: "running", awaiting_gate: null }, sub({ id: "s", gate: "G3", state: "in_review" }))).toBe("hidden");
    expect(deriveApprovalCard({ status: "running", awaiting_gate: null }, null)).toBe("hidden");
  });

  test("run awaiting 且提交 in_review → pending", () => {
    expect(deriveApprovalCard(awaiting, sub({ id: "s", gate: "G3", state: "in_review" }))).toBe("pending");
  });

  test("run awaiting 但无提交 → hidden", () => {
    expect(deriveApprovalCard(awaiting, null)).toBe("hidden");
  });

  test("run awaiting 但提交未进入人工审批（preparing/checking）→ hidden", () => {
    expect(deriveApprovalCard(awaiting, sub({ id: "s", gate: "G3", state: "preparing" }))).toBe("hidden");
    expect(deriveApprovalCard(awaiting, sub({ id: "s", gate: "G3", state: "checking" }))).toBe("hidden");
  });

  test("批准后（提交 approved）：即使 run 仍在 awaiting 轮询窗口内也显示已批准卡", () => {
    expect(deriveApprovalCard(awaiting, sub({ id: "s", gate: "G3", state: "approved" }))).toBe("approved");
  });

  test("驳回后（提交 rejected）：已决卡在 run 离开 awaiting 后仍保留（对话记录）", () => {
    expect(deriveApprovalCard(awaiting, sub({ id: "s", gate: "G3", state: "rejected" }))).toBe("rejected");
    expect(deriveApprovalCard({ status: "fail_closed", awaiting_gate: null }, sub({ id: "s", gate: "G3", state: "rejected" }))).toBe("rejected");
  });

  test("提交门与 run 等待门不一致 → hidden", () => {
    expect(deriveApprovalCard(awaiting, sub({ id: "s", gate: "G4", state: "in_review" }))).toBe("hidden");
  });

  test("run 非 awaiting 时 in_review 提交不再渲染（等待态以 run 为准）", () => {
    expect(deriveApprovalCard({ status: "running", awaiting_gate: "G3" }, sub({ id: "s", gate: "G3", state: "in_review" }))).toBe("hidden");
  });

  test("findApprovalSubmission 取该门最新一次提交", () => {
    const older = sub({ id: "old", gate: "G3", state: "approved", created_at: "2026-08-16T00:00:00Z" });
    const newer = sub({ id: "new", gate: "G3", state: "in_review", created_at: "2026-08-17T00:00:00Z" });
    const other = sub({ id: "g4", gate: "G4", state: "in_review", created_at: "2026-08-18T00:00:00Z" });
    expect(findApprovalSubmission([older, newer, other], "G3")?.id).toBe("new");
    expect(findApprovalSubmission([other], "G3")).toBe(null);
  });
});

// ─── 里程碑 / 非里程碑文案 ────────────────────────────────────────────

describe("批准按钮与里程碑文案", () => {
  test("五个里程碑门：✓ 批准并建立 B? 里程碑", () => {
    expect(approvalButtonLabel("G1")).toBe("✓ 批准并建立 B0 需求里程碑");
    expect(approvalButtonLabel("G3")).toBe("✓ 批准并建立 B1 设计里程碑");
    expect(approvalButtonLabel("G4")).toBe("✓ 批准并建立 B2 RTL里程碑");
    expect(approvalButtonLabel("G7")).toBe("✓ 批准并建立 B3 实现里程碑");
    expect(approvalButtonLabel("G9")).toBe("✓ 批准并建立 B4 发布里程碑");
  });

  test("非里程碑门：仅「✓ 批准」", () => {
    expect(approvalButtonLabel("G2")).toBe("✓ 批准");
    expect(approvalButtonLabel("G0")).toBe("✓ 批准");
  });

  test("已批准卡里程碑行：仅里程碑门有 🏁 行", () => {
    expect(approvalMilestoneLine("G3")).toBe("🏁 已建立 B1 设计里程碑");
    expect(approvalMilestoneLine("G2")).toBe(null);
  });
});

// ─── 驳回置灰 ─────────────────────────────────────────────────────────

describe("驳回理由必填（空置灰）", () => {
  test("空串/纯空白 → 禁用", () => {
    expect(rejectDisabled("")).toBe(true);
    expect(rejectDisabled("   ")).toBe(true);
    expect(rejectDisabled("\n\t ")).toBe(true);
  });

  test("非空理由 → 可用", () => {
    expect(rejectDisabled("时序不满足")).toBe(false);
    expect(rejectDisabled(" x ")).toBe(false);
  });
});

// ─── 批准请求体（baseline_id = bl-<gate小写>-<ts>）───────────────────

describe("buildApproveBody", () => {
  test("里程碑门带 bl-g?-<ts> 形态 baseline_id", async () => {
    const body = await buildApproveBody(subDetail({ gate: "G3" }), { now: 1234567890 });
    expect(body.baseline_id).toBe("bl-g3-1234567890");
    expect(body.configuration_snapshot_id).toBe("snap-1");
    expect(body.approved_gate_result_id).toBe("agr-sub-1");
    expect(body.signature_method).toBe("platform_token");
    expect(body.check_results_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/** 按 URL 分派的假 client（路由按最长前缀优先匹配；记录调用，模拟 Core API）。 */
function fakeClient(routes: ReadonlyArray<readonly [string, (init?: { body?: unknown }) => unknown]>) {
  const sorted = [...routes].sort((a, b) => b[0].length - a[0].length);
  const calls: { path: string; body?: unknown }[] = [];
  const client = (async (path: string, init?: { body?: unknown }) => {
    calls.push({ path, body: init?.body });
    const hit = sorted.find(([prefix]) => path.startsWith(prefix));
    if (!hit) throw new Error(`no fake route for ${path}`);
    return hit[1]!(init);
  }) as unknown as ApiClient;
  return { client, calls };
}

describe("快照成员修订解析", () => {
  test("memberRevisionIdsFromEvents 取 snapshot.created payload", () => {
    const events = [
      { event_type: "snapshot.frozen", payload: { memberRevisionIds: ["r0"] } },
      { event_type: "snapshot.created", payload: { id: "snap-1", projectId: "p1", manifestHash: "h", memberRevisionIds: ["r1", "r2"] } },
    ] as OutboxEvent[];
    expect(memberRevisionIdsFromEvents(events)).toEqual(["r1", "r2"]);
    expect(memberRevisionIdsFromEvents([{ event_type: "x", payload: null } as unknown as OutboxEvent])).toBe(null);
  });

  test("resolveSnapshotMembers：修订 → GJB 文档名成员列表（mock API）", async () => {
    const { client, calls } = fakeClient([
      ["/api/v1/projects/p1/events", () => [
        { event_type: "snapshot.created", payload: { id: "snap-1", projectId: "p1", manifestHash: "h", memberRevisionIds: ["rev-a1", "rev-missing"] } },
      ]],
      ["/api/v1/projects/p1/artifacts", () => [
        { id: "a1", artifact_type: "ARCHITECTURE_DESIGN", created_at: "2026-08-17T00:00:00Z" },
        { id: "a2", artifact_type: "UNKNOWN_TYPE", created_at: "2026-08-17T00:00:00Z" },
      ]],
      ["/api/v1/projects/p1/artifacts/a1/revisions", () => [
        { id: "rev-a1", version: 2, state: "candidate", content_hash: "h", content_location: "l", title: null, created_at: "2026-08-17T01:00:00Z" },
      ]],
      ["/api/v1/projects/p1/artifacts/a2/revisions", () => []],
    ]);
    const members = await resolveSnapshotMembers(client, "p1", "snap-1");
    expect(members).not.toBe(null);
    expect(members).toHaveLength(2);
    expect(members![0]).toMatchObject({ revisionId: "rev-a1", artifactId: "a1", docName: "PLDS 结构设计说明", version: 2 });
    expect(members![1]).toMatchObject({ revisionId: "rev-missing", artifactId: null, docName: "工程文档" });
    // 事件按 aggregate 过滤查询
    expect(calls.some((c) => c.path.includes("aggregate_type=configuration_snapshot") && c.path.includes("aggregate_id=snap-1"))).toBe(true);
  });
});

// ─── 批准/驳回后流转（mock API 全链路）────────────────────────────────

describe("批准后流转（mock API）", () => {
  test("批准：POST approve 携带 baseline_id，随后 getGateSubmission 返回 approved → 卡片变已批准+里程碑", async () => {
    let state = "in_review";
    const { client, calls } = fakeClient([
      ["/api/v1/projects/p1/gate-submissions/sub-1/approve", () => ({})],
      ["/api/v1/projects/p1/gate-submissions/sub-1", () => subDetail({ state })],
    ]);

    const before = getGateSubmission(client, "p1", "sub-1");
    const detail = await before;
    expect(deriveApprovalCard({ status: "awaiting_approval", awaiting_gate: "G3" }, detail)).toBe("pending");

    await approveGateSubmission(client, "p1", "sub-1", await buildApproveBody(detail, { now: 42 }), "idem-key");
    state = "approved";

    const after = await getGateSubmission(client, "p1", "sub-1");
    expect(deriveApprovalCard({ status: "awaiting_approval", awaiting_gate: "G3" }, after)).toBe("approved");
    expect(approvalMilestoneLine(after.gate)).toBe("🏁 已建立 B1 设计里程碑");

    const approveCall = calls.find((c) => c.path.endsWith("/approve"))!;
    expect(approveCall.body).toMatchObject({ baseline_id: "bl-g3-42", configuration_snapshot_id: "snap-1" });
  });

  test("驳回：reason 必填、POST reject 后状态 rejected → 卡片变已驳回", async () => {
    let state = "in_review";
    const { client, calls } = fakeClient([
      ["/api/v1/projects/p1/gate-submissions/sub-1/reject", () => ({})],
      ["/api/v1/projects/p1/gate-submissions/sub-1", () => subDetail({ gate: "G2", state })],
    ]);

    const detail = await getGateSubmission(client, "p1", "sub-1");
    expect(deriveApprovalCard({ status: "awaiting_approval", awaiting_gate: "G2" }, detail)).toBe("pending");

    await rejectGateSubmission(client, "p1", "sub-1", "接口定义不完整", "idem-key");
    state = "rejected";

    const after = await getGateSubmission(client, "p1", "sub-1");
    expect(deriveApprovalCard({ status: "awaiting_approval", awaiting_gate: "G2" }, after)).toBe("rejected");
    expect(approvalMilestoneLine(after.gate)).toBe(null);
    expect(calls.find((c) => c.path.endsWith("/reject"))!.body).toEqual({ reason: "接口定义不完整" });
  });
});

// ─── 记录标签中文映射 ─────────────────────────────────────────────────

describe("工具运行映射（记录标签）", () => {
  test("操作名剥离 vivado_ 前缀后映射中文；未映射回退原文", () => {
    expect(jobOperationText("vivado_synthesize")).toBe("综合");
    expect(jobOperationText("vivado_validate_sources")).toBe("源文件校验");
    expect(jobOperationText("vivado_report_sta")).toBe("静态时序分析");
    expect(jobOperationText("custom_op")).toBe("custom_op");
  });

  test("耗时 = endTime − startTime；缺时间或非法 → null", () => {
    expect(jobDurationText("2026-08-17T10:00:00Z", "2026-08-17T10:00:45Z")).toBe("45s");
    expect(jobDurationText(null, "2026-08-17T10:00:45Z")).toBe(null);
    expect(jobDurationText("2026-08-17T10:01:00Z", "2026-08-17T10:00:00Z")).toBe(null);
  });
});
