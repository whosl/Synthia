import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConnectorProjectScope, RemoteConnectorAdapter } from "../src/api/connector-adapter.ts";

test("H41 Core cached clients re-read scope: add, revoke, corrupt, recover", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthia-h41-core-"));
  const path = join(root, "client.json");
  let builds = 0;
  const update = (project_scope: string[]) => writeFile(path, JSON.stringify({ connector_id: "test", project_scope }));
  const adapter = new RemoteConnectorAdapter(() => {
    builds++;
    return {
      state: "ready", hasCapabilityDrift: false,
      async register() { return { registration_state: "ready" }; },
      async heartbeat() { return { registration_state: "ready" }; },
      async discover() { return { capabilities: [] }; },
      async submit() { throw new Error("unused"); },
      async status(id: string) { return { id, state: "succeeded" }; },
      async evidence(id: string) { return { jobId: id, entries: [] }; },
      async fetchEvidenceContent() { throw new Error("unused"); },
    };
  }, { connector_id: "test", project_scope: ["p1"] }, [], {}, () => readConnectorProjectScope(path, "test"));
  try {
    await update(["p1"]);
    await adapter.queryStatus("p1", "job");
    await update(["p1", "p2"]);
    await adapter.queryStatus("p2", "job");
    expect(builds).toBe(2);
    await update(["p2"]);
    await expect(adapter.queryStatus("p1", "job")).rejects.toThrow("project not allowed");
    await writeFile(path, "{broken");
    await expect(adapter.queryStatus("p2", "job")).rejects.toThrow("scope reload failed");
    await update(["p2"]);
    await adapter.queryStatus("p2", "job");
    await writeFile(path, JSON.stringify({ connector_id: "changed", project_scope: ["p2"] }));
    await expect(adapter.queryStatus("p2", "job")).rejects.toThrow("scope reload failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
