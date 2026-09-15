import { describe, expect, test } from "bun:test";

import { assembleJobEvidenceTool } from "./job-evidence-tool.ts";
import { NoGovernanceClient } from "./types.ts";
import type { ToolExecContext } from "./agent-types.ts";

function context(
  connector: ToolExecContext["connector"],
  overrides: Partial<ToolExecContext> = {},
): ToolExecContext {
  return {
    projectId: "p-ev",
    taskId: "task-ev",
    taskKind: "main",
    governance: new NoGovernanceClient(),
    connector,
    part: "xc7k70tfbv676-1",
    classification: "internal",
    ...overrides,
  };
}

function fakeConnector(overrides: Partial<NonNullable<ToolExecContext["connector"]>> = {}) {
  const connector = {
    id: "connector-test",
    drift: false,
    discover: async () => [],
    submit: async () => {
      throw new Error("not used");
    },
    fetchEvidenceContent: async () => {
      throw new Error("not used");
    },
    ...overrides,
  } as unknown as NonNullable<ToolExecContext["connector"]>;
  return connector;
}

describe("synthia_job_evidence", () => {
  test("manifest listing returns entries without content fetches", async () => {
    const tool = assembleJobEvidenceTool();
    const connector = fakeConnector({
      fetchEvidenceManifest: async (jobId) => ({
        jobId,
        entries: [
          {
            name: "sta.rpt",
            uri: `workspace://${jobId}/output/sta.rpt`,
            sha256: "a".repeat(64),
            sizeBytes: 20129,
            mediaType: "text/plain",
          },
        ],
      }),
    });
    const out = await tool.execute({ job_id: "job-abc" }, context(connector));
    expect(out.isError).toBeUndefined();
    const payload = JSON.parse(out.content as string);
    expect(payload.schema).toBe("synthia-job-evidence-manifest.v1");
    expect(payload.job_id).toBe("job-abc");
    expect(payload.entries[0].name).toBe("sta.rpt");
    expect(payload.entries[0].content).toBeUndefined();
  });

  test("named content returns text with provenance and truncation flag", async () => {
    const tool = assembleJobEvidenceTool();
    const connector = fakeConnector({
      fetchEvidenceContent: async (_jobId, name) => ({
        content: `WNS 2.389 (${name})`,
        sha256: "b".repeat(64),
        truncated: false,
        mediaType: "text/plain",
      }),
    });
    const out = await tool.execute({ job_id: "job-abc", name: "sta.rpt" }, context(connector));
    expect(out.isError).toBeUndefined();
    const payload = JSON.parse(out.content as string);
    expect(payload.schema).toBe("synthia-job-evidence-content.v1");
    expect(payload.name).toBe("sta.rpt");
    expect(payload.content).toContain("WNS 2.389");
    expect(payload.sha256).toBe("b".repeat(64));
  });

  test("binary evidence is refused with uri/sha guidance instead of base64", async () => {
    const tool = assembleJobEvidenceTool();
    const connector = fakeConnector({
      fetchEvidenceContent: async () => ({
        content: "",
        sha256: "c".repeat(64),
        truncated: false,
        mediaType: "application/octet-stream",
      }),
    });
    const out = await tool.execute({ job_id: "job-abc", name: "routed.dcp" }, context(connector));
    expect(out.isError).toBe(true);
    expect(out.content).toContain("二进制");
  });

  test("fail-closed without connector and on invalid identifiers", async () => {
    const tool = assembleJobEvidenceTool();
    const noConnector = await tool.execute({ job_id: "job-abc" }, context(null));
    expect(noConnector.isError).toBe(true);
    expect(noConnector.content).toContain("fail-closed");

    const badId = await tool.execute({ job_id: "../etc" }, context(fakeConnector()));
    expect(badId.isError).toBe(true);

    const badName = await tool.execute(
      { job_id: "job-abc", name: "no-extension-or-worse!" },
      context(fakeConnector()),
    );
    expect(badName.isError).toBe(true);
  });

  test("worker-side fetch failure surfaces as an honest error, not silence", async () => {
    const tool = assembleJobEvidenceTool();
    const connector = fakeConnector({
      fetchEvidenceContent: async () => {
        throw new Error("JOB_NOT_FOUND");
      },
    });
    const out = await tool.execute({ job_id: "job-gone", name: "sta.rpt" }, context(connector));
    expect(out.isError).toBe(true);
    expect(out.content).toContain("JOB_NOT_FOUND");
  });
});
