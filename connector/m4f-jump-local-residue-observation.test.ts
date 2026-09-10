import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  classifyFixedPathSshCommandLine,
  JUMP_LOCAL_RESIDUE_ARTIFACT,
  JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
  JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256,
  runJumpLocalResidueObservation,
} from "./scripts/invoke-m4f-jump-local-residue-observation.ts";
import {
  BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED,
  BOUND_JUMP_RECEIVER_ENCODED_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_SHA256,
  BOUND_JUMP_RECEIVER_SOURCE_LENGTH,
  BOUND_JUMP_RECEIVER_SOURCE_SHA256,
  BOUND_JUMP_RECEIVER_ENCODED_LENGTH as RECEIVER_ENCODED_LENGTH,
  CeremonyFailure,
  MAX_BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  type BoundJumpPhaseResult,
  type MasterAuditEvidence,
  type ProcessObservation,
} from "./scripts/m4f-bound-jump-transport.ts";

const TOKEN = "SYNTHIA_M4F_JUMP_LOCAL_RESIDUE_OBSERVATION_20260827_05";
const ENV = "SYNTHIA_M4F_JUMP_LOCAL_RESIDUE_CONFIRMATION";
const USER_SID = "S-1-5-21-3442870711-319385569-2277832987-500";
const PS_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const SSH_PATH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
const MASTER_HASH = "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
const CHILD_HASH = "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
const NETWORK_HASH = "02c94dce4f86ac0627bb4d1a960ff8fb1dd6cfc1bcb6f77cfaccb20387c7d6f1";
const CURRENT_COMMAND = `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${BOUND_JUMP_RECEIVER_ENCODED}`;
const CURRENT_COMMAND_HASH = createHash("sha256").update(CURRENT_COMMAND).digest("hex");

afterEach(() => delete process.env[ENV]);

describe("M4-F jump-local residue/liveness observation", () => {
  test("is confirmation-first, single-shot, and retains raw phase evidence on semantic failure", () => {
    let calls = 0;
    const invokePhase = (): BoundJumpPhaseResult => {
      calls += 1;
      return phase(payload());
    };
    expect(capture(() => runJumpLocalResidueObservation({ invokePhase })).code)
      .toBe("M4F_JUMP_LOCAL_RESIDUE_CONFIRMATION_REQUIRED");
    process.env[ENV] = "wrong";
    expect(capture(() => runJumpLocalResidueObservation({ invokePhase })).code)
      .toBe("M4F_JUMP_LOCAL_RESIDUE_CONFIRMATION_REQUIRED");
    expect(calls).toBe(0);
    process.env[ENV] = TOKEN;
    let seenName = "";
    let seenArtifact = "";
    const result = runJumpLocalResidueObservation({
      invokePhase: (name, artifact) => {
        calls += 1;
        seenName = name;
        seenArtifact = artifact;
        return phase(payload());
      },
    });
    expect(result.status).toBe("observed");
    expect(calls).toBe(1);
    expect(seenName).toBe("jump-local-residue:observe");
    expect(seenArtifact).toBe(JUMP_LOCAL_RESIDUE_ARTIFACT);

    const invalid = phase(payload());
    invalid.payload.unknown = true;
    calls = 0;
    const detail = capture(() => runJumpLocalResidueObservation({
      invokePhase: () => { calls += 1; return invalid; },
    }));
    expect(calls).toBe(1);
    expect(detail.retry_permitted).toBe(false);
    expect(detail.observation).toBe(invalid);
  });

  test("freezes two bounded CIM snapshots and contains no active or sensitive capability", () => {
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH).toBe(17_467);
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256)
      .toBe("7d35d79cb754c0690db3c0c2760897bfdf02f8ab4845dff8558d6d8a2930c1c2");
    expect(createHash("sha256").update(JUMP_LOCAL_RESIDUE_ARTIFACT).digest("hex"))
      .toBe(JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256);
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT.match(/Get-CimInstance/g)).toHaveLength(1);
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT.match(/Observe-Snapshot /g)).toHaveLength(2);
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).toContain("-OperationTimeoutSec $TimeoutSeconds");
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).toContain("[Threading.Thread]::Sleep($remaining)");
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).toContain("provider_activation_may_create_processes = $true");
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).not.toContain("Get-Process");
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).not.toMatch(/Process\.Start|\.Kill\(|\bTerminate\b|Stop-Process/iu);
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).not.toMatch(/(?:New|Set|Remove|Copy|Move)-Item|Set-Acl|Set-Content|Out-File/iu);
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).not.toMatch(/CreateFile|OpenProcess|CloseHandle|WaitForExit/iu);
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).not.toMatch(/id_192|staging|Vivado|hw_server|192\.168\.31\.66|Administrator@|100\.66\.198\.60/iu);
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|TcpClient|Socket/iu);
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).not.toMatch(/-ComputerName|-CimSession|New-CimSession|Remove-CimSession/iu);
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).not.toMatch(/-Namespace|CimSessionOptions|CimSessionProxy|\\\\root\\|root\\cimv2/iu);
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).not.toContain("command_line_base64");
  });

  test("classifies fixed-path ssh command lines with an exact two-form allowlist", () => {
    expect(classifyFixedPathSshCommandLine(SSH_PATH, `${SSH_PATH} -V`)).toBe("unquoted");
    expect(classifyFixedPathSshCommandLine(SSH_PATH, `"${SSH_PATH}" -V`)).toBe("quoted");
    for (const commandLine of [
      `${SSH_PATH} -V extra`,
      `${SSH_PATH} -V `,
      "ssh.exe -V",
      `"${SSH_PATH} -V`,
      SSH_PATH.slice(0, -1),
      null,
    ]) {
      expect(classifyFixedPathSshCommandLine(SSH_PATH, commandLine)).toBe("indeterminate");
    }
    expect(classifyFixedPathSshCommandLine("C:\\other\\ssh.exe", "ssh.exe -V"))
      .toBe("not_fixed_path");
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).toContain(
      'if ($candidate.raw_command_line -ceq $unquotedSshV)',
    );
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).toContain(
      '} elseif ($candidate.raw_command_line -ceq $quotedSshV) {',
    );
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).toContain(
      'Fail "M4F_JUMP_LOCAL_RESIDUE_SSH_COMMAND_NOT_ALLOWLISTED"',
    );
    expect(JUMP_LOCAL_RESIDUE_ARTIFACT).not.toContain(
      "continue\n      }\n      $relation",
    );
  });

  test("keeps producer and validator parent correlation aligned across snapshots and 100ns ticks", () => {
    withConfirmation(() => {
      const cases: Record<string, unknown>[] = [];
      cases.push(payload({
        receivers: [receiver(200, [1])],
        ssh: [ssh(300, 200, "pid_reuse_suspected", 200, [2])],
      }));
      cases.push(payload({
        receivers: [receiver(200, [2])],
        ssh: [ssh(300, 200, "pid_reuse_suspected", 200, [1])],
      }));

      const olderTwin = receiver(200, [1]);
      olderTwin.creation_time_utc = "2026-08-27T01:00:01.0000001Z";
      const newerChild = ssh(300, 200, "live_receiver_twin", 200, [1]);
      newerChild.creation_time_utc = "2026-08-27T01:00:01.0000002Z";
      cases.push(payload({ receivers: [olderTwin], ssh: [newerChild] }));

      const newerTwin = receiver(200, [1]);
      newerTwin.creation_time_utc = "2026-08-27T01:00:01.0000002Z";
      const olderChild = ssh(300, 200, "pid_reuse_suspected", 200, [1]);
      olderChild.creation_time_utc = "2026-08-27T01:00:01.0000001Z";
      cases.push(payload({ receivers: [newerTwin], ssh: [olderChild] }));

      const observerChild = ssh(300, 100, "observer_self", 100, [1]);
      observerChild.creation_time_utc = "2026-08-27T01:00:00.0000001Z";
      cases.push(payload({ ssh: [observerChild] }));
      const preObserverChild = ssh(300, 100, "pid_reuse_suspected", 100, [1]);
      preObserverChild.creation_time_utc = "2026-08-27T00:59:59.9999999Z";
      cases.push(payload({ ssh: [preObserverChild] }));

      for (const candidate of cases) {
        expect(runJumpLocalResidueObservation({ invokePhase: () => phase(candidate) }).status)
          .toBe("observed");
      }
    });
  });

  test("accepts composite PID reuse bindings and rejects fabricated exact duplicates", () => {
    const receiverFirst = receiver(200, [1]);
    receiverFirst.creation_time_utc = "2026-08-27T01:00:01.0000000Z";
    const receiverSecond = receiver(200, [2]);
    receiverSecond.creation_time_utc = "2026-08-27T01:00:01.0000001Z";
    const sshFirst = ssh(300, 999, "unresolved", null, [1]);
    sshFirst.creation_time_utc = "2026-08-27T01:00:02.0000000Z";
    const sshSecond = ssh(300, 999, "unresolved", null, [2]);
    sshSecond.creation_time_utc = "2026-08-27T01:00:02.0000001Z";
    setSshCommandForm(sshSecond, "quoted");
    withConfirmation(() => {
      expect(runJumpLocalResidueObservation({
        invokePhase: () => phase(payload({
          receivers: [receiverFirst, receiverSecond],
          ssh: [sshFirst, sshSecond],
        })),
      }).status).toBe("observed");

      for (const duplicate of [
        payload({ receivers: [receiverFirst, { ...receiverFirst }] }),
        payload({ ssh: [sshFirst, { ...sshFirst }] }),
      ]) {
        expect(capture(() => runJumpLocalResidueObservation({ invokePhase: () => phase(duplicate) })).code)
          .toBe("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID");
      }
    });
  });

  test("accepts no residue, twin-only, ssh-only, correlated, and indeterminate observations", () => {
    withConfirmation(() => {
      for (const candidate of [
        payload(),
        payload({ receivers: [receiver(200, [1, 2])] }),
        payload({ ssh: [ssh(300, 999, "unresolved", null, [1])] }),
        payload({
          receivers: [receiver(200, [1, 2])],
          ssh: [ssh(300, 200, "live_receiver_twin", 200, [2])],
        }),
        payload({ ssh: [ssh(300, 100, "observer_self", 100, [1])] }),
        payload({
          receivers: [receiver(200, [1])],
          ssh: [ssh(300, 200, "pid_reuse_suspected", 200, [2])],
        }),
        (() => {
          const fact = ssh(300, 100, "pid_reuse_suspected", 100, [1]);
          fact.creation_time_utc = "2026-08-27T00:59:59.0000000Z";
          return payload({ ssh: [fact] });
        })(),
        payload({ indeterminate: true }),
        payload({ indeterminate: true, receivers: [receiver(200, [2])] }),
        payload({ bothIndeterminate: true }),
        (() => {
          const value = payload();
          value.status = "indeterminate";
          (value.snapshots as Array<Record<string, unknown>>)[1]!.current_receiver = {
            ...current(),
            process_id: 101,
          };
          return value;
        })(),
      ]) {
        expect(runJumpLocalResidueObservation({ invokePhase: () => phase(candidate) }).status)
          .toBe("observed");
      }
    });
  });

  test("rejects state, disclaimers, count, ordering, PID, self, command, path, time, and schema drift", () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => { value.status = "no_residue_observed"; value.receiver_matches = [receiver(200, [1])]; value.receiver_match_count = 1; },
      (value) => { value.historical_absence_not_proven = false; },
      (value) => { value.continuous_absence_not_proven = false; },
      (value) => { value.residue_origin_not_proven = false; },
      (value) => { value.provider_activation_may_create_processes = false; },
      (value) => { value.receiver_match_count = 1; },
      (value) => { value.snapshot_count = 1; },
      (value) => { value.complete_snapshot_count = 1; },
      (value) => { value.observation_finished_utc = "invalid"; },
      (value) => { value.observation_finished_utc = "2026-08-27T01:00:03.000000Z"; },
      (value) => { value.observation_finished_utc = "2026-02-30T01:00:03.0000000Z"; },
      (value) => { (value.snapshots as Array<Record<string, unknown>>)[1]!.observation_time_utc = "2026-08-27T01:00:01.1000000Z"; },
      (value) => { (value.snapshots as Array<Record<string, unknown>>)[0]!.index = 2; },
      (value) => { (value.snapshots as Array<Record<string, unknown>>)[0]!.receiver_match_count = 1; },
      (value) => {
        value.status = "residue_observed";
        value.receiver_matches = [receiver(200, [1])];
        value.receiver_match_count = 1;
        value.ssh_v_matches = [ssh(300, 999, "unresolved", null, [1])];
        value.ssh_v_match_count = 1;
        const first = (value.snapshots as Array<Record<string, unknown>>)[0]!;
        first.receiver_match_count = 1;
        first.ssh_v_match_count = 1;
        first.observed_process_count = 2;
      },
      (value) => { (value.snapshots as Array<Record<string, unknown>>)[0]!.unknown = true; },
      (value) => { value.unknown = true; },
      (value) => {
        value.status = "residue_observed";
        value.receiver_matches = [receiver(300, [1]), receiver(200, [1])];
        value.receiver_match_count = 2;
      },
      (value) => {
        value.status = "residue_observed";
        value.receiver_matches = [receiver(200, [1]), receiver(200, [2])];
        value.receiver_match_count = 2;
      },
      (value) => {
        value.status = "residue_observed";
        const later = receiver(200, [2]);
        later.creation_time_utc = "2026-08-27T01:00:01.0000002Z";
        const earlier = receiver(200, [1]);
        earlier.creation_time_utc = "2026-08-27T01:00:01.0000001Z";
        value.receiver_matches = [later, earlier];
        value.receiver_match_count = 2;
      },
      (value) => {
        value.status = "residue_observed";
        value.receiver_matches = [receiver(100, [1])];
        value.receiver_match_count = 1;
      },
      (value) => {
        value.status = "residue_observed";
        const fact = receiver(200, [2]); fact.command_line_sha256 = "b".repeat(64);
        value.receiver_matches = [fact]; value.receiver_match_count = 1;
      },
      (value) => {
        value.status = "residue_observed";
        const fact = receiver(200, [2]); fact.executable_path = "C:\\other.exe";
        value.receiver_matches = [fact]; value.receiver_match_count = 1;
      },
      (value) => {
        value.status = "residue_observed";
        const fact = receiver(200, [2]); fact.creation_time_utc = "bad";
        value.receiver_matches = [fact]; value.receiver_match_count = 1;
      },
      (value) => {
        value.status = "residue_observed";
        value.receiver_matches = [receiver(200, [2, 1])]; value.receiver_match_count = 1;
      },
      (value) => {
        value.status = "residue_observed";
        value.receiver_matches = [receiver(200, [3])]; value.receiver_match_count = 1;
      },
      (value) => {
        value.status = "residue_observed";
        const fact = ssh(300, 999, "unresolved", null, [1]); fact.command_line_form = "extra";
        value.ssh_v_matches = [fact]; value.ssh_v_match_count = 1;
      },
      (value) => {
        value.status = "residue_observed";
        const fact = ssh(300, 999, "observer_self", 100, [1]);
        value.ssh_v_matches = [fact]; value.ssh_v_match_count = 1;
      },
      (value) => {
        value.status = "indeterminate";
        value.complete_snapshot_count = 1;
        const snapshots = value.snapshots as Array<Record<string, unknown>>;
        snapshots[0] = snapshot(1, false);
        ((snapshots[0]!.exception as Record<string, unknown>).message_utf8_sha256) = "0".repeat(64);
      },
      (value) => {
        value.status = "indeterminate";
        value.complete_snapshot_count = 1;
        const snapshots = value.snapshots as Array<Record<string, unknown>>;
        snapshots[0] = snapshot(1, false);
        ((snapshots[0]!.exception as Record<string, unknown>).message_utf8_base64) = "!!!";
      },
      (value) => {
        value.status = "residue_observed";
        const fact = ssh(300, 100, "unresolved", null, [1]);
        value.ssh_v_matches = [fact]; value.ssh_v_match_count = 1;
      },
      (value) => {
        (value.receiver_command_contract as Record<string, unknown>).encoded_command_sha256 = "0".repeat(64);
      },
    ];
    withConfirmation(() => {
      for (const mutate of mutations) {
        const value = payload();
        mutate(value);
        expect(capture(() => runJumpLocalResidueObservation({ invokePhase: () => phase(value) })).code)
          .toBe("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID");
      }
    });
  });

  test("rejects phase/process/master evidence drift", () => {
    withConfirmation(() => {
      for (const mutate of [
        (result: BoundJumpPhaseResult) => { result.identity.identity_sid = "S-1-5-1"; },
        (result: BoundJumpPhaseResult) => { result.process.timed_out = true; },
        (result: BoundJumpPhaseResult) => { result.process.stderr_base64 = "eA=="; },
        (result: BoundJumpPhaseResult) => { result.input.artifact_sha256 = "0".repeat(64); },
        (result: BoundJumpPhaseResult) => { result.master_after.master_pid += 1; },
        (result: BoundJumpPhaseResult) => { result.master_before.network_sha256 = "f".repeat(64); result.master_after.network_sha256 = "f".repeat(64); },
      ]) {
        const result = phase(payload());
        mutate(result);
        expect(capture(() => runJumpLocalResidueObservation({ invokePhase: () => result })).code)
          .toBe("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID");
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

function phase(value: Record<string, unknown>): BoundJumpPhaseResult {
  const result: BoundJumpPhaseResult = {
    schema: "synthia-m4f-bound-phase.v1",
    phase: "jump-local-residue:observe",
    identity: {
      schema: "synthia-m4f-jump-identity.v1",
      computer_name: "DESKTOP-E380LR7",
      identity_name: "desktop-e380lr7\\administrator",
      identity_sid: USER_SID,
    },
    payload: value,
    process: processObservation(),
    input: {
      artifact_length: JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
      artifact_sha256: JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256,
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
  const stdin = Buffer.from(`${Buffer.from(JUMP_LOCAL_RESIDUE_ARTIFACT).toString("base64")}\n`, "ascii");
  result.input.stdin_length = stdin.length;
  result.input.stdin_sha256 = createHash("sha256").update(stdin).digest("hex");
  result.process.stdout_base64 = Buffer.from(
    `${JSON.stringify(result.identity)}\n${JSON.stringify(result.payload)}\n`,
    "utf8",
  ).toString("base64");
  return result;
}

function current(): Record<string, unknown> {
  return {
    schema: "synthia-m4f-jump-local-process-fact.v1",
    process_id: 100,
    parent_process_id: 50,
    creation_time_utc: "2026-08-27T01:00:00.0000000Z",
    executable_path: PS_PATH,
    command_line_utf8_length: Buffer.byteLength(CURRENT_COMMAND),
    command_line_sha256: CURRENT_COMMAND_HASH,
  };
}

function receiver(pid: number, indexes: number[]): Record<string, unknown> {
  return {
    ...current(),
    process_id: pid,
    parent_process_id: 50,
    creation_time_utc: "2026-08-27T01:00:01.0000000Z",
    observed_snapshot_indexes: indexes,
  };
}

function ssh(
  pid: number,
  parentPid: number,
  relation: "observer_self" | "live_receiver_twin" | "pid_reuse_suspected" | "unresolved",
  matchedPid: number | null,
  indexes: number[],
): Record<string, unknown> {
  const command = `${SSH_PATH} -V`;
  return {
    schema: "synthia-m4f-jump-local-ssh-v-fact.v1",
    process_id: pid,
    parent_process_id: parentPid,
    creation_time_utc: "2026-08-27T01:00:02.0000000Z",
    executable_path: SSH_PATH,
    command_line_utf8_length: Buffer.byteLength(command),
    command_line_sha256: createHash("sha256").update(command).digest("hex"),
    command_line_form: "unquoted",
    parent_relation: relation,
    matched_receiver_pid: matchedPid,
    observed_snapshot_indexes: indexes,
  };
}

function setSshCommandForm(
  fact: Record<string, unknown>,
  form: "quoted" | "unquoted",
): void {
  const command = form === "quoted" ? `"${SSH_PATH}" -V` : `${SSH_PATH} -V`;
  fact.command_line_form = form;
  fact.command_line_utf8_length = Buffer.byteLength(command);
  fact.command_line_sha256 = createHash("sha256").update(command).digest("hex");
}

function exception(): Record<string, unknown> {
  const message = Buffer.from("CIM unavailable", "utf8");
  return {
    schema: "synthia-m4f-jump-local-residue-exception.v1",
    type: "Microsoft.Management.Infrastructure.CimException",
    hresult: -2_147_217_391,
    message_utf8_length: message.length,
    message_utf8_sha256: createHash("sha256").update(message).digest("hex"),
    message_utf8_base64: message.toString("base64"),
  };
}

function snapshot(index: number, complete: boolean, receiverCount = 0, sshCount = 0): Record<string, unknown> {
  return {
    schema: "synthia-m4f-jump-local-residue-snapshot.v1",
    index,
    status: complete ? "complete" : "indeterminate",
    observation_time_utc: `2026-08-27T01:00:0${index}.0000000Z`,
    observed_process_count: complete ? 1 + receiverCount + sshCount : null,
    current_receiver: complete ? current() : null,
    receiver_match_count: complete ? receiverCount : 0,
    ssh_v_match_count: complete ? sshCount : 0,
    exception: complete ? null : exception(),
  };
}

function payload(options: {
  receivers?: Record<string, unknown>[];
  ssh?: Record<string, unknown>[];
  indeterminate?: boolean;
  bothIndeterminate?: boolean;
} = {}): Record<string, unknown> {
  const receivers = options.receivers ?? [];
  const sshFacts = options.ssh ?? [];
  const firstComplete = !options.indeterminate && !options.bothIndeterminate;
  const secondComplete = !options.bothIndeterminate;
  const completeCount = Number(firstComplete) + Number(secondComplete);
  const hasResidue = receivers.length > 0 || sshFacts.length > 0;
  return {
    schema: "synthia-m4f-jump-local-residue-observation.v1",
    status: hasResidue
      ? "residue_observed"
      : completeCount === 2 ? "no_residue_observed" : "indeterminate",
    observation_finished_utc: "2026-08-27T01:00:03.0000000Z",
    historical_absence_not_proven: true,
    continuous_absence_not_proven: true,
    residue_origin_not_proven: true,
    provider_activation_may_create_processes: true,
    receiver_command_contract: {
      schema: "synthia-m4f-jump-local-receiver-command-contract.v1",
      executable_path: PS_PATH,
      argument_prefix: [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
      ],
      encoded_command_length: RECEIVER_ENCODED_LENGTH,
      encoded_command_sha256: BOUND_JUMP_RECEIVER_ENCODED_SHA256,
    },
    current_receiver: completeCount > 0 ? current() : null,
    snapshot_interval_milliseconds: 250,
    snapshot_count: 2,
    complete_snapshot_count: completeCount,
    snapshots: [
      snapshot(1, firstComplete, firstComplete ? receivers.filter((item) => (item.observed_snapshot_indexes as number[]).includes(1)).length : 0, firstComplete ? sshFacts.filter((item) => (item.observed_snapshot_indexes as number[]).includes(1)).length : 0),
      snapshot(2, secondComplete, secondComplete ? receivers.filter((item) => (item.observed_snapshot_indexes as number[]).includes(2)).length : 0, secondComplete ? sshFacts.filter((item) => (item.observed_snapshot_indexes as number[]).includes(2)).length : 0),
    ],
    receiver_match_count: receivers.length,
    receiver_matches: receivers,
    ssh_v_match_count: sshFacts.length,
    ssh_v_matches: sshFacts,
  };
}
