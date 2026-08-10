import { describe, expect, test } from "bun:test";
import {
  SKILL_ALLOWED_PERMISSIONS,
  SKILL_FORBIDDEN_PERMISSIONS,
  assertValidSkill,
  assertValidSkillPack,
  isKnownCapability,
  isKnownCapabilityId,
  parseCapabilityId,
  validateSkill,
  validateSkillPack,
  type SkillDescriptor,
  type SkillPack,
} from "../src/skill-catalog.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function validDescriptor(overrides: Partial<SkillDescriptor> = {}): SkillDescriptor {
  return {
    skill_id: "rtl-candidate-author",
    schema_version: "synthia.skill-pack.v1",
    version: "1.0.0",
    phase: "G4",
    purpose: "Author RTL candidate revisions from frozen B1 design input.",
    inputs: [
      "Approved B1 detailed design (DETAILED_DESIGN, frozen).",
    ],
    outputs: [
      { artifact_type: "RTL_SOURCE_SET", declared_status: "candidate", description: "Verilog candidate set." },
    ],
    preconditions: ["B1 detailed design is approved and frozen."],
    required_permissions: ["read", "candidate_write"],
    required_capabilities: ["vivado-batch-1:synthesize"],
    evidence: [
      "Synthesis utilization report for the candidate (EvidenceManifest SHA-256).",
    ],
    failure_policy: "fail_closed",
    ...overrides,
  };
}

function validPack(overrides: Partial<SkillPack> = {}): SkillPack {
  return {
    schema_version: "synthia.skill-pack.v1",
    pack_id: "synthia.fpga",
    version: "1.0.0",
    skills: [validDescriptor()],
    ...overrides,
  };
}

// ── Happy path ──────────────────────────────────────────────────────────────

describe("skill-catalog — happy path", () => {
  test("a well-formed Synthia skill validates", () => {
    const result = validateSkill(validDescriptor());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.descriptor.skill_id).toBe("rtl-candidate-author");
    }
  });

  test("a generation/analysis skill with no Connector capability is valid", () => {
    const result = validateSkill(
      validDescriptor({ required_capabilities: [], skill_id: "requirements-author" }),
    );
    expect(result.valid).toBe(true);
  });

  test("all 8 frozen vivado-batch-1 capabilities are recognized", () => {
    const ops = [
      "discover_toolchain",
      "query_parts",
      "validate_sources",
      "simulate",
      "synthesize",
      "report_drc",
      "report_sta",
      "report_resources",
    ];
    for (const op of ops) {
      expect(isKnownCapabilityId(`vivado-batch-1:${op}`)).toBe(true);
    }
  });

  test("a well-formed pack validates", () => {
    expect(validateSkillPack(validPack()).valid).toBe(true);
  });
});

// ── Capability id parsing & matching ────────────────────────────────────────

describe("skill-catalog — capability id parsing", () => {
  test("parses versioned capability ids", () => {
    expect(parseCapabilityId("vivado-batch-1:synthesize")).toEqual({
      version: "vivado-batch-1",
      operation: "synthesize",
    });
  });

  test("rejects unversioned bare operations", () => {
    expect(parseCapabilityId("synthesize")).toBeNull();
    expect(parseCapabilityId("vivado-batch-1")).toBeNull();
  });

  test("rejects MCP-generated names", () => {
    expect(parseCapabilityId("mcp__vivado_synthesize")).toBeNull();
    expect(parseCapabilityId("mcp__server_tool")).toBeNull();
  });

  test("rejects arbitrary / free-text Tcl entry points", () => {
    expect(parseCapabilityId("execute_tcl")).toBeNull();
    expect(parseCapabilityId("execute_tcl(any_string)")).toBeNull();
    expect(parseCapabilityId("vivado_raw_tcl")).toBeNull();
    expect(parseCapabilityId("vivado-batch-1:exec_shell")).toBeNull();
  });

  test("isKnownCapability rejects a valid-shape but unimplemented capability", () => {
    // Structurally versioned but not in the frozen operation set.
    expect(
      isKnownCapability({
        version: "vivado-batch-1",
        operation: "generate_bitstream",
      }),
    ).toBe(false);
    expect(isKnownCapabilityId("vivado-batch-1:opt_design")).toBe(false);
    // Unknown version entirely.
    expect(isKnownCapabilityId("vivado-batch-2:synthesize")).toBe(false);
  });
});

// ── Missing / invalid fields (fail-closed) ──────────────────────────────────

describe("skill-catalog — missing and invalid fields", () => {
  test("missing required_permissions fails (empty permission set is fail-closed)", () => {
    const result = validateSkill(validDescriptor({ required_permissions: [] }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(" ")).toContain("required_permissions");
    }
  });

  test("bad schema_version fails", () => {
    const result = validateSkill(
      validDescriptor({ schema_version: "synthia.skill-pack.v0" as SkillDescriptor["schema_version"] }),
    );
    expect(result.valid).toBe(false);
  });

  test("non-semantic version fails", () => {
    const result = validateSkill(validDescriptor({ version: "latest" }));
    expect(result.valid).toBe(false);
  });

  test("unknown phase fails", () => {
    const result = validateSkill(validDescriptor({ phase: "GX" as SkillDescriptor["phase"] }));
    expect(result.valid).toBe(false);
  });

  test("unknown artifact type on output fails", () => {
    const result = validateSkill(
      validDescriptor({
        outputs: [
          { artifact_type: "BITSTREAM_FILE" as SkillDescriptor["outputs"][number]["artifact_type"], declared_status: "candidate", description: "x" },
        ],
      }),
    );
    expect(result.valid).toBe(false);
  });

  test("empty outputs fails", () => {
    const result = validateSkill(validDescriptor({ outputs: [] }));
    expect(result.valid).toBe(false);
  });

  test("empty evidence fails", () => {
    const result = validateSkill(validDescriptor({ evidence: [] }));
    expect(result.valid).toBe(false);
  });

  test("invalid failure_policy fails", () => {
    const result = validateSkill(
      validDescriptor({ failure_policy: "auto_approve" as SkillDescriptor["failure_policy"] }),
    );
    expect(result.valid).toBe(false);
  });
});

// ── Forbidden permissions ───────────────────────────────────────────────────

describe("skill-catalog — forbidden permissions", () => {
  test("the canonical human/accountability gates are forbidden", () => {
    expect([...SKILL_FORBIDDEN_PERMISSIONS]).toEqual(
      expect.arrayContaining(["approve", "baseline", "publish", "hardware_write"]),
    );
  });

  test("skill must not declare approve/baseline/publish/hardware_write", () => {
    for (const forbidden of ["approve", "baseline", "publish", "hardware_write"] as const) {
      const result = validateSkill(
        validDescriptor({ required_permissions: ["read", forbidden] }),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.join(" ")).toContain(forbidden);
      }
    }
  });

  test("allowed permission set is bounded to read/candidate_write/tool_submit", () => {
    expect([...SKILL_ALLOWED_PERMISSIONS].sort()).toEqual(
      ["candidate_write", "read", "tool_submit"],
    );
  });
});

// ── Unknown / arbitrary capability rejection ─────────────────────────────────

describe("skill-catalog — capability rejection", () => {
  test("unversioned bare operation in required_capabilities fails", () => {
    const result = validateSkill(validDescriptor({ required_capabilities: ["synthesize"] }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(" ")).toContain("required_capabilities");
    }
  });

  test("MCP-generated name in required_capabilities fails", () => {
    const result = validateSkill(
      validDescriptor({ required_capabilities: ["mcp__vivado_synthesize"] }),
    );
    expect(result.valid).toBe(false);
  });

  test("free-text Tcl entry point in required_capabilities fails", () => {
    for (const id of ["execute_tcl", "execute_tcl(any_string)", "vivado_raw_tcl"]) {
      const result = validateSkill(validDescriptor({ required_capabilities: [id] }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.join(" ")).toContain(id);
      }
    }
  });

  test("valid-shape but unimplemented capability fails", () => {
    // generate_bitstream / program_device are post-MVP, not in the frozen set.
    const result = validateSkill(
      validDescriptor({ required_capabilities: ["vivado-batch-1:generate_bitstream"] }),
    );
    expect(result.valid).toBe(false);
  });
});

// ── Output status: no approval power ────────────────────────────────────────

describe("skill-catalog — output declared status", () => {
  test("approved declared_status is rejected (skill has no approval power)", () => {
    const result = validateSkill(
      validDescriptor({
        outputs: [
          { artifact_type: "RTL_SOURCE_SET", declared_status: "approved" as never, description: "x" },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(" ")).toContain("declared_status");
    }
  });

  test("diagnostic declared_status is accepted", () => {
    const result = validateSkill(
      validDescriptor({
        outputs: [
          { artifact_type: "DRC_REPORT", declared_status: "diagnostic", description: "DRC findings." },
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });
});

// ── Pack-level validation ───────────────────────────────────────────────────

describe("skill-catalog — pack validation", () => {
  test("duplicate skill_id fails", () => {
    const dup = validDescriptor();
    const result = validateSkillPack(validPack({ skills: [dup, { ...dup }] }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(" ")).toContain("duplicate");
    }
  });

  test("wrong pack_id fails", () => {
    const result = validateSkillPack(validPack({ pack_id: "fpga" }));
    expect(result.valid).toBe(false);
  });

  test("wrong schema_version fails", () => {
    const result = validateSkillPack(
      validPack({ schema_version: "synthia.skill-pack.v0" as SkillPack["schema_version"] }),
    );
    expect(result.valid).toBe(false);
  });

  test("empty skills array fails", () => {
    const result = validateSkillPack(validPack({ skills: [] }));
    expect(result.valid).toBe(false);
  });

  test("invalid nested skill surfaces with index path", () => {
    const result = validateSkillPack(
      validPack({ skills: [validDescriptor({ required_permissions: [] })] }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(" ")).toContain("skills[0]");
    }
  });
});

// ── Throwing variants ───────────────────────────────────────────────────────

describe("skill-catalog — asserting variants", () => {
  test("assertValidSkill throws on invalid descriptor", () => {
    expect(() => assertValidSkill(validDescriptor({ required_permissions: [] }))).toThrow(
      "SKILL_DESCRIPTOR_INVALID",
    );
  });

  test("assertValidSkillPack throws on invalid pack", () => {
    expect(() => assertValidSkillPack(validPack({ pack_id: "bad" }))).toThrow(
      "SKILL_PACK_INVALID",
    );
  });

  test("assertValidSkill does not throw on valid descriptor", () => {
    expect(() => assertValidSkill(validDescriptor())).not.toThrow();
  });
});
