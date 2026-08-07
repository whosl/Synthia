import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VIVADO_CAPABILITIES, VivadoBatchAdapter, validateVivadoRequest, type SynthesizeRequest } from "./vivado.ts";

const request = (jobId = "job-1"): SynthesizeRequest => ({ operation: "synthesize", jobId, projectId: "project-1", runClass: "exploratory", sources: [{ path: "top.v", content: "module top; endmodule\n" }], top: "top", part: "xc7vx690tffg1761-2" });

describe("Vivado batch adapter", () => {
  test("exposes all frozen typed capabilities and rejects unsafe inputs", () => {
    expect(VIVADO_CAPABILITIES.map(capability => capability.operation)).toEqual(["discover_toolchain", "query_parts", "validate_sources", "simulate", "synthesize", "report_drc", "report_sta", "report_resources"]);
    expect(() => validateVivadoRequest({ ...request(), sources: [{ path: "../escape.v", content: "module x; endmodule" }] })).toThrow("UNSAFE_PATH");
    expect(() => validateVivadoRequest({ ...request(), top: "top; exec rm" })).toThrow("UNSAFE_TOP");
  });

  test("uses an injected runner and records SHA-256 evidence references", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      const adapter = new VivadoBatchAdapter({ workspaceRoot: root, binary: "/opt/Vivado/2025.1/bin/vivado", commandRunner: async (_command, _args, cwd) => { await writeFile(join(cwd, "output", "drc.rpt"), "report\n"); return { exitCode: 0, stdout: "Vivado v2025.1\n", stderr: "" }; } });
      const result = await adapter.execute({ ...request(), operation: "report_drc" });
      expect(result.status).toBe("succeeded");
      expect(result.command).toContain("-mode");
      expect(result.workspace).toBe(join(root, "job-1"));
      expect(result.evidence.entries[0]).toMatchObject({ name: "drc.rpt", uri: "workspace://job-1/output/drc.rpt", sizeBytes: 7, mediaType: "text/plain" });
      expect(result.evidence.entries[0]?.sha256).toBe("331d26d6d8f862e46ba900811be8a7a1e4dbaa229b14c99becfd5e5151490d95");
      expect((await readFile(join(result.workspace, "run.tcl"), "utf8"))).toContain("synth_design");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("returns explicit unsupported when the real binary is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      const result = await new VivadoBatchAdapter({ workspaceRoot: root, binary: "/missing/vivado" }).execute({ operation: "discover_toolchain", jobId: "discover-1", projectId: "project-1", runClass: "exploratory" });
      expect(result.status).toBe("unsupported");
      expect(result.unsupportedReason).toBe("BINARY_UNAVAILABLE");
      expect(result.toolchain.licenseStatus).toBe("unknown");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
