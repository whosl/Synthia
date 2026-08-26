import { describe, expect, test } from "bun:test";

import { assembleWorkspaceReadTool } from "./workspace-read-tool.ts";
import { NoGovernanceClient } from "./types.ts";
import type { TaskAuthorizationScope, TaskWorkspaceClient } from "./task-workspace-client.ts";
import type { ToolExecContext } from "./agent-types.ts";

const MAIN_SCOPE: TaskAuthorizationScope = {
  schema: "task-scope.v1",
  workspace: "project",
  read_paths: ["doc/**", "rtl/**"],
  write_paths: ["doc/**", "rtl/**"],
  run_classes: ["exploratory"],
  can_submit_gates: true,
  can_create_milestones: true,
  can_start_formal_runs: true,
};

function context(
  governance: NoGovernanceClient,
  overrides: Partial<ToolExecContext> = {},
): ToolExecContext {
  return {
    projectId: "p-read",
    taskId: "task-read",
    taskKind: "main",
    authorization: MAIN_SCOPE,
    governance,
    connector: null,
    part: "xc7k70tfbv676-1",
    classification: "internal",
    ...overrides,
  };
}

describe("synthia_workspace_read", () => {
  test("Project Agent reads current project bytes with registered provenance", async () => {
    const governance = new NoGovernanceClient();
    const write = await governance.writeWorkspaceFiles({
      files: [{ path: "doc/requirements.md", content: "# Requirements\nUART 8N1\n" }],
    });
    const result = await assembleWorkspaceReadTool().execute(
      { path: "doc/requirements.md" },
      context(governance),
    );
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(result.content) as Record<string, unknown>;
    expect(body.path).toBe("doc/requirements.md");
    expect(body.content).toBe("# Requirements\nUART 8N1\n");
    expect(body.registered).toBe(true);
    expect(body.commit).toBe(write.commit);
  });

  test("rejects project-external and out-of-scope paths before Core access", async () => {
    const governance = new NoGovernanceClient();
    const tool = assembleWorkspaceReadTool();
    expect((await tool.execute({ path: "../golden/uart.v" }, context(governance))).isError).toBe(true);
    expect((await tool.execute({ path: "tb/uart_tb.sv" }, context(governance))).isError).toBe(true);
  });

  test("Side Agent uses only its isolated workspace capability", async () => {
    const governance = new NoGovernanceClient();
    let isolatedReads = 0;
    const workspace: TaskWorkspaceClient = {
      projectId: "p-read",
      taskId: "task-side",
      workspaceId: "ws-side",
      async appendEvent() { throw new Error("unused"); },
      async listTree() { return []; },
      async readFile(path) {
        isolatedReads++;
        return {
          path,
          content: "module side; endmodule\n",
          contentHash: "a".repeat(64),
          commit: "b".repeat(40),
        };
      },
      async writeFiles() { throw new Error("unused"); },
      async finalizeResult() { throw new Error("unused"); },
    };
    const result = await assembleWorkspaceReadTool().execute(
      { path: "rtl/side.v" },
      context(governance, {
        taskId: "task-side",
        taskKind: "side",
        workspaceId: "ws-side",
        workspace,
        authorization: { ...MAIN_SCOPE, workspace: "isolated" },
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(isolatedReads).toBe(1);
    expect(JSON.parse(result.content).isolated).toBe(true);
  });
});
