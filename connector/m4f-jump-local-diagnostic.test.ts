import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  JUMP_LOCAL_DIAGNOSTIC_ARTIFACT,
  JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_LENGTH,
  JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_SHA256,
  runJumpLocalDiagnostic,
} from "./scripts/invoke-m4f-jump-local-diagnostic.ts";
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

const CONFIRMATION = "SYNTHIA_M4F_JUMP_LOCAL_DIAGNOSTIC_20260827_04";
const CONFIRMATION_ENV = "SYNTHIA_M4F_JUMP_LOCAL_DIAGNOSTIC_CONFIRMATION";
const SSH_PATH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
const KEY_PATH = "C:\\Users\\Administrator\\.ssh\\id_192.168.31.66";
const USER_SID = "S-1-5-21-3442870711-319385569-2277832987-500";
const MASTER_HASH = "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
const CHILD_HASH = "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
const NETWORK_HASH = "02c94dce4f86ac0627bb4d1a960ff8fb1dd6cfc1bcb6f77cfaccb20387c7d6f1";

afterEach(() => {
  delete process.env[CONFIRMATION_ENV];
});

describe("M4-F jump-local launch diagnostic", () => {
  test("is import-safe, confirmation-gated, single-shot, and bound to the exact phase", () => {
    let calls = 0;
    const invokePhase = (): BoundJumpPhaseResult => {
      calls += 1;
      return phase(validPayload());
    };

    expect(captureFailure(() => runJumpLocalDiagnostic({ invokePhase })).code)
      .toBe("M4F_JUMP_LOCAL_DIAGNOSTIC_CONFIRMATION_REQUIRED");
    process.env[CONFIRMATION_ENV] = "wrong";
    expect(captureFailure(() => runJumpLocalDiagnostic({ invokePhase })).code)
      .toBe("M4F_JUMP_LOCAL_DIAGNOSTIC_CONFIRMATION_REQUIRED");
    expect(calls).toBe(0);

    process.env[CONFIRMATION_ENV] = CONFIRMATION;
    let observedPhase = "";
    let observedArtifact = "";
    const result = runJumpLocalDiagnostic({
      invokePhase: (name, artifact) => {
        calls += 1;
        observedPhase = name;
        observedArtifact = artifact;
        return phase(validPayload());
      },
    });
    expect(result.status).toBe("observed");
    expect(calls).toBe(1);
    expect(observedPhase).toBe("jump-local-diagnostic:observe");
    expect(observedArtifact).toBe(JUMP_LOCAL_DIAGNOSTIC_ARTIFACT);
  });

  test("freezes artifact and bound-stdin transport evidence", () => {
    expect(JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_LENGTH).toBe(29_219);
    expect(JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_SHA256)
      .toBe("29ddfc2df266b0989f5abbded4955c20b39f9711c182ae566137d827b67a5922");
    expect(createHash("sha256").update(JUMP_LOCAL_DIAGNOSTIC_ARTIFACT).digest("hex"))
      .toBe(JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_SHA256);
    const result = phase(validPayload());
    expect(result.input).toMatchObject({
      artifact_length: JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_LENGTH,
      artifact_sha256: JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_SHA256,
      receiver_source_sha256: BOUND_JUMP_RECEIVER_SOURCE_SHA256,
      receiver_encoded_sha256: BOUND_JUMP_RECEIVER_ENCODED_SHA256,
      receiver_command_length: BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
    });
    expect(result.master_before.master_effective_config_sha256).toBe(MASTER_HASH);
    expect(result.master_before.child_effective_config_sha256).toBe(CHILD_HASH);
  });

  test("artifact permits only the fixed local ssh -V child and never reads key content", () => {
    const artifact = JUMP_LOCAL_DIAGNOSTIC_ARTIFACT;
    expect(artifact.match(/\.Start\(\)/g)).toHaveLength(1);
    expect(artifact).toContain("$startInfo.FileName = $sshPath");
    expect(artifact).toContain('$startInfo.Arguments = "-V"');
    expect(artifact).toContain("$process.StandardInput.Close()");
    expect(artifact).toContain('start_call_bound = "outer_transport_only"');
    expect(artifact).toContain("outer_transport_timeout_milliseconds = 90000");
    expect(artifact).toContain("UseShellExecute = $false");
    expect(artifact).toContain("CreateFileW");
    expect(artifact).toContain("[uint32]0,");
    expect(artifact).not.toContain("CopyToAsync");
    expect(artifact).not.toContain("Add-Type");
    expect(artifact).not.toMatch(/Get-ReadOnlySha256\s+\$identityPath/u);
    expect(artifact).not.toMatch(/\[IO\.File\]::Open\([^)]*identityPath/su);
    expect(artifact).not.toMatch(/\$startInfo\.Arguments\s*=.*identity/u);
    expect(artifact).not.toMatch(/(?:Administrator@|admin@|ProxyJump|ProxyCommand|IdentityFile|RequestTTY|-tt?\b)/iu);
    expect(artifact).not.toMatch(/(?:Invoke-WebRequest|Invoke-RestMethod|Get-Command|Start-Process|cmd\.exe|powershell\.exe)/iu);
    expect(artifact).not.toMatch(/(?:New|Set|Remove|Copy|Move)-Item|Set-Acl|Set-Content|Add-Content|Out-File/iu);
    expect(artifact).not.toMatch(/(?:Vivado|hw_server|program_hw|open_hw|\/private\/tmp|gate-root|staging-ceremony)/iu);
    expect(artifact).not.toMatch(/(?:\?\?|\?\.|ForEach-Object\s+-Parallel|Start-ThreadJob)/u);
  });

  test("initializes dynamic native type in script scope for receiver ScriptBlock invocation", async () => {
    const transportSource = await Bun.file(
      new URL("./scripts/m4f-bound-jump-transport.ts", import.meta.url),
    ).text();
    const initializer = "$script:nativeFileIdentityType = $null";
    expect(JUMP_LOCAL_DIAGNOSTIC_ARTIFACT.match(/\$script:nativeFileIdentityType = \$null/g))
      .toHaveLength(1);
    expect(JUMP_LOCAL_DIAGNOSTIC_ARTIFACT.indexOf(initializer))
      .toBeLessThan(JUMP_LOCAL_DIAGNOSTIC_ARTIFACT.indexOf("function Open-StableFileIdentityHandle"));
    expect(JUMP_LOCAL_DIAGNOSTIC_ARTIFACT).not.toMatch(/^\$nativeFileIdentityType = \$null$/mu);
    expect(transportSource).toContain("[ScriptBlock]::Create($artifactSource)");
    expect(transportSource).toContain("& $artifactScriptBlock");
    expect(transportSource.indexOf("[ScriptBlock]::Create($artifactSource)"))
      .toBeLessThan(transportSource.indexOf("& $artifactScriptBlock"));
  });

  test("accepts all four exact probe states", () => {
    const timedOutWithKillException = timedOutProbe();
    timedOutWithKillException.kill_exception = exception(5);
    const unconfirmedWithWaitException = terminationUnconfirmedProbe();
    unconfirmedWithWaitException.wait_for_exit_result = null;
    unconfirmedWithWaitException.wait_exception = exception(1460);
    const probes = [
      exitedProbe(),
      startFailedProbe(null),
      startFailedProbe(2),
      timedOutProbe(),
      timedOutWithKillException,
      terminationUnconfirmedProbe(),
      unconfirmedWithWaitException,
    ];
    withConfirmation(() => {
      for (const probe of probes) {
        const payload = validPayload();
        payload.probe = probe;
        expect(runJumpLocalDiagnostic({ invokePhase: () => phase(payload) }).status).toBe("observed");
      }
    });
  });

  test("accepts bounded safe key ACL subsets centered on frozen-user read", () => {
    const safeRuleSets = [
      [accessRule(USER_SID)],
      [accessRule("S-1-5-18"), accessRule(USER_SID)],
      [accessRule("S-1-5-18"), accessRule(USER_SID), accessRule("S-1-5-32-544")],
    ];
    withConfirmation(() => {
      for (const rules of safeRuleSets) {
        const payload = validPayload();
        for (const field of ["identity_before", "identity_after"]) {
          const fact = payload[field] as Record<string, unknown>;
          fact.access_rules = structuredClone(rules);
          fact.access_rule_count = rules.length;
        }
        expect(runJumpLocalDiagnostic({ invokePhase: () => phase(payload) }).status).toBe("observed");
      }
    });
  });

  test("rejects malformed raw bytes, exceptions, version output, and state schemas", () => {
    const mutations: Array<(payload: Record<string, unknown>) => void> = [
      (payload) => ((payload.probe as Record<string, unknown>).extra = true),
      (payload) => (((payload.probe as Record<string, unknown>).stderr as Record<string, unknown>).sha256 = "0".repeat(64)),
      (payload) => (((payload.probe as Record<string, unknown>).stdout as Record<string, unknown>).length = 99),
      (payload) => (((payload.probe as Record<string, unknown>).stderr as Record<string, unknown>).base64 = "!!!"),
      (payload) => (((payload.probe as Record<string, unknown>).stderr as Record<string, unknown>).base64 = Buffer.from("not openssh\n").toString("base64")),
      (payload) => { payload.probe = startFailedProbe(null); ((payload.probe as Record<string, unknown>).ambiguous = true); },
      (payload) => { payload.probe = startFailedProbe(null); (((payload.probe as Record<string, unknown>).exception as Record<string, unknown>).message_utf8_length = 99); },
      (payload) => { payload.probe = startFailedProbe(null); (((payload.probe as Record<string, unknown>).exception as Record<string, unknown>).message_utf8_sha256 = "f".repeat(64)); },
      (payload) => { payload.probe = startFailedProbe(null); (((payload.probe as Record<string, unknown>).exception as Record<string, unknown>).native_error_code = 2.5); },
    ];
    withConfirmation(() => {
      for (const mutate of mutations) {
        const payload = validPayload();
        mutate(payload);
        expect(captureFailure(() => runJumpLocalDiagnostic({ invokePhase: () => phase(payload) })).code)
          .toBe("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID");
      }
    });
  });

  test("rejects ACL, ancestor, identity, and pre/post drift adversarially", () => {
    const mutations: Array<(payload: Record<string, unknown>) => void> = [
      (payload) => ((payload.ssh_before as Record<string, unknown>).owner_sid = "S-1-5-21-1"),
      (payload) => (((payload.ssh_before as Record<string, unknown>).access_rules as unknown[]).reverse()),
      (payload) => {
        const fact = payload.ssh_before as Record<string, unknown>;
        (fact.access_rules as unknown[]).push(accessRule("S-1-5-32-544"));
        fact.access_rule_count = 3;
      },
      (payload) => {
        const fact = payload.ssh_before as Record<string, unknown>;
        const conflict = accessRule("S-1-5-32-544");
        conflict.access_control_type = "Deny";
        (fact.access_rules as unknown[]).push(conflict);
        fact.access_rule_count = 3;
      },
      (payload) => {
        const fact = payload.ssh_before as Record<string, unknown>;
        fact.access_rule_count = 65;
      },
      (payload) => (((payload.ssh_before as Record<string, unknown>).access_rules as Array<Record<string, unknown>>)[0]!.unknown = true),
      (payload) => {
        const ancestor = ((payload.ssh_before as Record<string, unknown>).ancestors as Array<Record<string, unknown>>)[0]!;
        const rule = (ancestor.access_rules as Array<Record<string, unknown>>)[1]!;
        rule.sid = "S-1-5-99";
        rule.file_system_rights = 65_536;
      },
      (payload) => (((payload.ssh_before as Record<string, unknown>).ancestors as Array<Record<string, unknown>>)[0]!.path = "C:\\Windows"),
      (payload) => (((payload.ssh_before as Record<string, unknown>).ancestors as Array<Record<string, unknown>>)[0]!.reparse = true),
      (payload) => (((payload.ssh_before as Record<string, unknown>).ancestors as Array<Record<string, unknown>>)[0]!.owner_sid = "S-1-5-21-1"),
      (payload) => ((payload.identity_before as Record<string, unknown>).file_id = "f".repeat(16)),
      (payload) => ((payload.identity_before as Record<string, unknown>).creation_time_utc = "invalid"),
      (payload) => ((payload.identity_before as Record<string, unknown>).hard_link_count = 2),
      (payload) => ((payload.identity_before as Record<string, unknown>).owner_sid = "S-1-5-99"),
      (payload) => {
        const fact = payload.identity_before as Record<string, unknown>;
        fact.access_rules = [accessRule("S-1-5-18")];
        fact.access_rule_count = 1;
      },
      (payload) => {
        const fact = payload.identity_before as Record<string, unknown>;
        fact.access_rules = [accessRule("S-1-5-99"), accessRule(USER_SID)];
        fact.access_rule_count = 2;
      },
      (payload) => {
        const fact = payload.identity_before as Record<string, unknown>;
        const writer = accessRule("S-1-5-99");
        writer.file_system_rights = 2;
        fact.access_rules = [writer, accessRule(USER_SID)];
        fact.access_rule_count = 2;
      },
      (payload) => ((payload.identity_before as Record<string, unknown>).sha256 = "0".repeat(64)),
      (payload) => ((payload.ssh_after as Record<string, unknown>).sha256 = "0".repeat(64)),
    ];
    withConfirmation(() => {
      for (const mutate of mutations) {
        const payload = validPayload();
        mutate(payload);
        expect(captureFailure(() => runJumpLocalDiagnostic({ invokePhase: () => phase(payload) })).code)
          .toBe("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID");
      }
    });
  });

  test("preserves the complete single diagnostic on semantic failure and never retries", () => {
    withConfirmation(() => {
      const invalid = phase(validPayload());
      invalid.payload.status = "invalid";
      let calls = 0;
      const detail = captureFailure(() => runJumpLocalDiagnostic({
        invokePhase: () => {
          calls += 1;
          return invalid;
        },
      }));
      expect(calls).toBe(1);
      expect(detail.retry_permitted).toBe(false);
      expect(detail.current_stage).toBe("validation");
      expect(detail.diagnostic).toBe(invalid);
    });
  });

  test("rejects phase identity and any master before/after drift", () => {
    withConfirmation(() => {
      for (const mutate of [
        (result: BoundJumpPhaseResult) => { result.identity.identity_sid = "S-1-5-21-1"; },
        (result: BoundJumpPhaseResult) => { result.identity.unknown = true; },
        (result: BoundJumpPhaseResult) => { result.master_after.master_pid += 1; },
        (result: BoundJumpPhaseResult) => { result.master_after.network_sha256 = "f".repeat(64); },
        (result: BoundJumpPhaseResult) => { result.master_before.known_hosts_path = "/tmp/other"; },
        (result: BoundJumpPhaseResult) => { result.master_before.network_sha256 = "f".repeat(64); result.master_after.network_sha256 = "f".repeat(64); },
        (result: BoundJumpPhaseResult) => { result.process.exit_status = 1; },
        (result: BoundJumpPhaseResult) => { result.process.timed_out = true; },
        (result: BoundJumpPhaseResult) => { result.process.outcome_ambiguous = true; },
        (result: BoundJumpPhaseResult) => { result.process.stderr_base64 = Buffer.from("warning").toString("base64"); },
      ]) {
        const diagnostic = phase(validPayload());
        mutate(diagnostic);
        expect(captureFailure(() => runJumpLocalDiagnostic({ invokePhase: () => diagnostic })).code)
          .toBe("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID");
      }
    });
  });
});

function withConfirmation(run: () => void): void {
  process.env[CONFIRMATION_ENV] = CONFIRMATION;
  try {
    run();
  } finally {
    delete process.env[CONFIRMATION_ENV];
  }
}

function captureFailure(run: () => unknown): Record<string, unknown> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CeremonyFailure);
    return (error as CeremonyFailure).detail;
  }
  throw new Error("expected CeremonyFailure");
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
  return {
    schema: "synthia-m4f-bound-phase.v1",
    phase: "jump-local-diagnostic:observe",
    identity: {
      schema: "synthia-m4f-jump-identity.v1",
      computer_name: "DESKTOP-E380LR7",
      identity_name: "desktop-e380lr7\\administrator",
      identity_sid: USER_SID,
    },
    payload,
    process: processObservation(),
    input: {
      artifact_length: JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_LENGTH,
      artifact_sha256: JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_SHA256,
      stdin_length: JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_LENGTH,
      stdin_sha256: JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_SHA256,
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
}

function accessRule(sid: string): Record<string, unknown> {
  return {
    sid,
    access_control_type: "Allow",
    file_system_rights: 1,
    inheritance_flags: 0,
    propagation_flags: 0,
    is_inherited: false,
  };
}

function ancestors(paths: string[], ownerSid = "S-1-5-32-544"): Array<Record<string, unknown>> {
  return paths.map((path) => ({
    schema: "synthia-m4f-jump-local-ancestor-fact.v1",
    path,
    directory_info: true,
    reparse: false,
    owner_sid: ownerSid,
    access_rules_protected: true,
    access_rule_count: 2,
    access_rules: [accessRule("S-1-5-18"), accessRule("S-1-5-32-544")],
  }));
}

function sshFact(): Record<string, unknown> {
  const ancestorFacts = ancestors([
    "C:\\Windows\\System32\\OpenSSH",
    "C:\\Windows\\System32",
    "C:\\Windows",
    "C:\\",
  ], USER_SID);
  return {
    schema: "synthia-m4f-jump-local-ssh-fact.v1",
    path: SSH_PATH,
    actual_full_name: SSH_PATH,
    length: 1_234_567,
    sha256: "a".repeat(64),
    file_version: "OpenSSH_for_Windows_9.5p1",
    owner_sid: USER_SID,
    access_rules_protected: true,
    access_rule_count: 3,
    access_rules: [accessRule("S-1-5-18"), accessRule(USER_SID), accessRule("S-1-5-32-544")],
    ancestor_count: ancestorFacts.length,
    ancestors: ancestorFacts,
  };
}

function keyFact(): Record<string, unknown> {
  const ancestorFacts = ancestors([
    "C:\\Users\\Administrator\\.ssh",
    "C:\\Users\\Administrator",
    "C:\\Users",
    "C:\\",
  ], USER_SID);
  return {
    schema: "synthia-m4f-jump-local-key-fact.v1",
    observation_scope: "metadata_and_acl_only",
    path: KEY_PATH,
    actual_full_name: KEY_PATH,
    length: 464,
    creation_time_utc: "2026-08-27T01:02:03.0000000Z",
    last_write_time_utc: "2026-08-27T01:02:04.0000000Z",
    volume_serial_number: "1234abcd",
    file_id: "1234567890abcdef",
    hard_link_count: 1,
    owner_sid: USER_SID,
    access_rules_protected: true,
    access_rule_count: 3,
    access_rules: [accessRule("S-1-5-18"), accessRule(USER_SID), accessRule("S-1-5-32-544")],
    ancestor_count: ancestorFacts.length,
    ancestors: ancestorFacts,
  };
}

function stream(bytes: Uint8Array): Record<string, unknown> {
  return {
    length: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    base64: Buffer.from(bytes).toString("base64"),
  };
}

function exception(nativeErrorCode: number | null = null): Record<string, unknown> {
  const message = Buffer.from("diagnostic exception", "utf8");
  return {
    schema: "synthia-m4f-jump-local-exception.v1",
    type: "System.ComponentModel.Win32Exception",
    hresult: -2_147_467_259,
    native_error_code: nativeErrorCode,
    message_utf8_length: message.length,
    message_utf8_sha256: createHash("sha256").update(message).digest("hex"),
    message_utf8_base64: message.toString("base64"),
  };
}

function exitedProbe(): Record<string, unknown> {
  return {
    state: "exited",
    ambiguous: false,
    start_call_locally_timed: false,
    start_call_bound: "outer_transport_only",
    outer_transport_timeout_milliseconds: 90_000,
    output_complete: true,
    executable: SSH_PATH,
    arguments: ["-V"],
    use_shell_execute: false,
    redirect_standard_input: true,
    redirect_standard_output: true,
    redirect_standard_error: true,
    create_no_window: true,
    timeout_milliseconds: 10_000,
    exit_status: 0,
    stdout: stream(Buffer.alloc(0)),
    stderr: stream(Buffer.from("OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2\r\n", "ascii")),
  };
}

function startFailedProbe(nativeErrorCode: number | null): Record<string, unknown> {
  return {
    state: "start_failed",
    ambiguous: false,
    start_call_locally_timed: false,
    start_call_bound: "outer_transport_only",
    outer_transport_timeout_milliseconds: 90_000,
    executable: SSH_PATH,
    arguments: ["-V"],
    use_shell_execute: false,
    redirect_standard_input: true,
    redirect_standard_output: true,
    redirect_standard_error: true,
    create_no_window: true,
    timeout_milliseconds: 10_000,
    exception: exception(nativeErrorCode),
  };
}

function timedOutProbe(): Record<string, unknown> {
  return {
    state: "timed_out",
    ambiguous: true,
    start_call_locally_timed: false,
    start_call_bound: "outer_transport_only",
    outer_transport_timeout_milliseconds: 90_000,
    output_complete: false,
    executable: SSH_PATH,
    arguments: ["-V"],
    use_shell_execute: false,
    redirect_standard_input: true,
    redirect_standard_output: true,
    redirect_standard_error: true,
    create_no_window: true,
    timeout_milliseconds: 10_000,
    exit_status: -1,
    stdout: stream(Buffer.alloc(0)),
    stderr: stream(Buffer.alloc(0)),
    exception: exception(),
    kill_attempted: true,
    kill_exception: null,
    wait_for_exit_result: true,
    wait_exception: null,
  };
}

function terminationUnconfirmedProbe(): Record<string, unknown> {
  return {
    state: "termination_unconfirmed",
    ambiguous: true,
    start_call_locally_timed: false,
    start_call_bound: "outer_transport_only",
    outer_transport_timeout_milliseconds: 90_000,
    output_complete: false,
    executable: SSH_PATH,
    arguments: ["-V"],
    use_shell_execute: false,
    redirect_standard_input: true,
    redirect_standard_output: true,
    redirect_standard_error: true,
    create_no_window: true,
    timeout_milliseconds: 10_000,
    exit_status: null,
    stdout: stream(Buffer.alloc(0)),
    stderr: stream(Buffer.alloc(0)),
    trigger_exception: exception(),
    kill_attempted: true,
    kill_exception: null,
    wait_for_exit_result: false,
    wait_exception: null,
  };
}

function validPayload(): Record<string, unknown> {
  return {
    schema: "synthia-m4f-jump-local-diagnostic.v1",
    status: "observed",
    jump_identity: {
      schema: "synthia-m4f-jump-local-identity.v1",
      computer_name: "DESKTOP-E380LR7",
      identity_name: "desktop-e380lr7\\administrator",
      identity_sid: "S-1-5-21-3442870711-319385569-2277832987-500",
      administrator: true,
    },
    powershell: {
      schema: "synthia-m4f-jump-local-powershell.v1",
      ps_version: "5.1.19041.5608",
      ps_edition: "Desktop",
      process_id: 1234,
      process_bitness: 64,
      os_bitness: 64,
    },
    ssh_before: sshFact(),
    ssh_after: sshFact(),
    identity_before: keyFact(),
    identity_after: keyFact(),
    probe: exitedProbe(),
  };
}
