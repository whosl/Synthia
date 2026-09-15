import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  buildResidueOwnershipCommand,
  buildResidueOwnershipScript,
  deriveOwnershipObservation,
  executeResidueOwnership,
  parseOwnershipMarkers,
  recordResidueOwnership,
  residueOwnershipConfirmation,
  residueOwnershipPlan,
  type OwnershipDependencies,
  type OwnershipMarker,
  type ResidueOwnershipConfig,
} from "./scripts/m4f-direct-residue-ownership-diagnostic-14.ts";
import type { M4fDirectAdmissionConfig, RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const source = Buffer.from("candidate14-source");
const testSource = Buffer.from("candidate14-test");
const transportSource = Buffer.from("candidate14-transport");
const rawConfig = Buffer.from("candidate12-raw-config");
const canonicalConfig = Buffer.from("candidate12-canonical-config");
const candidateResult = Buffer.from("candidate12-result");
const candidateMarkers = Buffer.from("candidate12-markers");
const candidateStdout = Buffer.from("candidate12-stdout");
const candidateProcess = Buffer.from("candidate12-process");
const candidate13Config = Buffer.from("candidate13-config");
const candidate13Canonical = Buffer.from("candidate13-canonical");
const candidate13Result = Buffer.from("candidate13-result");
const candidate13Markers = Buffer.from("candidate13-markers");
const candidate13Stdout = Buffer.from("candidate13-stdout");
const candidate13Process = Buffer.from("candidate13-process");
const wrapperHash = "f70c515fd57e178fc26d1c7468098437f1f3f9cd56e56fb1e696ba72725f3e8a";
const otherHash = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881";
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
  gate_id: "candidate14-admission",
  target: {
    host: "100.96.223.49",
    port: 22,
    user: "admin",
    computer_name: "DESKTOP-DVFFB09",
    identity_name: "desktop-dvffb09\\admin",
    identity_sid: "S-1-5-21-2561815994-3878748218-1101284459-1001",
    identity_file: "/tmp/id",
    known_hosts_file: "/tmp/known",
    known_hosts_host_token: "100.96.223.49",
    host_key_fingerprint: "SHA256:jZVimVML+3vYKaaMK30EakIxOvOWiilN6FjBW/4uhfY",
    expected_effective_config_sha256: sha256(effective),
    acl_paths: ["C:\\Windows\\Temp"],
    vivado_executable: "D:\\Xilinx\\Vivado\\2021.1\\bin\\vivado.bat",
    bun_executable: "D:\\synthia-worker\\runtime\\bun.exe",
  },
};
const admissionBytes = Buffer.from(JSON.stringify(admission));

const config: ResidueOwnershipConfig = {
  schema: "synthia-m4f-direct-residue-ownership-config.v2",
  diagnostic_id: "m4f-residue-ownership-candidate14",
  admission_config_path: "/tmp/candidate14-admission.json",
  admission_config_sha256: sha256(admissionBytes),
  evidence_directory: "/tmp/candidate14-evidence",
  candidate12: {
    raw_config_path: "/tmp/candidate12.json",
    raw_config_sha256: sha256(rawConfig),
    evidence_directory: "/tmp/candidate12-evidence",
    canonical_config_sha256: sha256(canonicalConfig),
    result_sha256: sha256(candidateResult),
    markers_sha256: sha256(candidateMarkers),
    raw_stdout_sha256: sha256(candidateStdout),
    remote_process_sha256: sha256(candidateProcess),
  },
  candidate13_failure: {
    config_path: "/tmp/candidate13.json",
    config_sha256: sha256(candidate13Config),
    evidence_directory: "/tmp/candidate13-evidence",
    canonical_config_sha256: sha256(candidate13Canonical),
    result_sha256: sha256(candidate13Result),
    markers_sha256: sha256(candidate13Markers),
    raw_stdout_sha256: sha256(candidate13Stdout),
    remote_process_sha256: sha256(candidate13Process),
    failure_code: "parameter_binding_validation",
  },
  targets: [
    {
      candidate: "candidate09",
      role: "powershell",
      pid: 44768,
      name: "powershell.exe",
      creation_utc: "2026-08-28T16:25:51.0137884Z",
    },
    {
      candidate: "candidate09",
      role: "conhost",
      pid: 64484,
      name: "conhost.exe",
      creation_utc: "2026-08-28T16:25:50.9908927Z",
    },
    {
      candidate: "candidate10",
      role: "powershell",
      pid: 58908,
      name: "powershell.exe",
      creation_utc: "2026-08-28T17:12:52.5233863Z",
    },
    {
      candidate: "candidate10",
      role: "conhost",
      pid: 66316,
      name: "conhost.exe",
      creation_utc: "2026-08-28T17:12:52.5009297Z",
    },
  ],
  expected_wrapper_decoded_utf8_sha256: "21ea7ae211c4433bced41512d6b54d37b259a7700ae3dffe63147c6ab5178407",
  known_unquoted_wrapper_command_sha256: wrapperHash,
  expected_source_sha256: sha256(source),
  expected_test_source_sha256: sha256(testSource),
  expected_transport_source_sha256: sha256(transportSource),
  expected_effective_config_sha256: sha256(effective),
};

const frozen = new Map<string, Buffer>([
  [config.candidate12.raw_config_path, rawConfig],
  [config.candidate12.evidence_directory + "/diagnostic-config.canonical.json", canonicalConfig],
  [config.candidate12.evidence_directory + "/result.json", candidateResult],
  [config.candidate12.evidence_directory + "/markers.json", candidateMarkers],
  [config.candidate12.evidence_directory + "/remote-stdout.raw", candidateStdout],
  [config.candidate12.evidence_directory + "/remote-process.json", candidateProcess],
  [config.candidate13_failure.config_path, candidate13Config],
  [config.candidate13_failure.evidence_directory + "/diagnostic-config.canonical.json", candidate13Canonical],
  [config.candidate13_failure.evidence_directory + "/result.json", candidate13Result],
  [config.candidate13_failure.evidence_directory + "/markers.json", candidate13Markers],
  [config.candidate13_failure.evidence_directory + "/remote-stdout.raw", candidate13Stdout],
  [config.candidate13_failure.evidence_directory + "/remote-process.json", candidate13Process],
]);

type ProcessRow = [number, number, string, string | null, number, boolean, number | null, string | null];

function baseRows(): ProcessRow[] {
  return [
    [9001, 0, "sshd.exe", "2026-08-28T16:25:49.0000000Z", 11, true, 4, otherHash],
    [44768, 9001, "powershell.exe", config.targets[0]!.creation_utc, 11, true, 120, wrapperHash],
    [64484, 9001, "conhost.exe", config.targets[1]!.creation_utc, 11, true, 30, otherHash],
    [9002, 0, "sshd.exe", "2026-08-28T17:12:50.0000000Z", 12, true, 4, otherHash],
    [58908, 9002, "powershell.exe", config.targets[2]!.creation_utc, 12, true, 120, wrapperHash],
    [66316, 9002, "conhost.exe", config.targets[3]!.creation_utc, 12, true, 30, otherHash],
  ];
}

function marker(
  ordinal: number,
  stage: OwnershipMarker["stage"],
  phase: OwnershipMarker["phase"],
  status: OwnershipMarker["status"],
  payload?: unknown,
): string {
  const semantic = payload ?? (stage === "start"
      ? { direct_encoded_entry: true }
    : stage === "snapshot" && phase === "end"
      ? {
        cc: 1,
        n: baseRows().length,
        r: baseRows(),
        w: [
          [44768, true, true, config.expected_wrapper_decoded_utf8_sha256],
          [58908, true, true, config.expected_wrapper_decoded_utf8_sha256],
        ],
        rl: false,
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
          cleanup_derivation_performed: false,
        }
        : {});
  return JSON.stringify({
    schema: "synthia-m4f-residue-owner-marker.v2",
    diagnostic_id: config.diagnostic_id,
    ordinal,
    stage,
    phase,
    status,
    payload: status === "unknown" ? null : semantic,
    error: status === "unknown" ? {
      code: "r",
      type: "System.Management.Automation.ParameterBindingValidationException",
      error_sha256: otherHash,
    } : null,
  }) + "\n";
}

function transcript(rows = baseRows()): string {
  return marker(1, "start", "start", "observed")
    + marker(2, "snapshot", "begin", "started")
    + marker(3, "snapshot", "end", "observed", {
      cc: 1,
      n: rows.length,
      r: rows,
      w: [
        [44768, true, true, config.expected_wrapper_decoded_utf8_sha256],
        [58908, true, true, config.expected_wrapper_decoded_utf8_sha256],
      ],
      rl: false,
    })
    + marker(4, "complete", "complete", "complete");
}

function raw(stdout: string, status: number | null = 0): RawProcessResult {
  return { status, signal: null, errorCode: null, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

function dependencies(remote = raw(transcript())): {
  value: OwnershipDependencies;
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
      frozenBytes: (path) => frozen.get(path) ?? Buffer.from("missing"),
      admissionConfigBytes: () => admissionBytes,
      transportInputs: () => [],
      now: () => new Date(clock++ === 0 ? "2026-08-29T04:00:00.000Z" : "2026-08-29T04:00:01.000Z"),
    },
  };
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("M4-F Candidate-14 residue ownership diagnostic", () => {
  test("uses one full CIM snapshot in a bounded direct EncodedCommand", () => {
    const script = buildResidueOwnershipScript(config);
    const command = buildResidueOwnershipCommand(config);
    expect(script.split("\n")[0]).toMatch(/^\[Console\]::Out\.WriteLine\(.+\);\[Console\]::Out\.Flush\(\)$/u);
    expect(script.match(/Get-CimInstance Win32_Process/gu)).toHaveLength(1);
    expect(script).toContain("$all=@(Get-CimInstance Win32_Process)");
    expect(script).toContain("$p.CommandLine");
    expect(script).toContain("function Get-SynthiaHash");
    expect(script).toContain("param([AllowNull()][object]$Value)");
    expect(script).toContain("Get-SynthiaHash -Value ([string]$q)");
    expect(script).not.toMatch(/function H(?:\(|\s*\{)/u);
    expect(script).not.toMatch(/(?:^|[;(])H\s+/mu);
    expect(script).toContain("$v=$null-ne$q;$l=$null;$x=$null;if($v)");
    expect(script).toContain("code=$g;type=$t;error_sha256=$z");
    expect(script).toContain('$g+"|"+$t+"|"+$_.FullyQualifiedErrorId');
    expect(script).toContain("FromBase64String");
    expect(script).toContain("UnicodeEncoding");
    expect(script).toContain("ToBase64String");
    expect(script).toContain("FullyQualifiedErrorId");
    expect(script).not.toContain(".Exception.Message");
    expect(script).not.toContain("ScriptStackTrace");
    expect(script).not.toContain("PositionMessage");
    expect(script).not.toContain("Test-Path");
    for (const forbidden of [
      "Console]::In", "ReadToEnd", "ScriptBlock", "GZip", "New-Item", "Remove-Item",
      "Start-Process", "Stop-Process", "Set-Service", "vivado.bat", "program_hw", "open_hw",
    ]) expect(script).not.toContain(forbidden);
    expect(command).toStartWith(
      "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ",
    );
    expect(Buffer.from(command.slice(command.lastIndexOf(" ") + 1), "base64").toString("utf16le")).toBe(script);
    expect(command.length).toBeLessThanOrEqual(7000);
    expect(command.length).toBeLessThan(8191);
    expect(residueOwnershipPlan(config, admission)).toMatchObject({
      cim_snapshot_count: 1,
      attempt_count: 1,
      retry_permitted: false,
      stdin_length: 0,
      local_timeout_ms: 25000,
      local_timeout_kill_signal: "SIGKILL",
      closure_depth_limit: 8,
      closure_row_limit: 32,
      cleanup_derivation_permitted: false,
      network_attempted: false,
      lineage: "candidate14_after_candidate13_failure",
      evidence_directory: "/tmp/candidate14-evidence",
    });
  });

  test("removes the frozen predecessor's PowerShell 5.1 h/Get-History alias collision", () => {
    const candidate13VulnerableCall = "function H($s){...};$s=$p.CommandLine;...;(H $s)";
    expect(candidate13VulnerableCall).toContain("function H($s)");
    expect(candidate13VulnerableCall).toContain("(H $s)");
    expect(config.candidate13_failure.failure_code).toBe("parameter_binding_validation");
    const script = buildResidueOwnershipScript(config);
    expect(script).not.toContain("function H(");
    expect(script).not.toContain("(H $");
    expect(script.match(/Get-SynthiaHash/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  test("strictly parses exact markers and mutation declarations", () => {
    expect(parseOwnershipMarkers(Buffer.from(transcript()), config)).toHaveLength(4);
    expect(() => parseOwnershipMarkers(Buffer.from(transcript().replace(
      '"process_mutation_performed":false',
      '"process_mutation_performed":true',
    )), config)).toThrow("M4F_RESIDUE_OWNERSHIP_MARKER_INVALID");
    expect(() => parseOwnershipMarkers(Buffer.from(transcript().replace('"cc":1', '"cc":2')), config))
      .toThrow("M4F_RESIDUE_OWNERSHIP_MARKER_INVALID");
    expect(() => parseOwnershipMarkers(Buffer.from(transcript().replace(
      '"w":[[44768',
      '"w":[[7003,false,false,null],[44768',
    )), config)).toThrow("M4F_RESIDUE_OWNERSHIP_MARKER_INVALID");
    expect(() => parseOwnershipMarkers(Buffer.from(transcript().replace(
      /,\[58908,true,true,"[0-9a-f]{64}"\]/u,
      "",
    )), config)).toThrow("M4F_RESIDUE_OWNERSHIP_MARKER_INVALID");
  });

  test("accepts only fixed substage plus type and FQID hash for remote failures", () => {
    const unknown = marker(1, "start", "start", "observed")
      + marker(2, "snapshot", "begin", "started")
      + marker(3, "snapshot", "end", "unknown")
      + marker(4, "complete", "complete", "complete");
    expect(parseOwnershipMarkers(Buffer.from(unknown), config)).toHaveLength(4);
    expect(() => parseOwnershipMarkers(Buffer.from(unknown.replace(
      '"code":"r"',
      '"code":"raw_message"',
    )), config)).toThrow("M4F_RESIDUE_OWNERSHIP_MARKER_INVALID");
    expect(() => parseOwnershipMarkers(Buffer.from(unknown.replace(
      '"error_sha256":"' + otherHash + '"',
      '"error_sha256":"' + otherHash + '","message":"secret"',
    )), config)).toThrow("M4F_RESIDUE_OWNERSHIP_MARKER_INVALID");
  });

  test("projects null, empty, and normal CommandLine facts without null hashing", () => {
    const rows = baseRows();
    rows.push([7001, 0, "system.exe", "2026-08-28T15:00:00.0000000Z", 0, false, null, null]);
    rows.push([7002, 0, "empty.exe", "2026-08-28T15:00:01.0000000Z", 0, true, 0,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"]);
    expect(parseOwnershipMarkers(Buffer.from(transcript(rows)), config)).toHaveLength(4);
    const targetNull = baseRows();
    targetNull[1] = [...targetNull[1]!] as ProcessRow;
    targetNull[1]![5] = false;
    targetNull[1]![6] = null;
    targetNull[1]![7] = null;
    const observation = deriveOwnershipObservation(
      parseOwnershipMarkers(Buffer.from(transcript(targetNull)), config), config,
    )!;
    expect(observation.reasons).toContain("candidate09_powershell_command_line_unavailable");
    const forgedNull = transcript(rows).replace("false,null,null", "false,0,null");
    expect(() => parseOwnershipMarkers(Buffer.from(forgedNull), config))
      .toThrow("M4F_RESIDUE_OWNERSHIP_MARKER_INVALID");
  });

  test("derives four exact targets and bounded separate SSH trees", () => {
    const markers = parseOwnershipMarkers(Buffer.from(transcript()), config);
    const observation = deriveOwnershipObservation(markers, config)!;
    expect(observation.targets).toHaveLength(4);
    expect(observation.targets[0]).toMatchObject({
      candidate: "candidate09",
      role: "powershell",
      expected_pid: 44768,
      exists: true,
      pid: 44768,
      parent_pid: 9001,
      parent_exists: true,
      parent_name: "sshd.exe",
      session_id: 11,
      command_line_readable: true,
    });
    expect(observation.candidates[0]).toMatchObject({
      nearest_common_sshd: { pid: 9001, creation_utc: "2026-08-28T16:25:49.0000000Z" },
      same_session: true,
      pair_tree_connected: true,
      closure_overflow: false,
    });
    expect(observation.cross_candidate_connected).toBe(false);
    expect(observation.targets[0]!.classification).toBe("candidate09_10_stdin_wrapper");
    expect(observation.targets[1]!.classification).toBe("candidate_console_peer");
    expect(observation.reasons).toEqual([]);
  });

  test("selects the unique nearest common sshd when a farther common sshd also exists", () => {
    const rows = baseRows();
    rows[0] = [...rows[0]!] as ProcessRow;
    rows[0]![1] = 8999;
    rows.push([8999, 0, "sshd.exe", "2026-08-28T16:25:48.0000000Z", 11, true, 4, otherHash]);
    const observation = deriveOwnershipObservation(
      parseOwnershipMarkers(Buffer.from(transcript(rows)), config), config,
    )!;
    expect(observation.candidates[0]!.nearest_common_sshd).toEqual({
      pid: 9001,
      creation_utc: "2026-08-28T16:25:49.0000000Z",
    });
    expect(observation.candidates[0]!.pair_tree_connected).toBe(true);
    expect(observation.reasons).not.toContain("candidate09_sshd_ancestor_ambiguous");
  });

  test("rejects tied nearest common sshd ancestry as ambiguous", () => {
    const rows = baseRows().filter((row) => row[0] !== 9001);
    rows[0] = [...rows[0]!] as ProcessRow;
    rows[1] = [...rows[1]!] as ProcessRow;
    rows[0]![1] = 9101;
    rows[1]![1] = 9102;
    rows.push(
      [9101, 9102, "sshd.exe", "2026-08-28T16:25:49.0000000Z", 11, true, 4, otherHash],
      [9102, 9101, "sshd.exe", "2026-08-28T16:25:48.0000000Z", 11, true, 4, otherHash],
    );
    const observation = deriveOwnershipObservation(
      parseOwnershipMarkers(Buffer.from(transcript(rows)), config), config,
    )!;
    expect(observation.candidates[0]!.nearest_common_sshd).toBeNull();
    expect(observation.candidates[0]!.pair_tree_connected).toBe(false);
    expect(observation.reasons).toContain("candidate09_sshd_ancestor_ambiguous");
    expect(observation.reasons).toContain("candidate09_cycle");
  });

  test("requires strict wrapper proof and treats the historical raw hash as supporting only", () => {
    const fullCommandHashRebuiltLocally = "9a291f2f147b58333e0a0c7bedff94da91357054250931721363dc804431ce8a";
    expect(config.known_unquoted_wrapper_command_sha256).toBe(wrapperHash);
    expect(config.known_unquoted_wrapper_command_sha256).not.toBe(fullCommandHashRebuiltLocally);
    const forged = transcript().replace(
      `[44768,true,true,"${config.expected_wrapper_decoded_utf8_sha256}"]`,
      "[44768,true,false,null]",
    );
    const observation = deriveOwnershipObservation(parseOwnershipMarkers(Buffer.from(forged), config), config)!;
    expect(observation.targets[0]!.classification).toBe("unattributed");
    expect(observation.reasons).toContain("candidate09_wrapper_not_proven");
    expect(observation.reasons).toContain("candidate09_raw_hash_only");
  });

  test("downgrades missing, reused, missing-parent, and cross-connected targets", () => {
    const missing = baseRows().filter((row) => row[0] !== 44768);
    const missingObservation = deriveOwnershipObservation(
      parseOwnershipMarkers(Buffer.from(transcript(missing)), config), config,
    )!;
    expect(missingObservation.reasons).toContain("candidate09_powershell_missing");

    const reused = baseRows();
    reused[1] = [...reused[1]!] as ProcessRow;
    reused[1]![3] = "2026-08-29T00:00:00.0000000Z";
    expect(deriveOwnershipObservation(parseOwnershipMarkers(Buffer.from(transcript(reused)), config), config)!.reasons)
      .toContain("candidate09_powershell_pid_reused");

    const orphan = baseRows();
    orphan[1] = [...orphan[1]!] as ProcessRow;
    orphan[1]![1] = 7777;
    expect(deriveOwnershipObservation(parseOwnershipMarkers(Buffer.from(transcript(orphan)), config), config)!.reasons)
      .toContain("candidate09_powershell_parent_missing");

    const connected = baseRows();
    connected[3] = [...connected[3]!] as ProcessRow;
    connected[3]![0] = 9010;
    connected[4] = [...connected[4]!] as ProcessRow;
    connected[5] = [...connected[5]!] as ProcessRow;
    connected[4]![1] = 9001;
    connected[5]![1] = 9001;
    const cross = deriveOwnershipObservation(parseOwnershipMarkers(Buffer.from(transcript(connected)), config), config)!;
    expect(cross.cross_candidate_connected).toBe(true);
    expect(cross.reasons).toContain("cross_candidate_connected");
  });

  test("compares seven-digit process creation timestamps without losing 100ns precision", () => {
    const rows = baseRows();
    rows[0] = [...rows[0]!] as ProcessRow;
    rows[0]![3] = "2026-08-28T16:25:51.0137885Z";
    rows[1] = [...rows[1]!] as ProcessRow;
    rows[1]![3] = "2026-08-28T16:25:51.0137884Z";
    expect(Date.parse(rows[0]![3]!)).toBe(Date.parse(rows[1]![3]!));
    const observation = deriveOwnershipObservation(
      parseOwnershipMarkers(Buffer.from(transcript(rows)), config), config,
    )!;
    expect(observation.reasons).toContain("candidate09_parent_later_than_child");
  });

  test("downgrades unknown descendants and closure overflow", () => {
    const rows = baseRows();
    for (let index = 0; index < 33; index += 1) {
      rows.push([
        20_000 + index, 44768, "child.exe", "2026-08-28T16:25:52.0000000Z",
        11, true, 4, otherHash,
      ]);
    }
    const observation = deriveOwnershipObservation(parseOwnershipMarkers(Buffer.from(transcript(rows)), config), config)!;
    expect(observation.reasons).toContain("candidate09_unknown_descendant");
    expect(observation.reasons).toContain("candidate09_closure_overflow");
    expect(observation.candidates[0]!.closure.length).toBeLessThanOrEqual(32);
    expect(observation.candidates[0]!.descendants.length).toBeLessThanOrEqual(32);
  });

  test("uses empty stdin and exactly one remote attempt", () => {
    const harness = dependencies();
    const result = executeResidueOwnership(
      config,
      admission,
      residueOwnershipConfirmation(config, admission),
      harness.value,
    );
    expect(result.status).toBe("observed");
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[0]!.args[0]).toBe("-G");
    expect(harness.calls[1]!.stdin).toEqual(Buffer.alloc(0));
    expect(harness.calls[1]!.timeoutMs).toBe(25000);
    expect(harness.calls[1]!.args.filter((arg) => arg === "100.96.223.49")).toHaveLength(1);
  });

  test("non-empty trailing bytes force partial_unknown", () => {
    const harness = dependencies(raw(transcript() + "tail"));
    const result = executeResidueOwnership(
      config,
      admission,
      residueOwnershipConfirmation(config, admission),
      harness.value,
    );
    expect(result.status).toBe("partial_unknown");
    expect(result.trailing_fragment_length).toBe(4);
    expect(result.trailing_fragment_sha256).toBe(sha256("tail"));
  });

  test("freezes exclusive evidence without storing the raw command", () => {
    const parent = mkdtempSync("/tmp/synthia-candidate14-test-");
    temporaryDirectories.push(parent);
    const evidence = parent + "/evidence";
    const recordConfig: ResidueOwnershipConfig = { ...config, evidence_directory: evidence };
    const harness = dependencies();
    const confirmation = residueOwnershipConfirmation(recordConfig, admission);
    const result = recordResidueOwnership(recordConfig, confirmation, evidence, harness.value);
    expect(result.status).toBe("observed");
    expect(existsSync(evidence + "/diagnostic-config.canonical.json")).toBe(true);
    expect(existsSync(evidence + "/plan.canonical.json")).toBe(true);
    expect(existsSync(evidence + "/observation.json")).toBe(true);
    expect(JSON.parse(readFileSync(evidence + "/remote-command.json", "utf8"))).toMatchObject({
      stdin_length: 0,
      attempt_count: 1,
      raw_command_stored: false,
    });
    expect(JSON.parse(readFileSync(evidence + "/result.json", "utf8"))).toMatchObject({
      status: "observed",
      attempt_count: 1,
      retry_permitted: false,
      cleanup_derivation_permitted: false,
    });
    expect(() => recordResidueOwnership(recordConfig, confirmation, evidence, dependencies().value))
      .toThrow("M4F_RESIDUE_OWNERSHIP_EVIDENCE_INVALID");
  });
});
