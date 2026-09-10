import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import {
  buildCandidate36Payload,
  planCandidate36,
  validateCandidate36HelperOutput,
  validateCandidate36Output,
  validateCandidate36ParseOutput,
} from "./scripts/m4f-direct-nine-pid-cleanup-parse-helper-gate-36.ts";
import {
  buildCandidate35BusinessScript,
  CANDIDATE31_RECORD_PATH,
  CANDIDATE34_RECORD_PATH,
  CANDIDATE34_RECORD_SHA256,
  CANDIDATE34_SOURCE_SHA256,
  CANDIDATE34_TEST_SHA256,
  CANDIDATE35_ID,
  type Candidate35Config,
} from "./scripts/m4f-direct-nine-pid-cleanup-runner-35.ts";

function config(): Candidate35Config {
  return {
    schema: "synthia-m4f-direct-nine-pid-cleanup-35-config.v1",
    cleanup_id: CANDIDATE35_ID,
    target_host: "100.96.223.49",
    target_computer: "DESKTOP-DVFFB09",
    target_identity_name: "desktop-dvffb09\\admin",
    target_identity_sid: "S-1-5-21-2561815994-3878748218-1101284459-1001",
    candidate31_record_path: CANDIDATE31_RECORD_PATH,
    candidate31_record_sha256: "4efad9fab8445eeee887e564fe6362f1341f96500f7926b8ddee690ee50fa8aa",
    candidate34_record_path: CANDIDATE34_RECORD_PATH,
    candidate34_record_sha256: CANDIDATE34_RECORD_SHA256,
    expected_candidate34_source_sha256: CANDIDATE34_SOURCE_SHA256,
    expected_candidate34_test_sha256: CANDIDATE34_TEST_SHA256,
    expected_source_sha256: "a".repeat(64),
    expected_test_sha256: "b".repeat(64),
    expected_transport_source_sha256: "c".repeat(64),
    effect_wait_ms: 5_000,
    remote_deadline_seconds: 60,
  };
}

function parseOutput(change?: (fields: string[]) => void): Buffer {
  const built = buildCandidate36Payload(config());
  const fields = [
    "r36p", String(built.targetScriptLength), "0", "ScriptBlockAst", "True",
    built.targetScriptSha256, built.targetGzipSha256, "System.IO.Compression.GZipStream",
  ];
  change?.(fields);
  return Buffer.from(fields.join("|") + "\r\n");
}

function helperOutput(change?: (value: Record<string, unknown>) => void): Buffer {
  const value: Record<string, unknown> = {
    s: "r36h",
    powershell_edition: "Desktop",
    powershell_version: "5.1.26100.9168",
    helper_count: 6,
    hash_x: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
    micro_ticks: 639237312001234560,
    dummy_row: [
      1, 2, "cmd.exe", "2026-08-31T00:00:00.0000000Z", 0,
      "C:\\Windows\\System32\\cmd.exe", true, 3,
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    ],
    deep_count: 12,
    deep_terminal: "zero",
    deep_terminal_pid: 0,
    missing_count: 0,
    missing_terminal: "missing_parent",
    missing_terminal_pid: 201,
    cycle_count: 1,
    cycle_terminal: "cycle",
    cycle_terminal_pid: 300,
    invalid_count: 1,
    invalid_terminal: "invalid_edge",
    invalid_terminal_pid: 401,
    stale_exact: true,
    target_exact: true,
    target_body_invoked: false,
    cim_executed: false,
    kill_executed: false,
    stdin_length: 0,
  };
  change?.(value);
  return Buffer.from(JSON.stringify(value) + "\r\n");
}

describe("M4-F Candidate 36 exact C35 parse/helper gate", () => {
  test("gzip-binds exact C35 bytes and parses without invoking them", () => {
    const built = buildCandidate36Payload(config());
    expect(built.targetScript).toBe(buildCandidate35BusinessScript(config()));
    expect(gunzipSync(built.targetGzip)).toEqual(Buffer.from(built.targetScript, "utf8"));
    expect(built.parseScript.match(/Parser\]::ParseInput/gu)).toHaveLength(1);
    expect(built.parseScript).not.toMatch(
      /ScriptBlock\]::Create|Invoke-Expression|Get-CimInstance|MSFT_NetTCPConnection|\.Kill\s*\(|Stop-Process|taskkill/iu,
    );
  });

  test("extracts only six exact pure helpers and smokes synthetic objects", () => {
    const built = buildCandidate36Payload(config());
    expect(built.helperSha256).toHaveLength(6);
    expect(built.helperScript.match(/function\s+(?:Get|ConvertTo|Test)-SynthiaM4f35/gu)).toHaveLength(6);
    expect(built.helperScript).not.toMatch(/Write-SynthiaM4f35Marker|Get-SynthiaM4f35Snapshot|Test-SynthiaM4f35Guard/u);
    expect(built.helperSmokeScript).toContain("$d=[pscustomobject]");
    expect(built.helperSmokeScript).toContain("$dm=@{}");
    expect(built.helperSmokeScript).toContain("$cm=@{");
    expect(built.helperSmokeScript).toContain("$im=@{");
    expect(built.helperSmokeScript).not.toMatch(
      /Get-CimInstance|MSFT_NetTCPConnection|\.Kill\s*\(|Stop-Process|taskkill|Vivado|program_hw/iu,
    );
  });

  test("uses one exact-gzip stdin parse probe and one empty-stdin helper probe", () => {
    const built = buildCandidate36Payload(config());
    expect(built.parseCommand.length).toBeLessThanOrEqual(7_000);
    expect(built.helperCommand.length).toBeLessThanOrEqual(7_000);
    expect(built.parseCommand).toStartWith("powershell.exe -NoLogo -NoProfile -NonInteractive");
    expect(built.helperCommand).toStartWith("powershell.exe -NoLogo -NoProfile -NonInteractive");
    expect(built.helperLoader).toContain("[IO.Compression.CompressionMode]::Decompress");
    expect(built.parseStdin).toEqual(built.targetGzip);
    expect(built.parseStdinSha256).toBe(built.targetGzipSha256);
    expect(built.parseScript).toContain("[Console]::OpenStandardInput()");
    expect(built.parseScript).toContain("STDIN_EOF");
    expect(built.parseScript).toContain("STDIN_TAIL");
    expect(gunzipSync(built.compressedHelperSmokeScript).toString("utf8")).toBe(built.helperSmokeScript);
    expect(built.helperLoader).not.toContain(built.targetScript);
  });

  test("reports a two-probe no-effect local plan", () => {
    expect(planCandidate36(config())).toMatchObject({
      status: "planned_not_executed",
      helper_definition_count: 6,
      parser_call_count: 1,
      remote_probe_count: 2,
      parse_stdin_length: buildCandidate36Payload(config()).parseStdin.length,
      parse_stdin_sha256: buildCandidate36Payload(config()).parseStdinSha256,
      helper_stdin_length: 0,
      target_body_invoked: false,
      cim_executed: false,
      kill_executed: false,
      process_mutation_permitted: false,
      vivado_action_permitted: false,
      hardware_action_permitted: false,
    });
  });

  test("accepts only exact WinPS 5.1 parse and helper results", () => {
    const built = buildCandidate36Payload(config());
    expect(validateCandidate36ParseOutput(parseOutput(), built).parse_error_count).toBe(0);
    expect(validateCandidate36HelperOutput(helperOutput())).toMatchObject({
      helper_count: 6, target_body_invoked: false, cim_executed: false, kill_executed: false,
    });
    expect(validateCandidate36Output(parseOutput(), helperOutput(), built)).toMatchObject({
      status: "exact_target_parse_zero_and_pure_helpers_smoked",
      target_script_sha256: built.targetScriptSha256,
      target_gzip_sha256: built.targetGzipSha256,
      parse_error_count: 0,
      target_body_invoked: false,
      cim_executed: false,
      kill_executed: false,
      process_mutation_performed: false,
    });
    expect(() => validateCandidate36ParseOutput(parseOutput((fields) => { fields[2] = "1"; }), built))
      .toThrow("M4F_CANDIDATE36_PARSE_RESULT_REJECTED");
    for (const change of [
      (value: Record<string, unknown>) => { value.powershell_edition = "Core"; },
      (value: Record<string, unknown>) => { value.cycle_count = 2; },
      (value: Record<string, unknown>) => { value.stale_exact = false; },
      (value: Record<string, unknown>) => { value.kill_executed = true; },
    ]) {
      expect(() => validateCandidate36HelperOutput(helperOutput(change)))
        .toThrow("M4F_CANDIDATE36_HELPER_RESULT_REJECTED");
    }
    expect(() => validateCandidate36HelperOutput(Buffer.from("{}")))
      .toThrow("M4F_CANDIDATE36_HELPER_STDOUT_INVALID");
  });
});
