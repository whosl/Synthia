import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assertReceiverRepresentationArtifactFrozen,
  RECEIVER_REPRESENTATION_ARTIFACT,
  RECEIVER_REPRESENTATION_ARTIFACT_LENGTH,
  RECEIVER_REPRESENTATION_ARTIFACT_SHA256,
  runReceiverRepresentationDiagnostic08,
} from "./scripts/invoke-m4f-jump-local-receiver-representation-diagnostic-08.ts";
import {
  BOUND_JUMP_RECEIVER_COMMAND_LENGTH, BOUND_JUMP_RECEIVER_ENCODED_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_SHA256, BOUND_JUMP_RECEIVER_SOURCE_LENGTH,
  BOUND_JUMP_RECEIVER_SOURCE_SHA256, CeremonyFailure, MAX_BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  type BoundJumpPhaseResult, type MasterAuditEvidence, type ProcessObservation,
} from "./scripts/m4f-bound-jump-transport.ts";

const ENV = "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_CONFIRMATION";
const TOKEN = "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_20260827_08";
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const ENCODED = "ec4bb477e8e7bd0c08551837b21ad90e06aaa3bab11e95b44cef5dee0b6a22bb";
const NETWORK_OUTPUT = "p87062\ncssh\nf3\ntIPv4\nPTCP\nn100.123.31.75:65322->100.66.198.60:22\nTST=ESTABLISHED\nTQR=0\nTQS=0\n";
afterEach(() => delete process.env[ENV]);

describe("M4-F current receiver representation diagnostic _08", () => {
  test("is confirmation-first, one phase, frozen, and CRLF strict", () => {
    let calls = 0;
    expect(capture(() => runReceiverRepresentationDiagnostic08({ invokePhase: () => { calls++; return phase(payload()); } })).code)
      .toBe("M4F_RECEIVER_REPRESENTATION_CONFIRMATION_REQUIRED");
    expect(calls).toBe(0);
    process.env[ENV] = TOKEN;
    let name = "";
    const result = runReceiverRepresentationDiagnostic08({ invokePhase: (value) => { calls++; name = value; return phase(payload()); } });
    expect(result.status).toBe("observed");
    expect(calls).toBe(1);
    expect(name).toBe("jump-local-receiver-representation-08:diagnose");
    expect(() => assertReceiverRepresentationArtifactFrozen()).not.toThrow();
    expect(() => assertReceiverRepresentationArtifactFrozen(RECEIVER_REPRESENTATION_ARTIFACT_LENGTH + 1, RECEIVER_REPRESENTATION_ARTIFACT_SHA256)).toThrow();
    const lf = phase(payload());
    lf.process.stdout_base64 = Buffer.from(`${JSON.stringify(lf.identity)}\n${JSON.stringify(lf.payload)}\n`).toString("base64");
    expect(capture(() => runReceiverRepresentationDiagnostic08({ invokePhase: () => lf })).code)
      .toBe("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID");
  });

  test("contains only one exact current-PID CIM query and no active/sensitive capability", () => {
    expect(RECEIVER_REPRESENTATION_ARTIFACT.match(/Get-CimInstance/g)).toHaveLength(1);
    expect(RECEIVER_REPRESENTATION_ARTIFACT).toContain("SELECT ProcessId,ExecutablePath,CommandLine FROM Win32_Process WHERE ProcessId=");
    const query = RECEIVER_REPRESENTATION_ARTIFACT.match(/SELECT ProcessId[^"\r\n]+/u)?.[0];
    expect(query).toBe("SELECT ProcessId,ExecutablePath,CommandLine FROM Win32_Process WHERE ProcessId=");
    expect(query).not.toMatch(/\bOR\b|\bName\b|ParentProcessId|CreationDate/iu);
    expect(RECEIVER_REPRESENTATION_ARTIFACT).not.toMatch(/Get-Process|Sleep/iu);
    expect(RECEIVER_REPRESENTATION_ARTIFACT).not.toMatch(/Process\.Start|Start-Process|Stop-Process|\.Kill\(|\bssh\.exe\b|Invoke-WebRequest|TcpClient|Socket|Vivado|hw_server|192\.168\.31\.66|staging|id_192/iu);
    expect(RECEIVER_REPRESENTATION_ARTIFACT).not.toMatch(/raw_command|encoded_body|decoded_source|message_utf8_base64|exception.*message/iu);
    expect(RECEIVER_REPRESENTATION_ARTIFACT).not.toMatch(/Invoke-Expression|ScriptBlock\]::Create|&\s*\$|\.\s+\$/u);
  });

  test("accepts match, mismatch, and indeterminate as diagnostic evidence", () => {
    process.env[ENV] = TOKEN;
    for (const value of [
      payload(),
      payload({ mismatch: "executable" }),
      ...["query_failed", "cardinality", "pid_binding", "missing_property", "unsafe_executable", "missing_command", "command_bound"]
        .map((failure) => payload({ failure })),
    ]) expect(runReceiverRepresentationDiagnostic08({ invokePhase: () => phase(value) }).status).toBe("observed");
  });

  test("rejects classification, pins, privacy shape, and phase drift", () => {
    process.env[ENV] = TOKEN;
    const mutations: Array<(v: Record<string, unknown>) => void> = [
      (v) => { v.residue_state_evaluated = true; },
      (v) => { v.unknown = true; },
      (v) => { (v.actual as Record<string, unknown>).raw_command = "secret"; },
      (v) => { (v.expected as Record<string, unknown>).encoded_sha256 = "0".repeat(64); },
      (v) => { (v.classification as Record<string, unknown>).earliest_mismatch_stage = "hash"; },
      (v) => { (v.classification as Record<string, unknown>).command_candidate = "none"; },
      (v) => { (v.actual as Record<string, unknown>).executable_path = "C:\\Other\\powershell.exe"; },
    ];
    for (const mutate of mutations) { const value = payload(); mutate(value); expect(capture(() => runReceiverRepresentationDiagnostic08({ invokePhase: () => phase(value) })).code).toBe("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID"); }
    const wrong = phase(payload()); wrong.phase = "other";
    expect(capture(() => runReceiverRepresentationDiagnostic08({ invokePhase: () => wrong })).code).toBe("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID");
  });

  test("rejects failure-code contradictions and nested evidence drift", () => {
    process.env[ENV] = TOKEN;
    const payloadMutations: Array<[Record<string, unknown>, (v: Record<string, unknown>) => void]> = [
      [payload({ failure: "query_failed" }), (v) => { (v.query as Record<string, unknown>).returned_count = 1; (v.actual as Record<string, unknown>).returned_count = 1; }],
      [payload({ failure: "cardinality" }), (v) => { (v.query as Record<string, unknown>).returned_count = 1; (v.actual as Record<string, unknown>).returned_count = 1; }],
      [payload({ failure: "pid_binding" }), (v) => { (v.actual as Record<string, unknown>).executable_path = PS; }],
      [payload({ failure: "missing_command" }), (v) => { (v.actual as Record<string, unknown>).executable_path = null; }],
      [payload({ failure: "command_bound" }), (v) => { v.classification = payload().classification; }],
    ];
    for (const [value, mutate] of payloadMutations) {
      mutate(value);
      expect(capture(() => runReceiverRepresentationDiagnostic08({ invokePhase: () => phase(value) })).code)
        .toBe("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID");
    }
    const phaseMutations: Array<(v: BoundJumpPhaseResult) => void> = [
      (v) => { (v as unknown as Record<string, unknown>).unknown = true; },
      (v) => { v.identity.unknown = true; },
      (v) => { (v.process as unknown as Record<string, unknown>).unknown = true; },
      (v) => { (v.input as unknown as Record<string, unknown>).unknown = true; },
      (v) => { (v.master_before as unknown as Record<string, unknown>).unknown = true; },
      (v) => { (v.master_before.network_process as unknown as Record<string, unknown>).unknown = true; },
      (v) => { (v.master_before.network_connection as unknown as Record<string, unknown>).unknown = true; },
      (v) => { v.master_before.network_process.stdout_base64 = Buffer.from("forged\n").toString("base64"); v.master_after = structuredClone(v.master_before); },
      (v) => { v.master_before.network_connection.local_port = 65_321; v.master_after = structuredClone(v.master_before); },
    ];
    for (const mutate of phaseMutations) {
      const value = phase(payload());
      mutate(value);
      expect(capture(() => runReceiverRepresentationDiagnostic08({ invokePhase: () => value })).code)
        .toBe("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID");
    }
  });
});

function capture(run: () => unknown): Record<string, unknown> { try { run(); } catch (error) { expect(error).toBeInstanceOf(CeremonyFailure); return (error as CeremonyFailure).detail; } throw new Error("expected"); }
function payload(options: { mismatch?: string; failure?: string } = {}): Record<string, unknown> {
  const failure = options.failure ?? null;
  const mismatch = options.mismatch ?? "none";
  const returnedCount = failure === "query_failed" || failure === "cardinality" ? 0 : 1;
  const executableAvailable = failure === null || failure === "missing_command" || failure === "command_bound";
  return {
    schema: "synthia-m4f-current-receiver-representation-diagnostic.v1",
    status: failure ? "indeterminate" : mismatch === "none" ? "representation_match" : "representation_mismatch",
    scope: "current_pid_exact_cim_only", residue_state_evaluated: false, provider_activation_may_create_processes: true,
    failure_code: failure,
    query: { schema: "synthia-m4f-receiver-representation-query.v1", returned_count: returnedCount, elapsed_ticks: 10, stopwatch_frequency: 10_000_000 },
    expected: { schema: "synthia-m4f-receiver-representation-expected.v1", executable_path: PS, encoded_length: 3256, encoded_sha256: ENCODED, basename_command_length: 3346, basename_command_sha256: "facefc9fa05a87804412bd8ab6cff5364a35c84f10413454d308c16f42fc9dc2", fixed_command_length: 3389, fixed_command_sha256: "a0d79d8992e881d114cd4f70e6b916978e372160fb06e3a2bd781bdeb20d074f", quoted_command_length: 3391, quoted_command_sha256: "21521202d8b45084d75ec2d797b1214e41da760efcbe93e340b68ca2fb3fd251" },
    actual: { schema: "synthia-m4f-receiver-representation-actual.v1", returned_count: returnedCount, executable_path: executableAvailable ? mismatch === "executable" ? "C:\\Other\\powershell.exe" : PS : null, command_present: !failure, command_utf8_length: failure ? null : 3346, command_sha256: failure ? null : "facefc9fa05a87804412bd8ab6cff5364a35c84f10413454d308c16f42fc9dc2" },
    classification: failure ? null : { schema: "synthia-m4f-receiver-representation-classification.v1", executable: mismatch === "executable" ? "different" : "ordinal_exact", command_candidate: "basename_exact", marker: "exact", prefix: "basename_exact", token_shape: "base64_shape", encoded_length_matches: true, encoded_sha256_matches: true, canonical_base64: true, utf16le_roundtrip: true, earliest_mismatch_stage: mismatch },
  };
}
function proc(stdout = ""): ProcessObservation { return { exit_status: 0, signal: null, error_code: null, stdout_base64: Buffer.from(stdout).toString("base64"), stderr_base64: "", timed_out: false, outcome_ambiguous: false, retry_permitted: false }; }
function master(): MasterAuditEvidence { return { schema: "synthia-m4f-bound-master-audit.v1", master_pid: 87062, master_socket: "/private/tmp/synthia-m4f-jump.sock", known_hosts_path: "/Users/wenzhuolin/.ssh/known_hosts", host_key_fingerprint: "SHA256:I37M/4mZJwdlChfZyay+GSbhTuRKEQthOZW7sHmugh8", ssh_executable: "/usr/bin/ssh", master_effective_config_sha256: "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9", child_effective_config_sha256: "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8", network_sha256: "02c94dce4f86ac0627bb4d1a960ff8fb1dd6cfc1bcb6f77cfaccb20387c7d6f1", network_process: proc(NETWORK_OUTPUT), network_connection: { fd: 3, protocol: "TCP", local_address: "100.123.31.75", local_port: 65322, remote_address: "100.66.198.60", remote_port: 22, state: "ESTABLISHED" } }; }
function phase(value: Record<string, unknown>): BoundJumpPhaseResult {
  const result: BoundJumpPhaseResult = { schema: "synthia-m4f-bound-phase.v1", phase: "jump-local-receiver-representation-08:diagnose", identity: { schema: "synthia-m4f-jump-identity.v1", computer_name: "DESKTOP-E380LR7", identity_name: "desktop-e380lr7\\administrator", identity_sid: "S-1-5-21-3442870711-319385569-2277832987-500" }, payload: value, process: proc(), input: { artifact_length: RECEIVER_REPRESENTATION_ARTIFACT_LENGTH, artifact_sha256: RECEIVER_REPRESENTATION_ARTIFACT_SHA256, stdin_length: 0, stdin_sha256: "", receiver_source_length: BOUND_JUMP_RECEIVER_SOURCE_LENGTH, receiver_source_sha256: BOUND_JUMP_RECEIVER_SOURCE_SHA256, receiver_encoded_length: BOUND_JUMP_RECEIVER_ENCODED_LENGTH, receiver_encoded_sha256: BOUND_JUMP_RECEIVER_ENCODED_SHA256, receiver_command_length: BOUND_JUMP_RECEIVER_COMMAND_LENGTH, receiver_command_maximum: MAX_BOUND_JUMP_RECEIVER_COMMAND_LENGTH }, master_before: master(), master_after: master() };
  const stdin = Buffer.from(`${Buffer.from(RECEIVER_REPRESENTATION_ARTIFACT).toString("base64")}\n`, "ascii"); result.input.stdin_length = stdin.length; result.input.stdin_sha256 = createHash("sha256").update(stdin).digest("hex"); result.process.stdout_base64 = Buffer.from(`${JSON.stringify(result.identity)}\r\n${JSON.stringify(value)}\r\n`).toString("base64"); return result;
}
