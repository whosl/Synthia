import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import {
  buildGateRootsStagedRemoteScript,
  executeStagedDiagnostic,
  parseStagedMarkers,
  recordStagedDiagnostic,
  stagedDiagnosticConfirmation,
  stagedDiagnosticPlan,
  type M4fGateRootsStagedDiagnosticConfig,
  type StagedDiagnosticDependencies,
  type StagedMarker,
  type StagedRecordDependencies,
} from "./scripts/m4f-direct-gate-roots-staged-diagnostic.ts";
import type { M4fDirectAdmissionConfig, RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const source = Buffer.from("diagnostic-source");
const testSource = Buffer.from("diagnostic-test-source");
const gateRootsSource = Buffer.from("gate-roots-source");
const transportSource = Buffer.from("transport-source");
const temporaryDirectories: string[] = [];
const stageNames = [
  "identity", "start_observation", "volume_c", "volume_d", "target_existence",
  "ancestors_gate", "ancestors_backing", "root_acl_template", "stream_probe", "end_observation",
] as const;

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const effective = Buffer.from([
  "host 100.96.223.49", "hostname 100.96.223.49", "user admin", "port 22",
  "batchmode yes", "connecttimeout 15", "connectionattempts 1", "serveraliveinterval 0",
  "serveralivecountmax 4", "numberofpasswordprompts 0", "identityagent none",
  "identitiesonly yes", "pubkeyauthentication true", "passwordauthentication no",
  "kbdinteractiveauthentication no", "challengeresponseauthentication no",
  "gssapiauthentication no", "hostbasedauthentication no", "preferredauthentications publickey",
  "stricthostkeychecking true", "globalknownhostsfile /dev/null", "forwardagent no",
  "clearallforwardings yes", "permitlocalcommand no",
  "controlmaster false", "controlpersist no", "requesttty false", "warnweakcrypto no",
  "identityfile /tmp/id", "userknownhostsfile /tmp/known", "",
].join("\n"));

const admission: M4fDirectAdmissionConfig = {
  schema: "synthia-m4f-direct-admission-config.v1",
  gate_id: "admission-candidate10",
  target: {
    host: "100.96.223.49", port: 22, user: "admin", computer_name: "DESKTOP-DVFFB09",
    identity_name: "desktop-dvffb09\\admin", identity_sid: "S-1-5-21-2561815994-3878748218-1101284459-1001",
    identity_file: "/tmp/id", known_hosts_file: "/tmp/known", known_hosts_host_token: "100.96.223.49",
    host_key_fingerprint: "SHA256:jZVimVML+3vYKaaMK30EakIxOvOWiilN6FjBW/4uhfY",
    expected_effective_config_sha256: hash(effective), acl_paths: ["C:\\Windows\\Temp"],
    vivado_executable: "D:\\Xilinx\\Vivado\\2021.1\\bin\\vivado.bat",
    bun_executable: "D:\\synthia-worker\\runtime\\bun.exe",
  },
};

const config: M4fGateRootsStagedDiagnosticConfig = {
  schema: "synthia-m4f-direct-gate-roots-staged-diagnostic-config.v1",
  diagnostic_id: "m4f-gate-roots-candidate10",
  gate_id: "prod-20260828-03",
  admission_config_path: "/tmp/admission.json",
  admission_config_sha256: "a".repeat(64),
  candidate09_diagnostic_sha256: "c43e90a6319b0cd93ead246325be8e11f5a16e7606d63f17765b649212879726",
  candidate09_started_at_utc: "2026-08-28T16:25:50.640Z",
  candidate09_ended_at_utc: "2026-08-28T16:27:50.644Z",
  expected_gate_roots_source_sha256: hash(gateRootsSource),
  expected_diagnostic_source_sha256: hash(source),
  expected_test_source_sha256: hash(testSource),
  expected_transport_source_sha256: hash(transportSource),
  expected_effective_config_sha256: hash(effective),
};

function raw(stdout: string, status: number | null = 0, errorCode: string | null = null): RawProcessResult {
  return { status, signal: null, errorCode, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

function marker(ordinal: number, stage: StagedMarker["stage"], phase: StagedMarker["phase"], status: StagedMarker["status"]): string {
  return JSON.stringify({
    schema: "synthia-m4f-direct-gate-roots-staged-marker.v1",
    diagnostic_id: config.diagnostic_id,
    ordinal,
    stage,
    phase,
    status,
    observed_at_utc: "2026-08-29T00:00:00.000Z",
    payload: {},
    error: null,
  }) + "\n";
}

function fullTranscript(failedStage: typeof stageNames[number] | null): string {
  let ordinal = 0;
  let transcript = "";
  for (const stage of stageNames) {
    transcript += marker(++ordinal, stage, "begin", "started");
    transcript += marker(++ordinal, stage, "end", stage === failedStage ? "failed" : "observed");
  }
  return transcript + marker(++ordinal, "complete", "complete", "complete");
}

const admissionBytes = Buffer.from(JSON.stringify(admission));
const recordConfig: M4fGateRootsStagedDiagnosticConfig = {
  ...config,
  admission_config_sha256: hash(admissionBytes),
};

function recordDependencies(remote: RawProcessResult): {
  dependencies: StagedRecordDependencies;
  calls: Array<{ args: readonly string[]; timeoutMs: number }>;
} {
  const calls: Array<{ args: readonly string[]; timeoutMs: number }> = [];
  return {
    calls,
    dependencies: {
      spawn(_executable, args, _stdin, timeoutMs) {
        calls.push({ args, timeoutMs });
        return calls.length === 1 ? raw(effective.toString("utf8")) : remote;
      },
      sourceBytes: () => source,
      testSourceBytes: () => testSource,
      gateRootsSourceBytes: () => gateRootsSource,
      transportSourceBytes: () => transportSource,
      transportInputs: () => [],
      admissionConfigBytes: () => admissionBytes,
    },
  };
}

describe("M4-F Gate-root candidate10 staged read-only diagnostic", () => {
  test("builds flushed checkpoints around every high-risk stage with no mutation surface", () => {
    const script = buildGateRootsStagedRemoteScript(config, admission);
    for (const stage of stageNames) expect(script).toContain(`Stage "${stage}"`);
    expect((script.match(/\[Console\]::Out\.Flush\(\)/gu) ?? [])).toHaveLength(1);
    expect(script).toContain("Name='sshd.exe'");
    expect(script).toContain("candidate09_possible_count");
    expect(script).toContain('candidate09_attribution="possible_not_proven"');
    expect(script).toContain('wrapper_hash_role="supporting_not_required"');
    expect(script).toContain('Where-Object{$_.name -ceq "powershell.exe" -and $_.candidate09_start_window_match -and -not $_.current_diagnostic}');
    expect(script).toContain("candidate09_start_window_match");
    expect(script).toContain("command_line_sha256");
    expect(script).toContain("raw_command_line_returned=$false");
    expect(script).not.toContain("raw_command_line=");
    expect(script).toContain("C:\\Windows\\Temp\\synthia-m4f-prod-20260828-03");
    expect(script).not.toContain("synthia-m4f-prod-20260828-03-candidate10");
    expect(script).toContain('remote_self_deadline="cooperative_boundary_only"');
    expect(script).toContain('synchronous_call_cancellation="UNKNOWN"');
    expect(script).toContain('$script:failedStageCount+=1; return $null');
    expect(script).toContain('if($null -eq $identityFact){throw "M4F_GATE_ROOTS_STAGED_IDENTITY_STAGE_FAILED"}');
    for (const forbidden of [
      "New-Item", "Set-Acl", "Remove-Item", "Move-Item", "Copy-Item", "Rename-Item",
      "Set-Content", "Add-Content", "Out-File", "Start-Process", "Stop-Process",
      "Start-Service", "Stop-Service", "Restart-Service", "Set-Service", "New-Service",
      "Remove-Service", "Invoke-WebRequest", "Invoke-RestMethod", "program_hw",
      "open_hw", "connect_hw", "write_bitstream", "write_cfgmem",
    ]) expect(script).not.toMatch(new RegExp(`\\b${forbidden}\\b`, "iu"));
    expect(script).not.toMatch(/(?:^|[;&|]\s*)vivado(?:\.bat)?(?:\s|$)/imu);
  });

  test("freezes one SSH attempt, a 30-second local deadline, partial markers and UNKNOWN cancellation", () => {
    const plan = stagedDiagnosticPlan(config, admission);
    expect(plan).toMatchObject({
      maximum_attempts: 1,
      retry_permitted: false,
      local_deadline_ms: 30000,
      remote_cooperative_deadline_seconds: 20,
      partial_markers_accepted: true,
      remote_synchronous_call_cancellation: "UNKNOWN",
      local_timeout_may_leave_remote_process: "UNKNOWN",
      network_attempted: false,
    });
    expect(plan.stages).toEqual(stageNames);
    expect(stagedDiagnosticConfirmation(config, admission)).toMatch(
      /^SYNTHIA_M4F_DIRECT_GATE_ROOTS_STAGED_READ_ONLY:m4f-gate-roots-candidate10:(?:[0-9a-f]{64}:){3}[0-9a-f]{64}$/u,
    );
  });

  test("strictly parses complete NDJSON prefixes and ignores only a truncated tail", () => {
    const bytes = Buffer.from(
      marker(1, "identity", "begin", "started")
      + marker(2, "identity", "end", "observed")
      + '{"truncated":',
    );
    expect(parseStagedMarkers(bytes, config.diagnostic_id)).toHaveLength(2);
    expect(() => parseStagedMarkers(Buffer.from(
      marker(2, "identity", "begin", "started"),
    ), config.diagnostic_id)).toThrow("M4F_GATE_ROOTS_STAGED_MARKER_INVALID");
    expect(() => parseStagedMarkers(Buffer.from(
      marker(1, "start_observation", "begin", "started"),
    ), config.diagnostic_id)).toThrow("M4F_GATE_ROOTS_STAGED_MARKER_INVALID");
    expect(() => parseStagedMarkers(Buffer.from(
      marker(1, "identity", "end", "failed"),
    ), config.diagnostic_id)).toThrow("M4F_GATE_ROOTS_STAGED_MARKER_INVALID");
  });

  test("executes no more than one remote call and returns partial markers on timeout", () => {
    const calls: Array<{ args: readonly string[]; timeoutMs: number }> = [];
    const dependencies: StagedDiagnosticDependencies = {
      spawn(_executable, args, _stdin, timeoutMs) {
        calls.push({ args, timeoutMs });
        if (calls.length === 1) return raw(effective.toString("utf8"));
        return raw(marker(1, "identity", "begin", "started"), 255, "ETIMEDOUT");
      },
      sourceBytes: () => source,
      testSourceBytes: () => testSource,
      gateRootsSourceBytes: () => gateRootsSource,
      transportSourceBytes: () => transportSource,
      transportInputs: () => [],
    };
    const result = executeStagedDiagnostic(
      config,
      admission,
      stagedDiagnosticConfirmation(config, admission),
      dependencies,
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args[0]).toBe("-G");
    expect(calls[1]!.timeoutMs).toBe(30000);
    expect(result.markers).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.remote_state).toBe("partial_unknown");
  });

  test("does not classify a complete transcript containing a failed stage as observed", () => {
    const dependencies: StagedDiagnosticDependencies = {
      spawn(_executable, args) {
        return args[0] === "-G"
          ? raw(effective.toString("utf8"))
          : raw(fullTranscript("volume_c"));
      },
      sourceBytes: () => source,
      testSourceBytes: () => testSource,
      gateRootsSourceBytes: () => gateRootsSource,
      transportSourceBytes: () => transportSource,
      transportInputs: () => [],
    };
    const result = executeStagedDiagnostic(
      config,
      admission,
      stagedDiagnosticConfirmation(config, admission),
      dependencies,
    );
    expect(result.markers.at(-1)?.status).toBe("complete");
    expect(result.complete).toBe(false);
    expect(result.remote_state).toBe("partial_unknown");
  });

  test("fails closed before the remote attempt when pinned transport inputs drift", () => {
    let captures = 0;
    let spawns = 0;
    const dependencies: StagedDiagnosticDependencies = {
      spawn() {
        spawns += 1;
        return raw(effective.toString("utf8"));
      },
      sourceBytes: () => source,
      testSourceBytes: () => testSource,
      gateRootsSourceBytes: () => gateRootsSource,
      transportSourceBytes: () => transportSource,
      transportInputs: () => captures++ === 0 ? [] : [{
        schema: "synthia-m4f-direct-local-input.v1",
        label: "identity_file",
        path: "/tmp/drift",
        device: 1,
        inode: 1,
        owner_uid: 1,
        mode: 0o600,
        link_count: 1,
        size: 1,
        mtime_ms: 1,
        ctime_ms: 1,
        sha256: "0".repeat(64),
      }],
    };
    expect(() => executeStagedDiagnostic(
      config,
      admission,
      stagedDiagnosticConfirmation(config, admission),
      dependencies,
    )).toThrow("M4F_GATE_ROOTS_STAGED_TRANSPORT_INPUT_DRIFT");
    expect(spawns).toBe(1);
  });

  test("freezes timeout evidence with exclusive files and refuses overwrite", () => {
    const root = mkdtempSync("/tmp/synthia-m4f-candidate10-test-");
    temporaryDirectories.push(root);
    const evidenceDirectory = root + "/evidence";
    const scenario = recordDependencies(raw(
      marker(1, "identity", "begin", "started"), 255, "ETIMEDOUT",
    ));
    const result = recordStagedDiagnostic(
      recordConfig,
      stagedDiagnosticConfirmation(recordConfig, admission),
      evidenceDirectory,
      scenario.dependencies,
    );
    expect(result.complete).toBe(false);
    expect(scenario.calls).toHaveLength(2);
    expect(statSync(evidenceDirectory).mode & 0o777).toBe(0o700);
    expect(readdirSync(evidenceDirectory).sort()).toEqual([
      "admission-config.raw.json",
      "diagnostic-config.canonical.json",
      "markers.json",
      "powershell-stdin-wrapper.ps1",
      "remote-process.json",
      "remote-script.ps1",
      "remote-stderr.raw",
      "remote-stdout.raw",
      "result.json",
      "source-hashes.json",
      "ssh-effective-hashes.json",
      "ssh-effective-process.json",
      "ssh-effective.stderr.raw",
      "ssh-effective.stdout.raw",
      "transport-inputs-initial.json",
      "transport-inputs-post_remote.json",
      "transport-inputs-pre_remote.json",
    ]);
    expect(statSync(evidenceDirectory + "/remote-stdout.raw").mode & 0o777).toBe(0o600);
    expect(readFileSync(evidenceDirectory + "/remote-stdout.raw", "utf8"))
      .toBe(marker(1, "identity", "begin", "started"));
    expect(() => recordStagedDiagnostic(
      recordConfig,
      stagedDiagnosticConfirmation(recordConfig, admission),
      evidenceDirectory,
      scenario.dependencies,
    )).toThrow("M4F_GATE_ROOTS_STAGED_EVIDENCE_DIRECTORY_INVALID");
    expect(scenario.calls).toHaveLength(2);
  });

  test("preserves raw streams, process facts and parse failure after malformed output", () => {
    const root = mkdtempSync("/tmp/synthia-m4f-candidate10-error-test-");
    temporaryDirectories.push(root);
    const evidenceDirectory = root + "/evidence";
    const scenario = recordDependencies(raw("not-json\n", 255, null));
    expect(() => recordStagedDiagnostic(
      recordConfig,
      stagedDiagnosticConfirmation(recordConfig, admission),
      evidenceDirectory,
      scenario.dependencies,
    )).toThrow("M4F_GATE_ROOTS_STAGED_MARKER_INVALID");
    expect(readdirSync(evidenceDirectory)).toContain("failure.json");
    expect(readdirSync(evidenceDirectory)).toContain("marker-parse-failure.json");
    expect(readFileSync(evidenceDirectory + "/remote-stdout.raw", "utf8")).toBe("not-json\n");
    expect(JSON.parse(readFileSync(evidenceDirectory + "/remote-process.json", "utf8")))
      .toMatchObject({ exit_status: 255, stdout_sha256: hash("not-json\n"), retry_permitted: false });
  });

  test("rejects stale confirmation and any source drift before spawning", () => {
    const calls: unknown[] = [];
    const dependencies: StagedDiagnosticDependencies = {
      spawn(...args) { calls.push(args); return raw(""); },
      sourceBytes: () => source,
      testSourceBytes: () => testSource,
      gateRootsSourceBytes: () => gateRootsSource,
      transportSourceBytes: () => transportSource,
      transportInputs: () => [],
    };
    expect(() => executeStagedDiagnostic(config, admission, "wrong", dependencies))
      .toThrow("M4F_GATE_ROOTS_STAGED_CONFIRMATION_REQUIRED");
    expect(calls).toHaveLength(0);
    dependencies.testSourceBytes = () => Buffer.from("drift");
    expect(() => executeStagedDiagnostic(
      config,
      admission,
      stagedDiagnosticConfirmation(config, admission),
      dependencies,
    )).toThrow("M4F_GATE_ROOTS_STAGED_SOURCE_MISMATCH");
    expect(calls).toHaveLength(0);
  });
});
