import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  buildEncodedDiagnosticCommand,
  buildEncodedDiagnosticScript,
  encodedDiagnosticConfirmation,
  encodedDiagnosticPlan,
  executeEncodedDiagnostic,
  parseEncodedMarkers,
  recordEncodedDiagnostic,
  type EncodedDiagnosticDependencies,
  type EncodedMarker,
  type M4fGateRootsEncodedDiagnosticConfig,
} from "./scripts/m4f-direct-gate-roots-encoded-diagnostic.ts";
import type { M4fDirectAdmissionConfig, RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const source = Buffer.from("candidate11-source");
const testSource = Buffer.from("candidate11-test");
const transportSource = Buffer.from("candidate11-transport");
const effective = Buffer.from([
  "host 100.96.223.49", "hostname 100.96.223.49", "user admin", "port 22",
  "batchmode yes", "connecttimeout 15", "connectionattempts 1", "serveraliveinterval 0",
  "serveralivecountmax 4", "numberofpasswordprompts 0", "identityagent none",
  "identitiesonly yes", "pubkeyauthentication true", "passwordauthentication no",
  "kbdinteractiveauthentication no", "gssapiauthentication no", "hostbasedauthentication no",
  "preferredauthentications publickey", "stricthostkeychecking true",
  "globalknownhostsfile /dev/null", "forwardagent no", "clearallforwardings yes",
  "permitlocalcommand no", "controlmaster false", "controlpersist no", "requesttty false",
  "warnweakcrypto no", "identityfile /tmp/id", "userknownhostsfile /tmp/known", "",
].join("\n"));

const admission: M4fDirectAdmissionConfig = {
  schema: "synthia-m4f-direct-admission-config.v1",
  gate_id: "candidate11-admission",
  target: {
    host: "100.96.223.49", port: 22, user: "admin", computer_name: "DESKTOP-DVFFB09",
    identity_name: "desktop-dvffb09\\admin", identity_sid: "S-1-5-21-2561815994-3878748218-1101284459-1001",
    identity_file: "/tmp/id", known_hosts_file: "/tmp/known", known_hosts_host_token: "100.96.223.49",
    host_key_fingerprint: "SHA256:jZVimVML+3vYKaaMK30EakIxOvOWiilN6FjBW/4uhfY",
    expected_effective_config_sha256: sha256(effective), acl_paths: ["C:\\Windows\\Temp"],
    vivado_executable: "D:\\Xilinx\\Vivado\\2021.1\\bin\\vivado.bat",
    bun_executable: "D:\\synthia-worker\\runtime\\bun.exe",
  },
};
const admissionBytes = Buffer.from(JSON.stringify(admission));

const config: M4fGateRootsEncodedDiagnosticConfig = {
  schema: "synthia-m4f-direct-gate-roots-encoded-diagnostic-config.v1",
  diagnostic_id: "m4f-gate-roots-candidate11",
  gate_id: "prod-20260828-03",
  admission_config_path: "/tmp/admission-candidate11.json",
  admission_config_sha256: sha256(admissionBytes),
  candidate09_diagnostic_sha256: "c43e90a6319b0cd93ead246325be8e11f5a16e7606d63f17765b649212879726",
  candidate09_started_at_utc: "2026-08-28T16:25:50.640Z",
  candidate09_ended_at_utc: "2026-08-28T16:27:50.644Z",
  candidate10_remote_process_sha256: "86fbbeedb773fa076ccfea59e6800e690ece8d274ed404f04016d45494672362",
  candidate10_started_at_utc: "2026-08-28T17:12:52.000Z",
  candidate10_ended_at_utc: "2026-08-28T17:13:22.999Z",
  expected_source_sha256: sha256(source),
  expected_test_source_sha256: sha256(testSource),
  expected_transport_source_sha256: sha256(transportSource),
  expected_effective_config_sha256: sha256(effective),
};

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function raw(stdout: string, status: number | null = 0, errorCode: string | null = null): RawProcessResult {
  return { status, signal: null, errorCode, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

function marker(
  ordinal: number,
  stage: EncodedMarker["stage"],
  phase: EncodedMarker["phase"],
  status: EncodedMarker["status"],
  payload?: unknown,
  error?: unknown,
): string {
  const semanticPayload = payload ?? (stage === "start"
    ? { direct_encoded_entry: true }
    : stage === "native_processes" && phase === "end"
      ? { current_pid: 999, command_line_returned: false, rows: [] }
      : stage === "target_existence" && phase === "end"
        ? {
          gate_path: "C:\\Windows\\Temp\\synthia-m4f-prod-20260828-03",
          gate_exists: false,
          backing_path: "D:\\synthia-m4f-toolchain-prod-20260828-03",
          backing_exists: false,
        }
        : stage === "complete"
          ? {
            remote_deadline: "cooperative_15_seconds",
            stdin_length: 0,
            process_mutation_performed: false,
            file_mutation_performed: false,
            acl_mutation_performed: false,
            service_mutation_performed: false,
            vivado_action_performed: false,
            hardware_action_performed: false,
          }
          : {});
  return JSON.stringify({
    schema: "synthia-m4f-direct-gate-roots-encoded-marker.v1",
    diagnostic_id: config.diagnostic_id,
    ordinal,
    stage,
    phase,
    status,
    payload: status === "unknown" ? null : semanticPayload,
    error: status === "unknown" ? (error ?? { code: "DEADLINE" }) : null,
  }) + "\n";
}

function transcript(): string {
  return marker(1, "start", "start", "observed")
    + marker(2, "native_processes", "begin", "started")
    + marker(3, "native_processes", "end", "observed")
    + marker(4, "target_existence", "begin", "started")
    + marker(5, "target_existence", "end", "observed")
    + marker(6, "complete", "complete", "complete");
}

function dependencies(remote = raw(transcript())): {
  value: EncodedDiagnosticDependencies;
  calls: Array<{ args: readonly string[]; stdin: Buffer; timeoutMs: number }>;
} {
  const calls: Array<{ args: readonly string[]; stdin: Buffer; timeoutMs: number }> = [];
  let clock = 0;
  return {
    calls,
    value: {
      spawn(_executable, args, stdin, timeoutMs) {
        calls.push({ args, stdin, timeoutMs });
        return calls.length === 1 ? raw(effective.toString("utf8")) : remote;
      },
      sourceBytes: () => source,
      testSourceBytes: () => testSource,
      transportSourceBytes: () => transportSource,
      admissionConfigBytes: () => admissionBytes,
      transportInputs: () => [],
      now: () => new Date(clock++ === 0 ? "2026-08-29T02:00:00.000Z" : "2026-08-29T02:00:25.000Z"),
    },
  };
}

describe("M4-F candidate11 direct EncodedCommand diagnostic", () => {
  test("puts start+flush first and excludes every wrapper or mutation surface", () => {
    const script = buildEncodedDiagnosticScript(config);
    expect(script.split("\n")[0]).toMatch(/^\[Console\]::Out\.WriteLine\(.+\);\[Console\]::Out\.Flush\(\)$/u);
    expect(script).toContain('S "native_processes"');
    expect(script).toContain("Get-Process powershell,sshd,conhost");
    expect(script).toContain("? Id -ne $PID");
    expect(script).toContain("candidate09_window");
    expect(script).toContain("candidate10_window");
    expect(script).toContain('S "target_existence"');
    expect(script).toContain("C:\\Windows\\Temp\\synthia-m4f-prod-20260828-03");
    expect(script).toContain("D:\\synthia-m4f-toolchain-prod-20260828-03");
    for (const forbidden of [
      "Console]::In", "ReadToEnd", "ScriptBlock", "GZip", "FromBase64String",
      "Get-CimInstance", "New-Item", "Set-Acl", "Remove-Item", "Start-Process",
      "Stop-Process", "Set-Service", "Start-Service", "vivado.bat", "program_hw",
      "open_hw", "write_bitstream",
    ]) expect(script).not.toContain(forbidden);
    expect(script).not.toContain("CommandLine");
  });

  test("freezes a direct EncodedCommand under the conservative Windows boundary", () => {
    const command = buildEncodedDiagnosticCommand(config);
    const plan = encodedDiagnosticPlan(config, admission);
    expect(command).toStartWith("powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ");
    const encoded = command.slice(command.lastIndexOf(" ") + 1);
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(buildEncodedDiagnosticScript(config));
    expect(plan).toMatchObject({
      topology: "single_ssh_direct_encoded_command_empty_stdin",
      attempt_count: 1,
      retry_permitted: false,
      local_timeout_ms: 25000,
      local_timeout_kill_signal: "SIGKILL",
      remote_cooperative_deadline_seconds: 15,
      stdin_length: 0,
      remote_command_length: command.length,
      remote_command_length_limit: 6000,
      windows_command_limit: 8191,
      reserved_command_characters: 2191,
      first_remote_action: "write_and_flush_start_marker",
      network_attempted: false,
    });
    expect(command.length).toBeLessThanOrEqual(6000);
    expect(8191 - command.length).toBeGreaterThanOrEqual(2191);
    expect(encodedDiagnosticConfirmation(config, admission)).toMatch(
      /^SYNTHIA_M4F_DIRECT_GATE_ROOTS_ENCODED_READ_ONLY:m4f-gate-roots-candidate11:(?:[0-9a-f]{64}:){3}[0-9a-f]{64}$/u,
    );
  });

  test("strictly parses complete marker prefixes", () => {
    expect(parseEncodedMarkers(Buffer.from(transcript()), config)).toHaveLength(6);
    expect(parseEncodedMarkers(Buffer.from(marker(1, "start", "start", "observed") + "partial"), config)).toHaveLength(1);
    expect(() => parseEncodedMarkers(Buffer.from(
      marker(1, "native_processes", "begin", "started"),
    ), config)).toThrow("M4F_GATE_ROOTS_ENCODED_MARKER_INVALID");
  });

  test("rejects semantic marker forgeries and treats non-empty tails as unknown", () => {
    const forgedNative = transcript().replace(
      marker(3, "native_processes", "end", "observed"),
      marker(3, "native_processes", "end", "observed", "forged"),
    );
    expect(() => parseEncodedMarkers(Buffer.from(forgedNative), config))
      .toThrow("M4F_GATE_ROOTS_ENCODED_MARKER_INVALID");
    const forgedWindow = transcript().replace(
      marker(3, "native_processes", "end", "observed"),
      marker(3, "native_processes", "end", "observed", {
        current_pid: 999,
        command_line_returned: false,
        rows: [{
          pid: 123,
          name: "powershell",
          start_token: "2026-08-28T16:26:00.0000000Z",
          candidate09_window: false,
          candidate10_window: false,
        }],
      }),
    );
    expect(() => parseEncodedMarkers(Buffer.from(forgedWindow), config))
      .toThrow("M4F_GATE_ROOTS_ENCODED_MARKER_INVALID");
    const forgedNullWindow = transcript().replace(
      marker(3, "native_processes", "end", "observed"),
      marker(3, "native_processes", "end", "observed", {
        current_pid: 999,
        command_line_returned: false,
        rows: [{
          pid: 123,
          name: "sshd",
          start_token: null,
          candidate09_window: false,
          candidate10_window: true,
        }],
      }),
    );
    expect(() => parseEncodedMarkers(Buffer.from(forgedNullWindow), config))
      .toThrow("M4F_GATE_ROOTS_ENCODED_MARKER_INVALID");
    const forgedTarget = transcript().replace(
      marker(5, "target_existence", "end", "observed"),
      marker(5, "target_existence", "end", "observed", {
        gate_path: "C:\\Windows\\Temp\\synthia-m4f-prod-20260828-03",
        backing_path: "D:\\synthia-m4f-toolchain-prod-20260828-03",
      }),
    );
    expect(() => parseEncodedMarkers(Buffer.from(forgedTarget), config))
      .toThrow("M4F_GATE_ROOTS_ENCODED_MARKER_INVALID");
    const completePayload = JSON.parse(marker(6, "complete", "complete", "complete")).payload;
    const forgedComplete = transcript().replace(
      marker(6, "complete", "complete", "complete"),
      marker(6, "complete", "complete", "complete", {
        ...completePayload,
        process_mutation_performed: true,
      }),
    );
    expect(() => parseEncodedMarkers(Buffer.from(forgedComplete), config))
      .toThrow("M4F_GATE_ROOTS_ENCODED_MARKER_INVALID");
    const scenario = dependencies(raw(transcript() + "garbage"));
    const result = executeEncodedDiagnostic(
      config,
      admission,
      encodedDiagnosticConfirmation(config, admission),
      scenario.value,
    );
    expect(result.status).toBe("partial_unknown");
    expect(result.trailing_fragment_length).toBe(7);
    expect(result.trailing_fragment_sha256).toBe(sha256("garbage"));
  });

  test("uses exactly one remote attempt with empty stdin and the 25-second bound", () => {
    const scenario = dependencies();
    const result = executeEncodedDiagnostic(
      config,
      admission,
      encodedDiagnosticConfirmation(config, admission),
      scenario.value,
    );
    expect(result.status).toBe("observed");
    expect(result.stdin_length).toBe(0);
    expect(result.trailing_fragment_length).toBe(0);
    expect(scenario.calls).toHaveLength(2);
    expect(scenario.calls[0]!.args[0]).toBe("-G");
    expect(scenario.calls[1]!.stdin.length).toBe(0);
    expect(scenario.calls[1]!.timeoutMs).toBe(25000);
    expect(scenario.calls[1]!.args.at(-1)).toBe(buildEncodedDiagnosticCommand(config));
  });

  test("records one attempt with explicit timestamps and never overwrites evidence", () => {
    const root = mkdtempSync("/tmp/synthia-m4f-candidate11-test-");
    temporaryDirectories.push(root);
    const evidence = root + "/evidence";
    const scenario = dependencies(raw(marker(1, "start", "start", "observed"), 255, "ETIMEDOUT"));
    const result = recordEncodedDiagnostic(
      config,
      encodedDiagnosticConfirmation(config, admission),
      evidence,
      scenario.value,
    );
    expect(result.status).toBe("partial_unknown");
    const record = JSON.parse(readFileSync(evidence + "/result.json", "utf8"));
    expect(record).toMatchObject({
      attempt_count: 1,
      started_at_utc: "2026-08-29T02:00:00.000Z",
      ended_at_utc: "2026-08-29T02:00:25.000Z",
      stdin_length: 0,
      retry_permitted: false,
    });
    expect(JSON.parse(readFileSync(evidence + "/remote-process.json", "utf8")))
      .toMatchObject({
        attempt_count: 1,
        started_at_utc: "2026-08-29T02:00:25.000Z",
        ended_at_utc: "2026-08-29T02:00:25.000Z",
        timed_out: true,
        stdin_length: 0,
        retry_permitted: false,
      });
    expect(JSON.parse(readFileSync(evidence + "/remote-command.json", "utf8")))
      .toMatchObject({ attempt_count: 1, stdin_length: 0 });
    for (const label of ["initial", "pre_remote", "post_remote"]) {
      expect(JSON.parse(readFileSync(evidence + `/transport-inputs-${label}.json`, "utf8"))).toEqual([]);
    }
    expect(() => recordEncodedDiagnostic(
      config,
      encodedDiagnosticConfirmation(config, admission),
      evidence,
      scenario.value,
    )).toThrow("M4F_GATE_ROOTS_ENCODED_EVIDENCE_DIRECTORY_INVALID");
    expect(scenario.calls).toHaveLength(2);
  });

  test("rejects stale confirmation and source drift before any spawn", () => {
    const scenario = dependencies();
    expect(() => executeEncodedDiagnostic(config, admission, "stale", scenario.value))
      .toThrow("M4F_GATE_ROOTS_ENCODED_CONFIRMATION_REQUIRED");
    expect(scenario.calls).toHaveLength(0);
    scenario.value.testSourceBytes = () => Buffer.from("drift");
    expect(() => executeEncodedDiagnostic(
      config,
      admission,
      encodedDiagnosticConfirmation(config, admission),
      scenario.value,
    )).toThrow("M4F_GATE_ROOTS_ENCODED_SOURCE_MISMATCH");
    expect(scenario.calls).toHaveLength(0);
  });
});
