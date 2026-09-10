import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { canonicalEvolutionEvalHash } from "../evolution-eval.ts";
import {
  auditDirectSshEffectiveConfig,
  buildDirectPowerShellStdinCommand,
  buildDirectSshEffectiveArguments,
  buildDirectSshOptions,
  captureM4fDirectTransportInputs,
  type LocalInputFact,
  type M4fDirectAdmissionConfig,
  validateM4fDirectAdmissionConfig,
} from "./m4f-gate-admission-transport.ts";

const SSH_PATH = "/usr/bin/ssh";
const SCP_PATH = "/usr/bin/scp";
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/u;
const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const WINDOWS_DRIVE_PATH = /^[A-Z]:\\[^\r\n\0/]*$/u;
const WINDOWS_RESERVED_SEGMENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const TARGET_HOST = "100.96.223.49";
const TARGET_COMPUTER = "DESKTOP-DVFFB09";
const TARGET_USER = "admin";
const DIRECT_ORIGIN = "https://100.96.223.49:18443";
const LOCAL_SERVICE_SID = "S-1-5-19";
const SERVER_AUTH_EKU = "1.3.6.1.5.5.7.3.1";

export type DeploymentArtifactRole =
  | "release_manifest"
  | "worker_bundle"
  | "bun_runtime"
  | "launcher"
  | "windows_certifier"
  | "config_template"
  | "toolchain_attestation"
  | "server_pfx"
  | "pfx_password"
  | "trusted_client_ca";

export interface M4fDeploymentArtifact {
  role: DeploymentArtifactRole;
  local_path: string;
  remote_name: string;
  sha256: string;
  secret: boolean;
}

export interface M4fDirectDeploymentConfigV1 {
  schema: "synthia-m4f-direct-deployment-config.v1";
  gate_id: string;
  deployment_id: string;
  release_version: string;
  admission_config_path: string;
  admission_config_sha256: string;
  gate_roots_record_path: string;
  gate_roots_record_sha256: string;
  gate_root: string;
  backing_root: string;
  release_root: string;
  active_config_path: string;
  ledger_epoch: string;
  service_identity_sid: "S-1-5-19";
  task_name: string;
  protected_8443: {
    pid: number;
    process_start_utc: string;
    task_name: string;
    task_definition_sha256: string;
  };
  tls: {
    required_ip_san: "100.96.223.49";
    required_eku_oid: "1.3.6.1.5.5.7.3.1";
    expected_issuer: string;
    expected_certificate_sha256: string;
    expected_not_after_utc: string;
  };
  artifacts: M4fDeploymentArtifact[];
  expected_source_sha256: string;
  expected_remote_program_sha256: string;
}

export interface LocalArtifactFact {
  role: DeploymentArtifactRole;
  remote_name: string | null;
  secret: boolean;
  size_bytes: number | null;
  sha256: string | null;
  verified: true;
}

export interface M4fDirectDeploymentPlanV1 {
  schema: "synthia-m4f-direct-deployment-plan.v1";
  status: "planned_not_executed";
  gate_id: string;
  deployment_id: string;
  release_version: string;
  target: {
    host: "100.96.223.49";
    user: "admin";
    computer_name: "DESKTOP-DVFFB09";
    origin: "https://100.96.223.49:18443";
  };
  gate_root: string;
  backing_root: string;
  release_root: string;
  active_config_path: string;
  task_name: string;
  service_identity_sid: "S-1-5-19";
  ledger_epoch: string;
  protected_8443: M4fDirectDeploymentConfigV1["protected_8443"];
  tls_public_binding: {
    required_ip_san: "100.96.223.49";
    required_eku_oid: "1.3.6.1.5.5.7.3.1";
    expected_issuer: string;
    expected_certificate_sha256: string;
    expected_not_after_utc: string;
    private_key_or_password_in_plan: false;
  };
  artifacts: LocalArtifactFact[];
  phase_order: readonly [
    "transport_and_remote_read_only_preflight",
    "exclusive_version_root_create",
    "versioned_release_tls_config_upload",
    "remote_hash_acl_tls_seal",
    "stage_and_initialize_once",
    "post_initialize_stop_and_reopen_verify",
    "localservice_task_register_and_start",
    "process_listener_ledger_evidence_collect",
  ];
  config_sha256: string;
  source_sha256: string;
  remote_program_sha256: string;
  plan_sha256: string;
  confirmation: string;
  dry_run_default: true;
  network_attempted: false;
  remote_mutation_started: false;
  retry_permitted: false;
  automatic_cleanup: false;
  vivado_execution_permitted: false;
  hardware_action_permitted: false;
  old_8443_mutation_permitted: false;
}

export interface RawProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  errorCode: string | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface DeploymentPhaseResult {
  phase: string;
  process: ProcessEvidence;
  payload: Record<string, unknown>;
}

export interface ProcessEvidence {
  exit_status: number | null;
  signal: string | null;
  error_code: string | null;
  timed_out: boolean;
  outcome_ambiguous: boolean;
  stdout_length: number;
  stdout_sha256: string;
  stderr_length: number;
  stderr_sha256: string;
  retry_permitted: false;
}

export interface UploadResult {
  role: DeploymentArtifactRole;
  remote_name: string | null;
  secret: boolean;
  process: ProcessEvidence;
}

export interface DirectDeploymentDependencies {
  sourceBytes(): Buffer;
  remoteProgramBytes(): Buffer;
  runEffectiveConfig(config: M4fDirectAdmissionConfig): RawProcessResult;
  runPhase(config: M4fDirectAdmissionConfig, phase: string, script: Buffer): RawProcessResult;
  upload(config: M4fDirectAdmissionConfig, artifact: M4fDeploymentArtifact, remotePath: string): RawProcessResult;
  now(): Date;
}

export interface M4fDirectDeploymentRecordV1 {
  schema: "synthia-m4f-direct-deployment-record.v1";
  status: "deployed_observed";
  gate_id: string;
  deployment_id: string;
  recorded_at_utc: string;
  confirmation_sha256: string;
  config_sha256: string;
  plan_sha256: string;
  source_sha256: string;
  remote_program_sha256: string;
  transport_inputs_before: LocalInputFact[];
  transport_inputs_after: LocalInputFact[];
  artifacts: LocalArtifactFact[];
  uploads: UploadResult[];
  phases: DeploymentPhaseResult[];
  secret_bytes_in_evidence: false;
  secret_hashes_in_evidence: false;
  retry_permitted: false;
  automatic_cleanup: false;
  vivado_executed: false;
  hardware_action_performed: false;
  old_8443_untouched: true;
}

export class M4fDirectDeploymentFailure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_DIRECT_DEPLOYMENT_FAILED"));
  }
}

const CONFIG_KEYS = [
  "active_config_path", "admission_config_path", "admission_config_sha256", "artifacts",
  "backing_root", "deployment_id", "expected_remote_program_sha256", "expected_source_sha256",
  "gate_id", "gate_root", "gate_roots_record_path", "gate_roots_record_sha256", "ledger_epoch",
  "protected_8443", "release_root", "release_version", "schema", "service_identity_sid",
  "task_name", "tls",
] as const;
const PROTECTED_KEYS = ["pid", "process_start_utc", "task_definition_sha256", "task_name"] as const;
const TLS_KEYS = ["expected_certificate_sha256", "expected_issuer", "expected_not_after_utc", "required_eku_oid", "required_ip_san"] as const;
const ARTIFACT_KEYS = ["local_path", "remote_name", "role", "secret", "sha256"] as const;
const REQUIRED_ROLES: readonly DeploymentArtifactRole[] = [
  "release_manifest", "worker_bundle", "bun_runtime", "launcher", "windows_certifier",
  "config_template", "toolchain_attestation", "server_pfx", "pfx_password", "trusted_client_ca",
];
const SECRET_ROLES = new Set<DeploymentArtifactRole>(["server_pfx", "pfx_password"]);
const FIXED_REMOTE_NAMES = new Map<DeploymentArtifactRole, string>([
  ["release_manifest", "worker-release.manifest.json"],
  ["worker_bundle", "server.bundle.mjs"],
  ["launcher", "start-worker-66.cmd"],
  ["windows_certifier", "certify-m4f-windows.ps1"],
  ["pfx_password", "pfx-password.txt"],
]);

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function iso(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function fail(code: string, stage: string, extra: Record<string, unknown> = {}): never {
  throw new M4fDirectDeploymentFailure({
    schema: "synthia-m4f-direct-deployment-failure.v1",
    code,
    stage,
    retry_permitted: false,
    automatic_cleanup: false,
    ...extra,
  });
}

function readBoundJson(path: string, expectedHash: string, label: string): Record<string, unknown> {
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch { fail("M4F_DIRECT_DEPLOYMENT_INPUT_UNAVAILABLE", "local_preflight", { label }); }
  if (sha256(bytes!) !== expectedHash) fail("M4F_DIRECT_DEPLOYMENT_INPUT_HASH_MISMATCH", "local_preflight", { label });
  try {
    const value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes!)));
    if (!value) fail("M4F_DIRECT_DEPLOYMENT_INPUT_INVALID", "local_preflight", { label });
    return value;
  } catch (error) {
    if (error instanceof M4fDirectDeploymentFailure) throw error;
    fail("M4F_DIRECT_DEPLOYMENT_INPUT_INVALID", "local_preflight", { label });
  }
}

function canonicalWindowsSegments(value: unknown): { drive: string; segments: string[] } | null {
  if (typeof value !== "string" || value.length < 4 || value.length > 1024
    || !WINDOWS_DRIVE_PATH.test(value) || value.endsWith("\\")) return null;
  const segments = value.slice(3).split("\\");
  if (!segments.length || segments.some((segment) => segment.length < 1
    || segment === "." || segment === ".." || segment.endsWith(".") || segment.endsWith(" ")
    || /[<>:"|?*\u0000-\u001f]/u.test(segment) || WINDOWS_RESERVED_SEGMENT.test(segment))) return null;
  return { drive: value.slice(0, 2), segments };
}

function sameWindowsPath(left: string, right: string): boolean {
  const leftPath = canonicalWindowsSegments(left);
  const rightPath = canonicalWindowsSegments(right);
  return !!leftPath && !!rightPath
    && leftPath.drive.toLowerCase() === rightPath.drive.toLowerCase()
    && canonicalJson(leftPath.segments.map((item) => item.toLowerCase()))
      === canonicalJson(rightPath.segments.map((item) => item.toLowerCase()));
}

function under(root: string, path: string): boolean {
  const rootPath = canonicalWindowsSegments(root);
  const childPath = canonicalWindowsSegments(path);
  return !!rootPath && !!childPath && rootPath.drive.toLowerCase() === childPath.drive.toLowerCase()
    && rootPath.segments.length <= childPath.segments.length
    && rootPath.segments.every((segment, index) => segment.toLowerCase() === childPath.segments[index]!.toLowerCase());
}

export function validateM4fDirectDeploymentConfig(raw: unknown): M4fDirectDeploymentConfigV1 {
  const config = object(raw);
  const protectedWorker = object(config?.protected_8443);
  const tls = object(config?.tls);
  if (!config || !protectedWorker || !tls
    || !exactKeys(config, CONFIG_KEYS) || !exactKeys(protectedWorker, PROTECTED_KEYS) || !exactKeys(tls, TLS_KEYS)
    || config.schema !== "synthia-m4f-direct-deployment-config.v1"
    || typeof config.gate_id !== "string" || !SAFE_ID.test(config.gate_id)
    || typeof config.deployment_id !== "string" || !SAFE_ID.test(config.deployment_id)
    || typeof config.release_version !== "string" || !SAFE_ID.test(config.release_version)
    || typeof config.admission_config_path !== "string" || !config.admission_config_path.startsWith("/")
    || !HASH.test(String(config.admission_config_sha256))
    || typeof config.gate_roots_record_path !== "string" || !config.gate_roots_record_path.startsWith("/")
    || !HASH.test(String(config.gate_roots_record_sha256))
    || typeof config.gate_root !== "string" || !canonicalWindowsSegments(config.gate_root)
    || typeof config.backing_root !== "string" || !canonicalWindowsSegments(config.backing_root)
    || typeof config.release_root !== "string" || !canonicalWindowsSegments(config.release_root)
    || typeof config.active_config_path !== "string" || !canonicalWindowsSegments(config.active_config_path)
    || !sameWindowsPath(config.gate_root, `C:\\Windows\\Temp\\synthia-m4f-${config.gate_id}`)
    || !sameWindowsPath(config.backing_root, `D:\\synthia-m4f-toolchain-${config.gate_id}`)
    || !sameWindowsPath(config.release_root, `${config.gate_root}\\release-${config.release_version}`)
    || !sameWindowsPath(config.active_config_path, `${config.release_root}\\worker-18443.active.json`)
    || !under(config.gate_root, config.release_root) || !under(config.release_root, config.active_config_path)
    || under("D:\\synthia-worker", config.release_root) || under(config.release_root, "D:\\synthia-worker")
    || typeof config.ledger_epoch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(config.ledger_epoch)
    || config.service_identity_sid !== LOCAL_SERVICE_SID
    || typeof config.task_name !== "string" || !/^Synthia-M4F-18443-[A-Za-z0-9._-]{1,64}$/u.test(config.task_name)
    || !Number.isSafeInteger(protectedWorker.pid) || Number(protectedWorker.pid) < 1
    || !iso(protectedWorker.process_start_utc)
    || typeof protectedWorker.task_name !== "string" || protectedWorker.task_name.length < 1
    || !HASH.test(String(protectedWorker.task_definition_sha256))
    || tls.required_ip_san !== TARGET_HOST || tls.required_eku_oid !== SERVER_AUTH_EKU
    || typeof tls.expected_issuer !== "string" || tls.expected_issuer.trim() !== tls.expected_issuer || tls.expected_issuer.length < 1
    || !HASH.test(String(tls.expected_certificate_sha256)) || !iso(tls.expected_not_after_utc)
    || Date.parse(String(tls.expected_not_after_utc)) <= Date.now()
    || !HASH.test(String(config.expected_source_sha256)) || !HASH.test(String(config.expected_remote_program_sha256))
    || !Array.isArray(config.artifacts) || config.artifacts.length !== REQUIRED_ROLES.length) {
    fail("M4F_DIRECT_DEPLOYMENT_CONFIG_INVALID", "config");
  }
  const artifacts = config.artifacts as unknown[];
  const roles = new Set<string>();
  const names = new Set<string>();
  for (const rawArtifact of artifacts) {
    const artifact = object(rawArtifact);
    if (!artifact || !exactKeys(artifact, ARTIFACT_KEYS)
      || !REQUIRED_ROLES.includes(artifact.role as DeploymentArtifactRole)
      || roles.has(String(artifact.role))
      || typeof artifact.local_path !== "string" || !artifact.local_path.startsWith("/")
      || typeof artifact.remote_name !== "string" || !SAFE_REMOTE_NAME.test(artifact.remote_name)
      || names.has(artifact.remote_name.toLowerCase())
      || (FIXED_REMOTE_NAMES.has(artifact.role as DeploymentArtifactRole)
        && FIXED_REMOTE_NAMES.get(artifact.role as DeploymentArtifactRole) !== artifact.remote_name)
      || !HASH.test(String(artifact.sha256))
      || artifact.secret !== SECRET_ROLES.has(artifact.role as DeploymentArtifactRole)) {
      fail("M4F_DIRECT_DEPLOYMENT_ARTIFACT_INVALID", "config");
    }
    roles.add(String(artifact.role));
    names.add(artifact.remote_name.toLowerCase());
  }
  if (REQUIRED_ROLES.some((role) => !roles.has(role))) fail("M4F_DIRECT_DEPLOYMENT_ARTIFACT_SET_INVALID", "config");
  return raw as M4fDirectDeploymentConfigV1;
}

function readArtifact(artifact: M4fDeploymentArtifact): { fact: LocalArtifactFact; bytes: Buffer } {
  let fd: number | null = null;
  try {
    const pathBefore = lstatSync(artifact.local_path);
    fd = openSync(artifact.local_path, "r");
    const before = fstatSync(fd);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(artifact.local_path);
    if (!before.isFile() || pathBefore.isSymbolicLink() || pathAfter.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino || after.nlink !== 1
      || (artifact.secret && (after.uid !== process.getuid?.() || (after.mode & 0o777) !== 0o600))
      || bytes.length < 1 || sha256(bytes) !== artifact.sha256) {
      fail("M4F_DIRECT_DEPLOYMENT_LOCAL_ARTIFACT_UNTRUSTED", "local_preflight", { role: artifact.role });
    }
    return {
      fact: {
        role: artifact.role,
        remote_name: artifact.secret ? null : artifact.remote_name,
        secret: artifact.secret,
        size_bytes: artifact.secret ? null : bytes.length,
        sha256: artifact.secret ? null : artifact.sha256,
        verified: true,
      },
      bytes,
    };
  } catch (error) {
    if (error instanceof M4fDirectDeploymentFailure) throw error;
    return fail("M4F_DIRECT_DEPLOYMENT_LOCAL_ARTIFACT_UNAVAILABLE", "local_preflight", { role: artifact.role });
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function validateBindings(config: M4fDirectDeploymentConfigV1): M4fDirectAdmissionConfig {
  const admission = validateM4fDirectAdmissionConfig(readBoundJson(
    config.admission_config_path,
    config.admission_config_sha256,
    "admission_config",
  ));
  const roots = readBoundJson(config.gate_roots_record_path, config.gate_roots_record_sha256, "gate_roots_record");
  const currentTransportInputs = captureM4fDirectTransportInputs(admission);
  if (admission.gate_id !== config.gate_id
    || admission.target.expected_effective_config_sha256 === null
    || roots.schema !== "synthia-m4f-direct-gate-roots-record.v3"
    || roots.status !== "created" || roots.gate_id !== config.gate_id
    || roots.gate_root !== config.gate_root || roots.backing_root !== config.backing_root
    || roots.effective_config_sha256 !== admission.target.expected_effective_config_sha256
    || !Array.isArray(roots.transport_inputs_after)
    || canonicalJson(roots.transport_inputs_after) !== canonicalJson(currentTransportInputs)
    || object(roots.remote_result)?.hardware_action_performed !== false) {
    fail("M4F_DIRECT_DEPLOYMENT_GATE_ROOT_BINDING_INVALID", "local_preflight");
  }
  return admission;
}

function validateReleaseAndConfig(config: M4fDirectDeploymentConfigV1, bytesByRole: Map<DeploymentArtifactRole, Buffer>): void {
  let manifest: Record<string, unknown>;
  let template: Record<string, unknown>;
  try {
    manifest = object(JSON.parse(bytesByRole.get("release_manifest")!.toString("utf8")))!;
    template = object(JSON.parse(bytesByRole.get("config_template")!.toString("utf8")))!;
  } catch { fail("M4F_DIRECT_DEPLOYMENT_JSON_ARTIFACT_INVALID", "local_preflight"); }
  const bundle = object(manifest?.bundle);
  const runtime = object(manifest?.runtime);
  const releaseFiles = object(manifest?.release_files);
  const { manifest_hash: manifestHash, ...manifestBody } = manifest ?? {};
  if (!manifest || !template || manifest.schema !== "synthia-worker-release-manifest.v1"
    || !bundle || !runtime || !releaseFiles || !HASH.test(String(manifestHash))
    || canonicalEvolutionEvalHash(manifestBody) !== manifestHash
    || bundle.sha256 !== config.artifacts.find((item) => item.role === "worker_bundle")!.sha256
    || runtime.sha256 !== config.artifacts.find((item) => item.role === "bun_runtime")!.sha256
    || releaseFiles.launcher_sha256 !== config.artifacts.find((item) => item.role === "launcher")!.sha256
    || releaseFiles.windows_certifier_sha256 !== config.artifacts.find((item) => item.role === "windows_certifier")!.sha256
    || releaseFiles.config_template_sha256 !== config.artifacts.find((item) => item.role === "config_template")!.sha256) {
    fail("M4F_DIRECT_DEPLOYMENT_RELEASE_BINDING_INVALID", "local_preflight");
  }
  const byRole = new Map(config.artifacts.map((item) => [item.role, item]));
  const remote = (role: DeploymentArtifactRole) => config.release_root + "\\" + byRole.get(role)!.remote_name;
  const exactRoots = new Map<string, string>([
    ["workspace_root", `${config.gate_root}\\workspace`],
    ["evidence_root", `${config.gate_root}\\evidence`],
    ["evolution_eval_ledger_root", `${config.gate_root}\\ledger`],
    ["evolution_eval_spool_root", `${config.gate_root}\\spool`],
    ["evolution_eval_log_root", `${config.gate_root}\\logs`],
  ]);
  if (template.listen_host !== "0.0.0.0" || template.listen_port !== 18443
    || template.endpoint_url !== DIRECT_ORIGIN || template.evolution_eval_enabled !== false
    || template.evolution_eval_ledger_mode !== "reopen"
    || template.server_certificate_path !== remote("server_pfx")
    || template.server_private_key_path !== remote("server_pfx")
    || template.trusted_client_ca_path !== remote("trusted_client_ca")
    || template.vivado_toolchain_attestation_path !== remote("toolchain_attestation")
    || template.vivado_toolchain_attestation_sha256 !== byRole.get("toolchain_attestation")!.sha256
    || [...exactRoots].some(([name, expected]) => typeof template[name] !== "string"
      || !canonicalWindowsSegments(template[name]) || !sameWindowsPath(String(template[name]), expected))
    || Object.values(template).some((value) => typeof value === "string" && value.toLowerCase().includes("d:\\synthia-worker"))) {
    fail("M4F_DIRECT_DEPLOYMENT_CONFIG_TEMPLATE_INVALID", "local_preflight");
  }
}

function planCore(config: M4fDirectDeploymentConfigV1, facts: LocalArtifactFact[], sourceHash: string, remoteHash: string) {
  return {
    schema: "synthia-m4f-direct-deployment-plan.v1" as const,
    status: "planned_not_executed" as const,
    gate_id: config.gate_id,
    deployment_id: config.deployment_id,
    release_version: config.release_version,
    target: {
      host: "100.96.223.49" as const,
      user: "admin" as const,
      computer_name: "DESKTOP-DVFFB09" as const,
      origin: "https://100.96.223.49:18443" as const,
    },
    gate_root: config.gate_root,
    backing_root: config.backing_root,
    release_root: config.release_root,
    active_config_path: config.active_config_path,
    task_name: config.task_name,
    service_identity_sid: config.service_identity_sid,
    ledger_epoch: config.ledger_epoch,
    protected_8443: config.protected_8443,
    tls_public_binding: {
      ...config.tls,
      private_key_or_password_in_plan: false as const,
    },
    artifacts: facts,
    phase_order: [
      "transport_and_remote_read_only_preflight", "exclusive_version_root_create",
      "versioned_release_tls_config_upload", "remote_hash_acl_tls_seal",
      "stage_and_initialize_once", "post_initialize_stop_and_reopen_verify",
      "localservice_task_register_and_start", "process_listener_ledger_evidence_collect",
    ] as const,
    config_sha256: sha256(canonicalJson(config) + "\n"),
    source_sha256: sourceHash,
    remote_program_sha256: remoteHash,
    dry_run_default: true as const,
    network_attempted: false as const,
    remote_mutation_started: false as const,
    retry_permitted: false as const,
    automatic_cleanup: false as const,
    vivado_execution_permitted: false as const,
    hardware_action_permitted: false as const,
    old_8443_mutation_permitted: false as const,
  };
}

export function directDeploymentConfirmation(plan: Pick<M4fDirectDeploymentPlanV1, "deployment_id" | "config_sha256" | "plan_sha256" | "source_sha256" | "remote_program_sha256">): string {
  return `SYNTHIA_M4F_DIRECT_DEPLOY:${plan.deployment_id}:${plan.config_sha256}:${plan.plan_sha256}:${plan.source_sha256}:${plan.remote_program_sha256}`;
}

export function planM4fDirectDeployment(
  raw: unknown,
  dependencies: Pick<DirectDeploymentDependencies, "sourceBytes" | "remoteProgramBytes"> = systemDependencies,
): M4fDirectDeploymentPlanV1 {
  const config = validateM4fDirectDeploymentConfig(raw);
  validateBindings(config);
  const sourceHash = sha256(dependencies.sourceBytes());
  const remoteHash = sha256(dependencies.remoteProgramBytes());
  if (sourceHash !== config.expected_source_sha256 || remoteHash !== config.expected_remote_program_sha256) {
    fail("M4F_DIRECT_DEPLOYMENT_SOURCE_HASH_MISMATCH", "local_preflight");
  }
  const facts: LocalArtifactFact[] = [];
  const bytesByRole = new Map<DeploymentArtifactRole, Buffer>();
  for (const artifact of config.artifacts) {
    const captured = readArtifact(artifact);
    facts.push(captured.fact);
    bytesByRole.set(artifact.role, captured.bytes);
  }
  validateReleaseAndConfig(config, bytesByRole);
  const core = planCore(config, facts, sourceHash, remoteHash);
  const planSha256 = sha256(canonicalJson(core) + "\n");
  const plan = { ...core, plan_sha256: planSha256 };
  return { ...plan, confirmation: directDeploymentConfirmation(plan) };
}

function psQuote(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function payload(config: M4fDirectDeploymentConfigV1): string {
  return Buffer.from(JSON.stringify({
    computer: TARGET_COMPUTER,
    identity_name: "desktop-dvffb09\\admin",
    gate_id: config.gate_id,
    release_version: config.release_version,
    gate_root: config.gate_root,
    backing_root: config.backing_root,
    release_root: config.release_root,
    active_config_path: config.active_config_path,
    task_name: config.task_name,
    ledger_epoch: config.ledger_epoch,
    old: config.protected_8443,
    tls: config.tls,
    artifacts: config.artifacts.map((artifact) => ({
      role: artifact.role,
      remote_name: artifact.remote_name,
      sha256: artifact.sha256,
      secret: artifact.secret,
    })),
  }), "utf8").toString("base64");
}

function phaseScript(config: M4fDirectDeploymentConfigV1, phase: string): Buffer {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
    `$cfg=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuote(payload(config))}))|ConvertFrom-Json)`,
    "$identity=[Security.Principal.WindowsIdentity]::GetCurrent()",
    "if($env:COMPUTERNAME -cne $cfg.computer -or $identity.Name.ToLowerInvariant() -cne $cfg.identity_name){throw 'M4F_DEPLOY_TARGET_IDENTITY_MISMATCH'}",
    `$phase=${psQuote(phase)}`,
    M4F_DIRECT_DEPLOYMENT_REMOTE_PROGRAM,
  ].join("\n") + "\n";
  return Buffer.from(script, "utf8");
}

export const M4F_DIRECT_DEPLOYMENT_REMOTE_PROGRAM = String.raw`
function Hash([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Emit([hashtable]$Body){$Body.schema='synthia-m4f-direct-deployment-phase.v1';$Body.phase=$phase;$Body.retry_permitted=$false;$Body.vivado_executed=$false;$Body.hardware_action_performed=$false;$Body|ConvertTo-Json -Compress -Depth 12}
function AssertCanonicalPath([string]$Path){
  if([string]::IsNullOrWhiteSpace($Path) -or $Path.Length -gt 1024 -or $Path.Contains('/') -or $Path -notcmatch '^[A-Z]:\\'){throw 'M4F_DEPLOY_PATH_INVALID'}
  $full=[IO.Path]::GetFullPath($Path);if(-not $full.Equals($Path,[StringComparison]::OrdinalIgnoreCase)){throw 'M4F_DEPLOY_PATH_NONCANONICAL'}
  $segments=@($Path.Substring(3).Split([char]'\'))
  foreach($segment in $segments){if([string]::IsNullOrEmpty($segment) -or $segment -ceq '.' -or $segment -ceq '..' -or $segment.EndsWith('.') -or $segment.EndsWith(' ') -or $segment.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$'){throw 'M4F_DEPLOY_PATH_SEGMENT_INVALID'}}
}
function AssertNoReparseChain([string]$Path){
  $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  while($null -ne $item){if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'M4F_DEPLOY_REPARSE_ANCESTOR'};$item=if($item -is [IO.DirectoryInfo]){$item.Parent}else{$item.Directory}}
}
function AssertDeploymentBoundary(){
  $expectedGate='C:\Windows\Temp\synthia-m4f-'+[string]$cfg.gate_id;$expectedBacking='D:\synthia-m4f-toolchain-'+[string]$cfg.gate_id;$expectedRelease=$expectedGate+'\release-'+[string]$cfg.release_version;$expectedActive=$expectedRelease+'\worker-18443.active.json'
  foreach($path in @([string]$cfg.gate_root,[string]$cfg.backing_root,[string]$cfg.release_root,[string]$cfg.active_config_path)){AssertCanonicalPath $path}
  if(-not ([string]$cfg.gate_root).Equals($expectedGate,[StringComparison]::OrdinalIgnoreCase) -or -not ([string]$cfg.backing_root).Equals($expectedBacking,[StringComparison]::OrdinalIgnoreCase) -or -not ([string]$cfg.release_root).Equals($expectedRelease,[StringComparison]::OrdinalIgnoreCase) -or -not ([string]$cfg.active_config_path).Equals($expectedActive,[StringComparison]::OrdinalIgnoreCase)){throw 'M4F_DEPLOY_PATH_LAYOUT_MISMATCH'}
  foreach($root in @([string]$cfg.gate_root,[string]$cfg.backing_root)){ $item=Get-Item -LiteralPath $root -Force -ErrorAction Stop;if($item -isnot [IO.DirectoryInfo]){throw 'M4F_DEPLOY_GATE_ROOT_INVALID'};AssertNoReparseChain $root }
  if(Test-Path -LiteralPath $cfg.release_root){$release=Get-Item -LiteralPath $cfg.release_root -Force -ErrorAction Stop;if($release -isnot [IO.DirectoryInfo]){throw 'M4F_DEPLOY_RELEASE_ROOT_INVALID'};AssertNoReparseChain ([string]$cfg.release_root)}
}
function TaskHash([string]$Name){$xml=Export-ScheduledTask -TaskName $Name -ErrorAction Stop;$bytes=[Text.Encoding]::Unicode.GetBytes($xml);$hasher=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($hasher.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$hasher.Dispose()}}
function SealFile([string]$Path){
  $acl=[Security.AccessControl.FileSecurity]::new();$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));$acl.SetAccessRuleProtection($true,$false)
  foreach($sid in @('S-1-5-32-544','S-1-5-18')){[void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','None','None','Allow'))}
  [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-19'),'ReadAndExecute,Read,Synchronize','None','None','Allow'));Set-Acl -LiteralPath $Path -AclObject $acl
}
function OldWorker(){
  $old=Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$cfg.old.pid) -ErrorAction Stop
  if($null -eq $old -or ([DateTime]$old.CreationDate).ToUniversalTime().ToString('o') -cne [string]$cfg.old.process_start_utc){throw 'M4F_DEPLOY_OLD_8443_IDENTITY_DRIFT'}
  $listener=@(Get-NetTCPConnection -State Listen -LocalPort 8443 -ErrorAction Stop|Where-Object{$_.OwningProcess -eq [int]$cfg.old.pid})
  if($listener.Count -ne 1){throw 'M4F_DEPLOY_OLD_8443_LISTENER_DRIFT'}
  $task=Get-ScheduledTask -TaskName ([string]$cfg.old.task_name) -ErrorAction Stop
  $taskHash=TaskHash ([string]$cfg.old.task_name)
  if($taskHash -cne [string]$cfg.old.task_definition_sha256){throw 'M4F_DEPLOY_OLD_8443_TASK_DRIFT'}
  return @{pid=[int]$old.ProcessId;start_utc=([DateTime]$old.CreationDate).ToUniversalTime().ToString('o');listener_count=1;task_state=$task.State.ToString();task_definition_sha256=$taskHash}
}
AssertDeploymentBoundary
if($phase -ceq 'transport_and_remote_read_only_preflight'){
  $old=OldWorker
  foreach($p in @($cfg.gate_root,$cfg.backing_root)){ $i=Get-Item -LiteralPath $p -Force -ErrorAction Stop;if($i -isnot [IO.DirectoryInfo] -or (($i.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0)){throw 'M4F_DEPLOY_GATE_ROOT_INVALID'} }
  if(Test-Path -LiteralPath $cfg.release_root){throw 'M4F_DEPLOY_RELEASE_ROOT_ALREADY_EXISTS'}
  if(@(Get-NetTCPConnection -State Listen -LocalPort 18443 -ErrorAction SilentlyContinue).Count -ne 0){throw 'M4F_DEPLOY_18443_ALREADY_LISTENING'}
  if($null -ne (Get-ScheduledTask -TaskName ([string]$cfg.task_name) -ErrorAction SilentlyContinue)){throw 'M4F_DEPLOY_TASK_ALREADY_EXISTS'}
  Emit @{status='passed';old_8443=$old;gate_root_exists=$true;backing_root_exists=$true;release_root_exists=$false;listener_18443_count=0;remote_mutation=$false};exit 0
}
if($phase -ceq 'exclusive_version_root_create'){
  [void](OldWorker)
  if(Test-Path -LiteralPath $cfg.release_root){throw 'M4F_DEPLOY_RELEASE_ROOT_ALREADY_EXISTS'}
  $dir=New-Item -ItemType Directory -Path ([string]$cfg.release_root) -ErrorAction Stop
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));$acl.SetAccessRuleProtection($true,$false)
  foreach($sid in @('S-1-5-32-544','S-1-5-18')){[void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
  [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-19'),'ReadAndExecute,Read,Synchronize','ContainerInherit,ObjectInherit','None','Allow'))
  Set-Acl -LiteralPath $dir.FullName -AclObject $acl
  AssertDeploymentBoundary
  Emit @{status='created';release_root=[string]$cfg.release_root;exclusive_create=$true;old_8443_untouched=$true;remote_mutation=$true};exit 0
}
if($phase -ceq 'remote_hash_acl_tls_seal'){
  [void](OldWorker)
  $secretVerified=0;$public=@()
  foreach($artifact in @($cfg.artifacts)){$path=Join-Path ([string]$cfg.release_root) ([string]$artifact.remote_name);if(-not(Test-Path -LiteralPath $path -PathType Leaf) -or (Hash $path) -cne [string]$artifact.sha256){throw 'M4F_DEPLOY_REMOTE_HASH_MISMATCH'};SealFile $path;if((Hash $path) -cne [string]$artifact.sha256){throw 'M4F_DEPLOY_REMOTE_HASH_DRIFT'};if($artifact.secret){$secretVerified++}else{$public+=@{role=[string]$artifact.role;sha256=[string]$artifact.sha256}}}
  $pfx=$cfg.artifacts|Where-Object{$_.role -ceq 'server_pfx'}; $password=$cfg.artifacts|Where-Object{$_.role -ceq 'pfx_password'}
  $passwordText=[IO.File]::ReadAllText((Join-Path ([string]$cfg.release_root) ([string]$password.remote_name))).TrimEnd([char]13,[char]10)
  try{$cert=[Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path ([string]$cfg.release_root) ([string]$pfx.remote_name)),$passwordText,[Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)}finally{$passwordText=$null}
  if(-not $cert.HasPrivateKey){throw 'M4F_DEPLOY_TLS_PRIVATE_KEY_MISSING'}
  $san=$cert.Extensions|Where-Object{$_.Oid.Value -ceq '2.5.29.17'}|Select-Object -First 1
  if($null -eq $san -or $san.Format($false) -notmatch 'IP Address=100\.96\.223\.49(?:,|$)'){throw 'M4F_DEPLOY_TLS_IP_SAN_MISSING'}
  $eku=$cert.Extensions|Where-Object{$_.Oid.Value -ceq '2.5.29.37'}|Select-Object -First 1
  if($null -eq $eku -or @($eku.EnhancedKeyUsages|Where-Object{$_.Value -ceq [string]$cfg.tls.required_eku_oid}).Count -ne 1){throw 'M4F_DEPLOY_TLS_EKU_MISMATCH'}
  $h=[Security.Cryptography.SHA256]::Create();try{$certHash=[BitConverter]::ToString($h.ComputeHash($cert.RawData)).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
  if($certHash -cne [string]$cfg.tls.expected_certificate_sha256 -or $cert.Issuer -cne [string]$cfg.tls.expected_issuer -or $cert.NotAfter.ToUniversalTime().ToString('o') -cne [string]$cfg.tls.expected_not_after_utc){throw 'M4F_DEPLOY_TLS_PUBLIC_BINDING_MISMATCH'}
  Emit @{status='sealed';public_artifacts=$public;secret_artifacts_verified=[int]$secretVerified;secret_hashes_emitted=$false;tls=@{ip_san='100.96.223.49';server_auth_eku=$true;issuer=$cert.Issuer;certificate_sha256=$certHash;not_after_utc=$cert.NotAfter.ToUniversalTime().ToString('o')};old_8443_untouched=$true;remote_mutation=$true};exit 0
}
if($phase -ceq 'stage_and_initialize_once'){
  [void](OldWorker)
  $certifier=Join-Path ([string]$cfg.release_root) (($cfg.artifacts|Where-Object{$_.role -ceq 'windows_certifier'}).remote_name)
  $template=Join-Path ([string]$cfg.release_root) (($cfg.artifacts|Where-Object{$_.role -ceq 'config_template'}).remote_name)
  $bun=Join-Path ([string]$cfg.release_root) (($cfg.artifacts|Where-Object{$_.role -ceq 'bun_runtime'}).remote_name)
  $bundle=Join-Path ([string]$cfg.release_root) (($cfg.artifacts|Where-Object{$_.role -ceq 'worker_bundle'}).remote_name)
  $stage=& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $certifier -Mode StageCeremony -ReleaseRoot $cfg.release_root -ConfigTemplatePath $template -Epoch $cfg.ledger_epoch -StagingRoot $cfg.gate_root -GateId $cfg.gate_id -BunPath $bun -ServiceIdentity 'S-1-5-19' -ConfirmIsolatedStaging 2>&1
  if($LASTEXITCODE -ne 0){throw 'M4F_DEPLOY_STAGE_CEREMONY_FAILED'};$stageJson=$stage|Select-Object -Last 1|ConvertFrom-Json
  $env:SYNTHIA_WORKER_CONFIG_SHA256=Hash ([string]$stageJson.initialize_config)
  $initialize=& $bun $bundle --initialize-evolution-ledger ([string]$stageJson.initialize_config) 2>&1
  if($LASTEXITCODE -ne 0){throw 'M4F_DEPLOY_LEDGER_INITIALIZE_FAILED'}
  Emit @{status='initialized_once';initialize_config=[string]$stageJson.initialize_config;reopen_config=[string]$stageJson.reopen_config;ledger_epoch=[string]$cfg.ledger_epoch;initialize_process_stopped=$true;old_8443_untouched=$true;remote_mutation=$true};exit 0
}
if($phase -ceq 'post_initialize_stop_and_reopen_verify'){
  [void](OldWorker)
  $ceremony=Join-Path ([string]$cfg.gate_root) ('ceremony-'+[string]$cfg.gate_id);$init=Join-Path $ceremony 'worker-66.initialize.json';$reopen=Join-Path $ceremony 'worker-66.reopen.json'
  $certifier=Join-Path ([string]$cfg.release_root) (($cfg.artifacts|Where-Object{$_.role -ceq 'windows_certifier'}).remote_name);$bun=Join-Path ([string]$cfg.release_root) (($cfg.artifacts|Where-Object{$_.role -ceq 'bun_runtime'}).remote_name);$bundle=Join-Path ([string]$cfg.release_root) (($cfg.artifacts|Where-Object{$_.role -ceq 'worker_bundle'}).remote_name)
  $post=& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $certifier -Mode PostInitialize -ReleaseRoot $cfg.release_root -ConfigPath $reopen -StagingRoot $cfg.gate_root -GateId $cfg.gate_id -BunPath $bun -ServiceIdentity 'S-1-5-19' 2>&1;if($LASTEXITCODE -ne 0){throw 'M4F_DEPLOY_POST_INITIALIZE_FAILED'}
  $env:SYNTHIA_WORKER_CONFIG_SHA256=Hash $reopen;$verify=& $bun $bundle --verify-evolution-ledger $reopen 2>&1;if($LASTEXITCODE -ne 0){throw 'M4F_DEPLOY_LEDGER_REOPEN_FAILED'}
  Move-Item -LiteralPath $init -Destination ($init+'.archived') -ErrorAction Stop;Move-Item -LiteralPath $reopen -Destination ([string]$cfg.active_config_path) -ErrorAction Stop
  Emit @{status='reopen_promoted';initialize_archived=$true;initialize_process_stopped=$true;reopen_verified=$true;active_config_sha256=Hash ([string]$cfg.active_config_path);ledger_epoch=[string]$cfg.ledger_epoch;old_8443_untouched=$true;remote_mutation=$true};exit 0
}
if($phase -ceq 'localservice_task_register_and_start'){
  [void](OldWorker)
  if($null -ne (Get-ScheduledTask -TaskName ([string]$cfg.task_name) -ErrorAction SilentlyContinue)){throw 'M4F_DEPLOY_TASK_ALREADY_EXISTS'}
  $launcher=Join-Path ([string]$cfg.release_root) (($cfg.artifacts|Where-Object{$_.role -ceq 'launcher'}).remote_name);$bun=Join-Path ([string]$cfg.release_root) (($cfg.artifacts|Where-Object{$_.role -ceq 'bun_runtime'}).remote_name);$password=Join-Path ([string]$cfg.release_root) (($cfg.artifacts|Where-Object{$_.role -ceq 'pfx_password'}).remote_name)
  $logRoot=[string](Get-Content -LiteralPath $cfg.active_config_path -Raw|ConvertFrom-Json).evolution_eval_log_root
  $wrapper=Join-Path ([string]$cfg.release_root) 'run-18443-localservice.cmd';$lines=@('@echo off','setlocal','set "SYNTHIA_WORKER_ROOT='+$cfg.release_root+'"','set "SYNTHIA_WORKER_BUN='+$bun+'"','set "SYNTHIA_WORKER_CONFIG='+$cfg.active_config_path+'"','set "SYNTHIA_WORKER_SERVICE_IDENTITY=S-1-5-19"','set "SYNTHIA_WORKER_LOG_ROOT='+$logRoot+'"','set "SYNTHIA_M4F_STAGING_ROOT='+$cfg.gate_root+'"','set "SYNTHIA_M4F_GATE_ID='+$cfg.gate_id+'"','call "'+$launcher+'"')
  [IO.File]::WriteAllLines($wrapper,$lines,[Text.Encoding]::ASCII)
  SealFile $wrapper
  $action=New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/d /c "'+$wrapper+'"') -WorkingDirectory ([string]$cfg.release_root)
  $principal=New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 0 -ExecutionTimeLimit (New-TimeSpan -Days 1) -StartWhenAvailable:$false
  [void](Register-ScheduledTask -TaskName ([string]$cfg.task_name) -Action $action -Principal $principal -Settings $settings -Force:$false)
  Start-ScheduledTask -TaskName ([string]$cfg.task_name);$deadline=[DateTime]::UtcNow.AddSeconds(60);do{Start-Sleep -Milliseconds 250;$listener=@(Get-NetTCPConnection -State Listen -LocalPort 18443 -ErrorAction SilentlyContinue)}while($listener.Count -eq 0 -and [DateTime]::UtcNow -lt $deadline)
  if($listener.Count -ne 1){throw 'M4F_DEPLOY_18443_LISTENER_MISSING'}
  $pid=[int]$listener[0].OwningProcess;$proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pid);$owner=$proc|Invoke-CimMethod -MethodName GetOwnerSid
  if($owner.Sid -cne 'S-1-5-19'){throw 'M4F_DEPLOY_SERVICE_IDENTITY_MISMATCH'}
  Emit @{status='started';task_name=[string]$cfg.task_name;task_definition_sha256=TaskHash ([string]$cfg.task_name);supervisor_wrapper_sha256=Hash $wrapper;task_state=(Get-ScheduledTask -TaskName ([string]$cfg.task_name)).State.ToString();pid=$pid;process_start_utc=([DateTime]$proc.CreationDate).ToUniversalTime().ToString('o');owner_sid=[string]$owner.Sid;listener_port=18443;old_8443_untouched=$true;remote_mutation=$true};exit 0
}
if($phase -ceq 'process_listener_ledger_evidence_collect'){
  $old=OldWorker;$task=Get-ScheduledTask -TaskName ([string]$cfg.task_name) -ErrorAction Stop;$listener=@(Get-NetTCPConnection -State Listen -LocalPort 18443 -ErrorAction Stop)
  if($listener.Count -ne 1){throw 'M4F_DEPLOY_18443_LISTENER_DRIFT'};$pid=[int]$listener[0].OwningProcess;$proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pid);$owner=$proc|Invoke-CimMethod -MethodName GetOwnerSid
  $active=Get-Content -LiteralPath $cfg.active_config_path -Raw|ConvertFrom-Json;$ledger=Get-Content -LiteralPath (Join-Path ([string]$active.evolution_eval_ledger_root) 'ledger.json') -Raw|ConvertFrom-Json
  if($ledger.ledger_epoch -cne [string]$cfg.ledger_epoch -or $active.evolution_eval_ledger_mode -cne 'reopen'){throw 'M4F_DEPLOY_LEDGER_EVIDENCE_INVALID'}
  $forbidden=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -in @('vivado.exe','vivado_lab.exe','hw_server.exe') -and $_.CreationDate -ge $proc.CreationDate})
  if($forbidden.Count -ne 0){throw 'M4F_DEPLOY_FORBIDDEN_PROCESS_OBSERVED'}
  Emit @{status='observed';task=@{name=[string]$cfg.task_name;state=$task.State.ToString();principal_sid='S-1-5-19';restart_count=0;definition_sha256=TaskHash ([string]$cfg.task_name)};process=@{pid=$pid;start_utc=([DateTime]$proc.CreationDate).ToUniversalTime().ToString('o');owner_sid=[string]$owner.Sid};listener=@{port=18443;pid=$pid};ledger=@{epoch=[string]$ledger.ledger_epoch;mode='reopen';metadata_sha256=Hash (Join-Path ([string]$active.evolution_eval_ledger_root) 'ledger.json')};active_config_sha256=Hash ([string]$cfg.active_config_path);old_8443=$old;old_8443_untouched=$true;secret_material_emitted=$false;remote_mutation=$false};exit 0
}
throw 'M4F_DEPLOY_PHASE_INVALID'
`;

function processEvidence(result: RawProcessResult): ProcessEvidence {
  const timedOut = result.errorCode === "ETIMEDOUT";
  return {
    exit_status: result.status,
    signal: result.signal,
    error_code: result.errorCode,
    timed_out: timedOut,
    outcome_ambiguous: timedOut || result.signal !== null || result.errorCode !== null || result.status !== 0,
    stdout_length: result.stdout.length,
    stdout_sha256: sha256(result.stdout),
    stderr_length: result.stderr.length,
    stderr_sha256: sha256(result.stderr),
    retry_permitted: false,
  };
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const item = object(value);
  return item && exactKeys(item, keys) ? item : null;
}

function validOldWorker(value: unknown, config: M4fDirectDeploymentConfigV1): boolean {
  const old = exactObject(value, ["listener_count", "pid", "start_utc", "task_definition_sha256", "task_state"]);
  return !!old && old.pid === config.protected_8443.pid
    && old.start_utc === config.protected_8443.process_start_utc
    && old.listener_count === 1
    && old.task_definition_sha256 === config.protected_8443.task_definition_sha256
    && typeof old.task_state === "string" && old.task_state.length > 0;
}

function validPhasePayload(
  value: Record<string, unknown>,
  phase: string,
  config: M4fDirectDeploymentConfigV1,
): boolean {
  const common = ["hardware_action_performed", "phase", "retry_permitted", "schema", "status", "vivado_executed"];
  const exact = (extra: readonly string[]) => exactKeys(value, [...common, ...extra]);
  if (phase === "transport_and_remote_read_only_preflight") {
    return exact(["backing_root_exists", "gate_root_exists", "listener_18443_count", "old_8443", "release_root_exists", "remote_mutation"])
      && value.status === "passed" && validOldWorker(value.old_8443, config)
      && value.gate_root_exists === true && value.backing_root_exists === true
      && value.release_root_exists === false && value.listener_18443_count === 0
      && value.remote_mutation === false;
  }
  if (phase === "exclusive_version_root_create") {
    return exact(["exclusive_create", "old_8443_untouched", "release_root", "remote_mutation"])
      && value.status === "created" && value.release_root === config.release_root
      && value.exclusive_create === true && value.old_8443_untouched === true
      && value.remote_mutation === true;
  }
  if (phase === "remote_hash_acl_tls_seal") {
    const tls = exactObject(value.tls, ["certificate_sha256", "ip_san", "issuer", "not_after_utc", "server_auth_eku"]);
    const publicArtifacts = Array.isArray(value.public_artifacts) ? value.public_artifacts : null;
    const expected = config.artifacts.filter((item) => !item.secret)
      .map((item) => `${item.role}:${item.sha256}`).sort();
    const observed = publicArtifacts?.map((raw) => {
      const item = exactObject(raw, ["role", "sha256"]);
      return item && typeof item.role === "string" && HASH.test(String(item.sha256))
        ? `${item.role}:${item.sha256}` : null;
    });
    return exact(["old_8443_untouched", "public_artifacts", "remote_mutation", "secret_artifacts_verified", "secret_hashes_emitted", "tls"])
      && value.status === "sealed" && value.secret_artifacts_verified === SECRET_ROLES.size
      && value.secret_hashes_emitted === false && value.old_8443_untouched === true
      && value.remote_mutation === true && !!observed && !observed.includes(null)
      && canonicalJson(observed.sort()) === canonicalJson(expected)
      && !!tls && tls.ip_san === config.tls.required_ip_san && tls.server_auth_eku === true
      && tls.issuer === config.tls.expected_issuer
      && tls.certificate_sha256 === config.tls.expected_certificate_sha256
      && tls.not_after_utc === config.tls.expected_not_after_utc;
  }
  const ceremonyRoot = `${config.gate_root}\\ceremony-${config.gate_id}`;
  if (phase === "stage_and_initialize_once") {
    return exact(["initialize_config", "initialize_process_stopped", "ledger_epoch", "old_8443_untouched", "remote_mutation", "reopen_config"])
      && value.status === "initialized_once"
      && value.initialize_config === `${ceremonyRoot}\\worker-66.initialize.json`
      && value.reopen_config === `${ceremonyRoot}\\worker-66.reopen.json`
      && value.ledger_epoch === config.ledger_epoch && value.initialize_process_stopped === true
      && value.old_8443_untouched === true && value.remote_mutation === true;
  }
  if (phase === "post_initialize_stop_and_reopen_verify") {
    return exact(["active_config_sha256", "initialize_archived", "initialize_process_stopped", "ledger_epoch", "old_8443_untouched", "remote_mutation", "reopen_verified"])
      && value.status === "reopen_promoted" && HASH.test(String(value.active_config_sha256))
      && value.initialize_archived === true && value.initialize_process_stopped === true
      && value.reopen_verified === true && value.ledger_epoch === config.ledger_epoch
      && value.old_8443_untouched === true && value.remote_mutation === true;
  }
  if (phase === "localservice_task_register_and_start") {
    return exact(["listener_port", "old_8443_untouched", "owner_sid", "pid", "process_start_utc", "remote_mutation", "supervisor_wrapper_sha256", "task_definition_sha256", "task_name", "task_state"])
      && value.status === "started" && value.task_name === config.task_name
      && HASH.test(String(value.task_definition_sha256)) && HASH.test(String(value.supervisor_wrapper_sha256))
      && Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && iso(value.process_start_utc)
      && value.owner_sid === LOCAL_SERVICE_SID && value.listener_port === 18443
      && typeof value.task_state === "string" && value.task_state.length > 0
      && value.old_8443_untouched === true && value.remote_mutation === true;
  }
  if (phase === "process_listener_ledger_evidence_collect") {
    const task = exactObject(value.task, ["definition_sha256", "name", "principal_sid", "restart_count", "state"]);
    const process = exactObject(value.process, ["owner_sid", "pid", "start_utc"]);
    const listener = exactObject(value.listener, ["pid", "port"]);
    const ledger = exactObject(value.ledger, ["epoch", "metadata_sha256", "mode"]);
    return exact(["active_config_sha256", "ledger", "listener", "old_8443", "old_8443_untouched", "process", "remote_mutation", "secret_material_emitted", "task"])
      && value.status === "observed" && !!task && task.name === config.task_name
      && task.principal_sid === LOCAL_SERVICE_SID && task.restart_count === 0
      && typeof task.state === "string" && task.state.length > 0 && HASH.test(String(task.definition_sha256))
      && !!process && Number.isSafeInteger(process.pid) && Number(process.pid) > 0
      && process.owner_sid === LOCAL_SERVICE_SID && iso(process.start_utc)
      && !!listener && listener.port === 18443 && listener.pid === process.pid
      && !!ledger && ledger.epoch === config.ledger_epoch && ledger.mode === "reopen"
      && HASH.test(String(ledger.metadata_sha256)) && HASH.test(String(value.active_config_sha256))
      && validOldWorker(value.old_8443, config) && value.old_8443_untouched === true
      && value.secret_material_emitted === false && value.remote_mutation === false;
  }
  return false;
}

function parsePhase(
  result: RawProcessResult,
  phase: string,
  config: M4fDirectDeploymentConfigV1,
): DeploymentPhaseResult {
  const process = processEvidence(result);
  if (result.stdout.length > MAX_STREAM_BYTES || result.stderr.length > MAX_STREAM_BYTES
    || result.status !== 0 || result.signal !== null || result.errorCode !== null || result.stderr.length !== 0) {
    fail("M4F_DIRECT_DEPLOYMENT_PHASE_FAILED", phase, { process, remote_effect_state: "unknown" });
  }
  let payloadValue: Record<string, unknown> | null = null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
    if (lines.length !== 1) throw new Error("line count");
    payloadValue = object(JSON.parse(lines[0]!));
  } catch { fail("M4F_DIRECT_DEPLOYMENT_PHASE_OUTPUT_INVALID", phase, { process }); }
  if (!payloadValue || payloadValue.schema !== "synthia-m4f-direct-deployment-phase.v1"
    || payloadValue.phase !== phase || payloadValue.retry_permitted !== false
    || payloadValue.vivado_executed !== false || payloadValue.hardware_action_performed !== false
    || !validPhasePayload(payloadValue, phase, config)) {
    fail("M4F_DIRECT_DEPLOYMENT_PHASE_OUTPUT_INVALID", phase, { process });
  }
  return { phase, process, payload: payloadValue };
}

function sameFacts(left: LocalArtifactFact[], right: LocalArtifactFact[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function executeM4fDirectDeployment(
  raw: unknown,
  confirmation: string,
  dependencies: DirectDeploymentDependencies = systemDependencies,
): M4fDirectDeploymentRecordV1 {
  const config = validateM4fDirectDeploymentConfig(raw);
  const plan = planM4fDirectDeployment(config, dependencies);
  if (confirmation !== plan.confirmation) fail("M4F_DIRECT_DEPLOYMENT_CONFIRMATION_REQUIRED", "confirmation", { remote_effect_state: "not_started" });
  const admission = validateBindings(config);
  const transportBefore = captureM4fDirectTransportInputs(admission);
  const effective = dependencies.runEffectiveConfig(admission);
  if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null || effective.stderr.length !== 0) {
    fail("M4F_DIRECT_DEPLOYMENT_EFFECTIVE_CONFIG_FAILED", "transport", { process: processEvidence(effective), remote_effect_state: "not_started" });
  }
  auditDirectSshEffectiveConfig(effective.stdout, admission);
  if (sha256(effective.stdout) !== admission.target.expected_effective_config_sha256) {
    fail("M4F_DIRECT_DEPLOYMENT_EFFECTIVE_CONFIG_DRIFT", "transport", {
      process: processEvidence(effective),
      remote_effect_state: "not_started",
    });
  }
  const phases: DeploymentPhaseResult[] = [];
  const uploads: UploadResult[] = [];
  const run = (phase: string) => {
    try {
      const script = phaseScript(config, phase);
      if (sha256(Buffer.from(M4F_DIRECT_DEPLOYMENT_REMOTE_PROGRAM, "utf8")) !== config.expected_remote_program_sha256) {
        fail("M4F_DIRECT_DEPLOYMENT_REMOTE_SOURCE_DRIFT", phase);
      }
      const result = parsePhase(dependencies.runPhase(admission, phase, script), phase, config);
      phases.push(result);
      return result;
    } catch (error) {
      if (error instanceof M4fDirectDeploymentFailure) {
        throw new M4fDirectDeploymentFailure({
          ...error.detail,
          completed_phases: phases,
          completed_uploads: uploads.filter((item) => !item.secret),
        });
      }
      throw error;
    }
  };
  run("transport_and_remote_read_only_preflight");
  run("exclusive_version_root_create");
  for (const artifact of config.artifacts) {
    const before = readArtifact(artifact).fact;
    const result = dependencies.upload(admission, artifact, config.release_root + "\\" + artifact.remote_name);
    const process = processEvidence(result);
    uploads.push({ role: artifact.role, remote_name: artifact.remote_name, secret: artifact.secret, process });
    if (result.status !== 0 || result.signal !== null || result.errorCode !== null || result.stderr.length !== 0) {
      fail("M4F_DIRECT_DEPLOYMENT_UPLOAD_FAILED", "versioned_release_tls_config_upload", {
        role: artifact.secret ? "redacted_secret_artifact" : artifact.role,
        process,
        completed_phases: phases,
        completed_uploads: uploads.filter((item) => !item.secret),
        remote_effect_state: "unknown",
      });
    }
    if (!sameFacts([before], [readArtifact(artifact).fact])) fail("M4F_DIRECT_DEPLOYMENT_LOCAL_ARTIFACT_DRIFT", "versioned_release_tls_config_upload", { role: artifact.role });
  }
  run("remote_hash_acl_tls_seal");
  run("stage_and_initialize_once");
  run("post_initialize_stop_and_reopen_verify");
  run("localservice_task_register_and_start");
  run("process_listener_ledger_evidence_collect");
  const postInitialize = phases.find((item) => item.phase === "post_initialize_stop_and_reopen_verify")!.payload;
  const started = phases.find((item) => item.phase === "localservice_task_register_and_start")!.payload;
  const observed = phases.find((item) => item.phase === "process_listener_ledger_evidence_collect")!.payload;
  const observedTask = object(observed.task)!;
  const observedProcess = object(observed.process)!;
  if (observed.active_config_sha256 !== postInitialize.active_config_sha256
    || observedTask.definition_sha256 !== started.task_definition_sha256
    || observedProcess.pid !== started.pid
    || observedProcess.start_utc !== started.process_start_utc) {
    fail("M4F_DIRECT_DEPLOYMENT_CROSS_PHASE_DRIFT", "finalization", {
      completed_phases: phases,
      completed_uploads: uploads.filter((item) => !item.secret),
    });
  }
  const transportAfter = captureM4fDirectTransportInputs(admission, "network");
  if (canonicalJson(transportBefore) !== canonicalJson(transportAfter)) fail("M4F_DIRECT_DEPLOYMENT_TRANSPORT_DRIFT", "finalization");
  const artifactFacts = config.artifacts.map((artifact) => readArtifact(artifact).fact);
  if (!sameFacts(plan.artifacts, artifactFacts)) fail("M4F_DIRECT_DEPLOYMENT_LOCAL_ARTIFACT_DRIFT", "finalization");
  return {
    schema: "synthia-m4f-direct-deployment-record.v1",
    status: "deployed_observed",
    gate_id: config.gate_id,
    deployment_id: config.deployment_id,
    recorded_at_utc: dependencies.now().toISOString(),
    confirmation_sha256: sha256(confirmation),
    config_sha256: plan.config_sha256,
    plan_sha256: plan.plan_sha256,
    source_sha256: plan.source_sha256,
    remote_program_sha256: plan.remote_program_sha256,
    transport_inputs_before: transportBefore,
    transport_inputs_after: transportAfter,
    artifacts: artifactFacts.filter((item) => !item.secret),
    uploads: uploads.filter((item) => !item.secret),
    phases,
    secret_bytes_in_evidence: false,
    secret_hashes_in_evidence: false,
    retry_permitted: false,
    automatic_cleanup: false,
    vivado_executed: false,
    hardware_action_performed: false,
    old_8443_untouched: true,
  };
}

function scpOptions(config: M4fDirectAdmissionConfig): string[] {
  const options = buildDirectSshOptions(config);
  return options.filter((value, index) => !(index === 0 && value === "-T"));
}

const systemDependencies: DirectDeploymentDependencies = {
  sourceBytes: () => readFileSync(new URL(import.meta.url)),
  remoteProgramBytes: () => Buffer.from(M4F_DIRECT_DEPLOYMENT_REMOTE_PROGRAM, "utf8"),
  runEffectiveConfig(config) {
    const result = spawnSync(SSH_PATH, buildDirectSshEffectiveArguments(config), { encoding: "buffer", timeout: 15_000, windowsHide: true });
    return { status: result.status, signal: result.signal, errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
  },
  runPhase(config, _phase, script) {
    const result = spawnSync(SSH_PATH, [...buildDirectSshOptions(config), TARGET_HOST, buildDirectPowerShellStdinCommand()], { input: script, encoding: "buffer", timeout: 240_000, maxBuffer: MAX_STREAM_BYTES, windowsHide: true });
    return { status: result.status, signal: result.signal, errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
  },
  upload(config, artifact, remotePath) {
    const target = `${TARGET_USER}@${TARGET_HOST}:${remotePath.replaceAll("\\", "/")}`;
    const result = spawnSync(SCP_PATH, [...scpOptions(config), "--", artifact.local_path, target], { encoding: "buffer", timeout: 240_000, maxBuffer: MAX_STREAM_BYTES, windowsHide: true });
    return { status: result.status, signal: result.signal, errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
  },
  now: () => new Date(),
};

function recordFailure(absolute: string, error: M4fDirectDeploymentFailure): never {
  const failurePath = resolve(absolute, "deployment-failure.json");
  writeFileSync(failurePath, canonicalJson(error.detail) + "\n", { flag: "wx", mode: 0o600 });
  chmodSync(failurePath, 0o400);
  chmodSync(absolute, 0o500);
  throw error;
}

export function recordM4fDirectDeployment(
  raw: unknown,
  confirmation: string,
  evidencePath: string,
  dependencies: DirectDeploymentDependencies = systemDependencies,
): M4fDirectDeploymentRecordV1 {
  const plan = planM4fDirectDeployment(raw, dependencies);
  if (confirmation !== plan.confirmation) {
    fail("M4F_DIRECT_DEPLOYMENT_CONFIRMATION_REQUIRED", "confirmation", {
      remote_effect_state: "not_started",
    });
  }
  const absolute = resolve(evidencePath);
  mkdirSync(absolute, { recursive: false, mode: 0o700 });
  const planPath = resolve(absolute, "deployment-plan.json");
  writeFileSync(planPath, canonicalJson(plan) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(planPath, 0o400);
  try {
    const record = executeM4fDirectDeployment(raw, confirmation, dependencies);
    const recordPath = resolve(absolute, "deployment-record.json");
    writeFileSync(recordPath, canonicalJson(record) + "\n", { flag: "wx", mode: 0o600 });
    chmodSync(recordPath, 0o400);
    chmodSync(absolute, 0o500);
    return record;
  } catch (error) {
    if (error instanceof M4fDirectDeploymentFailure) return recordFailure(absolute, error);
    chmodSync(absolute, 0o500);
    throw error;
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const explicitMode = args[0] === "plan" || args[0] === "execute";
  const mode = explicitMode ? args[0]! : "plan";
  const configPath = explicitMode ? args[1] : args[0];
  const evidencePath = explicitMode ? args[2] : undefined;
  if (!configPath) throw new Error("M4F_DIRECT_DEPLOYMENT_CONFIG_REQUIRED");
  const config = JSON.parse(readFileSync(resolve(configPath), "utf8"));
  if (mode === "plan") {
    console.log(JSON.stringify(planM4fDirectDeployment(config), null, 2));
    return;
  }
  if (mode !== "execute" || !evidencePath) throw new Error("M4F_DIRECT_DEPLOYMENT_MODE_INVALID");
  const confirmation = process.env.SYNTHIA_M4F_DIRECT_DEPLOYMENT_CONFIRMATION ?? "";
  console.log(JSON.stringify(recordM4fDirectDeployment(config, confirmation, evidencePath), null, 2));
}

if (import.meta.main) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : "M4F_DIRECT_DEPLOYMENT_FAILED");
    process.exitCode = 1;
  }
}
