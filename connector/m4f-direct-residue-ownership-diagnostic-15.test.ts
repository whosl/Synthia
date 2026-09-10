import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  buildResidueOwnership15Command,
  buildResidueOwnership15Script,
  deriveOwnership15Observation,
  executeResidueOwnership15,
  hasExactCandidate15WrapperShape,
  parseOwnership15Markers,
  residueOwnership15Confirmation,
  residueOwnership15Plan,
  validateResidueOwnership15Config,
  type Ownership15Dependencies,
  type ResidueOwnership15Config,
} from "./scripts/m4f-direct-residue-ownership-diagnostic-15.ts";
import type { M4fDirectAdmissionConfig, RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const psHash = "8666564baaf3aa762b67d0eb4b8d288ab2f2611bad85e0046dc5b07455a0b5fc";
const conhostHash = "417222c4a0ecb4d60a457ebe8e26fddf3d5406bffb16a5c59af8eeb241beca51";
const cmdHash = "5bc4c97b1fd21194056191199161af8371483e645131cf7c32a83018ae5be99e";
const decodedHash = "21ea7ae211c4433bced41512d6b54d37b259a7700ae3dffe63147c6ab5178407";
const source = Buffer.from("candidate15-source");
const testSource = Buffer.from("candidate15-test");
const transportSource = Buffer.from("candidate15-transport");
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
  gate_id: "candidate15-admission",
  target: {
    host: "100.96.223.49", port: 22, user: "admin", computer_name: "DESKTOP-DVFFB09",
    identity_name: "desktop-dvffb09\\admin",
    identity_sid: "S-1-5-21-2561815994-3878748218-1101284459-1001",
    identity_file: "/tmp/id", known_hosts_file: "/tmp/known",
    known_hosts_host_token: "100.96.223.49",
    host_key_fingerprint: "SHA256:jZVimVML+3vYKaaMK30EakIxOvOWiilN6FjBW/4uhfY",
    expected_effective_config_sha256: hash(effective), acl_paths: ["C:\\Windows\\Temp"],
    vivado_executable: "D:\\Xilinx\\Vivado\\2021.1\\bin\\vivado.bat",
    bun_executable: "D:\\synthia-worker\\runtime\\bun.exe",
  },
};
const admissionBytes = Buffer.from(JSON.stringify(admission));
const c14Names = [
  "admission-config.raw.json", "confirmation.sha256", "diagnostic-config.canonical.json", "failure.json",
  "plan.canonical.json", "remote-command.json", "remote-process.json", "remote-script.ps1",
  "remote-stderr.raw", "remote-stdout.raw", "ssh-effective-process.json", "ssh-effective-stderr.raw",
  "ssh-effective-stdout.raw", "transport-inputs-initial.json", "transport-inputs-post_remote.json",
  "transport-inputs-pre_remote.json",
] as const;

function c14Transcript(id: string): Buffer {
  const rows = [
    [0, 0, "system idle process", "2026-08-12T22:31:27.2546270Z", 0, false, null, null],
    [56576, 6100, "cmd.exe", "2026-08-28T16:25:50.9870650Z", 0, true, 1217, cmdHash],
    [64484, 56576, "conhost.exe", "2026-08-28T16:25:50.9908920Z", 0, true, 39, conhostHash],
    [44768, 56576, "powershell.exe", "2026-08-28T16:25:51.0137880Z", 0, true, 1183, psHash],
    [67048, 24260, "cmd.exe", "2026-08-28T17:12:52.4952390Z", 0, true, 1217, cmdHash],
    [66316, 67048, "conhost.exe", "2026-08-28T17:12:52.5009290Z", 0, true, 39, conhostHash],
    [58908, 67048, "powershell.exe", "2026-08-28T17:12:52.5233860Z", 0, true, 1183, psHash],
  ];
  const base = (ordinal: number, stage: string, phase: string, status: string, payload: unknown) => JSON.stringify({
    schema: "synthia-m4f-residue-owner-marker.v2", diagnostic_id: id, ordinal, stage, phase, status,
    payload, error: null,
  }) + "\n";
  return Buffer.from(base(1, "start", "start", "observed", { direct_encoded_entry: true })
    + base(2, "snapshot", "begin", "started", {})
    + base(3, "snapshot", "end", "observed", {
      cc: 1, n: rows.length, r: rows,
      w: [[44768, false, false, null], [58908, false, false, null]], rl: false,
    }) + base(4, "complete", "complete", "complete", {}));
}

interface Fixture {
  config: ResidueOwnership15Config;
  frozen: Map<string, Buffer>;
}

function fixture(): Fixture {
  const c12Path = "/tmp/candidate12.json";
  const c12Dir = "/tmp/candidate12-evidence";
  const c14Path = "/tmp/candidate14.json";
  const c14Dir = "/tmp/candidate14-evidence";
  const c14Id = "candidate14-frozen";
  const c12Raw = Buffer.from(JSON.stringify({
    candidate09_started_at_utc: "2026-08-28T16:25:50.640Z",
    candidate09_ended_at_utc: "2026-08-28T16:27:50.644Z",
    candidate10_started_at_utc: "2026-08-28T17:12:52.000Z",
    candidate10_ended_at_utc: "2026-08-28T17:13:22.999Z",
  }));
  const c14Raw = Buffer.from(JSON.stringify({ diagnostic_id: c14Id }));
  const c14Files = new Map<string, Buffer>();
  for (const name of c14Names) c14Files.set(name, Buffer.from(name));
  c14Files.set("diagnostic-config.canonical.json", Buffer.from(JSON.stringify({ diagnostic_id: c14Id })));
  c14Files.set("failure.json", Buffer.from(JSON.stringify({
    error: "M4F_RESIDUE_OWNERSHIP_MARKER_INVALID", attempt_count: 1, stdin_length: 0,
    retry_permitted: false, cleanup_derivation_permitted: false,
  })));
  c14Files.set("remote-process.json", Buffer.from(JSON.stringify({
    attempt_count: 1, exit_status: 0, signal: null, error_code: null, stdin_length: 0,
    stderr_length: 0, retry_permitted: false,
  })));
  c14Files.set("remote-stdout.raw", c14Transcript(c14Id));
  const c12Files = new Map<string, Buffer>([
    ["diagnostic-config.canonical.json", Buffer.from("c12-canonical")], ["result.json", Buffer.from("c12-result")],
    ["markers.json", Buffer.from("c12-markers")], ["remote-stdout.raw", Buffer.from("c12-stdout")],
    ["remote-process.json", Buffer.from("c12-process")],
  ]);
  const config: ResidueOwnership15Config = {
    schema: "synthia-m4f-direct-residue-ownership-config.v3",
    diagnostic_id: "m4f-direct-residue-ownership-prod-20260829-15",
    admission_config_path: "/tmp/admission.json", admission_config_sha256: hash(admissionBytes),
    evidence_directory: "/tmp/candidate15-evidence",
    candidate12: {
      raw_config_path: c12Path, raw_config_sha256: hash(c12Raw), evidence_directory: c12Dir,
      canonical_config_sha256: hash(c12Files.get("diagnostic-config.canonical.json")!),
      result_sha256: hash(c12Files.get("result.json")!), markers_sha256: hash(c12Files.get("markers.json")!),
      raw_stdout_sha256: hash(c12Files.get("remote-stdout.raw")!),
      remote_process_sha256: hash(c12Files.get("remote-process.json")!),
    },
    candidate14_failure: {
      config_path: c14Path, config_sha256: hash(c14Raw), evidence_directory: c14Dir,
      failure_code: "parser_failure", failure_error: "M4F_RESIDUE_OWNERSHIP_MARKER_INVALID", attempt_count: 1,
      files: Object.fromEntries(c14Names.map((name) => [name, hash(c14Files.get(name)!)])),
    },
    raw_command_hashes: { powershell: psHash, conhost: conhostHash, cmd: cmdHash },
    cmd_bindings: [
      { candidate: "candidate09", pid: 56576, parent_pid: 6100, name: "cmd.exe", creation_utc: "2026-08-28T16:25:50.9870650Z", session_id: 0 },
      { candidate: "candidate10", pid: 67048, parent_pid: 24260, name: "cmd.exe", creation_utc: "2026-08-28T17:12:52.4952390Z", session_id: 0 },
    ],
    attempt_windows: [
      { candidate: "candidate09", started_at_utc: "2026-08-28T16:25:50.640Z", ended_at_utc: "2026-08-28T16:27:50.644Z" },
      { candidate: "candidate10", started_at_utc: "2026-08-28T17:12:52.000Z", ended_at_utc: "2026-08-28T17:13:22.999Z" },
    ],
    targets: [
      { candidate: "candidate09", role: "powershell", pid: 44768, name: "powershell.exe", creation_utc: "2026-08-28T16:25:51.0137884Z" },
      { candidate: "candidate09", role: "conhost", pid: 64484, name: "conhost.exe", creation_utc: "2026-08-28T16:25:50.9908927Z" },
      { candidate: "candidate10", role: "powershell", pid: 58908, name: "powershell.exe", creation_utc: "2026-08-28T17:12:52.5233863Z" },
      { candidate: "candidate10", role: "conhost", pid: 66316, name: "conhost.exe", creation_utc: "2026-08-28T17:12:52.5009297Z" },
    ],
    expected_wrapper_decoded_utf8_sha256: decodedHash,
    known_double_space_wrapper_command_sha256: psHash,
    expected_source_sha256: hash(source), expected_test_source_sha256: hash(testSource),
    expected_transport_source_sha256: hash(transportSource), expected_effective_config_sha256: hash(effective),
  };
  const frozen = new Map<string, Buffer>([[c12Path, c12Raw], [c14Path, c14Raw]]);
  for (const [name, bytes] of c12Files) frozen.set(c12Dir + "/" + name, bytes);
  for (const [name, bytes] of c14Files) frozen.set(c14Dir + "/" + name, bytes);
  return { config, frozen };
}

type Detail = [number, number, string, string, number, string, number | null, string | null, boolean | null, string | null, boolean | null, boolean | null, string | null];

function snapshot(presentCmd = true): { e: number[][]; d: Detail[] } {
  const { config } = fixture();
  const micro = (value: string) => value.replace(/(\.\d{6})\dZ$/u, "$10Z");
  const details: Detail[] = config.targets.map((target) => {
    const cmd = config.cmd_bindings.find((item) => item.candidate === target.candidate)!;
    const rawHash = target.role === "powershell" ? psHash : conhostHash;
    return [target.pid, cmd.pid, target.name, micro(target.creation_utc), 0, rawHash,
      target.pid, target.name, false, target.creation_utc,
      target.role === "powershell" ? true : null, target.role === "powershell" ? true : null,
      target.role === "powershell" ? decodedHash : null];
  });
  if (presentCmd) {
    for (const cmd of config.cmd_bindings) {
      details.push([cmd.pid, cmd.parent_pid, cmd.name, cmd.creation_utc, cmd.session_id, cmdHash,
        null, null, null, null, null, null, null]);
    }
  }
  const e = details.map((row) => [row[0], row[1]]);
  if (!presentCmd) {
    // Targets retain the frozen parent PID after cmd.exe exits; no PID reuse is present.
  }
  e.push([90000, 4]);
  return { e, d: details };
}

function transcript(presentCmd = true, mutate?: (payload: Record<string, unknown>) => void): Buffer {
  const { config } = fixture();
  const shot = snapshot(presentCmd);
  const payload: Record<string, unknown> = { cc: 1, n: shot.e.length, e: shot.e, d: shot.d, rl: false };
  mutate?.(payload);
  const marker = (ordinal: number, stage: string, phase: string, status: string, value: unknown) => JSON.stringify({
    schema: "synthia-m4f-r15.v1", diagnostic_id: config.diagnostic_id, ordinal, stage, phase, status,
    payload: value, error: null,
  }) + "\n";
  return Buffer.from(marker(1, "start", "start", "observed", { de: 1 })
    + marker(2, "snapshot", "begin", "started", {})
    + marker(3, "snapshot", "end", "observed", payload)
    + marker(4, "complete", "complete", "complete", {
      rd: 15, si: 0, pm: 0, fm: 0, am: 0, sm: 0, va: 0, ha: 0, cp: 0, cd: 0,
    }));
}

function raw(stdout: Buffer, status: number | null = 0): RawProcessResult {
  return { status, signal: null, errorCode: null, stdout, stderr: Buffer.alloc(0) };
}

function deps(remote = raw(transcript())): { value: Ownership15Dependencies; calls: Array<{ args: readonly string[]; stdin: Buffer; timeout: number }> } {
  const { config, frozen } = fixture();
  const calls: Array<{ args: readonly string[]; stdin: Buffer; timeout: number }> = [];
  return {
    calls,
    value: {
      spawn(_executable, args, stdin, timeout) {
        calls.push({ args, stdin, timeout });
        return calls.length === 1 ? raw(effective) : remote;
      },
      sourceBytes: () => source, testSourceBytes: () => testSource,
      transportSourceBytes: () => transportSource,
      frozenBytes: (path) => frozen.get(path) ?? Buffer.from("missing"),
      admissionConfigBytes: () => admissionBytes, transportInputs: () => [], now: () => new Date(0),
    },
  };
}

function parsed(presentCmd = true, mutate?: (payload: Record<string, unknown>) => void) {
  const { config } = fixture();
  return parseOwnership15Markers(transcript(presentCmd, mutate), config);
}

describe("M4-F Candidate-15 residue ownership diagnostic", () => {
  test("builds one direct, empty-stdin, compact read-only command under both limits", () => {
    const { config } = fixture();
    const script = buildResidueOwnership15Script(config);
    const command = buildResidueOwnership15Command(config);
    expect(script.match(/Get-CimInstance Win32_Process/gu)).toHaveLength(1);
    expect(script.match(/Get-Process -Id/gu)).toHaveLength(1);
    expect(script).toContain("$_.ProcessId-ne0");
    expect(script).toContain("n=$e.Count");
    expect(script).toContain("StartTime.ToUniversalTime().ToString");
    expect(script).toContain("HasExited");
    expect(script).toContain("\\Apowershell\\.exe[ ][ ]");
    expect(script).toContain("FromBase64String");
    expect(script).toContain("UnicodeEncoding");
    expect(script).not.toContain(".Exception.Message");
    for (const forbidden of ["Console]::In", "ReadToEnd", "Stop-Process", "Remove-Item", "New-Item", "vivado", "open_hw", "program_hw"]) {
      expect(script.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(command.length).toBeLessThanOrEqual(7000);
    expect(command.length).toBe(6618);
    expect(command.length).toBeLessThan(8191);
    expect(Buffer.from(command.slice(command.lastIndexOf(" ") + 1), "base64").toString("utf16le")).toBe(script);
    expect(residueOwnership15Plan(config, admission)).toMatchObject({
      attempt_count: 1, retry_permitted: false, stdin_length: 0, cim_snapshot_count: 1,
      get_process_target_count: 4, detailed_object_count_maximum: 6, pid_zero_excluded: true,
      cleanup_derivation_permitted: false, vivado_action_performed: false, hardware_action_performed: false,
    });
  });

  test("locks exact production targets, command hashes, cmd parents, and parser-failure lineage", () => {
    const { config } = fixture();
    expect(validateResidueOwnership15Config(config)).toEqual(config);
    for (const mutate of [
      (value: any) => value.targets[0].pid = 1,
      (value: any) => value.cmd_bindings[0].parent_pid = 4,
      (value: any) => value.raw_command_hashes.powershell = "0".repeat(64),
      (value: any) => value.candidate14_failure.failure_code = "other",
      (value: any) => value.candidate14_failure.attempt_count = 2,
    ]) {
      const changed = structuredClone(config) as any;
      mutate(changed);
      expect(() => validateResidueOwnership15Config(changed)).toThrow("M4F_RESIDUE_15_CONFIG_INVALID");
    }
  });

  test("observes both exact cmd-present residue pairs without authorizing cleanup", () => {
    const { config } = fixture();
    const observation = deriveOwnership15Observation(parsed(), config)!;
    expect(observation.reasons).toEqual([]);
    expect(observation.cross_candidate_connected).toBe(false);
    expect(observation.candidates.map((item) => item.ownership_mode)).toEqual([
      "orphaned_session_residue_cmd_present", "orphaned_session_residue_cmd_present",
    ]);
    expect(observation.candidates.every((item) => item.cleanup_derivation_permitted === false)).toBe(true);
    expect(observation.targets.every((item) => item.get_process_id_exact
      && item.get_process_has_exited === false && item.command_line_hash_exact)).toBe(true);
  });

  test("accepts exact naturally-exited cmd parents only when their PIDs and upstreams remain absent", () => {
    const { config } = fixture();
    const observation = deriveOwnership15Observation(parsed(false), config)!;
    expect(observation.reasons).toEqual([]);
    expect(observation.candidates.map((item) => item.current_cmd_state)).toEqual([
      "naturally_exited", "naturally_exited",
    ]);
    expect(observation.candidates.map((item) => item.ownership_mode)).toEqual([
      "orphaned_session_residue_cmd_naturally_exited", "orphaned_session_residue_cmd_naturally_exited",
    ]);
  });

  test("rejects PID zero, count drift, nested or unknown detail records", () => {
    const { config } = fixture();
    expect(() => parseOwnership15Markers(transcript(true, (p) => (p.e as number[][]).push([0, 0])), config))
      .toThrow("M4F_RESIDUE_15_MARKER_INVALID");
    expect(() => parseOwnership15Markers(transcript(true, (p) => p.n = 1), config))
      .toThrow("M4F_RESIDUE_15_MARKER_INVALID");
    expect(() => parseOwnership15Markers(transcript(true, (p) => (p.d as unknown[]).push([[1, 2]])), config))
      .toThrow("M4F_RESIDUE_15_MARKER_INVALID");
  });

  test("fails closed on every handle and 100ns/CIM correlation field", () => {
    const { config } = fixture();
    for (const [index, value] of [[6, 44769], [7, "pwsh.exe"], [8, true], [9, "2026-08-28T16:25:51.0137885Z"]] as const) {
      const markers = parsed(true, (p) => ((p.d as Detail[])[0]![index] as unknown) = value);
      const observation = deriveOwnership15Observation(markers, config)!;
      expect(observation.reasons.length).toBeGreaterThan(0);
    }
    const badCim = parsed(true, (p) => (p.d as Detail[])[0]![3] = "2026-08-28T16:25:51.0137881Z");
    expect(deriveOwnership15Observation(badCim, config)!.reasons).toContain("candidate09_powershell_cim_microseconds_mismatch");
  });

  test("requires ASCII-only exact wrapper proof, canonical UTF-16LE, decoded hash, and raw hash", () => {
    const { config } = fixture();
    for (const [index, value] of [[10, false], [11, false], [12, "0".repeat(64)], [5, "0".repeat(64)]] as const) {
      const markers = parsed(true, (p) => {
        ((p.d as Detail[])[0]![index] as unknown) = value;
        if (index === 10 || index === 11) (p.d as Detail[])[0]![12] = null;
      });
      expect(deriveOwnership15Observation(markers, config)!.reasons).toContain("candidate09_wrapper_not_proven");
    }
    const script = buildResidueOwnership15Script(config);
    expect(script).toContain("[ ][ ]-NoLogo");
    expect(script).not.toContain("\\s+");
    expect(script).not.toContain("Trim");
    expect(script).not.toContain("powershell(?:.exe)?");
    const token = "QQ==";
    const suffix = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + token;
    expect(hasExactCandidate15WrapperShape("powershell.exe  " + suffix)).toBe(true);
    for (const gap of [" ", "   ", "\t", "\u00a0"]) {
      expect(hasExactCandidate15WrapperShape("powershell.exe" + gap + suffix)).toBe(false);
    }
  });

  test("fails closed on cmd reuse, hash, parent, session, creation, upstream, and extra descendants", () => {
    const { config } = fixture();
    const mutations: Array<(p: Record<string, unknown>) => void> = [
      (p) => (p.d as Detail[])[4]![2] = "pwsh.exe",
      (p) => (p.d as Detail[])[4]![5] = "0".repeat(64),
      (p) => (p.d as Detail[])[4]![1] = 4,
      (p) => (p.d as Detail[])[4]![4] = 2,
      (p) => (p.d as Detail[])[4]![3] = "2026-08-28T16:25:50.9870651Z",
      (p) => { (p.e as number[][]).push([6100, 4]); p.n = (p.e as number[][]).length; },
      (p) => { (p.e as number[][]).push([77777, 44768]); p.n = (p.e as number[][]).length; },
    ];
    for (const mutate of mutations) {
      let reasons: string[];
      try { reasons = deriveOwnership15Observation(parsed(true, mutate), config)!.reasons; } catch { reasons = ["parser_rejected"]; }
      expect(reasons.length).toBeGreaterThan(0);
    }
  });

  test("rejects malformed markers, mutation claims, trailing fragments, and unsafe error payloads", () => {
    const { config } = fixture();
    const trailing = deps(raw(Buffer.concat([transcript(), Buffer.from("x")])));
    expect(executeResidueOwnership15(
      config, admission, residueOwnership15Confirmation(config, admission), trailing.value,
    ).status).toBe("partial_unknown");
    expect(() => parseOwnership15Markers(Buffer.from(transcript().toString().replace('"pm":0', '"pm":1')), config))
      .toThrow("M4F_RESIDUE_15_MARKER_INVALID");
    expect(() => parseOwnership15Markers(Buffer.from(transcript().toString().replace('"de":1', '"de":true')), config))
      .toThrow("M4F_RESIDUE_15_MARKER_INVALID");
  });

  test("validates all sixteen Candidate-14 artifacts plus parser-failure semantics before SSH", () => {
    const { config, frozen } = fixture();
    const good = deps();
    const confirmation = residueOwnership15Confirmation(config, admission);
    expect(executeResidueOwnership15(config, admission, confirmation, good.value).status).toBe("ownership_observed");
    expect(good.calls).toHaveLength(2);
    for (const name of c14Names) {
      const bad = deps();
      const path = config.candidate14_failure.evidence_directory + "/" + name;
      bad.value.frozenBytes = (candidate) => candidate === path ? Buffer.from("tampered") : frozen.get(candidate) ?? Buffer.from("missing");
      expect(() => executeResidueOwnership15(config, admission, confirmation, bad.value))
        .toThrow("M4F_RESIDUE_15_FROZEN_INPUT_MISMATCH");
      expect(bad.calls).toHaveLength(0);
    }
  });

  test("rejects semantic Candidate-14 parser-failure drift even when rebound by a matching hash", () => {
    const f = fixture();
    const changed = structuredClone(f.config);
    const path = changed.candidate14_failure.evidence_directory + "/failure.json";
    const bytes = Buffer.from(JSON.stringify({
      error: "M4F_RESIDUE_OWNERSHIP_MARKER_INVALID", attempt_count: 2, stdin_length: 0,
      retry_permitted: false, cleanup_derivation_permitted: false,
    }));
    changed.candidate14_failure.files["failure.json"] = hash(bytes);
    f.frozen.set(path, bytes);
    const d = deps();
    d.value.frozenBytes = (candidate) => f.frozen.get(candidate) ?? Buffer.from("missing");
    expect(() => executeResidueOwnership15(changed, admission, residueOwnership15Confirmation(changed, admission), d.value))
      .toThrow("M4F_RESIDUE_15_CANDIDATE14_SEMANTIC_MISMATCH");
    expect(d.calls).toHaveLength(0);
  });

  test("uses exactly one empty-stdin remote attempt after the audited effective-config probe", () => {
    const { config } = fixture();
    const d = deps();
    const result = executeResidueOwnership15(config, admission, residueOwnership15Confirmation(config, admission), d.value);
    expect(result.status).toBe("ownership_observed");
    expect(d.calls).toHaveLength(2);
    expect(d.calls[0]!.args[0]).toBe("-G");
    expect(d.calls[1]!.args).toContain("100.96.223.49");
    expect(d.calls[1]!.stdin.length).toBe(0);
    expect(d.calls[1]!.timeout).toBe(25000);
  });

  test("freezes confirmation to config, plan, source, and test hashes", () => {
    const { config } = fixture();
    const confirmation = residueOwnership15Confirmation(config, admission);
    expect(confirmation).toStartWith("SYNTHIA_M4F_DIRECT_RESIDUE_OWNERSHIP_15_READ_ONLY:");
    expect(confirmation.split(":" )).toHaveLength(6);
    const changed = structuredClone(config);
    changed.evidence_directory = "/tmp/other-evidence";
    expect(residueOwnership15Confirmation(changed, admission)).not.toBe(confirmation);
  });
});
