import { describe, expect, test } from "bun:test";
import type { JobRequest } from "./index.ts";
import { workerRequestBindingMatches } from "./server.ts";

const inputHash = "a".repeat(64);
const toolchainHash = "b".repeat(64);

function request(runClass: JobRequest["runClass"]): JobRequest {
  return {
    jobId: "job-1",
    idempotencyKey: "idem-1",
    projectId: "proj-1",
    operation: "implement",
    runClass,
    input: inputHash,
    correlationId: "corr-1",
  };
}

function candidate(runClass: JobRequest["runClass"]): Record<string, unknown> {
  return {
    jobId: "job-1",
    projectId: "proj-1",
    operation: "implement",
    runClass,
    inputHash,
    toolchainHash,
  };
}

describe("worker outer/inner request binding", () => {
  test("formal requires the exact immutable input and toolchain hashes", () => {
    expect(workerRequestBindingMatches(request("formal"), candidate("formal"), toolchainHash)).toBe(true);
    expect(workerRequestBindingMatches(
      request("formal"),
      { ...candidate("formal"), inputHash: "c".repeat(64) },
      toolchainHash,
    )).toBe(false);
    expect(workerRequestBindingMatches(
      request("formal"),
      { ...candidate("formal"), toolchainHash: "c".repeat(64) },
      toolchainHash,
    )).toBe(false);
    const missingInput = { ...candidate("formal") };
    delete missingInput.inputHash;
    expect(workerRequestBindingMatches(request("formal"), missingInput, toolchainHash)).toBe(false);
  });

  test("legacy exploratory may omit inputHash but cannot contradict it", () => {
    const legacy = { ...candidate("exploratory") };
    delete legacy.inputHash;
    delete legacy.toolchainHash;
    expect(workerRequestBindingMatches(request("exploratory"), legacy, toolchainHash)).toBe(true);
    expect(workerRequestBindingMatches(
      request("exploratory"),
      { ...legacy, inputHash: "c".repeat(64) },
      toolchainHash,
    )).toBe(false);
  });

  test("all run classes bind job, project, operation and run class", () => {
    for (const key of ["jobId", "projectId", "operation", "runClass"] as const) {
      expect(workerRequestBindingMatches(
        request("gate_check"),
        { ...candidate("gate_check"), [key]: "mismatch" },
        toolchainHash,
      )).toBe(false);
    }
  });

  test("rejects nested toolchain values that contradict the configured worker", () => {
    const configured = { vivadoBinary: "D:/Xilinx/Vivado/2021.1/bin/vivado.bat", part: "xc7k70tfbv676-1" };
    const base = {
      ...candidate("formal"),
      part: configured.part,
      toolchain: {
        vivadoBinary: configured.vivadoBinary,
        part: configured.part,
        profileHash: toolchainHash,
      },
    };
    expect(workerRequestBindingMatches(request("formal"), base, toolchainHash, configured)).toBe(true);
    expect(workerRequestBindingMatches(request("formal"), {
      ...base,
      toolchain: { ...base.toolchain, vivadoBinary: "D:/unapproved/vivado.bat" },
    }, toolchainHash, configured)).toBe(false);
    expect(workerRequestBindingMatches(request("formal"), {
      ...base,
      toolchain: { ...base.toolchain, profileHash: "c".repeat(64) },
    }, toolchainHash, configured)).toBe(false);
    expect(workerRequestBindingMatches(request("formal"), {
      ...base,
      part: "xc7a35tcsg324-1",
    }, toolchainHash, configured)).toBe(false);
  });
});
