import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildResidueOwnership16ParseCommand,
  executeResidueOwnership16Parse,
  lintResidueOwnership16ParseLoader,
  planResidueOwnership16Parse,
  planResidueOwnership16ParseEnvelope,
  residueOwnership16ParseConfirmation,
  type ResidueOwnership16ParseConfig,
} from "./scripts/m4f-direct-residue-ownership-diagnostic-16.ts";
import {
  buildResidueOwnership17Command,
  buildResidueOwnership17Script,
} from "./scripts/m4f-direct-residue-ownership-diagnostic-17.ts";
import { fixture, processResult, sha256 } from "./m4f-direct-residue-ownership-16-17-fixture.ts";

function parseConfig(): { value: ResidueOwnership16ParseConfig; setup: ReturnType<typeof fixture> } {
  const setup = fixture();
  const path = setup.actualConfig.candidate16_parse_success.parse_config_path;
  return { value: JSON.parse(setup.frozen.get(path)!.toString("utf8")), setup };
}

describe("M4-F Candidate-16 Windows PowerShell parse-only gate", () => {
  test("builds a Parser.ParseInput-only loader with conservative token boundaries", () => {
    const { scriptConfig } = fixture();
    const script = buildResidueOwnership17Script(scriptConfig);
    const command = buildResidueOwnership17Command(scriptConfig);
    const packed = buildResidueOwnership16ParseCommand(script, sha256(Buffer.from(command, "ascii")));
    expect(packed.loader).toContain("[Management.Automation.Language.Parser]::ParseInput");
    expect(packed.loader).toContain("if ($e.Count) {exit 2}");
    expect(packed.loader).toContain("$x | ConvertTo-Json");
    for (const forbidden of ["ScriptBlock]::Create", ".Invoke(", "& $s", "Invoke-Expression", "Stop-Process", "program_hw"]) {
      expect(packed.loader.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(packed.loader).toContain("parser_end_block_present=($null -ne $a.EndBlock)");
    expect(packed.command.length).toBeLessThanOrEqual(7000);
    expect(() => lintResidueOwnership16ParseLoader(packed.loader)).not.toThrow();
    for (const invalid of ["if($e.Count)", "$x| ConvertTo-Json", "$x |ConvertTo-Json", "&{$x}", "ScriptBlock]::Create"]) {
      expect(() => lintResidueOwnership16ParseLoader(invalid)).toThrow("M4F_RESIDUE_16_LOADER_TOKEN_BOUNDARY_INVALID");
    }
  });

  test("planning envelope binds config, pure canonical plan, sources, and exact confirmation", () => {
    const { value, setup } = parseConfig();
    const plan = planResidueOwnership16Parse(value, setup.dependencies);
    const envelope = planResidueOwnership16ParseEnvelope(value, setup.dependencies);
    expect(envelope).toEqual({
      ...plan,
      config_sha256: sha256(canonical(value) + "\n"),
      plan_sha256: sha256(canonical(plan) + "\n"),
      confirmation: residueOwnership16ParseConfirmation(value, setup.dependencies),
    });
    expect(plan).not.toHaveProperty("confirmation");
    expect(envelope).toMatchObject({
      status: "planned_not_executed", parser_required: "Windows PowerShell Desktop 5.1",
      attempt_count: 1, retry_permitted: false, stdin_length: 0,
      effective_timeout_ms: 15_000, remote_timeout_ms: 30_000,
      target_body_not_invoked: true, network_attempted: false, vivado_action_performed: false,
      hardware_action_performed: false, cleanup_performed: false,
    });
  });

  test("accepts one successful parse-only result and freezes mutually verifiable evidence", () => {
    const { value, setup } = parseConfig();
    const directory = mkdtempSync(join(tmpdir(), "synthia-c16-"));
    rmSync(directory, { recursive: true });
    value.evidence_directory = directory;
    const bound = setup.actualConfig.candidate16_parse_success;
    setup.setRemote(processResult(setup.frozen.get(bound.evidence_directory + "/stdout.raw")!));
    try {
      const confirmation = residueOwnership16ParseConfirmation(value, setup.dependencies);
      const record = executeResidueOwnership16Parse(value, confirmation, directory, setup.dependencies);
      expect(record).toMatchObject({
        status: "parsed_not_invoked", attempt: 1, target_body_not_invoked: true,
        process_mutation_performed: false, file_mutation_performed: false,
        vivado_action_performed: false, hardware_action_performed: false, cleanup_performed: false,
      });
      expect(setup.calls).toHaveLength(2);
      expect(setup.calls[1]!.stdin).toHaveLength(0);
      expect(readFileSync(directory + "/confirmation.sha256", "ascii")).toBe(sha256(confirmation) + "\n");
      expect(JSON.parse(readFileSync(directory + "/transport-inputs-initial.json", "utf8"))).toEqual([]);
      expect(readFileSync(directory + "/transport-inputs-pre_remote.json")).toEqual(
        readFileSync(directory + "/transport-inputs-post_remote.json"),
      );
      expect(readFileSync(directory + "/target-script.ps1", "utf8")).toBe(buildResidueOwnership17Script(setup.scriptConfig));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a Windows parser failure without claiming target invocation", () => {
    const { value, setup } = parseConfig();
    const directory = mkdtempSync(join(tmpdir(), "synthia-c16-reject-"));
    rmSync(directory, { recursive: true });
    value.evidence_directory = directory;
    const script = buildResidueOwnership17Script(setup.scriptConfig);
    const command = buildResidueOwnership17Command(setup.scriptConfig);
    setup.setRemote(processResult(JSON.stringify({
      schema: "synthia-m4f-direct-residue-ownership-parse-result.v1", status: "parse_rejected",
      target_script_sha256: sha256(script), target_script_length: Buffer.byteLength(script),
      target_command_sha256: sha256(Buffer.from(command, "ascii")), parse_error_count: 1,
      parser_ast_type: "System.Management.Automation.Language.ScriptBlockAst", powershell_edition: "Desktop",
      parser_end_block_present: true,
      powershell_version: "5.1.19041.5608", target_body_not_invoked: true,
      process_mutation_performed: false, file_mutation_performed: false, vivado_action_performed: false,
      hardware_action_performed: false, cleanup_performed: false,
    }) + "\r\n", "", 2));
    try {
      expect(() => executeResidueOwnership16Parse(
        value, residueOwnership16ParseConfirmation(value, setup.dependencies), directory, setup.dependencies,
      )).toThrow("M4F_RESIDUE_16_TARGET_PARSE_REJECTED");
      expect(JSON.parse(readFileSync(directory + "/parse-failure.json", "utf8"))).toMatchObject({
        code: "M4F_RESIDUE_16_TARGET_PARSE_REJECTED", target_body_not_invoked: true,
        process_mutation_performed: false, file_mutation_performed: false,
        vivado_action_performed: false, hardware_action_performed: false, cleanup_performed: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}
