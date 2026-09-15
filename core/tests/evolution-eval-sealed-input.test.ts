import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  canonicalEvolutionEvalSealedInputProjection,
  canonicalEvolutionEvalWorkspaceManifest,
} from "../src/domain/evolution-eval.ts";
import type { TransactionClient } from "../src/db/repository.ts";
import type { CoreIssuedEvalBinding } from "../src/services/evolution-eval-connector-port.ts";
import { loadEvolutionEvalSealedInput } from "../src/services/evolution-eval-sealed-input.ts";

const DEADLINE = "2026-08-27T03:00:00.000Z";

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(sourcePath = "rtl/top.sv") {
  const source = Buffer.from("module top; endmodule\n", "utf8");
  const skill = Buffer.from("puts {inert guidance only}\n", "utf8");
  const files = [
    { path: sourcePath, sha256: sha(source), size_bytes: source.byteLength, media_type: "text/x-systemverilog", layer: "source" as const, read_only: true, managed_content: source },
    { path: "scripts/check.tcl", sha256: sha(skill), size_bytes: skill.byteLength, media_type: "text/plain", layer: "skill" as const, read_only: true, managed_content: skill },
  ];
  const canonical = canonicalEvolutionEvalWorkspaceManifest({
    schema: "evolution-eval-workspace-manifest.v1",
    workspace_id: "workspace-1",
    revision: 1,
    files: files.map(({ managed_content: _content, ...file }) => file),
  });
  const binding: CoreIssuedEvalBinding = {
    project_id: "project-1",
    dispatch_request_hash: "d".repeat(64),
    dispatch: {
      schema: "evolution-eval-dispatch-request.v1",
      eval_job_id: "job-1",
      connector_job_id: "connector-job-1",
      connector_idempotency_key: "e".repeat(64),
      eval_input_ref: "input-1",
      input_manifest_hash: "f".repeat(64),
      workspace_id: "workspace-1",
      workspace_revision: 1,
      workspace_manifest_hash: canonical.sha256,
      sealed_input_projection_hash: canonicalEvolutionEvalSealedInputProjection(canonical.manifest).sha256,
      operation: "synthesize",
      parameters: { operation: "synthesize", source_paths: [sourcePath], top: "top", part: "xc7a35tcpg236-1" },
      part: "xc7a35tcpg236-1",
      toolchain_profile_hash: "a".repeat(64),
      requested_timeout_ms: 60_000,
      operation_cap_ms: 7_200_000,
      deadline_at: DEADLINE,
      run_class: "evolution_eval",
    },
  };
  const revision = {
    current_revision: 1,
    sealed_at: new Date(),
    discarded_at: null,
    manifest: canonical.manifest,
    manifest_hash: canonical.sha256,
    file_count: 2,
    total_bytes: source.byteLength + skill.byteLength,
    source_files: 1,
    source_bytes: source.byteLength,
    skill_files: 1,
    skill_bytes: skill.byteLength,
    overlay_files: 0,
    overlay_bytes: 0,
  };
  return { binding, files, revision };
}

function database(
  value = fixture(),
  overrides: { toolState?: string; dispatchHash?: string } = {},
): TransactionClient & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string) {
      calls.push(sql.trim().replace(/\s+/g, " "));
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("SELECT curator_run_id,tool_run_id FROM evolution_eval_job")) return { rows: [{ curator_run_id: "run-1", tool_run_id: "tool-1" }] };
      if (sql.includes("FROM curator_run")) return { rows: [{ id: "run-1" }] };
      if (sql.includes("FROM evolution_eval_run")) return { rows: [{ curator_run_id: "run-1" }] };
      if (sql.includes("FROM evolution_eval_job job")) return { rows: [{
        id: "job-1", project_id: "project-1", tool_run_id: "tool-1",
        connector_job_id: "connector-job-1", connector_idempotency_key: "e".repeat(64),
        eval_input_ref: "input-1", input_manifest_hash: "f".repeat(64), workspace_id: "workspace-1",
        operation: "synthesize", parameters: value.binding.dispatch.parameters,
        part: "xc7a35tcpg236-1", toolchain_profile_hash: "a".repeat(64), deadline_at: DEADLINE,
      }] };
      if (sql.includes("FROM tool_run")) return { rows: [{ state: overrides.toolState ?? "running" }] };
      if (sql.includes("FROM evolution_eval_dispatch WHERE")) return { rows: [{
        workspace_id: "workspace-1", workspace_revision: 1,
        workspace_manifest_hash: value.binding.dispatch.workspace_manifest_hash,
        sealed_input_projection_hash: value.binding.dispatch.sealed_input_projection_hash,
        dispatch_request_hash: overrides.dispatchHash ?? value.binding.dispatch_request_hash,
        requested_timeout_ms: 60_000, operation_cap_ms: 7_200_000, deadline_at: DEADLINE,
      }] };
      if (sql.includes("FROM evolution_eval_dispatch_tombstone")) return { rows: [] };
      if (sql.includes("FROM evolution_eval_workspace_projection")) return { rows: [value.revision] };
      if (sql.includes("FROM evolution_eval_workspace_file")) return { rows: value.files };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

async function collect(input: Awaited<ReturnType<typeof loadEvolutionEvalSealedInput>>) {
  const result: Array<{ path: string; bytes: Buffer }> = [];
  for await (const file of input.files) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of file.content) chunks.push(chunk);
    result.push({ path: file.path, bytes: Buffer.concat(chunks) });
  }
  return result;
}

describe("loadEvolutionEvalSealedInput", () => {
  test("binds the non-Skill projection manifest and streams exactly its bytes after commit", async () => {
    const value = fixture();
    const db = database(value);
    const input = await loadEvolutionEvalSealedInput(db, value.binding);
    expect(input.manifest).toEqual(canonicalEvolutionEvalWorkspaceManifest(input.manifest).manifest);
    expect(input.manifest.files.map(file => [file.path, file.layer])).toEqual([
      ["rtl/top.sv", "source"],
    ]);
    expect((await collect(input)).map(file => file.path)).toEqual(["rtl/top.sv"]);
    expect(db.calls.at(-1)).toBe("COMMIT");
    expect(db.calls.join(" ")).not.toContain("/Users/");
  });

  test("rejects binding drift and never returns bytes from a non-running fence", async () => {
    const value = fixture();
    await expect(loadEvolutionEvalSealedInput(database(value, { dispatchHash: "0".repeat(64) }), value.binding))
      .rejects.toThrow("Core-issued binding drifted");
    await expect(loadEvolutionEvalSealedInput(database(value, { toolState: "submitted" }), value.binding))
      .rejects.toThrow("only be loaded after the running fence");
  });

  test("fails closed when the durable or Core-issued sealed-input projection hash drifts", async () => {
    const value = fixture();
    const durableDrift = {
      ...value,
      binding: {
        ...value.binding,
        dispatch: {
          ...value.binding.dispatch,
          sealed_input_projection_hash: "0".repeat(64),
        },
      },
    };
    await expect(loadEvolutionEvalSealedInput(database(durableDrift), value.binding))
      .rejects.toThrow("Core-issued binding drifted");

    await expect(loadEvolutionEvalSealedInput(database(value), {
      ...value.binding,
      dispatch: {
        ...value.binding.dispatch,
        sealed_input_projection_hash: "1".repeat(64),
      },
    })).rejects.toThrow("Core-issued binding drifted");

    await expect(loadEvolutionEvalSealedInput(database(durableDrift), durableDrift.binding))
      .rejects.toThrow("sealed input projection hash drifted");
  });

  test("stages Skill files for exact hash binding but forbids selecting them as Vivado inputs", async () => {
    const base = fixture();
    const value = {
      ...base,
      binding: {
        ...base.binding,
        dispatch: {
          ...base.binding.dispatch,
          parameters: {
            operation: "synthesize" as const,
            source_paths: ["scripts/check.tcl"],
            top: "top",
            part: "xc7a35tcpg236-1",
          },
        },
      },
    };
    await expect(loadEvolutionEvalSealedInput(database(value), value.binding))
      .rejects.toThrow(/Skill assets|forbidden extension/);
  });

  test("re-hashes durable bytes and fails closed on content or budget drift", async () => {
    const value = fixture();
    const corrupted = { ...value, files: value.files.map((file, index) => index === 0 ? { ...file, managed_content: Buffer.from("changed") } : file) };
    await expect(loadEvolutionEvalSealedInput(database(corrupted), corrupted.binding))
      .rejects.toThrow(/size drifted|hash drifted/);
    const overBudget = { ...value, revision: { ...value.revision, source_files: 4097 } };
    await expect(loadEvolutionEvalSealedInput(database(overBudget), overBudget.binding))
      .rejects.toThrow("source counters drifted");
  });
});
