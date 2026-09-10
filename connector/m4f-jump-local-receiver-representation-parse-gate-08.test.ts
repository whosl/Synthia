import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertReceiverRepresentationParseGateArtifactFrozen,
  RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT,
  RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_LENGTH,
  RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_SHA256,
  runReceiverRepresentationParseGate08,
} from "./scripts/invoke-m4f-jump-local-receiver-representation-parse-gate-08.ts";
import {
  runReceiverRepresentationDiagnostic08,
  RECEIVER_REPRESENTATION_ARTIFACT,
  RECEIVER_REPRESENTATION_ARTIFACT_LENGTH,
  RECEIVER_REPRESENTATION_ARTIFACT_SHA256,
} from "./scripts/invoke-m4f-jump-local-receiver-representation-diagnostic-08.ts";
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

const TOKEN = "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_PARSE_GATE_20260827_08";
const ENV = "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_PARSE_GATE_CONFIRMATION";
const OBSERVATION_ENV = "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_CONFIRMATION";
const OBSERVATION_TOKEN = "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_20260827_08";
const USER_SID = "S-1-5-21-3442870711-319385569-2277832987-500";
const MASTER_HASH = "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
const CHILD_HASH = "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
const NETWORK_HASH = "02c94dce4f86ac0627bb4d1a960ff8fb1dd6cfc1bcb6f77cfaccb20387c7d6f1";
const NETWORK_OUTPUT = "p87062\ncssh\nf3\ntIPv4\nPTCP\nn100.123.31.75:65322->100.66.198.60:22\nTST=ESTABLISHED\nTQR=0\nTQS=0\n";

afterEach(() => {
  delete process.env[ENV];
  delete process.env[OBSERVATION_ENV];
});

describe("M4-F receiver representation PowerShell 5.1 parse gate _08", () => {
  test("is an independently confirmed, single-phase ceremony", () => {
    let calls = 0;
    const invokePhase = (): BoundJumpPhaseResult => {
      calls += 1;
      return phase(parsedPayload());
    };
    expect(capture(() => runReceiverRepresentationParseGate08({ invokePhase })).code)
      .toBe("M4F_JUMP_LOCAL_RESIDUE_PARSE_CONFIRMATION_REQUIRED");
    process.env[OBSERVATION_ENV] = OBSERVATION_TOKEN;
    expect(capture(() => runReceiverRepresentationParseGate08({ invokePhase })).code)
      .toBe("M4F_JUMP_LOCAL_RESIDUE_PARSE_CONFIRMATION_REQUIRED");
    expect(calls).toBe(0);

    process.env[ENV] = TOKEN;
    let seenPhase = "";
    let seenArtifact = "";
    const result = runReceiverRepresentationParseGate08({
      invokePhase: (name, artifact) => {
        calls += 1;
        seenPhase = name;
        seenArtifact = artifact;
        return phase(parsedPayload());
      },
    });
    expect(result.status).toBe("parsed_not_invoked");
    expect(calls).toBe(1);
    expect(seenPhase).toBe("jump-local-receiver-representation-parse-gate-08:parse");
    expect(seenArtifact).toBe(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT);
  });

  test("embeds exactly the frozen _08 diagnostic target and can only parse or create, never invoke it", () => {
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_LENGTH).toBe(19_236);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_SHA256)
      .toBe("3241f48af99b1710619bf9874d34a1b36ab3f1649d36cebf8cbe1c1bfc4c0a35");
    const match = /\$targetBase64 = "([A-Za-z0-9+/=]+)"/u
      .exec(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT);
    expect(match).not.toBeNull();
    const embedded = Buffer.from(match![1]!, "base64");
    expect(embedded.toString("base64")).toBe(match![1]!);
    expect(embedded.equals(Buffer.from(RECEIVER_REPRESENTATION_ARTIFACT, "utf8"))).toBe(true);
    expect(embedded.length).toBe(RECEIVER_REPRESENTATION_ARTIFACT_LENGTH);
    expect(createHash("sha256").update(embedded).digest("hex"))
      .toBe(RECEIVER_REPRESENTATION_ARTIFACT_SHA256);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT)
      .toContain("[System.Management.Automation.Language.Parser]::ParseInput(");
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT)
      .toContain("[ScriptBlock]::Create($targetSource)");
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT).toContain("target_body_not_invoked = $true");
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT)
      .not.toMatch(/Invoke-Expression|Invoke-Command|\.Invoke\(|&\s*\$targetSource|\.\s+\$targetSource/iu);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT)
      .not.toMatch(/&\s*\$constructedTarget|\.\s+\$constructedTarget|\$constructedTarget\s*\.\s*(?:Invoke|InvokeReturnAsIs)\s*\(|Invoke-Command[^\r\n]*\$constructedTarget|(?:ForEach|Where)-Object[^\r\n]*\$constructedTarget|%\s+\$constructedTarget|\|[^\r\n]*\$constructedTarget|AddScript[^\r\n]*\$constructedTarget|AddCommand[^\r\n]*\$constructedTarget|\.Invoke\([^\r\n]*\$constructedTarget|PowerShell[^\r\n]*\$constructedTarget/iu);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT.split("\n")
      .filter((line) => line.includes("$targetSource"))).toEqual([
      "$targetSource = $strictUtf8.GetString($targetBytes)",
      "if ($strictUtf8.GetBytes($targetSource).Length -ne $targetBytes.Length) {",
      "$parsedTarget = [System.Management.Automation.Language.Parser]::ParseInput($targetSource, [ref]$tokens, [ref]$parseErrors)",
      "  $constructedTarget = [ScriptBlock]::Create($targetSource)",
      "  target_source_character_length = [int]$targetSource.Length",
    ]);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT.split("\n")
      .filter((line) => line.includes("$constructedTarget"))).toEqual([
      "$constructedTarget = $null",
      "  $constructedTarget = [ScriptBlock]::Create($targetSource)",
      "$targetScriptblockConstructed = $null -ne $constructedTarget",
      "  $constructedExtentText = [string]$constructedTarget.Ast.Extent.Text",
      "  $constructedAstType = [string]$constructedTarget.Ast.GetType().FullName",
      "  $constructedExtentStartOffset = [int]$constructedTarget.Ast.Extent.StartOffset",
      "  $constructedExtentEndOffset = [int]$constructedTarget.Ast.Extent.EndOffset",
    ]);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT)
      .not.toMatch(/Get-CimInstance|Get-Process|Start-Process|Process\.Start|Stop-Process|\.Kill\(|\bTerminate\b/iu);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT)
      .not.toMatch(/Get-Content|Set-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item|Set-Acl/iu);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT)
      .not.toMatch(/-ComputerName|-CimSession|New-CimSession|Remove-CimSession|Invoke-WebRequest|Invoke-RestMethod|TcpClient|Socket/iu);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT)
      .not.toMatch(/id_192|staging|Vivado|hw_server|192\.168\.31\.66|100\.66\.198\.60|Administrator@/iu);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT).not.toContain("message_utf8_base64");
  });

  test("freezes the wrapper before transport and keeps confirmations isolated both ways", () => {
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_LENGTH).toBe(19_236);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_SHA256)
      .toBe("3241f48af99b1710619bf9874d34a1b36ab3f1649d36cebf8cbe1c1bfc4c0a35");
    expect(createHash("sha256").update(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT).digest("hex"))
      .toBe(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_SHA256);
    const source = readFileSync(
      new URL("./scripts/invoke-m4f-jump-local-receiver-representation-parse-gate-08.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      "if (RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_LENGTH !== EXPECTED_ARTIFACT_LENGTH",
    );
    expect(source).toContain(
      'throw new Error("M4F_RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_DRIFT")',
    );
    expect(source.indexOf("M4F_RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_DRIFT"))
      .toBeLessThan(source.indexOf("export function runReceiverRepresentationParseGate08"));
    expect(() => assertReceiverRepresentationParseGateArtifactFrozen()).not.toThrow();
    expect(() => assertReceiverRepresentationParseGateArtifactFrozen(
      RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_LENGTH + 1,
      RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_SHA256,
    )).toThrow("M4F_RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_DRIFT");
    expect(() => assertReceiverRepresentationParseGateArtifactFrozen(
      RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_LENGTH,
      "0".repeat(64),
    )).toThrow("M4F_RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_DRIFT");
    process.env[ENV] = TOKEN;
    let observationCalls = 0;
    expect(capture(() => runReceiverRepresentationDiagnostic08({
      invokePhase: () => { observationCalls += 1; return phase(parsedPayload()); },
    })).code).toBe("M4F_RECEIVER_REPRESENTATION_CONFIRMATION_REQUIRED");
    expect(observationCalls).toBe(0);
  });

  test("accepts only parsed_not_invoked and retains bounded parse-rejection fingerprints without raw messages", () => {
    withConfirmation(() => {
      expect(runReceiverRepresentationParseGate08({
        invokePhase: () => phase(parsedPayload()),
      }).status).toBe("parsed_not_invoked");
      for (const rejected of [rejectedPayload(), constructionRejectedPayload()]) {
        const raw = phase(rejected);
        const failure = capture(() => runReceiverRepresentationParseGate08({
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
        ((value.parse_errors as Record<string, unknown>[])[0]!).message_utf8_sha256 = "f".repeat(63);
      },
      (value) => {
        Object.assign(value, rejectedPayload());
        ((value.parse_errors as Record<string, unknown>[])[0]!).end_offset = RECEIVER_REPRESENTATION_ARTIFACT_LENGTH + 1;
      },
      (value) => {
        Object.assign(value, rejectedPayload());
        ((value.parse_errors as Record<string, unknown>[])[0]!).error_id = "unsafe\nsource";
      },
      (value) => {
        Object.assign(value, constructionRejectedPayload());
        (value.scriptblock_create_exception as Record<string, unknown>).type = "unsafe exception text";
      },
    ];
    withConfirmation(() => {
      for (const mutate of payloadMutations) {
        const value = parsedPayload();
        mutate(value);
        expect(capture(() => runReceiverRepresentationParseGate08({
          invokePhase: () => phase(value),
        })).code).toBe("M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID");
      }
      for (const mutate of [
        (value: BoundJumpPhaseResult) => { value.phase = "jump-local-receiver-representation-07:diagnose"; },
        (value: BoundJumpPhaseResult) => { value.process.timed_out = true; },
        (value: BoundJumpPhaseResult) => { value.input.artifact_sha256 = "0".repeat(64); },
        (value: BoundJumpPhaseResult) => { value.master_after.master_pid += 1; },
        (value: BoundJumpPhaseResult) => { (value as unknown as Record<string, unknown>).unknown = true; },
        (value: BoundJumpPhaseResult) => { value.identity.unknown = true; },
        (value: BoundJumpPhaseResult) => { (value.process as unknown as Record<string, unknown>).unknown = true; },
        (value: BoundJumpPhaseResult) => { (value.input as unknown as Record<string, unknown>).unknown = true; },
        (value: BoundJumpPhaseResult) => { (value.master_before as unknown as Record<string, unknown>).unknown = true; },
        (value: BoundJumpPhaseResult) => { (value.master_before.network_process as unknown as Record<string, unknown>).unknown = true; },
        (value: BoundJumpPhaseResult) => { (value.master_before.network_connection as unknown as Record<string, unknown>).unknown = true; },
        (value: BoundJumpPhaseResult) => { value.master_before.network_process.stdout_base64 = Buffer.from("forged\n").toString("base64"); value.master_after = structuredClone(value.master_before); },
        (value: BoundJumpPhaseResult) => { value.master_before.network_connection.local_port = 65_321; value.master_after = structuredClone(value.master_before); },
      ]) {
        const value = phase(parsedPayload());
        mutate(value);
        expect(capture(() => runReceiverRepresentationParseGate08({
          invokePhase: () => value,
        })).code).toBe("M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID");
      }
      const transportFailure = capture(() => runReceiverRepresentationParseGate08({
        invokePhase: () => { throw new Error("sensitive transport detail"); },
      }));
      expect(transportFailure.code).toBe("M4F_JUMP_LOCAL_RESIDUE_PARSE_TRANSPORT_FAILED");
      expect(transportFailure.cause).toBeNull();
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
    target_artifact_length: RECEIVER_REPRESENTATION_ARTIFACT_LENGTH,
    target_artifact_sha256: RECEIVER_REPRESENTATION_ARTIFACT_SHA256,
    target_source_character_length: RECEIVER_REPRESENTATION_ARTIFACT.length,
    target_source_utf8_length: RECEIVER_REPRESENTATION_ARTIFACT_LENGTH,
    target_source_sha256: RECEIVER_REPRESENTATION_ARTIFACT_SHA256,
    powershell_edition: "Desktop",
    powershell_version: "5.1.19041.5607",
    process_bitness: 64,
    language_mode: "FullLanguage",
    parser_ast_type: "System.Management.Automation.Language.ScriptBlockAst",
    parser_extent_start_offset: 0,
    parser_extent_end_offset: RECEIVER_REPRESENTATION_ARTIFACT.length,
    parser_extent_character_length: RECEIVER_REPRESENTATION_ARTIFACT.length,
    parser_extent_utf8_length: RECEIVER_REPRESENTATION_ARTIFACT_LENGTH,
    parser_extent_sha256: RECEIVER_REPRESENTATION_ARTIFACT_SHA256,
    parse_error_count: 0,
    parse_errors_truncated: false,
    parse_errors: [],
    target_scriptblock_constructed: true,
    constructed_ast_type: "System.Management.Automation.Language.ScriptBlockAst",
    constructed_extent_start_offset: 0,
    constructed_extent_end_offset: RECEIVER_REPRESENTATION_ARTIFACT.length,
    constructed_extent_character_length: RECEIVER_REPRESENTATION_ARTIFACT.length,
    constructed_extent_utf8_length: RECEIVER_REPRESENTATION_ARTIFACT_LENGTH,
    constructed_extent_sha256: RECEIVER_REPRESENTATION_ARTIFACT_SHA256,
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

function processObservation(stdout = ""): ProcessObservation {
  return {
    exit_status: 0,
    signal: null,
    error_code: null,
    stdout_base64: Buffer.from(stdout).toString("base64"),
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
    network_process: processObservation(NETWORK_OUTPUT),
    network_connection: {
      fd: 3,
      protocol: "TCP",
      local_address: "100.123.31.75",
      local_port: 65_322,
      remote_address: "100.66.198.60",
      remote_port: 22,
      state: "ESTABLISHED",
    },
  };
}

function phase(payload: Record<string, unknown>): BoundJumpPhaseResult {
  const result: BoundJumpPhaseResult = {
    schema: "synthia-m4f-bound-phase.v1",
    phase: "jump-local-receiver-representation-parse-gate-08:parse",
    identity: {
      schema: "synthia-m4f-jump-identity.v1",
      computer_name: "DESKTOP-E380LR7",
      identity_name: "desktop-e380lr7\\administrator",
      identity_sid: USER_SID,
    },
    payload,
    process: processObservation(),
    input: {
      artifact_length: RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_LENGTH,
      artifact_sha256: RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_SHA256,
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
    `${Buffer.from(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT, "utf8").toString("base64")}\n`,
    "ascii",
  );
  result.input.stdin_length = stdin.length;
  result.input.stdin_sha256 = createHash("sha256").update(stdin).digest("hex");
  result.process.stdout_base64 = Buffer.from(
    `${JSON.stringify(result.identity)}\r\n${JSON.stringify(payload)}\r\n`,
    "utf8",
  ).toString("base64");
  return result;
}
