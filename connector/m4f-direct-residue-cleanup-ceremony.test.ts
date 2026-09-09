import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  captureM4fDirectTransportInputs,
  type M4fDirectAdmissionConfig,
} from "./scripts/m4f-gate-admission-transport.ts";
import {
  assertResidueCleanupConfirmation,
  assertHandleStartDiagnosticConfirmation,
  buildHandleStartDiagnosticRemoteCommand,
  buildHandleStartDiagnosticRemoteScript,
  buildResidueCleanupRemoteCommand,
  buildResidueCleanupRemoteScript,
  classifyPartialCleanupEffects,
  cleanupConfirmation,
  deriveResidueCleanupPlan,
  executeHandleStartDiagnostic,
  executeResidueCleanup,
  handleStartDiagnosticConfirmation,
  HandleStartDiagnosticFailure,
  M4F_DIRECT_RESIDUE_CLEANUP_GUARDS,
  normalizeWindowsUtcTicksToCimPrecision,
  parseDotNetUtcIsoToTicks,
  parseCleanupMarkerPrefix,
  parseCleanupMarkers,
  planResidueCleanup,
  planHandleStartDiagnostic,
  ResidueCleanupFailure,
  type CleanupMarker,
  type M4fDirectResidueCleanupConfig,
  type M4fDirectResidueCleanupConfigV1,
  type M4fDirectHandleStartDiagnosticConfig,
  type HandleStartDiagnosticPlan,
  type ResidueCleanupPlan,
  validCleanupOutput,
  validHandleStartDiagnosticOutput,
  validateHandleStartDiagnosticConfig,
  validateResidueCleanupConfig,
} from "./scripts/m4f-direct-residue-cleanup-ceremony.ts";

const HASH = "a".repeat(64);
const POWERSHELL_HASH = "8".repeat(64);
const CONHOST_HASH = "4".repeat(64);
const OBSERVED_AT = "2026-08-28T07:00:00.0000000Z";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const STAGES = [
  ["identity", "2026-08-28T04:58:38.036Z", "2026-08-28T04:58:40.2848080Z", 67504, 22844, 57736],
  ["volumes", "2026-08-28T04:59:38.046Z", "2026-08-28T04:59:40.8741360Z", 61560, 61792, 34440],
  ["acl-01", "2026-08-28T05:00:38.060Z", "2026-08-28T05:00:41.0239510Z", 49588, 49424, 4120],
  ["acl-02", "2026-08-28T05:01:38.075Z", "2026-08-28T05:01:40.6062450Z", 67232, 66952, 67000],
  ["acl-03", "2026-08-28T05:02:38.088Z", "2026-08-28T05:02:40.3772930Z", 14444, 49044, 52508],
  ["listeners", "2026-08-28T05:03:38.096Z", "2026-08-28T05:03:42.8926620Z", 45188, 52856, 65484],
  ["vivado-fact", "2026-08-28T05:04:41.209Z", "2026-08-28T05:04:43.8325900Z", 54852, 6696, 33804],
  ["bun-fact", "2026-08-28T05:05:41.220Z", "2026-08-28T05:05:44.3912860Z", 44400, 57848, 25536],
] as const;

function config(): M4fDirectResidueCleanupConfig {
  return {
    schema: "synthia-m4f-direct-residue-cleanup-config.v1",
    ceremony_id: "cleanup-prod-01",
    admission_config_path: "/private/admission.json",
    admission_config_sha256: HASH,
    residue_record_path: "/private/residue.json",
    residue_record_sha256: HASH,
    staged_record_path: "/private/staged.json",
    staged_record_sha256: HASH,
    expected_source_sha256: HASH,
    expected_transport_source_sha256: HASH,
    expected_effective_config_sha256: HASH,
  };
}

function admission(): M4fDirectAdmissionConfig {
  return {
    target: {
      host: "100.96.223.49",
      user: "admin",
      computer_name: "DESKTOP-DVFFB09",
      identity_name: "desktop-dvffb09\\admin",
      identity_sid: "S-1-5-21-2561815994-3878748218-1101284459-1001",
    },
  } as M4fDirectAdmissionConfig;
}

function processFact(
  pid: number,
  parentPid: number,
  name: string,
  created: string,
  commandSha256: string,
  processClass: "session" | "sshd" | "current",
): Record<string, unknown> {
  return {
    pid,
    parent_pid: parentPid,
    name,
    created,
    command_sha256: commandSha256,
    class: processClass,
  };
}

function residueRecord(): Record<string, unknown> {
  const processes: Record<string, unknown>[] = [
    processFact(5720, 1448, "sshd.exe", "2026-08-12T22:31:34.3585680Z", "c".repeat(64), "sshd"),
    processFact(62348, 5720, "sshd.exe", "2026-08-28T04:20:27.7190740Z", "d".repeat(64), "sshd"),
    processFact(7744, 66312, "powershell.exe", "2026-08-28T06:58:03.7336520Z", "e".repeat(64), "current"),
  ];
  for (const [, , powerShellCreated, powerShellPid, conhostPid, parentPid] of STAGES) {
    const conhostCreated = powerShellCreated.replace(
      /\.(\d{2})\d+Z$/u,
      (_match, prefix: string) => `.${prefix}00000Z`,
    );
    processes.push(
      processFact(powerShellPid, parentPid, "powershell.exe", powerShellCreated, POWERSHELL_HASH, "session"),
      processFact(conhostPid, parentPid, "conhost.exe", conhostCreated, CONHOST_HASH, "session"),
    );
  }
  const followupMarker = (ordinal: number, phase: string, payload: Record<string, unknown>) => ({
    ordinal,
    phase,
    status: "observed",
    observed_at_utc: OBSERVED_AT,
    payload,
    error: null,
  });
  return {
    schema: "synthia-m4f-direct-identity-residue-followup-record.v2",
    status: "observed",
    hardware_action_performed: false,
    process_termination_performed: false,
    marker_count: 8,
    last_marker_phase: "complete",
    attempt: 1,
    retry_permitted: false,
    trailing_fragment_length: 0,
    trailing_fragment_sha256: sha256(Buffer.alloc(0)),
    stdout_truncated_line: false,
    process: {
      exit_status: 0,
      signal: null,
      error_code: null,
      timed_out: false,
      outcome_ambiguous: false,
      stdout_length: 4096,
      stdout_sha256: HASH,
      stderr_length: 0,
      stderr_sha256: HASH,
      retry_permitted: false,
    },
    markers: [
      followupMarker(1, "start", { current_pid: 7744 }),
      followupMarker(2, "env-identity", {}),
      followupMarker(3, "processes-native", {}),
      followupMarker(4, "cim-system-snapshot", {
        current_pid: 7744,
        processes,
        resource: { free_kib: 1024, process_count: 24, total_kib: 2048 },
        sshd_service: { exists: true, start_type: "Automatic", status: "Running" },
      }),
      followupMarker(5, "openssh-events", {}),
      followupMarker(6, "whoami-user", {
        exit_status: 0,
        identity_name: admission().target.identity_name,
        identity_sid: admission().target.identity_sid,
      }),
      followupMarker(7, "windows-identity", {
        identity_name: admission().target.identity_name,
        identity_sid: admission().target.identity_sid,
      }),
      followupMarker(8, "complete", { complete: true }),
    ],
  };
}

function stagedRecord(): Record<string, unknown> {
  const unknown = STAGES.map(([stageId, started], index) => ({
    stage_id: stageId,
    ordinal: index < 6 ? index + 2 : index + 3,
    attempt: 1,
    retry_permitted: false,
    status: "unknown",
    output_valid: false,
    started_at_utc: started,
    finished_at_utc: new Date(Date.parse(started) + 60_000).toISOString(),
    script_sha256: HASH,
    process: {
      timed_out: true,
      outcome_ambiguous: true,
      error_code: "ETIMEDOUT",
      signal: "SIGKILL",
      stdout_length: 0,
      stderr_length: 0,
      retry_permitted: false,
    },
  }));
  const observed = (stageId: string, ordinal: number) => ({
    stage_id: stageId,
    ordinal,
    attempt: 1,
    retry_permitted: false,
    status: "observed",
    output_valid: true,
    started_at_utc: "2026-08-28T04:57:00.000Z",
    finished_at_utc: "2026-08-28T04:57:01.000Z",
    script_sha256: HASH,
  });
  return {
    schema: "synthia-m4f-direct-staged-diagnostic-record.v1",
    status: "completed_with_unknown",
    hardware_action_performed: false,
    planned_stage_count: 10,
    attempted_stage_count: 10,
    observed_stage_count: 2,
    unknown_stage_count: 8,
    stage_records: [
      observed("wrapper-smoke", 1),
      ...unknown.slice(0, 6),
      observed("processes", 8),
      ...unknown.slice(6),
    ],
  };
}

function plan(): ResidueCleanupPlan {
  return deriveResidueCleanupPlan(config(), admission(), residueRecord(), stagedRecord());
}

function marker(phase: CleanupMarker["phase"], payload: Record<string, unknown>): CleanupMarker {
  return { phase, status: "observed", observed_at_utc: OBSERVED_AT, payload };
}

function successMarkers(value: ResidueCleanupPlan): CleanupMarker[] {
  const pids = value.targets.map((target) => target.pid);
  const killPerformedPids = [...pids];
  return [
    marker("start", { current_pid: 90000, target_count: 16, plan_sha256: value.plan_sha256 }),
    marker("pre-identity", {
      computer: value.target_computer,
      name: value.target_identity_name,
      sid: value.target_identity_sid,
    }),
    marker("preflight", { matched: 16 }),
    ...value.targets.map((target) => marker("target", {
      ordinal: target.ordinal,
      pid: target.pid,
      start_token: target.start_token_sha256,
      effect: "terminated_exact_handle",
    })),
    marker("postflight", {
      residue_pids: [],
      kill_performed_pids: killPerformedPids,
      already_exited_pids: [],
      resolved_target_pids: pids,
    }),
    marker("post-identity", {
      computer: value.target_computer,
      name: value.target_identity_name,
      sid: value.target_identity_sid,
    }),
    marker("complete", {
      complete: true,
      resolved_count: 16,
      kill_performed_count: 16,
      already_exited_count: 0,
    }),
  ];
}

function effectiveConfig(admitted: M4fDirectAdmissionConfig): Buffer {
  const values: Record<string, string> = {
    hostname: admitted.target.host,
    user: admitted.target.user,
    port: "22",
    batchmode: "yes",
    connecttimeout: "15",
    connectionattempts: "1",
    serveraliveinterval: "0",
    serveralivecountmax: "4",
    numberofpasswordprompts: "0",
    identityagent: "none",
    identitiesonly: "yes",
    pubkeyauthentication: "true",
    passwordauthentication: "no",
    kbdinteractiveauthentication: "no",
    gssapiauthentication: "no",
    hostbasedauthentication: "no",
    preferredauthentications: "publickey",
    stricthostkeychecking: "true",
    forwardagent: "no",
    clearallforwardings: "yes",
    permitlocalcommand: "no",
    controlmaster: "false",
    controlpersist: "no",
    warnweakcrypto: "no",
    requesttty: "false",
    identityfile: admitted.target.identity_file,
    userknownhostsfile: admitted.target.known_hosts_file,
    globalknownhostsfile: "/dev/null",
  };
  return Buffer.from(Object.entries(values).map(([key, value]) => `${key} ${value}`).join("\n") + "\n");
}

function boundFileFact(path: string): Record<string, unknown> {
  const stat = statSync(path);
  const bytes = readFileSync(path);
  return {
    path,
    device: stat.dev,
    inode: stat.ino,
    owner_uid: stat.uid,
    mode: 0o600,
    link_count: 1,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    sha256: sha256(bytes),
  };
}

function successfulDiagnosticRecord(
  cleanupPlan: ResidueCleanupPlan,
  cleanupPlanPath: string,
  admissionPath: string,
  admitted: M4fDirectAdmissionConfig,
): Record<string, unknown> {
  const diagnosticPlan = {
    diagnostic_id: "handle-start-diagnostic-success-02",
    plan_sha256: "b".repeat(64),
    cleanup_plan_sha256: cleanupPlan.plan_sha256,
    target_computer: cleanupPlan.target_computer,
    target_identity_name: cleanupPlan.target_identity_name,
    target_identity_sid: cleanupPlan.target_identity_sid,
    targets: cleanupPlan.targets,
  } as HandleStartDiagnosticPlan;
  const transport = captureM4fDirectTransportInputs(admitted);
  const bound = [boundFileFact(admissionPath), boundFileFact(cleanupPlanPath)];
  return {
    schema: "synthia-m4f-direct-handle-start-diagnostic-record.v1",
    diagnostic_id: diagnosticPlan.diagnostic_id,
    status: "observed",
    action: "observe_handle_start_ticks_read_only",
    plan_sha256: diagnosticPlan.plan_sha256,
    cleanup_plan_sha256: cleanupPlan.plan_sha256,
    confirmation_sha256: sha256(handleStartDiagnosticConfirmation(
      diagnosticPlan.diagnostic_id,
      diagnosticPlan.plan_sha256,
      16,
    )),
    attempt: 1,
    timeout_ms: 45000,
    recorded_at_utc: "2026-08-28T08:00:00.000Z",
    elapsed_ms: 100,
    observation: handleStartObservation(diagnosticPlan),
    process: {
      exit_status: 0,
      signal: null,
      error_code: null,
      timed_out: false,
      outcome_ambiguous: false,
      stdout_length: 1024,
      stdout_sha256: "d".repeat(64),
      stderr_length: 0,
      stderr_sha256: sha256(Buffer.alloc(0)),
      retry_permitted: false,
    },
    transport_inputs_before: transport,
    transport_inputs_after: structuredClone(transport),
    bound_files_before: bound,
    bound_files_after: structuredClone(bound),
    process_termination_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    retry_permitted: false,
  };
}

function driftFixture(
  kind: "none" | "source" | "evidence" | "transport" | "diagnostic-before" | "diagnostic-after",
): {
  config: M4fDirectResidueCleanupConfig;
  confirmation: string;
  evidenceDirectory: string;
  dependencies: Parameters<typeof executeResidueCleanup>[3];
} {
  const root = mkdtempSync(join(tmpdir(), "synthia-cleanup-test-"));
  const identityPath = join(root, "id_ed25519");
  const knownHostsPath = join(root, "known_hosts");
  const key = Buffer.alloc(32, 7);
  const fingerprint = "SHA256:"
    + createHash("sha256").update(key).digest("base64").replace(/=+$/u, "");
  writeFileSync(identityPath, "private-key-A");
  writeFileSync(knownHostsPath, `100.96.223.49 ssh-ed25519 ${key.toString("base64")}\n`);
  chmodSync(identityPath, 0o600);
  chmodSync(knownHostsPath, 0o600);
  const admitted: M4fDirectAdmissionConfig = {
    schema: "synthia-m4f-direct-admission-config.v1",
    gate_id: "cleanup-test",
    target: {
      host: "100.96.223.49",
      port: 22,
      user: "admin",
      computer_name: "DESKTOP-DVFFB09",
      identity_name: "desktop-dvffb09\\admin",
      identity_sid: "S-1-5-21-2561815994-3878748218-1101284459-1001",
      identity_file: identityPath,
      known_hosts_file: knownHostsPath,
      known_hosts_host_token: "100.96.223.49",
      host_key_fingerprint: fingerprint,
      expected_effective_config_sha256: null,
      acl_paths: ["C:\\one", "C:\\two", "C:\\three"],
      vivado_executable: "C:\\Xilinx\\Vivado\\bin\\vivado.bat",
      bun_executable: "C:\\Bun\\bun.exe",
    },
  };
  const admissionBytes = Buffer.from(JSON.stringify(admitted));
  const residueBytes = Buffer.from(JSON.stringify(residueRecord()));
  const stagedBytes = Buffer.from(JSON.stringify(stagedRecord()));
  const admissionPath = join(root, "admission.json");
  const residuePath = join(root, "residue.json");
  const stagedPath = join(root, "staged.json");
  for (const [path, bytes] of [
    [admissionPath, admissionBytes],
    [residuePath, residueBytes],
    [stagedPath, stagedBytes],
  ] as Array<[string, Buffer]>) {
    writeFileSync(path, bytes);
    chmodSync(path, 0o600);
  }
  const source = Buffer.from("reviewed-cleanup-source");
  const transportSource = Buffer.from("reviewed-transport-source");
  const effective = effectiveConfig(admitted);
  const auditConfig: M4fDirectResidueCleanupConfigV1 = {
    schema: "synthia-m4f-direct-residue-cleanup-config.v1",
    ceremony_id: "cleanup-drift-test",
    admission_config_path: admissionPath,
    admission_config_sha256: sha256(admissionBytes),
    residue_record_path: residuePath,
    residue_record_sha256: sha256(residueBytes),
    staged_record_path: stagedPath,
    staged_record_sha256: sha256(stagedBytes),
    expected_source_sha256: sha256(source),
    expected_transport_source_sha256: sha256(transportSource),
    expected_effective_config_sha256: sha256(effective),
  };
  const auditPlan = deriveResidueCleanupPlan(
    auditConfig,
    admitted,
    residueRecord(),
    stagedRecord(),
  );
  const auditPlanPath = join(root, "diagnostic-bound-cleanup-plan.json");
  writeFileSync(auditPlanPath, JSON.stringify(auditPlan));
  chmodSync(auditPlanPath, 0o600);
  const diagnosticRecord = successfulDiagnosticRecord(
    auditPlan,
    auditPlanPath,
    admissionPath,
    admitted,
  );
  const diagnosticRecordPath = join(root, "diagnostic-record.json");
  const diagnosticRecordBytes = Buffer.from(JSON.stringify(diagnosticRecord));
  writeFileSync(diagnosticRecordPath, diagnosticRecordBytes);
  chmodSync(diagnosticRecordPath, 0o600);
  const cleanupConfig: M4fDirectResidueCleanupConfig = {
    ...auditConfig,
    schema: "synthia-m4f-direct-residue-cleanup-config.v2",
    handle_start_diagnostic_record_path: diagnosticRecordPath,
    handle_start_diagnostic_record_sha256: sha256(diagnosticRecordBytes),
  };
  let partialStdout = Buffer.alloc(0);
  let sourceReads = 0;
  let monotonic = 0;
  const dependencies: Parameters<typeof executeResidueCleanup>[3] = {
    spawn(_executable, args) {
      if (args[0] === "-G") {
        if (kind === "diagnostic-before") {
          writeFileSync(diagnosticRecordPath, Buffer.concat([diagnosticRecordBytes, Buffer.from(" ")]));
          chmodSync(diagnosticRecordPath, 0o600);
        }
        return { status: 0, signal: null, errorCode: null, stdout: effective, stderr: Buffer.alloc(0) };
      }
      if (kind === "evidence") {
        writeFileSync(residuePath, Buffer.from("evidence-drift"));
        chmodSync(residuePath, 0o600);
      } else if (kind === "transport") {
        writeFileSync(identityPath, "private-key-B");
        chmodSync(identityPath, 0o600);
      } else if (kind === "diagnostic-after") {
        writeFileSync(diagnosticRecordPath, Buffer.concat([diagnosticRecordBytes, Buffer.from(" ")]));
        chmodSync(diagnosticRecordPath, 0o600);
      }
      return { status: 0, signal: null, errorCode: null, stdout: partialStdout, stderr: Buffer.alloc(0) };
    },
    sourceBytes() {
      sourceReads += 1;
      return kind === "source" && sourceReads >= 3 ? Buffer.from("source-drift") : source;
    },
    transportSourceBytes: () => transportSource,
    now: () => new Date("2026-08-28T08:00:00.000Z"),
    monotonicMs: () => ++monotonic,
  };
  const cleanupPlan = planResidueCleanup(cleanupConfig, dependencies);
  sourceReads = 0;
  const partialMarkers = successMarkers(cleanupPlan).slice(0, 4);
  if (kind === "none") {
    partialMarkers.push({
      phase: "target",
      status: "unknown",
      observed_at_utc: OBSERVED_AT,
      payload: {
        ordinal: cleanupPlan.targets[1]!.ordinal,
        pid: cleanupPlan.targets[1]!.pid,
        effect: "none_handle_start_changed",
      },
    });
  }
  partialStdout = Buffer.from(partialMarkers
    .map((item) => JSON.stringify(item)).join("\n") + "\n");
  return {
    config: cleanupConfig,
    confirmation: cleanupPlan.confirmation,
    evidenceDirectory: join(root, "cleanup-evidence"),
    dependencies,
  };
}

function handleStartObservation(value: HandleStartDiagnosticPlan): Record<string, unknown> {
  const first = value.targets[0]!;
  const targets = value.targets.map((target) => ({
    ordinal: target.ordinal,
    expected_pid: target.pid,
    exists: true,
    pid: target.pid,
    parent_pid: target.parent_pid,
    name: target.name,
    creation_utc: target.creation_utc,
    creation_utc_ticks: String(parseDotNetUtcIsoToTicks(target.creation_utc)),
    command_sha256: target.command_sha256,
    process_class: "session",
    core_match: true,
  }));
  const expectedTicks = parseDotNetUtcIsoToTicks(first.creation_utc);
  const handleTicks = expectedTicks + 7n;
  const handleIso = first.creation_utc.replace(/0Z$/u, "7Z");
  return {
    schema: "synthia-m4f-direct-handle-start-observation.v1",
    diagnostic_id: value.diagnostic_id,
    diagnostic_plan_sha256: value.plan_sha256,
    cleanup_plan_sha256: value.cleanup_plan_sha256,
    current_pid: 90000,
    identity: {
      computer: value.target_computer,
      name: value.target_identity_name,
      sid: value.target_identity_sid,
    },
    ordinal_one_expected: {
      ordinal: first.ordinal,
      pid: first.pid,
      parent_pid: first.parent_pid,
      peer_pid: first.peer_pid,
      name: first.name,
      creation_utc: first.creation_utc,
      command_sha256: first.command_sha256,
      start_token: first.start_token_sha256,
    },
    ordinal_one: {
      cim: targets[0],
      handle: {
        available: true,
        id: first.pid,
        has_exited: false,
        start_time_utc: handleIso,
        start_time_utc_ticks: String(handleTicks),
        expected_cim_utc_ticks: String(expectedTicks),
        tick_delta: "7",
        normalized_handle_utc_ticks: String(normalizeWindowsUtcTicksToCimPrecision(handleTicks)),
        normalized_cim_utc_ticks: String(normalizeWindowsUtcTicksToCimPrecision(expectedTicks)),
        normalized_equal: true,
      },
    },
    targets,
    protection: {
      pid_13644: {
        pid: 13644,
        exists: true,
        name: "node.exe",
        creation_utc: "2026-08-14T08:02:31.2903580Z",
      },
      sshd: [{ pid: 5720, parent_pid: 1448, name: "sshd.exe" }],
    },
    process_termination_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
  };
}

function diagnosticFixture(): {
  config: M4fDirectHandleStartDiagnosticConfig;
  plan: HandleStartDiagnosticPlan;
  evidenceDirectory: string;
  dependencies: Parameters<typeof executeHandleStartDiagnostic>[3];
  counts: { effective: number; remote: number };
} {
  const base = driftFixture("none");
  const admitted = JSON.parse(readFileSync(base.config.admission_config_path, "utf8"));
  const residue = JSON.parse(readFileSync(base.config.residue_record_path, "utf8"));
  const staged = JSON.parse(readFileSync(base.config.staged_record_path, "utf8"));
  const cleanupPlan = deriveResidueCleanupPlan(base.config, admitted, residue, staged);
  const root = dirname(base.config.admission_config_path);
  const cleanupPlanPath = join(root, "frozen-cleanup-plan.json");
  const consumedEvidenceRoot = join(root, "consumed-handle-start-diagnostics");
  mkdirSync(consumedEvidenceRoot, { mode: 0o700 });
  chmodSync(consumedEvidenceRoot, 0o700);
  const cleanupPlanBytes = Buffer.from(JSON.stringify(cleanupPlan));
  writeFileSync(cleanupPlanPath, cleanupPlanBytes);
  chmodSync(cleanupPlanPath, 0o600);
  const config: M4fDirectHandleStartDiagnosticConfig = {
    schema: "synthia-m4f-direct-handle-start-diagnostic-config.v1",
    diagnostic_id: "handle-start-diagnostic-test-01",
    cleanup_plan_path: cleanupPlanPath,
    cleanup_plan_sha256: sha256(cleanupPlanBytes),
    admission_config_path: base.config.admission_config_path,
    admission_config_sha256: base.config.admission_config_sha256,
    consumed_evidence_root: consumedEvidenceRoot,
    expected_source_sha256: base.config.expected_source_sha256,
    expected_transport_source_sha256: base.config.expected_transport_source_sha256,
    expected_effective_config_sha256: base.config.expected_effective_config_sha256,
  };
  const counts = { effective: 0, remote: 0 };
  let planValue: HandleStartDiagnosticPlan;
  const dependencies: Parameters<typeof executeHandleStartDiagnostic>[3] = {
    ...base.dependencies,
    spawn(executable, args, stdin, timeoutMs) {
      if (args[0] === "-G") {
        counts.effective += 1;
        return base.dependencies.spawn(executable, args, stdin, timeoutMs);
      }
      counts.remote += 1;
      return {
        status: 0,
        signal: null,
        errorCode: null,
        stdout: Buffer.from(JSON.stringify(handleStartObservation(planValue)) + "\n"),
        stderr: Buffer.alloc(0),
      };
    },
  };
  planValue = planHandleStartDiagnostic(config, dependencies);
  return {
    config,
    plan: planValue,
    evidenceDirectory: join(consumedEvidenceRoot, config.diagnostic_id),
    dependencies,
    counts,
  };
}

function mutateBoundDiagnosticRecord(
  fixture: ReturnType<typeof driftFixture>,
  mutate: (record: Record<string, any>) => void,
): void {
  if (fixture.config.schema !== "synthia-m4f-direct-residue-cleanup-config.v2") {
    throw new Error("v2 fixture required");
  }
  const path = fixture.config.handle_start_diagnostic_record_path;
  const record = JSON.parse(readFileSync(path, "utf8"));
  mutate(record);
  const bytes = Buffer.from(JSON.stringify(record));
  writeFileSync(path, bytes);
  chmodSync(path, 0o600);
  fixture.config.handle_start_diagnostic_record_sha256 = sha256(bytes);
}

describe("M4F direct residue cleanup ceremony", () => {
  test("derives only the eight staged PowerShell/conhost pairs", () => {
    const value = plan();
    expect(value.target_count).toBe(16);
    expect(value.targets.slice(0, 8).every((target) => target.name === "powershell.exe")).toBe(true);
    expect(value.targets.slice(8).every((target) => target.name === "conhost.exe")).toBe(true);
    expect(new Set(value.targets.map((target) => target.stage_id))).toEqual(new Set(STAGES.map(([id]) => id)));
    expect(value.targets.every((target) => target.process_class === "session")).toBe(true);
    expect(value.targets.every((target) => target.start_token_sha256.length === 64)).toBe(true);
  });

  test("hard-protects service/current sshd, current observer, and Node 13644", () => {
    const value = plan();
    const protectedPids = value.protected_processes.map((process) => process.pid);
    expect(protectedPids).toContain(5720);
    expect(protectedPids).toContain(62348);
    expect(protectedPids).toContain(7744);
    expect(protectedPids).toContain(13644);
    expect(value.targets.some((target) => protectedPids.includes(target.pid))).toBe(false);
    expect(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.normalSshdTerminationPermitted).toBe(false);
    expect(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.nodeTerminationPermitted).toBe(false);
  });

  test("fails closed when a stage has an additional candidate", () => {
    const residue = residueRecord();
    const marker = (residue.markers as Array<Record<string, unknown>>)[3]!;
    const payload = marker.payload as Record<string, unknown>;
    (payload.processes as Array<Record<string, unknown>>).push(
      processFact(9999, 57736, "conhost.exe", "2026-08-28T04:58:41.0000000Z", CONHOST_HASH, "session"),
    );
    expect(() => deriveResidueCleanupPlan(config(), admission(), residue, stagedRecord()))
      .toThrow(ResidueCleanupFailure);
    try {
      deriveResidueCleanupPlan(config(), admission(), residue, stagedRecord());
    } catch (error) {
      expect((error as ResidueCleanupFailure).detail.code)
        .toBe("M4F_DIRECT_RESIDUE_CLEANUP_STAGE_TARGET_AMBIGUOUS");
    }
  });

  test("fails closed if the frozen staged record no longer proves eight timeouts", () => {
    const staged = stagedRecord();
    staged.unknown_stage_count = 7;
    expect(() => deriveResidueCleanupPlan(config(), admission(), residueRecord(), staged))
      .toThrow(ResidueCleanupFailure);
  });

  test("requires the exact plan-bound confirmation", () => {
    const value = plan();
    expect(value.confirmation).toBe(cleanupConfirmation(value.ceremony_id, value.plan_sha256, 16));
    expect(() => assertResidueCleanupConfirmation(value, value.confirmation)).not.toThrow();
    expect(() => assertResidueCleanupConfirmation(value, value.confirmation + "-changed"))
      .toThrow(ResidueCleanupFailure);
  });

  test("remote command is one bounded empty-stdin ceremony with PID reuse guards", () => {
    const value = plan();
    const packed = buildResidueCleanupRemoteCommand(value);
    expect(packed.command.length).toBeLessThanOrEqual(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.remoteCommandLimit);
    expect(packed.command).not.toContain("EncodedCommand");
    expect(packed.command).not.toContain("Console]::In");
    expect(packed.command).not.toContain("$input");
    expect(packed.loader).toContain("$ErrorActionPreference='Stop'");
    expect(packed.script).toContain("GetProcessById");
    expect(packed.script).toContain(
      "function U($d){$u=([datetime]$d).ToUniversalTime();[long]($u.Ticks-($u.Ticks%10))}",
    );
    expect(packed.script).toContain("if((U $p.StartTime)-ne(U ([string]$t[5])))");
    expect(packed.script).not.toContain("StartTime.ToUniversalTime().ToString(\"o\")");
    expect(packed.script).toContain("$anc[$i]");
    expect(packed.script).toContain("$c.p-contains$i");
    expect(packed.script).toContain("none_token_changed");
    expect(packed.script).toContain("none_handle_start_changed");
    expect(packed.script).toContain("exited_after_preflight");
    expect(packed.script).toContain("$p.Kill()");
    expect(packed.script.indexOf("none_handle_start_changed"))
      .toBeLessThan(packed.script.indexOf("$p.Kill()"));
    expect(packed.script.indexOf("E preflight observed"))
      .toBeLessThan(packed.script.indexOf("$p.Kill()"));
    expect(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.emptyStdin).toBe(true);
    expect(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.maximumRemoteAttempts).toBe(1);
  });

  test("compares handle and CIM start times at exact CIM microsecond precision", () => {
    const cimTicks = 638919251202848080n;
    expect(normalizeWindowsUtcTicksToCimPrecision(cimTicks)).toBe(cimTicks);
    expect(normalizeWindowsUtcTicksToCimPrecision(cimTicks + 9n)).toBe(cimTicks);
    expect(normalizeWindowsUtcTicksToCimPrecision(cimTicks + 10n)).toBe(cimTicks + 10n);
    expect(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.windowsCimTicksPerMicrosecond).toBe(10);
  });

  test("parses .NET UTC round-trip timestamps losslessly across Gregorian boundaries", () => {
    expect(parseDotNetUtcIsoToTicks("0001-01-01T00:00:00.0000000Z")).toBe(0n);
    expect(parseDotNetUtcIsoToTicks("0001-01-01T00:00:00.0000001Z")).toBe(1n);
    expect(parseDotNetUtcIsoToTicks("2000-02-29T00:00:00.0000000Z")
      - parseDotNetUtcIsoToTicks("2000-02-28T00:00:00.0000000Z")).toBe(864_000_000_000n);
    expect(parseDotNetUtcIsoToTicks("9999-12-31T23:59:59.9999999Z"))
      .toBe(3_155_378_975_999_999_999n);
    for (const invalid of [
      "0000-01-01T00:00:00.0000000Z",
      "10000-01-01T00:00:00.0000000Z",
      "1900-02-29T00:00:00.0000000Z",
      "2000-02-30T00:00:00.0000000Z",
      "2026-08-28T24:00:00.0000000Z",
      "2026-08-28T00:60:00.0000000Z",
      "2026-08-28T00:00:60.0000000Z",
      "2026-08-28T00:00:00.0000000+00:00",
      "2026-08-28T00:00:00.00000000Z",
    ]) expect(() => parseDotNetUtcIsoToTicks(invalid)).toThrow(RangeError);
    expect(() => normalizeWindowsUtcTicksToCimPrecision(-1n)).toThrow(RangeError);
    expect(() => normalizeWindowsUtcTicksToCimPrecision(3_155_378_976_000_000_000n))
      .toThrow(RangeError);
  });

  test("rejects target timestamps that claim finer precision than CIM supplies", () => {
    const residue = residueRecord();
    const marker = (residue.markers as Array<Record<string, unknown>>)[3]!;
    const payload = marker.payload as Record<string, unknown>;
    const processes = payload.processes as Array<Record<string, unknown>>;
    const target = processes.find((fact) => fact.pid === 67504)!;
    target.created = "2026-08-28T04:58:40.2848081Z";
    expect(() => deriveResidueCleanupPlan(config(), admission(), residue, stagedRecord()))
      .toThrow(ResidueCleanupFailure);
  });

  test("derives a separately confirmed plan-bound read-only handle diagnostic", () => {
    const fixture = diagnosticFixture();
    expect(validateHandleStartDiagnosticConfig(fixture.config)).toEqual(fixture.config);
    const frozenCleanupPlan = JSON.parse(readFileSync(fixture.config.cleanup_plan_path, "utf8"));
    expect(fixture.plan.cleanup_plan_sha256).toBe(frozenCleanupPlan.plan_sha256);
    expect(fixture.plan.cleanup_plan_file_sha256).toBe(fixture.config.cleanup_plan_sha256);
    expect(fixture.plan.admission_config_sha256).toBe(fixture.config.admission_config_sha256);
    expect(fixture.plan.consumed_evidence_root).toBe(fixture.config.consumed_evidence_root);
    expect(fixture.plan.consumed_evidence_root_device).toBeGreaterThan(0);
    expect(fixture.plan.consumed_evidence_root_inode).toBeGreaterThan(0);
    expect(fixture.plan.target_count).toBe(16);
    expect(fixture.plan.effect).toMatchObject({
      operation: "observe_handle_start_ticks_read_only",
      ordinal_one_only_handle_open: true,
      maximum_remote_attempts: 1,
      process_termination_permitted: false,
      file_mutation_permitted: false,
      vivado_permitted: false,
      hardware_action_permitted: false,
    });
    expect(fixture.plan.confirmation).toBe(handleStartDiagnosticConfirmation(
      fixture.plan.diagnostic_id,
      fixture.plan.plan_sha256,
      16,
    ));
    expect(() => assertHandleStartDiagnosticConfirmation(fixture.plan, fixture.plan.confirmation))
      .not.toThrow();
    expect(() => assertHandleStartDiagnosticConfirmation(fixture.plan, fixture.plan.confirmation + "x"))
      .toThrow(HandleStartDiagnosticFailure);
    expect(() => validateHandleStartDiagnosticConfig({ ...fixture.config, allow_kill: false }))
      .toThrow(HandleStartDiagnosticFailure);
    try {
      validateHandleStartDiagnosticConfig({ ...fixture.config, allow_kill: false });
    } catch (error) {
      expect(error).toBeInstanceOf(HandleStartDiagnosticFailure);
      expect((error as HandleStartDiagnosticFailure).detail).toMatchObject({
        schema: "synthia-m4f-direct-handle-start-diagnostic-failure.v1",
        code: "M4F_DIRECT_HANDLE_START_DIAGNOSTIC_CONFIG_INVALID",
        retry_permitted: false,
      });
    }
    for (const retiredId of M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.permanentlyRetiredCeremonyIds) {
      expect(() => validateHandleStartDiagnosticConfig({
        ...fixture.config,
        diagnostic_id: retiredId,
      })).toThrow(HandleStartDiagnosticFailure);
    }
    expect(() => planHandleStartDiagnostic({
      ...fixture.config,
      diagnostic_id: frozenCleanupPlan.ceremony_id,
    }, fixture.dependencies)).toThrow(HandleStartDiagnosticFailure);
  });

  test("handle-start diagnostic script exposes required ticks and no mutation capability", () => {
    const fixture = diagnosticFixture();
    const script = buildHandleStartDiagnosticRemoteScript(fixture.plan);
    const packed = buildHandleStartDiagnosticRemoteCommand(fixture.plan);
    expect(packed.command.length).toBeLessThanOrEqual(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.remoteCommandLimit);
    expect(script).toContain("ordinal_one_expected");
    expect(script).toContain("creation_utc_ticks");
    expect(script).toContain("start_time_utc_ticks");
    expect(script).toContain("tick_delta");
    expect(script).toContain("normalized_equal");
    expect(script).toContain("$by[13644]");
    expect(script).toContain('Name-ieq"sshd.exe"');
    expect(script.match(/GetProcessById/gu)).toHaveLength(1);
    const helperNames = [...script.matchAll(/\bfunction\s+([A-Za-z][A-Za-z0-9-]*)\s*\(/gu)]
      .map((match) => match[1]!.toLowerCase());
    const powerShell51Aliases = new Set([
      "%", "?", "ac", "asnp", "cat", "cd", "chdir", "clc", "clear", "clhy", "cli",
      "clp", "cls", "clv", "compare", "copy", "cp", "cpi", "cpp", "curl", "del", "diff",
      "dir", "ebp", "echo", "epal", "epcsv", "epsn", "erase", "etsn", "exsn", "fc", "fl",
      "foreach", "ft", "fw", "gal", "gbp", "gc", "gci", "gcm", "gcs", "gdr", "ghy", "gi",
      "gin", "gjb", "gl", "gm", "gmo", "gp", "gps", "group", "gsn", "gsnp", "gsv", "gu",
      "gv", "gwmi", "h", "history", "icm", "iex", "ihy", "ii", "ipal", "ipcsv", "ipmo",
      "ipsn", "irm", "ise", "iwmi", "iwr", "kill", "lp", "ls", "man", "md", "measure",
      "mi", "mount", "move", "mp", "mv", "nal", "ndr", "ni", "nmo", "npssc", "nsn", "nv",
      "ogv", "oh", "popd", "ps", "pushd", "pwd", "r", "rbp", "rcjb", "rcsn", "rd", "rdr",
      "ren", "ri", "rjb", "rm", "rmdir", "rmo", "rni", "rnp", "rp", "rsn", "rsnp", "rujb",
      "rv", "rvpa", "rwmi", "sajb", "sal", "saps", "sasv", "sbp", "sc", "select", "set",
      "shcm", "si", "sl", "sleep", "sls", "sort", "sp", "spjb", "spps", "spsv", "start",
      "stz", "sujb", "sv", "swmi", "tee", "trcm", "type", "wget", "where", "wjb", "write",
    ]);
    const powerShell51Cmdlets = new Set([
      "get-history", "invoke-history", "get-command", "get-process", "stop-process",
      "get-ciminstance", "convertfrom-json", "convertto-json", "write-output",
    ]);
    const automaticVariables = new Set([
      "args", "error", "event", "eventargs", "eventsubscriber", "executioncontext", "false",
      "foreach", "home", "host", "input", "lastexitcode", "matches", "myinvocation", "nestedpromptlevel",
      "null", "pid", "profile", "psboundparameters", "pscmdlet", "pscommandpath", "psculture",
      "psdebugcontext", "pshome", "psitem", "psscriptroot", "psuiculture", "psversiontable", "pwd",
      "sender", "shellid", "stacktrace", "this", "true",
    ]);
    expect(helperNames).toEqual(["invoke-synthiam4fhandlestartdiagnosticsha256exact"]);
    expect(helperNames.every((name) => !powerShell51Aliases.has(name))).toBe(true);
    expect(helperNames.every((name) => !powerShell51Cmdlets.has(name))).toBe(true);
    expect(helperNames.every((name) => !automaticVariables.has(name))).toBe(true);
    expect(script).not.toMatch(/\bfunction\s+H\b|\bH\s+\(\[string\]\$x\.CommandLine\)/u);
    expect(script).toContain(
      "Invoke-SynthiaM4fHandleStartDiagnosticSha256Exact ([string]$x.CommandLine)",
    );
    expect(script).not.toMatch(/\.Kill\s*\(|Stop-Process|Start-Process|Set-Content|Out-File|New-Item|Remove-|Set-Acl|Get-WinEvent|Win32_OperatingSystem|Get-NetTCPConnection|hw_server|open_hw|program_hw|write_cfgmem/iu);
    expect(script).not.toMatch(/\bvivado(?:\.bat|\.exe)\b/iu);
    expect(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.handleStartDiagnosticMaximumRemoteAttempts).toBe(1);
    expect(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.handleStartDiagnosticProcessTerminationPermitted)
      .toBe(false);
    expect(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.handleStartDiagnosticFileMutationPermitted).toBe(false);
  });

  test("permanently retires the PowerShell-alias-collision production diagnostic ID", () => {
    const fixture = diagnosticFixture();
    const retiredId = "m4f-direct-handle-start-prod-20260828-01";
    expect(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.permanentlyRetiredHandleStartDiagnosticIds)
      .toContain(retiredId);
    const retired = { ...fixture.config, diagnostic_id: retiredId };
    expect(() => validateHandleStartDiagnosticConfig(retired))
      .toThrow(HandleStartDiagnosticFailure);
    expect(() => planHandleStartDiagnostic(retired, fixture.dependencies))
      .toThrow(HandleStartDiagnosticFailure);
    try {
      validateHandleStartDiagnosticConfig(retired);
    } catch (error) {
      expect((error as HandleStartDiagnosticFailure).detail).toMatchObject({
        schema: "synthia-m4f-direct-handle-start-diagnostic-failure.v1",
        code: "M4F_DIRECT_HANDLE_START_DIAGNOSTIC_ID_RESERVED",
        diagnostic_id: retiredId,
        reason: "permanently_retired_diagnostic_id",
        remote_effect_state: "not_started",
        retry_permitted: false,
      });
    }
  });

  test("validates exact diagnostic target binding and lossless tick strings", () => {
    const fixture = diagnosticFixture();
    const observation = handleStartObservation(fixture.plan);
    expect(validHandleStartDiagnosticOutput(observation, fixture.plan)).toBe(true);
    const changedToken = structuredClone(observation);
    ((changedToken.ordinal_one_expected as Record<string, unknown>).start_token) = "0".repeat(64);
    expect(validHandleStartDiagnosticOutput(changedToken, fixture.plan)).toBe(false);
    const numericTicks = structuredClone(observation);
    const ordinalOne = numericTicks.ordinal_one as Record<string, unknown>;
    const handle = ordinalOne.handle as Record<string, unknown>;
    handle.start_time_utc_ticks = 638919251202848087;
    expect(validHandleStartDiagnosticOutput(numericTicks, fixture.plan)).toBe(false);

    const mutations: Array<(value: Record<string, any>) => void> = [
      (value) => { value.ordinal_one.handle.id += 1; },
      (value) => { value.ordinal_one.handle.has_exited = true; },
      (value) => { value.ordinal_one.handle = { available: false, error_type: "process_unavailable" }; },
      (value) => { value.ordinal_one.handle.expected_cim_utc_ticks = "1"; },
      (value) => { value.ordinal_one.cim.creation_utc_ticks = "1"; value.targets[0].creation_utc_ticks = "1"; },
      (value) => { value.ordinal_one.handle.start_time_utc = value.ordinal_one_expected.creation_utc; },
      (value) => { value.ordinal_one.handle.start_time_utc_ticks = "1"; },
      (value) => { value.ordinal_one.handle.tick_delta = "8"; },
      (value) => { value.ordinal_one.handle.normalized_handle_utc_ticks = "1"; },
      (value) => { value.ordinal_one.handle.normalized_cim_utc_ticks = "1"; },
      (value) => { value.ordinal_one.handle.normalized_equal = false; },
      (value) => { value.ordinal_one.cim.core_match = false; value.targets[0].core_match = false; },
      (value) => { value.ordinal_one.handle.start_time_utc_ticks = "-1"; },
      (value) => { value.ordinal_one.handle.expected_cim_utc_ticks = "3155378976000000000"; },
    ];
    for (const mutate of mutations) {
      const contradictory = structuredClone(observation) as Record<string, any>;
      mutate(contradictory);
      expect(validHandleStartDiagnosticOutput(contradictory, fixture.plan)).toBe(false);
    }
  });

  test("executes one read-only diagnostic attempt into a new immutable evidence directory", () => {
    const fixture = diagnosticFixture();
    const record = executeHandleStartDiagnostic(
      fixture.config,
      fixture.plan.confirmation,
      fixture.evidenceDirectory,
      fixture.dependencies,
    );
    expect(record.status).toBe("observed");
    expect(record.attempt).toBe(1);
    expect(record.retry_permitted).toBe(false);
    expect(record.process_termination_performed).toBe(false);
    expect(record.file_mutation_performed).toBe(false);
    expect(record.vivado_action_performed).toBe(false);
    expect(record.hardware_action_performed).toBe(false);
    expect(fixture.counts).toEqual({ effective: 1, remote: 1 });
    expect(JSON.parse(readFileSync(join(fixture.evidenceDirectory, "diagnostic-record.json"), "utf8")))
      .toMatchObject({ status: "observed", retry_permitted: false });
    expect(() => executeHandleStartDiagnostic(
      fixture.config,
      fixture.plan.confirmation,
      fixture.evidenceDirectory,
      fixture.dependencies,
    )).toThrow(HandleStartDiagnosticFailure);
    expect(fixture.counts).toEqual({ effective: 1, remote: 1 });
    expect(() => planHandleStartDiagnostic(fixture.config, fixture.dependencies))
      .toThrow(HandleStartDiagnosticFailure);
  });

  test("binds one diagnostic ID to one deterministic consumed-evidence path", () => {
    const fixture = diagnosticFixture();
    const alternate = fixture.evidenceDirectory + "-alternate";
    expect(() => executeHandleStartDiagnostic(
      fixture.config,
      fixture.plan.confirmation,
      alternate,
      fixture.dependencies,
    )).toThrow(HandleStartDiagnosticFailure);
    expect(fixture.counts).toEqual({ effective: 0, remote: 0 });
    const record = executeHandleStartDiagnostic(
      fixture.config,
      fixture.plan.confirmation,
      fixture.evidenceDirectory,
      fixture.dependencies,
    );
    expect(record.status).toBe("observed");
    expect(fixture.counts).toEqual({ effective: 1, remote: 1 });
    try {
      executeHandleStartDiagnostic(
        fixture.config,
        fixture.plan.confirmation,
        alternate,
        fixture.dependencies,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(HandleStartDiagnosticFailure);
      expect((error as HandleStartDiagnosticFailure).detail).toMatchObject({
        schema: "synthia-m4f-direct-handle-start-diagnostic-failure.v1",
        code: "M4F_DIRECT_HANDLE_START_DIAGNOSTIC_ID_CONSUMED",
        diagnostic_id: fixture.config.diagnostic_id,
        retry_permitted: false,
      });
    }
    expect(fixture.counts).toEqual({ effective: 1, remote: 1 });
  });

  test("rejects an untrusted consumed-evidence root before any network attempt", () => {
    const fixture = diagnosticFixture();
    chmodSync(fixture.config.consumed_evidence_root, 0o755);
    expect(() => planHandleStartDiagnostic(fixture.config, fixture.dependencies))
      .toThrow(HandleStartDiagnosticFailure);
    expect(() => executeHandleStartDiagnostic(
      fixture.config,
      fixture.plan.confirmation,
      fixture.evidenceDirectory,
      fixture.dependencies,
    )).toThrow(HandleStartDiagnosticFailure);
    expect(fixture.counts).toEqual({ effective: 0, remote: 0 });
  });

  test("fails before the remote diagnostic if a bound source drifts", () => {
    const fixture = diagnosticFixture();
    const source = fixture.dependencies.sourceBytes();
    let reads = 0;
    const dependencies: Parameters<typeof executeHandleStartDiagnostic>[3] = {
      ...fixture.dependencies,
      sourceBytes() {
        reads += 1;
        return reads >= 2 ? Buffer.from("changed-diagnostic-source") : source;
      },
    };
    try {
      executeHandleStartDiagnostic(
        fixture.config,
        fixture.plan.confirmation,
        fixture.evidenceDirectory,
        dependencies,
      );
      throw new Error("expected diagnostic source drift failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HandleStartDiagnosticFailure);
      expect((error as HandleStartDiagnosticFailure).detail).toMatchObject({
        schema: "synthia-m4f-direct-handle-start-diagnostic-failure.v1",
        code: "M4F_DIRECT_HANDLE_START_DIAGNOSTIC_SOURCE_MISMATCH",
        remote_effect_state: "not_started",
        retry_permitted: false,
      });
    }
    expect(fixture.counts).toEqual({ effective: 1, remote: 0 });
    expect(JSON.parse(readFileSync(join(fixture.evidenceDirectory, "diagnostic-failure.json"), "utf8")))
      .toMatchObject({
        schema: "synthia-m4f-direct-handle-start-diagnostic-failure.v1",
        code: "M4F_DIRECT_HANDLE_START_DIAGNOSTIC_SOURCE_MISMATCH",
        retry_permitted: false,
      });
    expect(() => planHandleStartDiagnostic(fixture.config, fixture.dependencies))
      .toThrow(HandleStartDiagnosticFailure);
  });

  test("never upgrades malformed diagnostic output to observed", () => {
    const fixture = diagnosticFixture();
    const dependencies: Parameters<typeof executeHandleStartDiagnostic>[3] = {
      ...fixture.dependencies,
      spawn(executable, args, stdin, timeoutMs) {
        if (args[0] === "-G") return fixture.dependencies.spawn(executable, args, stdin, timeoutMs);
        fixture.counts.remote += 1;
        return {
          status: 0,
          signal: null,
          errorCode: null,
          stdout: Buffer.from("{}\n"),
          stderr: Buffer.alloc(0),
        };
      },
    };
    const record = executeHandleStartDiagnostic(
      fixture.config,
      fixture.plan.confirmation,
      fixture.evidenceDirectory,
      dependencies,
    );
    expect(record.status).toBe("unknown");
    expect(record.observation).toBeNull();
    expect(record.process_termination_performed).toBe(false);
    expect(record.retry_permitted).toBe(false);
    expect(fixture.counts).toEqual({ effective: 1, remote: 1 });
  });

  test("never marks unavailable, exited, mismatched, or unequal handle evidence observed", () => {
    const mutations: Array<(value: Record<string, any>) => void> = [
      (value) => { value.ordinal_one.handle = { available: false, error_type: "process_unavailable" }; },
      (value) => { value.ordinal_one.handle.has_exited = true; },
      (value) => { value.ordinal_one.cim.core_match = false; value.targets[0].core_match = false; },
      (value) => {
        const expected = BigInt(value.ordinal_one.handle.expected_cim_utc_ticks);
        value.ordinal_one.handle.start_time_utc = value.ordinal_one_expected.creation_utc
          .replace(/8080Z$/u, "8090Z");
        value.ordinal_one.handle.start_time_utc_ticks = String(expected + 10n);
        value.ordinal_one.handle.tick_delta = "10";
        value.ordinal_one.handle.normalized_handle_utc_ticks = String(expected + 10n);
        value.ordinal_one.handle.normalized_equal = false;
      },
    ];
    for (const mutate of mutations) {
      const fixture = diagnosticFixture();
      const dependencies: Parameters<typeof executeHandleStartDiagnostic>[3] = {
        ...fixture.dependencies,
        spawn(executable, args, stdin, timeoutMs) {
          if (args[0] === "-G") return fixture.dependencies.spawn(executable, args, stdin, timeoutMs);
          fixture.counts.remote += 1;
          const observation = handleStartObservation(fixture.plan) as Record<string, any>;
          mutate(observation);
          return {
            status: 0,
            signal: null,
            errorCode: null,
            stdout: Buffer.from(JSON.stringify(observation) + "\n"),
            stderr: Buffer.alloc(0),
          };
        },
      };
      const record = executeHandleStartDiagnostic(
        fixture.config,
        fixture.plan.confirmation,
        fixture.evidenceDirectory,
        dependencies,
      );
      expect(record.status).toBe("unknown");
      expect(record.observation).toBeNull();
      expect(record.retry_permitted).toBe(false);
    }
  });

  test("emits PowerShell 5.1 foreach grammar with a delimited in keyword", () => {
    const script = buildResidueCleanupRemoteScript(plan());
    const loops = script.match(/foreach\([^\r\n]+/gu) ?? [];
    expect(loops).toHaveLength(3);
    expect(loops.every((loop) => loop.includes(" in $c.t)"))).toBe(true);
    expect(script).not.toContain(" in$c.t");
  });

  test("accepts only a complete ordered output bound to every start token", () => {
    const value = plan();
    const markers = successMarkers(value);
    expect(validCleanupOutput(markers, value)).toBe(true);
    const mutated = structuredClone(markers);
    mutated[3]!.payload.start_token = "0".repeat(64);
    expect(validCleanupOutput(mutated, value)).toBe(false);
    const reordered = structuredClone(markers);
    [reordered[3], reordered[4]] = [reordered[4]!, reordered[3]!];
    expect(validCleanupOutput(reordered, value)).toBe(false);
  });

  test("accepts a preflight-bound conhost natural exit without calling it a kill", () => {
    const value = plan();
    const markers = successMarkers(value);
    const target = value.targets.find((candidate) => candidate.name === "conhost.exe")!;
    const targetMarker = markers[3 + target.ordinal - 1]!;
    targetMarker.payload.effect = "exited_after_preflight";
    const postflight = markers.at(-3)!.payload;
    postflight.kill_performed_pids = value.targets
      .filter((candidate) => candidate.pid !== target.pid).map((candidate) => candidate.pid);
    postflight.already_exited_pids = [target.pid];
    markers.at(-1)!.payload.kill_performed_count = 15;
    markers.at(-1)!.payload.already_exited_count = 1;
    expect(validCleanupOutput(markers, value)).toBe(true);
    const effects = classifyPartialCleanupEffects(markers, value);
    expect(effects.kill_performed_pids).not.toContain(target.pid);
    expect(effects.already_exited_pids).toEqual([target.pid]);
    expect(effects.resolved_target_pids).toHaveLength(16);
  });

  test("keeps complete NDJSON markers and separately hashes a truncated tail", () => {
    const value = plan();
    const markers = successMarkers(value);
    const complete = markers.map((item) => JSON.stringify(item)).join("\n") + "\n";
    const fragment = '{"phase":"target","status":"observed"';
    const raw = Buffer.from(complete + fragment);
    expect(parseCleanupMarkers(raw)?.length).toBe(22);
    const parsed = parseCleanupMarkerPrefix(raw);
    expect(parsed.markers).toEqual(markers);
    expect(parsed.trailing_fragment_length).toBe(Buffer.byteLength(fragment));
    expect(parsed.stdout_truncated_line).toBe(true);
    expect(parsed.trailing_fragment_sha256).toHaveLength(64);
    const bad = Buffer.from(JSON.stringify({ ...markers[0], extra: true }) + "\n");
    expect(parseCleanupMarkers(bad)).toBeNull();
  });

  test("retains completed target evidence before timeout/SIGKILL truncation", () => {
    const value = plan();
    const prefix = successMarkers(value).slice(0, 4);
    const raw = Buffer.from(prefix.map((item) => JSON.stringify(item)).join("\n")
      + "\n" + '{"phase":"target"');
    const parsed = parseCleanupMarkerPrefix(raw);
    expect(parsed.markers).toEqual(prefix);
    expect(parsed.stdout_truncated_line).toBe(true);
    const effects = classifyPartialCleanupEffects(parsed.markers!, value);
    expect(effects.attribution_valid).toBe(true);
    expect(effects.kill_performed_pids).toEqual([value.targets[0]!.pid]);
    expect(effects.resolved_target_pids).toEqual([value.targets[0]!.pid]);
  });

  test("attributes partial effects only in exact plan order with PID, token, and effect binding", () => {
    const value = plan();
    const validPrefix = successMarkers(value).slice(0, 5);
    expect(classifyPartialCleanupEffects(validPrefix, value).kill_performed_pids)
      .toEqual(value.targets.slice(0, 2).map((target) => target.pid));
    for (const mutate of [
      (markers: CleanupMarker[]) => { markers[4]!.payload.ordinal = 99; },
      (markers: CleanupMarker[]) => { markers[4]!.payload.pid = 99; },
      (markers: CleanupMarker[]) => { markers[4]!.payload.start_token = "0".repeat(64); },
      (markers: CleanupMarker[]) => { markers[4]!.payload.effect = "kill_performed"; },
      (markers: CleanupMarker[]) => { markers[4] = structuredClone(markers[3]!); },
    ]) {
      const changed = structuredClone(validPrefix);
      mutate(changed);
      expect(classifyPartialCleanupEffects(changed, value)).toMatchObject({
        attribution_valid: false,
        kill_performed_pids: [],
        resolved_target_pids: [],
      });
    }
  });

  test("keeps the first proven kill when the second exact target fails closed", () => {
    const value = plan();
    const markers = successMarkers(value).slice(0, 4);
    markers.push({
      phase: "target",
      status: "unknown",
      observed_at_utc: OBSERVED_AT,
      payload: {
        ordinal: value.targets[1]!.ordinal,
        pid: value.targets[1]!.pid,
        effect: "none_token_changed",
      },
    });
    const effects = classifyPartialCleanupEffects(markers, value);
    expect(effects.attribution_valid).toBe(true);
    expect(effects.kill_performed_pids).toEqual([value.targets[0]!.pid]);
    expect(effects.resolved_target_pids).toEqual([value.targets[0]!.pid]);
  });

  test("records partial-or-unknown after one kill and a second-target handle drift", () => {
    const scenario = driftFixture("none");
    const record = executeResidueCleanup(
      scenario.config,
      scenario.confirmation,
      scenario.evidenceDirectory,
      scenario.dependencies,
    );
    expect(record.status).toBe("unknown");
    expect(record.process_termination_state).toBe("unknown");
    expect(record.kill_performed_pids).toHaveLength(1);
    expect(record.already_exited_pids).toEqual([]);
    expect(record.resolved_target_pids).toEqual(record.kill_performed_pids);
    expect(record.retry_permitted).toBe(false);
  });

  test("post-attempt source, evidence, and transport drift stay partial-or-unknown", () => {
    for (const kind of ["source", "evidence", "transport"] as const) {
      const scenario = driftFixture(kind);
      expect(() => executeResidueCleanup(
        scenario.config,
        scenario.confirmation,
        scenario.evidenceDirectory,
        scenario.dependencies,
      )).toThrow();
      const failure = JSON.parse(readFileSync(
        join(scenario.evidenceDirectory, "cleanup-failure.json"),
        "utf8",
      ));
      expect(failure.remote_effect_state).toBe("partial_or_unknown");
      expect(failure.remote_process).not.toBeNull();
      expect(failure.markers).toHaveLength(4);
      expect(failure.effect_attribution_valid).toBe(true);
      expect(failure.kill_performed_pids).toHaveLength(1);
      expect(failure.process_termination_state).toBe("unknown");
    }
  });

  test("rejects residue evidence with marker, identity, process, or completion drift", () => {
    for (const mutate of [
      (record: Record<string, unknown>) => {
        (record.markers as Array<Record<string, unknown>>)[0]!.ordinal = 2;
      },
      (record: Record<string, unknown>) => {
        (record.markers as Array<Record<string, unknown>>)[2]!.status = "unknown";
      },
      (record: Record<string, unknown>) => {
        const payload = (record.markers as Array<Record<string, unknown>>)[5]!.payload as Record<string, unknown>;
        payload.identity_sid = "S-1-5-18";
      },
      (record: Record<string, unknown>) => {
        const payload = (record.markers as Array<Record<string, unknown>>)[6]!.payload as Record<string, unknown>;
        payload.identity_name = "desktop-dvffb09\\other";
      },
      (record: Record<string, unknown>) => {
        ((record.process as Record<string, unknown>).exit_status) = 1;
      },
      (record: Record<string, unknown>) => {
        ((record.process as Record<string, unknown>).stderr_length) = 1;
      },
      (record: Record<string, unknown>) => {
        const payload = (record.markers as Array<Record<string, unknown>>)[7]!.payload as Record<string, unknown>;
        payload.complete = false;
      },
    ]) {
      const residue = residueRecord();
      mutate(residue);
      expect(() => deriveResidueCleanupPlan(config(), admission(), residue, stagedRecord()))
        .toThrow(ResidueCleanupFailure);
    }
  });

  test("rejects staged evidence when fixed order or timeout semantics drift", () => {
    for (const mutate of [
      (record: Record<string, unknown>) => {
        const stages = record.stage_records as Array<Record<string, unknown>>;
        [stages[1], stages[2]] = [stages[2]!, stages[1]!];
      },
      (record: Record<string, unknown>) => {
        const stage = (record.stage_records as Array<Record<string, unknown>>)[1]!;
        (stage.process as Record<string, unknown>).signal = null;
      },
      (record: Record<string, unknown>) => {
        const stage = (record.stage_records as Array<Record<string, unknown>>)[8]!;
        stage.status = "observed";
      },
    ]) {
      const staged = stagedRecord();
      mutate(staged);
      expect(() => deriveResidueCleanupPlan(config(), admission(), residueRecord(), staged))
        .toThrow(ResidueCleanupFailure);
    }
  });

  test("rejects config expansion and keeps mutation capabilities disabled", () => {
    expect(validateResidueCleanupConfig(config())).toEqual(config());
    expect(() => validateResidueCleanupConfig({ ...config(), allow_sshd: true }))
      .toThrow(ResidueCleanupFailure);
    expect(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.serviceMutationPermitted).toBe(false);
    expect(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.fileMutationPermitted).toBe(false);
    expect(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.vivadoPermitted).toBe(false);
    expect(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.hardwareActionPermitted).toBe(false);
  });

  test("requires v2 execution and binds the successful diagnostic raw bytes and semantics", () => {
    const legacy = driftFixture("none");
    const legacyConfig: M4fDirectResidueCleanupConfigV1 = {
      ...legacy.config,
      schema: "synthia-m4f-direct-residue-cleanup-config.v1",
    } as M4fDirectResidueCleanupConfigV1;
    delete (legacyConfig as Record<string, unknown>).handle_start_diagnostic_record_path;
    delete (legacyConfig as Record<string, unknown>).handle_start_diagnostic_record_sha256;
    expect(() => executeResidueCleanup(
      legacyConfig,
      legacy.confirmation,
      legacy.evidenceDirectory,
      legacy.dependencies,
    )).toThrow(ResidueCleanupFailure);

    const fixture = driftFixture("none");
    const first = planResidueCleanup(fixture.config, fixture.dependencies);
    expect(first.schema).toBe("synthia-m4f-direct-residue-cleanup-plan.v2");
    if (first.schema !== "synthia-m4f-direct-residue-cleanup-plan.v2"
      || fixture.config.schema !== "synthia-m4f-direct-residue-cleanup-config.v2") {
      throw new Error("v2 plan expected");
    }
    expect(first.handle_start_diagnostic).toMatchObject({
      record_path: fixture.config.handle_start_diagnostic_record_path,
      record_sha256: fixture.config.handle_start_diagnostic_record_sha256,
      record_file_fact: boundFileFact(fixture.config.handle_start_diagnostic_record_path),
      pid_13644_exists: true,
      process_termination_performed: false,
      file_mutation_performed: false,
      vivado_action_performed: false,
      hardware_action_performed: false,
    });
    expect(first.handle_start_diagnostic.cleanup_semantic_sha256).toHaveLength(64);
    expect(first.handle_start_diagnostic.target_core_sha256).toHaveLength(64);
    expect(first.handle_start_diagnostic.transport_inputs_sha256).toHaveLength(64);
    expect(first.handle_start_diagnostic.bound_inputs_sha256).toHaveLength(64);
    expect(first.handle_start_diagnostic.ordinal_one.floor_10_ticks_equal).toBe(true);
    const oldHash = first.plan_sha256;
    mutateBoundDiagnosticRecord(fixture, (record) => {
      record.recorded_at_utc = "2026-08-28T08:00:01.000Z";
    });
    const rebuilt = planResidueCleanup(fixture.config, fixture.dependencies);
    expect(rebuilt.plan_sha256).not.toBe(oldHash);
    expect(rebuilt.confirmation).not.toBe(first.confirmation);
  });

  test("binds record inode and timestamps so same-byte replacement cannot reuse confirmation", () => {
    for (const drift of ["inode", "timestamps"] as const) {
      const fixture = driftFixture("none");
      if (fixture.config.schema !== "synthia-m4f-direct-residue-cleanup-config.v2") {
        throw new Error("v2 fixture required");
      }
      const path = fixture.config.handle_start_diagnostic_record_path;
      const before = statSync(path);
      if (drift === "inode") {
        const replacement = path + ".replacement";
        writeFileSync(replacement, readFileSync(path));
        chmodSync(replacement, 0o600);
        renameSync(replacement, path);
        expect(statSync(path).ino).not.toBe(before.ino);
      } else {
        const changed = new Date(before.mtimeMs + 2_000);
        utimesSync(path, changed, changed);
        const after = statSync(path);
        expect(after.ino).toBe(before.ino);
        expect(after.mtimeMs).not.toBe(before.mtimeMs);
      }
      expect(sha256(readFileSync(path))).toBe(fixture.config.handle_start_diagnostic_record_sha256);
      let spawnCount = 0;
      const dependencies: Parameters<typeof executeResidueCleanup>[3] = {
        ...fixture.dependencies,
        spawn(...args) {
          spawnCount += 1;
          return fixture.dependencies.spawn(...args);
        },
      };
      try {
        executeResidueCleanup(
          fixture.config,
          fixture.confirmation,
          fixture.evidenceDirectory,
          dependencies,
        );
        throw new Error("expected bound record file fact drift rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(ResidueCleanupFailure);
        expect((error as ResidueCleanupFailure).detail).toMatchObject({
          code: "M4F_DIRECT_RESIDUE_CLEANUP_CONFIRMATION_REQUIRED",
          stage: "local_preflight",
          remote_effect_state: "not_started",
        });
      }
      expect(spawnCount).toBe(0);
    }
  });

  test("rejects replaced, unsuccessful, target-drifted, time-drifted, worker, identity, and transport evidence", () => {
    const mutations: Array<(record: Record<string, any>) => void> = [
      (record) => { record.status = "unknown"; },
      (record) => { record.attempt = 2; },
      (record) => { record.process.exit_status = 1; },
      (record) => { record.process.outcome_ambiguous = true; },
      (record) => { record.process.stderr_length = 1; },
      (record) => { record.retry_permitted = true; },
      (record) => { record.diagnostic_id = "m4f-direct-handle-start-prod-20260828-01"; },
      (record) => {
        record.cleanup_plan_sha256 = "9".repeat(64);
        record.observation.cleanup_plan_sha256 = record.cleanup_plan_sha256;
      },
      (record) => { record.observation.targets[4].pid += 1; },
      (record) => {
        const handle = record.observation.ordinal_one.handle;
        handle.start_time_utc_ticks = String(BigInt(handle.start_time_utc_ticks) + 10n);
      },
      (record) => { record.observation.protection.pid_13644.exists = false; },
      (record) => { record.observation.identity.sid = "S-1-5-18"; },
      (record) => { record.transport_inputs_after[0].sha256 = "0".repeat(64); },
      (record) => { record.bound_files_after[0].inode += 1; },
    ];
    for (const mutate of mutations) {
      const fixture = driftFixture("none");
      mutateBoundDiagnosticRecord(fixture, mutate);
      expect(() => planResidueCleanup(fixture.config, fixture.dependencies))
        .toThrow(ResidueCleanupFailure);
    }
    const replaced = driftFixture("none");
    if (replaced.config.schema !== "synthia-m4f-direct-residue-cleanup-config.v2") {
      throw new Error("v2 fixture required");
    }
    writeFileSync(replaced.config.handle_start_diagnostic_record_path, "{}");
    chmodSync(replaced.config.handle_start_diagnostic_record_path, 0o600);
    expect(() => planResidueCleanup(replaced.config, replaced.dependencies))
      .toThrow(ResidueCleanupFailure);
  });

  test("rejects every diagnostic mutation flag at record and observation level", () => {
    const fields = [
      "process_termination_performed",
      "file_mutation_performed",
      "vivado_action_performed",
      "hardware_action_performed",
    ];
    for (const location of ["record", "observation"] as const) {
      for (const field of fields) {
        const fixture = driftFixture("none");
        mutateBoundDiagnosticRecord(fixture, (record) => {
          (location === "record" ? record : record.observation)[field] = true;
        });
        expect(() => planResidueCleanup(fixture.config, fixture.dependencies))
          .toThrow(ResidueCleanupFailure);
      }
    }
  });

  test("re-reads the diagnostic and its bound inputs before and after the only remote attempt", () => {
    const before = driftFixture("diagnostic-before");
    expect(() => executeResidueCleanup(
      before.config,
      before.confirmation,
      before.evidenceDirectory,
      before.dependencies,
    )).toThrow(ResidueCleanupFailure);
    expect(JSON.parse(readFileSync(join(before.evidenceDirectory, "cleanup-failure.json"), "utf8")))
      .toMatchObject({ remote_effect_state: "not_started", process_termination_state: "not_performed" });

    const after = driftFixture("diagnostic-after");
    expect(() => executeResidueCleanup(
      after.config,
      after.confirmation,
      after.evidenceDirectory,
      after.dependencies,
    )).toThrow(ResidueCleanupFailure);
    expect(JSON.parse(readFileSync(join(after.evidenceDirectory, "cleanup-failure.json"), "utf8")))
      .toMatchObject({ remote_effect_state: "partial_or_unknown", process_termination_state: "unknown" });
  });

  test("permanently rejects every consumed unknown production ceremony ID", () => {
    const retiredIds = [
      "m4f-direct-residue-cleanup-prod-20260828-01",
      "m4f-direct-residue-cleanup-prod-20260828-02",
    ];
    const expectRetiredFailure = (operation: () => unknown, stage: string, retiredId: string) => {
      try {
        operation();
        throw new Error("expected retired ceremony ID rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(ResidueCleanupFailure);
        expect((error as ResidueCleanupFailure).detail).toMatchObject({
          code: "M4F_DIRECT_RESIDUE_CLEANUP_CEREMONY_ID_RETIRED",
          stage,
          remote_effect_state: "not_started",
          retry_permitted: false,
          ceremony_id: retiredId,
          retirement_reason: "consumed_attempt_with_unknown_result",
        });
      }
    };

    for (const retiredId of retiredIds) {
      const retiredConfig = { ...config(), ceremony_id: retiredId };
      expect(M4F_DIRECT_RESIDUE_CLEANUP_GUARDS.permanentlyRetiredCeremonyIds)
        .toContain(retiredId);
      expectRetiredFailure(() => validateResidueCleanupConfig(retiredConfig), "config", retiredId);
      expectRetiredFailure(
        () => deriveResidueCleanupPlan(retiredConfig, admission(), residueRecord(), stagedRecord()),
        "local_preflight",
        retiredId,
      );
    }
    const freshConfig = {
      ...config(),
      ceremony_id: "m4f-direct-residue-cleanup-prod-20260828-03",
    };
    expect(validateResidueCleanupConfig(freshConfig)).toEqual(freshConfig);
  });
});
