import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import {
  buildCandidate35BusinessScript,
  buildCandidate35Payload,
  candidate35Confirmation,
  candidate35StartToken,
  CANDIDATE31_RECORD_PATH,
  CANDIDATE34_RECORD_PATH,
  CANDIDATE34_RECORD_SHA256,
  CANDIDATE34_SOURCE_SHA256,
  CANDIDATE34_TEST_SHA256,
  CANDIDATE35_ID,
  CANDIDATE35_TARGETS,
  planCandidate35,
  validateCandidate35Config,
  validateCandidate35MarkerPrefix,
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

function marker(phase: string, status: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    schema: "synthia-m4f-direct-nine-pid-cleanup-35-marker.v1",
    cleanup_id: CANDIDATE35_ID,
    phase,
    status,
    observed_at_utc: "2026-08-31T03:00:00.0000000Z",
    payload,
  }) + "\r\n";
}

function startAndPreflight(states: Array<"present" | "absent">): string[] {
  return [
    marker("start", "observed", {
      current_pid: 70000,
      target_count: 9,
      c31: config().candidate31_record_sha256,
      c34: config().candidate34_record_sha256,
    }),
    marker("preflight", "observed", {
      target_states: CANDIDATE35_TARGETS.map((target, index) => [
        target.ordinal,
        target.pid,
        states[index],
        states[index] === "present" ? String(9000 + target.ordinal) : null,
      ]),
      retained_count: states.filter((state) => state === "present").length,
      worker_retained: true,
      authority: "candidate31_historical_exact",
      stale_exact: true,
    }),
  ];
}

describe("M4-F Candidate 35 exact nine-PID cleanup payload", () => {
  test("strictly binds the exact C31/C34 lineage and production identity", () => {
    expect(validateCandidate35Config(config())).toEqual(config());
    for (const mutate of [
      (value: Record<string, unknown>) => { value.extra = true; },
      (value: Record<string, unknown>) => { value.candidate31_record_path = "/private/tmp/other"; },
      (value: Record<string, unknown>) => { value.candidate34_record_sha256 = "0".repeat(64); },
      (value: Record<string, unknown>) => { value.target_host = "100.66.198.60"; },
      (value: Record<string, unknown>) => { value.remote_deadline_seconds = 61; },
    ]) {
      const value = structuredClone(config()) as unknown as Record<string, unknown>;
      mutate(value);
      expect(() => validateCandidate35Config(value)).toThrow("M4F_CANDIDATE35_CONFIG_INVALID");
    }
  });

  test("round-trips the exact gzip business bytes and stays within the direct command budget", () => {
    const built = buildCandidate35Payload(config());
    expect(gunzipSync(built.compressed_business_script)).toEqual(Buffer.from(built.business_script, "utf8"));
    expect(built.business_script_sha256).toBe(
      createHash("sha256").update(built.business_script).digest("hex"),
    );
    expect(built.remote_command.length).toBeLessThanOrEqual(7_000);
    expect(built.remote_command_length).toBe(built.remote_command.length);
    expect(built.business_script_length).toBe(Buffer.byteLength(built.business_script, "utf8"));
    expect(built.remote_command).toMatch(/^[\x00-\x7f]*$/u);
    expect(built.remote_command).toContain("[IO.Compression.CompressionMode]::Decompress");
    expect(built.remote_command).not.toContain(",0)");
    expect(built.remote_command).toStartWith("powershell.exe -NoLogo -NoProfile -NonInteractive");
  });

  test("keeps one ordered retained-handle effect path behind exact process and listener guards", () => {
    const source = buildCandidate35BusinessScript(config());
    expect(source).toContain(
      "function Write-SynthiaM4f35Marker([string]$MarkerPhase,[string]$MarkerStatus,[System.Collections.IDictionary]$MarkerPayload)",
    );
    expect(source.match(/Get-CimInstance Win32_Process/gu)).toHaveLength(1);
    expect(source.match(/MSFT_NetTCPConnection/gu)).toHaveLength(1);
    expect(source.match(/\.Kill\(\)/gu)).toHaveLength(1);
    expect(source.match(/DangerousAddRef/gu)).toHaveLength(2);
    expect(source).toContain("local_port=8443;owning_pid=13644");
    expect(source).toContain("LocalPort-eq 18443");
    expect(source).toContain("PROTECTED_TARGET_OVERLAP");
    expect(source).toContain("TARGET_MISMATCH");
    expect(source).toContain("POWER_ORDER");
    expect(source).toContain("TARGET_RELATIONSHIP");
    expect(source).toContain("DIAGNOSTIC_EDGE");
    expect(source).toContain("Select-Object -First 1");
    expect(source).toContain("ElapsedMilliseconds");
    expect(source).toContain("[Math]::Min");
    expect(source).not.toMatch(/\$S35v\d+[A-Za-z]/u);
    expect(source).toContain("DangerousRelease()");
    expect(source).not.toMatch(/Vivado|hw_server|vivado_lab|open_hw|program_hw|write_cfgmem|Stop-Process|taskkill/iu);
    expect(CANDIDATE35_TARGETS.map((target) => target.pid)).toEqual([
      44768, 56576, 64484, 58908, 67048, 66316, 39016, 48664, 66340,
    ]);
  });

  test("produces a deterministic no-retry plan and confirmation", () => {
    expect(planCandidate35(config())).toMatchObject({
      status: "planned_not_executed",
      topology: "one_direct_ssh_empty_stdin_no_retry",
      remote_attempt_count: 1,
      retry_permitted: false,
      absent_target_policy: "skip",
      present_mismatch_policy: "block_all_effects",
      effect_ambiguity_policy: "permanent_partial_no_retry",
      remote_file_write_permitted: false,
      vivado_action_permitted: false,
      hardware_action_permitted: false,
      remote_command_limit: 7_000,
      windows_cmd_limit: 8_191,
    });
    const plan = planCandidate35(config());
    expect(plan.remote_command_length).toBeLessThanOrEqual(plan.remote_command_limit);
    expect(plan.windows_cmd_headroom).toBe(8_191 - plan.remote_command_length);
    expect(candidate35Confirmation(config())).toBe(candidate35Confirmation(config()));
    expect(candidate35Confirmation(config()).split(":" )).toHaveLength(6);
  });

  test("accepts an exact all-absent terminal marker stream", () => {
    const states = Array.from({ length: 9 }, () => "absent" as const);
    const lines = startAndPreflight(states);
    for (const target of CANDIDATE35_TARGETS) {
      lines.push(marker("absent_skip", "observed", {
        ordinal: target.ordinal,
        pid: target.pid,
        start_token: candidate35StartToken(target),
      }));
    }
    lines.push(marker("complete", "complete", {
      cleanup_completed: true,
      present_count: 0,
      absent_count: 9,
      retry_permitted: false,
    }));
    const parsed = validateCandidate35MarkerPrefix(Buffer.from(lines.join("")), config());
    expect(parsed.complete).toBe(true);
    expect(parsed.markers).toHaveLength(12);
    expect(parsed.effect_ambiguity).toBe(false);
    expect(parsed.trailing_fragment_length).toBe(0);
  });

  test("accepts exact effects in group order and detects an unresolved effect boundary", () => {
    const states = Array.from({ length: 9 }, () => "present" as const);
    const lines = startAndPreflight(states);
    for (const target of CANDIDATE35_TARGETS) {
      lines.push(marker("effect_start", "started", {
        ordinal: target.ordinal,
        pid: target.pid,
        raw_handle: String(9000 + target.ordinal),
        start_token: candidate35StartToken(target),
      }));
      lines.push(marker("effect_result", "observed", {
        ordinal: target.ordinal,
        pid: target.pid,
        effect: "same_process_instance_kill_completed",
        has_exited: true,
        raw_handle: String(9000 + target.ordinal),
        start_token: candidate35StartToken(target),
      }));
    }
    lines.push(marker("complete", "complete", {
      cleanup_completed: true,
      present_count: 9,
      absent_count: 0,
      retry_permitted: false,
    }));
    expect(validateCandidate35MarkerPrefix(Buffer.from(lines.join("")), config()).complete).toBe(true);

    const ambiguous = startAndPreflight(states);
    const first = CANDIDATE35_TARGETS[0]!;
    ambiguous.push(marker("effect_start", "started", {
      ordinal: first.ordinal,
      pid: first.pid,
      raw_handle: "9001",
      start_token: candidate35StartToken(first),
    }));
    ambiguous.push(marker("failure", "partial_unknown", {
      phase: "effect_start_1",
      effect_result_pending: true,
      error_type: "System.Exception",
      retry_permitted: false,
    }));
    const parsed = validateCandidate35MarkerPrefix(Buffer.from(ambiguous.join("")), config());
    expect(parsed.complete).toBe(false);
    expect(parsed.effect_ambiguity).toBe(true);
    expect(parsed.retry_permitted).toBe(false);
  });

  test("stops at the first invalid or incomplete line and preserves its bytes", () => {
    const prefix = startAndPreflight(Array.from({ length: 9 }, () => "absent" as const)).join("");
    const tail = Buffer.from([0xff, 0x00, 0x0a]);
    const parsed = validateCandidate35MarkerPrefix(Buffer.concat([Buffer.from(prefix), tail]), config());
    expect(parsed.valid_prefix_length).toBe(Buffer.byteLength(prefix));
    expect(parsed.trailing_fragment_length).toBe(tail.length);
    expect(parsed.complete).toBe(false);
  });

  test("rejects standalone or structurally loose failure markers", () => {
    const validFailure = {
      phase: "preflight_snapshot",
      effect_result_pending: false,
      error_type: "System.Exception",
      retry_permitted: false,
    };
    expect(validateCandidate35MarkerPrefix(
      Buffer.from(marker("failure", "partial_unknown", validFailure)), config(),
    ).markers).toHaveLength(0);

    const prefix = marker("start", "observed", {
      current_pid: 70000,
      target_count: 9,
      c31: config().candidate31_record_sha256,
      c34: config().candidate34_record_sha256,
    });
    expect(validateCandidate35MarkerPrefix(
      Buffer.from(prefix + marker("failure", "observed", validFailure)), config(),
    ).markers).toHaveLength(1);
    expect(validateCandidate35MarkerPrefix(
      Buffer.from(prefix + marker("failure", "partial_unknown", { ...validFailure, extra: true })), config(),
    ).markers).toHaveLength(1);
  });
});
