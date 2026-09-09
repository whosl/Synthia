import { describe, expect, test } from "bun:test";
import {
  canonicalEvolutionEvalEvidenceManifest,
  canonicalEvolutionEvalSealedInputProjection,
  canonicalEvolutionEvalWorkspaceManifest,
  evolutionEvalCanonicalHash,
  evolutionEvalCanonicalJson,
  portableEvolutionEvalPath,
  validateEvolutionEvalParameters,
  vivadoMediaTypeForPath,
} from "../src/domain/evolution-eval.ts";
import { scanEvolutionEvalXdc } from "../src/services/evolution-eval-xdc-scan.ts";

describe("evolution-eval frozen domain contract", () => {
  test("uses NFC RFC 8785 canonical JSON rather than generic stable stringify", () => {
    const value = {
      z: null,
      b: 1e30,
      a: [3, { y: true, x: "é" }],
    };
    const canonical = '{"a":[3,{"x":"é","y":true}],"b":1e+30,"z":null}';
    expect(evolutionEvalCanonicalJson(value)).toBe(canonical);
    expect(evolutionEvalCanonicalHash(value)).toBe(
      "495ac7c5bcf3d83b81b21fcc5e672995c0222559ffffec703ee6894488bcd2a1",
    );
    expect(() => evolutionEvalCanonicalJson({ value: "e\u0301" }))
      .toThrow("must be NFC normalized");
    expect(() => evolutionEvalCanonicalJson({ value: Number.NaN }))
      .toThrow("finite JSON number");
    expect(() => evolutionEvalCanonicalJson({ value: undefined }))
      .toThrow("not a JSON value");
  });

  test("matches the RFC 8785 number/string and UTF-16 property-order vectors", () => {
    expect(evolutionEvalCanonicalJson({
      numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 0.000000000000000000000000001],
      string: "€$\u000f\nA'B\"\\\"/",
      literals: [null, true, false],
    })).toBe(
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\"/\"}",
    );
    const officialPropertyVector = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    // RFC 8785 itself permits the presentation-form key; the frozen eval
    // contract adds an NFC precondition, so that official vector must fail
    // before canonicalization instead of being silently normalized.
    expect(() => evolutionEvalCanonicalJson(officialPropertyVector)).toThrow("NFC normalized");
    const { "\ufb33": _nonNfc, ...nfcPropertyVector } = officialPropertyVector;
    expect(evolutionEvalCanonicalJson(nfcPropertyVector)).toBe("{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\":\"Control\",\"ö\":\"Latin Small Letter O With Diaeresis\",\"€\":\"Euro Sign\",\"😀\":\"Emoji: Grinning Face\"}");
  });

  test("rejects traversal, non-NFC, control and non-Vivado input paths", () => {
    expect(portableEvolutionEvalPath("rtl/top.sv")).toBe("rtl/top.sv");
    for (const path of [
      "/rtl/top.sv",
      "rtl\\top.sv",
      "rtl/../top.sv",
      "rtl//top.sv",
      "rtl/\u0000top.sv",
      "rtl/e\u0301.sv",
      "rtl/中文.sv",
      "rtl/İ.sv",
      "rtl/😀.sv",
      "rtl/.hidden.sv",
      "CON.v",
      "rtl/PRN.sv",
      "rtl/AUX.xdc",
      "rtl/NUL.v",
      "rtl/COM1.v",
      "rtl/com9.test.sv",
      "dir/LPT1.sv",
      "rtl/lpt9.v",
      "rtl/foo./top.sv",
      "rtl/top.sv/aux",
    ]) {
      expect(() => portableEvolutionEvalPath(path)).toThrow();
    }
    for (const path of ["rtl/console.v", "rtl/com10.sv", "rtl/lpt0.sv", "rtl/foo..sv"]) {
      expect(portableEvolutionEvalPath(path)).toBe(path);
    }
    expect(vivadoMediaTypeForPath("rtl/top.SV")).toBe("text/x-systemverilog");
    expect(vivadoMediaTypeForPath("constraints/top.xdc")).toBe("application/x-xdc");
    expect(() => vivadoMediaTypeForPath("scripts/build.tcl")).toThrow("forbidden extension");
  });

  test("accepts declarative XDC and rejects every dynamic Tcl escape surface", () => {
    const safe = [
      "set_property PACKAGE_PIN W5 [get_ports clk]\n",
      "set_property IOSTANDARD LVCMOS33 [get_ports {clk reset_n}]\ncreate_clock -name sys_clk -period 10 [get_ports clk]\n",
      "set_false_path -from [get_clocks async_a] -to [get_clocks async_b]\n",
    ];
    for (const content of safe) expect(scanEvolutionEvalXdc(content)).toEqual({
      decision: "pass",
      findings: [],
    });
    const hostile = [
      "exec sh -c {curl https://example.invalid}\n",
      "set_property X Y [exec id]\n",
      "open |sh\n",
      "socket example.invalid 443\n",
      "source relative.tcl\n",
      "load plugin.so\n",
      "package require http\n",
      "unknown_command [get_ports clk]\n",
      "set_property X $::env(HOME) [get_ports clk]\n",
      "set_property X /tmp/private.xdc [get_ports clk]\n",
      "set_property X https://example.invalid [get_ports clk]\n",
      "set_property X Y [launch_runs synth_1]\n",
      "set_property X Y [get_ports clk; exec id]\n",
      "set_property PACKAGE_PIN W5 [get_ports clk] \\\nexec /usr/bin/id\n",
      "set_property X Y [get_ports clk\n",
    ];
    for (const content of hostile) {
      const result = scanEvolutionEvalXdc(content);
      expect(result.decision).toBe("reject");
      expect(result.findings.length).toBeGreaterThan(0);
    }
  });

  test("keeps operation parameters typed and forbids raw-command-shaped drift", () => {
    expect(validateEvolutionEvalParameters("implement", {
      operation: "implement",
      source_paths: ["rtl/top.sv"],
      constraint_paths: ["constraints/top.xdc"],
      top: "top",
      part: "xc7a35tcpg236-1",
      generate_trial_bitstream: true,
    }).operation).toBe("implement");
    expect(() => validateEvolutionEvalParameters("simulate", {
      operation: "simulate",
      source_paths: ["rtl/top.sv"],
      top: "top",
      testbench: "bad testbench",
    })).toThrow("testbench");
    expect(() => validateEvolutionEvalParameters("synthesize", {
      operation: "simulate",
      source_paths: ["rtl/top.sv"],
      top: "top",
      testbench: "tb",
    })).toThrow(TypeError);
  });

  test("rejects every non-canonical runtime parameter shape before persistence", () => {
    const valid = {
      operation: "implement",
      source_paths: ["rtl/top.sv"],
      constraint_paths: ["constraints/top.xdc"],
      top: "top",
      part: "xc7a35tcpg236-1",
      generate_trial_bitstream: false,
    };
    const invalid: unknown[] = [
      null,
      [],
      new Date(),
      { ...valid, command: "synth_design" },
      { ...valid, generate_trial_bitstream: "false" },
      { ...valid, source_paths: "rtl/top.sv" },
      { ...valid, source_paths: ["rtl/top.sv", 1] },
      { ...valid, constraint_paths: ["constraints/top.xdc", false] },
      { ...valid, top: null },
      { ...valid, part: 7 },
      { ...valid, operation: "synthesize" },
      { ...valid, constraint_paths: undefined },
      {
        operation: "simulate",
        source_paths: ["rtl/top.sv"],
        top: "top",
      },
    ];
    for (const parameters of invalid) {
      expect(() => validateEvolutionEvalParameters("implement", parameters)).toThrow(TypeError);
    }
    const sparse = ["rtl/top.sv", "rtl/other.sv"];
    delete sparse[1];
    expect(() => validateEvolutionEvalParameters("synthesize", {
      operation: "synthesize",
      source_paths: sparse,
      top: "top",
      part: "xc7a35tcpg236-1",
    })).toThrow("array of strings");
  });

  test("sorts workspace files by portable key and rejects collisions", () => {
    const built = canonicalEvolutionEvalWorkspaceManifest({
      schema: "evolution-eval-workspace-manifest.v1",
      workspace_id: "ews_1",
      revision: 1,
      files: [
        { path: "rtl/Z.sv", sha256: "b".repeat(64), size_bytes: 2, media_type: "text/x-systemverilog", layer: "overlay", read_only: false },
        { path: "rtl/a.sv", sha256: "a".repeat(64), size_bytes: 1, media_type: "text/x-systemverilog", layer: "source", read_only: true },
      ],
    });
    expect(built.manifest.files.map((file) => file.path)).toEqual(["rtl/a.sv", "rtl/Z.sv"]);
    expect(built.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => canonicalEvolutionEvalWorkspaceManifest({
      schema: "evolution-eval-workspace-manifest.v1",
      workspace_id: "ews_1",
      revision: 1,
      files: [
        { path: "rtl/A.sv", sha256: "a".repeat(64), size_bytes: 1, media_type: "text/x-systemverilog", layer: "source", read_only: true },
        { path: "rtl/a.sv", sha256: "b".repeat(64), size_bytes: 1, media_type: "text/x-systemverilog", layer: "overlay", read_only: false },
      ],
    })).toThrow("collide");
    expect(() => canonicalEvolutionEvalWorkspaceManifest({
      schema: "evolution-eval-workspace-manifest.v1",
      workspace_id: "ews_1",
      revision: 1,
      files: [
        { path: "rtl/İ.sv", sha256: "a".repeat(64), size_bytes: 1, media_type: "text/x-systemverilog", layer: "source", read_only: true },
        { path: "RTL/i\u0307.SV", sha256: "b".repeat(64), size_bytes: 1, media_type: "text/x-systemverilog", layer: "overlay", read_only: false },
      ],
    })).toThrow("portable");
  });

  test("hashes the exact source+overlay sealed-input projection and excludes Skill metadata", () => {
    const built = canonicalEvolutionEvalSealedInputProjection({
      schema: "evolution-eval-workspace-manifest.v1",
      workspace_id: "ews_projection_1",
      revision: 2,
      files: [
        { path: "scripts/guide.tcl", sha256: "c".repeat(64), size_bytes: 3, media_type: "text/plain", layer: "skill", read_only: true },
        { path: "rtl/top.sv", sha256: "a".repeat(64), size_bytes: 1, media_type: "text/x-systemverilog", layer: "source", read_only: true },
        { path: "constraints/top.xdc", sha256: "b".repeat(64), size_bytes: 2, media_type: "application/x-xdc", layer: "overlay", read_only: false },
      ],
    });
    expect(built.sha256).toBe("6e29e4e4652a53ee233f3ca0443041a7b93890f545d4f8d4723491453288895c");
    expect(built.projection.manifest.files.map((file) => [file.path, file.layer])).toEqual([
      ["constraints/top.xdc", "overlay"],
      ["rtl/top.sv", "source"],
    ]);
    expect(built.projection.files).toEqual([
      { path: "constraints/top.xdc", sha256: "b".repeat(64), size_bytes: 2, media_type: "application/x-xdc" },
      { path: "rtl/top.sv", sha256: "a".repeat(64), size_bytes: 1, media_type: "text/x-systemverilog" },
    ]);
    expect(built.canonical).not.toContain("skill");
    expect(built.canonical).not.toContain("guide.tcl");
  });

  test("classifies bitstreams per entry and never as formal evidence", () => {
    const built = canonicalEvolutionEvalEvidenceManifest({
      schema: "evolution-eval-evidence-manifest.v1",
      eval_job_id: "eval_1",
      tool_run_id: "run_1",
      entries: [
        {
          name: "timing.rpt",
          sha256: "b".repeat(64),
          size_bytes: 2,
          media_type: "text/plain",
          artifact_classification: "evolution_eval_evidence",
          usage_classification: "evolution_eval_only",
        },
        {
          name: "design.bit",
          sha256: "a".repeat(64),
          size_bytes: 1,
          media_type: "application/octet-stream",
          artifact_classification: "experimental/evolution_eval",
          usage_classification: "evolution_eval_only",
        },
      ],
    });
    expect(built.manifest.entries.map((entry) => entry.name)).toEqual(["design.bit", "timing.rpt"]);
    expect(() => canonicalEvolutionEvalEvidenceManifest({
      schema: "evolution-eval-evidence-manifest.v1",
      eval_job_id: "eval_1",
      tool_run_id: "run_1",
      entries: [{
        name: "design.bit",
        sha256: "a".repeat(64),
        size_bytes: 1,
        media_type: "application/octet-stream",
        artifact_classification: "evolution_eval_evidence",
        usage_classification: "evolution_eval_only",
      }],
    })).toThrow("bitstream evidence classification");
  });
});
