import { describe, expect, test } from "bun:test";
import { diagnosticExcerpt, diagnosticExcerptParts, fetchDiagnostics } from "./vivado-tool.ts";

/** The exact shape of stdout that blinded the p5 repair loop (job-a428aea0). */
const P5_STDOUT_TAIL = [
  "PHASE=simulate",
  "PHASE_EXIT_CODE=0",
  'SIMULATOR_OUTPUT_BEGIN',
  '"xsim tb_top_behav -key {Behavioral:sim_1:Functional:tb_top}"',
  "Time resolution is 1 ps",
  "INFO  [TX0F] begin",
  "INFO  [TX0F] end",
  "INFO  [B2B] begin",
  "ERROR [B2B] start-to-start interval 312520000 ns, expected 1041700±20 ns",
  "INFO  [B2B] end",
  "INFO  [END] begin",
  "ERROR [END] rx_done count 11, expected 10",
  "INFO  [END] end",
  "$finish called at time 313 ms",
].join("\r\n");

function p5ShapedStdout(): string {
  const noise = Array.from({ length: 60 }, (_, i) => `INFO: [ProjectBase 1-489] project setup noise ${i}`).join("\r\n");
  return `****** Vivado v2021.1 (64-bit)\r\n${noise}\r\n${P5_STDOUT_TAIL}`;
}

describe("diagnosticExcerpt (content-aware fallback)", () => {
  test("short input is returned whole", () => {
    const s = "Vivado v2021.1\nERROR: [Common 17-39] nope\n";
    expect(diagnosticExcerpt(s)).toBe(s);
  });

  test("the p5-shaped log keeps every ERROR with its scenario banner despite the long noise head", () => {
    const out = diagnosticExcerpt(p5ShapedStdout());
    expect(out).toContain("ERROR [B2B] start-to-start interval 312520000 ns");
    expect(out).toContain("expected 1041700");
    expect(out).toContain("ERROR [END] rx_done count 11");
    // The scenario attribution banner travels with the error.
    const b2b = out.indexOf("ERROR [B2B]");
    expect(out.lastIndexOf("INFO  [B2B] begin")).toBeLessThan(b2b);
    expect(out.lastIndexOf("INFO  [B2B] begin")).toBeGreaterThan(b2b - 200);
    // Phase trail present.
    expect(out).toContain("PHASE=simulate");
    // The head is preserved as a small banner, not 2000 chars of noise.
    expect(out).toContain("****** Vivado v2021.1");
    expect(out.length).toBeLessThanOrEqual(2000 + 600);
  });

  test("errors anywhere — head, middle, and tail — all survive", () => {
    const lines: string[] = ["ERROR [HEAD] first"];
    for (let i = 0; i < 100; i++) lines.push(`filler ${i}`);
    lines.push("ERROR [MID] middle");
    for (let i = 0; i < 100; i++) lines.push(`filler tail ${i}`);
    lines.push("ERROR [TAIL] last");
    const out = diagnosticExcerpt(lines.join("\n"));
    expect(out).toContain("ERROR [HEAD] first");
    expect(out).toContain("ERROR [MID] middle");
    expect(out).toContain("ERROR [TAIL] last");
  });

  test("parts carry explicit kinds so consumers can render them", () => {
    const parts = diagnosticExcerptParts(p5ShapedStdout());
    expect(parts[0]!.kind).toBe("head");
    expect(parts.some(p => p.kind === "failure")).toBeTrue();
    expect(parts.some(p => p.kind === "phase")).toBeTrue();
  });
});

describe("fetchDiagnostics (worker-version preference chain)", () => {
  const digestPayload = {
    schema: "synthia-log-digest.v1",
    operation: "simulate",
    counts: { failure: 2, warning: 0, pass: 0 },
    failureLines: [
      { source: "simulator", index: 9, line: "ERROR [B2B] start-to-start interval 312520000 ns", contextBefore: ["INFO  [B2B] begin"] },
      { source: "simulator", index: 12, line: "ERROR [END] rx_done count 11, expected 10" },
    ],
    warningLines: [], passLines: [], phaseMarkers: ["PHASE=simulate"],
    scanned: { stdout: 4050, stderr: 0, simulator: 1709 },
    truncated: false,
  };

  function fakeConnector(files: Record<string, unknown>) {
    const calls: string[] = [];
    return {
      calls,
      async fetchEvidenceContent(_jobId: string, name: string) {
        calls.push(name);
        if (!(name in files)) throw new Error("EVIDENCE_NOT_AVAILABLE");
        return { content: JSON.stringify(files[name]) };
      },
    };
  }

  test("prefers the dedicated log-digest.json when present", async () => {
    const c = fakeConnector({ "log-digest.json": digestPayload });
    const r = await fetchDiagnostics(c, "job-1", [{ name: "log-digest.json" }, { name: "worker-result.json" }]);
    expect(r!.source).toBe("log-digest.json");
    expect(r!.digest!.counts!.failure).toBe(2);
    expect(c.calls).toEqual(["log-digest.json"]);
  });

  test("old worker: falls back to worker-result.json logDigest, then to smart excerpts", async () => {
    const c = fakeConnector({ "worker-result.json": { exitCode: 0, phase: "simulate", stdout: p5ShapedStdout(), simulatorStdout: P5_STDOUT_TAIL.slice(P5_STDOUT_TAIL.indexOf("INFO  [TX0F]")) } });
    const r = await fetchDiagnostics(c, "job-1", [{ name: "worker-result.json" }]);
    expect(r!.source).toBe("worker-result.json");
    // Even the legacy path now surfaces the assertions (content-aware excerpt).
    const stdout = String((r!.diagnostics as Record<string, unknown>).stdout);
    expect(stdout).toContain("ERROR [B2B] start-to-start interval 312520000 ns");
    expect(stdout).toContain("expected 1041700");
  });

  test("embedded logDigest in worker-result.json is picked up and passed through", async () => {
    const c = fakeConnector({ "worker-result.json": { exitCode: 0, logDigest: digestPayload } });
    const r = await fetchDiagnostics(c, "job-1", [{ name: "worker-result.json" }]);
    expect(r!.source).toBe("worker-result.json");
    expect(r!.digest!.counts!.failure).toBe(2);
    expect(r!.digest).toEqual(digestPayload);
    expect((r!.diagnostics as Record<string, unknown>).logDigest).toBeDefined();
  });

  test("no diagnostics evidence at all → undefined, caller keeps the manifest summary", async () => {
    const c = fakeConnector({});
    const r = await fetchDiagnostics(c, "job-1", [{ name: "drc.rpt" }]);
    expect(r).toBeUndefined();
    expect(c.calls).toEqual([]);
  });
});
