import { describe, expect, test } from "bun:test";
import {
  LEARNED_SKILL_SCANNER_VERSION,
  TCL_ALLOW_TEST_VECTORS,
  TCL_DENY_TEST_VECTORS,
  scanLearnedSkillFiles,
  scanLearnedSkillPackage,
  type LearnedSkillFileInput,
} from "../src/services/learned-skill-scan.ts";

const skillMd: LearnedSkillFileInput = {
  path: "SKILL.md",
  kind: "skill_md",
  language: null,
  content: "# Timing diagnosis\n\nInspect timing evidence and explain the local goal.\n",
};

describe("Learned Skill deterministic scanner", () => {
  test("accepts the three frozen script languages and produces a stable manifest", () => {
    const files: LearnedSkillFileInput[] = [
      skillMd,
      { path: "scripts/check.tcl", kind: "script", language: "tcl", content: TCL_ALLOW_TEST_VECTORS[0] },
      { path: "scripts/check.py", kind: "script", language: "python", content: "def check(values):\n    return sorted(values)\n" },
      { path: "scripts/check.ts", kind: "script", language: "typescript", content: "export const check = (xs: number[]) => [...xs].sort();\n" },
      { path: "references/notes.md", kind: "reference", language: null, content: "Observed on Vivado synthesis.\n" },
      { path: "templates/example.sv", kind: "template", language: null, content: "module example; endmodule\n" },
    ];
    const first = scanLearnedSkillFiles(files);
    const second = scanLearnedSkillFiles([...files].reverse());
    expect(first.decision).toBe("pass");
    expect(first.scannerVersion).toBe(LEARNED_SKILL_SCANNER_VERSION);
    expect(first.contentManifestHash).toBe(second.contentManifestHash);
    expect(first.files.map((file) => file.sha256)).toHaveLength(files.length);
  });

  test("keeps every explicit safe Tcl vector allowed", () => {
    for (const [index, content] of TCL_ALLOW_TEST_VECTORS.entries()) {
      const result = scanLearnedSkillFiles([
        skillMd,
        { path: `scripts/safe-${index}.tcl`, kind: "script", language: "tcl", content },
      ]);
      expect(result.findings).toEqual([]);
    }
  });

  test("quarantines every explicit unsafe Tcl vector with its stable code", () => {
    for (const [index, vector] of TCL_DENY_TEST_VECTORS.entries()) {
      const result = scanLearnedSkillFiles([
        skillMd,
        { path: `scripts/unsafe-${index}.tcl`, kind: "script", language: "tcl", content: vector.content },
      ]);
      expect(result.decision).toBe("quarantine");
      expect(result.findings.map((item) => item.code)).toContain(vector.code);
    }
  });

  test("rejects shell, path traversal, kind spoofing and case collisions", () => {
    const result = scanLearnedSkillFiles([
      skillMd,
      { path: "scripts/run.sh", kind: "script", language: null, content: "#!/bin/sh\n" },
      { path: "references/../secret.md", kind: "reference", language: null, content: "x" },
      { path: "scripts/tool.py", kind: "template", language: null, content: "pass\n" },
      { path: "skill.md", kind: "skill_md", language: null, content: "duplicate\n" },
    ]);
    expect(result.decision).toBe("quarantine");
    expect(result.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      "PATH_NOT_ALLOWED",
      "UNSAFE_PATH",
      "FILE_SHAPE_MISMATCH",
      "PATH_COLLISION",
    ]));
  });

  test("rejects secrets and Python/TypeScript escape surfaces", () => {
    const result = scanLearnedSkillFiles([
      skillMd,
      { path: "scripts/net.py", kind: "script", language: "python", content: "import requests\nrequests.get('https://example.invalid')\n" },
      { path: "scripts/proc.ts", kind: "script", language: "typescript", content: "Bun.spawn(['sh']);\n" },
      { path: "references/leak.md", kind: "reference", language: null, content: "api_key='super-secret-value'\n" },
    ]);
    expect(result.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      "NETWORK_API",
      "PROCESS_START",
      "SECRET_MATERIAL",
    ]));
  });

  test("rejects Tcl command substitution and every host absolute path", () => {
    for (const content of [
      "set result [exec sh -c {id}]\n",
      "set run [launch_runs synth_1]\n",
      "puts /tmp/private/result.dcp\n",
      "puts /srv/vendor-specific/result.dcp\n",
    ]) {
      const result = scanLearnedSkillFiles([
        skillMd,
        { path: "scripts/unsafe.tcl", kind: "script", language: "tcl", content },
      ]);
      expect(result.decision).toBe("quarantine");
    }
  });

  test("scans metadata, applicability and outcome contract", () => {
    const result = scanLearnedSkillPackage([skillMd], {
      name: "Timing diagnosis",
      summary: "Reusable workflow",
      description: "Do not disclose customer-specific observations",
      applicability: { report: "/tmp/customer/timing.rpt" },
      outcomeContract: { evidence_ref: "evidence-secret-123" },
    });
    expect(result.decision).toBe("quarantine");
    expect(result.findings.map((item) => item.path)).toEqual(expect.arrayContaining([
      "<metadata>.description",
      "<metadata>.applicability",
      "<metadata>.outcome_contract",
    ]));
  });
});
