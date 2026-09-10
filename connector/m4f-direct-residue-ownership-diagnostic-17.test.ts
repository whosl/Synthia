import { describe, expect, test } from "bun:test";
import {
  buildResidueOwnership17Command,
  buildResidueOwnership17Script,
  executeResidueOwnership17,
  lintCandidate17PowerShellSyntax,
  residueOwnership17Confirmation,
  residueOwnership17Plan,
} from "./scripts/m4f-direct-residue-ownership-diagnostic-17.ts";
import {
  admission,
  asOwnership17Dependencies,
  fixture,
  sha256,
} from "./m4f-direct-residue-ownership-16-17-fixture.ts";

describe("M4-F Candidate-17 read-only ownership builder", () => {
  test("fixes the exact Candidate-15 parser defect and all selected word-operator boundaries", () => {
    const setup = fixture();
    const script = buildResidueOwnership17Script(setup.scriptConfig);
    expect(script).toContain("foreach ($i in $want)");
    expect(script).not.toContain("foreach($i in$want)");
    expect(script).toContain("$_.ProcessId -ne 0");
    expect(script).toContain("$_.ProcessId -in $ids");
    expect(script).toContain(").Count -ne 4");
    expect(script).toContain("$x.Count -ne 1");
    expect(script).toContain("$null -ne $q");
    expect(script).toContain("$q -and $q -cmatch '");
    expect(script).toContain(" -ceq $Matches[1]");
    expect(script).toContain("UtcNow -ge $dl");
    expect(script).toContain("n=$e.Count");
    expect(script.match(/Get-CimInstance Win32_Process/gu)).toHaveLength(1);
    expect(script.match(/Get-Process -Id/gu)).toHaveLength(1);
    expect(script).toContain("if($i -in $ids){$z=Get-Process -Id $i");
    const targetIds = setup.scriptConfig.targets.map((target) => target.pid);
    const cmdIds = setup.scriptConfig.cmd_bindings.map((binding) => binding.pid);
    expect(new Set(targetIds).size).toBe(4);
    expect(cmdIds.every((pid) => !targetIds.includes(pid))).toBeTrue();
    expect(() => lintCandidate17PowerShellSyntax(script)).not.toThrow();
    expect(() => lintCandidate17PowerShellSyntax(script.replace("$x.Count -ne 1", "$x.Count-ne1")))
      .toThrow("M4F_RESIDUE_17_POWERSHELL_TOKEN_BOUNDARY_INVALID");
    expect(() => lintCandidate17PowerShellSyntax(script.replace("foreach ($i in $want)", "foreach($i in$want)")))
      .toThrow();
  });

  test("keeps one empty-stdin encoded read-only command below both limits", () => {
    const setup = fixture();
    const script = buildResidueOwnership17Script(setup.scriptConfig);
    const command = buildResidueOwnership17Command(setup.scriptConfig);
    expect(command.length).toBe(6698);
    expect(command.length).toBeLessThanOrEqual(7000);
    expect(command.length).toBeLessThan(8191);
    expect(Buffer.from(command.slice(command.lastIndexOf(" ") + 1), "base64").toString("utf16le")).toBe(script);
    for (const forbidden of ["Stop-Process", "Remove-Item", "New-Item", "vivado", "hw_server", "open_hw", "program_hw"]) {
      expect(script.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(residueOwnership17Plan(setup.actualConfig, admission)).toMatchObject({
      cim_snapshot_count: 1, get_process_target_count: 4,
      get_process_target_count_basis: "static_proof_four_unique_target_ids_cmd_ids_disjoint_and_guarded_branch",
      process_mutation_performed: false, file_mutation_performed: false,
      vivado_action_performed: false, hardware_action_performed: false, cleanup_performed: false,
    });
  });

  test("rejects any Candidate-16 evidence drift before the first network call", () => {
    const setup = fixture();
    const binding = setup.actualConfig.candidate16_parse_success;
    const path = binding.evidence_directory + "/transport-inputs-post_remote.json";
    setup.frozen.set(path, Buffer.from("[{}]\n"));
    expect(() => executeResidueOwnership17(
      setup.actualConfig,
      admission,
      residueOwnership17Confirmation(setup.actualConfig, admission),
      asOwnership17Dependencies(setup.dependencies),
    )).toThrow("M4F_RESIDUE_17_PARSE_INPUT_MISMATCH");
    expect(setup.calls).toHaveLength(0);
  });

  test("independently rejects Candidate-16 or shared loader source drift before network", () => {
    for (const method of ["candidate16SourceBytes", "candidate16TestSourceBytes", "parseLoaderSourceBytes"] as const) {
      const setup = fixture();
      const dependencies = { ...asOwnership17Dependencies(setup.dependencies), [method]: () => Buffer.from("drift") };
      expect(() => executeResidueOwnership17(
        setup.actualConfig,
        admission,
        residueOwnership17Confirmation(setup.actualConfig, admission),
        dependencies,
      )).toThrow("M4F_RESIDUE_17_PARSE_SUCCESS_SEMANTIC_MISMATCH");
      expect(setup.calls).toHaveLength(0);
    }
  });

  test("rejects a forged parse-record timeout before the first network call even when its file hash is updated", () => {
    const setup = fixture();
    const binding = setup.actualConfig.candidate16_parse_success;
    const path = binding.evidence_directory + "/parse-record.json";
    const record = JSON.parse(setup.frozen.get(path)!.toString("utf8"));
    record.timeout_ms = 1;
    const bytes = Buffer.from(JSON.stringify(record, null, 2) + "\n");
    setup.frozen.set(path, bytes);
    binding.files["parse-record.json"] = sha256(bytes);
    expect(() => executeResidueOwnership17(
      setup.actualConfig,
      admission,
      residueOwnership17Confirmation(setup.actualConfig, admission),
      asOwnership17Dependencies(setup.dependencies),
    )).toThrow("M4F_RESIDUE_17_PARSE_SUCCESS_SEMANTIC_MISMATCH");
    expect(setup.calls).toHaveLength(0);
  });

  test("rejects a forged remote-process exit before network even when its file hash is updated", () => {
    const setup = fixture();
    const binding = setup.actualConfig.candidate16_parse_success;
    const path = binding.evidence_directory + "/remote-process.json";
    const process = JSON.parse(setup.frozen.get(path)!.toString("utf8"));
    process.exit_status = 99;
    const bytes = Buffer.from(JSON.stringify(process, null, 2) + "\n");
    setup.frozen.set(path, bytes);
    binding.files["remote-process.json"] = sha256(bytes);
    expect(() => executeResidueOwnership17(
      setup.actualConfig,
      admission,
      residueOwnership17Confirmation(setup.actualConfig, admission),
      asOwnership17Dependencies(setup.dependencies),
    )).toThrow("M4F_RESIDUE_17_PARSE_SUCCESS_SEMANTIC_MISMATCH");
    expect(setup.calls).toHaveLength(0);
  });

  test("admits frozen Candidate-16 success before beginning the separate read-only observation", () => {
    const setup = fixture();
    const result = executeResidueOwnership17(
      setup.actualConfig,
      admission,
      residueOwnership17Confirmation(setup.actualConfig, admission),
      asOwnership17Dependencies(setup.dependencies),
    );
    expect(result.status).toBe("partial_unknown");
    expect(setup.calls).toHaveLength(2);
    expect(setup.calls.every((call) => call.stdin.length === 0)).toBeTrue();
  });
});
