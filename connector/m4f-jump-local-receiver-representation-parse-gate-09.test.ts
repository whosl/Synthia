import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_SHA256,
  BOUND_JUMP_RECEIVER_SOURCE_LENGTH,
  BOUND_JUMP_RECEIVER_SOURCE_SHA256,
  type BoundJumpPhaseResult,
  CeremonyFailure,
  type MasterAuditEvidence,
  type ProcessObservation,
} from "./scripts/m4f-bound-jump-transport.ts";
import {
  RECEIVER_REPRESENTATION_ARTIFACT_09,
  RECEIVER_REPRESENTATION_ARTIFACT_09_LENGTH,
  RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256,
} from "./scripts/invoke-m4f-jump-local-receiver-representation-diagnostic-09.ts";
import {
  RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09,
  RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09_LENGTH,
  RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09_SHA256,
  runReceiverRepresentationParseGate09,
} from "./scripts/invoke-m4f-jump-local-receiver-representation-parse-gate-09.ts";

const ENV = "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_PARSE_GATE_CONFIRMATION_09";
const TOKEN = "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_PARSE_GATE_20260827_09";
const PHASE = "jump-local-receiver-representation-parse-gate-09:parse";
const NETWORK = "p87062\ncssh\nf3\ntIPv4\nPTCP\nn100.123.31.75:65322->100.66.198.60:22\nTST=ESTABLISHED\nTQR=0\nTQS=0\n";
afterEach(() => delete process.env[ENV]);

describe("M4-F receiver representation parse gate _09", () => {
  test("is independently confirmed, single-shot, and returns only redacted evidence", () => {
    let calls = 0;
    expect(capture(() => runReceiverRepresentationParseGate09({ invokePhase: () => { calls += 1; return phase(); } })).code).toBe("M4F_RECEIVER_REPRESENTATION_PARSE_09_CONFIRMATION_REQUIRED");
    expect(calls).toBe(0);
    process.env[ENV] = TOKEN;
    const result = runReceiverRepresentationParseGate09({ invokePhase: (name, artifact) => {
      calls += 1;
      expect(name).toBe(PHASE);
      expect(artifact).toBe(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09);
      return phase();
    } });
    expect(calls).toBe(1);
    expect(result.status).toBe("parsed_not_invoked");
    expect(JSON.stringify(result)).not.toContain("stdout_base64");
  });

  test("embeds the exact frozen _09 target and has no target invocation path", () => {
    const encoded = /\$targetBase64 = "([A-Za-z0-9+/=]+)"/u.exec(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09)?.[1];
    expect(encoded).toBeDefined();
    expect(Buffer.from(encoded!, "base64").equals(Buffer.from(RECEIVER_REPRESENTATION_ARTIFACT_09))).toBe(true);
    expect(createHash("sha256").update(Buffer.from(encoded!, "base64")).digest("hex")).toBe(RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09).toContain("target_body_not_invoked = $true");
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09).toContain("[System.Management.Automation.Language.Parser]::ParseInput");
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09.match(/\[System\.Management\.Automation\.Language\.Parser\]::ParseInput\(/gu)).toHaveLength(1);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09.match(/\[ScriptBlock\]::Create\(/gu)).toHaveLength(1);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09).not.toMatch(/Invoke-Expression|Invoke-Command|\.Invoke\s*\(|\.AddScript\s*\(|&\s*(?:\$targetSource|\$constructedTarget)|^\s*\.\s+(?:\$targetSource|\$constructedTarget)/imu);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09).not.toMatch(/Get-CimInstance|Get-Process|Start-Process|Stop-Process|Vivado|hw_server|staging/iu);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09_LENGTH).toBe(19_540);
    expect(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09_SHA256).toBe("892525d449f666bea9a3dd246b7a0ffa590d26147e14ec0a2c7b575e67727bac");
  });

  test("rejects parse, framing, phase, and target drift without invoking again", () => {
    process.env[ENV] = TOKEN;
    const mutations: Array<(value: BoundJumpPhaseResult) => void> = [
      (value) => { value.phase = "jump-local-receiver-representation-08:diagnose"; },
      (value) => { value.payload.target_body_not_invoked = false; },
      (value) => { value.payload.target_artifact_sha256 = "0".repeat(64); },
      (value) => { value.payload.parse_error_count = 1; value.payload.status = "parse_rejected"; },
      (value) => { value.process.stdout_base64 = Buffer.from(`${JSON.stringify(value.identity)}\n${JSON.stringify(value.payload)}\n`).toString("base64"); },
    ];
    for (const mutate of mutations) {
      const value = phase();
      mutate(value);
      expect(capture(() => runReceiverRepresentationParseGate09({ invokePhase: () => value })).code).toBe("M4F_RECEIVER_REPRESENTATION_PARSE_09_OUTPUT_INVALID");
    }
  });

  test("retains conservative stage-aware transport failure with no raw stream", () => {
    process.env[ENV] = TOKEN;
    const failure = capture(() => runReceiverRepresentationParseGate09({ invokePhase: () => {
      throw new CeremonyFailure({ schema: "legacy", code: "M4F_BOUND_PHASE_SPAWN_SYNC_FAILED", process: proc(true), input: input(), transport_trace: { schema: "synthia-m4f-bound-transport-trace-09.v1", transport_stage: "child_execution", child_state: "unknown", child_outcome_state: "unknown", effect_state: "unknown", master_before: master(), master_after: null } });
    } }));
    expect(failure.code).toBe("M4F_RECEIVER_REPRESENTATION_PARSE_09_TRANSPORT_FAILED");
    expect((failure.transport_failure as Record<string, unknown>).effect_state).toBe("unknown");
    expect(JSON.stringify(failure)).not.toContain(Buffer.from("raw remote parse stream").toString("base64"));
  });
});

function capture(run: () => unknown): Record<string, unknown> { try { run(); } catch (error) { expect(error).toBeInstanceOf(CeremonyFailure); return (error as CeremonyFailure).detail; } throw new Error("expected failure"); }
function payload(): Record<string, unknown> { return { schema: "synthia-m4f-receiver-representation-parse-09-gate.v1", status: "parsed_not_invoked", target_artifact_length: RECEIVER_REPRESENTATION_ARTIFACT_09_LENGTH, target_artifact_sha256: RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256, target_source_character_length: RECEIVER_REPRESENTATION_ARTIFACT_09.length, target_source_utf8_length: RECEIVER_REPRESENTATION_ARTIFACT_09_LENGTH, target_source_sha256: RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256, powershell_edition: "Desktop", powershell_version: "5.1.19041.5607", process_bitness: 64, language_mode: "FullLanguage", parser_ast_type: "System.Management.Automation.Language.ScriptBlockAst", parser_extent_start_offset: 0, parser_extent_end_offset: RECEIVER_REPRESENTATION_ARTIFACT_09.length, parser_extent_character_length: RECEIVER_REPRESENTATION_ARTIFACT_09.length, parser_extent_utf8_length: RECEIVER_REPRESENTATION_ARTIFACT_09_LENGTH, parser_extent_sha256: RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256, parse_error_count: 0, parse_errors_truncated: false, parse_errors: [], target_scriptblock_constructed: true, constructed_ast_type: "System.Management.Automation.Language.ScriptBlockAst", constructed_extent_start_offset: 0, constructed_extent_end_offset: RECEIVER_REPRESENTATION_ARTIFACT_09.length, constructed_extent_character_length: RECEIVER_REPRESENTATION_ARTIFACT_09.length, constructed_extent_utf8_length: RECEIVER_REPRESENTATION_ARTIFACT_09_LENGTH, constructed_extent_sha256: RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256, scriptblock_create_exception: null, target_body_not_invoked: true }; }
function proc(ambiguous = false, stdout = "raw remote parse stream"): ProcessObservation { return { exit_status: ambiguous ? null : 0, signal: ambiguous ? "SIGTERM" : null, error_code: ambiguous ? "ETIMEDOUT" : null, stdout_base64: Buffer.from(stdout).toString("base64"), stderr_base64: "", timed_out: ambiguous, outcome_ambiguous: ambiguous, retry_permitted: false }; }
function input() { const stdin = Buffer.from(`${Buffer.from(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09).toString("base64")}\n`, "ascii"); return { artifact_length: RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09_LENGTH, artifact_sha256: RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09_SHA256, stdin_length: stdin.length, stdin_sha256: createHash("sha256").update(stdin).digest("hex"), receiver_source_length: BOUND_JUMP_RECEIVER_SOURCE_LENGTH, receiver_source_sha256: BOUND_JUMP_RECEIVER_SOURCE_SHA256, receiver_encoded_length: BOUND_JUMP_RECEIVER_ENCODED_LENGTH, receiver_encoded_sha256: BOUND_JUMP_RECEIVER_ENCODED_SHA256, receiver_command_length: BOUND_JUMP_RECEIVER_COMMAND_LENGTH, receiver_command_maximum: 8_192 }; }
function master(): MasterAuditEvidence { return { schema: "synthia-m4f-bound-master-audit.v1", master_pid: 87062, master_socket: "/private/tmp/synthia-m4f-jump.sock", known_hosts_path: "/Users/wenzhuolin/.ssh/known_hosts", host_key_fingerprint: "SHA256:I37M/4mZJwdlChfZyay+GSbhTuRKEQthOZW7sHmugh8", ssh_executable: "/usr/bin/ssh", master_effective_config_sha256: "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9", child_effective_config_sha256: "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8", network_sha256: "02c94dce4f86ac0627bb4d1a960ff8fb1dd6cfc1bcb6f77cfaccb20387c7d6f1", network_process: proc(false, NETWORK), network_connection: { fd: 3, protocol: "TCP", local_address: "100.123.31.75", local_port: 65322, remote_address: "100.66.198.60", remote_port: 22, state: "ESTABLISHED" } }; }
function phase(): BoundJumpPhaseResult { const value = payload(); const identity = { schema: "synthia-m4f-jump-identity.v1", computer_name: "DESKTOP-E380LR7", identity_name: "desktop-e380lr7\\administrator", identity_sid: "S-1-5-21-3442870711-319385569-2277832987-500" }; const stdout = `${JSON.stringify(identity)}\r\n${JSON.stringify(value)}\r\n`; return { schema: "synthia-m4f-bound-phase.v1", phase: PHASE, identity, payload: value, process: proc(false, stdout), input: input(), master_before: master(), master_after: master() }; }
