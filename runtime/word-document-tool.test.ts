import { describe, expect, test } from "bun:test";

import type { ToolExecContext } from "./agent-types.ts";
import { assembleWordDocumentTool } from "./word-document-tool.ts";
import { NoGovernanceClient } from "./types.ts";

function context(governance: NoGovernanceClient): ToolExecContext {
  return {
    projectId: "p-word",
    taskId: "task-word",
    taskKind: "main",
    authorization: {
      schema: "task-scope.v1",
      workspace: "project",
      read_paths: ["doc/**"],
      write_paths: ["doc/**"],
      run_classes: ["exploratory"],
      can_submit_gates: true,
      can_create_milestones: true,
      can_start_formal_runs: true,
    },
    governance,
    connector: null,
    part: "xc7vx690tffg1761-2",
    classification: "internal",
  };
}

describe("synthia_word_document", () => {
  test("creates, inspects and edits governed DOCX bytes", async () => {
    const governance = new NoGovernanceClient();
    const tool = assembleWordDocumentTool();
    const created = await tool.execute({
      operation: "create_from_markdown",
      path: "doc/uart-spec.docx",
      markdown: "# UART 规格\n\n波特率 9600",
      title: "UART 规格",
    }, context(governance));
    expect(created.isError).not.toBe(true);
    expect(JSON.parse(created.content).candidate).toBe(true);

    const inspected = await tool.execute({
      operation: "inspect_text",
      path: "doc/uart-spec.docx",
    }, context(governance));
    expect(inspected.isError).not.toBe(true);
    expect(JSON.parse(inspected.content).text).toContain("波特率 9600");

    const edited = await tool.execute({
      operation: "replace_text",
      path: "doc/uart-spec.docx",
      find: "9600",
      replace: "115200",
    }, context(governance));
    expect(edited.isError).not.toBe(true);
    expect(JSON.parse(edited.content).replacements).toBe(1);

    const finalInspection = await tool.execute({
      operation: "inspect_text",
      path: "doc/uart-spec.docx",
    }, context(governance));
    expect(JSON.parse(finalInspection.content).text).toContain("波特率 115200");
    const stored = await governance.readWorkspaceFile("doc/uart-spec.docx");
    expect(Buffer.from(stored.contentBase64 ?? "", "base64").slice(0, 2)).toEqual(
      Uint8Array.from([0x50, 0x4b]),
    );
  });

  test("enforces .docx extension and Core-issued path scopes", async () => {
    const governance = new NoGovernanceClient();
    const tool = assembleWordDocumentTool();
    expect((await tool.execute({
      operation: "create_from_markdown",
      path: "doc/not-word.md",
      markdown: "x",
    }, context(governance))).isError).toBe(true);
    expect((await tool.execute({
      operation: "create_from_markdown",
      path: "rtl/not-allowed.docx",
      markdown: "x",
    }, context(governance))).isError).toBe(true);
  });
});
