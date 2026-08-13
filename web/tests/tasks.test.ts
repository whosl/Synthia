import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  AUDIT_CATEGORY_TEXT,
  STAGE_CHAIN,
  STAGE_NODE_STATUS_TEXT,
  TASK_STATUS_TEXT,
  createPoller,
  deriveStageChain,
  describeAuditEvent,
  isTerminalStatus,
  normalizeStageId,
  shortRunId,
} from "../src/domain/tasks.ts";

describe("阶段链硬编码与 Contract 一致", () => {
  test("顺序：intake→G1→behavior_wave→G2→architecture→register_spec→G3→rtl→validate→tb→simulate→xdc→synthesize→implement→G4", () => {
    expect(STAGE_CHAIN.map((n) => n.id)).toEqual([
      "intake", "G1", "behavior_wave", "G2", "architecture", "register_spec",
      "G3", "rtl", "validate", "tb", "simulate", "xdc", "synthesize", "implement", "G4",
    ]);
    expect(STAGE_CHAIN.filter((n) => n.kind === "gate").map((n) => n.id)).toEqual(["G1", "G2", "G3", "G4"]);
  });

  test("runtime 阶段别名 rtl_build 归一化为 rtl", () => {
    expect(normalizeStageId("rtl_build")).toBe("rtl");
    expect(normalizeStageId("rtl")).toBe("rtl");
  });
});

describe("阶段链状态推导", () => {
  const byId = (input: Parameters<typeof deriveStageChain>[0]) =>
    new Map(deriveStageChain(input).map(({ node, status }) => [node.id, status]));

  test("running：当前阶段进行中，之前完成，之后未开始", () => {
    const states = byId({ status: "running", current_stage: "architecture", awaiting_gate: null });
    expect(states.get("intake")).toBe("done");
    expect(states.get("G1")).toBe("done");
    expect(states.get("behavior_wave")).toBe("done");
    expect(states.get("G2")).toBe("done");
    expect(states.get("architecture")).toBe("running");
    expect(states.get("register_spec")).toBe("pending");
    expect(states.get("G4")).toBe("pending");
  });

  test("running：current_stage 为 rtl_build 别名时仍命中 rtl 节点", () => {
    const states = byId({ status: "running", current_stage: "rtl_build", awaiting_gate: null });
    expect(states.get("G3")).toBe("done");
    expect(states.get("rtl")).toBe("running");
    expect(states.get("validate")).toBe("pending");
  });

  test("awaiting_approval：等待门之前的节点全部完成，该门等待，之后未开始", () => {
    const states = byId({ status: "awaiting_approval", current_stage: "intake", awaiting_gate: "G1" });
    expect(states.get("intake")).toBe("done");
    expect(states.get("G1")).toBe("waiting");
    expect(states.get("behavior_wave")).toBe("pending");
    expect(states.get("G4")).toBe("pending");
  });

  test("awaiting_approval G3：前两个门已完成", () => {
    const states = byId({ status: "awaiting_approval", current_stage: "register_spec", awaiting_gate: "G3" });
    expect(states.get("G1")).toBe("done");
    expect(states.get("G2")).toBe("done");
    expect(states.get("register_spec")).toBe("done");
    expect(states.get("G3")).toBe("waiting");
    expect(states.get("rtl")).toBe("pending");
  });

  test("succeeded：全部完成；failed：当前节点失败；无当前阶段：全部未开始", () => {
    const done = byId({ status: "succeeded", current_stage: "implement", awaiting_gate: null });
    expect([...done.values()].every((s) => s === "done")).toBe(true);

    const failed = byId({ status: "fail_closed", current_stage: "simulate", awaiting_gate: null });
    expect(failed.get("tb")).toBe("done");
    expect(failed.get("simulate")).toBe("failed");
    expect(failed.get("xdc")).toBe("pending");

    const fresh = byId({ status: "running", current_stage: null, awaiting_gate: null });
    expect([...fresh.values()].every((s) => s === "pending")).toBe(true);
  });

  test("四种主状态文案齐备", () => {
    expect(STAGE_NODE_STATUS_TEXT.done).toBe("完成");
    expect(STAGE_NODE_STATUS_TEXT.running).toBe("进行中");
    expect(STAGE_NODE_STATUS_TEXT.waiting).toBe("等待批准");
    expect(STAGE_NODE_STATUS_TEXT.pending).toBe("未开始");
  });
});

describe("audit 事件中文映射", () => {
  test("六种类别均有中文文案", () => {
    for (const category of ["model", "gate", "tool_call", "lifecycle", "governance", "loop"]) {
      expect(AUDIT_CATEGORY_TEXT[category]).toBeTruthy();
    }
  });

  test("类别/阶段/结果映射为中文，detail 保留", () => {
    const text = describeAuditEvent({
      ts: "2026-08-13T00:00:00Z",
      seq: 7,
      category: "gate",
      phase: "gate_review",
      action: "G2: awaiting human approval",
      result: "ok",
      detail: "submission=sub-1",
    });
    expect(text).toContain("门禁");
    expect(text).toContain("门禁评审");
    expect(text).toContain("成功");
    expect(text).toContain("submission=sub-1");
  });

  test("模型类别 + 阶段别名归一化；未知类别回退原文", () => {
    const model = describeAuditEvent({
      ts: "2026-08-13T00:00:00Z",
      seq: 3,
      category: "model",
      phase: "rtl_build",
      action: "rtl generated",
      result: "ok",
    });
    expect(model).toContain("模型生成");
    expect(model).toContain("RTL 生成");

    const unknown = describeAuditEvent({
      ts: "2026-08-13T00:00:00Z",
      seq: 1,
      category: "mystery",
      phase: "nowhere",
      action: "something",
    });
    expect(unknown).toContain("mystery");
    expect(unknown).toContain("something");
  });
});

describe("轮询清理", () => {
  afterEach(() => jest.useRealTimers());

  test("tick 按间隔触发；stop 后不再触发", () => {
    jest.useFakeTimers();
    let count = 0;
    const poller = createPoller(() => {
      count += 1;
    }, 3000);
    jest.advanceTimersByTime(3000);
    expect(count).toBe(1);
    jest.advanceTimersByTime(6000);
    expect(count).toBe(3);
    poller.stop();
    jest.advanceTimersByTime(9000);
    expect(count).toBe(3);
  });

  test("tick 返回 false 时自动停止（终态停轮询）", () => {
    jest.useFakeTimers();
    let count = 0;
    createPoller(() => {
      count += 1;
      return count < 2 ? undefined : false;
    }, 3000);
    jest.advanceTimersByTime(12000);
    expect(count).toBe(2);
  });
});

describe("run 状态辅助", () => {
  test("终态判定与状态文案", () => {
    expect(isTerminalStatus("succeeded")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("fail_closed")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("awaiting_approval")).toBe(false);
    expect(TASK_STATUS_TEXT.awaiting_approval).toBe("等待批准");
  });

  test("run_id 短码", () => {
    expect(shortRunId("run-12345678-abcd-ef00")).toBe("12345678…");
    expect(shortRunId("run-abc")).toBe("abc");
  });
});
