import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VIVADO_CAPABILITIES, VivadoBatchAdapter, validateVivadoRequest, type SimulateRequest, type SynthesizeRequest } from "./vivado.ts";

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

describe("Vivado simulate contract", () => {
  const simulateRequest = (overrides: Partial<SimulateRequest> = {}): SimulateRequest => ({ operation: "simulate", jobId: "sim-1", projectId: "project-1", runClass: "exploratory", sources: [{ path: "rtl/dut.v", content: "module dut; endmodule\n" }, { path: "tb/tb.sv", content: "module tb; endmodule\n" }], top: "dut", testbench: "tb", ...overrides });
  const countingAdapter = (root: string) => { let calls = 0; const adapter = new VivadoBatchAdapter({ workspaceRoot: root, binary: "vivado", commandRunner: async () => { calls++; return { exitCode: 0, stdout: "Vivado v2025.1\n", stderr: "" }; } }); return { adapter, calls: () => calls }; };

  test("run.tcl binds the controlled DUT top and testbench and reads mixed .v/.sv sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      const adapter = new VivadoBatchAdapter({ workspaceRoot: root, binary: "vivado", commandRunner: async () => ({ exitCode: 0, stdout: "Vivado v2025.1\n", stderr: "" }) });
      const result = await adapter.execute(simulateRequest({ sources: [{ path: "rtl/dut.v", content: "module dut; endmodule\n" }, { path: "tb/tb.sv", content: "module tb; endmodule\n" }, { path: "rtl/sv_as_v.v", content: "module sv_as_v; endmodule\n", mediaType: "text/systemverilog" }] }));
      expect(result.status).toBe("succeeded");
      const tcl = await readFile(join(result.workspace, "run.tcl"), "utf8");
      const inputDir = join(result.workspace, "input");
      // Controlled binding of DUT top and testbench — never a bare default launch
      expect(tcl).toContain("create_project -in_memory");
      expect(tcl).toContain("set_property top {dut} [current_fileset]");
      expect(tcl).toContain("set_property top {tb} [get_filesets sim_1]");
      expect(tcl).toContain("update_compile_order -fileset sim_1");
      expect(tcl).toContain("launch_simulation -mode behavioral");
      expect(tcl).toContain("run all");
      // Mixed sources: .v -> read_verilog, .sv -> read_verilog -sv (no free-form paths)
      expect(tcl).toContain(`read_verilog {${join(inputDir, "rtl/dut.v")}}`);
      expect(tcl).toContain(`read_verilog -sv {${join(inputDir, "tb/tb.sv")}}`);
      // Validated mediaType selects SystemVerilog parsing regardless of extension
      expect(tcl).toContain(`read_verilog -sv {${join(inputDir, "rtl/sv_as_v.v")}}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("is fail-closed when the testbench is missing or carries an unsafe token", () => {
    expect(() => validateVivadoRequest({ ...simulateRequest(), testbench: undefined } as unknown as SimulateRequest)).toThrow("NO_TESTBENCH");
    expect(() => validateVivadoRequest(simulateRequest({ testbench: "tb; exec rm" }))).toThrow("UNSAFE_TESTBENCH");
    expect(() => validateVivadoRequest(simulateRequest({ testbench: "tb\nrun all" }))).toThrow("UNSAFE_TESTBENCH");
  });

  test("nested source paths are materialized and readable via run.tcl before the runner fires", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      const { adapter, calls } = countingAdapter(root);
      const sources = [{ path: "rtl/deep/nested/dut.v", content: "module dut; endmodule\n" }, { path: "tb/inner/tb.sv", content: "module tb; endmodule\n" }];
      const result = await adapter.execute(simulateRequest({ sources }));
      expect(result.status).toBe("succeeded");
      expect(calls()).toBe(1);
      const inputDir = join(result.workspace, "input");
      expect(await readFile(join(inputDir, "rtl/deep/nested/dut.v"), "utf8")).toBe("module dut; endmodule\n");
      expect(await readFile(join(inputDir, "tb/inner/tb.sv"), "utf8")).toBe("module tb; endmodule\n");
      const tcl = await readFile(join(result.workspace, "run.tcl"), "utf8");
      expect(tcl).toContain(`read_verilog {${join(inputDir, "rtl/deep/nested/dut.v")}}`);
      expect(tcl).toContain(`read_verilog -sv {${join(inputDir, "tb/inner/tb.sv")}}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("controlled fileset binding routes design and sim sources into the right filesets", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      const adapter = new VivadoBatchAdapter({ workspaceRoot: root, binary: "vivado", commandRunner: async () => ({ exitCode: 0, stdout: "Vivado v2025.1\n", stderr: "" }) });
      const result = await adapter.execute(simulateRequest());
      const inputDir = join(result.workspace, "input");
      const tcl = await readFile(join(result.workspace, "run.tcl"), "utf8");
      expect(tcl).toContain(`add_files -fileset sources_1 {${join(inputDir, "rtl/dut.v")}}`);
      expect(tcl).toContain(`add_files -fileset sim_1 {${join(inputDir, "tb/tb.sv")}}`);
      expect(tcl).toContain("update_compile_order -fileset sources_1");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects a mismatched top/testbench before the runner fires", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      const { adapter, calls } = countingAdapter(root);
      await expect(adapter.execute(simulateRequest({ top: "missing_top" }))).rejects.toThrow("MISSING_TOP_MODULE");
      expect(calls()).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects a duplicate module declaration before the runner fires", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      const { adapter, calls } = countingAdapter(root);
      await expect(adapter.execute(simulateRequest({ sources: [{ path: "a/dut.v", content: "module dut; endmodule\n" }, { path: "b/dut.v", content: "module dut; endmodule\n" }, { path: "tb/tb.sv", content: "module tb; endmodule\n" }] }))).rejects.toThrow("AMBIGUOUS_TOP_MODULE");
      expect(calls()).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("does not treat comment or string text as module declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      const { adapter, calls } = countingAdapter(root);
      const sources = [{ path: "rtl/dut.v", content: "// module dut; fake\n/* module dut; fake2 */\nmodule dut; endmodule\n" }, { path: "tb/tb.sv", content: 'initial $display("module dut; inside string");\nmodule tb; endmodule\n' }];
      const result = await adapter.execute(simulateRequest({ sources }));
      expect(result.status).toBe("succeeded");
      expect(calls()).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects an unknown source language before the runner fires", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      const { adapter, calls } = countingAdapter(root);
      await expect(adapter.execute(simulateRequest({ sources: [{ path: "rtl/dut.v", content: "module dut; endmodule\n" }, { path: "tb/tb.vhd", content: "entity tb is end entity;\n" }] }))).rejects.toThrow("UNSUPPORTED_SOURCE_LANGUAGE");
      expect(calls()).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects a disallowed mediaType even when the extension is allowed", () => {
    expect(() => validateVivadoRequest(simulateRequest({ sources: [{ path: "rtl/dut.v", content: "module dut; endmodule\n", mediaType: "text/vnd.arm.c" }] }))).toThrow("UNSUPPORTED_SOURCE_LANGUAGE");
  });

  test("rejects identical top and testbench role names before the runner fires", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      const { adapter, calls } = countingAdapter(root);
      await expect(adapter.execute(simulateRequest({ top: "dut", testbench: "dut" }))).rejects.toThrow("SAME_TOP_TESTBENCH");
      expect(calls()).toBe(0);
      // Fires at request-validation time regardless of which role name collides.
      expect(() => validateVivadoRequest(simulateRequest({ top: "tb", testbench: "tb" }))).toThrow("SAME_TOP_TESTBENCH");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects a single source declaring both requested top and testbench before the runner fires", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      const { adapter, calls } = countingAdapter(root);
      // One source file holds both requested roles — it must not silently bind into sim_1 and drop the DUT from sources_1.
      await expect(adapter.execute(simulateRequest({ sources: [{ path: "rtl/mixed.v", content: "module dut; endmodule\nmodule tb; endmodule\n" }] }))).rejects.toThrow("AMBIGUOUS_SOURCE_ROLE");
      expect(calls()).toBe(0);
      // Separate-file DUT/TB is still the accepted binding shape; mixed-file rejection does not affect it.
      const result = await adapter.execute(simulateRequest({ sources: [{ path: "rtl/dut.v", content: "module dut; endmodule\n" }, { path: "tb/tb.sv", content: "module tb; endmodule\n" }] }));
      expect(result.status).toBe("succeeded");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("Vivado execution result classification", () => {
  const synthesizeRequest = (overrides: Partial<SynthesizeRequest> = {}): SynthesizeRequest => ({ operation: "synthesize", jobId: "syn-1", projectId: "project-1", runClass: "exploratory", sources: [{ path: "top.v", content: "module top; endmodule\n" }], top: "top", part: "xc7vx690tffg1761-2", ...overrides });
  const discoverRequest = (jobId: string) => ({ operation: "discover_toolchain" as const, jobId, projectId: "project-1", runClass: "exploratory" as const });

  test("rejects an out-of-contract runClass and an unsafe timeoutMs at validation time", () => {
    expect(() => validateVivadoRequest({ ...synthesizeRequest(), runClass: "best_effort" as unknown as SynthesizeRequest["runClass"] })).toThrow("INVALID_RUN_CLASS");
    expect(() => validateVivadoRequest({ ...synthesizeRequest(), timeoutMs: 0 })).toThrow("INVALID_TIMEOUT");
    expect(() => validateVivadoRequest({ ...synthesizeRequest(), timeoutMs: -100 })).toThrow("INVALID_TIMEOUT");
    expect(() => validateVivadoRequest({ ...synthesizeRequest(), timeoutMs: 5.5 })).toThrow("INVALID_TIMEOUT");
    expect(() => validateVivadoRequest({ ...synthesizeRequest(), timeoutMs: Number.POSITIVE_INFINITY })).toThrow("INVALID_TIMEOUT");
    expect(() => validateVivadoRequest({ ...synthesizeRequest(), timeoutMs: "30000" as unknown as number })).toThrow("INVALID_TIMEOUT");
    // A finite positive integer within the ceiling is accepted.
    expect(() => validateVivadoRequest({ ...synthesizeRequest(), timeoutMs: 60 * 1000 })).not.toThrow();
  });

  test("treats a runner that reports a timeout as a first-class timeout outcome, not a failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      let calls = 0;
      const adapter = new VivadoBatchAdapter({ workspaceRoot: root, binary: "vivado", commandRunner: async () => { calls++; return { exitCode: 124, stdout: "", stderr: "", timedOut: true, signal: "SIGTERM" }; } });
      const result = await adapter.execute(synthesizeRequest({ timeoutMs: 1000 }));
      expect(result.status).toBe("timeout");
      expect(result.timedOut).toBe(true);
      expect(result.signal).toBe("SIGTERM");
      expect(result.timeoutMs).toBe(1000);
      expect(result.unsupportedReason).toBeUndefined();
      expect(calls).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("classifies a generic runner exception as lost, never as BINARY_UNAVAILABLE", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      let calls = 0;
      const adapter = new VivadoBatchAdapter({ workspaceRoot: root, binary: "vivado", commandRunner: async () => { calls++; throw new Error("transport severed"); } });
      const result = await adapter.execute(synthesizeRequest());
      expect(result.status).toBe("lost");
      expect(result.unsupportedReason).toBeUndefined();
      expect(calls).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("still maps a missing-binary runner error (ENOENT) to BINARY_UNAVAILABLE", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      const adapter = new VivadoBatchAdapter({ workspaceRoot: root, binary: "vivado", commandRunner: async () => { const e = new Error("not found"); (e as NodeJS.ErrnoException).code = "ENOENT"; throw e; } });
      const result = await adapter.execute(synthesizeRequest());
      expect(result.status).toBe("unsupported");
      expect(result.unsupportedReason).toBe("BINARY_UNAVAILABLE");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("keeps licenseStatus unknown on a clean discover_toolchain run and only flips on explicit evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      const clean = new VivadoBatchAdapter({ workspaceRoot: root, binary: "vivado", commandRunner: async () => ({ exitCode: 0, stdout: "Vivado v2025.1\n", stderr: "" }) });
      // discover_toolchain only runs version/get_parts — exit 0 must NOT imply a license checkout.
      const ok = await clean.execute(discoverRequest("discover-clean"));
      expect(ok.status).toBe("succeeded");
      expect(ok.toolchain.licenseStatus).toBe("unknown");
      // Explicit license checkout failure text flips to unavailable.
      const failing = new VivadoBatchAdapter({ workspaceRoot: root, binary: "vivado", commandRunner: async () => ({ exitCode: 1, stdout: "", stderr: "ERROR: License checkout failed for feature 'Synthesis'\n" }) });
      const fail = await failing.execute(discoverRequest("discover-fail"));
      expect(fail.status).toBe("unsupported");
      expect(fail.unsupportedReason).toBe("LICENSE_UNAVAILABLE");
      expect(fail.toolchain.licenseStatus).toBe("unavailable");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects a module declared twice within a single source before the runner fires", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      let calls = 0;
      const adapter = new VivadoBatchAdapter({ workspaceRoot: root, binary: "vivado", commandRunner: async () => { calls++; return { exitCode: 0, stdout: "Vivado v2025.1\n", stderr: "" }; } });
      await expect(adapter.execute({ operation: "simulate", jobId: "sim-dup", projectId: "project-1", runClass: "exploratory", sources: [{ path: "rtl/dut.v", content: "module dut; endmodule\nmodule dut; endmodule\n" }, { path: "tb/tb.sv", content: "module tb; endmodule\n" }], top: "dut", testbench: "tb" })).rejects.toThrow("AMBIGUOUS_TOP_MODULE");
      expect(calls).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("Vivado request fail-closed schema", () => {
  // Boundary contract: any malformed untyped payload entering the adapter must
  // surface a stable VIVADO_POLICY_REJECTED:<code> — never a TypeError or an
  // undefined-property crash. `request()` is a fully-typed synthesize baseline.
  test("rejects null/undefined/array/primitive requests with INVALID_REQUEST", () => {
    for (const value of [null, undefined, [], [request()], "synthesize", 42, true] as unknown[]) {
      expect(() => validateVivadoRequest(value as unknown as SynthesizeRequest)).toThrow("INVALID_REQUEST");
    }
  });

  test("rejects non-string core identifiers and operation", () => {
    expect(() => validateVivadoRequest({ ...request(), jobId: 5 } as unknown as SynthesizeRequest)).toThrow("INVALID_ID");
    expect(() => validateVivadoRequest({ ...request(), projectId: false } as unknown as SynthesizeRequest)).toThrow("INVALID_ID");
    expect(() => validateVivadoRequest({ ...request(), runClass: 1 } as unknown as SynthesizeRequest)).toThrow("INVALID_RUN_CLASS");
    expect(() => validateVivadoRequest({ ...request(), operation: 7 } as unknown as SynthesizeRequest)).toThrow("CAPABILITY_UNAVAILABLE");
  });

  test("rejects a malformed toolchain shape and member types with INVALID_TOOLCHAIN", () => {
    expect(() => validateVivadoRequest({ ...request(), toolchain: "bad" } as unknown as SynthesizeRequest)).toThrow("INVALID_TOOLCHAIN");
    expect(() => validateVivadoRequest({ ...request(), toolchain: [] } as unknown as SynthesizeRequest)).toThrow("INVALID_TOOLCHAIN");
    expect(() => validateVivadoRequest({ ...request(), toolchain: { vivadoBinary: 5 } } as unknown as SynthesizeRequest)).toThrow("INVALID_TOOLCHAIN");
    expect(() => validateVivadoRequest({ ...request(), toolchain: { requiredLicense: false } } as unknown as SynthesizeRequest)).toThrow("INVALID_TOOLCHAIN");
    expect(() => validateVivadoRequest({ ...request(), toolchain: { part: 7 } } as unknown as SynthesizeRequest)).toThrow("INVALID_TOOLCHAIN");
    expect(() => validateVivadoRequest({ ...request(), toolchain: { profileHash: null } } as unknown as SynthesizeRequest)).toThrow("INVALID_TOOLCHAIN");
  });

  test("rejects malformed sources collections and source shapes", () => {
    expect(() => validateVivadoRequest({ ...request(), sources: "top.v" } as unknown as SynthesizeRequest)).toThrow("INVALID_SOURCES");
    expect(() => validateVivadoRequest({ ...request(), sources: {} } as unknown as SynthesizeRequest)).toThrow("INVALID_SOURCES");
    expect(() => validateVivadoRequest({ ...request(), sources: [null] } as unknown as SynthesizeRequest)).toThrow("INVALID_SOURCE");
    expect(() => validateVivadoRequest({ ...request(), sources: ["top.v"] } as unknown as SynthesizeRequest)).toThrow("INVALID_SOURCE");
    expect(() => validateVivadoRequest({ ...request(), sources: [{ path: "top.v", content: "module top; endmodule\n" }, 42] } as unknown as SynthesizeRequest)).toThrow("INVALID_SOURCE");
  });

  test("rejects a non-string source.path before path safety evaluation", () => {
    expect(() => validateVivadoRequest({ ...request(), sources: [{ path: 123, content: "module top; endmodule\n" }] } as unknown as SynthesizeRequest)).toThrow("INVALID_SOURCE_PATH");
    expect(() => validateVivadoRequest({ ...request(), sources: [{ path: null, content: "module top; endmodule\n" }] } as unknown as SynthesizeRequest)).toThrow("INVALID_SOURCE_PATH");
  });

  test("rejects source.content that is neither string nor Uint8Array, but accepts both", () => {
    expect(() => validateVivadoRequest({ ...request(), sources: [{ path: "top.v", content: 123 }] } as unknown as SynthesizeRequest)).toThrow("INVALID_SOURCE_CONTENT");
    expect(() => validateVivadoRequest({ ...request(), sources: [{ path: "top.v", content: { raw: "x" } }] } as unknown as SynthesizeRequest)).toThrow("INVALID_SOURCE_CONTENT");
    expect(() => validateVivadoRequest({ ...request(), sources: [{ path: "top.v", content: null }] } as unknown as SynthesizeRequest)).toThrow("INVALID_SOURCE_CONTENT");
    expect(() => validateVivadoRequest({ ...request(), sources: [{ path: "top.v", content: new Uint8Array([0x6d]) }] })).not.toThrow();
  });

  test("rejects a non-string source.mediaType", () => {
    expect(() => validateVivadoRequest({ ...request(), sources: [{ path: "top.v", content: "module top; endmodule\n", mediaType: 5 }] } as unknown as SynthesizeRequest)).toThrow("INVALID_SOURCE_MEDIA_TYPE");
  });

  test("rejects non-string top, part, testbench, pattern and family", () => {
    expect(() => validateVivadoRequest({ ...request(), top: 9 } as unknown as SynthesizeRequest)).toThrow("INVALID_TOP");
    expect(() => validateVivadoRequest({ ...request(), part: false } as unknown as SynthesizeRequest)).toThrow("INVALID_PART");
    const simulate = { operation: "simulate" as const, jobId: "sim-1", projectId: "project-1", runClass: "exploratory" as const, sources: [{ path: "rtl/dut.v", content: "module dut; endmodule\n" }, { path: "tb/tb.sv", content: "module tb; endmodule\n" }], top: "dut", testbench: "tb" };
    expect(() => validateVivadoRequest({ ...simulate, testbench: 3 } as unknown as SynthesizeRequest)).toThrow("INVALID_TESTBENCH");
    expect(() => validateVivadoRequest({ ...simulate, testbench: null } as unknown as SynthesizeRequest)).toThrow("INVALID_TESTBENCH");
    const query = { operation: "query_parts" as const, jobId: "q-1", projectId: "project-1", runClass: "exploratory" as const };
    expect(() => validateVivadoRequest({ ...query, pattern: 11 } as unknown as SynthesizeRequest)).toThrow("INVALID_PATTERN");
    expect(() => validateVivadoRequest({ ...query, family: true } as unknown as SynthesizeRequest)).toThrow("INVALID_FAMILY");
  });

  test("never invokes the runner for a malformed request", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-vivado-"));
    try {
      let calls = 0;
      const adapter = new VivadoBatchAdapter({ workspaceRoot: root, binary: "vivado", commandRunner: async () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; } });
      await expect(adapter.execute(null as unknown as SynthesizeRequest)).rejects.toThrow("INVALID_REQUEST");
      await expect(adapter.execute({ ...request(), sources: "not-an-array" } as unknown as SynthesizeRequest)).rejects.toThrow("INVALID_SOURCES");
      await expect(adapter.execute({ ...request(), sources: [{ path: "top.v", content: 5 }] } as unknown as SynthesizeRequest)).rejects.toThrow("INVALID_SOURCE_CONTENT");
      expect(calls).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("still accepts every well-formed typed request shape", () => {
    expect(() => validateVivadoRequest(request())).not.toThrow();
    expect(() => validateVivadoRequest({ operation: "discover_toolchain", jobId: "d-1", projectId: "project-1", runClass: "exploratory" })).not.toThrow();
    expect(() => validateVivadoRequest({ operation: "query_parts", jobId: "q-1", projectId: "project-1", runClass: "exploratory", pattern: "xc7*", family: "artix7" })).not.toThrow();
  });
});
