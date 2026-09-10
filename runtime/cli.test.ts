import { describe, expect, test } from "bun:test";
import { parseArgs } from "./cli.ts";

const argv = (...args: string[]): string[] => ["bun", "runtime/cli.ts", ...args];

describe("runtime CLI argument parsing", () => {
  test("resume without a placeholder task does not consume option values as the task", () => {
    const parsed = parseArgs(argv(
      "--resume", "agent-1",
      "--part", "xc7k70tfbv676-1",
      "--project", "p8",
      "--no-governance",
    ));
    expect(parsed.task).toBe("");
    expect(parsed.resumeAgentId).toBe("agent-1");
    expect(parsed.part).toBe("xc7k70tfbv676-1");
    expect(parsed.project).toBe("p8");
    expect(parsed.noGovernance).toBe(true);
  });

  test("parses an immutable external acceptance testbench pair", () => {
    const parsed = parseArgs(argv(
      "build uart",
      "--acceptance-tb", "/tmp/uart_acceptance.sv",
      "--acceptance-module", "uart_acceptance_tb",
    ));
    expect(parsed.task).toBe("build uart");
    expect(parsed.acceptanceTbPath).toBe("/tmp/uart_acceptance.sv");
    expect(parsed.acceptanceModule).toBe("uart_acceptance_tb");
  });

  test("rejects an incomplete acceptance pair and unknown options", () => {
    expect(() => parseArgs(argv("task", "--acceptance-tb", "tb.sv"))).toThrow(/supplied together/);
    expect(() => parseArgs(argv("task", "--unknown"))).toThrow(/unknown option/);
    expect(() => parseArgs(argv(
      "--resume", "agent-1",
      "--acceptance-tb", "tb.sv",
      "--acceptance-module", "tb",
    ))).toThrow(/immutable across --resume/);
  });
});
