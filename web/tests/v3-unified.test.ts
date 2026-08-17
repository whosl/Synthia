/**
 * v3 统一项目页领域规则测试（band.ts / unified.ts v3 增量 / 路由重定向沿用）：
 * - 「当前动作」一句话推导（awaiting 高亮、running 阶段+已用时、终态人话）；
 * - 等待时长人话；批准失败人话（含 active 基线冲突）；
 * - 空项目示例任务文案真实可用；旧路由重定向不回归。
 */
import { describe, expect, test } from "bun:test";
import { currentAction, terminalActionText, waitText } from "../src/domain/band.ts";
import { EXAMPLE_TASKS, humanizeDecisionError, humanizeLoadError } from "../src/domain/unified.ts";
import { ApiError, NetworkError, type ApiErrorBody } from "../src/api/client.ts";

// ─── 当前动作（状态带）──────────────────────────────────────────────

describe("currentAction：状态带「当前动作」一句话", () => {
  test("awaiting_approval → 「<审查>等待批准 · 已等待 X」，tone=awaiting", () => {
    const a = currentAction({ status: "awaiting_approval", stageName: null, awaitingReview: "行为审查", elapsedMs: 125_000 });
    expect(a.text).toBe("行为审查等待批准 · 已等待 2 分钟");
    expect(a.tone).toBe("awaiting");
  });

  test("awaiting 无审查名回退；无 elapsed 无等待后缀", () => {
    expect(currentAction({ status: "awaiting_approval", stageName: null, awaitingReview: null, elapsedMs: null }).text)
      .toBe("等待批准");
  });

  test("running → 「<阶段>中 · 已 X」；无阶段 → Agent 正在处理", () => {
    expect(currentAction({ status: "running", stageName: "综合", awaitingReview: null, elapsedMs: 65_000 }).text)
      .toBe("综合中 · 已 1 分钟");
    expect(currentAction({ status: "running", stageName: null, awaitingReview: null, elapsedMs: null }).text)
      .toBe("Agent 正在处理…");
  });

  test("终态人话；其余 idle", () => {
    expect(currentAction({ status: "succeeded", stageName: null, awaitingReview: null, elapsedMs: null }))
      .toEqual({ text: "全流程完成，码流已生成 ✅", tone: "done" });
    expect(currentAction({ status: "fail_closed", stageName: null, awaitingReview: null, elapsedMs: null }).tone)
      .toBe("failed");
    expect(currentAction({ status: "idle", stageName: null, awaitingReview: null, elapsedMs: null }).tone)
      .toBe("idle");
  });
});

describe("waitText：等待时长人话", () => {
  test("秒/分钟/小时分段", () => {
    expect(waitText(500)).toBe("1 秒");
    expect(waitText(59_000)).toBe("59 秒");
    expect(waitText(60_000)).toBe("1 分钟");
    expect(waitText(3_600_000)).toBe("1 小时");
    expect(waitText(3_900_000)).toBe("1 小时 5 分钟");
  });
});

describe("terminalActionText", () => {
  test("四终态 + 默认", () => {
    expect(terminalActionText("succeeded")).toContain("码流");
    expect(terminalActionText("interrupted")).toBe("任务已中断");
    expect(terminalActionText("whatever")).toBe("等待新指令");
  });
});

// ─── 错误人话化（spec §5/§11）───────────────────────────────────────

function apiError(status: number, code: string, message: string): ApiError {
  const body: ApiErrorBody = { code, message, retryable: false, details: null, correlation_id: "corr-1" };
  return new ApiError(status, body);
}

describe("humanizeDecisionError：批准失败人话", () => {
  test("active 基线冲突（409 baseline unique）→ 人话 + 建议，无错误码/关联号", () => {
    const f = humanizeDecisionError(apiError(409, "conflict", "baseline_unique_active_project_kind violation"), "批准");
    expect(f.text).toContain("生效基线");
    expect(f.hint).toBeTruthy();
    expect(f.text).not.toMatch(/baseline_unique|corr-1/i);
  });

  test("409 已处理过 → 状态已变化提示", () => {
    const f = humanizeDecisionError(apiError(409, "GATE_SUBMISSION_NOT_REVIEWABLE", "not reviewable"), "驳回");
    expect(f.text).toContain("已");
  });

  test("403 → 无权限；401 → 登录失效；5xx → 服务不可用+重试建议", () => {
    expect(humanizeDecisionError(apiError(403, "forbidden", "no scope"), "批准").text).toContain("权限");
    expect(humanizeDecisionError(apiError(401, "unauthorized", "x"), "批准").text).toContain("登录");
    const serverErr = humanizeDecisionError(apiError(503, "unavailable", "x"), "批准");
    expect(serverErr.text).toContain("服务暂时不可用");
    expect(serverErr.hint).toContain("重试");
  });

  test("NetworkError → 网络失败人话", () => {
    expect(humanizeDecisionError(new NetworkError("fetch failed"), "发送").text).toContain("网络");
  });
});

describe("humanizeLoadError：轮询失败人话", () => {
  test("网络/404/401/403/5xx 分支", () => {
    expect(humanizeLoadError(new NetworkError("x"))).toContain("网络");
    expect(humanizeLoadError(apiError(404, "not_found", "x"))).toContain("不存在");
    expect(humanizeLoadError(apiError(401, "u", "x"))).toContain("登录");
    expect(humanizeLoadError(apiError(403, "f", "x"))).toContain("无权");
    expect(humanizeLoadError(apiError(500, "e", "x"))).toContain("自动重试");
    expect(humanizeLoadError("weird")).toContain("自动重试");
  });
});

// ─── 空项目示例任务（spec §6：一键填入真实可用）────────────────────

describe("EXAMPLE_TASKS：示例任务卡", () => {
  test("3-4 条、均为非空中文任务描述", () => {
    expect(EXAMPLE_TASKS.length).toBeGreaterThanOrEqual(3);
    expect(EXAMPLE_TASKS.length).toBeLessThanOrEqual(4);
    for (const t of EXAMPLE_TASKS) {
      expect(t.length).toBeGreaterThan(8);
      expect(/[一-鿿]/.test(t)).toBe(true);
    }
  });
});
