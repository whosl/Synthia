import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  admissionV2Confirmation,
  AdmissionV2Failure,
  buildAdmissionV2Command,
  buildAdmissionV2Script,
  expandAdmissionV2CompactSnapshot,
  M4F_DIRECT_ADMISSION_V2_GUARDS,
  planAdmissionV2,
  recordAdmissionV2,
  spawnAdmissionV2Process,
  validateAdmissionV2Config,
  validateAdmissionV2Snapshot,
  type AdmissionV2Dependencies,
  type M4fDirectAdmissionV2Config,
} from "./scripts/m4f-direct-admission-v2.ts";
import { buildIdentityResidueFollowupLoader } from "./scripts/m4f-direct-identity-residue-followup.ts";
import type { M4fDirectAdmissionConfig, RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const roots: string[] = [];
const KEY = Buffer.from(Array.from({ length: 48 }, (_, index) => index + 1));
const FINGERPRINT = "SHA256:" + createHash("sha256").update(KEY)
  .digest("base64").replace(/=+$/u, "");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("M4-F direct admission v2", () => {
  test("plans one bounded compressed EncodedCommand with empty stdin", () => {
    const scenario = fixture();
    const plan = planAdmissionV2(scenario.config, scenario.dependencies);
    expect(plan).toMatchObject({
      schema: "synthia-m4f-direct-admission-v2-plan.v1",
      status: "planned_not_executed",
      topology: "single_ssh_direct_compressed_encoded_command_empty_stdin",
      attempt_count: 1,
      timeout_ms: 240_000,
      network_attempted: false,
      hardware_action_performed: false,
      process_termination_performed: false,
    });
    expect(Number(plan.remote_command_length)).toBeLessThanOrEqual(6500);
    expect(plan.confirmation).toBe(admissionV2Confirmation(scenario.config));
    expect(scenario.calls).toHaveLength(0);
    expect(M4F_DIRECT_ADMISSION_V2_GUARDS).toMatchObject({
      timeoutMs: 240_000,
      remoteAttemptCount: 1,
      commandLengthLimit: 6500,
      retryPermitted: false,
      hardwareActionPermitted: false,
      processTerminationPermitted: false,
    });
  });

  test("delimits return expressions for Windows PowerShell 5.1", () => {
    const script = buildAdmissionV2Script(fixture().admission);
    expect(script.match(/return \[ordered\]/gu)).toHaveLength(2);
    expect(script).not.toContain("return[ordered]");
  });

  test("permanently rejects the consumed production admission id", () => {
    const scenario = fixture();
    for (const admissionId of [
      "m4f-direct-admission-v2-prod-20260828-01",
      "m4f-direct-admission-v2-prod-20260828-02",
    ]) {
      expect(() => validateAdmissionV2Config({
        ...scenario.config,
        admission_id: admissionId,
      })).toThrow(AdmissionV2Failure);
    }
  });

  test("reuses the prod-04 loader and strongly binds fixed whoami before all snapshot work", () => {
    const scenario = fixture();
    const source = buildAdmissionV2Script(scenario.admission);
    const packed = buildAdmissionV2Command(scenario.admission);
    const prod04 = buildIdentityResidueFollowupLoader(source);
    expect(packed.compressed).toEqual(prod04.compressed);
    expect(packed.loader).toBe(prod04.loader);
    expect(gunzipSync(packed.compressed).toString("utf8")).toBe(source);
    expect(packed.command).toStartWith(
      "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ",
    );
    expect(packed.command.length).toBeLessThanOrEqual(6500);
    expect(source.indexOf("$env:COMPUTERNAME")).toBeLessThan(source.indexOf("whoami.exe"));
    expect(source.indexOf("whoami.exe")).toBeLessThan(source.indexOf("Get-CimInstance"));
    expect(source).toContain("C:\\Windows\\System32\\whoami.exe");
    expect(source).toContain("/user /fo csv /nh");
    expect(source).toContain("ConvertFrom-Csv -InputObject ($r[0]) -Header n,s");
    expect(source).not.toContain("WindowsIdentity");
    expect(source).toContain("Get-CimInstance -ClassName Win32_LogicalDisk -Filter");
    expect(source).toContain("Get-Acl -LiteralPath");
    expect(source).toContain("Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue");
    expect(source).toContain("Get-CimInstance -ClassName Win32_Process");
    expect(source).toContain("Get-FileHash -LiteralPath $x -Algorithm SHA256");
    expect(packed.loader).toStartWith("$ProgressPreference=\"SilentlyContinue\"");
    for (const preference of ["Information", "Verbose", "Debug", "Warning"]) {
      expect(packed.loader).toContain("\"" + preference + "\"");
    }
    expect(packed.loader).not.toContain("Console]::In.ReadToEnd");
    expect(source).not.toMatch(/Stop-Process|taskkill|Start-Process|Set-Content|Out-File/iu);
    expect(source).not.toMatch(/vivado .*-(?:mode|source)|open_hw|program_hw|write_bitstream|write_cfgmem/iu);
  });

  test("strictly expands compact target JSON back to the full snapshot schema", () => {
    const scenario = fixture();
    const snapshot = expandAdmissionV2CompactSnapshot(compactSnapshot(scenario.admission));
    expect(snapshot).toMatchObject({
      schema: "synthia-m4f-direct-target-admission-snapshot.v2",
      identity: {
        computer_name: "DESKTOP-DVFFB09",
        user_domain: "WORKGROUP",
        user_name: "admin",
        whoami_name: scenario.admission.target.identity_name,
        whoami_sid: scenario.admission.target.identity_sid,
      },
      acl: scenario.admission.target.acl_paths.map((path) => ({ path, exists: true })),
      hardware_action_performed: false,
      process_termination_performed: false,
    });
    const malformed = compactSnapshot(scenario.admission);
    (malformed.i as Record<string, unknown>).unexpected = true;
    expect(capture(() => expandAdmissionV2CompactSnapshot(malformed)).code)
      .toBe("M4F_DIRECT_ADMISSION_V2_COMPACT_SNAPSHOT_INVALID");
  });

  test("preserves every listed v1 business fact and rejects weakened compact values", () => {
    const scenario = fixture();
    const compact = compactSnapshot(scenario.admission);
    const secondRule = {
      s: "S-1-5-32-544",
      t: "Deny",
      r: 2,
      i: true,
      n: "ContainerInherit",
      p: "InheritOnly",
    };
    for (const acl of compact.a as Array<Record<string, unknown>>) {
      (acl.r as unknown[]).push(secondRule);
    }
    const snapshot = expandAdmissionV2CompactSnapshot(compact);
    expect(snapshot).toEqual({
      schema: "synthia-m4f-direct-target-admission-snapshot.v2",
      observed_at_utc: compact.t,
      identity: {
        computer_name: "DESKTOP-DVFFB09",
        user_domain: "WORKGROUP",
        user_name: "admin",
        whoami_name: scenario.admission.target.identity_name,
        whoami_sid: scenario.admission.target.identity_sid,
      },
      volumes: [
        { device_id: "C:", drive_type: 3, free_bytes: 100, size_bytes: 200, file_system: "NTFS" },
        { device_id: "D:", drive_type: 3, free_bytes: 300, size_bytes: 400, file_system: "NTFS" },
      ],
      acl: scenario.admission.target.acl_paths.map((path) => ({
        path,
        exists: true,
        owner_sid: scenario.admission.target.identity_sid,
        protected: true,
        reparse: false,
        rules: [
          {
            sid: scenario.admission.target.identity_sid,
            type: "Allow",
            rights: 2032127,
            inherited: false,
            inheritance: "None",
            propagation: "None",
          },
          {
            sid: "S-1-5-32-544",
            type: "Deny",
            rights: 2,
            inherited: true,
            inheritance: "ContainerInherit",
            propagation: "InheritOnly",
          },
        ],
      })),
      listeners: [{ address: "0.0.0.0", port: 8443, pid: 100 }],
      relevant_processes: [{
        pid: 100,
        parent_pid: 50,
        name: "node.exe",
        executable_path: "D:\\synthia-worker\\node.exe",
        creation_date: "2026-08-28T11:00:00.000Z",
      }],
      vivado: {
        path: scenario.admission.target.vivado_executable,
        exists: true,
        length: 100,
        sha256: "a".repeat(64),
        file_version: "1.0",
      },
      bun: {
        path: scenario.admission.target.bun_executable,
        exists: true,
        length: 100,
        sha256: "a".repeat(64),
        file_version: "1.0",
      },
      hardware_action_performed: false,
      process_termination_performed: false,
    });

    for (const mutate of [
      (value: Record<string, unknown>) => {
        ((value.l as unknown[])[0] as Record<string, unknown>).a = "";
      },
      (value: Record<string, unknown>) => {
        ((value.p as unknown[])[0] as Record<string, unknown>).x = "D:\\bad\0path.exe";
      },
      (value: Record<string, unknown>) => {
        ((value.p as unknown[])[0] as Record<string, unknown>).x = "D:\\" + "a".repeat(1022);
      },
    ]) {
      const malformed = compactSnapshot(scenario.admission);
      mutate(malformed);
      const expanded = expandAdmissionV2CompactSnapshot(malformed);
      const failure = capture(() => validateAdmissionV2Snapshot(expanded, scenario.admission));
      expect(failure.code).toBe("M4F_DIRECT_ADMISSION_V2_SNAPSHOT_INVALID");
    }
  });

  test("accepts signed Windows FileSystemRights bitmasks and rejects out-of-range values", () => {
    const scenario = fixture();
    const compact = compactSnapshot(scenario.admission);
    const aclEntry = (compact.a as unknown[])[1] as Record<string, unknown>;
    const rules = aclEntry.r as unknown[];
    const firstRule = rules[0] as Record<string, unknown>;
    firstRule.r = -536_805_376;
    expect(() => validateAdmissionV2Snapshot(
      expandAdmissionV2CompactSnapshot(compact),
      scenario.admission,
    )).not.toThrow();
    firstRule.r = -2_147_483_649;
    expect(() => validateAdmissionV2Snapshot(
      expandAdmissionV2CompactSnapshot(compact),
      scenario.admission,
    )).toThrow(AdmissionV2Failure);
  });

  test("records one successful attempt with raw streams and 0700/0600 evidence", () => {
    const scenario = fixture();
    const evidence = join(scenario.root, "evidence");
    const result = recordAdmissionV2(
      scenario.config,
      admissionV2Confirmation(scenario.config),
      evidence,
      scenario.dependencies,
    );
    expect(result).toMatchObject({
      schema: "synthia-m4f-direct-admission-v2-record.v1",
      status: "observed",
      attempt: 1,
      timeout_ms: 240_000,
      stdin_length: 0,
      process: { stdin_length: 0, stderr_length: 0, retry_permitted: false },
      target_snapshot: {
        identity: {
          whoami_name: scenario.admission.target.identity_name,
          whoami_sid: scenario.admission.target.identity_sid,
        },
      },
      hardware_action_performed: false,
      process_termination_performed: false,
    });
    expect(scenario.calls).toHaveLength(2);
    expect(scenario.calls[0]!.args[0]).toBe("-G");
    expect(scenario.calls[1]!.stdin).toEqual(Buffer.alloc(0));
    expect(scenario.calls[1]!.timeoutMs).toBe(240_000);
    expect(scenario.calls[1]!.args.at(-1)).toBe(buildAdmissionV2Command(scenario.admission).command);
    expect(lstatSync(evidence).mode & 0o777).toBe(0o700);
    for (const name of [
      "admission-v2-config.canonical.json", "remote-script.ps1", "remote-loader.ps1",
      "remote-payload.gzip", "ssh-effective.stdout.raw", "ssh-effective.stderr.raw",
      "ssh-effective-process.json", "stdout.raw", "stderr.raw", "remote-process.json",
      "admission-v2-record.json",
    ]) expect(lstatSync(join(evidence, name)).mode & 0o777).toBe(0o600);
    expect(result.process.stdout_sha256).toBe(sha256(readFileSync(join(evidence, "stdout.raw"))));
  });

  test("never substitutes another identity source for a wrong whoami SID", () => {
    const scenario = fixture();
    const snapshot = compactSnapshot(scenario.admission);
    (snapshot.i as Record<string, unknown>).s = "S-1-5-21-1-2-3-9999";
    scenario.remote = processResult(JSON.stringify(snapshot) + "\n");
    const evidence = join(scenario.root, "wrong-whoami");
    expect(capture(() => recordAdmissionV2(
      scenario.config,
      admissionV2Confirmation(scenario.config),
      evidence,
      scenario.dependencies,
    )).code).toBe("M4F_DIRECT_ADMISSION_V2_SNAPSHOT_INVALID");
    expect(readFileSync(join(evidence, "stdout.raw"))).toEqual(scenario.remote.stdout);
    expect(JSON.parse(readFileSync(join(evidence, "admission-v2-failure.json"), "utf8")))
      .toMatchObject({ retry_permitted: false, remote_process: { stdout_length: scenario.remote.stdout.length } });
    expect(scenario.calls).toHaveLength(2);
  });

  test("freezes both raw streams on timeout and never retries", () => {
    const scenario = fixture();
    scenario.remote = processResult("partial", "diagnostic", null, "SIGKILL", "ETIMEDOUT");
    const evidence = join(scenario.root, "timeout");
    expect(capture(() => recordAdmissionV2(
      scenario.config,
      admissionV2Confirmation(scenario.config),
      evidence,
      scenario.dependencies,
    )).code).toBe("M4F_DIRECT_ADMISSION_V2_TRANSPORT_FAILED");
    expect(readFileSync(join(evidence, "stdout.raw"), "utf8")).toBe("partial");
    expect(readFileSync(join(evidence, "stderr.raw"), "utf8")).toBe("diagnostic");
    expect(JSON.parse(readFileSync(join(evidence, "remote-process.json"), "utf8")))
      .toMatchObject({ timed_out: true, signal: "SIGKILL", retry_permitted: false });
    const failure = JSON.parse(readFileSync(join(evidence, "admission-v2-failure.json"), "utf8"));
    expect(failure.transport_inputs_before).toEqual(failure.transport_inputs_after);
    expect(failure.admission_config_before).toEqual(failure.admission_config_after);
    expect(scenario.calls).toHaveLength(2);
  });

  test("never reports not-started after a remote attempt when after-binding fails", () => {
    const scenario = fixture();
    const spawn = scenario.dependencies.spawn;
    scenario.dependencies.spawn = (executable, args, stdin, timeoutMs) => {
      const result = spawn(executable, args, stdin, timeoutMs);
      if (args[0] !== "-G") {
        writeSecure(scenario.config.admission_config_path, JSON.stringify({
          ...scenario.admission,
          gate_id: "changed-after-remote",
        }) + "\n");
      }
      return result;
    };
    const evidence = join(scenario.root, "after-binding-failure");
    const failure = capture(() => recordAdmissionV2(
      scenario.config,
      admissionV2Confirmation(scenario.config),
      evidence,
      scenario.dependencies,
    ));
    expect(failure).toMatchObject({
      remote_effect_state: "read_only_unknown",
      stage: "network_postflight",
    });
    expect(JSON.parse(readFileSync(join(evidence, "admission-v2-failure.json"), "utf8")))
      .toMatchObject({
        remote_effect_state: "read_only_unknown",
        stage: "network_postflight",
        remote_process: { exit_status: 0 },
      });
    expect(scenario.calls).toHaveLength(2);
  });

  test("rejects stale source, wrong confirmation, layout drift, and existing evidence before network", () => {
    const stale = fixture();
    stale.source = Buffer.from("stale");
    expect(String(capture(() => planAdmissionV2(stale.config, stale.dependencies)).code))
      .toContain("SOURCE_MISMATCH");
    expect(stale.calls).toHaveLength(0);

    const wrong = fixture();
    const wrongEvidence = join(wrong.root, "wrong-confirmation");
    expect(capture(() => recordAdmissionV2(
      wrong.config, "wrong", wrongEvidence, wrong.dependencies,
    )).code).toBe("M4F_DIRECT_ADMISSION_V2_CONFIRMATION_REQUIRED");
    expect(existsSync(wrongEvidence)).toBe(false);
    expect(wrong.calls).toHaveLength(0);

    const occupied = fixture();
    const occupiedPath = join(occupied.root, "occupied");
    writeFileSync(occupiedPath, "occupied");
    expect(capture(() => recordAdmissionV2(
      occupied.config,
      admissionV2Confirmation(occupied.config),
      occupiedPath,
      occupied.dependencies,
    )).code).toBe("M4F_DIRECT_ADMISSION_V2_EVIDENCE_DIRECTORY_INVALID");
    expect(occupied.calls).toHaveLength(0);

    const layout = fixture();
    layout.admission.target.acl_paths = ["C:\\Windows\\Temp"];
    writeSecure(layout.config.admission_config_path, JSON.stringify(layout.admission) + "\n");
    layout.config.admission_config_sha256 = sha256(readFileSync(layout.config.admission_config_path));
    expect(capture(() => planAdmissionV2(layout.config, layout.dependencies)).code)
      .toBe("M4F_DIRECT_ADMISSION_V2_TARGET_LAYOUT_MISMATCH");
  });

  test("enforces SIGKILL for the bounded local deadline", () => {
    const started = performance.now();
    const result = spawnAdmissionV2Process(
      "/bin/sh", ["-c", "trap '' TERM; while :; do :; done"], Buffer.alloc(0), 100,
    );
    expect(result).toMatchObject({ errorCode: "ETIMEDOUT", signal: "SIGKILL" });
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

interface Scenario {
  root: string;
  admission: M4fDirectAdmissionConfig;
  config: M4fDirectAdmissionV2Config;
  source: Buffer;
  transport: Buffer;
  loader: Buffer;
  effective: string;
  remote: RawProcessResult;
  calls: Array<{ args: readonly string[]; stdin: Buffer; timeoutMs: number }>;
  dependencies: AdmissionV2Dependencies;
}

function fixture(): Scenario {
  const root = mkdtempSync(join(tmpdir(), "synthia-admission-v2-"));
  roots.push(root);
  const identity = join(root, "id");
  const knownHosts = join(root, "known");
  writeSecure(identity, "private-key\n");
  writeSecure(knownHosts, "100.96.223.49 ssh-ed25519 " + KEY.toString("base64") + "\n");
  const admission: M4fDirectAdmissionConfig = {
    schema: "synthia-m4f-direct-admission-config.v1",
    gate_id: "admission-v2-base",
    target: {
      host: "100.96.223.49",
      port: 22,
      user: "admin",
      computer_name: "DESKTOP-DVFFB09",
      identity_name: "desktop-dvffb09\\admin",
      identity_sid: "S-1-5-21-2561815994-3878748218-1101284459-1001",
      identity_file: identity,
      known_hosts_file: knownHosts,
      known_hosts_host_token: "100.96.223.49",
      host_key_fingerprint: FINGERPRINT,
      expected_effective_config_sha256: null,
      acl_paths: [
        "C:\\Windows\\Temp",
        "D:\\synthia-worker",
        "D:\\Xilinx\\Vivado\\2021.1",
      ],
      vivado_executable: "D:\\Xilinx\\Vivado\\2021.1\\bin\\vivado.bat",
      bun_executable: "D:\\synthia-worker\\runtime\\bun-1.4.1\\bun.exe",
    },
  };
  const effective = effectiveConfig(admission);
  admission.target.expected_effective_config_sha256 = sha256(effective);
  const admissionPath = join(root, "admission.json");
  writeSecure(admissionPath, JSON.stringify(admission) + "\n");
  const source = Buffer.from("admission-v2-source");
  const transport = Buffer.from("transport-source");
  const loader = Buffer.from("loader-source");
  const config: M4fDirectAdmissionV2Config = {
    schema: "synthia-m4f-direct-admission-v2-config.v1",
    admission_id: "admission-v2-test-01",
    admission_config_path: admissionPath,
    admission_config_sha256: sha256(readFileSync(admissionPath)),
    expected_source_sha256: sha256(source),
    expected_transport_source_sha256: sha256(transport),
    expected_loader_source_sha256: sha256(loader),
  };
  const scenario: Scenario = {
    root,
    admission,
    config,
    source,
    transport,
    loader,
    effective,
    remote: processResult(JSON.stringify(compactSnapshot(admission)) + "\n"),
    calls: [],
    dependencies: {} as AdmissionV2Dependencies,
  };
  let tick = 0;
  scenario.dependencies = {
    spawn(_executable, args, stdin, timeoutMs) {
      scenario.calls.push({ args, stdin: Buffer.from(stdin), timeoutMs });
      return args[0] === "-G" ? processResult(scenario.effective) : scenario.remote;
    },
    sourceBytes: () => Buffer.from(scenario.source),
    transportSourceBytes: () => Buffer.from(scenario.transport),
    loaderSourceBytes: () => Buffer.from(scenario.loader),
    now: () => new Date("2026-08-28T12:00:00.000Z"),
    monotonicMs: () => (tick += 25),
  };
  return scenario;
}

function compactSnapshot(admission: M4fDirectAdmissionConfig): Record<string, unknown> {
  const rule = { s: admission.target.identity_sid, t: "Allow", r: 2032127, i: false, n: "None", p: "None" };
  const file = (path: string) => ({ p: path, e: true, l: 100, h: "a".repeat(64), v: "1.0" });
  return {
    s: "s2",
    t: "2026-08-28T12:00:00.000Z",
    i: { c: "DESKTOP-DVFFB09", d: "WORKGROUP", u: "admin", n: admission.target.identity_name, s: admission.target.identity_sid },
    v: [
      { d: "C:", t: 3, f: 100, s: 200, y: "NTFS" },
      { d: "D:", t: 3, f: 300, s: 400, y: "NTFS" },
    ],
    a: admission.target.acl_paths.map((path) => ({ p: path, e: true, o: admission.target.identity_sid, x: true, y: false, r: [rule] })),
    l: [{ a: "0.0.0.0", p: 8443, i: 100 }],
    p: [{ i: 100, p: 50, n: "node.exe", x: "D:\\synthia-worker\\node.exe", c: "2026-08-28T11:00:00.000Z" }],
    x: file(admission.target.vivado_executable),
    b: file(admission.target.bun_executable),
    h: false,
    k: false,
  };
}

function effectiveConfig(config: M4fDirectAdmissionConfig): string {
  return [
    "host 100.96.223.49", "hostname 100.96.223.49", "user admin", "port 22", "batchmode yes",
    "connecttimeout 15", "connectionattempts 1", "serveraliveinterval 0", "serveralivecountmax 4",
    "numberofpasswordprompts 0", "identityagent none", "identitiesonly yes", "pubkeyauthentication true",
    "passwordauthentication no", "kbdinteractiveauthentication no", "gssapiauthentication no",
    "hostbasedauthentication no", "preferredauthentications publickey", "stricthostkeychecking true",
    "forwardagent no", "clearallforwardings yes", "permitlocalcommand no", "controlmaster false",
    "controlpersist no", "warnweakcrypto no", "requesttty false", "identityfile " + config.target.identity_file,
    "userknownhostsfile " + config.target.known_hosts_file, "globalknownhostsfile /dev/null", "",
  ].join("\n");
}

function writeSecure(path: string, content: string | Buffer): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function processResult(
  stdout = "",
  stderr = "",
  status: number | null = 0,
  signal: NodeJS.Signals | null = null,
  errorCode: string | null = null,
): RawProcessResult {
  return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), status, signal, errorCode };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function capture(action: () => unknown): Record<string, unknown> {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AdmissionV2Failure);
    return (error as AdmissionV2Failure).detail;
  }
  throw new Error("expected failure");
}
