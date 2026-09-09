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
import {
  admissionV2ParseOnlyConfirmation,
  AdmissionV2ParseOnlyFailure,
  buildAdmissionV2ParseOnlyCommand,
  executeAdmissionV2ParseOnly,
  planAdmissionV2ParseOnly,
  validateAdmissionV2ParseOnlyConfig,
  type AdmissionV2ParseOnlyDependencies,
  type AdmissionV2ParseOnlyConfig,
} from "./scripts/m4f-direct-admission-v2-parse-only.ts";
import { buildAdmissionV2Script, type M4fDirectAdmissionV2Config } from "./scripts/m4f-direct-admission-v2.ts";
import type { M4fDirectAdmissionConfig, RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const HASH = "a".repeat(64);
const roots: string[] = [];
const KEY = Buffer.from(Array.from({ length: 48 }, (_, index) => index + 1));
const FINGERPRINT = "SHA256:" + createHash("sha256").update(KEY)
  .digest("base64").replace(/=+$/u, "");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(): Record<string, unknown> {
  return {
    schema: "synthia-m4f-direct-admission-v2-parse-only-config.v1",
    parse_id: "m4f-direct-admission-v2-parse-test-validator-01",
    admission_v2_config_path: "/private/tmp/admission-v2.json",
    admission_v2_config_sha256: HASH,
    expected_source_sha256: HASH,
    expected_admission_v2_source_sha256: HASH,
    expected_transport_source_sha256: HASH,
  };
}

describe("M4-F direct Admission v2 PowerShell parse-only gate", () => {
  test("parses and constructs the target without invoking its body", () => {
    const target = "$global:SynthiaMustNotRun=$true\n".repeat(100);
    const packed = buildAdmissionV2ParseOnlyCommand(target);
    expect(packed.command.length).toBeLessThanOrEqual(8191);
    expect(packed.loader).toContain("Language.Parser]::ParseInput($s");
    expect(packed.loader).toContain("$b=[ScriptBlock]::Create($s)");
    expect(packed.loader).toContain("target_body_not_invoked=$true");
    expect(packed.loader).not.toContain("&$b");
    expect(packed.loader).not.toContain("$b.Invoke");
    expect(packed.command).not.toContain("SynthiaMustNotRun");
  });

  test("binds an exact strict config and confirmation", () => {
    expect(validateAdmissionV2ParseOnlyConfig(config())).toEqual(config());
    expect(admissionV2ParseOnlyConfirmation(config())).toMatch(
      /^SYNTHIA_M4F_DIRECT_ADMISSION_V2_WINDOWS_PARSE_ONLY:[a-z0-9-]+:[0-9a-f]{64}$/u,
    );
    for (const changed of [
      { ...config(), extra: true },
      { ...config(), parse_id: "../bad" },
      { ...config(), admission_v2_config_path: "/private/tmp/../bad" },
      { ...config(), expected_source_sha256: "bad" },
      { ...config(), parse_id: "m4f-direct-admission-v2-parse-prod-20260828-01" },
    ]) {
      expect(() => validateAdmissionV2ParseOnlyConfig(changed))
        .toThrow(AdmissionV2ParseOnlyFailure);
    }
  });

  test("plans with zero network and freezes a self-contained successful record", () => {
    const scenario = fixture();
    const plan = planAdmissionV2ParseOnly(scenario.config, scenario.dependencies);
    expect(plan).toMatchObject({
      status: "planned_not_executed",
      admission_id: scenario.wrapper.admission_id,
      source_sha256: scenario.targetSourceHash,
      target_body_not_invoked: true,
      network_attempted: false,
    });
    expect(scenario.calls).toHaveLength(0);

    const evidence = join(scenario.root, "evidence");
    const record = executeAdmissionV2ParseOnly(
      scenario.config,
      admissionV2ParseOnlyConfirmation(scenario.config),
      evidence,
      scenario.dependencies,
    );
    expect(record).toMatchObject({
      status: "parsed_not_invoked",
      admission_id: scenario.wrapper.admission_id,
      target_body_not_invoked: true,
      transport_inputs_before: scenario.expectedInputs,
      transport_inputs_after: scenario.expectedInputs,
    });
    expect(scenario.calls).toHaveLength(2);
    expect(scenario.calls.every((call) => call.stdin.length === 0)).toBe(true);
    expect(lstatSync(evidence).mode & 0o777).toBe(0o700);
    for (const name of [
      "parse-config.canonical.json", "target-source.ps1", "parse-loader.ps1",
      "ssh-effective.stdout.raw", "ssh-effective.stderr.raw", "ssh-effective-process.json",
      "stdout.raw", "stderr.raw", "remote-process.json", "parse-record.json",
    ]) {
      expect(lstatSync(join(evidence, name)).mode & 0o777).toBe(0o600);
    }
  });

  test("classifies a deterministic target parse rejection separately from transport", () => {
    const scenario = fixture();
    scenario.remote = processResult(JSON.stringify(parsePayload(scenario, "parse_rejected")) + "\n", "", 2);
    const evidence = join(scenario.root, "parse-rejected");
    const failure = capture(() => executeAdmissionV2ParseOnly(
      scenario.config,
      admissionV2ParseOnlyConfirmation(scenario.config),
      evidence,
      scenario.dependencies,
    ));
    expect(failure).toMatchObject({
      code: "M4F_DIRECT_ADMISSION_V2_TARGET_PARSE_REJECTED",
      remote_effect_state: "read_only_observed",
      parse_result: { status: "parse_rejected", parse_error_count: 1 },
    });
    expect(JSON.parse(readFileSync(join(evidence, "parse-failure.json"), "utf8")))
      .toMatchObject({
        remote_effect_state: "read_only_observed",
        remote_process: { exit_status: 2 },
        transport_inputs_before: scenario.expectedInputs,
        transport_inputs_after: scenario.expectedInputs,
      });
  });

  test("freezes timeout facts and rejects local drift before network", () => {
    const timeout = fixture();
    timeout.remote = processResult("partial", "diagnostic", null, "SIGKILL", "ETIMEDOUT");
    const evidence = join(timeout.root, "timeout");
    expect(capture(() => executeAdmissionV2ParseOnly(
      timeout.config,
      admissionV2ParseOnlyConfirmation(timeout.config),
      evidence,
      timeout.dependencies,
    )).code).toBe("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_TRANSPORT_FAILED");
    expect(JSON.parse(readFileSync(join(evidence, "parse-failure.json"), "utf8")))
      .toMatchObject({
        remote_process: { timed_out: true, signal: "SIGKILL" },
        transport_inputs_before: timeout.expectedInputs,
        transport_inputs_after: timeout.expectedInputs,
      });
    expect(timeout.calls).toHaveLength(2);

    const stale = fixture();
    stale.gateSource = Buffer.from("changed");
    expect(capture(() => planAdmissionV2ParseOnly(stale.config, stale.dependencies)).code)
      .toBe("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_SOURCE_MISMATCH");
    expect(stale.calls).toHaveLength(0);

    const wrong = fixture();
    const wrongEvidence = join(wrong.root, "wrong-confirmation");
    expect(capture(() => executeAdmissionV2ParseOnly(
      wrong.config, "wrong", wrongEvidence, wrong.dependencies,
    )).code).toBe("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_CONFIRMATION_REQUIRED");
    expect(existsSync(wrongEvidence)).toBe(false);
    expect(wrong.calls).toHaveLength(0);
  });

  test("freezes the observed effective-config hash when ssh -G drifts", () => {
    const scenario = fixture();
    scenario.effective = "host changed\n";
    const evidence = join(scenario.root, "effective-drift");
    expect(capture(() => executeAdmissionV2ParseOnly(
      scenario.config,
      admissionV2ParseOnlyConfirmation(scenario.config),
      evidence,
      scenario.dependencies,
    )).code).toBe("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_EFFECTIVE_FAILED");
    const failure = JSON.parse(readFileSync(join(evidence, "parse-failure.json"), "utf8"));
    expect(failure.effective_config_sha256).toBe(sha256("host changed\n"));
    expect(failure.effective_config_sha256)
      .not.toBe(scenario.admission.target.expected_effective_config_sha256);
    expect(scenario.calls).toHaveLength(1);
  });

  test("never reports not-started when a post-spawn bound input becomes unreadable", () => {
    const scenario = fixture();
    const spawn = scenario.dependencies.spawn;
    scenario.dependencies.spawn = (executable, args, stdin, timeoutMs) => {
      const result = spawn(executable, args, stdin, timeoutMs);
      if (args[0] !== "-G") {
        writeSecure(scenario.config.admission_v2_config_path, JSON.stringify({
          ...scenario.wrapper,
          admission_id: "changed-after-parse-spawn",
        }) + "\n");
      }
      return result;
    };
    const evidence = join(scenario.root, "after-binding-failure");
    const failure = capture(() => executeAdmissionV2ParseOnly(
      scenario.config,
      admissionV2ParseOnlyConfirmation(scenario.config),
      evidence,
      scenario.dependencies,
    ));
    expect(failure).toMatchObject({
      remote_effect_state: "read_only_unknown",
      stage: "network_postflight",
    });
    expect(JSON.parse(readFileSync(join(evidence, "parse-failure.json"), "utf8")))
      .toMatchObject({
        remote_effect_state: "read_only_unknown",
        stage: "network_postflight",
        remote_process: { exit_status: 0 },
        attempt: 1,
        timeout_ms: 30_000,
        stdin_length: 0,
      });
  });
});

interface Scenario {
  root: string;
  admission: M4fDirectAdmissionConfig;
  wrapper: M4fDirectAdmissionV2Config;
  config: AdmissionV2ParseOnlyConfig;
  targetSourceHash: string;
  gateSource: Buffer;
  admissionSource: Buffer;
  transportSource: Buffer;
  effective: string;
  remote: RawProcessResult;
  expectedInputs: unknown[];
  calls: Array<{ args: readonly string[]; stdin: Buffer; timeoutMs: number }>;
  dependencies: AdmissionV2ParseOnlyDependencies;
}

function fixture(): Scenario {
  const root = mkdtempSync(join(tmpdir(), "synthia-admission-v2-parse-"));
  roots.push(root);
  const identity = join(root, "id");
  const knownHosts = join(root, "known");
  writeSecure(identity, "private-key\n");
  writeSecure(knownHosts, "100.96.223.49 ssh-ed25519 " + KEY.toString("base64") + "\n");
  const admission: M4fDirectAdmissionConfig = {
    schema: "synthia-m4f-direct-admission-config.v1",
    gate_id: "admission-v2-parse-base",
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
      bun_executable: "D:\\synthia-worker\\runtime\\bun-1.3.14\\bun.exe",
    },
  };
  const effective = effectiveConfig(admission);
  admission.target.expected_effective_config_sha256 = sha256(effective);
  const admissionPath = join(root, "admission.json");
  writeSecure(admissionPath, JSON.stringify(admission) + "\n");
  const gateSource = Buffer.from("parse-gate-source");
  const admissionSource = Buffer.from("admission-v2-source");
  const transportSource = Buffer.from("transport-source");
  const wrapper: M4fDirectAdmissionV2Config = {
    schema: "synthia-m4f-direct-admission-v2-config.v1",
    admission_id: "admission-v2-parse-test-01",
    admission_config_path: admissionPath,
    admission_config_sha256: sha256(readFileSync(admissionPath)),
    expected_source_sha256: sha256(admissionSource),
    expected_transport_source_sha256: sha256(transportSource),
    expected_loader_source_sha256: HASH,
  };
  const wrapperPath = join(root, "admission-v2.json");
  writeSecure(wrapperPath, JSON.stringify(wrapper) + "\n");
  const config: AdmissionV2ParseOnlyConfig = {
    schema: "synthia-m4f-direct-admission-v2-parse-only-config.v1",
    parse_id: "admission-v2-parse-test-01",
    admission_v2_config_path: wrapperPath,
    admission_v2_config_sha256: sha256(readFileSync(wrapperPath)),
    expected_source_sha256: sha256(gateSource),
    expected_admission_v2_source_sha256: sha256(admissionSource),
    expected_transport_source_sha256: sha256(transportSource),
  };
  const source = buildAdmissionV2Script(admission);
  const scenario = {
    root,
    admission,
    wrapper,
    config,
    targetSourceHash: sha256(source),
    gateSource,
    admissionSource,
    transportSource,
    effective,
    remote: processResult(),
    expectedInputs: [] as unknown[],
    calls: [] as Array<{ args: readonly string[]; stdin: Buffer; timeoutMs: number }>,
    dependencies: {} as AdmissionV2ParseOnlyDependencies,
  } as Scenario;
  scenario.remote = processResult(JSON.stringify(parsePayload(scenario, "parsed_not_invoked")) + "\n");
  scenario.dependencies = {
    spawn(_executable, args, stdin, timeoutMs) {
      scenario.calls.push({ args, stdin: Buffer.from(stdin), timeoutMs });
      return args[0] === "-G" ? processResult(scenario.effective) : scenario.remote;
    },
    sourceBytes: () => Buffer.from(scenario.gateSource),
    admissionSourceBytes: () => Buffer.from(scenario.admissionSource),
    transportSourceBytes: () => Buffer.from(scenario.transportSource),
    now: () => new Date("2026-08-28T12:00:00.000Z"),
  };
  scenario.expectedInputs = [identity, knownHosts].map((path, index) => {
    const stat = lstatSync(path);
    return {
      schema: "synthia-m4f-direct-local-input.v1",
      label: index === 0 ? "identity_file" : "known_hosts_file",
      path,
      device: stat.dev,
      inode: stat.ino,
      owner_uid: stat.uid,
      mode: 0o600,
      link_count: 1,
      size: stat.size,
      mtime_ms: stat.mtimeMs,
      ctime_ms: stat.ctimeMs,
      sha256: sha256(readFileSync(path)),
    };
  });
  return scenario;
}

function parsePayload(scenario: Scenario, status: "parsed_not_invoked" | "parse_rejected"): Record<string, unknown> {
  return {
    schema: "synthia-m4f-direct-admission-v2-parse-only-result.v1",
    status,
    source_sha256: scenario.targetSourceHash,
    source_length: Buffer.byteLength(buildAdmissionV2Script(scenario.admission), "utf8"),
    parse_error_count: status === "parsed_not_invoked" ? 0 : 1,
    parser_ast_type: "System.Management.Automation.Language.ScriptBlockAst",
    constructed_ast_type: status === "parsed_not_invoked"
      ? "System.Management.Automation.Language.ScriptBlockAst"
      : null,
    powershell_edition: "Desktop",
    powershell_version: "5.1.19041.5607",
    target_body_not_invoked: true,
    hardware_action_performed: false,
    process_termination_performed: false,
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
    expect(error).toBeInstanceOf(AdmissionV2ParseOnlyFailure);
    return (error as AdmissionV2ParseOnlyFailure).detail;
  }
  throw new Error("expected failure");
}
