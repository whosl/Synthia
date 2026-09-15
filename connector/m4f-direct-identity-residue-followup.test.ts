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
  buildIdentityResidueFollowupCommand,
  buildIdentityResidueFollowupLoader,
  buildIdentityResidueFollowupScript,
  FOLLOWUP_PHASES,
  identityResidueFollowupConfirmation,
  IdentityResidueFollowupFailure,
  M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_GUARDS,
  parseIdentityResidueMarkers,
  planIdentityResidueFollowup,
  recordIdentityResidueFollowup,
  spawnBoundedFollowupProcess,
  type FollowupDependencies,
  type M4fDirectIdentityResidueFollowupConfig,
} from "./scripts/m4f-direct-identity-residue-followup.ts";
import type { M4fDirectAdmissionConfig, RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const roots: string[] = [];
const KEY = Buffer.from(Array.from({ length: 48 }, (_, index) => index + 1));
const FINGERPRINT = "SHA256:" + createHash("sha256").update(KEY)
  .digest("base64").replace(/=+$/u, "");
const WINDOWS_POWERSHELL_51_BUILTIN_ALIASES = new Set(`
  % ? ac asnp cat cd chdir clc clear clhy cli clp cls clv cnsn compare copy
  cp cpi cpp curl cvpa dbp del diff dir dnsn ebp echo epal epcsv epsn erase
  etsn exsn fc fhx fl foreach ft fw gal gbp gc gci gcm gcs gdr ghy gi gin
  gjb gl gm gmo gp gps group gsn gsnp gsv gu gv gwmi h history icm iex ihy
  ii ipal ipcsv ipmo ipsn irm ise iwmi iwr kill lp ls man md measure mi mount
  move mp mv nal ndr ni nmo npssc nsn nv ogv oh popd ps pushd pwd r rbp rcjb
  rcsn rd rdr ren ri rjb rm rmdir rmo rni rnp rp rsn rsnp rujb rv rvpa rwmi
  sajb sal saps sasv sbp sc select set shcm si sl sleep sls sort sp spjb spps
  spsv start stz sujb sv swmi tee trcm type wget where wjb write
`.trim().split(/\s+/u));
const WINDOWS_POWERSHELL_51_BUILTIN_FUNCTIONS = new Set([
  "cd..", "cd\\", "help", "mkdir", "more", "oss", "pause", "prompt",
  "tabexpansion2",
]);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("M4-F single-session identity/residue follow-up", () => {
  test("uses one bounded direct EncodedCommand with empty stdin", () => {
    const scenario = fixture();
    const plan = planIdentityResidueFollowup(scenario.config, scenario.dependencies);
    expect(plan).toMatchObject({
      schema: "synthia-m4f-direct-identity-residue-followup-plan.v2",
      topology: "single_ssh_direct_encoded_command_empty_stdin",
      attempt_count: 1,
      timeout_ms: 30_000,
      maximum_remote_elapsed_ms: 30_000,
      phase_order: FOLLOWUP_PHASES,
      network_attempted: false,
      hardware_action_performed: false,
      process_termination_performed: false,
    });
    expect(Number(plan.remote_command_length)).toBeLessThan(8191);
    expect(plan.confirmation).toBe(identityResidueFollowupConfirmation(scenario.config));
    expect(scenario.calls).toHaveLength(0);
    expect(M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_GUARDS).toMatchObject({
      remoteAttemptCount: 1,
      maximumRemoteElapsedMs: 30_000,
      windowsCmdLimit: 8191,
      commandLengthLimit: 6500,
      reservedPrefixCharacters: 1691,
      processTerminationPermitted: false,
    });
  });

  test("enforces the local deadline with SIGKILL", () => {
    const started = performance.now();
    const result = spawnBoundedFollowupProcess(
      "/bin/sh", ["-c", "trap '' TERM; while :; do :; done"], Buffer.alloc(0), 100,
    );
    expect(result).toMatchObject({ errorCode: "ETIMEDOUT", signal: "SIGKILL" });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("the command is a closed read-only inventory with flushed markers", () => {
    const source = buildIdentityResidueFollowupScript();
    const packed = buildIdentityResidueFollowupLoader(source);
    const command = buildIdentityResidueFollowupCommand(source);
    expect(command).toStartWith("powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ");
    expect(command.length).toBeLessThanOrEqual(6500);
    expect(8191 - 6500).toBe(1691);
    expect(gunzipSync(packed.compressed).toString("utf8")).toBe(source);
    expect(packed.loader).toContain(packed.compressed.toString("base64"));
    expect(packed.loader).toStartWith("$ProgressPreference=\"SilentlyContinue\"");
    for (const preference of ["Information", "Verbose", "Debug", "Warning"]) {
      expect(packed.loader).toContain("\"" + preference + "\"");
    }
    expect(packed.loader).not.toContain("Console]::In.ReadToEnd");
    expect(packed.loader).not.toMatch(/Set-Content|Out-File|WriteAllBytes|WriteAllText/iu);
    expect(source).toContain("[Console]::Out.Flush()");
    expect(source).toContain("$env:COMPUTERNAME");
    expect(source).toContain("Get-Process sshd,powershell,conhost");
    expect(source).toContain("(Get-CimInstance -ClassName Win32_Process -Filter");
    expect(source).toContain("CommandLine");
    expect(source).toContain("Get-CimInstance -ClassName Win32_OperatingSystem");
    expect(source).toContain("Get-Service -Name sshd");
    expect(source).toContain("(Get-WinEvent -LogName \"OpenSSH/Operational\" -MaxEvents 16)");
    expect(source).toContain("C:\\Windows\\System32\\whoami.exe");
    expect(source).toContain("$env:SystemRoot-ine\"C:\\Windows\"");
    expect(source).toContain("ConvertFrom-Csv -InputObject ($r[0]) -Header n,s");
    expect(source).toContain("category=[string]$_.CategoryInfo.Category");
    expect(source).toContain("fqid_sha256=SynthiaHash $_.FullyQualifiedErrorId");
    expect(source).toContain("message_sha256=SynthiaHash $_.Exception.Message");
    expect(source).not.toContain("message=$_.Exception.Message");
    expect(source).toContain("WindowsIdentity]::GetCurrent()");
    expect(source).not.toMatch(/Stop-Process|taskkill|Start-Process|Invoke-Expression|Invoke-Command/iu);
    expect(source).not.toMatch(/(?:New|Set|Remove|Copy|Move)-Item|Set-Content|Out-File|Set-Acl/iu);
    expect(source).not.toMatch(/vivado|open_hw|connect_hw|program_hw|write_bitstream|write_cfgmem/iu);
    expect(source).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|curl|wget/iu);
  });

  test("serializes a missing or empty process command hash as explicit JSON null", () => {
    const source = buildIdentityResidueFollowupScript();
    expect(source).toContain(
      "$q=$_.CommandLine;$h=$null;if(-not [string]::IsNullOrWhiteSpace([string]$q)){$h=SynthiaHash $q}",
    );
    expect(source).toContain("command_sha256=$h");
    expect(source).not.toContain("command_sha256=if($q){SynthiaHash $q}");

    const scenario = fixture();
    const lines = markerStream(scenario.admission).trimEnd().split("\n");
    const snapshot = JSON.parse(lines[3]!);
    snapshot.payload.processes[0].command_sha256 = null;
    lines[3] = JSON.stringify(snapshot);
    scenario.remote = processResult(lines.join("\n") + "\n");
    expect(recordIdentityResidueFollowup(
      scenario.config,
      identityResidueFollowupConfirmation(scenario.config),
      join(scenario.root, "explicit-null-command-hash"),
      scenario.dependencies,
    ).status).toBe("observed");

    const invalid = fixture();
    const invalidLines = markerStream(invalid.admission).trimEnd().split("\n");
    const invalidSnapshot = JSON.parse(invalidLines[3]!);
    invalidSnapshot.payload.processes[0].command_sha256 = {};
    invalidLines[3] = JSON.stringify(invalidSnapshot);
    invalid.remote = processResult(invalidLines.join("\n") + "\n");
    expect(recordIdentityResidueFollowup(
      invalid.config,
      identityResidueFollowupConfirmation(invalid.config),
      join(invalid.root, "object-command-hash"),
      invalid.dependencies,
    ).status).toBe("unknown");
  });

  test("keeps every helper out of the Windows PowerShell 5.1 command namespace", () => {
    const source = buildIdentityResidueFollowupScript();
    expect(WINDOWS_POWERSHELL_51_BUILTIN_ALIASES.has("h")).toBe(true);
    expect(WINDOWS_POWERSHELL_51_BUILTIN_ALIASES.has("H".toLowerCase())).toBe(true);
    const helpers = [...source.matchAll(/^function\s+([^\s(]+)/gmu)]
      .map((match) => match[1]!.toLowerCase());
    expect(helpers).toEqual(["synthiahash", "e", "p"]);
    for (const helper of helpers) {
      expect(WINDOWS_POWERSHELL_51_BUILTIN_ALIASES.has(helper)).toBe(false);
      expect(WINDOWS_POWERSHELL_51_BUILTIN_FUNCTIONS.has(helper)).toBe(false);
      expect(helper).not.toMatch(/^[a-z]+-[a-z]/u);
    }
    expect(source).not.toMatch(/\bH\b/u);
    expect(source.match(/\bSynthiaHash\b/gu)).toHaveLength(5);
    expect(source).toContain("function SynthiaHash($s){");
    expect(source.indexOf("function SynthiaHash($s){"))
      .toBeLessThan(source.indexOf("fqid_sha256=SynthiaHash"));
    const hashCalls = source.split("\n").slice(2).join("\n")
      .match(/\bSynthiaHash\b/gu);
    expect(hashCalls).toHaveLength(4);

    const sourceFile = readFileSync(
      new URL("./scripts/m4f-direct-identity-residue-followup.ts", import.meta.url),
      "utf8",
    );
    expect(sourceFile.match(/\bSynthiaHash\b/gu)).toHaveLength(5);
    expect(sha256(sourceFile.replaceAll("SynthiaHash", "H")))
      .toBe("dc4248306c1d98364500b1af3772b2ba1d4d576f543ca5b65fbce59e1b455e60");
  });

  test("rejects an incompressible fixture above the audited command cap", () => {
    const chunks: Buffer[] = [];
    let seed = Buffer.from("synthia-command-boundary-fixture");
    while (Buffer.concat(chunks).length < 6000) {
      seed = createHash("sha256").update(seed).digest();
      chunks.push(seed);
    }
    const fixtureSource = Buffer.concat(chunks).subarray(0, 6000).toString("base64");
    const failure = capture(() => buildIdentityResidueFollowupCommand(fixtureSource));
    expect(failure).toMatchObject({
      code: "M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_COMMAND_TOO_LONG",
      stage: "local_preflight",
      command_length_limit: 6500,
      reserved_prefix_characters: 1691,
    });
    expect(Number(failure.command_length)).toBeGreaterThan(6500);
  });

  test("rejects wrong confirmation and stale source before evidence or spawn", () => {
    const wrong = fixture();
    const wrongEvidence = join(wrong.root, "wrong");
    expect(capture(() => recordIdentityResidueFollowup(
      wrong.config, "wrong", wrongEvidence, wrong.dependencies,
    )).code).toBe("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_CONFIRMATION_REQUIRED");
    expect(existsSync(wrongEvidence)).toBe(false);
    expect(wrong.calls).toHaveLength(0);

    const stale = fixture();
    stale.source = Buffer.from("changed");
    const staleEvidence = join(stale.root, "stale");
    expect(String(capture(() => recordIdentityResidueFollowup(
      stale.config,
      identityResidueFollowupConfirmation(stale.config),
      staleEvidence,
      stale.dependencies,
    )).code)).toContain("SOURCE_MISMATCH");
    expect(existsSync(staleEvidence)).toBe(false);
    expect(stale.calls).toHaveLength(0);
  });

  test("strictly parses ordered complete and partial NDJSON marker prefixes", () => {
    const scenario = fixture();
    const complete = Buffer.from(markerStream(scenario.admission));
    expect(parseIdentityResidueMarkers(complete, scenario.admission)?.map((item) => item.phase))
      .toEqual(FOLLOWUP_PHASES);
    const partialLines = markerStream(scenario.admission).trimEnd().split("\n").slice(0, 4).join("\n") + "\n";
    expect(parseIdentityResidueMarkers(Buffer.from(partialLines), scenario.admission)?.at(-1)?.phase)
      .toBe("cim-system-snapshot");
    const malformed = JSON.parse(markerStream(scenario.admission).split("\n")[1]!);
    malformed.phase = "windows-identity";
    expect(parseIdentityResidueMarkers(Buffer.from(JSON.stringify(malformed) + "\n"), scenario.admission))
      .toBeNull();
    const fragmented = Buffer.from(partialLines + '{"ordinal":5,"phase":"openssh-events"');
    expect(parseIdentityResidueMarkers(fragmented, scenario.admission)?.at(-1)?.phase)
      .toBe("cim-system-snapshot");

    const semanticMismatch = markerStream(scenario.admission).trimEnd().split("\n");
    const env = JSON.parse(semanticMismatch[1]!);
    env.payload.user_name = "intruder";
    semanticMismatch[1] = JSON.stringify(env);
    expect(parseIdentityResidueMarkers(
      Buffer.from(semanticMismatch.join("\n") + "\n"), scenario.admission,
    )).toHaveLength(8);

    const unknown = JSON.parse(markerStream(scenario.admission).split("\n")[0]!);
    unknown.status = "unknown";
    unknown.payload = null;
    unknown.error = {
      type: "System.Management.Automation.ParameterBindingException",
      hresult: -2146233087,
      category: "InvalidArgument",
      fqid_sha256: "c".repeat(64),
      message_sha256: "d".repeat(64),
    };
    expect(parseIdentityResidueMarkers(
      Buffer.from(JSON.stringify(unknown) + "\n"), scenario.admission,
    )).toHaveLength(1);
    unknown.error.message = "raw messages are forbidden";
    expect(parseIdentityResidueMarkers(
      Buffer.from(JSON.stringify(unknown) + "\n"), scenario.admission,
    )).toBeNull();
  });

  test("retains structurally valid markers but fails semantic identity checks closed", () => {
    const scenario = fixture();
    const lines = markerStream(scenario.admission).trimEnd().split("\n");
    const env = JSON.parse(lines[1]!);
    env.payload.user_name = "intruder";
    lines[1] = JSON.stringify(env);
    scenario.remote = processResult(lines.join("\n") + "\n");
    const result = recordIdentityResidueFollowup(
      scenario.config,
      identityResidueFollowupConfirmation(scenario.config),
      join(scenario.root, "semantic-mismatch"),
      scenario.dependencies,
    );
    expect(result).toMatchObject({
      status: "unknown",
      marker_count: 8,
      last_marker_phase: "complete",
    });
  });

  test("requires exact whoami and WindowsIdentity account/SID matches", () => {
    for (const phaseIndex of [5, 6]) {
      const scenario = fixture();
      const lines = markerStream(scenario.admission).trimEnd().split("\n");
      const identity = JSON.parse(lines[phaseIndex]!);
      identity.payload.identity_sid = "S-1-5-21-0-0-0-9999";
      lines[phaseIndex] = JSON.stringify(identity);
      scenario.remote = processResult(lines.join("\n") + "\n");
      const result = recordIdentityResidueFollowup(
        scenario.config,
        identityResidueFollowupConfirmation(scenario.config),
        join(scenario.root, "security-identity-mismatch-" + phaseIndex),
        scenario.dependencies,
      );
      expect(result).toMatchObject({
        status: "unknown",
        marker_count: 8,
        last_marker_phase: "complete",
      });
    }
  });

  test("preserves an unknown phase marker and continues through complete", () => {
    const scenario = fixture();
    const lines = markerStream(scenario.admission).trimEnd().split("\n");
    const failedPhase = JSON.parse(lines[3]!);
    failedPhase.status = "unknown";
    failedPhase.payload = null;
    failedPhase.error = {
      type: "System.InvalidOperationException",
      hresult: -2146233079,
      category: "OperationStopped",
      fqid_sha256: "e".repeat(64),
      message_sha256: "f".repeat(64),
    };
    lines[3] = JSON.stringify(failedPhase);
    scenario.remote = processResult(lines.join("\n") + "\n");
    const result = recordIdentityResidueFollowup(
      scenario.config,
      identityResidueFollowupConfirmation(scenario.config),
      join(scenario.root, "phase-throw-continues"),
      scenario.dependencies,
    );
    expect(result).toMatchObject({
      status: "unknown",
      marker_count: 8,
      last_marker_phase: "complete",
      markers: [
        {}, {}, {}, { phase: "cim-system-snapshot", status: "unknown" },
        {}, {}, {}, { phase: "complete", status: "observed" },
      ],
    });
    expect(buildIdentityResidueFollowupScript()).toContain(
      "catch{E $o $n unknown $null",
    );
  });

  test("records one successful remote attempt and freezes 0700/0600 evidence", () => {
    const scenario = fixture();
    const evidence = join(scenario.root, "evidence");
    const result = recordIdentityResidueFollowup(
      scenario.config,
      identityResidueFollowupConfirmation(scenario.config),
      evidence,
      scenario.dependencies,
    );
    expect(result).toMatchObject({
      status: "observed",
      attempt: 1,
      timeout_ms: 30_000,
      stdin_length: 0,
      marker_count: 8,
      last_marker_phase: "complete",
      remote_payload_encoding: "gzip_base64_utf8",
      remote_compressed_length: buildIdentityResidueFollowupLoader().compressed.length,
      remote_loader_length: buildIdentityResidueFollowupLoader().loader.length,
      trailing_fragment_length: 0,
      stdout_truncated_line: false,
      hardware_action_performed: false,
      process_termination_performed: false,
    });
    expect(scenario.calls).toHaveLength(2);
    expect(scenario.calls[0]!.args[0]).toBe("-G");
    expect(scenario.calls[1]!.stdin).toEqual(Buffer.alloc(0));
    expect(scenario.calls[1]!.timeoutMs).toBe(30_000);
    expect(scenario.calls[1]!.args.at(-1)).toBe(buildIdentityResidueFollowupCommand());
    expect(lstatSync(evidence).mode & 0o777).toBe(0o700);
    for (const name of [
      "diagnostic-config.canonical.json", "remote-script.ps1", "remote-loader.ps1",
      "remote-payload.gzip", "ssh-effective.stdout.raw",
      "ssh-effective.stderr.raw", "ssh-effective-process.json", "stdout.raw", "stderr.raw",
      "remote-process.json", "diagnostic-record.json",
    ]) expect(lstatSync(join(evidence, name)).mode & 0o777).toBe(0o600);
    expect(result.process.stdout_sha256).toBe(sha256(readFileSync(join(evidence, "stdout.raw"))));
  });

  test("preserves the last flushed phase on timeout and never retries", () => {
    const scenario = fixture();
    const prefix = markerStream(scenario.admission).trimEnd().split("\n").slice(0, 5).join("\n") + "\n";
    const fragment = '{"ordinal":6,"phase":"whoami-user"';
    const partial = prefix + fragment;
    scenario.remote = processResult(partial, "", null, "SIGKILL", "ETIMEDOUT");
    const result = recordIdentityResidueFollowup(
      scenario.config,
      identityResidueFollowupConfirmation(scenario.config),
      join(scenario.root, "timeout"),
      scenario.dependencies,
    );
    expect(result).toMatchObject({
      status: "unknown",
      attempt: 1,
      marker_count: 5,
      last_marker_phase: "openssh-events",
      trailing_fragment_length: Buffer.byteLength(fragment),
      trailing_fragment_sha256: sha256(fragment),
      stdout_truncated_line: true,
      process: { timed_out: true, signal: "SIGKILL", retry_permitted: false },
    });
    expect(scenario.calls).toHaveLength(2);
  });

  test("never accepts a complete marker set followed by an unterminated fragment", () => {
    const scenario = fixture();
    const fragment = '{"unexpected":true';
    scenario.remote = processResult(markerStream(scenario.admission) + fragment);
    const result = recordIdentityResidueFollowup(
      scenario.config,
      identityResidueFollowupConfirmation(scenario.config),
      join(scenario.root, "complete-plus-fragment"),
      scenario.dependencies,
    );
    expect(result).toMatchObject({
      status: "unknown",
      marker_count: 8,
      last_marker_phase: "complete",
      trailing_fragment_length: Buffer.byteLength(fragment),
      trailing_fragment_sha256: sha256(fragment),
      stdout_truncated_line: true,
    });
  });

  test("detects admission inode replacement even when bytes are identical", () => {
    const scenario = fixture();
    scenario.onRemote = () => {
      const bytes = readFileSync(scenario.config.admission_config_path);
      rmSync(scenario.config.admission_config_path);
      writeSecure(scenario.config.admission_config_path, bytes);
    };
    const evidence = join(scenario.root, "inode-drift");
    const failure = capture(() => recordIdentityResidueFollowup(
      scenario.config,
      identityResidueFollowupConfirmation(scenario.config),
      evidence,
      scenario.dependencies,
    ));
    expect(failure.code).toBe("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_LOCAL_INPUT_DRIFT");
    expect(JSON.parse(readFileSync(join(evidence, "diagnostic-failure.json"), "utf8")))
      .toMatchObject({ remote_process: { stdout_length: scenario.remote.stdout.length } });
  });

  test("rejects existing evidence without spawning", () => {
    const scenario = fixture();
    const path = join(scenario.root, "occupied");
    writeFileSync(path, "occupied");
    expect(capture(() => recordIdentityResidueFollowup(
      scenario.config,
      identityResidueFollowupConfirmation(scenario.config),
      path,
      scenario.dependencies,
    )).code).toBe("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_EVIDENCE_DIRECTORY_INVALID");
    expect(scenario.calls).toHaveLength(0);
  });
});

interface Scenario {
  root: string;
  admission: M4fDirectAdmissionConfig;
  config: M4fDirectIdentityResidueFollowupConfig;
  effective: string;
  source: Buffer;
  transportSource: Buffer;
  remote: RawProcessResult;
  onRemote: (() => void) | null;
  calls: Array<{ args: readonly string[]; stdin: Buffer; timeoutMs: number }>;
  dependencies: FollowupDependencies;
}

function fixture(): Scenario {
  const root = mkdtempSync(join(tmpdir(), "synthia-single-residue-"));
  roots.push(root);
  const identity = join(root, "id");
  const knownHosts = join(root, "known");
  writeSecure(identity, "private-key\n");
  writeSecure(knownHosts, "100.96.223.49 ssh-ed25519 " + KEY.toString("base64") + "\n");
  const admission: M4fDirectAdmissionConfig = {
    schema: "synthia-m4f-direct-admission-config.v1",
    gate_id: "residue-source",
    target: {
      host: "100.96.223.49", port: 22, user: "admin", computer_name: "DESKTOP-DVFFB09",
      identity_name: "desktop-dvffb09\\admin",
      identity_sid: "S-1-5-21-2561815994-3878748218-1101284459-1001",
      identity_file: identity, known_hosts_file: knownHosts, known_hosts_host_token: "100.96.223.49",
      host_key_fingerprint: FINGERPRINT, expected_effective_config_sha256: null,
      acl_paths: ["C:\\Windows\\Temp"],
      vivado_executable: "D:\\Xilinx\\Vivado\\2021.1\\bin\\vivado.bat",
      bun_executable: "D:\\synthia-worker\\runtime\\bun.exe",
    },
  };
  const admissionPath = join(root, "admission.json");
  writeSecure(admissionPath, Buffer.from(JSON.stringify(admission) + "\n"));
  const effective = effectiveConfig(admission);
  const source = Buffer.from("followup-source");
  const transportSource = Buffer.from("transport-source");
  const config: M4fDirectIdentityResidueFollowupConfig = {
    schema: "synthia-m4f-direct-identity-residue-followup-config.v2",
    diagnostic_id: "single-residue-test-01",
    admission_config_path: admissionPath,
    admission_config_sha256: sha256(readFileSync(admissionPath)),
    expected_source_sha256: sha256(source),
    expected_transport_source_sha256: sha256(transportSource),
    expected_effective_config_sha256: sha256(effective),
  };
  const scenario: Scenario = {
    root, admission, config, effective, source, transportSource,
    remote: processResult(markerStream(admission)), onRemote: null, calls: [],
    dependencies: {} as FollowupDependencies,
  };
  let tick = 0;
  scenario.dependencies = {
    spawn(_executable, args, stdin, timeoutMs) {
      scenario.calls.push({ args, stdin: Buffer.from(stdin), timeoutMs });
      if (args[0] === "-G") return processResult(scenario.effective);
      scenario.onRemote?.();
      return scenario.remote;
    },
    sourceBytes: () => Buffer.from(scenario.source),
    transportSourceBytes: () => Buffer.from(scenario.transportSource),
    now: () => new Date("2026-08-28T08:00:00.000Z"),
    monotonicMs: () => (tick += 25),
  };
  return scenario;
}

function markerStream(admission: M4fDirectAdmissionConfig): string {
  const process = {
    pid: 100, parent_pid: 90, name: "powershell.exe", created: "2026-08-28T08:00:00.000Z",
    command_sha256: "a".repeat(64), class: "current",
  };
  const payloads: Record<string, Record<string, unknown>> = {
    "start": { current_pid: 100 },
    "env-identity": { computer_name: "DESKTOP-DVFFB09", user_domain: "WORKGROUP", user_name: "admin" },
    "processes-native": { sshd_count: 2, powershell_count: 1, conhost_count: 1 },
    "cim-system-snapshot": { current_pid: 100, processes: [process], resource: { free_kib: 100, total_kib: 200, process_count: 80 }, sshd_service: { exists: true, status: "Running", start_type: "Automatic" } },
    "openssh-events": { count: 2, first_id: 10, last_id: 11, sha256: "b".repeat(64) },
    "whoami-user": { exit_status: 0, identity_name: admission.target.identity_name, identity_sid: admission.target.identity_sid },
    "windows-identity": { identity_name: admission.target.identity_name, identity_sid: admission.target.identity_sid },
    "complete": { complete: true },
  };
  return FOLLOWUP_PHASES.map((phase, index) => JSON.stringify({
    ordinal: index + 1, phase, status: "observed", observed_at_utc: "2026-08-28T08:00:00.000Z",
    payload: payloads[phase], error: null,
  })).join("\n") + "\n";
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
  stdout = "", stderr = "", status: number | null = 0,
  signal: NodeJS.Signals | null = null, errorCode: string | null = null,
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
    expect(error).toBeInstanceOf(IdentityResidueFollowupFailure);
    return (error as IdentityResidueFollowupFailure).detail;
  }
  throw new Error("expected failure");
}
