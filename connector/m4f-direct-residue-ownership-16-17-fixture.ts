import { createHash } from "node:crypto";
import {
  buildResidueOwnership17Command,
  buildResidueOwnership17Script,
  Candidate17ScriptConfig,
  Ownership17Dependencies,
  ResidueOwnership17Config,
} from "./scripts/m4f-direct-residue-ownership-diagnostic-17.ts";
import {
  planResidueOwnership16Parse,
  residueOwnership16ParseConfirmation,
  type Ownership16ParseDependencies,
  type ResidueOwnership16ParseConfig,
} from "./scripts/m4f-direct-residue-ownership-diagnostic-16.ts";
import { buildResidueOwnershipParseCommand } from "./scripts/m4f-residue-ownership-16-17-parse-loader.ts";
import type { M4fDirectAdmissionConfig, RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export const emptyHash = sha256("");
export const source17 = Buffer.from("candidate17-source");
export const test17 = Buffer.from("candidate17-test");
export const source16 = Buffer.from("candidate16-source");
export const test16 = Buffer.from("candidate16-test");
export const parseLoaderSource = Buffer.from("parse-loader-source");
export const source15 = Buffer.from("candidate15-source");
export const transportSource = Buffer.from("transport-source");
export const psHash = "8666564baaf3aa762b67d0eb4b8d288ab2f2611bad85e0046dc5b07455a0b5fc";
export const conhostHash = "417222c4a0ecb4d60a457ebe8e26fddf3d5406bffb16a5c59af8eeb241beca51";
export const cmdHash = "5bc4c97b1fd21194056191199161af8371483e645131cf7c32a83018ae5be99e";
export const decodedHash = "21ea7ae211c4433bced41512d6b54d37b259a7700ae3dffe63147c6ab5178407";

export const effective = Buffer.from([
  "host 100.96.223.49", "hostname 100.96.223.49", "user admin", "port 22",
  "batchmode yes", "connecttimeout 15", "connectionattempts 1", "serveraliveinterval 0",
  "serveralivecountmax 4", "numberofpasswordprompts 0", "identityagent none",
  "identitiesonly yes", "pubkeyauthentication true", "passwordauthentication no",
  "kbdinteractiveauthentication no", "gssapiauthentication no", "hostbasedauthentication no",
  "preferredauthentications publickey", "stricthostkeychecking true", "globalknownhostsfile /dev/null",
  "forwardagent no", "clearallforwardings yes", "permitlocalcommand no", "controlmaster false",
  "controlpersist no", "requesttty false", "warnweakcrypto no", "identityfile /tmp/id",
  "userknownhostsfile /tmp/known", "",
].join("\n"));

export const admission: M4fDirectAdmissionConfig = {
  schema: "synthia-m4f-direct-admission-config.v1",
  gate_id: "candidate16-17-test",
  target: {
    host: "100.96.223.49", port: 22, user: "admin", computer_name: "DESKTOP-DVFFB09",
    identity_name: "desktop-dvffb09\\admin",
    identity_sid: "S-1-5-21-2561815994-3878748218-1101284459-1001",
    identity_file: "/tmp/id", known_hosts_file: "/tmp/known", known_hosts_host_token: "100.96.223.49",
    host_key_fingerprint: "SHA256:jZVimVML+3vYKaaMK30EakIxOvOWiilN6FjBW/4uhfY",
    expected_effective_config_sha256: sha256(effective), acl_paths: ["C:\\Windows\\Temp"],
    vivado_executable: "D:\\Xilinx\\Vivado\\2021.1\\bin\\vivado.bat",
    bun_executable: "D:\\synthia-worker\\runtime\\bun.exe",
  },
};
export const admissionBytes = Buffer.from(JSON.stringify(admission));

export const c15Names = [
  "admission-config.raw.json", "confirmation.sha256", "diagnostic-config.canonical.json", "markers.json",
  "observation.json", "plan.canonical.json", "remote-command.json", "remote-process.json", "remote-script.ps1",
  "remote-stderr.raw", "remote-stdout.raw", "result.json", "ssh-effective-process.json",
  "ssh-effective-stderr.raw", "ssh-effective-stdout.raw", "transport-inputs-initial.json",
  "transport-inputs-post_remote.json", "transport-inputs-pre_remote.json",
] as const;

export const c16Names = [
  "confirmation.sha256", "parse-config.canonical.json", "parse-loader.ps1", "parse-record.json", "plan.canonical.json",
  "remote-process.json", "ssh-effective-process.json", "ssh-effective-stderr.raw", "ssh-effective-stdout.raw",
  "stderr.raw", "stdout.raw", "target-script.ps1", "transport-inputs-initial.json",
  "transport-inputs-post_remote.json", "transport-inputs-pre_remote.json",
] as const;

export interface Fixture {
  scriptConfig: Candidate17ScriptConfig;
  actualConfig: ResidueOwnership17Config;
  frozen: Map<string, Buffer>;
  dependencies: Ownership16ParseDependencies;
  calls: Array<{ args: readonly string[]; stdin: Buffer; timeout: number }>;
  setRemote(result: RawProcessResult): void;
}

export function processResult(stdout: string | Buffer, stderr: string | Buffer = "", status = 0): RawProcessResult {
  return {
    status, signal: null, errorCode: null,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr),
  };
}

export function fixture(): Fixture {
  const frozen = new Map<string, Buffer>();
  const c15ConfigPath = "/tmp/candidate15.json";
  const c15PlanPath = "/tmp/candidate15-plan.json";
  const c15ConfirmationPath = "/tmp/candidate15-confirmation.txt";
  const c15ReviewPath = "/tmp/candidate15-review.json";
  const c15Dir = "/tmp/candidate15-evidence";
  const c15Config = Buffer.from(JSON.stringify({
    schema: "synthia-m4f-direct-residue-ownership-config.v3",
    diagnostic_id: "m4f-direct-residue-ownership-prod-20260829-15",
  }));
  frozen.set(c15ConfigPath, c15Config);
  frozen.set(c15PlanPath, Buffer.from("plan15"));
  frozen.set(c15ConfirmationPath, Buffer.from("confirmation15\n"));
  frozen.set(c15ReviewPath, Buffer.from("review15"));
  const c15 = new Map<string, Buffer>();
  for (const name of c15Names) c15.set(name, Buffer.from(name));
  c15.set("diagnostic-config.canonical.json", Buffer.from(JSON.stringify({
    diagnostic_id: "m4f-direct-residue-ownership-prod-20260829-15",
  })));
  c15.set("result.json", Buffer.from(JSON.stringify({
    status: "partial_unknown", reasons: ["snapshot_unavailable"], attempt_count: 1, stdin_length: 0,
    marker_count: 0, trailing_fragment_length: 0, trailing_fragment_sha256: emptyHash,
    retry_permitted: false, cleanup_performed: false, cleanup_derivation_permitted: false,
  })));
  c15.set("remote-process.json", Buffer.from(JSON.stringify({
    attempt_count: 1, exit_status: 1, signal: null, error_code: null, stdin_length: 0,
    stdin_sha256: emptyHash, stdout_length: 0, stdout_sha256: emptyHash, stderr_length: 1912,
    stderr_sha256: "pending", retry_permitted: false,
  })));
  c15.set("remote-command.json", Buffer.from(JSON.stringify({
    length: 6618, sha256: "9243ff7238cd47b3ccaddbb7a5462d57a3be1a3faa95fdca90933a999e5327e9",
    stdin_length: 0, attempt_count: 1, raw_command_stored: false,
  })));
  c15.set("markers.json", Buffer.from("[]"));
  c15.set("observation.json", Buffer.from("null"));
  c15.set("remote-stdout.raw", Buffer.alloc(0));
  c15.set("remote-stderr.raw", Buffer.from("FullyQualifiedErrorId : MissingInInForeach".padEnd(1912, "x")));
  c15.set("remote-script.ps1", Buffer.from("line\nforeach($i in$want){$null}\n"));
  c15.set("ssh-effective-stdout.raw", Buffer.from("c15-effective"));
  c15.set("ssh-effective-stderr.raw", Buffer.alloc(0));
  c15.set("ssh-effective-process.json", Buffer.from(JSON.stringify({
    exit_status: 0, signal: null, error_code: null, stdin_length: 0, stderr_length: 0,
    stdout_sha256: sha256(c15.get("ssh-effective-stdout.raw")!),
  })));
  for (const name of ["transport-inputs-initial.json", "transport-inputs-pre_remote.json", "transport-inputs-post_remote.json"]) {
    c15.set(name, Buffer.from("[]"));
  }
  const remote = JSON.parse(c15.get("remote-process.json")!.toString());
  remote.stderr_sha256 = sha256(c15.get("remote-stderr.raw")!);
  c15.set("remote-process.json", Buffer.from(JSON.stringify(remote)));
  for (const [name, bytes] of c15) frozen.set(c15Dir + "/" + name, bytes);

  const zero = "0".repeat(64);
  const scriptConfig: Candidate17ScriptConfig = {
    schema: "synthia-m4f-candidate17-script-config.v1",
    diagnostic_id: "m4f-direct-residue-ownership-candidate17-test",
    admission_config_path: "/tmp/admission.json", admission_config_sha256: sha256(admissionBytes),
    evidence_directory: "/tmp/candidate17-evidence",
    candidate12: {
      raw_config_path: "/tmp/c12", raw_config_sha256: zero, evidence_directory: "/tmp/e12",
      canonical_config_sha256: zero, result_sha256: zero, markers_sha256: zero,
      raw_stdout_sha256: zero, remote_process_sha256: zero,
    },
    candidate14_failure: {
      config_path: "/tmp/c14", config_sha256: zero, evidence_directory: "/tmp/e14",
      failure_code: "parser_failure", failure_error: "M4F_RESIDUE_OWNERSHIP_MARKER_INVALID", attempt_count: 1,
      files: Object.fromEntries([
        "admission-config.raw.json", "confirmation.sha256", "diagnostic-config.canonical.json", "failure.json",
        "plan.canonical.json", "remote-command.json", "remote-process.json", "remote-script.ps1",
        "remote-stderr.raw", "remote-stdout.raw", "ssh-effective-process.json", "ssh-effective-stderr.raw",
        "ssh-effective-stdout.raw", "transport-inputs-initial.json", "transport-inputs-post_remote.json",
        "transport-inputs-pre_remote.json",
      ].map((name) => [name, zero])),
    },
    candidate15_failure: {
      config_path: c15ConfigPath, config_sha256: sha256(c15Config), plan_path: c15PlanPath,
      plan_sha256: sha256(frozen.get(c15PlanPath)!), confirmation_path: c15ConfirmationPath,
      confirmation_sha256: sha256(frozen.get(c15ConfirmationPath)!), review_record_path: c15ReviewPath,
      review_record_sha256: sha256(frozen.get(c15ReviewPath)!), evidence_directory: c15Dir,
      failure_code: "powershell_parser_missing_in_separator",
      files: Object.fromEntries(c15Names.map((name) => [name, sha256(c15.get(name)!)])),
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
    expected_candidate15_source_sha256: sha256(source15), expected_source_sha256: sha256(source17),
    expected_test_source_sha256: sha256(test17), expected_transport_source_sha256: sha256(transportSource),
    expected_effective_config_sha256: sha256(effective),
  };
  const scriptBytes = Buffer.from(JSON.stringify(scriptConfig));
  const scriptPath = "/tmp/candidate17-script.json";
  frozen.set(scriptPath, scriptBytes);
  const calls: Array<{ args: readonly string[]; stdin: Buffer; timeout: number }> = [];
  let remoteResult = processResult("");
  const dependencies: Ownership16ParseDependencies = {
    spawn(_executable, args, stdin, timeout) {
      calls.push({ args, stdin, timeout });
      return args[0] === "-G" ? processResult(effective) : remoteResult;
    },
    sourceBytes: () => source17, testSourceBytes: () => test17,
    candidate15SourceBytes: () => source15, transportSourceBytes: () => transportSource,
    candidate16SourceBytes: () => source16, candidate16TestSourceBytes: () => test16,
    parseLoaderSourceBytes: () => parseLoaderSource,
    parseSourceBytes: () => source16, parseTestSourceBytes: () => test16,
    frozenBytes: (path) => frozen.get(path) ?? Buffer.from("missing"),
    admissionConfigBytes: () => admissionBytes, transportInputs: () => [], now: () => new Date(0),
  };
  const c16Dir = "/tmp/candidate16-parse-evidence";
  const c16ConfigPath = "/tmp/candidate16-parse.json";
  const c16Config: ResidueOwnership16ParseConfig = {
    schema: "synthia-m4f-direct-residue-ownership-parse-config.v1",
    parse_id: "candidate16-test",
    candidate17_script_config_path: scriptPath,
    candidate17_script_config_sha256: sha256(scriptBytes),
    evidence_directory: c16Dir,
    expected_source_sha256: sha256(source16),
    expected_test_source_sha256: sha256(test16),
    expected_candidate17_source_sha256: sha256(source17),
    expected_parse_loader_source_sha256: sha256(parseLoaderSource),
  };
  const c16ConfigBytes = Buffer.from(JSON.stringify(c16Config));
  frozen.set(c16ConfigPath, c16ConfigBytes);
  const plan = planResidueOwnership16Parse(c16Config, dependencies);
  const confirmation = residueOwnership16ParseConfirmation(c16Config, dependencies);
  const targetScript = buildResidueOwnership17Script(scriptConfig);
  const targetCommand = buildResidueOwnership17Command(scriptConfig);
  const targetScriptHash = sha256(targetScript);
  const targetCommandHash = sha256(Buffer.from(targetCommand, "ascii"));
  const packed = buildResidueOwnershipParseCommand(targetScript, targetCommandHash);
  const parseResult = {
    schema: "synthia-m4f-direct-residue-ownership-parse-result.v1",
    status: "parsed_not_invoked",
    target_script_sha256: targetScriptHash,
    target_script_length: Buffer.byteLength(targetScript, "utf8"),
    target_command_sha256: targetCommandHash,
    parse_error_count: 0,
    parser_ast_type: "System.Management.Automation.Language.ScriptBlockAst",
    parser_end_block_present: true,
    powershell_edition: "Desktop",
    powershell_version: "5.1.19041.5608",
    target_body_not_invoked: true,
    process_mutation_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    cleanup_performed: false,
  };
  const stdout = Buffer.from(JSON.stringify(parseResult) + "\r\n");
  const process = {
    exit_status: 0, signal: null, error_code: null, timed_out: false, stdin_length: 0,
    stdout_length: stdout.length, stdout_sha256: sha256(stdout), stderr_length: 0,
    stderr_sha256: emptyHash, retry_permitted: false,
  };
  const effectiveProcess = {
    exit_status: 0, signal: null, error_code: null, timed_out: false, stdin_length: 0,
    stdout_length: effective.length, stdout_sha256: sha256(effective), stderr_length: 0,
    stderr_sha256: emptyHash, retry_permitted: false,
  };
  const record = {
    schema: "synthia-m4f-direct-residue-ownership-parse-record.v1",
    status: "parsed_not_invoked",
    parse_id: c16Config.parse_id,
    recorded_at_utc: new Date(0).toISOString(),
    config_sha256: sha256(canonical(c16Config) + "\n"),
    confirmation_sha256: sha256(confirmation),
    candidate17_script_config_sha256: c16Config.candidate17_script_config_sha256,
    target_script_sha256: targetScriptHash,
    target_script_length: Buffer.byteLength(targetScript, "utf8"),
    target_command_sha256: targetCommandHash,
    target_command_length: targetCommand.length,
    compressed_sha256: sha256(packed.compressed),
    loader_sha256: sha256(packed.loader),
    parse_command_sha256: sha256(packed.command),
    effective_config_sha256: sha256(effective),
    attempt: 1,
    timeout_ms: 30_000,
    stdin_length: 0,
    result: parseResult,
    process,
    target_body_not_invoked: true,
    process_mutation_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    cleanup_performed: false,
    retry_permitted: false,
  };
  const c16 = new Map<string, Buffer>();
  c16.set("confirmation.sha256", Buffer.from(sha256(confirmation) + "\n"));
  c16.set("parse-config.canonical.json", Buffer.from(canonical(c16Config) + "\n"));
  c16.set("parse-loader.ps1", Buffer.from(packed.loader));
  c16.set("parse-record.json", Buffer.from(JSON.stringify(record, null, 2) + "\n"));
  c16.set("plan.canonical.json", Buffer.from(canonical(plan) + "\n"));
  c16.set("remote-process.json", Buffer.from(JSON.stringify(process, null, 2) + "\n"));
  c16.set("ssh-effective-process.json", Buffer.from(JSON.stringify(effectiveProcess, null, 2) + "\n"));
  c16.set("ssh-effective-stderr.raw", Buffer.alloc(0));
  c16.set("ssh-effective-stdout.raw", effective);
  c16.set("stderr.raw", Buffer.alloc(0));
  c16.set("stdout.raw", stdout);
  c16.set("target-script.ps1", Buffer.from(targetScript));
  c16.set("transport-inputs-initial.json", Buffer.from("[]\n"));
  c16.set("transport-inputs-post_remote.json", Buffer.from("[]\n"));
  c16.set("transport-inputs-pre_remote.json", Buffer.from("[]\n"));
  const actualConfig: ResidueOwnership17Config = {
    schema: "synthia-m4f-direct-residue-ownership-config.v6",
    diagnostic_id: scriptConfig.diagnostic_id,
    evidence_directory: scriptConfig.evidence_directory,
    script_config_sha256: sha256(Buffer.from(canonical(scriptConfig) + "\n")),
    script_config: scriptConfig,
    candidate16_parse_success: {
      parse_config_path: c16ConfigPath, parse_config_sha256: sha256(c16ConfigBytes), evidence_directory: c16Dir,
      target_script_sha256: targetScriptHash, target_command_sha256: targetCommandHash,
      files: Object.fromEntries(c16Names.map((name) => [name, sha256(c16.get(name)!)])),
    },
    expected_source_sha256: sha256(source17), expected_test_source_sha256: sha256(test17),
  };
  for (const [name, bytes] of c16) frozen.set(c16Dir + "/" + name, bytes);
  return {
    scriptConfig, actualConfig, frozen, dependencies, calls,
    setRemote(result) { remoteResult = result; },
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function asOwnership17Dependencies(value: Ownership16ParseDependencies): Ownership17Dependencies {
  return value;
}
