/**
 * 就地审批（第二批 step 6）的回归测试，外加「打开哪一版」这条后来被产物卡复用的判定。
 *
 * 这里盯的是几个「写错了也照样跑、但线上会坏」的判定，全部是实际踩过的坑：
 * 1. 3s 轮询下的去重判据（写错 → 一次等待放大成几十个请求）；
 * 2. 决策成功后卡片是否还在（写错 → 刚点完批准卡片当场消失）；
 * 3. 幂等尝试的复用/重铸（写错 → 重试撞 409 IDEMPOTENCY_CONFLICT）；
 * 4. 错误人话化按 message 匹配（写错 → 最常见的失败落到「请重试」，让人无限重试）；
 * 5. 打开哪一版 / 跟哪一版比（写错 → 审了一份不是被提交的内容，或 diff 比错两版）。
 */
import { describe, expect, test } from "bun:test";
import { ApiError, NetworkError } from "../src/api/client.ts";
import {
  deriveApprovalCard,
  humanizeDecisionError,
  shouldFetchSubmission,
  shouldReuseApproveAttempt,
  shouldReuseRejectAttempt,
} from "../src/domain/unified.ts";
import { pickRevision, prevRevisionId, type FileTreeEntry } from "../src/views/project-view-contract.ts";
import type { ArtifactRevision, GateSubmission } from "../src/api/types.ts";

// ─── 夹具 ─────────────────────────────────────────────────────────────

function sub(state: GateSubmission["state"], gate = "G4"): GateSubmission {
  return {
    id: "sub_1",
    project_id: "p1",
    gate,
    state,
    snapshot_id: "snap_1",
    created_at: "2026-08-18T00:00:00Z",
    submitted_at: "2026-08-18T00:00:00Z",
  } as GateSubmission;
}

function rev(id: string, version: number): ArtifactRevision {
  return {
    id,
    artifact_id: "a1",
    version,
    state: "candidate",
    content_hash: `sha256:${id}`,
    created_at: "2026-08-18T00:00:00Z",
  } as ArtifactRevision;
}

const ENTRY: FileTreeEntry = {
  artifactId: "a1",
  artifactType: "PLDS_SOURCE_CODE",
  createdAt: "2026-08-18T00:00:00Z",
  revisions: [rev("r1", 1), rev("r2", 2), rev("r3", 3)],
  latestRevision: rev("r3", 3),
  path: "rtl/top.v",
  phase: "rtl_build",
  status: "registered",
};

// ─── 1. 轮询去重判据 ──────────────────────────────────────────────────

describe("shouldFetchSubmission（3s 轮询不放大成 N 个请求）", () => {
  test("进入等待态且尚未持有提交 → 拉", () => {
    expect(shouldFetchSubmission({ status: "awaiting_approval", awaiting_gate: "G4" }, null)).toBe(true);
  });

  test("已持有同门 in_review 提交 → 跳过（稳定等待期间零新增请求）", () => {
    expect(
      shouldFetchSubmission({ status: "awaiting_approval", awaiting_gate: "G4" }, { gate: "G4", state: "in_review" }),
    ).toBe(false);
  });

  test("换了另一道门 → 重新拉", () => {
    expect(
      shouldFetchSubmission({ status: "awaiting_approval", awaiting_gate: "G7" }, { gate: "G4", state: "in_review" }),
    ).toBe(true);
  });

  test("持有的提交已被决策（非 in_review）→ 重新拉，不能靠旧副本", () => {
    expect(
      shouldFetchSubmission({ status: "awaiting_approval", awaiting_gate: "G4" }, { gate: "G4", state: "approved" }),
    ).toBe(true);
  });

  test("非等待态 / 无 run → 不拉", () => {
    expect(shouldFetchSubmission({ status: "running", awaiting_gate: null }, null)).toBe(false);
    expect(shouldFetchSubmission({ status: "awaiting_approval", awaiting_gate: null }, null)).toBe(false);
    expect(shouldFetchSubmission(null, null)).toBe(false);
  });
});

// ─── 2. 决策成功后卡片仍在 ─────────────────────────────────────────────

describe("deriveApprovalCard：决策完卡片不能消失", () => {
  test("批准成功后 run 已离开等待态，已决卡仍渲染（本步踩过的坑）", () => {
    // runtime 监视循环发现 approved 会自行 resume，run 立刻变 running；
    // 此时若还按「run 不在等待态就藏」处理，刚点完批准的那张卡会当场消失。
    expect(deriveApprovalCard({ status: "running", awaiting_gate: null }, sub("approved"))).toBe("approved");
    expect(deriveApprovalCard({ status: "failed", awaiting_gate: null }, sub("rejected"))).toBe("rejected");
  });

  test("run 已离开等待态但提交仍是 in_review（本地副本过期）→ 藏，等重拉纠正", () => {
    expect(deriveApprovalCard({ status: "running", awaiting_gate: null }, sub("in_review"))).toBe("hidden");
  });

  test("等待中且提交 in_review → 可操作", () => {
    expect(deriveApprovalCard({ status: "awaiting_approval", awaiting_gate: "G4" }, sub("in_review"))).toBe("pending");
  });

  test("run 等的是另一道门 → 藏（别把上一道门的卡挂在这一道门上）", () => {
    expect(deriveApprovalCard({ status: "awaiting_approval", awaiting_gate: "G7" }, sub("in_review"))).toBe("hidden");
  });
});

// ─── 3. 幂等尝试的复用 / 重铸 ─────────────────────────────────────────

describe("幂等尝试：键与请求体必须一起冻住", () => {
  test("同一提交上失败重试 → 复用同键同体（服务端安全重放）", () => {
    const prev = { subId: "sub_1", key: "k1", body: {} };
    expect(shouldReuseApproveAttempt(prev, "sub_1")).toBe(true);
  });

  test("换了提交 → 重铸", () => {
    expect(shouldReuseApproveAttempt({ subId: "sub_1", key: "k1", body: {} }, "sub_2")).toBe(false);
    expect(shouldReuseApproveAttempt(null, "sub_1")).toBe(false);
  });

  test("驳回理由未变 → 复用；理由改了 → 必须重铸（理由参与 requestHash）", () => {
    const prev = { subId: "sub_1", key: "k1", reason: "时序不满足" };
    expect(shouldReuseRejectAttempt(prev, "sub_1", "时序不满足")).toBe(true);
    // 同键异体 → 服务端 409 IDEMPOTENCY_CONFLICT，所以这里必须是 false
    expect(shouldReuseRejectAttempt(prev, "sub_1", "命名不规范")).toBe(false);
    expect(shouldReuseRejectAttempt(prev, "sub_2", "时序不满足")).toBe(false);
  });
});

// ─── 4. 错误人话化（缺陷②回归）────────────────────────────────────────

describe("humanizeDecisionError：按 message 匹配，不是按 code", () => {
  test("400 NOT_REVIEWABLE（别人已抢先批准，最常见）→ 「已被处理过」而非兜底", () => {
    // 信封 code 恒为六个固定值之一，具体错误码在 message 里；且这条是
    // InvariantError → 400，不在 409 分支内，所以必须在 status 分支之前拦下。
    const err = new ApiError(400, { code: "validation", message: "GATE_SUBMISSION_NOT_REVIEWABLE" } as never);
    const out = humanizeDecisionError(err, "批准");
    expect(out.text).toContain("已被处理过");
    expect(out.text).not.toContain("请重试");
  });

  test("409 NOT_REJECTABLE → 同一条文案（两个码 HTTP 状态不同，行为必须一致）", () => {
    const err = new ApiError(409, { code: "conflict", message: "GATE_SUBMISSION_NOT_REJECTABLE" } as never);
    expect(humanizeDecisionError(err, "驳回").text).toContain("已被处理过");
  });

  test("409 ACTIVE_BASELINE_CONFLICT → 里程碑冲突的人话（对应后端缺陷①的修复）", () => {
    const err = new ApiError(409, { code: "conflict", message: "ACTIVE_BASELINE_CONFLICT" } as never);
    const out = humanizeDecisionError(err, "批准");
    expect(out.text).toContain("里程碑");
    expect(out.hint).not.toBeNull();
  });

  test("403 / 401 / 5xx / 网络各有专属文案，不落兜底", () => {
    expect(humanizeDecisionError(new ApiError(403, { code: "authorization", message: "FORBIDDEN" } as never), "批准").text).toContain("权限");
    expect(humanizeDecisionError(new ApiError(401, { code: "authorization", message: "UNAUTHENTICATED" } as never), "批准").text).toContain("登录");
    expect(humanizeDecisionError(new ApiError(500, { code: "internal", message: "INTERNAL" } as never), "批准").text).toContain("服务暂时不可用");
    expect(humanizeDecisionError(new NetworkError("boom"), "批准").text).toContain("网络");
  });

  test("任何一条决策失败文案都不得出现「基线」", () => {
    // redesign-v2 那道守卫只扫 .vue 的 <template>，看不见 .ts 里的字符串——
    // 里程碑冲突那条就曾漏写成「已存在生效基线（active 基线冲突）…处理旧基线」，
    // 在项目页上直接把内部术语抖给用户。这里改成对**输出**断言，覆盖全部分支。
    const errs: unknown[] = [
      new ApiError(400, { code: "validation", message: "GATE_SUBMISSION_NOT_REVIEWABLE" } as never),
      new ApiError(409, { code: "conflict", message: "ACTIVE_BASELINE_CONFLICT" } as never),
      new ApiError(409, { code: "conflict", message: "STATE_TRANSITION_CONFLICT" } as never),
      new ApiError(403, { code: "authorization", message: "FORBIDDEN" } as never),
      new ApiError(401, { code: "authorization", message: "UNAUTHENTICATED" } as never),
      new ApiError(500, { code: "internal", message: "INTERNAL" } as never),
      new ApiError(418, { code: "internal", message: "TEAPOT" } as never),
      new NetworkError("boom"),
      new Error("unknown"),
    ];
    for (const err of errs) {
      for (const action of ["批准", "驳回", "发送"] as const) {
        const out = humanizeDecisionError(err, action);
        expect(`${out.text} ${out.hint ?? ""}`, `${action} / ${String(err)}`).not.toContain("基线");
      }
    }
  });
});

// ─── 5. 待审产物按快照当时的版本打开 ──────────────────────────────────

describe("pickRevision：审批必须钉住快照当时的版本", () => {
  test("不传 → 最新版（文件树 / 对话流产物卡的既有行为）", () => {
    expect(pickRevision(ENTRY)!.id).toBe("r3");
  });

  test("传了快照里的历史版本 → 就打开那一版，不跳最新版", () => {
    // agent 提交后可能又写了 r3；按最新版审等于审了一份不是被提交的内容。
    expect(pickRevision(ENTRY, "r1")!.id).toBe("r1");
    expect(pickRevision(ENTRY, "r2")!.version).toBe(2);
  });

  test("版本已被清理 → 回落最新版（总比什么都不打开强）", () => {
    expect(pickRevision(ENTRY, "r-gone")!.id).toBe("r3");
  });

  test("盘上有、还没登记的文件 → null（正文得从工作区读，不是从修订读）", () => {
    const unregistered: FileTreeEntry = { ...ENTRY, revisions: [], latestRevision: null, status: "untracked" };
    expect(pickRevision(unregistered)).toBeNull();
    expect(pickRevision(unregistered, "r1")).toBeNull();
  });
});

// ─── 6. 对话流产物卡「查看改动」的 base（复用中栏 diff，流内不做行级 diff）──

describe("prevRevisionId：产物卡跳中栏 diff 的 base", () => {
  test("中间版本 → 前一版（revisions 按版本升序）", () => {
    expect(prevRevisionId(ENTRY, "r3")).toBe("r2");
    expect(prevRevisionId(ENTRY, "r2")).toBe("r1");
  });

  test("首版 → null（没有可比的上一版，卡上不出「查看改动」）", () => {
    expect(prevRevisionId(ENTRY, "r1")).toBeNull();
  });

  test("这一版已不在版本链里 → null，而不是错拿末位当前驱", () => {
    // findIndex 返回 -1，若写成 `at - 1` 会取到 revisions[-2]；这里守住必须是 null。
    expect(prevRevisionId(ENTRY, "r-gone")).toBeNull();
  });

  test("产物只有一版 → null", () => {
    const single: FileTreeEntry = { ...ENTRY, revisions: [rev("r1", 1)], latestRevision: rev("r1", 1) };
    expect(prevRevisionId(single, "r1")).toBeNull();
  });
});
