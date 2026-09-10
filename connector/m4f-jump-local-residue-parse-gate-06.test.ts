import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertJumpLocalResidueParseGateArtifactFrozen,
  JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT,
  JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_LENGTH,
  JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_SHA256,
  runJumpLocalResidueParseGate06,
} from "./scripts/invoke-m4f-jump-local-residue-parse-gate-06.ts";
import {
  runJumpLocalResidueObservation,
  findPowerShell51MultilineCommandInvocationRisks,
  JUMP_LOCAL_RESIDUE_ARTIFACT,
  JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
  JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256,
} from "./scripts/invoke-m4f-jump-local-residue-observation-06.ts";
import {
  BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_SHA256,
  BOUND_JUMP_RECEIVER_SOURCE_LENGTH,
  BOUND_JUMP_RECEIVER_SOURCE_SHA256,
  CeremonyFailure,
  MAX_BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  type BoundJumpPhaseResult,
  type MasterAuditEvidence,
  type ProcessObservation,
} from "./scripts/m4f-bound-jump-transport.ts";

const TOKEN = "SYNTHIA_M4F_JUMP_LOCAL_RESIDUE_PARSE_GATE_20260827_06";
const ENV = "SYNTHIA_M4F_JUMP_LOCAL_RESIDUE_PARSE_GATE_CONFIRMATION";
const OBSERVATION_ENV = "SYNTHIA_M4F_JUMP_LOCAL_RESIDUE_CONFIRMATION_06";
const OBSERVATION_TOKEN = "SYNTHIA_M4F_JUMP_LOCAL_RESIDUE_OBSERVATION_20260827_06";
const USER_SID = "S-1-5-21-3442870711-319385569-2277832987-500";
const MASTER_HASH = "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
const CHILD_HASH = "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
const NETWORK_HASH = "02c94dce4f86ac0627bb4d1a960ff8fb1dd6cfc1bcb6f77cfaccb20387c7d6f1";

afterEach(() => {
  delete process.env[ENV];
  delete process.env[OBSERVATION_ENV];
});

describe("M4-F jump-local residue PowerShell 5.1 parse gate _06", () => {
  test("is an independently confirmed, single-phase ceremony", () => {
    let calls = 0;
    const invokePhase = (): BoundJumpPhaseResult => {
      calls += 1;
      return phase(parsedPayload());
    };
    expect(capture(() => runJumpLocalResidueParseGate06({ invokePhase })).code)
      .toBe("M4F_JUMP_LOCAL_RESIDUE_PARSE_CONFIRMATION_REQUIRED");
    process.env[OBSERVATION_ENV] = OBSERVATION_TOKEN;
    expect(capture(() => runJumpLocalResidueParseGate06({ invokePhase })).code)
      .toBe("M4F_JUMP_LOCAL_RESIDUE_PARSE_CONFIRMATION_REQUIRED");
    expect(calls).toBe(0);

    process.env[ENV] = TOKEN;
    let seenPhase = "";
    let seenArtifact = "";
    const result = runJumpLocalResidueParseGate06({
      invokePhase: (name, artifact) => {
        calls += 1;
        seenPhase = name;
        seenArtifact = artifact;
        return phase(parsedPayload());
      },
    });
    expect(result.status).toBe("parsed_not_invoked");
    expect(calls).toBe(1);
    expect(seenPhase).toBe("jump-local-residue-parse-gate-06:parse");
    expect(seenArtifact).toBe(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT);
  });

  test("embeds exactly the frozen _06 target and can only parse or create, never invoke it", () => {
    expect(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_LENGTH).toBe(29_299);
    expect(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_SHA256)
      .toBe("2ab9fef7e00e16535abe3f009036a938a88e19b5862cb7cd8e7532b874e3fc2b");
    const match = /\$targetBase64 = "([A-Za-z0-9+/=]+)"/u
      .exec(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT);
    expect(match).not.toBeNull();
    const embedded = Buffer.from(match![1]!, "base64");
    expect(embedded.toString("base64")).toBe(match![1]!);
    expect(embedded.equals(Buffer.from(JUMP_LOCAL_RESIDUE_ARTIFACT, "utf8"))).toBe(true);
    expect(embedded.length).toBe(JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH);
    expect(createHash("sha256").update(embedded).digest("hex"))
      .toBe(JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256);
    expect(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT)
      .toContain("[System.Management.Automation.Language.Parser]::ParseInput(");
    expect(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT)
      .toContain("[ScriptBlock]::Create($targetSource)");
    expect(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT).toContain("target_body_not_invoked = $true");
    expect(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT)
      .not.toMatch(/Invoke-Expression|Invoke-Command|\.Invoke\(|&\s*\$targetSource|\.\s+\$targetSource/iu);
    expect(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT)
      .not.toMatch(/&\s*\$constructedTarget|\.\s+\$constructedTarget|\$constructedTarget\s*\.\s*(?:Invoke|InvokeReturnAsIs)\s*\(|Invoke-Command[^\r\n]*\$constructedTarget|(?:ForEach|Where)-Object[^\r\n]*\$constructedTarget|%\s+\$constructedTarget|\|[^\r\n]*\$constructedTarget|AddScript[^\r\n]*\$constructedTarget|AddCommand[^\r\n]*\$constructedTarget|\.Invoke\([^\r\n]*\$constructedTarget|PowerShell[^\r\n]*\$constructedTarget/iu);
    expect(findPowerShell51MultilineCommandInvocationRisks(
      JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT,
    )).toEqual([]);
    expect(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT.split("\n")
      .filter((line) => line.includes("$targetSource"))).toEqual([
      "$targetSource = $strictUtf8.GetString($targetBytes)",
      "if ($strictUtf8.GetBytes($targetSource).Length -ne $targetBytes.Length) {",
      "$parsedTarget = [System.Management.Automation.Language.Parser]::ParseInput($targetSource, [ref]$tokens, [ref]$parseErrors)",
      "  $constructedTarget = [ScriptBlock]::Create($targetSource)",
      "  target_source_character_length = [int]$targetSource.Length",
    ]);
    expect(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT.split("\n")
      .filter((line) => line.includes("$constructedTarget"))).toEqual([
      "$constructedTarget = $null",
      "  $constructedTarget = [ScriptBlock]::Create($targetSource)",
      "$targetScriptblockConstructed = $null -ne $constructedTarget",
      "  $constructedExtentText = [string]$constructedTarget.Ast.Extent.Text",
      "  $constructedAstType = [string]$constructedTarget.Ast.GetType().FullName",
      "  $constructedExtentStartOffset = [int]$constructedTarget.Ast.Extent.StartOffset",
      "  $constructedExtentEndOffset = [int]$constructedTarget.Ast.Extent.EndOffset",
    ]);
    expect(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT)
      .not.toMatch(/Get-CimInstance|Get-Process|Start-Process|Process\.Start|Stop-Process|\.Kill\(|\bTerminate\b/iu);
    expect(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT)
      .not.toMatch(/Get-Content|Set-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item|Set-Acl/iu);
    expect(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT)
      .not.toMatch(/-ComputerName|-CimSession|New-CimSession|Remove-CimSession|Invoke-WebRequest|Invoke-RestMethod|TcpClient|Socket/iu);
    expect(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT)
      .not.toMatch(/id_192|staging|Vivado|hw_server|192\.168\.31\.66|100\.66\.198\.60|Administrator@/iu);
  });

  test("freezes the wrapper before transport and keeps confirmations isolated both ways", () => {
    expect(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_LENGTH).toBe(29_299);
    expect(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_SHA256)
      .toBe("2ab9fef7e00e16535abe3f009036a938a88e19b5862cb7cd8e7532b874e3fc2b");
    expect(createHash("sha256").update(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT).digest("hex"))
      .toBe(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_SHA256);
    const source = readFileSync(
      new URL("./scripts/invoke-m4f-jump-local-residue-parse-gate-06.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      "if (JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_LENGTH !== EXPECTED_ARTIFACT_LENGTH",
    );
    expect(source).toContain(
      'throw new Error("M4F_JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_DRIFT")',
    );
    expect(source.indexOf("M4F_JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_DRIFT"))
      .toBeLessThan(source.indexOf("export function runJumpLocalResidueParseGate06"));
    expect(() => assertJumpLocalResidueParseGateArtifactFrozen()).not.toThrow();
    expect(() => assertJumpLocalResidueParseGateArtifactFrozen(
      JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_LENGTH + 1,
      JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_SHA256,
    )).toThrow("M4F_JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_DRIFT");
    expect(() => assertJumpLocalResidueParseGateArtifactFrozen(
      JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_LENGTH,
      "0".repeat(64),
    )).toThrow("M4F_JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_DRIFT");
    process.env[ENV] = TOKEN;
    let observationCalls = 0;
    expect(capture(() => runJumpLocalResidueObservation({
      invokePhase: () => { observationCalls += 1; return phase(parsedPayload()); },
    })).code).toBe("M4F_JUMP_LOCAL_RESIDUE_CONFIRMATION_REQUIRED");
    expect(observationCalls).toBe(0);
  });

  test("accepts only parsed_not_invoked and retains bounded parse_rejected raw evidence", () => {
    withConfirmation(() => {
      expect(runJumpLocalResidueParseGate06({
        invokePhase: () => phase(parsedPayload()),
      }).status).toBe("parsed_not_invoked");
      for (const rejected of [rejectedPayload(), constructionRejectedPayload()]) {
        const raw = phase(rejected);
        const failure = capture(() => runJumpLocalResidueParseGate06({
          invokePhase: () => raw,
        }));
        expect(failure.code).toBe("M4F_JUMP_LOCAL_RESIDUE_PARSE_REJECTED");
        expect(failure.observation).toBe(raw);
      }
    });
  });

  test("rejects target, version, state, bounds, raw evidence, and phase drift", () => {
    const payloadMutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => { value.target_artifact_sha256 = "0".repeat(64); },
      (value) => { value.target_artifact_length = 1; },
      (value) => { value.powershell_version = "7.4.0.0"; },
      (value) => { value.powershell_edition = "Core"; },
      (value) => { value.process_bitness = 32; },
      (value) => { value.language_mode = "ConstrainedLanguage"; },
      (value) => { value.target_body_not_invoked = false; },
      (value) => { value.parser_extent_end_offset = 1; },
      (value) => { value.parser_extent_sha256 = "0".repeat(64); },
      (value) => { value.constructed_extent_sha256 = "0".repeat(64); },
      (value) => { value.status = "parse_rejected"; },
      (value) => { value.parse_error_count = 1; },
      (value) => { value.parse_errors_truncated = true; },
      (value) => { value.scriptblock_create_exception = exceptionFact("unexpected"); },
      (value) => { value.unknown = true; },
      (value) => {
        Object.assign(value, rejectedPayload());
        ((value.parse_errors as Record<string, unknown>[])[0]!).message_utf8_sha256 = "f".repeat(64);
      },
      (value) => {
        Object.assign(value, rejectedPayload());
        ((value.parse_errors as Record<string, unknown>[])[0]!).end_offset = JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH + 1;
      },
    ];
    withConfirmation(() => {
      for (const mutate of payloadMutations) {
        const value = parsedPayload();
        mutate(value);
        expect(capture(() => runJumpLocalResidueParseGate06({
          invokePhase: () => phase(value),
        })).code).toBe("M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID");
      }
      for (const mutate of [
        (value: BoundJumpPhaseResult) => { value.phase = "jump-local-residue-06:observe"; },
        (value: BoundJumpPhaseResult) => { value.process.timed_out = true; },
        (value: BoundJumpPhaseResult) => { value.input.artifact_sha256 = "0".repeat(64); },
        (value: BoundJumpPhaseResult) => { value.master_after.master_pid += 1; },
      ]) {
        const value = phase(parsedPayload());
        mutate(value);
        expect(capture(() => runJumpLocalResidueParseGate06({
          invokePhase: () => value,
        })).code).toBe("M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID");
      }
    });
  });
});

function withConfirmation(run: () => void): void {
  process.env[ENV] = TOKEN;
  try { run(); } finally { delete process.env[ENV]; }
}

function capture(run: () => unknown): Record<string, unknown> {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(CeremonyFailure);
    return (error as CeremonyFailure).detail;
  }
  throw new Error("expected CeremonyFailure");
}

function messageFact(message: string): Record<string, unknown> {
  const bytes = Buffer.from(message, "utf8");
  return {
    message_utf8_length: bytes.length,
    message_utf8_sha256: createHash("sha256").update(bytes).digest("hex"),
    message_utf8_base64: bytes.toString("base64"),
  };
}

function exceptionFact(message: string): Record<string, unknown> {
  return {
    schema: "synthia-m4f-jump-local-residue-parse-exception.v1",
    type: "System.Management.Automation.ParseException",
    hresult: -2_147_233_083,
    ...messageFact(message),
  };
}

function parseErrorFact(): Record<string, unknown> {
  return {
    schema: "synthia-m4f-jump-local-residue-parse-error.v1",
    error_id: "ExpectedExpression",
    ...messageFact("Expected expression after '('."),
    start_offset: 100,
    end_offset: 101,
  };
}

function parsedPayload(): Record<string, unknown> {
  return {
    schema: "synthia-m4f-jump-local-residue-parse-gate.v1",
    status: "parsed_not_invoked",
    target_artifact_length: JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
    target_artifact_sha256: JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256,
    target_source_character_length: JUMP_LOCAL_RESIDUE_ARTIFACT.length,
    target_source_utf8_length: JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
    target_source_sha256: JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256,
    powershell_edition: "Desktop",
    powershell_version: "5.1.19041.5607",
    process_bitness: 64,
    language_mode: "FullLanguage",
    parser_ast_type: "System.Management.Automation.Language.ScriptBlockAst",
    parser_extent_start_offset: 0,
    parser_extent_end_offset: JUMP_LOCAL_RESIDUE_ARTIFACT.length,
    parser_extent_character_length: JUMP_LOCAL_RESIDUE_ARTIFACT.length,
    parser_extent_utf8_length: JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
    parser_extent_sha256: JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256,
    parse_error_count: 0,
    parse_errors_truncated: false,
    parse_errors: [],
    target_scriptblock_constructed: true,
    constructed_ast_type: "System.Management.Automation.Language.ScriptBlockAst",
    constructed_extent_start_offset: 0,
    constructed_extent_end_offset: JUMP_LOCAL_RESIDUE_ARTIFACT.length,
    constructed_extent_character_length: JUMP_LOCAL_RESIDUE_ARTIFACT.length,
    constructed_extent_utf8_length: JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
    constructed_extent_sha256: JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256,
    scriptblock_create_exception: null,
    target_body_not_invoked: true,
  };
}

function rejectedPayload(): Record<string, unknown> {
  return {
    ...parsedPayload(),
    status: "parse_rejected",
    parse_error_count: 1,
    parse_errors: [parseErrorFact()],
  };
}

function constructionRejectedPayload(): Record<string, unknown> {
  return {
    ...parsedPayload(),
    status: "parse_rejected",
    target_scriptblock_constructed: false,
    constructed_ast_type: null,
    constructed_extent_start_offset: null,
    constructed_extent_end_offset: null,
    constructed_extent_character_length: null,
    constructed_extent_utf8_length: null,
    constructed_extent_sha256: null,
    scriptblock_create_exception: exceptionFact("ScriptBlock parse rejected"),
  };
}

function processObservation(): ProcessObservation {
  return {
    exit_status: 0,
    signal: null,
    error_code: null,
    stdout_base64: "",
    stderr_base64: "",
    timed_out: false,
    outcome_ambiguous: false,
    retry_permitted: false,
  };
}

function master(): MasterAuditEvidence {
  return {
    schema: "synthia-m4f-bound-master-audit.v1",
    master_pid: 87_062,
    master_socket: "/private/tmp/synthia-m4f-jump.sock",
    known_hosts_path: "/Users/wenzhuolin/.ssh/known_hosts",
    host_key_fingerprint: "SHA256:I37M/4mZJwdlChfZyay+GSbhTuRKEQthOZW7sHmugh8",
    ssh_executable: "/usr/bin/ssh",
    master_effective_config_sha256: MASTER_HASH,
    child_effective_config_sha256: CHILD_HASH,
    network_sha256: NETWORK_HASH,
    network_process: processObservation(),
    network_connection: {
      fd: 1,
      protocol: "TCP",
      local_address: "100.123.31.75",
      local_port: 50_000,
      remote_address: "100.66.198.60",
      remote_port: 22,
      state: "ESTABLISHED",
    },
  };
}

function phase(payload: Record<string, unknown>): BoundJumpPhaseResult {
  const result: BoundJumpPhaseResult = {
    schema: "synthia-m4f-bound-phase.v1",
    phase: "jump-local-residue-parse-gate-06:parse",
    identity: {
      schema: "synthia-m4f-jump-identity.v1",
      computer_name: "DESKTOP-E380LR7",
      identity_name: "desktop-e380lr7\\administrator",
      identity_sid: USER_SID,
    },
    payload,
    process: processObservation(),
    input: {
      artifact_length: JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_LENGTH,
      artifact_sha256: JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_SHA256,
      stdin_length: 0,
      stdin_sha256: "",
      receiver_source_length: BOUND_JUMP_RECEIVER_SOURCE_LENGTH,
      receiver_source_sha256: BOUND_JUMP_RECEIVER_SOURCE_SHA256,
      receiver_encoded_length: BOUND_JUMP_RECEIVER_ENCODED_LENGTH,
      receiver_encoded_sha256: BOUND_JUMP_RECEIVER_ENCODED_SHA256,
      receiver_command_length: BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
      receiver_command_maximum: MAX_BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
    },
    master_before: master(),
    master_after: master(),
  };
  const stdin = Buffer.from(
    `${Buffer.from(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT, "utf8").toString("base64")}\n`,
    "ascii",
  );
  result.input.stdin_length = stdin.length;
  result.input.stdin_sha256 = createHash("sha256").update(stdin).digest("hex");
  result.process.stdout_base64 = Buffer.from(
    `${JSON.stringify(result.identity)}\n${JSON.stringify(payload)}\n`,
    "utf8",
  ).toString("base64");
  return result;
}
