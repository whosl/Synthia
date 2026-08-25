import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../src/hashing.ts";
import {
  P4ValidationError,
  evidenceKind,
  evidenceManifestHash,
  evidenceRole,
  evidenceVerdicts,
  hasXdcConstraintFact,
  parseDrcReport,
  parseTimingReport,
  validateEvidenceName,
  validateFormalInputContent,
  type FrozenEvidenceCandidate,
} from "../src/services/p4-formal-flow.ts";
import { validateP4EvidenceManifestLimits } from "../src/api/p4-handlers.ts";
import {
  MAX_EVIDENCE_ENTRIES,
  MAX_EVIDENCE_ENTRY_BYTES,
  MAX_EVIDENCE_TOTAL_BYTES,
} from "../src/api/connector-port.ts";

function entry(
  name: string,
  content: string,
  role = evidenceRole(name, evidenceKind(name)),
): FrozenEvidenceCandidate {
  const bytes = new TextEncoder().encode(content);
  return {
    name,
    role,
    kind: evidenceKind(name),
    sha256: sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
    mediaType: "text/plain",
    bytes,
    verdict: null,
  };
}

function resultEntry(
  name: string,
  operation: "validate_sources" | "simulate" | "synthesize" | "implement",
): FrozenEvidenceCandidate {
  return entry(name, JSON.stringify({
    schema: `${operation}-result.v1`,
    passed: true,
    status: "succeeded",
    exitCode: 0,
    timedOut: false,
  }));
}

describe("P4 Core evidence interpretation", () => {
  test("bounds evidence manifests before Core fetches or accumulates content", () => {
    expect(validateP4EvidenceManifestLimits([
      { name: "synthia.bit", sizeBytes: 32 * 1024 * 1024 },
      { name: "tool.log", sizeBytes: 1024 },
    ])).toBe(32 * 1024 * 1024 + 1024);
    expect(() => validateP4EvidenceManifestLimits([
      { name: "oversized.bit", sizeBytes: MAX_EVIDENCE_ENTRY_BYTES + 1 },
    ])).toThrow("EVIDENCE_LIMIT_EXCEEDED");
    expect(() => validateP4EvidenceManifestLimits([
      { name: "first.bit", sizeBytes: MAX_EVIDENCE_ENTRY_BYTES },
      { name: "second.bit", sizeBytes: MAX_EVIDENCE_ENTRY_BYTES },
      { name: "extra.log", sizeBytes: MAX_EVIDENCE_TOTAL_BYTES - MAX_EVIDENCE_ENTRY_BYTES * 2 + 1 },
    ])).toThrow("EVIDENCE_LIMIT_EXCEEDED");
    expect(() => validateP4EvidenceManifestLimits(Array.from(
      { length: MAX_EVIDENCE_ENTRIES + 1 },
      (_, index) => ({ name: `entry-${index}`, sizeBytes: 0 }),
    ))).toThrow("EVIDENCE_LIMIT_EXCEEDED");
  });
  test("formal input rejects cache, secret, and certificate material", () => {
    expect(() => validateFormalInputContent("rtl/.cache/top.sv", "module top; endmodule\n"))
      .toThrow(P4ValidationError);
    expect(() => validateFormalInputContent("doc/signing.pem", "not even a valid certificate"))
      .toThrow(P4ValidationError);
    expect(() => validateFormalInputContent(
      "doc/review.md",
      "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n",
    )).toThrow(P4ValidationError);
    expect(validateFormalInputContent("rtl/top.sv", "module top; endmodule\n")).toBeUndefined();
  });

  test("G0 complete constraint facts require active category-specific XDC commands", () => {
    const complete = [
      "set_property PACKAGE_PIN W5 [get_ports clk]",
      "set_property IOSTANDARD LVCMOS33 [get_ports clk]",
      "create_generated_clock -name divided [get_pins div/Q]",
    ].join("\n");
    expect(hasXdcConstraintFact(complete, "pin")).toBe(true);
    expect(hasXdcConstraintFact(complete, "electrical")).toBe(true);
    expect(hasXdcConstraintFact(complete, "clock")).toBe(true);

    const commentsOnly = [
      "# set_property PACKAGE_PIN W5 [get_ports clk]",
      "# set_property IOSTANDARD LVCMOS33 [get_ports clk]",
      "# create_clock -period 10 [get_ports clk]",
    ].join("\n");
    expect(hasXdcConstraintFact(commentsOnly, "pin")).toBe(false);
    expect(hasXdcConstraintFact(commentsOnly, "electrical")).toBe(false);
    expect(hasXdcConstraintFact(commentsOnly, "clock")).toBe(false);
  });

  test("rejects unsafe or locale-dependent evidence names", () => {
    for (const name of ["../secret", "/absolute", "nested//file", "back\\slash", "有歧义.log", "space name.log"]) {
      expect(() => validateEvidenceName(name)).toThrow(P4ValidationError);
    }
    expect(validateEvidenceName("reports/run-1/stdout.log")).toBe("reports/run-1/stdout.log");
  });

  test("manifest hashing is deterministic and independent of input order", () => {
    const first = entry("z.log", "z");
    const second = entry("a.log", "a");
    expect(evidenceManifestHash([first, second])).toBe(evidenceManifestHash([second, first]));
  });

  test("DRC and timing remain fail-closed for incomplete or negative reports", () => {
    expect(parseDrcReport("DRC finished with 0 Errors")).toEqual({ determined: true, errorCount: 0, clean: true });
    expect(parseDrcReport("Violations found: 1")).toEqual({ determined: false, errorCount: null, clean: false });
    expect(parseTimingReport("Slack (VIOLATED)\nWNS(ns) TNS(ns)\n-0.100 -0.200").met).toBe(false);
    expect(parseTimingReport("All user specified timing constraints are met.").determined).toBe(false);
  });

  test("formal implementation needs every artifact plus clean DRC and covered timing", () => {
    const entries = [
      entry("input-manifest.json", "{}"),
      entry("run.tcl", "puts ok"),
      entry("stdout.log", "IMPLEMENT_OK"),
      entry("stderr.log", ""),
      entry("tool.log", "IMPLEMENT_OK"),
      resultEntry("implementation-result.json", "implement"),
      entry("synth.dcp", "checkpoint"),
      entry("drc.rpt", "DRC finished with 0 Errors"),
      entry("sta.rpt", "Clock: clk\nWNS(ns) TNS(ns)\n0.125 0.000\nAll user specified timing constraints are met."),
      entry("resources.rpt", "resources"),
      entry("routed.dcp", "routed"),
      entry("synthia.bit", "bitstream"),
    ];
    const passed = evidenceVerdicts("implement", entries) as {
      common: Record<string, boolean>;
      implementation: { determined: boolean; passed: boolean };
      drc: { clean: boolean; errorCount: number | null };
      timing: { met: boolean; coveredClocks: string[] };
    };
    expect(Object.values(passed.common).every(Boolean)).toBe(true);
    expect(passed.implementation).toMatchObject({ determined: true, passed: true });
    expect(passed.drc).toMatchObject({ clean: true, errorCount: 0 });
    expect(passed.timing.met).toBe(true);
    expect(passed.timing.coveredClocks.length).toBeGreaterThan(0);

    const missingBitstream = evidenceVerdicts("implement", entries.filter((item) => item.name !== "synthia.bit")) as {
      implementation: { determined: boolean; passed: boolean };
    };
    expect(missingBitstream.implementation).toEqual(expect.objectContaining({ determined: false, passed: false }));

    const missingResult = evidenceVerdicts("implement", entries.filter((item) => item.role !== "implementation_result")) as {
      implementation: { determined: boolean; passed: boolean };
    };
    expect(missingResult.implementation).toEqual(expect.objectContaining({ determined: false, passed: false }));
  });

  test("operation verdicts require Core-parseable result evidence, not only a log marker", () => {
    const validationLog = entry("stdout.log", "SOURCE_VALIDATION_OK\n");
    expect(evidenceVerdicts("validate_sources", [validationLog])).toMatchObject({
      validation: { determined: false, passed: false },
    });
    expect(evidenceVerdicts("validate_sources", [
      validationLog,
      resultEntry("validation-result.json", "validate_sources"),
    ])).toMatchObject({ validation: { determined: true, passed: true } });

    const simulationLog = entry(
      "stdout.log",
      "SIMULATOR_OUTPUT_BEGIN\nPASS\nSIMULATOR_OUTPUT_END\nPHASE_EXIT_CODE=0\nSIMULATION_OK\n",
    );
    expect(evidenceVerdicts("simulate", [simulationLog])).toMatchObject({
      simulation: { determined: false, passed: false },
    });
    expect(evidenceVerdicts("simulate", [
      simulationLog,
      resultEntry("simulation-result.json", "simulate"),
    ])).toMatchObject({ simulation: { determined: true, passed: true } });

    expect(evidenceVerdicts("synthesize", [entry("resources.rpt", "resources")])).toMatchObject({
      synthesis: { determined: false, passed: false },
    });
    expect(evidenceVerdicts("synthesize", [
      entry("resources.rpt", "resources"),
      resultEntry("synthesis-result.json", "synthesize"),
    ])).toMatchObject({ synthesis: { determined: true, passed: true } });
  });
});
