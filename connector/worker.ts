import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createReadStream, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { sha256 } from "../core/src/hashing.ts";
import type { ConnectorCapability, EvidenceManifest, Job, JobRequest } from "./index.ts";
import { EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER, EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER, EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER, MAX_EVIDENCE_ENTRIES, MAX_EVIDENCE_ENTRY_BYTES, MAX_EVIDENCE_TOTAL_BYTES, REMOTE_SCHEMA_VERSION, type ConnectorEndpoint, type ConnectorRegistration, type DataClassification, type DiscoverySnapshot, type EvolutionEvalRemoteAttestation, type RemoteEnvelope } from "./remote.ts";
import {
  EVOLUTION_EVAL_HTTP_BODY_MAX_BYTES,
  EVOLUTION_EVAL_EVIDENCE_LIMITS,
  EVOLUTION_EVAL_SPOOL_HARD_CAP_BYTES,
  EvolutionEvalProtocolError,
  canonicalEvolutionEvalHash,
  evaluateEvolutionEvalDiscoveryPolicy,
  effectiveEvolutionEvalTimeoutMs,
  validateCoreIssuedEvalBinding,
  validateEvolutionEvalRemoteRequest,
  validateEvolutionEvalSealedInput,
  type CoreIssuedEvalBinding,
  type EvalLedgerQuery,
  type EvolutionEvalRemoteRequestV1,
  type EvolutionEvalConnectorEvidenceContentV1,
  type EvolutionEvalConnectorEvidenceEntryV1,
  type EvolutionEvalConnectorEvidenceManifestV1,
  type EvolutionEvalRetentionResultV1,
  type ValidatedEvolutionEvalSealedInput,
} from "./evolution-eval.ts";
import type { EvolutionEvalLedger, EvolutionEvalProcessIdentity } from "./evolution-eval-ledger.ts";
import { readWindowsProcessIdentityFacts } from "./vivado.ts";

export interface WorkerExecutionResult {
  outcome?: "success" | "failure" | "timeout" | "lost" | "unknown_effect";
  output?: string;
  evidence?: EvidenceManifest;
  error_code?: string;
  stdout?: string;
  stderr?: string;
}
export interface WorkerExecution { discover(): Promise<DiscoverySnapshot>; execute(request: JobRequest, workspace: string): Promise<WorkerExecutionResult>; }

function validEvolutionEvalRemoteAttestation(discovery: DiscoverySnapshot | undefined): discovery is DiscoverySnapshot & {
  readonly active_config_sha256: string;
  readonly worker_process_instance_id: string;
  readonly vivado_toolchain_attestation_sha256: string;
  readonly live_mapping_health: "healthy";
} {
  return typeof discovery?.active_config_sha256 === "string"
    && /^[0-9a-f]{64}$/.test(discovery.active_config_sha256)
    && typeof discovery.worker_process_instance_id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(discovery.worker_process_instance_id)
    && typeof discovery.vivado_toolchain_attestation_sha256 === "string"
    && /^[0-9a-f]{64}$/.test(discovery.vivado_toolchain_attestation_sha256)
    && discovery.live_mapping_health === "healthy";
}
export interface EvolutionEvalExecutionResult {
  readonly terminalState: "succeeded" | "failed" | "timeout";
  readonly errorCode?: string | null;
  readonly evidence?: EvidenceManifest;
}
export interface EvolutionEvalPreparedExecution {
  readonly identity: EvolutionEvalProcessIdentity;
  execute(input: {
    readonly binding: CoreIssuedEvalBinding;
    readonly sealedInput: ValidatedEvolutionEvalSealedInput;
    readonly workspace: string;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    readonly onBeforeLaunch: () => Promise<boolean>;
  }): Promise<EvolutionEvalExecutionResult>;
  close(): Promise<void>;
}
export interface EvolutionEvalExecution {
  /** Production seam: create the inert guardian before durable acceptance. */
  prepare?(input: { readonly workspace: string }): Promise<EvolutionEvalPreparedExecution>;
  execute(input: {
    readonly binding: CoreIssuedEvalBinding;
    readonly sealedInput: ValidatedEvolutionEvalSealedInput;
    readonly workspace: string;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    readonly onProcessStarted: (identity: EvolutionEvalProcessIdentity) => Promise<boolean>;
    /** Called at the last inert boundary, immediately before the command is released. */
    readonly onBeforeLaunch: () => Promise<boolean>;
  }): Promise<EvolutionEvalExecutionResult>;
}
export interface EvolutionEvalWorkerOptions {
  readonly ledger: EvolutionEvalLedger;
  readonly spoolRoot: string;
  readonly execution: EvolutionEvalExecution;
  readonly toolchainProfileHash: string;
  readonly now?: () => Date;
  readonly stopGraceMs?: number;
  /** Platform process-tree proof seam; production defaults to OS process groups / Windows Job guardian. */
  readonly processSupervisor?: EvolutionEvalProcessSupervisor;
  /** Revalidates current config/process/toolchain identity immediately before a new effect boundary. */
  readonly assertNewEffectReady?: () => Promise<void>;
}
export interface EvolutionEvalProcessSupervisor {
  isTreeStopped(identity: EvolutionEvalProcessIdentity): boolean;
  ownsIdentity(identity: EvolutionEvalProcessIdentity): Promise<boolean>;
  stopAndConfirm(identity: EvolutionEvalProcessIdentity, graceMs: number): Promise<boolean>;
}
export interface WorkerRuntimeOptions { endpoint: ConnectorEndpoint; workspaceRoot: string; execution?: WorkerExecution; now?: () => Date; evolutionEval?: EvolutionEvalWorkerOptions; }
const terminal = new Set<Job["state"]>(["succeeded", "failed", "cancelled", "timeout", "lost", "unknown_effect"]);
const idRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const classes: readonly DataClassification[] = ["public", "internal", "confidential", "restricted"];
const MAX_CONTENT_BYTES = 256 * 1024;
const CONTENT_WINDOW_BYTES = 128 * 1024;
const evidenceNameRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const EVOLUTION_EVAL_ADMISSION_BYTES = 256 * 1024 * 1024;
const EVOLUTION_EVAL_ADMISSION_SLOTS = EVOLUTION_EVAL_SPOOL_HARD_CAP_BYTES / EVOLUTION_EVAL_ADMISSION_BYTES;
const WINDOWS_MOVE_WRITE_THROUGH = String.raw`
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SynthiaDurableMove {
  const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
  const uint OPEN_EXISTING = 3, FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION {
    public uint Attributes; public FILETIME CreationTime, LastAccessTime, LastWriteTime;
    public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
  }
  [DllImport("kernel32.dll", EntryPoint="MoveFileExW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool MoveFileExW(string source, string target, uint flags);
  [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(IntPtr handle, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  static bool Identity(string path, out uint volume, out uint high, out uint low) {
    volume = high = low = 0;
    IntPtr handle = CreateFileW(path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
    if (handle == new IntPtr(-1)) return false;
    try {
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(handle, out info)) return false;
      volume = info.VolumeSerialNumber; high = info.FileIndexHigh; low = info.FileIndexLow;
      return high != 0 || low != 0;
    } finally { CloseHandle(handle); }
  }
  static bool Same(uint av, uint ah, uint al, uint bv, uint bh, uint bl) {
    return av == bv && ah == bh && al == bl;
  }
  public static int MoveNoReplace(string source, string target, string mutexName) {
    using (var mutex = new System.Threading.Mutex(false, mutexName)) {
      bool held = false;
      try {
        try { held = mutex.WaitOne(System.TimeSpan.FromMinutes(2)); }
        catch (System.Threading.AbandonedMutexException) { held = true; }
        if (!held) return 258;
        uint sv, sh, sl; if (!Identity(source, out sv, out sh, out sl)) return 6;
        if (MoveFileExW(source, target, 8)) {
          uint tv, th, tl;
          return Identity(target, out tv, out th, out tl) && Same(sv, sh, sl, tv, th, tl) ? 0 : 13;
        }
        int moveError = Marshal.GetLastWin32Error();
        if (moveError == 80 || moveError == 183) {
          uint rv, rh, rl, tv, th, tl;
          if (!Identity(source, out rv, out rh, out rl) || !Same(sv, sh, sl, rv, rh, rl)
            || !Identity(target, out tv, out th, out tl)) return 13;
        }
        return moveError;
      } finally {
        if (held) mutex.ReleaseMutex();
      }
    }
  }
}
'@
$code = [SynthiaDurableMove]::MoveNoReplace(
  $env:SYNTHIA_EVOLUTION_MOVE_SOURCE,
  $env:SYNTHIA_EVOLUTION_MOVE_TARGET,
  $env:SYNTHIA_EVOLUTION_MOVE_MUTEX)
if ($code -eq 0) { exit 0 }
if ($code -eq 80 -or $code -eq 183) { exit 17 }
[Console]::Error.Write($code)
exit 18
`;

function windowsMoveWriteThrough(source: string, target: string): "created" | "exists" {
  const sourceWasDirectory = lstatSync(source).isDirectory();
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(WINDOWS_MOVE_WRITE_THROUGH, "utf16le").toString("base64"),
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      SYNTHIA_EVOLUTION_MOVE_SOURCE: source,
      SYNTHIA_EVOLUTION_MOVE_TARGET: target,
      SYNTHIA_EVOLUTION_MOVE_MUTEX: `Local\\SynthiaEvolutionMove-${sha256(target)}`,
    },
  });
  if (!result.error && result.stderr.trim() === "" && result.status === 0) {
    let sourceAbsent = false;
    try { lstatSync(source); } catch (error) {
      sourceAbsent = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    try {
      if (sourceAbsent && lstatSync(target).isDirectory() === sourceWasDirectory) return "created";
    } catch {}
  }
  if (!result.error && result.stderr.trim() === "" && result.status === 17) {
    try {
      if (lstatSync(source).isDirectory() === sourceWasDirectory) {
        lstatSync(target);
        return "exists";
      }
    } catch {}
  }
  throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_UNAVAILABLE", `MoveFileExW failed: ${result.stderr.trim() || result.error?.message || result.status}`);
}
const unavailableExecution: WorkerExecution = {
  async discover() { return { connector_id: "unavailable", connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: "none", vivado_version: "unavailable", vivado_patch: "unavailable", part_catalog_hash: "unavailable", sdk_worker_build_hash: "unavailable", capabilities: [], toolchain_profile_hash: "unavailable", license_status: "unknown", unsupported: ["vivado_discovery", "vivado_execution"] }; },
  async execute() { return { outcome: "failure", error_code: "UNSUPPORTED_VIVADO" }; },
};
function good(v: unknown): v is string { return typeof v === "string" && v.trim().length > 0; }
function responseError(code: string, message: string, status: number): Response { return Response.json({ error_code: code, message }, { status }); }
function copy<T>(v: T): T { return structuredClone(v); }
function exactObjectKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const actual = new Set(keys as string[]);
  return required.every((key) => actual.has(key))
    && [...actual].every((key) => required.includes(key) || optional.includes(key));
}

async function boundedJson(request: Request, maximumBytes: number): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_RESOURCE_LIMIT");
  }
  if (!request.body) throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_INVALID_REQUEST");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_RESOURCE_LIMIT");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_INVALID_REQUEST"); }
  try { return JSON.parse(text); }
  catch { throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_INVALID_REQUEST"); }
}

function evalCommon(binding: CoreIssuedEvalBinding, ledgerEpoch: string) {
  return {
    schema: "evolution-eval-ledger-query.v1" as const,
    connector_job_id: binding.dispatch.connector_job_id,
    connector_idempotency_key: binding.dispatch.connector_idempotency_key,
    dispatch_request_hash: binding.dispatch_request_hash,
    ledger_epoch: ledgerEpoch,
  };
}

async function syncFile(path: string): Promise<void> {
  // FlushFileBuffers on Windows requires a handle opened for writing.
  const handle = await open(path, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") {
    const details = await stat(path);
    if (!details.isDirectory()) throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_UNAVAILABLE");
    return;
  }
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function evolutionEvidenceMediaType(name: string): EvolutionEvalConnectorEvidenceEntryV1["media_type"] | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".rpt") || lower.endsWith(".log") || lower.endsWith(".tcl")) return "text/plain";
  if (lower.endsWith(".bit") || lower.endsWith(".dcp")) return "application/octet-stream";
  return null;
}

function evidenceArtifactClassification(
  name: string,
): EvolutionEvalConnectorEvidenceEntryV1["artifact_classification"] {
  return name.toLowerCase().endsWith(".bit")
    ? "experimental/evolution_eval"
    : "evolution_eval_evidence";
}

function assertConnectorEvidenceManifest(
  value: unknown,
  binding: CoreIssuedEvalBinding,
): EvolutionEvalConnectorEvidenceManifestV1 {
  if (!exactObjectKeys(value, [
    "connector_job_id", "dispatch_request_hash", "entries", "eval_job_id", "manifest_hash", "schema",
  ])) throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
  const manifest = value as unknown as EvolutionEvalConnectorEvidenceManifestV1;
  if (manifest.schema !== "evolution-eval-connector-evidence-manifest.v1"
    || manifest.eval_job_id !== binding.dispatch.eval_job_id
    || manifest.connector_job_id !== binding.dispatch.connector_job_id
    || manifest.dispatch_request_hash !== binding.dispatch_request_hash
    || !Array.isArray(manifest.entries)
    || manifest.entries.length > EVOLUTION_EVAL_EVIDENCE_LIMITS.entries
    || !/^[0-9a-f]{64}$/.test(String(manifest.manifest_hash))) {
    throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
  }
  let totalBytes = 0;
  let priorName: string | undefined;
  const names = new Set<string>();
  for (const entry of manifest.entries) {
    if (!exactObjectKeys(entry, [
      "artifact_classification", "media_type", "name", "sha256", "size_bytes", "usage_classification",
    ]) || typeof entry.name !== "string" || !evidenceNameRe.test(entry.name)
      || names.has(entry.name) || (priorName !== undefined && priorName >= entry.name)
      || !/^[0-9a-f]{64}$/.test(String(entry.sha256))
      || !Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0
      || entry.size_bytes > EVOLUTION_EVAL_EVIDENCE_LIMITS.entryBytes
      || !(["application/json", "text/plain", "application/octet-stream"] as const).includes(entry.media_type)
      || (evolutionEvidenceMediaType(entry.name) !== null
        && evolutionEvidenceMediaType(entry.name) !== entry.media_type)
      || entry.artifact_classification !== evidenceArtifactClassification(entry.name)
      || entry.usage_classification !== "evolution_eval_only") {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    names.add(entry.name);
    priorName = entry.name;
    totalBytes += entry.size_bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > EVOLUTION_EVAL_EVIDENCE_LIMITS.totalBytes) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_LIMIT_EXCEEDED");
    }
  }
  const { manifest_hash: ignored, ...canonical } = manifest;
  if (canonicalEvolutionEvalHash(canonical) !== manifest.manifest_hash) {
    throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
  }
  return structuredClone(manifest);
}

interface AdmissionOwnerProcess {
  readonly pid: number;
  readonly start_token: string;
}

async function readProcessStartToken(pid: number): Promise<string | null> {
  try {
    let source: string;
    if (process.platform === "linux") {
      const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
      const tail = statLine.slice(statLine.lastIndexOf(")") + 2).trim().split(/\s+/);
      const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      if (!tail[19] || !bootId) return null;
      source = `${bootId}:${pid}:${tail[19]}`;
    } else if (process.platform === "win32") {
      const facts = readWindowsProcessIdentityFacts(pid);
      if (!facts) return null;
      source = `${pid}:${facts}`;
    } else {
      const bootResult = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
      const factsResult = spawnSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      const boot = bootResult.stdout.trim();
      const facts = factsResult.stdout.trim();
      if (bootResult.error || bootResult.status !== 0 || bootResult.stderr.trim() !== ""
        || factsResult.error || factsResult.status !== 0 || factsResult.stderr.trim() !== "" || !boot || !facts) return null;
      source = `${boot}:${pid}:${facts}`;
    }
    return source.trim().length > 0 ? sha256(source) : null;
  } catch {
    return null;
  }
}

async function currentAdmissionOwner(): Promise<AdmissionOwnerProcess> {
  const startToken = await readProcessStartToken(process.pid);
  if (!startToken) throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_UNAVAILABLE");
  return { pid: process.pid, start_token: startToken };
}

async function admissionOwnerState(owner: AdmissionOwnerProcess): Promise<"matching" | "gone" | "unknown"> {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") return "gone";
  }
  const observed = await readProcessStartToken(owner.pid);
  if (observed === null) return "unknown";
  return observed === owner.start_token ? "matching" : "gone";
}

class EvolutionEvalWorker {
  private readonly root: string;
  private readonly clock: () => Date;
  private readonly stopGraceMs: number;
  private readonly startupReconciliation: Promise<void>;
  private readonly retentionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly active = new Map<string, {
    readonly controller: AbortController;
    readonly settled: Promise<void>;
    readonly ownerToken: string;
    readonly processStarted: Promise<EvolutionEvalProcessIdentity | null>;
    readonly resolveProcessStarted: (identity: EvolutionEvalProcessIdentity | null) => void;
    identity?: EvolutionEvalProcessIdentity;
    stopAs?: "cancelled" | "timeout";
  }>();
  private spoolTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: EvolutionEvalWorkerOptions) {
    this.root = resolve(options.spoolRoot);
    this.clock = options.now ?? (() => new Date());
    this.stopGraceMs = options.stopGraceMs ?? 5_000;
    if (!options.toolchainProfileHash.match(/^[0-9a-f]{64}$/) || !Number.isSafeInteger(this.stopGraceMs)
      || this.stopGraceMs < 1 || this.stopGraceMs > 60_000) throw new Error("CONFIG_INVALID");
    this.startupReconciliation = this.reconcileSpoolAdmissions().catch(() => undefined);
    setInterval(() => { void this.reconcileSpoolAdmissions().catch(() => undefined); }, 60 * 60 * 1000).unref();
  }

  async query(bindingInput: CoreIssuedEvalBinding): Promise<EvalLedgerQuery> {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    const observation = await this.options.ledger.query(binding);
    if (observation.state === "terminal") await this.reconcileSpoolAdmissions();
    return observation;
  }

  reserve(binding: CoreIssuedEvalBinding): Promise<EvalLedgerQuery> {
    return this.options.ledger.queryOrReserve(validateCoreIssuedEvalBinding(binding));
  }

  async querySpool(bindingInput: CoreIssuedEvalBinding): Promise<{ schema: "evolution-eval-spool-result.v1"; binding: CoreIssuedEvalBinding; unacked_bytes: number; hard_cap_bytes: 2147483648 }> {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    await this.reconcileSpoolAdmissions();
    return {
      schema: "evolution-eval-spool-result.v1",
      binding,
      unacked_bytes: await this.spoolBytes(),
      hard_cap_bytes: EVOLUTION_EVAL_SPOOL_HARD_CAP_BYTES,
    };
  }

  async evidenceManifest(bindingInput: CoreIssuedEvalBinding): Promise<EvolutionEvalConnectorEvidenceManifestV1> {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    await this.reconcileRetentionForBinding(binding);
    await this.assertEvidenceReadable(binding);
    return this.readEvidenceManifest(binding);
  }

  async queryRetention(bindingInput: CoreIssuedEvalBinding): Promise<EvolutionEvalRetentionResultV1> {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    await this.startupReconciliation;
    await this.reconcileRetentionForBinding(binding);
    const observation = await this.options.ledger.getRetentionObservation(binding);
    if (observation.state === "absent") {
      return {
        schema: "evolution-eval-retention-result.v1",
        binding,
        state: "absent",
        retryable: false,
        authorization_kind: null,
        authorization_hash: null,
        connector_fact_hash: null,
        source_authorization_kind: null,
        source_authorization_hash: null,
        source_connector_fact_hash: null,
        error_code: null,
        physical_deleted: false,
      };
    }
    if (observation.state === "pending_ack") {
      return {
        schema: "evolution-eval-retention-result.v1",
        binding,
        state: "pending_ack",
        retryable: false,
        authorization_kind: null,
        authorization_hash: null,
        connector_fact_hash: null,
        source_authorization_kind: null,
        source_authorization_hash: null,
        source_connector_fact_hash: null,
        error_code: null,
        physical_deleted: false,
      };
    }
    if (observation.state === "acknowledged" || observation.state === "quarantined"
      || observation.state === "discarded" || observation.state === "cleaned" || observation.state === "expired") {
      const authorizationHash = observation.state === "acknowledged" || observation.state === "quarantined"
        || observation.state === "discarded" || observation.state === "cleaned"
        ? observation.authorizationHash : observation.factHash;
      const kind = observation.state === "acknowledged" ? "ack"
        : observation.state === "quarantined" ? "quarantine"
          : observation.state === "discarded" ? "discard"
            : observation.state === "expired" ? "expiry" : "cleanup";
      return this.retentionResult(
        binding,
        observation.state,
        kind,
        authorizationHash,
        observation.factHash,
        observation.state === "cleaned" ? {
          kind: observation.sourceKind,
          hash: observation.sourceAuthorizationHash,
          connectorFactHash: observation.authorizationFactHash,
        } : undefined,
      );
    }
    if (observation.state === "unavailable") {
      return {
        schema: "evolution-eval-retention-result.v1",
        binding,
        state: "transient_unavailable",
        retryable: true,
        authorization_kind: null,
        authorization_hash: null,
        connector_fact_hash: null,
        source_authorization_kind: null,
        source_authorization_hash: null,
        source_connector_fact_hash: null,
        error_code: "EVOLUTION_EVAL_LEDGER_UNAVAILABLE",
        physical_deleted: await this.evidenceBytesPurged(binding),
      };
    }
    throw new EvolutionEvalProtocolError(
      observation.state === "corrupt" ? "EVOLUTION_EVAL_EVIDENCE_CORRUPT" : "EVOLUTION_EVAL_EVIDENCE_NOT_AVAILABLE",
    );
  }

  async evidenceEntry(
    bindingInput: CoreIssuedEvalBinding,
    name: string,
  ): Promise<EvolutionEvalConnectorEvidenceContentV1> {
    const { binding, entry, path } = await this.evidenceEntryDescriptor(bindingInput, name);
    const bytes = await readFile(path);
    return {
      schema: "evolution-eval-connector-evidence-entry.v1",
      eval_job_id: binding.dispatch.eval_job_id,
      connector_job_id: binding.dispatch.connector_job_id,
      dispatch_request_hash: binding.dispatch_request_hash,
      name: entry.name,
      sha256: entry.sha256,
      size_bytes: entry.size_bytes,
      media_type: entry.media_type,
      content_base64: bytes.toString("base64"),
    };
  }

  async evidenceEntryDescriptor(bindingInput: CoreIssuedEvalBinding, name: string): Promise<{
    readonly binding: CoreIssuedEvalBinding;
    readonly entry: EvolutionEvalConnectorEvidenceEntryV1;
    readonly path: string;
  }> {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    if (!evidenceNameRe.test(name)) throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_NOT_AVAILABLE");
    await this.reconcileRetentionForBinding(binding);
    await this.assertEvidenceReadable(binding);
    const manifest = await this.readEvidenceManifest(binding);
    const entry = manifest.entries.find((candidate) => candidate.name === name);
    if (!entry) throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_NOT_AVAILABLE");
    const path = join(this.jobWorkspace(binding), "output", name);
    let before;
    try { before = await lstat(path); } catch {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    if (!before.isFile() || before.isSymbolicLink() || before.size !== entry.size_bytes
      || before.size > EVOLUTION_EVAL_EVIDENCE_LIMITS.entryBytes) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    const digest = createHash("sha256");
    let total = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      total += chunk.byteLength;
      if (total > EVOLUTION_EVAL_EVIDENCE_LIMITS.entryBytes || total > entry.size_bytes) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      digest.update(chunk);
    }
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size
      || total !== entry.size_bytes || digest.digest("hex") !== entry.sha256) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    return { binding, entry, path };
  }

  async acknowledgeEvidence(
    bindingInput: CoreIssuedEvalBinding,
    hashes: { readonly connectorManifestHash: string; readonly coreManifestHash: string; readonly coreAckFactHash: string },
  ): Promise<EvolutionEvalRetentionResultV1> {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    const observation = await this.options.ledger.markEvidenceAcknowledged(binding, hashes);
    if (!(observation.state === "acknowledged" || observation.state === "cleaned")) {
      throw new EvolutionEvalProtocolError(
        observation.state === "unavailable"
          ? "EVOLUTION_EVAL_LEDGER_UNAVAILABLE"
          : "EVOLUTION_EVAL_EVIDENCE_CORRUPT",
      );
    }
    if (observation.state === "cleaned") {
      return this.retentionResult(
        binding,
        "acknowledged",
        "ack",
        observation.sourceAuthorizationHash,
        observation.authorizationFactHash,
      );
    }
    await this.reconcileRetentionForBinding(binding);
    return this.retentionResult(binding, "acknowledged", "ack", observation.authorizationHash, observation.factHash);
  }

  async quarantineEvidence(
    bindingInput: CoreIssuedEvalBinding,
    hashes: { readonly errorFactHash: string; readonly coreQuarantineFactHash: string },
  ): Promise<EvolutionEvalRetentionResultV1> {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    const observation = await this.options.ledger.markEvidenceQuarantined(binding, hashes);
    if (!(observation.state === "quarantined" || observation.state === "cleaned")) {
      throw new EvolutionEvalProtocolError(
        observation.state === "unavailable"
          ? "EVOLUTION_EVAL_LEDGER_UNAVAILABLE"
          : "EVOLUTION_EVAL_EVIDENCE_CORRUPT",
      );
    }
    if (observation.state === "quarantined" && !await this.evidenceBytesPurged(binding)) {
      await this.moveEvidenceToQuarantine(binding);
      await this.reconcileRetentionForBinding(binding);
    }
    if (observation.state === "cleaned") {
      return this.retentionResult(
        binding,
        "quarantined",
        "quarantine",
        observation.sourceAuthorizationHash,
        observation.authorizationFactHash,
      );
    }
    return this.retentionResult(binding, "quarantined", "quarantine", observation.authorizationHash, observation.factHash);
  }

  async cleanupEvidence(
    bindingInput: CoreIssuedEvalBinding,
    authorizationFactHash: string,
    coreCleanupFactHash: string,
  ): Promise<EvolutionEvalRetentionResultV1> {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    const before = await this.options.ledger.getRetentionObservation(binding);
    if (before.state === "cleaned") {
      if (before.authorizationFactHash !== authorizationFactHash
        || before.authorizationHash !== coreCleanupFactHash) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      await this.deleteEvidenceBytes(binding);
      await this.releaseSpoolAdmission(binding, binding.dispatch.sealed_input_projection_hash);
      return this.retentionResult(binding, "cleaned", "cleanup", before.authorizationHash, before.factHash, {
        kind: before.sourceKind,
        hash: before.sourceAuthorizationHash,
        connectorFactHash: before.authorizationFactHash,
      });
    }
    if (!(before.state === "acknowledged" || before.state === "quarantined")
      || before.factHash !== authorizationFactHash) {
      throw new EvolutionEvalProtocolError(
        before.state === "unavailable" ? "EVOLUTION_EVAL_LEDGER_UNAVAILABLE" : "EVOLUTION_EVAL_EVIDENCE_CORRUPT",
      );
    }
    const cleaned = await this.options.ledger.markEvidenceCleaned(binding, authorizationFactHash, coreCleanupFactHash);
    if (cleaned.state !== "cleaned") {
      throw new EvolutionEvalProtocolError(
        cleaned.state === "unavailable" ? "EVOLUTION_EVAL_LEDGER_UNAVAILABLE" : "EVOLUTION_EVAL_EVIDENCE_CORRUPT",
      );
    }
    await this.deleteEvidenceBytes(binding);
    await this.releaseSpoolAdmission(binding, binding.dispatch.sealed_input_projection_hash);
    return this.retentionResult(binding, "cleaned", "cleanup", cleaned.authorizationHash, cleaned.factHash, {
      kind: cleaned.sourceKind,
      hash: cleaned.sourceAuthorizationHash,
      connectorFactHash: cleaned.authorizationFactHash,
    });
  }

  async discardEvidence(
    bindingInput: CoreIssuedEvalBinding,
    input: ({
      readonly reason: "unavailable_at_deadline";
    } | {
      readonly reason: "absolute_expiry";
      readonly coreManifestHash: string;
    }) & {
      readonly coreConclusionFactHash: string;
      readonly coreCleanupFactHash: string;
      readonly discardAuthorizationHash: string;
    },
  ): Promise<EvolutionEvalRetentionResultV1> {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    let observation = await this.options.ledger.markEvidenceDiscarded(binding, input);
    if (!(observation.state === "discarded" || observation.state === "cleaned")) {
      throw new EvolutionEvalProtocolError(
        observation.state === "unavailable" ? "EVOLUTION_EVAL_LEDGER_UNAVAILABLE" : "EVOLUTION_EVAL_EVIDENCE_CORRUPT",
      );
    }
    const execution = await this.options.ledger.query(binding);
    if (execution.state === "terminal" && observation.state === "discarded") {
      await this.deleteEvidenceBytes(binding);
      observation = await this.options.ledger.markEvidenceCleaned(
        binding,
        observation.factHash,
        observation.cleanupAuthorizationHash,
      );
      if (observation.state === "cleaned") {
        await this.releaseSpoolAdmission(binding, binding.dispatch.sealed_input_projection_hash);
      }
    }
    if (observation.state === "cleaned") {
      return this.retentionResult(binding, "cleaned", "cleanup", observation.authorizationHash, observation.factHash, {
        kind: observation.sourceKind,
        hash: observation.sourceAuthorizationHash,
        connectorFactHash: observation.authorizationFactHash,
      });
    }
    if (observation.state !== "discarded") {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_UNAVAILABLE");
    }
    return this.retentionResult(binding, "discarded", "discard", observation.authorizationHash, observation.factHash);
  }

  async submit(bindingInput: CoreIssuedEvalBinding, input: unknown): Promise<EvalLedgerQuery> {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    const sealedInput = validateEvolutionEvalSealedInput(input, binding);
    const existing = await this.options.ledger.query(binding);
    if (existing.state === "accepted" || existing.state === "terminal") {
      await this.assertMaterializedProjection(binding, sealedInput.projectionHash);
      if (existing.state === "terminal") await this.reconcileSpoolAdmissions();
      return existing;
    }
    if (existing.state === "transient_unavailable" || existing.state === "ledger_corrupt") return existing;
    if (existing.state !== "proven_never_accepted" || !existing.replay_permitted) return existing;
    if (binding.dispatch.toolchain_profile_hash !== this.options.toolchainProfileHash) {
      return { ...evalCommon(binding, this.options.ledger.ledgerEpoch), state: "proven_never_accepted", replay_permitted: false };
    }
    const timeoutMs = effectiveEvolutionEvalTimeoutMs(binding, this.clock());
    const predecessor = this.spoolTail;
    const gate = Promise.withResolvers<void>();
    this.spoolTail = gate.promise;
    await predecessor;
    let workspace: string;
    let accepted: Awaited<ReturnType<EvolutionEvalLedger["markAccepted"]>>;
    let admissionOwnerCreated: AdmissionOwnerProcess | undefined;
    let prepared: EvolutionEvalPreparedExecution | undefined;
    try {
      await this.reconcileSpoolAdmissions();
      admissionOwnerCreated = await this.reserveSpoolAdmission(binding, sealedInput.projectionHash);
      workspace = await this.materialize(binding, sealedInput);
      prepared = await this.options.execution.prepare?.({ workspace });
      await this.options.assertNewEffectReady?.();
      accepted = await this.options.ledger.markAccepted(binding, {
        executionState: "running",
        processIdentity: prepared?.identity,
      });
      if (!accepted.accepted_now && prepared) {
        await prepared.close();
        prepared = undefined;
      }
    } catch (error) {
      await prepared?.close().catch(() => undefined);
      if (admissionOwnerCreated) {
        await this.releaseSpoolAdmission(binding, sealedInput.projectionHash, admissionOwnerCreated);
      }
      throw error;
    } finally {
      gate.resolve();
    }
    if (accepted.accepted_now && accepted.effect_owner_token) {
      const controller = new AbortController();
      const processStarted = Promise.withResolvers<EvolutionEvalProcessIdentity | null>();
      const holder: {
        controller: AbortController;
        settled: Promise<void>;
        ownerToken: string;
        processStarted: Promise<EvolutionEvalProcessIdentity | null>;
        resolveProcessStarted: (identity: EvolutionEvalProcessIdentity | null) => void;
        identity?: EvolutionEvalProcessIdentity;
        stopAs?: "cancelled" | "timeout";
      } = {
        controller,
        settled: Promise.resolve(),
        ownerToken: accepted.effect_owner_token,
        processStarted: processStarted.promise,
        resolveProcessStarted: processStarted.resolve,
      };
      holder.settled = this.execute(binding, sealedInput, workspace, timeoutMs, accepted.effect_owner_token, holder, prepared);
      this.active.set(binding.dispatch.connector_job_id, holder);
      void holder.settled.finally(() => this.active.delete(binding.dispatch.connector_job_id));
    }
    return accepted.observation;
  }

  async cancel(bindingInput: CoreIssuedEvalBinding, reason: "tombstoned" | "deadline" | "shutdown"): Promise<EvalLedgerQuery> {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    const observation = await this.options.ledger.query(binding);
    if (observation.state !== "accepted") return observation;
    const active = this.active.get(binding.dispatch.connector_job_id);
    const stopAs = reason === "deadline" ? "timeout" : "cancelled";
    if (!await this.options.ledger.markStopRequested(binding, stopAs, active?.ownerToken)) {
      return {
        ...evalCommon(binding, this.options.ledger.ledgerEpoch),
        state: "ambiguous",
        effect_possible: true,
        error_code: "EVOLUTION_EVAL_STOP_UNCONFIRMED",
      };
    }
    if (active) { active.stopAs = stopAs; active.controller.abort(active.stopAs); }
    const identity = active?.identity
      ?? await this.options.ledger.getProcessIdentity(binding)
      ?? (active ? await Promise.race([
        active.processStarted,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), this.stopGraceMs)),
      ]) : null);
    if (!identity) return { ...evalCommon(binding, this.options.ledger.ledgerEpoch), state: "ambiguous", effect_possible: true, error_code: "EVOLUTION_EVAL_STOP_UNCONFIRMED" };
    const confirmed = await this.stopAndConfirm(identity);
    if (!confirmed) {
      return {
        ...evalCommon(binding, this.options.ledger.ledgerEpoch),
        state: "ambiguous",
        effect_possible: true,
        error_code: "EVOLUTION_EVAL_STOP_UNCONFIRMED",
      };
    }
    if (active) {
      await Promise.race([active.settled, new Promise<void>((resolve) => setTimeout(resolve, this.stopGraceMs))]);
      const current = await this.options.ledger.query(binding);
      if (current.state === "terminal") return current;
    }
    if (!await this.options.ledger.markProcessExitConfirmed(binding, identity, active?.ownerToken)) {
      return { ...evalCommon(binding, this.options.ledger.ledgerEpoch), state: "ambiguous", effect_possible: true, error_code: "EVOLUTION_EVAL_STOP_UNCONFIRMED" };
    }
    return this.options.ledger.markTerminalAfterConfirmedStop(
      binding,
      stopAs,
      stopAs === "timeout" ? "EVOLUTION_EVAL_DEADLINE_EXCEEDED" : "EVOLUTION_EVAL_CANCELLED",
    );
  }

  private jobWorkspace(binding: CoreIssuedEvalBinding): string {
    return join(this.root, "jobs", sha256(binding.dispatch.connector_job_id));
  }

  private evidenceManifestPath(binding: CoreIssuedEvalBinding): string {
    return join(this.jobWorkspace(binding), "evidence-manifest.json");
  }

  private async readEvidenceManifest(
    binding: CoreIssuedEvalBinding,
  ): Promise<EvolutionEvalConnectorEvidenceManifestV1> {
    try {
      const path = this.evidenceManifestPath(binding);
      const details = await lstat(path);
      if (!details.isFile() || details.isSymbolicLink() || details.size < 2 || details.size > 1024 * 1024) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      return assertConnectorEvidenceManifest(JSON.parse(await readFile(path, "utf8")), binding);
    } catch (error) {
      if (error instanceof EvolutionEvalProtocolError) throw error;
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
  }

  private async persistEvidenceManifest(
    binding: CoreIssuedEvalBinding,
    manifest: EvolutionEvalConnectorEvidenceManifestV1,
  ): Promise<void> {
    const target = this.evidenceManifestPath(binding);
    try {
      const prior = await this.readEvidenceManifest(binding);
      if (canonicalEvolutionEvalHash(prior) !== canonicalEvolutionEvalHash(manifest)) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      return;
    } catch (error) {
      if (error instanceof EvolutionEvalProtocolError && error.code !== "EVOLUTION_EVAL_EVIDENCE_CORRUPT") throw error;
      try { await lstat(target); throw error; } catch (statError) {
        if (!(statError instanceof Error && "code" in statError
          && (statError as NodeJS.ErrnoException).code === "ENOENT")) throw error;
      }
    }
    const temporary = join(dirname(target), `.evidence-manifest-${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    await syncFile(temporary);
    try {
      if (process.platform === "win32") {
        const outcome = windowsMoveWriteThrough(temporary, target);
        if (outcome === "exists") {
          const prior = await this.readEvidenceManifest(binding);
          if (canonicalEvolutionEvalHash(prior) !== canonicalEvolutionEvalHash(manifest)) {
            throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
          }
        }
      } else {
        try { await link(temporary, target); } catch (error) {
          if (!(error instanceof Error && "code" in error
            && (error as NodeJS.ErrnoException).code === "EEXIST")) throw error;
          const prior = await this.readEvidenceManifest(binding);
          if (canonicalEvolutionEvalHash(prior) !== canonicalEvolutionEvalHash(manifest)) {
            throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
          }
        }
      }
      await syncDirectory(dirname(target));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async validateAndPersistEvidence(
    binding: CoreIssuedEvalBinding,
    workspace: string,
    evidence: EvidenceManifest,
  ): Promise<EvolutionEvalConnectorEvidenceManifestV1> {
    if (evidence.jobId !== binding.dispatch.connector_job_id
      || !Array.isArray(evidence.entries)
      || evidence.entries.length > EVOLUTION_EVAL_EVIDENCE_LIMITS.entries) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_LIMIT_EXCEEDED");
    }
    const outputDirectory = join(workspace, "output");
    let outputDetails;
    try { outputDetails = await lstat(outputDirectory); } catch {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    if (!outputDetails.isDirectory() || outputDetails.isSymbolicLink()) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    const directoryNames = (await readdir(outputDirectory)).sort();
    const reportedNames = evidence.entries.map((entry) => entry.name).sort();
    if (JSON.stringify(directoryNames) !== JSON.stringify(reportedNames)) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    const entries: EvolutionEvalConnectorEvidenceEntryV1[] = [];
    const names = new Set<string>();
    let totalBytes = 0;
    for (const reported of [...evidence.entries].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (typeof reported.name !== "string" || !evidenceNameRe.test(reported.name) || names.has(reported.name)
        || reported.uri !== `workspace://${binding.dispatch.connector_job_id}/output/${reported.name}`
        || !/^[0-9a-f]{64}$/.test(String(reported.sha256))
        || !Number.isSafeInteger(reported.sizeBytes) || reported.sizeBytes < 0
        || reported.sizeBytes > EVOLUTION_EVAL_EVIDENCE_LIMITS.entryBytes
        || !(["application/json", "text/plain", "application/octet-stream"] as const).includes(reported.mediaType as never)
        || (evolutionEvidenceMediaType(reported.name) !== null
          && evolutionEvidenceMediaType(reported.name) !== reported.mediaType)) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      names.add(reported.name);
      const path = join(outputDirectory, reported.name);
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size !== reported.sizeBytes) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      const bytes = await readFile(path);
      const after = await lstat(path);
      if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size
        || bytes.byteLength !== reported.sizeBytes || sha256(bytes) !== reported.sha256) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      totalBytes += bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > EVOLUTION_EVAL_EVIDENCE_LIMITS.totalBytes) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_LIMIT_EXCEEDED");
      }
      entries.push({
        name: reported.name,
        sha256: reported.sha256,
        size_bytes: reported.sizeBytes,
        media_type: reported.mediaType as EvolutionEvalConnectorEvidenceEntryV1["media_type"],
        artifact_classification: evidenceArtifactClassification(reported.name),
        usage_classification: "evolution_eval_only",
      });
    }
    const canonical = {
      schema: "evolution-eval-connector-evidence-manifest.v1" as const,
      eval_job_id: binding.dispatch.eval_job_id,
      connector_job_id: binding.dispatch.connector_job_id,
      dispatch_request_hash: binding.dispatch_request_hash,
      entries,
    };
    const manifest: EvolutionEvalConnectorEvidenceManifestV1 = {
      ...canonical,
      manifest_hash: canonicalEvolutionEvalHash(canonical),
    };
    assertConnectorEvidenceManifest(manifest, binding);
    await this.persistEvidenceManifest(binding, manifest);
    return manifest;
  }

  private async assertEvidenceReadable(binding: CoreIssuedEvalBinding): Promise<void> {
    if (await this.evidenceBytesPurged(binding)) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_NOT_AVAILABLE");
    }
    const terminal = await this.options.ledger.query(binding);
    if (terminal.state !== "terminal") {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_NOT_AVAILABLE");
    }
    const retention = await this.options.ledger.getRetentionObservation(binding);
    if (!(retention.state === "pending_ack" || retention.state === "acknowledged")) {
      throw new EvolutionEvalProtocolError(
        retention.state === "unavailable"
          ? "EVOLUTION_EVAL_LEDGER_UNAVAILABLE"
          : retention.state === "corrupt" || retention.state === "quarantined"
            ? "EVOLUTION_EVAL_EVIDENCE_CORRUPT"
            : "EVOLUTION_EVAL_EVIDENCE_NOT_AVAILABLE",
      );
    }
  }

  private async retentionResult(
    binding: CoreIssuedEvalBinding,
    state: "acknowledged" | "quarantined" | "discarded" | "cleaned" | "expired",
    authorizationKind: "ack" | "quarantine" | "expiry" | "discard" | "cleanup",
    authorizationHash: string,
    connectorFactHash: string,
    source?: { readonly kind: "ack" | "quarantine" | "expiry" | "discard"; readonly hash: string; readonly connectorFactHash: string },
  ): Promise<EvolutionEvalRetentionResultV1> {
    return {
      schema: "evolution-eval-retention-result.v1",
      binding,
      state,
      retryable: false,
      authorization_kind: authorizationKind,
      authorization_hash: authorizationHash,
      connector_fact_hash: connectorFactHash,
      source_authorization_kind: source?.kind ?? null,
      source_authorization_hash: source?.hash ?? null,
      source_connector_fact_hash: source?.connectorFactHash ?? null,
      error_code: null,
      physical_deleted: await this.evidenceBytesPurged(binding),
    };
  }

  private async moveEvidenceToQuarantine(binding: CoreIssuedEvalBinding): Promise<void> {
    const workspace = this.jobWorkspace(binding);
    const source = join(workspace, "output");
    const target = join(workspace, "quarantine-output");
    try {
      const targetDetails = await lstat(target);
      if (!targetDetails.isDirectory() || targetDetails.isSymbolicLink()) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      try { await lstat(source); throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT"); }
      catch (error) {
        if (error instanceof EvolutionEvalProtocolError) throw error;
        if (error instanceof Error && "code" in error
          && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    } catch (error) {
      if (error instanceof EvolutionEvalProtocolError) throw error;
      if (!(error instanceof Error && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }
    if (process.platform === "win32") {
      const outcome = windowsMoveWriteThrough(source, target);
      if (outcome === "exists") throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    } else {
      await rename(source, target);
    }
    await syncDirectory(workspace);
  }

  private async deleteEvidenceBytes(binding: CoreIssuedEvalBinding): Promise<void> {
    const workspace = this.jobWorkspace(binding);
    await rm(join(workspace, "output"), { recursive: true, force: true });
    await rm(join(workspace, "quarantine-output"), { recursive: true, force: true });
    const tombstone = join(workspace, "evidence-purged.json");
    try {
      await writeFile(tombstone, JSON.stringify({
        schema: "evolution-eval-evidence-purged.v1",
        connector_job_id: binding.dispatch.connector_job_id,
        dispatch_request_hash: binding.dispatch_request_hash,
      }), { flag: "wx", mode: 0o600 });
      await syncFile(tombstone);
    } catch (error) {
      if (!(error instanceof Error && "code" in error
        && (error as NodeJS.ErrnoException).code === "EEXIST")) throw error;
    }
    await syncDirectory(workspace);
  }

  private async evidenceBytesPurged(binding: CoreIssuedEvalBinding): Promise<boolean> {
    try {
      const value = JSON.parse(await readFile(join(this.jobWorkspace(binding), "evidence-purged.json"), "utf8")) as Record<string, unknown>;
      if (Reflect.ownKeys(value).length !== 3
        || value.schema !== "evolution-eval-evidence-purged.v1"
        || value.connector_job_id !== binding.dispatch.connector_job_id
        || value.dispatch_request_hash !== binding.dispatch_request_hash) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async reconcileRetentionForBinding(binding: CoreIssuedEvalBinding): Promise<void> {
    const terminal = await this.options.ledger.query(binding);
    if (terminal.state !== "terminal") return;
    let retention = await this.options.ledger.getRetentionObservation(binding);
    const absoluteDeleteAt = Date.parse(terminal.terminal_at) + EVOLUTION_EVAL_EVIDENCE_LIMITS.absoluteRetentionMs;
    if (retention.state === "pending_ack" && this.clock().getTime() >= absoluteDeleteAt) {
      retention = await this.options.ledger.markEvidenceExpired(binding);
    }
    if (retention.state === "acknowledged" && this.clock().getTime() >= absoluteDeleteAt) {
      await this.deleteEvidenceBytes(binding);
      await this.releaseSpoolAdmission(binding, binding.dispatch.sealed_input_projection_hash);
    } else if (retention.state === "expired"
      || (retention.state === "quarantined"
        && this.clock().getTime() >= Math.min(Date.parse(retention.deleteBy), absoluteDeleteAt))) {
      await this.deleteEvidenceBytes(binding);
      await this.releaseSpoolAdmission(binding, binding.dispatch.sealed_input_projection_hash);
    }
    if (retention.state === "discarded") {
      await this.deleteEvidenceBytes(binding);
      retention = await this.options.ledger.markEvidenceCleaned(
        binding,
        retention.factHash,
        retention.cleanupAuthorizationHash,
      );
    }
    if (retention.state === "cleaned") {
      await this.deleteEvidenceBytes(binding);
      await this.releaseSpoolAdmission(binding, binding.dispatch.sealed_input_projection_hash);
    }
    await this.scheduleRetentionForBinding(binding, terminal.terminal_at, retention);
  }

  private async scheduleRetentionForBinding(
    binding: CoreIssuedEvalBinding,
    terminalAt: string,
    retention: Awaited<ReturnType<EvolutionEvalLedger["getRetentionObservation"]>>,
  ): Promise<void> {
    const key = binding.dispatch.connector_job_id;
    const prior = this.retentionTimers.get(key);
    if (prior) clearTimeout(prior);
    this.retentionTimers.delete(key);
    if (await this.evidenceBytesPurged(binding)) return;
    const absoluteDeleteAt = Date.parse(terminalAt) + EVOLUTION_EVAL_EVIDENCE_LIMITS.absoluteRetentionMs;
    const deleteAt = retention.state === "quarantined"
      ? Math.min(Date.parse(retention.deleteBy), absoluteDeleteAt)
      : retention.state === "pending_ack" || retention.state === "acknowledged" || retention.state === "expired"
        ? absoluteDeleteAt
        : null;
    if (deleteAt === null) return;
    const delay = Math.max(0, Math.min(deleteAt - this.clock().getTime(), 2_147_483_647));
    const timer = setTimeout(() => {
      this.retentionTimers.delete(key);
      void this.reconcileRetentionForBinding(binding).catch(() => undefined);
    }, delay);
    timer.unref();
    this.retentionTimers.set(key, timer);
  }

  private async execute(
    binding: CoreIssuedEvalBinding,
    sealedInput: ValidatedEvolutionEvalSealedInput,
    workspace: string,
    timeoutMs: number,
    ownerToken: string,
    holder: {
      readonly controller: AbortController;
      readonly processStarted: Promise<EvolutionEvalProcessIdentity | null>;
      readonly resolveProcessStarted: (identity: EvolutionEvalProcessIdentity | null) => void;
      identity?: EvolutionEvalProcessIdentity;
      stopAs?: "cancelled" | "timeout";
    },
    prepared?: EvolutionEvalPreparedExecution,
  ): Promise<void> {
    const deadlineAt = Date.parse(binding.dispatch.deadline_at);
    const requestTimeout = Math.max(0, Math.min(timeoutMs, deadlineAt - this.clock().getTime()));
    const deadlineTimer = setTimeout(() => {
      void this.options.ledger.markStopRequested(binding, "timeout", ownerToken).then((durable) => {
        if (!durable) return;
        holder.stopAs = "timeout";
        holder.controller.abort("timeout");
      });
    }, requestTimeout);
    try {
      let result: EvolutionEvalExecutionResult;
      try {
        const onBeforeLaunch = async () => {
          try { await this.options.assertNewEffectReady?.(); }
          catch {
            holder.controller.abort("toolchain_readiness_drift");
            return false;
          }
          const expired = this.clock().getTime() >= deadlineAt;
          if (expired && await this.options.ledger.markStopRequested(binding, "timeout", ownerToken)) {
            holder.stopAs = "timeout";
            holder.controller.abort("timeout");
          }
          const stopObservation = await this.options.ledger.getStopObservation(binding);
          if (stopObservation.state === "stop_requested") {
            holder.stopAs = stopObservation.reason;
            holder.controller.abort(stopObservation.reason);
          } else if (stopObservation.state !== "absent") {
            holder.controller.abort("launch_gate_unavailable");
          }
          return !holder.controller.signal.aborted && !expired && stopObservation.state === "absent";
        };
        if (prepared) {
          const launchPermitted = await this.options.ledger.markProcessStarted(binding, prepared.identity, ownerToken);
          const recorded = launchPermitted ? prepared.identity : await this.options.ledger.getProcessIdentity(binding);
          if (!recorded || recorded.pid !== prepared.identity.pid
            || recorded.processGroupId !== prepared.identity.processGroupId
            || recorded.startToken !== prepared.identity.startToken) {
            holder.resolveProcessStarted(null);
            await prepared.close();
            throw new Error("EVOLUTION_EVAL_PROCESS_IDENTITY_UNAVAILABLE");
          }
          holder.identity = recorded;
          holder.resolveProcessStarted(recorded);
        }
        result = prepared ? await prepared.execute({
          binding,
          sealedInput,
          workspace,
          timeoutMs,
          signal: holder.controller.signal,
          onBeforeLaunch,
        }) : await this.options.execution.execute({
          binding,
          sealedInput,
          workspace,
          timeoutMs,
          signal: holder.controller.signal,
          onProcessStarted: async (identity) => {
            const launchPermitted = await this.options.ledger.markProcessStarted(binding, identity, ownerToken);
            const recorded = launchPermitted ? identity : await this.options.ledger.getProcessIdentity(binding);
            if (!recorded || recorded.pid !== identity.pid || recorded.processGroupId !== identity.processGroupId
              || recorded.startToken !== identity.startToken) {
              holder.resolveProcessStarted(null);
              return false;
            }
            holder.identity = recorded;
            holder.resolveProcessStarted(recorded);
            const expired = this.clock().getTime() >= deadlineAt;
            if (expired && await this.options.ledger.markStopRequested(binding, "timeout", ownerToken)) {
              holder.stopAs = "timeout";
              holder.controller.abort("timeout");
            }
            const stopObservation = await this.options.ledger.getStopObservation(binding);
            if (stopObservation.state === "stop_requested") {
              holder.stopAs = stopObservation.reason;
              holder.controller.abort(stopObservation.reason);
            } else if (stopObservation.state !== "absent") {
              holder.controller.abort("launch_gate_unavailable");
            }
            return launchPermitted && !holder.controller.signal.aborted && !expired
              && stopObservation.state === "absent";
          },
          onBeforeLaunch,
        });
      } catch {
        result = { terminalState: "failed", errorCode: "EVOLUTION_EVAL_EXECUTION_FAILED" };
      }
      holder.resolveProcessStarted(holder.identity ?? null);
      if (result.terminalState === "timeout"
        && await this.options.ledger.markStopRequested(binding, "timeout", ownerToken)) {
        holder.stopAs = "timeout";
        holder.controller.abort("timeout");
      }
      const terminalState = holder.stopAs ?? result.terminalState;
      const errorCode = holder.stopAs === "timeout"
        ? "EVOLUTION_EVAL_DEADLINE_EXCEEDED"
        : holder.stopAs === "cancelled"
          ? "EVOLUTION_EVAL_CANCELLED"
          : result.errorCode ?? null;
      if (!holder.identity) return;
      let verifiedTerminalState = terminalState;
      let verifiedErrorCode = errorCode;
      if (!this.processTreeStopped(holder.identity)) {
        const stopped = await this.stopAndConfirm(holder.identity);
        if (!stopped) return;
        if (!holder.stopAs) {
          verifiedTerminalState = "failed";
          verifiedErrorCode = "EVOLUTION_EVAL_ORPHAN_PROCESS";
        }
      }
      if (!await this.options.ledger.markProcessExitConfirmed(binding, holder.identity, ownerToken)) return;
      let retainedOutput = false;
      let retentionFence = await this.options.ledger.getRetentionObservation(binding);
      if (result.evidence && retentionFence.state !== "discarded" && retentionFence.state !== "cleaned") {
        try {
          const manifest = await this.validateAndPersistEvidence(binding, workspace, result.evidence);
          const totalBytes = manifest.entries.reduce((total, entry) => total + entry.size_bytes, 0);
          retainedOutput = await this.options.ledger.markOutput(binding, {
            spoolManifestHash: manifest.manifest_hash,
            entryCount: manifest.entries.length,
            totalBytes,
          }, ownerToken);
          if (!retainedOutput) {
            const afterOutputRace = await this.options.ledger.getRetentionObservation(binding);
            if (!(afterOutputRace.state === "discarded" || afterOutputRace.state === "cleaned")) return;
            retentionFence = afterOutputRace;
            await this.deleteEvidenceBytes(binding);
          }
        } catch {
          verifiedTerminalState = "failed";
          verifiedErrorCode = "EVOLUTION_EVAL_EVIDENCE_CORRUPT";
          await rm(join(workspace, "output"), { recursive: true, force: true });
        }
      }
      const terminal = await this.options.ledger.markTerminal(
        binding,
        { terminalState: verifiedTerminalState, errorCode: verifiedErrorCode },
        ownerToken,
      );
      if (terminal.state === "terminal" && retentionFence.state === "discarded") {
        await this.deleteEvidenceBytes(binding);
        const cleaned = await this.options.ledger.markEvidenceCleaned(
          binding,
          retentionFence.factHash,
          retentionFence.cleanupAuthorizationHash,
        );
        if (cleaned.state === "cleaned") {
          await this.releaseSpoolAdmission(binding, sealedInput.projectionHash);
        }
        return;
      }
      if (terminal.state === "terminal" && !retainedOutput) {
        await this.releaseSpoolAdmission(binding, sealedInput.projectionHash);
      } else if (terminal.state === "terminal") {
        await this.reconcileRetentionForBinding(binding);
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  private processTreeStopped(identity: EvolutionEvalProcessIdentity): boolean {
    if (this.options.processSupervisor) return this.options.processSupervisor.isTreeStopped(identity);
    try {
      process.kill(process.platform === "win32" ? identity.pid : -identity.processGroupId, 0);
      return false;
    } catch (error) {
      return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  private async ownsProcessIdentity(identity: EvolutionEvalProcessIdentity): Promise<boolean> {
    if (this.options.processSupervisor) return this.options.processSupervisor.ownsIdentity(identity);
    if (this.processTreeStopped(identity)) return true;
    return await readProcessStartToken(identity.pid) === identity.startToken;
  }

  private async stopAndConfirm(identity: EvolutionEvalProcessIdentity): Promise<boolean> {
    if (this.options.processSupervisor) {
      if (!await this.options.processSupervisor.ownsIdentity(identity)) return false;
      return this.options.processSupervisor.stopAndConfirm(identity, this.stopGraceMs);
    }
    if (!await this.ownsProcessIdentity(identity)) return false;
    if (!this.processTreeStopped(identity)) {
      if (process.platform === "win32") {
        const killed = spawnSync("taskkill", ["/PID", String(identity.pid), "/T", "/F"], { stdio: "ignore" });
        if (killed.status !== 0 && !this.processTreeStopped(identity)) return false;
      } else {
        try { process.kill(-identity.processGroupId, "SIGTERM"); } catch {}
      }
    }
    const deadline = Date.now() + this.stopGraceMs;
    while (Date.now() < deadline) {
      if (this.processTreeStopped(identity)) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (process.platform !== "win32") {
      try { process.kill(-identity.processGroupId, "SIGKILL"); } catch {}
      const forceDeadline = Date.now() + Math.min(this.stopGraceMs, 1_000);
      while (Date.now() < forceDeadline) {
        if (this.processTreeStopped(identity)) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return this.processTreeStopped(identity);
  }

  private async materialize(binding: CoreIssuedEvalBinding, input: ValidatedEvolutionEvalSealedInput): Promise<string> {
    const jobs = join(this.root, "jobs");
    const key = sha256(binding.dispatch.connector_job_id);
    const target = join(jobs, key);
    const temporary = join(jobs, `${key}.staging-${crypto.randomUUID()}`);
    await mkdir(jobs, { recursive: true, mode: 0o700 });
    try {
      const prior = JSON.parse(await readFile(join(target, "binding.json"), "utf8")) as {
        dispatch_request_hash?: unknown;
        sealed_input_projection_hash?: unknown;
      };
      if (prior.dispatch_request_hash !== binding.dispatch_request_hash
        || prior.sealed_input_projection_hash !== input.projectionHash) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_BINDING_CONFLICT");
      }
      return target;
    } catch (error) {
      if (error instanceof EvolutionEvalProtocolError) throw error;
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(join(temporary, "input"), { recursive: true, mode: 0o700 });
    try {
      for (let index = 0; index < input.files.length; index += 1) {
        const file = input.files[index]!;
        const manifestFile = input.manifest.files.find((candidate) => candidate.path === file.path)!;
        const path = join(temporary, "input", file.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(file.content);
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (manifestFile.read_only) await chmod(path, 0o400);
      }
      const bindingPath = join(temporary, "binding.json");
      await writeFile(bindingPath, JSON.stringify({
        dispatch_request_hash: binding.dispatch_request_hash,
        workspace_manifest_hash: binding.dispatch.workspace_manifest_hash,
        sealed_input_projection_hash: input.projectionHash,
      }), { flag: "wx", mode: 0o600 });
      await syncFile(bindingPath);
      await syncDirectory(temporary);
      if (process.platform === "win32") {
        const outcome = windowsMoveWriteThrough(temporary, target);
        if (outcome === "exists") {
          await rm(temporary, { recursive: true, force: true });
          return this.assertMaterializedProjection(binding, input.projectionHash).then(() => target);
        }
      } else {
        await rename(temporary, target);
      }
      await syncDirectory(jobs);
      return target;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  private async spoolBytes(): Promise<number> {
    const admissions = await this.readSpoolAdmissions();
    return admissions.length * EVOLUTION_EVAL_ADMISSION_BYTES;
  }

  private async readSpoolAdmissions(): Promise<readonly {
    readonly slot: number;
    readonly connector_job_id: string;
    readonly dispatch_request_hash: string;
    readonly sealed_input_projection_hash: string;
    readonly owner_process: AdmissionOwnerProcess;
    readonly binding: CoreIssuedEvalBinding;
  }[]> {
    const directory = join(this.root, "admissions");
    try {
      const details = await lstat(directory);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_CORRUPT");
      }
    } catch (error) {
      if (error instanceof Error && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const admissions: {
      slot: number;
      connector_job_id: string;
      dispatch_request_hash: string;
      sealed_input_projection_hash: string;
      owner_process: AdmissionOwnerProcess;
      binding: CoreIssuedEvalBinding;
    }[] = [];
    const seenJobs = new Set<string>();
    for (let slot = 0; slot < EVOLUTION_EVAL_ADMISSION_SLOTS; slot += 1) {
      try {
        const value = JSON.parse(await readFile(join(directory, `slot-${slot}.json`), "utf8")) as Record<string, unknown>;
        const ownerProcess = value.owner_process as Partial<AdmissionOwnerProcess> | undefined;
        if (Reflect.ownKeys(value).length !== 7
          || value.schema !== "evolution-eval-spool-admission.v2"
          || typeof value.connector_job_id !== "string" || !idRe.test(value.connector_job_id)
          || typeof value.dispatch_request_hash !== "string" || !/^[0-9a-f]{64}$/.test(value.dispatch_request_hash)
          || typeof value.sealed_input_projection_hash !== "string" || !/^[0-9a-f]{64}$/.test(value.sealed_input_projection_hash)
          || !ownerProcess || Reflect.ownKeys(ownerProcess).length !== 2
          || !Number.isSafeInteger(ownerProcess.pid) || Number(ownerProcess.pid) < 1
          || typeof ownerProcess.start_token !== "string" || !/^[0-9a-f]{64}$/.test(ownerProcess.start_token)
          || value.reserved_bytes !== EVOLUTION_EVAL_ADMISSION_BYTES) {
          throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_CORRUPT");
        }
        if (seenJobs.has(value.connector_job_id)) {
          throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_CORRUPT");
        }
        seenJobs.add(value.connector_job_id);
        const admissionBinding = validateCoreIssuedEvalBinding(value.binding);
        if (admissionBinding.dispatch.connector_job_id !== value.connector_job_id
          || admissionBinding.dispatch_request_hash !== value.dispatch_request_hash
          || admissionBinding.dispatch.sealed_input_projection_hash !== value.sealed_input_projection_hash) {
          throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_CORRUPT");
        }
        admissions.push({
          slot,
          connector_job_id: value.connector_job_id,
          dispatch_request_hash: value.dispatch_request_hash,
          sealed_input_projection_hash: value.sealed_input_projection_hash,
          owner_process: { pid: Number(ownerProcess.pid), start_token: ownerProcess.start_token },
          binding: admissionBinding,
        });
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (error instanceof EvolutionEvalProtocolError) throw error;
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_CORRUPT");
      }
    }
    return admissions;
  }

  private async resolveExistingAdmission(
    prior: {
      readonly dispatch_request_hash: string;
      readonly sealed_input_projection_hash: string;
      readonly owner_process: AdmissionOwnerProcess;
    },
    binding: CoreIssuedEvalBinding,
    projectionHash: string,
    ownerProcess: AdmissionOwnerProcess,
  ): Promise<"owned" | "reclaimed"> {
    if (prior.dispatch_request_hash !== binding.dispatch_request_hash
      || prior.sealed_input_projection_hash !== projectionHash) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_BINDING_CONFLICT");
    }
    if (prior.owner_process.pid === ownerProcess.pid
      && prior.owner_process.start_token === ownerProcess.start_token) return "owned";
    const ownerState = await admissionOwnerState(prior.owner_process);
    if (ownerState !== "gone") {
      // A process may only proceed to acceptance while it owns the durable
      // pre-accept admission. Unknown identity is retained fail-closed.
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    }
    const ledgerState = await this.options.ledger.query(binding);
    if (ledgerState.state !== "proven_never_accepted" || !ledgerState.replay_permitted) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    }
    await this.releaseSpoolAdmission(binding, projectionHash, prior.owner_process);
    return "reclaimed";
  }

  private async reserveSpoolAdmission(
    binding: CoreIssuedEvalBinding,
    projectionHash: string,
  ): Promise<AdmissionOwnerProcess | undefined> {
    const directory = join(this.root, "admissions");
    const temporaryDirectory = join(directory, "tmp");
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    const ownerProcess = await currentAdmissionOwner();
    const existing = await this.readSpoolAdmissions();
    const prior = existing.find((item) => item.connector_job_id === binding.dispatch.connector_job_id);
    if (prior) {
      if (await this.resolveExistingAdmission(prior, binding, projectionHash, ownerProcess) === "owned") {
        return undefined;
      }
    }
    const payload = JSON.stringify({
      schema: "evolution-eval-spool-admission.v2",
      connector_job_id: binding.dispatch.connector_job_id,
      dispatch_request_hash: binding.dispatch_request_hash,
      sealed_input_projection_hash: projectionHash,
      reserved_bytes: EVOLUTION_EVAL_ADMISSION_BYTES,
      owner_process: ownerProcess,
      binding,
    });
    const temporary = join(temporaryDirectory, `${sha256(binding.dispatch.connector_job_id)}-${crypto.randomUUID()}.json`);
    await writeFile(temporary, payload, { flag: "wx", mode: 0o600 });
    await syncFile(temporary);
    const start = Number.parseInt(sha256(binding.dispatch.connector_job_id).slice(0, 8), 16)
      % EVOLUTION_EVAL_ADMISSION_SLOTS;
    try {
      for (let offset = 0; offset < EVOLUTION_EVAL_ADMISSION_SLOTS; offset += 1) {
        const slot = (start + offset) % EVOLUTION_EVAL_ADMISSION_SLOTS;
        try {
          const slotPath = join(directory, `slot-${slot}.json`);
          if (process.platform === "win32") {
            if (windowsMoveWriteThrough(temporary, slotPath) === "exists") {
              const conflict = new Error("slot exists") as NodeJS.ErrnoException;
              conflict.code = "EEXIST";
              throw conflict;
            }
          } else {
            await link(temporary, slotPath);
          }
          if (process.platform !== "win32") {
            try {
              await syncDirectory(directory);
            } catch (error) {
              // Do not strand a pre-accept admission when the commit fence
              // fails in this process. Cross-crash recovery remains
              // fail-closed, but an observed fence failure is cleaned up.
              try {
                await unlink(slotPath);
                await syncDirectory(directory);
              } catch {}
              throw error;
            }
          }
          return ownerProcess;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) throw error;
          const raced = (await this.readSpoolAdmissions()).find(
            (item) => item.connector_job_id === binding.dispatch.connector_job_id,
          );
          if (raced) {
            if (await this.resolveExistingAdmission(raced, binding, projectionHash, ownerProcess) === "owned") {
              return undefined;
            }
            // The dead owner was reclaimed. Retry the same durable temporary
            // against the now-free slot and become its recorded owner.
            offset -= 1;
          }
        }
      }
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_SPOOL_FULL");
    } finally {
      try { await unlink(temporary); } catch {}
    }
  }

  private async releaseSpoolAdmission(
    binding: CoreIssuedEvalBinding,
    projectionHash: string,
    expectedOwner?: AdmissionOwnerProcess,
  ): Promise<void> {
    const directory = join(this.root, "admissions");
    const prior = (await this.readSpoolAdmissions()).find(
      (item) => item.connector_job_id === binding.dispatch.connector_job_id,
    );
    if (!prior) return;
    if (prior.dispatch_request_hash !== binding.dispatch_request_hash
      || prior.sealed_input_projection_hash !== projectionHash) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_BINDING_CONFLICT");
    }
    if (expectedOwner && (prior.owner_process.pid !== expectedOwner.pid
      || prior.owner_process.start_token !== expectedOwner.start_token)) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    }
    const slotPath = join(directory, `slot-${prior.slot}.json`);
    if (process.platform === "win32") {
      const temporaryDirectory = join(directory, "tmp");
      await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      await syncDirectory(temporaryDirectory);
      const tombstone = join(temporaryDirectory, `released-${crypto.randomUUID()}.json`);
      if (windowsMoveWriteThrough(slotPath, tombstone) !== "created") {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_UNAVAILABLE");
      }
      await unlink(tombstone);
    } else {
      try { await unlink(slotPath); } catch (error) {
        if (!(error instanceof Error && "code" in error
          && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
      }
    }
    await syncDirectory(directory);
  }

  private async reconcileSpoolAdmissions(): Promise<void> {
    for (const admission of await this.readSpoolAdmissions()) {
      const observation = await this.options.ledger.query(admission.binding);
      if (observation.state === "terminal") {
        const retention = await this.options.ledger.getRetentionObservation(admission.binding);
        if (retention.state === "absent") {
          await this.releaseSpoolAdmission(admission.binding, admission.sealed_input_projection_hash);
        } else {
          await this.reconcileRetentionForBinding(admission.binding);
        }
        continue;
      }
      if (observation.state === "proven_never_accepted" && observation.replay_permitted
        && await admissionOwnerState(admission.owner_process) === "gone") {
        await this.releaseSpoolAdmission(admission.binding, admission.sealed_input_projection_hash);
      }
    }
  }

  private async assertMaterializedProjection(binding: CoreIssuedEvalBinding, projectionHash: string): Promise<void> {
    const key = sha256(binding.dispatch.connector_job_id);
    try {
      const stored = JSON.parse(await readFile(join(this.root, "jobs", key, "binding.json"), "utf8")) as {
        dispatch_request_hash?: unknown;
        sealed_input_projection_hash?: unknown;
      };
      if (stored.dispatch_request_hash !== binding.dispatch_request_hash
        || stored.sealed_input_projection_hash !== projectionHash) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_BINDING_CONFLICT");
      }
    } catch (error) {
      if (error instanceof EvolutionEvalProtocolError) throw error;
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_BINDING_CONFLICT");
    }
  }
}

export class WorkerRuntime {
  private readonly endpoint: ConnectorEndpoint; private readonly root: string; private readonly execution: WorkerExecution; private readonly clock: () => Date;
  private registration?: ConnectorRegistration; private discovery?: DiscoverySnapshot; private active = 0; private leaseExpiresAt?: number;
  private readonly jobs = new Map<string, Job>(); private readonly jobBindings = new Map<string, { projectId: string; classification: DataClassification }>(); private readonly keys = new Map<string, { fingerprint: string; status: number; body: RemoteEnvelope<unknown> }>(); private readonly pending: string[] = []; private readonly evolutionEval?: EvolutionEvalWorker;
  /** H8: registry snapshot reload — resolves once the on-disk job registry
   *  (if any) has been merged; every request awaits it so post-restart
   *  queries cannot race the restore. */
  private readonly restorePromise: Promise<void>;
  constructor(o: WorkerRuntimeOptions) { this.endpoint = copy(o.endpoint); this.root = o.workspaceRoot; this.execution = o.execution ?? unavailableExecution; this.clock = o.now ?? (() => new Date()); this.evolutionEval = o.evolutionEval ? new EvolutionEvalWorker(o.evolutionEval) : undefined; if (!idRe.test(this.endpoint.connector_id) || this.endpoint.protocol_version !== REMOTE_SCHEMA_VERSION || this.endpoint.max_concurrency < 1) throw new Error("CONFIG_INVALID"); this.restorePromise = this.restoreRegistry(); }
  private registryPath(): string { return join(this.root, "jobs-registry.json"); }
  /** Persist the in-memory job registry so a worker restart does not orphan
   *  every historical job's evidence API (files stay on disk; the manifest
   *  only lived in memory). Non-terminal jobs at snapshot time are reloaded
   *  as "lost" — the process died mid-run, so their state is unknowable.
   *  Idempotency keys are deliberately NOT persisted: replay-after-restart
   *  is a stronger contract than the snapshot's recency. */
  /** Serialized last-writer-wins: concurrent snapshots (submit + terminal)
   *  must not let an older state overwrite a newer one on disk. */
  private snapshotChain: Promise<void> = Promise.resolve();
  private snapshotRegistry(): Promise<void> {
    this.snapshotChain = this.snapshotChain.then(() => this.writeSnapshot());
    return this.snapshotChain;
  }
  private async writeSnapshot(): Promise<void> {
    try {
      const snapshot = { schema: "synthia-worker-jobs-registry.v1", jobs: [...this.jobs.values()], bindings: [...this.jobBindings.entries()] };
      await mkdir(this.root, { recursive: true });
      await writeFile(this.registryPath(), JSON.stringify(snapshot), "utf8");
    } catch { /* best-effort persistence */ }
  }
  private async restoreRegistry(): Promise<void> { try { const raw = await readFile(this.registryPath(), "utf8"); const parsed = JSON.parse(raw) as { jobs?: unknown; bindings?: unknown }; if (!Array.isArray(parsed.jobs) || !Array.isArray(parsed.bindings)) return; for (const job of parsed.jobs) { if (!job || typeof job !== "object" || typeof (job as Job).id !== "string") continue; const restored = copy(job as Job); if (!terminal.has(restored.state)) restored.state = "lost"; this.jobs.set(restored.id, restored); } for (const [id, binding] of parsed.bindings) { if (typeof id === "string" && binding && typeof binding === "object" && typeof binding.projectId === "string") this.jobBindings.set(id, binding as { projectId: string; classification: DataClassification }); } } catch { /* missing/corrupt snapshot → fresh registry */ } }
  private discoveryReady(): boolean {
    const advertisesEvolutionEval = this.discovery?.capabilities.some((capability) => capability.runClasses.includes("evolution_eval")) === true;
    return this.discovery?.license_status === "available"
      && this.discovery.capabilities.length > 0
      && this.discovery.unsupported?.length === undefined
      && (!advertisesEvolutionEval || validEvolutionEvalRemoteAttestation(this.discovery));
  }
  private leaseReady(): boolean {
    const ready = this.registration?.registration_state === "ready"
      && this.leaseExpiresAt !== undefined && this.clock().getTime() < this.leaseExpiresAt;
    if (!ready && this.registration?.registration_state === "ready") {
      this.registration = { ...this.registration, registration_state: "offline" };
    }
    return ready;
  }
  private hasDrift(discovery: DiscoverySnapshot): boolean { return discovery.connector_protocol_version !== this.endpoint.protocol_version || discovery.toolchain_profile_hash !== this.endpoint.toolchain_profile_hash || (this.endpoint.expected_capability_map_version !== undefined && discovery.capability_map_version !== this.endpoint.expected_capability_map_version) || (this.endpoint.expected_part_catalog_hash !== undefined && discovery.part_catalog_hash !== this.endpoint.expected_part_catalog_hash) || (this.endpoint.expected_sdk_worker_build_hash !== undefined && discovery.sdk_worker_build_hash !== this.endpoint.expected_sdk_worker_build_hash) || discovery.license_status !== "available"; }

  async handle(request: Request): Promise<Response> {
    await this.restorePromise;
    if (request.method !== "POST") return responseError("METHOD_NOT_ALLOWED", "POST required", 405);
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return responseError("UNSUPPORTED_MEDIA_TYPE", "application/json required", 415);
    const pathname = new URL(request.url).pathname;
    let e: RemoteEnvelope<unknown>;
    try {
      e = (pathname.startsWith("/evolution-eval/")
        ? await boundedJson(request, EVOLUTION_EVAL_HTTP_BODY_MAX_BYTES)
        : await request.json()) as RemoteEnvelope<unknown>;
    } catch (error) {
      if (error instanceof EvolutionEvalProtocolError) return responseError(error.code, error.message, error.code === "EVOLUTION_EVAL_RESOURCE_LIMIT" ? 413 : 400);
      return responseError("INVALID_JSON", "request body must be JSON", 400);
    }
    const invalid = this.validateEnvelope(e); if (invalid) return invalid;
    if (pathname.startsWith("/evolution-eval/") && (
      !exactObjectKeys(e, ["actor", "capability_version", "classification", "correlation_id", "idempotency_key", "payload", "project_id", "schema_version"], ["causation_id"])
      || !exactObjectKeys(e.actor, ["actor_id", "actor_type"])
    )) return responseError("EVOLUTION_EVAL_INVALID_REQUEST", "non-canonical envelope", 400);
    const fingerprint = sha256(JSON.stringify({ ...e, correlation_id: undefined }));
    const key = `${e.project_id}:${e.classification}:${e.actor.actor_type}:${e.actor.actor_id}:${e.idempotency_key}`;
    const evalRoute = pathname.startsWith("/evolution-eval/");
    const expectedAttestation = (pathname === "/evolution-eval/reserve"
      || pathname === "/evolution-eval/submit") ? {
      active_config_sha256: request.headers.get(EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER) ?? "",
      worker_process_instance_id: request.headers.get(EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER) ?? "",
      vivado_toolchain_attestation_sha256: request.headers.get(EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER) ?? "",
    } : undefined;
    const prior = evalRoute ? undefined : this.keys.get(key); if (prior) return prior.fingerprint === fingerprint ? Response.json(prior.body, { status: prior.status }) : responseError("IDEMPOTENCY_CONFLICT", "idempotency key was used with a different request", 409);
    try {
      if (pathname === "/evolution-eval/evidence/entry") return await this.evolutionEvalEntryResponse(e);
      const out = await this.route(pathname, e, expectedAttestation); if (!evalRoute) this.keys.set(key, { fingerprint, status: out.status, body: out.body }); return this.ok(out.body, out.status);
    }
    catch (cause) {
      const code = cause instanceof EvolutionEvalProtocolError
        ? cause.code
        : cause instanceof Error ? cause.message : "WORKER_ERROR";
      const status = code === "JOB_NOT_FOUND" || code === "EVIDENCE_NOT_AVAILABLE" || code === "NOT_FOUND"
        || code === "EVOLUTION_EVAL_EVIDENCE_NOT_AVAILABLE" ? 404
        : code === "EVIDENCE_CORRUPT" || code === "EVOLUTION_EVAL_EVIDENCE_CORRUPT" ? 422
          : code === "EVIDENCE_LIMIT_EXCEEDED" || code === "EVOLUTION_EVAL_RESOURCE_LIMIT"
            || code === "EVOLUTION_EVAL_EVIDENCE_LIMIT_EXCEEDED" ? 413
            : code === "UNSUPPORTED_VIVADO" ? 501
              : code === "IDEMPOTENCY_CONFLICT" || code.includes("BINDING_CONFLICT")
                || code === "EVOLUTION_EVAL_REMOTE_ATTESTATION_MISMATCH" ? 409
                : code === "EVOLUTION_EVAL_SPOOL_FULL" || code === "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE" ? 503
                  : code === "PROJECT_NOT_ALLOWED" || code === "CLASSIFICATION_NOT_ALLOWED" ? 403 : 400;
      return responseError(code, code, status);
    }
  }

  private validateEnvelope(v: unknown): Response | undefined { if (!v || typeof v !== "object") return responseError("INVALID_ENVELOPE", "object required", 400); const e = v as Partial<RemoteEnvelope<unknown>>; if (e.schema_version !== REMOTE_SCHEMA_VERSION) return responseError("UNSUPPORTED_PROTOCOL", "connector.remote.v1 required", 400); if (!good(e.correlation_id) || !good(e.idempotency_key) || !good(e.project_id) || !good(e.capability_version)) return responseError("INVALID_ENVELOPE", "required envelope fields are missing", 400); if (!e.actor || (e.actor.actor_type !== "user" && e.actor.actor_type !== "service") || !good(e.actor.actor_id)) return responseError("INVALID_ENVELOPE", "actor is invalid", 400); if (!classes.includes(e.classification as DataClassification)) return responseError("INVALID_ENVELOPE", "classification is invalid", 400); if (!this.endpoint.project_scope.includes(e.project_id)) return responseError("PROJECT_NOT_ALLOWED", "PROJECT_NOT_ALLOWED", 403); if (!this.endpoint.data_classification_scope.includes(e.classification as DataClassification)) return responseError("CLASSIFICATION_NOT_ALLOWED", "CLASSIFICATION_NOT_ALLOWED", 403); return undefined; }
  private async route(path: string, e: RemoteEnvelope<unknown>, expectedAttestation?: EvolutionEvalRemoteAttestation): Promise<{ status: number; body: RemoteEnvelope<unknown> }> {
    const p = e.payload && typeof e.payload === "object" && !Array.isArray(e.payload) ? e.payload as Record<string, any> : {};
    if (path.startsWith("/evolution-eval/")) return this.routeEvolutionEval(path, e, expectedAttestation);
    if (path === "/registration") { if (this.endpoint.registration_state === "revoked") throw new Error("ENDPOINT_REVOKED"); this.registration = { ...copy(this.endpoint), registration_state: "approved" }; return { status: 200, body: this.envelope(e, this.registration) }; }
    if (path === "/discover") { this.discovery = await this.execution.discover(); return { status: 200, body: this.envelope(e, this.discovery) }; }
    if (path === "/heartbeat") { if (!this.registration) throw new Error("NOT_REGISTERED"); if (this.endpoint.registration_state === "revoked") throw new Error("ENDPOINT_REVOKED"); this.discovery = await this.execution.discover(); const now = this.clock(); const drift = this.hasDrift(this.discovery); const ready = this.discoveryReady() && !drift; this.leaseExpiresAt = now.getTime() + this.endpoint.lease_seconds * 1000; this.registration = { ...this.registration, registration_state: ready ? "ready" : "degraded", discovered: copy(this.discovery), last_heartbeat_at: now.toISOString(), lease_expires_at: new Date(this.leaseExpiresAt).toISOString(), capability_drift: drift }; return { status: 200, body: this.envelope(e, this.registration) }; }
    if (path === "/jobs/submit") {
      if (p.request?.runClass === "evolution_eval") throw new Error("EVOLUTION_EVAL_DEDICATED_ROUTE_REQUIRED");
      if (this.leaseExpiresAt !== undefined && this.clock().getTime() >= this.leaseExpiresAt) { this.registration = this.registration ? { ...this.registration, registration_state: "offline" } : this.registration; throw new Error("LEASE_EXPIRED"); }
      return this.submit(e, p.request as JobRequest, p.approval as Record<string, unknown> | undefined);
    }
    const jobId = p.job_id; if (!good(jobId)) throw new Error("INVALID_JOB_ID"); const job = this.jobs.get(jobId); const binding = this.jobBindings.get(jobId); if (!job || !binding || binding.projectId !== e.project_id || binding.classification !== e.classification) throw new Error("JOB_NOT_FOUND");
    if (path === "/jobs/status") return { status: 200, body: this.envelope(e, copy(job)) };
    if (path === "/jobs/cancel") { if (!terminal.has(job.state)) { job.state = "cancelled"; void this.snapshotRegistry(); } return { status: 200, body: this.envelope(e, copy(job)) }; }
    if (path === "/jobs/evidence") { if (!job.evidence) throw new Error("EVIDENCE_NOT_AVAILABLE"); this.assertEvidenceLimits(job.evidence); return { status: 200, body: this.envelope(e, copy(job.evidence)) }; }
    if (path === "/jobs/evidence/content") { const name = p.name; if (typeof name !== "string" || !evidenceNameRe.test(name)) throw new Error("EVIDENCE_NOT_AVAILABLE"); return this.evidenceContent(e, job, name, p.complete === true); }
    throw new Error("NOT_FOUND");
  }
  private submit(e: RemoteEnvelope<unknown>, request: JobRequest, approval?: Record<string, unknown>): { status: number; body: RemoteEnvelope<unknown> } { const capability = this.discovery?.capabilities.find(c => c.operation === request?.operation); if (!this.registration || this.registration.registration_state !== "ready" || this.registration.capability_drift === true) throw new Error("ENDPOINT_NOT_APPROVED"); if (!request || request.projectId !== e.project_id || !good(request.idempotencyKey) || !good(request.operation) || !good(request.input) || !good(request.correlationId)) throw new Error("INVALID_JOB_REQUEST"); if (!this.endpoint.allowed_capability_ids.includes(request.operation) || !capability || capability.version !== e.capability_version || !capability.runClasses.includes(request.runClass)) throw new Error("CAPABILITY_UNAVAILABLE"); if (request.runClass === "gate_check" && !good(approval?.gateSubmissionId)) throw new Error("GATE_SUBMISSION_REQUIRED"); if (request.runClass === "formal" && (approval?.inputApproved !== true || (!good(approval?.baselineId) && !good(approval?.approvedGateResultId)))) throw new Error("FORMAL_GATE_REQUIRED"); if (request.runClass === "formal" && request.input.startsWith("candidate:")) throw new Error("CANDIDATE_FORMAL_REJECTED"); const jobId = request.jobId ?? `job-${crypto.randomUUID()}`; if (!idRe.test(jobId)) throw new Error("INVALID_JOB_ID"); const fingerprint = sha256(JSON.stringify(request)); const old = this.jobs.get(jobId); if (old) { const binding = this.jobBindings.get(jobId); if (!binding || binding.projectId !== e.project_id || binding.classification !== e.classification) throw new Error("JOB_NOT_FOUND"); if (sha256(JSON.stringify(old.request)) !== fingerprint) throw new Error("IDEMPOTENCY_CONFLICT"); return { status: 200, body: this.envelope(e, copy(old)) }; } const job: Job = { id: jobId, request: { ...request, jobId }, state: "submitted", inputSha256: sha256(request.input) }; this.jobs.set(jobId, job); this.jobBindings.set(jobId, { projectId: e.project_id, classification: e.classification }); this.pending.push(jobId); void this.snapshotRegistry(); void this.pump(); return { status: 202, body: this.envelope(e, copy(job)) }; }


  private async routeEvolutionEval(path: string, e: RemoteEnvelope<unknown>, expectedAttestation?: EvolutionEvalRemoteAttestation): Promise<{ status: number; body: RemoteEnvelope<unknown> }> {
    if (!this.evolutionEval) throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    if (e.actor.actor_type !== "service" || e.actor.actor_id !== "synthia-core-evolution-eval-dispatcher") {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_OPERATION_FORBIDDEN");
    }
    const request = validateEvolutionEvalRemoteRequest(e.payload, e.project_id);
    const routeBySchema: Readonly<Record<EvolutionEvalRemoteRequestV1["schema"], string>> = {
      "evolution-eval-preflight-request.v1": "/evolution-eval/preflight",
      "evolution-eval-query-request.v1": "/evolution-eval/query",
      "evolution-eval-reserve-request.v1": "/evolution-eval/reserve",
      "evolution-eval-submit-request.v1": "/evolution-eval/submit",
      "evolution-eval-cancel-request.v1": "/evolution-eval/cancel",
      "evolution-eval-spool-query.v1": "/evolution-eval/spool/query",
      "evolution-eval-retention-query-request.v1": "/evolution-eval/retention/query",
      "evolution-eval-evidence-manifest-request.v1": "/evolution-eval/evidence/manifest",
      "evolution-eval-evidence-entry-request.v1": "/evolution-eval/evidence/entry",
      "evolution-eval-evidence-ack-request.v1": "/evolution-eval/evidence/ack",
      "evolution-eval-evidence-corrupt-ack-request.v1": "/evolution-eval/evidence/corrupt-ack",
      "evolution-eval-evidence-cleanup-request.v1": "/evolution-eval/evidence/cleanup",
    };
    if (routeBySchema[request.schema] !== path) throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_OPERATION_FORBIDDEN");
    if (request.schema === "evolution-eval-preflight-request.v1"
      || request.schema === "evolution-eval-reserve-request.v1") {
      this.discovery = await this.execution.discover();
    }
    if (request.schema === "evolution-eval-preflight-request.v1") {
      if (!validEvolutionEvalRemoteAttestation(this.discovery)) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
      }
      const capability = this.discovery?.capabilities.find((item) => item.operation === request.binding.dispatch.operation);
      const spool = await this.evolutionEval.querySpool(request.binding);
      const discoveryPolicy = evaluateEvolutionEvalDiscoveryPolicy(this.discovery?.capabilities ?? [], "vivado-batch-1");
      const eligible = this.leaseReady()
        && this.discovery?.license_status === "available"
        && this.discovery.toolchain_profile_hash === request.binding.dispatch.toolchain_profile_hash
        && capability?.version === e.capability_version
        && capability.runClasses.includes("evolution_eval")
        && discoveryPolicy.eligible
        && spool.unacked_bytes < spool.hard_cap_bytes;
      return { status: 200, body: this.envelope(e, {
        schema: "evolution-eval-preflight-result.v1",
        eligible,
        operation: request.binding.dispatch.operation,
        capability_version: capability?.version ?? null,
        license_available: this.discovery?.license_status === "available",
        active_config_sha256: this.discovery.active_config_sha256,
        worker_process_instance_id: this.discovery.worker_process_instance_id,
        vivado_toolchain_attestation_sha256: this.discovery.vivado_toolchain_attestation_sha256,
        live_mapping_health: this.discovery.live_mapping_health,
        unacked_spool_bytes: spool.unacked_bytes,
        hard_cap_bytes: spool.hard_cap_bytes,
        error_code: eligible ? null : spool.unacked_bytes >= spool.hard_cap_bytes
          ? "EVOLUTION_EVAL_SPOOL_FULL" : "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE",
      }) };
    }
    if (request.schema === "evolution-eval-query-request.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.query(request.binding)) };
    }
    if (request.schema === "evolution-eval-reserve-request.v1") {
      this.assertEvolutionEvalRemoteAttestation(expectedAttestation);
      return { status: 200, body: this.envelope(e, await this.evolutionEval.reserve(request.binding)) };
    }
    if (request.schema === "evolution-eval-spool-query.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.querySpool(request.binding)) };
    }
    if (request.schema === "evolution-eval-retention-query-request.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.queryRetention(request.binding)) };
    }
    if (request.schema === "evolution-eval-cancel-request.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.cancel(request.binding, request.reason)) };
    }
    if (request.schema === "evolution-eval-evidence-manifest-request.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.evidenceManifest(request.binding)) };
    }
    if (request.schema === "evolution-eval-evidence-entry-request.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.evidenceEntry(request.binding, request.name)) };
    }
    if (request.schema === "evolution-eval-evidence-ack-request.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.acknowledgeEvidence(request.binding, {
        connectorManifestHash: request.connector_manifest_hash,
        coreManifestHash: request.core_manifest_hash,
        coreAckFactHash: request.core_ack_fact_hash,
      })) };
    }
    if (request.schema === "evolution-eval-evidence-corrupt-ack-request.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.quarantineEvidence(request.binding, {
        errorFactHash: request.error_fact_hash,
        coreQuarantineFactHash: request.core_quarantine_fact_hash,
      })) };
    }
    if (request.schema === "evolution-eval-evidence-cleanup-request.v1") {
      if (request.mode === "connector_authorized") {
        return { status: 200, body: this.envelope(e, await this.evolutionEval.cleanupEvidence(
          request.binding,
          request.connector_authorization_fact_hash,
          request.core_cleanup_fact_hash,
        )) };
      }
      const discard = request.reason === "absolute_expiry"
        ? {
            reason: request.reason,
            coreManifestHash: request.core_manifest_hash,
            coreConclusionFactHash: request.core_conclusion_fact_hash,
            coreCleanupFactHash: request.core_cleanup_fact_hash,
            discardAuthorizationHash: request.discard_authorization_hash,
          }
        : {
            reason: request.reason,
            coreConclusionFactHash: request.core_conclusion_fact_hash,
            coreCleanupFactHash: request.core_cleanup_fact_hash,
            discardAuthorizationHash: request.discard_authorization_hash,
          };
      return { status: 200, body: this.envelope(e, await this.evolutionEval.discardEvidence(request.binding, discard)) };
    }
    // A replay is a read of already-durable state, not a new effect. Preserve
    // it even after the original deadline and without touching live toolchain
    // discovery or process-guardian seams.
    const before = await this.evolutionEval.query(request.binding);
    if (before.state === "accepted" || before.state === "terminal") {
      const result = await this.evolutionEval.submit(request.binding, request.input);
      return { status: 200, body: this.envelope(e, result) };
    }
    if (before.state !== "proven_never_accepted" || !before.replay_permitted) {
      const result = await this.evolutionEval.submit(request.binding, request.input);
      return { status: 202, body: this.envelope(e, result) };
    }

    // Reject an expired new submission before discovery. This is the canary's
    // Worker-level no-effect fence: no spool admission, materialization,
    // guardian preparation, or Vivado interaction is reachable past it.
    effectiveEvolutionEvalTimeoutMs(request.binding, this.clock());
    this.discovery = await this.execution.discover();
    this.assertEvolutionEvalRemoteAttestation(expectedAttestation);
    const capability = this.discovery!.capabilities.find((item) => item.operation === request.binding.dispatch.operation);
    const discoveryPolicy = evaluateEvolutionEvalDiscoveryPolicy(this.discovery?.capabilities ?? [], "vivado-batch-1");
    if (!validEvolutionEvalRemoteAttestation(this.discovery)
      || !this.leaseReady()
      || this.discovery?.license_status !== "available"
      || this.discovery.toolchain_profile_hash !== request.binding.dispatch.toolchain_profile_hash
      || capability?.version !== e.capability_version
      || !capability.runClasses.includes("evolution_eval") || !discoveryPolicy.eligible) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    }
    const result = await this.evolutionEval.submit(request.binding, request.input);
    return { status: 202, body: this.envelope(e, result) };
  }
  private assertEvolutionEvalRemoteAttestation(
    expectedAttestation: EvolutionEvalRemoteAttestation | undefined,
  ): asserts expectedAttestation is EvolutionEvalRemoteAttestation {
    if (!validEvolutionEvalRemoteAttestation(this.discovery)
      || !expectedAttestation
      || expectedAttestation.active_config_sha256 !== this.discovery.active_config_sha256
      || expectedAttestation.worker_process_instance_id !== this.discovery.worker_process_instance_id
      || expectedAttestation.vivado_toolchain_attestation_sha256 !== this.discovery.vivado_toolchain_attestation_sha256) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_REMOTE_ATTESTATION_MISMATCH");
    }
  }
  private async evolutionEvalEntryResponse(e: RemoteEnvelope<unknown>): Promise<Response> {
    if (!this.evolutionEval) throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    if (e.actor.actor_type !== "service" || e.actor.actor_id !== "synthia-core-evolution-eval-dispatcher") {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_OPERATION_FORBIDDEN");
    }
    const request = validateEvolutionEvalRemoteRequest(e.payload, e.project_id);
    if (request.schema !== "evolution-eval-evidence-entry-request.v1") {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_OPERATION_FORBIDDEN");
    }
    const descriptor = await this.evolutionEval.evidenceEntryDescriptor(request.binding, request.name);
    return new Response(Bun.file(descriptor.path), {
      status: 200,
      headers: {
        "content-type": descriptor.entry.media_type,
        "content-length": String(descriptor.entry.size_bytes),
        "x-synthia-schema": "evolution-eval-connector-evidence-entry-stream.v1",
        "x-synthia-correlation-id": e.correlation_id,
        "x-synthia-idempotency-key": e.idempotency_key,
        "x-synthia-project-id": e.project_id,
        "x-synthia-classification": e.classification,
        "x-synthia-capability-version": e.capability_version,
        "x-synthia-eval-job-id": descriptor.binding.dispatch.eval_job_id,
        "x-synthia-connector-job-id": descriptor.binding.dispatch.connector_job_id,
        "x-synthia-dispatch-request-hash": descriptor.binding.dispatch_request_hash,
        "x-synthia-evidence-name": descriptor.entry.name,
        "x-synthia-evidence-sha256": descriptor.entry.sha256,
      },
    });
  }
  private async pump(): Promise<void> { while (this.active < this.endpoint.max_concurrency && this.pending.length) { const jobId = this.pending.shift()!; const job = this.jobs.get(jobId); if (!job || terminal.has(job.state)) continue; this.active++; void this.run(job).finally(() => { this.active--; void this.pump(); }); } }
  private async run(job: Job): Promise<void> {
    const workspace = join(this.root, job.id);
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "request-input.txt"), job.request.input, "utf8");
      job.state = "preparing";
      job.state = "running";
      const result = await this.execution.execute(copy(job.request), workspace);
      if (this.jobs.get(job.id)?.state === "cancelled") return;
      job.state = result.outcome === "success" ? "succeeded" : result.outcome === "timeout" ? "timeout" : result.outcome === "lost" ? "lost" : result.outcome === "unknown_effect" ? "unknown_effect" : "failed";
      if (result.error_code) job.errorCode = result.error_code;
      if (result.output !== undefined) {
        job.outputSha256 = sha256(result.output);
        const outputPath = join(workspace, "output", "worker-result.json");
        await mkdir(join(workspace, "output"), { recursive: true });
        await writeFile(outputPath, result.output, "utf8");
        const outputEntry = { name: "worker-result.json", uri: `workspace://${job.id}/output/worker-result.json`, sha256: job.outputSha256, sizeBytes: new TextEncoder().encode(result.output).byteLength, mediaType: "application/json" };
        job.evidence = { jobId: job.id, entries: [...(result.evidence?.entries ?? []), outputEntry] };
      } else if (result.evidence) job.evidence = result.evidence;
      // Terminal transitions persist before run() settles — a crash right
      // after completion must not reload the job as non-terminal/lost.
      await this.snapshotRegistry();
    } catch {
      if (this.jobs.get(job.id)?.state === "cancelled") return;
      job.state = "failed";
      if (!job.errorCode) job.errorCode = "WORKER_EXECUTION_ERROR";
    }
  }
  private async evidenceContent(e: RemoteEnvelope<unknown>, job: Job, name: string, complete = false): Promise<{ status: number; body: RemoteEnvelope<unknown> }> {
    if (!job.evidence) throw new Error("EVIDENCE_NOT_AVAILABLE");
    this.assertEvidenceLimits(job.evidence);
    const entry = job.evidence.entries.find(x => x.name === name);
    if (!entry) throw new Error("EVIDENCE_NOT_AVAILABLE");
    const filePath = join(this.root, job.id, "output", name);
    let buf: Buffer;
    try { const details = await stat(filePath); if (details.size > MAX_EVIDENCE_ENTRY_BYTES) throw new Error("EVIDENCE_LIMIT_EXCEEDED"); if (!details.isFile() || details.size !== entry.sizeBytes) throw new Error("EVIDENCE_CORRUPT"); buf = await readFile(filePath) as Buffer; } catch (error) { if (error instanceof Error && error.message === "EVIDENCE_LIMIT_EXCEEDED") throw error; throw new Error("EVIDENCE_CORRUPT"); }
    if (sha256(buf) !== entry.sha256) throw new Error("EVIDENCE_CORRUPT");
    let contentBytes: Uint8Array = buf;
    let truncated = false;
    if (!complete && buf.byteLength > MAX_CONTENT_BYTES) {
      truncated = true;
      const omitted = buf.byteLength - CONTENT_WINDOW_BYTES * 2;
      contentBytes = Buffer.concat([buf.subarray(0, CONTENT_WINDOW_BYTES), Buffer.from(`\n…[${omitted} bytes omitted]…\n`, "utf8"), buf.subarray(buf.byteLength - CONTENT_WINDOW_BYTES)]);
    }
    return { status: 200, body: this.envelope(e, { name: entry.name, sha256: entry.sha256, sizeBytes: buf.byteLength, mediaType: entry.mediaType, content_base64: Buffer.from(contentBytes).toString("base64"), truncated }) };
  }
  private assertEvidenceLimits(manifest: EvidenceManifest): void { if (manifest.entries.length > MAX_EVIDENCE_ENTRIES) throw new Error("EVIDENCE_LIMIT_EXCEEDED"); let total = 0; for (const entry of manifest.entries) { if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > MAX_EVIDENCE_ENTRY_BYTES) throw new Error("EVIDENCE_LIMIT_EXCEEDED"); total += entry.sizeBytes; if (!Number.isSafeInteger(total) || total > MAX_EVIDENCE_TOTAL_BYTES) throw new Error("EVIDENCE_LIMIT_EXCEEDED"); } }
  private envelope<T>(e: RemoteEnvelope<unknown>, payload: T): RemoteEnvelope<T> { return { schema_version: REMOTE_SCHEMA_VERSION, correlation_id: e.correlation_id, causation_id: e.correlation_id, idempotency_key: e.idempotency_key, actor: e.actor, project_id: e.project_id, classification: e.classification, capability_version: e.capability_version, payload }; }
  private jobIdFrom(v: unknown): string { return v && typeof v === "object" && "id" in v && typeof v.id === "string" ? v.id : "worker"; }
  private ok<T>(body: RemoteEnvelope<T>, status: number): Response { return Response.json(body, { status }); }
}
export function createWorkerHandler(options: WorkerRuntimeOptions): (request: Request) => Promise<Response> { const runtime = new WorkerRuntime(options); return runtime.handle.bind(runtime); }
