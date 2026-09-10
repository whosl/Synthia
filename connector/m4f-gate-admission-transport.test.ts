import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
import {
  buildDirectPowerShellStdinCommand,
  buildDirectSshArguments,
  buildDirectSshEffectiveArguments,
  buildTargetAdmissionScript,
  directPowerShellStdinWrapperFact,
  executeM4fDirectAdmission,
  M4fDirectAdmissionFailure,
  M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE,
  M4F_DIRECT_ADMISSION_GUARDS,
  recordM4fDirectAdmission,
  type M4fDirectAdmissionConfig,
  type M4fDirectAdmissionDependencies,
  type RawProcessResult,
  validateM4fDirectAdmissionConfig,
} from "./scripts/m4f-gate-admission-transport.ts";

const roots: string[] = [];
const KEY_BYTES = Buffer.from(Array.from({ length: 48 }, (_, index) => index + 1));
const FINGERPRINT = "SHA256:" + createHash("sha256").update(KEY_BYTES).digest("base64").replace(/=+$/u, "");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("M4-F direct admission transport", () => {
  test("is a single Mac-to-100.96.223.49 admission path with exact target identity", () => {
    const scenario = fixture();
    const evidence = executeM4fDirectAdmission(scenario.config, scenario.dependencies);
    expect(evidence.result).toMatchObject({
      schema: "synthia-m4f-direct-admission-record.v1",
      action: "admission_snapshot",
      status: "observed",
      retry_permitted: false,
      target_binding: {
        host: "100.96.223.49",
        port: 22,
        user: "admin",
        computer_name: "DESKTOP-DVFFB09",
        identity_name: scenario.config.target.identity_name,
        identity_sid: scenario.config.target.identity_sid,
        host_key_fingerprint: FINGERPRINT,
      },
    });
    expect(scenario.calls).toHaveLength(2);
    expect(scenario.calls[0]).toMatchObject({ executable: "/usr/bin/ssh", timeoutMs: 15_000 });
    expect(scenario.calls[0]!.args[0]).toBe("-G");
    expect(scenario.calls[1]).toMatchObject({ executable: "/usr/bin/ssh", timeoutMs: 240_000 });
    expect(scenario.calls[1]!.args).toEqual(buildDirectSshArguments(scenario.config));
    const expectedStdin = Buffer.from(buildTargetAdmissionScript(scenario.config), "ascii");
    expect(scenario.calls[1]!.stdin).toEqual(expectedStdin);
    expect(evidence.result.process).toMatchObject({
      stdin_length: expectedStdin.length,
      stdin_sha256: createHash("sha256").update(expectedStdin).digest("hex"),
    });
    expect(evidence.result).toMatchObject({
      remote_wrapper_length: 409,
      remote_wrapper_sha256: "21ea7ae211c4433bced41512d6b54d37b259a7700ae3dffe63147c6ab5178407",
      remote_command_length: 1182,
    });
  });

  test("the real local ssh -G sees requesttty=false without diagnostics", () => {
    if (!existsSync("/usr/bin/ssh")) return;
    const scenario = fixture();
    const result = spawnSync(
      "/usr/bin/ssh",
      buildDirectSshEffectiveArguments(scenario.config),
      { encoding: "buffer" },
    );
    expect(result.status).toBe(0);
    expect(Buffer.from(result.stderr ?? Buffer.alloc(0)).length).toBe(0);
    const effective = Buffer.from(result.stdout ?? Buffer.alloc(0)).toString("utf8");
    expect(effective).toMatch(/^requesttty false$/mu);
    expect(effective).toMatch(/^serveraliveinterval 0$/mu);
    expect(effective).toMatch(/^serveralivecountmax 4$/mu);
    expect(effective).toMatch(/^warnweakcrypto no$/mu);
    expect(effective).not.toMatch(/^proxycommand\s/miu);
    expect(effective).not.toMatch(/^proxyjump\s/miu);
  });

  test("contains no retired jump topology or private-key-on-140 assumption", async () => {
    const source = await Bun.file(new URL("./scripts/m4f-gate-admission-transport.ts", import.meta.url)).text();
    for (const forbidden of [
      "100.66.198.60",
      "192.168.31.66",
      "DESKTOP-E380LR7",
      "identity_file_on_jump",
      "known_hosts_file_on_jump",
      "ControlPath=",
      "Administrator@",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain('const TARGET_HOST = "100.96.223.49"');
    expect(source).toContain('const TARGET_COMPUTER = "DESKTOP-DVFFB09"');
  });

  test("freezes the full public-key-only no-fallback SSH policy", () => {
    const scenario = fixture();
    const args = buildDirectSshArguments(scenario.config);
    for (const option of [
      "HostName=100.96.223.49",
      "User=admin",
      "BatchMode=yes",
      "ServerAliveInterval=0",
      "ServerAliveCountMax=4",
      "NumberOfPasswordPrompts=0",
      "IdentityAgent=none",
      "IdentitiesOnly=yes",
      "PubkeyAuthentication=yes",
      "PasswordAuthentication=no",
      "KbdInteractiveAuthentication=no",
      "GSSAPIAuthentication=no",
      "HostbasedAuthentication=no",
      "PreferredAuthentications=publickey",
      "StrictHostKeyChecking=yes",
      "ForwardAgent=no",
      "ClearAllForwardings=yes",
      "ProxyCommand=none",
      "ProxyJump=none",
      "ControlMaster=no",
      "ControlPersist=no",
      "WarnWeakCrypto=no",
    ]) {
      expect(args).toContain(option);
    }
    expect(args).toContain("IdentityFile=" + scenario.config.target.identity_file);
    expect(args).toContain("UserKnownHostsFile=" + scenario.config.target.known_hosts_file);
    expect(args).toContain("100.96.223.49");
  });

  test("disables SSH keepalive and relies only on the bounded outer timeout", () => {
    expect(M4F_DIRECT_ADMISSION_GUARDS).toMatchObject({
      networkTimeoutMs: 240_000,
      serverAliveIntervalSeconds: 0,
      serverAliveCountMax: 4,
      serverAliveEnabled: false,
    });
    const args = buildDirectSshArguments(fixture().config);
    expect(args).toContain("ServerAliveInterval=0");
    expect(args).toContain("ServerAliveCountMax=4");
    expect(args).not.toContain("ServerAliveInterval=10");
    expect(args).not.toContain("ServerAliveCountMax=2");
  });

  test("the only target action is the read-only admission snapshot", () => {
    const script = buildTargetAdmissionScript(fixture().config);
    const args = buildDirectSshArguments(fixture().config);
    expect(args.at(-1)).toBe(buildDirectPowerShellStdinCommand());
    expect(args.join(" ").length).toBeLessThan(8191);
    expect(args.at(-1)).toContain("-EncodedCommand ");
    expect(script).toContain("M4F_DIRECT_TARGET_IDENTITY_MISMATCH");
    expect(script).toContain("[Console]::OutputEncoding");
    expect(script).toContain("Get-CimInstance Win32_LogicalDisk");
    expect(script).toContain("Get-Acl -LiteralPath");
    expect(script).toContain("Get-NetTCPConnection -State Listen");
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("[Diagnostics.Stopwatch]::StartNew()");
    expect(script).toContain("$timings.total_before_json_ms");
    expect(script).toContain("([DateTime]$_.CreationDate).ToUniversalTime()");
    expect(script).toContain("hardware_action_performed=$false");
    expect(script).not.toMatch(/(?:New|Set|Remove|Copy|Move)-Item|Set-Acl|Set-Content|Add-Content|Out-File/iu);
    expect(script).not.toMatch(/Start-Process|[&]\s*[^\r\n]*vivado|open_hw|connect_hw_server|open_hw_target|program_hw|write_cfgmem/iu);
    expect(script).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|curl|wget/iu);
  });

  test("freezes the short PowerShell stdin wrapper and all pre-execution preferences", () => {
    const command = buildDirectPowerShellStdinCommand();
    expect(command).not.toContain("-Command -");
    const encoded = command.split("-EncodedCommand ")[1]!;
    expect(Buffer.from(encoded, "base64").toString("utf16le"))
      .toBe(M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE);
    const preReadLines = [
      '$ErrorActionPreference="Stop"',
      '$ProgressPreference="SilentlyContinue"',
      '$InformationPreference="SilentlyContinue"',
      '$VerbosePreference="SilentlyContinue"',
      '$DebugPreference="SilentlyContinue"',
      '$WarningPreference="SilentlyContinue"',
      "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
    ];
    for (const line of preReadLines) {
      expect(M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE).toContain(line);
      expect(M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE.indexOf(line))
        .toBeLessThan(M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE.indexOf("ReadToEnd"));
    }
    expect(M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE).toContain("$s=[Console]::In.ReadToEnd()");
    expect(M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE).toContain("& ([ScriptBlock]::Create($s))");
    expect(M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE.indexOf("ReadToEnd"))
      .toBeLessThan(M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE.indexOf("ScriptBlock]::Create"));
    expect(directPowerShellStdinWrapperFact()).toEqual({
      source_length: 409,
      source_sha256: "21ea7ae211c4433bced41512d6b54d37b259a7700ae3dffe63147c6ab5178407",
      command_length: 1182,
    });
    expect(command.length).toBeLessThan(8191);
  });

  test("rejects every host, hostname, user, identity, host token, and schema drift before spawn", () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => { value.extra = true; },
      (value) => { (value.target as Record<string, unknown>).host = "100.66.198.60"; },
      (value) => { (value.target as Record<string, unknown>).port = 2222; },
      (value) => { (value.target as Record<string, unknown>).user = "Administrator"; },
      (value) => { (value.target as Record<string, unknown>).computer_name = "DESKTOP-E380LR7"; },
      (value) => { (value.target as Record<string, unknown>).identity_name = "desktop-other\\admin"; },
      (value) => { (value.target as Record<string, unknown>).identity_sid = "S-1-invalid"; },
      (value) => { (value.target as Record<string, unknown>).known_hosts_host_token = "[100.96.223.49]:22"; },
    ];
    for (const mutate of mutations) {
      const scenario = fixture();
      const value = structuredClone(scenario.config) as unknown as Record<string, unknown>;
      mutate(value);
      const failure = capture(() => validateM4fDirectAdmissionConfig(value));
      expect(failure).toMatchObject({
        code: "M4F_DIRECT_ADMISSION_CONFIG_INVALID",
        stage: "config",
        effect_state: "not_started",
        retry_permitted: false,
      });
      expect(scenario.calls).toHaveLength(0);
    }
  });

  test("requires one exact 0600 host-key entry and freezes both local input hashes", () => {
    const scenario = fixture();
    const result = executeM4fDirectAdmission(scenario.config, scenario.dependencies).result;
    expect(result.local_inputs_before).toEqual(result.local_inputs_after);
    expect(result.local_inputs_before.map((fact) => fact.label)).toEqual(["identity_file", "known_hosts_file"]);
    expect(result.local_inputs_before.every((fact) => fact.mode === 0o600 && fact.link_count === 1)).toBe(true);
    expect(result.local_inputs_before.every((fact) => /^[0-9a-f]{64}$/u.test(fact.sha256))).toBe(true);

    const mismatch = fixture();
    mismatch.config.target.host_key_fingerprint = "SHA256:" + "A".repeat(43);
    expect(capture(() => executeM4fDirectAdmission(mismatch.config, mismatch.dependencies)).code)
      .toBe("M4F_DIRECT_ADMISSION_HOST_KEY_MISMATCH");
    expect(mismatch.calls).toHaveLength(0);

    const permissive = fixture();
    chmodSync(permissive.config.target.identity_file, 0o644);
    expect(capture(() => executeM4fDirectAdmission(permissive.config, permissive.dependencies)).code)
      .toBe("M4F_DIRECT_ADMISSION_LOCAL_INPUT_UNTRUSTED");
    expect(permissive.calls).toHaveLength(0);

    const readOnly = fixture();
    chmodSync(readOnly.config.target.identity_file, 0o400);
    expect(capture(() => executeM4fDirectAdmission(readOnly.config, readOnly.dependencies)).code)
      .toBe("M4F_DIRECT_ADMISSION_LOCAL_INPUT_UNTRUSTED");
    expect(readOnly.calls).toHaveLength(0);
  });

  test("audits the complete ssh -G binding before the network attempt", () => {
    const drifts: Array<[string, string, string]> = [
      ["hostname", "100.96.223.49", "100.66.198.60"],
      ["user", "admin", "Administrator"],
      ["connecttimeout", "15", "30"],
      ["connectionattempts", "1", "2"],
      ["serveraliveinterval", "0", "30"],
      ["serveralivecountmax", "4", "2"],
      ["numberofpasswordprompts", "0", "1"],
      ["identityagent", "none", "SSH_AUTH_SOCK"],
      ["identitiesonly", "yes", "no"],
      ["pubkeyauthentication", "true", "false"],
      ["passwordauthentication", "no", "yes"],
      ["kbdinteractiveauthentication", "no", "yes"],
      ["gssapiauthentication", "no", "yes"],
      ["hostbasedauthentication", "no", "yes"],
      ["preferredauthentications", "publickey", "password"],
      ["stricthostkeychecking", "true", "false"],
      ["forwardagent", "no", "yes"],
      ["clearallforwardings", "yes", "no"],
      ["permitlocalcommand", "no", "yes"],
      ["controlmaster", "false", "auto"],
      ["controlpersist", "no", "600"],
      ["warnweakcrypto", "no", "yes"],
      ["requesttty", "false", "true"],
    ];
    for (const [option, expected, drift] of drifts) {
      const scenario = fixture();
      scenario.effective = scenario.effective.replace(option + " " + expected, option + " " + drift);
      const failure = capture(() => executeM4fDirectAdmission(scenario.config, scenario.dependencies));
      expect(failure).toMatchObject({
        code: "M4F_DIRECT_ADMISSION_EFFECTIVE_CONFIG_MISMATCH",
        stage: "local_preflight",
        option,
        effect_state: "not_started",
        retry_permitted: false,
      });
      expect(scenario.calls).toHaveLength(1);
    }
    for (const forbidden of ["proxycommand proxy", "proxyjump jump-host"]) {
      const scenario = fixture();
      scenario.effective += forbidden + "\n";
      const failure = capture(() => executeM4fDirectAdmission(scenario.config, scenario.dependencies));
      expect(failure).toMatchObject({
        code: "M4F_DIRECT_ADMISSION_EFFECTIVE_CONFIG_MISMATCH",
        stage: "local_preflight",
        option: forbidden.split(" ")[0],
        effect_state: "not_started",
        retry_permitted: false,
      });
      expect(scenario.calls).toHaveLength(1);
    }
  });

  test("pins the approved effective config hash for later Gates", () => {
    const observed = fixture();
    expect(executeM4fDirectAdmission(observed.config, observed.dependencies).result.effective_config_sha256)
      .toBe(createHash("sha256").update(observed.effective).digest("hex"));

    const pinned = fixture();
    pinned.config.target.expected_effective_config_sha256 = createHash("sha256").update(pinned.effective).digest("hex");
    expect(executeM4fDirectAdmission(pinned.config, pinned.dependencies).result.status).toBe("observed");

    const drift = fixture();
    drift.config.target.expected_effective_config_sha256 = "0".repeat(64);
    expect(capture(() => executeM4fDirectAdmission(drift.config, drift.dependencies)).code)
      .toBe("M4F_DIRECT_ADMISSION_EFFECTIVE_CONFIG_HASH_MISMATCH");
    expect(drift.calls).toHaveLength(1);
  });

  test("is single-shot and classifies timeout, signal, and nonzero exit as unknown with no retry", () => {
    for (const raw of [
      processResult("", "", null, null, "ETIMEDOUT"),
      processResult("", "", null, "SIGTERM", null),
      processResult("", "ssh failed", 255, null, null),
    ]) {
      const scenario = fixture();
      scenario.networkResult = raw;
      const failure = capture(() => executeM4fDirectAdmission(scenario.config, scenario.dependencies));
      expect(failure).toMatchObject({
        code: "M4F_DIRECT_ADMISSION_TRANSPORT_FAILED",
        stage: "network",
        effect_state: "unknown",
        retry_permitted: false,
      });
      expect(scenario.calls).toHaveLength(2);
      expect((failure.process as Record<string, unknown>).retry_permitted).toBe(false);
      expect((failure.process as Record<string, unknown>).outcome_ambiguous).toBe(true);
    }
  });

  test("classifies local key or known-hosts drift after spawn as unknown and never retries", () => {
    const scenario = fixture();
    scenario.onNetwork = () => {
      writeFileSync(scenario.config.target.identity_file, "changed-private-key-bytes\n", { mode: 0o600 });
      chmodSync(scenario.config.target.identity_file, 0o600);
    };
    const failure = capture(() => executeM4fDirectAdmission(scenario.config, scenario.dependencies));
    expect(failure).toMatchObject({
      code: "M4F_DIRECT_ADMISSION_LOCAL_INPUT_DRIFT",
      stage: "network",
      effect_state: "unknown",
      retry_permitted: false,
    });
    expect(scenario.calls).toHaveLength(2);
  });

  test("freezes the executing source before network use and rejects source replacement", () => {
    const scenario = fixture();
    let reads = 0;
    scenario.dependencies.sourceBytes = () => Buffer.from(reads++ === 0 ? "source-before" : "source-after");
    const failure = capture(() => executeM4fDirectAdmission(scenario.config, scenario.dependencies));
    expect(failure).toMatchObject({
      code: "M4F_DIRECT_ADMISSION_SOURCE_DRIFT",
      stage: "network",
      effect_state: "unknown",
      retry_permitted: false,
    });
    expect(scenario.calls).toHaveLength(2);
  });

  test("strictly binds returned hostname, login identity, schema, and ACL path set", () => {
    const mutations: Array<(snapshot: Record<string, unknown>) => void> = [
      (snapshot) => { (snapshot.identity as Record<string, unknown>).computer_name = "DESKTOP-E380LR7"; },
      (snapshot) => { (snapshot.identity as Record<string, unknown>).identity_name = "desktop-dvffb09\\other"; },
      (snapshot) => { (snapshot.identity as Record<string, unknown>).identity_sid = "S-1-5-21-9-9-9-1001"; },
      (snapshot) => { snapshot.extra = true; },
      (snapshot) => { (snapshot.acl as unknown[]).pop(); },
      (snapshot) => { (snapshot.acl as unknown[]).push(structuredClone((snapshot.acl as unknown[])[0])); },
      (snapshot) => { ((snapshot.acl as Array<Record<string, unknown>>)[0]!).path = "C:\\wrong"; },
    ];
    for (const mutate of mutations) {
      const scenario = fixture();
      mutate(scenario.snapshot);
      const failure = capture(() => executeM4fDirectAdmission(scenario.config, scenario.dependencies));
      expect(failure).toMatchObject({
        code: "M4F_DIRECT_ADMISSION_SNAPSHOT_INVALID",
        stage: "output_validation",
        effect_state: "unknown",
        retry_permitted: false,
      });
      expect(failure).toMatchObject({
        process: { retry_permitted: false },
        config_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        source_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      expect(scenario.calls).toHaveLength(2);
    }
  });

  test("rejects structurally incomplete volume, file, ACL, listener, and process facts", () => {
    const mutations: Array<(snapshot: Record<string, unknown>) => void> = [
      (snapshot) => { snapshot.volumes = []; },
      (snapshot) => { snapshot.vivado = {}; },
      (snapshot) => { snapshot.bun = { path: "D:\\wrong", exists: false, length: null, sha256: null, file_version: null }; },
      (snapshot) => { (snapshot.acl as unknown[])[0] = { path: "C:\\Windows\\Temp" }; },
      (snapshot) => { (snapshot.listeners as unknown[])[0] = { address: "0.0.0.0", port: 22, pid: 123 }; },
      (snapshot) => { (snapshot.relevant_processes as unknown[])[0] = { pid: 123 }; },
      (snapshot) => { snapshot.stage_elapsed_ms = {}; },
      (snapshot) => { (snapshot.stage_elapsed_ms as Record<string, unknown>).acl_ms = -1; },
    ];
    for (const mutate of mutations) {
      const scenario = fixture();
      mutate(scenario.snapshot);
      expect(capture(() => executeM4fDirectAdmission(scenario.config, scenario.dependencies)).code)
        .toBe("M4F_DIRECT_ADMISSION_SNAPSHOT_INVALID");
    }
  });

  test("records only into a new 0700 evidence root with 0600 frozen files", () => {
    const scenario = fixture();
    const evidence = join(scenario.root, "new-direct-evidence");
    recordM4fDirectAdmission(scenario.config, evidence, scenario.dependencies);
    expect(lstatSync(evidence).mode & 0o777).toBe(0o700);
    for (const name of [
      "admission-record.json",
      "admission-config.canonical.json",
      "direct-ssh-effective-config.txt",
      "powershell-stdin-wrapper.ps1",
      "target-admission-stdin.ps1",
      "target-admission-snapshot.json",
    ]) {
      expect(lstatSync(join(evidence, name)).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(join(evidence, "admission-config.canonical.json"), "utf8"))
      .toContain('"host":"100.96.223.49"');
    expect(readFileSync(join(evidence, "target-admission-stdin.ps1")))
      .toEqual(Buffer.from(buildTargetAdmissionScript(scenario.config), "ascii"));
    expect(readFileSync(join(evidence, "powershell-stdin-wrapper.ps1"), "ascii"))
      .toBe(M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE);

    const duplicate = capture(() => recordM4fDirectAdmission(scenario.config, evidence, scenario.dependencies));
    expect(duplicate.code).toBe("M4F_DIRECT_ADMISSION_EVIDENCE_DIRECTORY_INVALID");
    expect(scenario.calls).toHaveLength(2);
  });

  test("freezes bounded raw SSH stderr and binds it to failure length and hash", () => {
    const scenario = fixture();
    const rawStderr = Buffer.from("Timeout, server 100.96.223.49 not responding.\r\n", "ascii");
    scenario.networkResult = processResult("", rawStderr.toString("ascii"), 255);
    const evidence = join(scenario.root, "failed-direct-evidence");
    const failure = capture(() => recordM4fDirectAdmission(
      scenario.config,
      evidence,
      scenario.dependencies,
    ));
    expect(failure).toMatchObject({
      code: "M4F_DIRECT_ADMISSION_TRANSPORT_FAILED",
      stage: "network",
      effect_state: "unknown",
      retry_permitted: false,
      process: {
        stderr_length: rawStderr.length,
        stderr_sha256: createHash("sha256").update(rawStderr).digest("hex"),
        retry_permitted: false,
      },
    });
    expect(lstatSync(join(evidence, "admission-failure.json")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(evidence, "ssh-stderr.raw")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(evidence, "ssh-stderr.raw"))).toEqual(rawStderr);
    expect(readFileSync(join(evidence, "ssh-stderr.raw"))).not.toEqual(scenario.calls[1]!.stdin);
    const recorded = JSON.parse(readFileSync(join(evidence, "admission-failure.json"), "utf8"));
    expect(recorded.process.stderr_length).toBe(rawStderr.length);
    expect(recorded.process.stderr_sha256)
      .toBe(createHash("sha256").update(rawStderr).digest("hex"));
    expect(scenario.calls).toHaveLength(2);
  });
});

interface Scenario {
  root: string;
  config: M4fDirectAdmissionConfig;
  dependencies: M4fDirectAdmissionDependencies;
  calls: Array<{ executable: string; args: readonly string[]; stdin: Buffer; timeoutMs: number }>;
  effective: string;
  snapshot: Record<string, unknown>;
  networkResult: RawProcessResult | null;
  onNetwork: (() => void) | null;
}

function fixture(): Scenario {
  const root = mkdtempSync(join(tmpdir(), "synthia-m4f-direct-admission-"));
  roots.push(root);
  const identity = join(root, "target_id");
  const knownHosts = join(root, "target_known_hosts");
  writeFileSync(identity, "not-a-real-private-key\n", { mode: 0o600 });
  writeFileSync(knownHosts, "100.96.223.49 ssh-ed25519 " + KEY_BYTES.toString("base64") + "\n", { mode: 0o600 });
  chmodSync(identity, 0o600);
  chmodSync(knownHosts, 0o600);
  const config: M4fDirectAdmissionConfig = {
    schema: "synthia-m4f-direct-admission-config.v1",
    gate_id: "direct-admission-test",
    target: {
      host: "100.96.223.49",
      port: 22,
      user: "admin",
      computer_name: "DESKTOP-DVFFB09",
      identity_name: "desktop-dvffb09\\admin",
      identity_sid: "S-1-5-21-100-200-300-1001",
      identity_file: identity,
      known_hosts_file: knownHosts,
      known_hosts_host_token: "100.96.223.49",
      host_key_fingerprint: FINGERPRINT,
      expected_effective_config_sha256: null,
      acl_paths: ["C:\\Windows\\Temp", "D:\\synthia-worker", "D:\\Xilinx\\Vivado\\2021.1"],
      vivado_executable: "D:\\Xilinx\\Vivado\\2021.1\\bin\\vivado.bat",
      bun_executable: "D:\\synthia-worker\\runtime\\bun-1.4.1\\bun.exe",
    },
  };
  const scenario: Scenario = {
    root,
    config,
    calls: [],
    effective: effectiveConfig(config),
    snapshot: snapshot(config),
    networkResult: null,
    onNetwork: null,
    dependencies: {} as M4fDirectAdmissionDependencies,
  };
  scenario.dependencies = {
    spawn(executable, args, stdin, timeoutMs) {
      scenario.calls.push({ executable, args, stdin: Buffer.from(stdin), timeoutMs });
      if (scenario.calls.length === 1) return processResult(scenario.effective);
      scenario.onNetwork?.();
      return scenario.networkResult ?? processResult(JSON.stringify(scenario.snapshot) + "\n");
    },
    sourceBytes: () => Buffer.from("frozen-direct-source"),
    now: () => new Date("2026-08-28T01:02:03.000Z"),
  };
  return scenario;
}

function effectiveConfig(config: M4fDirectAdmissionConfig): string {
  return [
    "host 100.96.223.49",
    "hostname 100.96.223.49",
    "user admin",
    "port 22",
    "batchmode yes",
    "connecttimeout 15",
    "connectionattempts 1",
    "serveraliveinterval 0",
    "serveralivecountmax 4",
    "numberofpasswordprompts 0",
    "identityagent none",
    "identitiesonly yes",
    "pubkeyauthentication true",
    "passwordauthentication no",
    "kbdinteractiveauthentication no",
    "gssapiauthentication no",
    "hostbasedauthentication no",
    "preferredauthentications publickey",
    "stricthostkeychecking true",
    "forwardagent no",
    "clearallforwardings yes",
    "permitlocalcommand no",
    "controlmaster false",
    "controlpersist no",
    "warnweakcrypto no",
    "requesttty false",
    "identityfile " + config.target.identity_file,
    "userknownhostsfile " + config.target.known_hosts_file,
    "globalknownhostsfile /dev/null",
    "",
  ].join("\n");
}

function snapshot(config: M4fDirectAdmissionConfig): Record<string, unknown> {
  return {
    schema: "synthia-m4f-direct-target-admission-snapshot.v1",
    observed_at_utc: "2026-08-28T01:01:00.0000000Z",
    identity: {
      computer_name: "DESKTOP-DVFFB09",
      identity_name: config.target.identity_name,
      identity_sid: config.target.identity_sid,
    },
    volumes: [
      { device_id: "C:", drive_type: 3, free_bytes: 12_000_000_000, size_bytes: 100_000_000_000, file_system: "NTFS" },
      { device_id: "D:", drive_type: 3, free_bytes: 300_000_000_000, size_bytes: 500_000_000_000, file_system: "NTFS" },
    ],
    acl: config.target.acl_paths.map((path) => ({
      path,
      exists: true,
      owner_sid: "S-1-5-32-544",
      protected: true,
      reparse: false,
      rules: [{
        sid: "S-1-5-18",
        type: "Allow",
        rights: 2032127,
        inherited: false,
        inheritance: "ContainerInherit, ObjectInherit",
        propagation: "None",
      }],
    })),
    listeners: [{ address: "0.0.0.0", port: 8443, pid: 123 }],
    relevant_processes: [{ pid: 123, parent_pid: 1, name: "node.exe", executable_path: "D:\\synthia-worker\\node.exe", creation_date: "2026-08-28T00:00:00Z" }],
    vivado: { path: config.target.vivado_executable, exists: true, length: 100, sha256: "a".repeat(64), file_version: "2021.1" },
    bun: { path: config.target.bun_executable, exists: true, length: 100, sha256: "b".repeat(64), file_version: "1.4.1" },
    stage_elapsed_ms: {
      identity_ms: 10,
      volumes_ms: 20,
      acl_ms: 30,
      listeners_ms: 40,
      relevant_processes_ms: 50,
      vivado_ms: 60,
      bun_ms: 1,
      total_before_json_ms: 211,
    },
    hardware_action_performed: false,
  };
}

function processResult(
  stdout = "",
  stderr = "",
  status: number | null = 0,
  signal: NodeJS.Signals | null = null,
  errorCode: string | null = null,
): RawProcessResult {
  return { status, signal, errorCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

function capture(action: () => unknown): Record<string, unknown> {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(M4fDirectAdmissionFailure);
    return (error as M4fDirectAdmissionFailure).detail;
  }
  throw new Error("expected M4fDirectAdmissionFailure");
}
