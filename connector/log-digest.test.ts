import { describe, expect, test } from "bun:test";
import {
  buildLogDigest,
  CONTEXT_LINES,
  LINE_CHAR_CAP,
  MAX_FAILURE_LINES,
} from "./log-digest.ts";

/**
 * Realistic Vivado simulate stdout: long project-generation noise head, then
 * phase markers, then the simulator region with interleaved scenario banners
 * and assertions — the shape that blinded the p5 repair loop.
 */
function vivadoSimulateStdout(simRegion: string, jobId = "job-x"): string {
  const noise = Array.from({ length: 30 }, (_, i) =>
    `INFO: [USF-XSim-60] Script generated:D:/synthia-worker/workspaces/${jobId}/vivado-project/synthia_batch.sim/sim_1/behav/xsim/step${i}.bat`,
  ).join("\r\n");
  return `****** Vivado v2021.1 (64-bit)\r\n${noise}\r\nINFO: [USF-XSim-4] XSim::Simulate design\r\nPHASE=simulate\r\nPHASE_EXIT_CODE=0\r\nSIMULATOR_OUTPUT_BEGIN\r\n${simRegion}\r\nSIMULATOR_OUTPUT_END\r\n`;
}

describe("buildLogDigest", () => {
  test("captures TB assertions wherever they sit, with scenario banner context", () => {
    const simRegion = [
      "INFO  [TX0F] begin",
      "INFO  [TX0F] end",
      "INFO  [B2B] begin",
      "ERROR [B2B] start-to-start interval 312520000 ns, expected 1041700±20 ns",
      "INFO  [B2B] end",
      "INFO  [END] begin",
      "ERROR [END] rx_done count 11, expected 10",
      "INFO  [END] end",
    ].join("\r\n");
    const digest = buildLogDigest("simulate", { stdout: vivadoSimulateStdout(simRegion), simulator: simRegion });

    expect(digest.schema).toBe("synthia-log-digest.v1");
    expect(digest.counts.failure).toBe(2);
    expect(digest.counts.pass).toBe(0);
    // Both assertions attributed to the simulator stream, not double-counted
    // against the echoed region inside stdout.
    expect(digest.failureLines).toHaveLength(2);
    expect(digest.failureLines.every(l => l.source === "simulator")).toBeTrue();
    const b2b = digest.failureLines.find(l => l.line.includes("start-to-start"))!;
    expect(b2b.line).toContain("312520000 ns");
    expect(b2b.line).toContain("1041700");
    // The scenario banner survives as context.
    expect(b2b.contextBefore).toContain("INFO  [B2B] begin");
    expect(digest.phaseMarkers).toContain("PHASE=simulate");
    expect(digest.phaseMarkers).toContain("PHASE_EXIT_CODE=0");
    expect(digest.scanned.simulator).toBe(simRegion.length);
    expect(digest.truncated).toBeFalse();
  });

  test("PASS markers land in passLines with counts, Vivado warnings in warningLines", () => {
    const simRegion = "INFO [SC1] begin\nPASS\nINFO [SC1] end\nALL TESTS PASSED";
    const stdout = vivadoSimulateStdout(simRegion) + "CRITICAL WARNING: [Vivado 12-1] something\r\nWARNING: [Common 17-3] else\r\n";
    const digest = buildLogDigest("simulate", { stdout, simulator: simRegion });
    expect(digest.counts.pass).toBe(2);
    expect(digest.passLines.map(l => l.line.trim())).toEqual(["PASS", "ALL TESTS PASSED"]);
    expect(digest.counts.warning).toBe(2);
    expect(digest.warningLines[0]!.line).toContain("CRITICAL WARNING");
  });

  test("a short log (the ~1000-char case) needs no window at all — everything is classified", () => {
    const stdout = "Vivado v2021.1\nERROR: [Common 17-39] bad thing\nPHASE=elaborate\nPHASE_EXIT_CODE=1\n";
    const digest = buildLogDigest("simulate", { stdout });
    expect(digest.counts.failure).toBe(1);
    expect(digest.failureLines[0]!.source).toBe("stdout");
    expect(digest.counts.pass).toBe(0);
    expect(digest.truncated).toBeFalse();
  });

  test("a long scattered log (the 5000+ char case) still captures every error position", () => {
    const scenarios = Array.from({ length: 10 }, (_, i) => {
      const filler = Array.from({ length: 40 }, (_, j) => `idle chatter line ${i}-${j}`).join("\n");
      return `${filler}\nINFO [S${i}] begin\nERROR [S${i}] failure number ${i}\nINFO [S${i}] end`;
    }).join("\n");
    const digest = buildLogDigest("simulate", { stdout: vivadoSimulateStdout(scenarios), simulator: scenarios });
    // All 10 errors captured regardless of position; head/middle/tail alike.
    expect(digest.failureLines).toHaveLength(10);
    expect(digest.counts.failure).toBe(10);
    const withContext = digest.failureLines.filter(l => (l.contextBefore ?? []).includes("INFO [S9] begin"));
    expect(withContext).toHaveLength(1);
  });

  test("more than MAX_FAILURE_LINES errors are capped with counts and truncated flag", () => {
    const simRegion = Array.from({ length: MAX_FAILURE_LINES + 7 }, (_, i) => `ERROR [S${i}] boom ${i}`).join("\n");
    const digest = buildLogDigest("simulate", { stdout: vivadoSimulateStdout(simRegion), simulator: simRegion });
    expect(digest.failureLines).toHaveLength(MAX_FAILURE_LINES);
    expect(digest.counts.failure).toBe(MAX_FAILURE_LINES + 7);
    expect(digest.truncated).toBeTrue();
  });

  test("oversized single lines are capped; Vivado-style ERROR: lines classify from stdout", () => {
    const long = "ERROR [B2B] " + "x".repeat(5000);
    const digest = buildLogDigest("simulate", { stdout: vivadoSimulateStdout(long), simulator: long });
    expect(digest.failureLines[0]!.line.length).toBeLessThanOrEqual(LINE_CHAR_CAP + 1);
    const vivadoStyle = buildLogDigest("synthesize", { stdout: "ERROR: [Vivado 12-1411] cannot find port\nWARNING: [Synth 8-3331] unconnected\n" });
    expect(vivadoStyle.counts.failure).toBe(1);
    expect(vivadoStyle.failureLines[0]!.source).toBe("stdout");
    expect(vivadoStyle.counts.warning).toBe(1);
  });

  test("context window is bounded at CONTEXT_LINES non-empty lines, skipping blanks", () => {
    const simRegion = "a\r\n\r\nb\r\n\r\nc\r\nERROR [X] late";
    const digest = buildLogDigest("simulate", { stdout: vivadoSimulateStdout(simRegion), simulator: simRegion });
    expect(digest.failureLines[0]!.contextBefore).toEqual(["b", "c"]);
    expect(CONTEXT_LINES).toBe(2);
  });

  test("simulate region inside stdout is not double-counted when simulator stream provided", () => {
    const simRegion = "ERROR [A] once";
    const digest = buildLogDigest("simulate", { stdout: vivadoSimulateStdout(simRegion), simulator: simRegion });
    expect(digest.counts.failure).toBe(1);
  });
});
