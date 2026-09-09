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
  runReceiverRepresentationDiagnostic09,
} from "./scripts/invoke-m4f-jump-local-receiver-representation-diagnostic-09.ts";

const ENV = "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_CONFIRMATION_09";
const TOKEN = "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_20260827_09";
const PHASE = "jump-local-receiver-representation-09:diagnose";
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const NETWORK = "p87062\ncssh\nf3\ntIPv4\nPTCP\nn100.123.31.75:65322->100.66.198.60:22\nTST=ESTABLISHED\nTQR=0\nTQS=0\n";
afterEach(() => delete process.env[ENV]);

describe("M4-F current receiver representation diagnostic _09", () => {
  test("uses a new confirmation and phase, remains single-shot, and redacts raw process streams", () => {
    let calls = 0;
    expect(capture(() => runReceiverRepresentationDiagnostic09({ invokePhase: () => { calls += 1; return phase(); } })).code).toBe("M4F_RECEIVER_REPRESENTATION_09_CONFIRMATION_REQUIRED");
    expect(calls).toBe(0);
    process.env[ENV] = TOKEN;
    const result = runReceiverRepresentationDiagnostic09({ invokePhase: (name, artifact) => {
      calls += 1;
      expect(name).toBe(PHASE);
      expect(artifact).toBe(RECEIVER_REPRESENTATION_ARTIFACT_09);
      return phase();
    } });
    expect(calls).toBe(1);
    expect(result.predecessor_effect_state).toBe("unknown");
    expect(result.observation.payload).toEqual(payload());
    expect(JSON.stringify(result)).not.toContain("stdout_base64");
    expect(JSON.stringify(result)).not.toContain(Buffer.from("sensitive remote stdout").toString("base64"));
  });

  test("diagnoses only current PID while declaring predecessor _08 unknown without query or cleanup", () => {
    expect(RECEIVER_REPRESENTATION_ARTIFACT_09.match(/Get-CimInstance/g)).toHaveLength(1);
    expect(RECEIVER_REPRESENTATION_ARTIFACT_09).toContain("SELECT ProcessId,ExecutablePath,CommandLine FROM Win32_Process WHERE ProcessId=");
    expect(RECEIVER_REPRESENTATION_ARTIFACT_09).toContain('attempt = "_08"; effect_state = "unknown"; queried = $false; cleanup_attempted = $false');
    expect(RECEIVER_REPRESENTATION_ARTIFACT_09).not.toMatch(/Get-Process|Stop-Process|Remove-|Start-Process|Sleep|ParentProcessId|CreationDate/iu);
    expect(RECEIVER_REPRESENTATION_ARTIFACT_09_LENGTH).toBe(10_222);
    expect(RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256).toBe("76633aaa8a00850501a92d92696b301bd6631d245777c58d943489dce4adfef9");
  });

  test("normalizes every injected legacy trace conservatively and never retains raw stdout", () => {
    process.env[ENV] = TOKEN;
    const scenarios = [
      trace("pre_audit", "not_started_proven", "not_started", null, null),
      trace("child_execution", "unknown", "unknown", master(), null),
      trace("child_execution", "started", "ambiguous", master(), master()),
      trace("post_audit", "started", "ambiguous", master(), null),
      trace("output_validation", "started", "known", master(), master()),
    ];
    for (const transportTrace of scenarios) {
      const failure = capture(() => runReceiverRepresentationDiagnostic09({ invokePhase: () => {
        throw new CeremonyFailure({
          schema: "synthia-m4f-bound-legacy-failure.v1",
          code: transportTrace.child_state === "unknown" ? "M4F_BOUND_PHASE_SPAWN_SYNC_FAILED" : "M4F_BOUND_PHASE_OUTCOME_AMBIGUOUS",
          phase: PHASE,
          reason: transportTrace.transport_stage === "post_audit" ? "post-master-audit-failed" : "local-termination-or-buffer-bound",
          process: proc(true),
          input: input(),
          transport_trace: transportTrace,
        });
      } }));
      expect(failure.code).toBe("M4F_RECEIVER_REPRESENTATION_09_TRANSPORT_FAILED");
      const retained = failure.transport_failure as Record<string, unknown>;
      expect(retained.transport_stage).toBe("unknown");
      expect(retained.child_state).toBe("unknown");
      expect(retained.child_outcome_state).toBe("unknown");
      expect(retained.effect_state).toBe("unknown");
      expect(retained.retry_permitted).toBe(false);
      expect(JSON.stringify(failure)).not.toContain(Buffer.from("sensitive remote stdout").toString("base64"));
    }
  });

  test("invalid or missing native trace is conservatively unknown", () => {
    process.env[ENV] = TOKEN;
    for (const thrown of [new Error("secret unexpected message"), new CeremonyFailure({ schema: "fake", code: "FAKE", transport_trace: { schema: "synthia-m4f-bound-transport-trace-09.v1", transport_stage: "pre_audit" } })]) {
      const failure = capture(() => runReceiverRepresentationDiagnostic09({ invokePhase: () => { throw thrown; } }));
      const retained = failure.transport_failure as Record<string, unknown>;
      expect(retained.transport_stage).toBe("unknown");
      expect(retained.child_state).toBe("unknown");
      expect(retained.effect_state).toBe("unknown");
      expect(JSON.stringify(failure)).not.toContain("secret unexpected message");
    }
  });

  test("validation failure envelope contains only bounded evidence, never an invalid remote payload", () => {
    process.env[ENV] = TOKEN;
    const secret = "raw-command --token do-not-retain";
    const value = phase();
    value.payload.raw_command = secret;
    value.payload.nested = { encoded: Buffer.from(secret).toString("base64") };
    value.process.stdout_base64 = Buffer.from(`${JSON.stringify(value.identity)}\r\n${JSON.stringify(value.payload)}\r\n`).toString("base64");
    const failure = capture(() => runReceiverRepresentationDiagnostic09({ invokePhase: () => value }));
    expect(failure.code).toBe("M4F_RECEIVER_REPRESENTATION_09_OUTPUT_INVALID");
    expect(failure.transport_failure).toBeNull();
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain(Buffer.from(secret).toString("base64"));
    const retained = failure.redacted_observation as Record<string, unknown>;
    expect(retained).not.toHaveProperty("identity");
    expect(retained).not.toHaveProperty("payload");
  });
});

function capture(run: () => unknown): Record<string, unknown> {
  try { run(); } catch (error) { expect(error).toBeInstanceOf(CeremonyFailure); return (error as CeremonyFailure).detail; }
  throw new Error("expected CeremonyFailure");
}
function payload(): Record<string, unknown> {
  return {
    schema: "synthia-m4f-current-receiver-representation-diagnostic-09.v1",
    predecessor_attempt: { schema: "synthia-m4f-predecessor-effect-09.v1", attempt: "_08", effect_state: "unknown", queried: false, cleanup_attempted: false },
    status: "representation_match", scope: "current_pid_exact_cim_only", residue_state_evaluated: false, provider_activation_may_create_processes: true, failure_code: null,
    query: { schema: "synthia-m4f-receiver-representation-query.v1", returned_count: 1, elapsed_ticks: 10, stopwatch_frequency: 10_000_000 },
    expected: { schema: "synthia-m4f-receiver-representation-expected.v1", executable_path: PS, encoded_length: 3256, encoded_sha256: "ec4bb477e8e7bd0c08551837b21ad90e06aaa3bab11e95b44cef5dee0b6a22bb", basename_command_length: 3346, basename_command_sha256: "facefc9fa05a87804412bd8ab6cff5364a35c84f10413454d308c16f42fc9dc2", fixed_command_length: 3389, fixed_command_sha256: "a0d79d8992e881d114cd4f70e6b916978e372160fb06e3a2bd781bdeb20d074f", quoted_command_length: 3391, quoted_command_sha256: "21521202d8b45084d75ec2d797b1214e41da760efcbe93e340b68ca2fb3fd251" },
    actual: { schema: "synthia-m4f-receiver-representation-actual.v1", returned_count: 1, executable_path: PS, command_present: true, command_utf8_length: 3346, command_sha256: "facefc9fa05a87804412bd8ab6cff5364a35c84f10413454d308c16f42fc9dc2" },
    classification: { schema: "synthia-m4f-receiver-representation-classification.v1", executable: "ordinal_exact", command_candidate: "basename_exact", marker: "exact", prefix: "basename_exact", token_shape: "base64_shape", encoded_length_matches: true, encoded_sha256_matches: true, canonical_base64: true, utf16le_roundtrip: true, earliest_mismatch_stage: "none" },
  };
}
function proc(ambiguous = false, stdout = "sensitive remote stdout"): ProcessObservation {
  return { exit_status: ambiguous ? null : 0, signal: ambiguous ? "SIGTERM" : null, error_code: ambiguous ? "ETIMEDOUT" : null, stdout_base64: Buffer.from(stdout).toString("base64"), stderr_base64: "", timed_out: ambiguous, outcome_ambiguous: ambiguous, retry_permitted: false };
}
function input() { const stdin = Buffer.from(`${Buffer.from(RECEIVER_REPRESENTATION_ARTIFACT_09).toString("base64")}\n`, "ascii"); return { artifact_length: RECEIVER_REPRESENTATION_ARTIFACT_09_LENGTH, artifact_sha256: RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256, stdin_length: stdin.length, stdin_sha256: createHash("sha256").update(stdin).digest("hex"), receiver_source_length: BOUND_JUMP_RECEIVER_SOURCE_LENGTH, receiver_source_sha256: BOUND_JUMP_RECEIVER_SOURCE_SHA256, receiver_encoded_length: BOUND_JUMP_RECEIVER_ENCODED_LENGTH, receiver_encoded_sha256: BOUND_JUMP_RECEIVER_ENCODED_SHA256, receiver_command_length: BOUND_JUMP_RECEIVER_COMMAND_LENGTH, receiver_command_maximum: 8_192 }; }
function master(): MasterAuditEvidence { return { schema: "synthia-m4f-bound-master-audit.v1", master_pid: 87062, master_socket: "/private/tmp/synthia-m4f-jump.sock", known_hosts_path: "/Users/wenzhuolin/.ssh/known_hosts", host_key_fingerprint: "SHA256:I37M/4mZJwdlChfZyay+GSbhTuRKEQthOZW7sHmugh8", ssh_executable: "/usr/bin/ssh", master_effective_config_sha256: "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9", child_effective_config_sha256: "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8", network_sha256: "02c94dce4f86ac0627bb4d1a960ff8fb1dd6cfc1bcb6f77cfaccb20387c7d6f1", network_process: proc(false, NETWORK), network_connection: { fd: 3, protocol: "TCP", local_address: "100.123.31.75", local_port: 65322, remote_address: "100.66.198.60", remote_port: 22, state: "ESTABLISHED" } }; }
function phase(): BoundJumpPhaseResult { const value = payload(); const identity = { schema: "synthia-m4f-jump-identity.v1", computer_name: "DESKTOP-E380LR7", identity_name: "desktop-e380lr7\\administrator", identity_sid: "S-1-5-21-3442870711-319385569-2277832987-500" }; const stdout = `${JSON.stringify(identity)}\r\n${JSON.stringify(value)}\r\n`; return { schema: "synthia-m4f-bound-phase.v1", phase: PHASE, identity, payload: value, process: proc(false, stdout), input: input(), master_before: master(), master_after: master() }; }
function trace(transport_stage: "pre_audit" | "child_execution" | "post_audit" | "output_validation", child_state: "not_started_proven" | "started" | "unknown", child_outcome_state: "not_started" | "known" | "ambiguous" | "unknown", master_before: MasterAuditEvidence | null, master_after: MasterAuditEvidence | null) { return { schema: "synthia-m4f-bound-transport-trace-09.v1", transport_stage, child_state, child_outcome_state, effect_state: child_state === "not_started_proven" ? "not_started" : "unknown", master_before, master_after }; }
