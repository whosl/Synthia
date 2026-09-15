import { createServer, type Server } from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createConnection } from "node:net";
import { WorkerRuntime, type WorkerExecution, type WorkerRuntimeOptions, type WorkerExecutionResult } from "./worker.ts";
import { createVivadoProcessGuardian, VivadoBatchAdapter, VIVADO_CAPABILITIES, type VivadoRequest } from "./vivado.ts";
import type { JobRequest } from "./index.ts";
import { REMOTE_SCHEMA_VERSION, type ConnectorEndpoint, type DiscoverySnapshot } from "./remote.ts";
import { canonicalRequestHash } from "../core/src/hashing.ts";
import { buildFullTreeManifest, finalizeVivadoToolchainAttestation, loadVivadoToolchainAttestation, type VivadoToolchainAttestationV1 } from "./toolchain-attestation.ts";

// The discovery wire contract is the three-key ConnectorCapability shape;
// server-internal CapabilityDefinition fields must not leak onto the wire.
const DISCOVERY_CAPABILITIES: readonly { operation: string; version: string; runClasses: readonly string[] }[] = Object.freeze(
  VIVADO_CAPABILITIES.map((capability) => ({
    operation: capability.operation,
    version: capability.version,
    runClasses: Object.freeze([...capability.runClasses]),
  })),
);

export interface WorkerConfig extends ConnectorEndpoint {
  listen_host: string;
  listen_port: number;
  server_certificate_path: string;
  server_private_key_path: string;
  trusted_client_ca_path: string;
  workspace_root: string;
  evidence_root: string;
  vivado_binary: string;
  vivado_part: string;
  vivado_install_identity: string;
  capability_map_version: string;
  part_catalog_hash: string;
  sdk_worker_build_hash: string;
  evolution_eval_enabled?: boolean;
  evolution_eval_ledger_root?: string;
  evolution_eval_ledger_epoch?: string;
  evolution_eval_ledger_mode?: "initialize" | "reopen";
  evolution_eval_spool_root?: string;
  evolution_eval_log_root?: string;
  vivado_toolchain_attestation_path?: string;
  vivado_toolchain_attestation_sha256?: string;
  vivado_toolchain_lock_handoff_path?: string;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const execFileAsync = promisify(execFile);
const failedBackingLocks = new WeakSet<ChildProcess>();

function boundedIdentity(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`CONFIG_INVALID:${name}`);
  return value;
}

/**
 * Keep the outer Connector request and the inner Vivado request on one
 * identity. Legacy exploratory requests may omit the newer inputHash member,
 * but may never provide a conflicting one. Formal requests must bind both the
 * immutable input hash and the discovered toolchain profile exactly.
 */
export function workerRequestBindingMatches(
  request: JobRequest,
  candidate: unknown,
  toolchainProfileHash: string,
  configured?: { readonly vivadoBinary: string; readonly part: string },
): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const binding = candidate as Record<string, unknown>;
  const identityBinding = binding.jobId === request.jobId
    && binding.projectId === request.projectId
    && binding.operation === request.operation
    && binding.runClass === request.runClass;
  const inputBinding = request.runClass === "formal"
    ? binding.inputHash === request.input
    : binding.inputHash === undefined || binding.inputHash === request.input;
  const toolchainBinding = request.runClass !== "formal"
    || binding.toolchainHash === toolchainProfileHash;
  const nested = binding.toolchain === undefined
    ? undefined
    : binding.toolchain && typeof binding.toolchain === "object" && !Array.isArray(binding.toolchain)
      ? binding.toolchain as Record<string, unknown>
      : null;
  if (nested === null) return false;
  const profileBinding = nested?.profileHash === undefined || nested.profileHash === toolchainProfileHash;
  const configuredBinding = configured === undefined || (
    (nested?.vivadoBinary === undefined || nested.vivadoBinary === configured.vivadoBinary)
    && (nested?.part === undefined || nested.part === configured.part)
    && (binding.part === undefined || binding.part === configured.part)
  );
  return identityBinding && inputBinding && toolchainBinding && profileBinding && configuredBinding;
}

function validateWorkerConfig(config: WorkerConfig): WorkerConfig {
  for (const name of ["connector_id", "endpoint_url", "protocol_version", "transport_mode", "auth_mode", "workspace_root", "evidence_root", "server_certificate_path", "server_private_key_path", "trusted_client_ca_path", "vivado_binary", "vivado_part", "toolchain_profile_hash", "part_catalog_hash", "sdk_worker_build_hash"] as const) required(config[name], name);
  if (config.protocol_version !== REMOTE_SCHEMA_VERSION || config.transport_mode !== "direct_https" || config.auth_mode !== "mtls") throw new Error("CONFIG_INVALID:protocol");
  if (!Number.isInteger(config.listen_port) || config.listen_port < 1 || config.listen_port > 65535) throw new Error("CONFIG_INVALID:listen_port");
  if (config.evolution_eval_enabled !== undefined && typeof config.evolution_eval_enabled !== "boolean") {
    throw new Error("CONFIG_INVALID:evolution_eval_enabled");
  }
  if (config.evolution_eval_enabled === true) {
    for (const name of ["evolution_eval_ledger_root", "evolution_eval_ledger_epoch", "evolution_eval_spool_root", "evolution_eval_log_root", "vivado_toolchain_attestation_path", "vivado_toolchain_attestation_sha256", "vivado_toolchain_lock_handoff_path"] as const) required(config[name], name);
    if (!HASH_PATTERN.test(config.vivado_toolchain_attestation_sha256!)) throw new Error("CONFIG_INVALID:vivado_toolchain_attestation_sha256");
    if (config.evolution_eval_ledger_mode !== "initialize" && config.evolution_eval_ledger_mode !== "reopen") throw new Error("CONFIG_INVALID:evolution_eval_ledger_mode");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.evolution_eval_ledger_epoch!)
      || config.evolution_eval_ledger_epoch === "REPLACE_WITH_M4F_DEPLOYMENT_EPOCH") {
      throw new Error("CONFIG_INVALID:evolution_eval_ledger_epoch");
    }
    const roots = [config.workspace_root, config.evidence_root, config.evolution_eval_ledger_root!, config.evolution_eval_spool_root!, config.evolution_eval_log_root!]
      .map((value) => value.toLowerCase().replace(/[\\/]+$/, ""));
    const overlaps = roots.some((root, index) => roots.some((candidate, candidateIndex) => (
      index !== candidateIndex
      && (root === candidate || root.startsWith(`${candidate}/`) || root.startsWith(`${candidate}\\`))
    )));
    if (overlaps) throw new Error("CONFIG_INVALID:evolution_eval_roots");
  }
  return config;
}

async function readWorkerConfig(path: string): Promise<{ config: WorkerConfig; sha256: string }> {
  const bytes = await readFile(path);
  return {
    config: validateWorkerConfig(JSON.parse(bytes.toString("utf8")) as WorkerConfig),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function loadWorkerConfig(path = process.env.SYNTHIA_WORKER_CONFIG ?? "D:/synthia-worker/config.json"): Promise<WorkerConfig> {
  return (await readWorkerConfig(path)).config;
}

function assertToolchainAttestationMatchesConfig(config: WorkerConfig, attestation: VivadoToolchainAttestationV1): void {
  if (attestation.toolchain_profile.derived_sha256 !== config.toolchain_profile_hash) throw new Error("CONFIG_INVALID:toolchain_profile_hash");
  if (attestation.toolchain_profile.capability_map_version !== config.capability_map_version) throw new Error("CONFIG_INVALID:capability_map_version");
  if (attestation.vivado.part_catalog_sha256 !== config.part_catalog_hash) throw new Error("CONFIG_INVALID:part_catalog_hash");
  if (attestation.vivado.target_part !== config.vivado_part) throw new Error("CONFIG_INVALID:vivado_part");
  const mountedBinary = `${attestation.attachment.volume.mount_path.replace(/[\\/]+$/u, "")}\\${attestation.vivado.binary_relative_path.replaceAll("/", "\\")}`;
  const normalize = (value: string) => value.replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase();
  if (normalize(mountedBinary) !== normalize(config.vivado_binary)) throw new Error("CONFIG_INVALID:vivado_binary");
}

async function assertLiveWindowsToolchainMapping(attestation: VivadoToolchainAttestationV1): Promise<void> {
  if (process.platform !== "win32") return;
  // The authorized admin Worker session cannot safely use the Storage CIM
  // surface (Get-Disk/Get-Partition hang under S4U tokens, and Start-Job
  // wraps the same hang). With SYNTHIA_M4F_MAPPING_VOLUME_ONLY=1 the check
  // degrades to the volume-level identity that session can complete.
  const volumeOnly = process.env.SYNTHIA_M4F_MAPPING_VOLUME_ONLY === "1";
  const script = [
    "$ErrorActionPreference='Stop'",
    "$vo=($env:SYNTHIA_M4F_MAPPING_VOLUME_ONLY -eq '1')",
    "if(-not $vo){$image=Get-DiskImage -ImagePath $args[0]}",
    "if(-not $vo -and (-not $image.Attached -or -not ([IO.Path]::GetFullPath([string]$image.ImagePath)).Equals([IO.Path]::GetFullPath($args[0]),[StringComparison]::OrdinalIgnoreCase))){exit 11}",
    "$disk=$null",
    "if(-not $vo){try{$j=Start-Job -ScriptBlock{param($p)Get-DiskImage -ImagePath $p|Get-Disk}-ArgumentList $args[0];if(Wait-Job $j -Timeout 5){$disk=Receive-Job $j};Remove-Job $j -Force}catch{}}",
    "$vol=$null",
    "if($disk){",
    "if(-not $disk.IsReadOnly-or [string]$disk.Number-cne$args[1]-or [string]$disk.UniqueId-cne$args[2]){exit 12}",
    "$pj=Start-Job -ScriptBlock{param($dn,$pn)Get-Partition -DiskNumber $dn -PartitionNumber $pn}-ArgumentList $disk.Number,([int]$args[3]);if(-not(Wait-Job $pj -Timeout 5)){Remove-Job $pj -Force;exit 20};$part=Receive-Job $pj;Remove-Job $pj -Force",
    "if([string]$part.Guid-cne$args[4]){exit 13}",
    "$vol=$part|Get-Volume",
    "$actualPaths=@($part.AccessPaths|%{$_.TrimEnd('\\')+'\\'}|Sort-Object -Unique)",
    "$expectedPaths=@(($args[7].TrimEnd('\\')),([string]$args[5]).TrimEnd('\\'))|ForEach-Object{$_+'\\'}|Sort-Object -Unique",
    "if(@(Compare-Object $actualPaths $expectedPaths).Count-ne 0){exit 15}",
    "}else{",
    "$ml=([string]$args[7]).Substring(0,1)",
    "$vol=Get-Volume -DriveLetter $ml -ErrorAction Stop",
    "}",
  ].join(";");
  try {
    // PowerShell -Command parses trailing arguments as expressions, which
    // mangles GUID/brace-bearing paths ({...} becomes a script block). Run the
    // script via a temp file with -File so every argument arrives as a literal.
    const mappingScriptPath = join(tmpdir(), `synthia-m4f-mapping-${process.pid}-${Date.now()}.ps1`);
    await writeFile(mappingScriptPath, script + "\n", { mode: 0o600 });
    try {
      await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", mappingScriptPath,
        attestation.vhdx.path,
        String(attestation.attachment.disk.number),
        attestation.attachment.disk.unique_id,
        String(attestation.attachment.partition.number),
        attestation.attachment.partition.guid,
        attestation.attachment.volume.guid,
        attestation.attachment.volume.serial_number,
        attestation.attachment.volume.mount_path,
        attestation.vhdx.file_identity.file_id,
        attestation.vhdx.file_identity.volume_serial_number,
        attestation.vhdx.backing_parent.path,
        attestation.vhdx.backing_parent.owner_sid,
        attestation.vhdx.backing_parent.acl_sha256,
        String(attestation.full_tree_manifest.total_bytes),
      ], { windowsHide: true, timeout: 30_000 });
    } finally {
      await rm(mappingScriptPath, { force: true }).catch(() => {});
    }
  } catch (error) {
    const mappingExit = /exit (\d+)/.exec(String((error as { stderr?: unknown }).stderr ?? ""))?.[1]
      ?? /exit code (\d+)/.exec(String(error))?.[1]
      ?? "";
    throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:live_mapping${mappingExit ? `:${mappingExit}` : ""}`);
  }
}

async function holdProtectedVhdxBacking(attestation: VivadoToolchainAttestationV1): Promise<ChildProcess | undefined> {
  if (process.platform !== "win32") return undefined;
  const script = [
    "$ErrorActionPreference='Stop'",
    "$stream=[IO.File]::Open($args[0],[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)",
    "$sha=[Security.Cryptography.SHA256]::Create()",
    "$digest=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()",
    "$length=$stream.Length",
    "$identity=((& fsutil.exe file queryfileid $args[0] 2>$null)|Out-String)",
    "if($LASTEXITCODE-ne 0){exit 18}",
    "[Console]::Out.WriteLine(('LOCKED|{0}|{1}|{2}'-f$digest,$length,($identity-replace'[\\r\\n]+',' ')))",
    "[Console]::Out.Flush()",
    "while($true){$line=[Console]::In.ReadLine();if($null-eq$line-or$line-eq'STOP'){break};Start-Sleep -Milliseconds 100}",
    "$stream.Dispose()",
  ].join(";");
  // -Command parses the trailing vhdx path as an expression and fails; use a
  // temp script file with -File so the path arrives as a literal argument.
  const backingScriptPath = join(tmpdir(), `synthia-m4f-backing-${process.pid}-${Date.now()}.ps1`);
  await writeFile(backingScriptPath, script + "\n", { mode: 0o600 });
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", backingScriptPath, attestation.vhdx.path], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.once("close", () => { void rm(backingScriptPath, { force: true }).catch(() => {}); });
  child.once("error", () => failedBackingLocks.add(child));
  child.once("exit", () => failedBackingLocks.add(child));
  child.once("close", () => failedBackingLocks.add(child));
  const line = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("TOOLCHAIN_ATTESTATION_INVALID:backing_lock_timeout")), 900_000);
    child.stdout!.on("data", (chunk) => {
      output += String(chunk);
      const newline = output.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timeout);
        resolve(output.slice(0, newline).trim());
      }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", () => { clearTimeout(timeout); reject(new Error("TOOLCHAIN_ATTESTATION_INVALID:backing_lock")); });
  });
  const [marker, digest, size, identity] = line.split("|", 4);
  if (marker !== "LOCKED" || digest !== attestation.vhdx.sha256 || Number(size) !== attestation.vhdx.size_bytes
    || !identity?.includes(attestation.vhdx.file_identity.file_id)) {
    child.kill();
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:backing_lock_identity");
  }
  child.unref();
  (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
  child.stdout?.destroy();
  child.stderr?.destroy();
  return child;
}

async function acknowledgeToolchainLockHandoff(
  config: WorkerConfig,
  attestation: VivadoToolchainAttestationV1,
  workerProcessInstanceId: string,
): Promise<void> {
  if (process.platform !== "win32") return;
  const path = required(config.vivado_toolchain_lock_handoff_path, "vivado_toolchain_lock_handoff_path");
  let request: Record<string, unknown>;
  try { request = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }
  catch { throw new Error("TOOLCHAIN_ATTESTATION_INVALID:lock_handoff"); }
  const keys = Object.keys(request).sort().join(",");
  if (keys !== "file_id,nonce,pipe_name,schema,supervisor_pid,supervisor_start_token,vivado_toolchain_attestation_sha256,volume_serial_number"
    || request.schema !== "synthia-vivado-toolchain-lock-handoff.v1"
    || request.vivado_toolchain_attestation_sha256 !== config.vivado_toolchain_attestation_sha256
    || request.volume_serial_number !== attestation.vhdx.file_identity.volume_serial_number
    || request.file_id !== attestation.vhdx.file_identity.file_id
    || typeof request.pipe_name !== "string" || !OPAQUE_ID_PATTERN.test(request.pipe_name)
    || !Number.isSafeInteger(request.supervisor_pid) || Number(request.supervisor_pid) < 1
    || typeof request.supervisor_start_token !== "string" || !HASH_PATTERN.test(request.supervisor_start_token)
    || typeof request.nonce !== "string" || !OPAQUE_ID_PATTERN.test(request.nonce)) {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:lock_handoff");
  }
  const ackPath = `${path}.ack.json`;
  const ack = {
    schema: "synthia-vivado-toolchain-lock-handoff-ack.v1",
    nonce: request.nonce,
    worker_process_instance_id: workerProcessInstanceId,
    vivado_toolchain_attestation_sha256: config.vivado_toolchain_attestation_sha256,
  };
  let handle: FileHandle;
  try {
    handle = await open(ackPath, "r+");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "EACCES") {
      // The supervisor seals the one-shot ack slot after consuming the
      // ceremony handoff; a same-ceremony worker restart must reopen (identity
      // is already proven by the PING above), never re-initialize the slot.
      const sealed = await stat(ackPath);
      if (sealed.size > 0) return;
    }
    throw error;
  }
  try {
    await handle.truncate(0);
    await handle.writeFile(`${JSON.stringify(ack)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pingToolchainCeremonyLock(config: WorkerConfig, attestation: VivadoToolchainAttestationV1): Promise<void> {
  if (process.platform !== "win32") return;
  const path = required(config.vivado_toolchain_lock_handoff_path, "vivado_toolchain_lock_handoff_path");
  let request: Record<string, unknown>;
  try { request = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }
  catch { throw new Error("TOOLCHAIN_ATTESTATION_INVALID:lock_handoff"); }
  if (Object.keys(request).sort().join(",") !== "file_id,nonce,pipe_name,schema,supervisor_pid,supervisor_start_token,vivado_toolchain_attestation_sha256,volume_serial_number"
    || request.schema !== "synthia-vivado-toolchain-lock-handoff.v1"
    || request.vivado_toolchain_attestation_sha256 !== config.vivado_toolchain_attestation_sha256
    || request.volume_serial_number !== attestation.vhdx.file_identity.volume_serial_number
    || request.file_id !== attestation.vhdx.file_identity.file_id
    || typeof request.pipe_name !== "string" || !OPAQUE_ID_PATTERN.test(request.pipe_name)
    || !Number.isSafeInteger(request.supervisor_pid) || Number(request.supervisor_pid) < 1
    || typeof request.supervisor_start_token !== "string" || !HASH_PATTERN.test(request.supervisor_start_token)
    || typeof request.nonce !== "string" || !OPAQUE_ID_PATTERN.test(request.nonce)) {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:lock_handoff");
  }
  const response = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(`\\\\.\\pipe\\${request.pipe_name as string}`);
    let output = "";
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error("TOOLCHAIN_ATTESTATION_INVALID:lock_helper_timeout")); }, 10_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`PING|${request.nonce as string}\n`));
    socket.on("data", (chunk) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline >= 0) { clearTimeout(timeout); socket.end(); resolve(output.slice(0, newline).trim()); }
    });
    socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
  const expected = [
    "HEALTHY",
    request.nonce,
    request.vivado_toolchain_attestation_sha256,
    attestation.vhdx.sha256,
    String(attestation.vhdx.size_bytes),
    attestation.vhdx.file_identity.volume_serial_number,
    attestation.vhdx.file_identity.file_id,
    String(request.supervisor_pid),
    request.supervisor_start_token,
  ].join("|");
  if (response !== expected) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:lock_helper_identity");
}

export async function verifyVivadoToolchainAttestationFromConfig(configPath: string): Promise<string> {
  const loaded = await loadExecutionConfig(configPath, true);
  if (loaded.config.evolution_eval_enabled !== true || !loaded.toolchain) {
    throw new Error("CONFIG_INVALID:vivado_toolchain_attestation_required");
  }
  // The verify command must not consume the lock supervisor's first pipe
  // connection: that slot belongs to the worker runtime's PING+ACK handshake,
  // and a verify-side PING would start the 30s ACK clock with no ACK writer.
  await assertLiveWindowsToolchainMapping(loaded.toolchain.attestation);
  return loaded.toolchain.rawSha256;
}

async function loadExecutionConfig(path: string, verifyToolchain = false): Promise<{
  config: WorkerConfig;
  sha256: string;
  toolchain?: { readonly attestation: VivadoToolchainAttestationV1; readonly rawSha256: string };
}> {
  const loaded = await readWorkerConfig(path);
  if (loaded.config.evolution_eval_enabled === true) {
    const expected = process.env.SYNTHIA_WORKER_CONFIG_SHA256;
    if (!expected || !HASH_PATTERN.test(expected) || expected !== loaded.sha256) {
      throw new Error("CONFIG_INVALID:active_config_sha256");
    }
    if (verifyToolchain) {
      const toolchain = await loadVivadoToolchainAttestation(
        required(loaded.config.vivado_toolchain_attestation_path, "vivado_toolchain_attestation_path"),
        required(loaded.config.vivado_toolchain_attestation_sha256, "vivado_toolchain_attestation_sha256"),
      );
      assertToolchainAttestationMatchesConfig(loaded.config, toolchain.attestation);
      return { ...loaded, toolchain };
    }
  }
  return loaded;
}

export async function verifyWorkerReleaseManifest(path: string): Promise<string> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const plain = (candidate: unknown): candidate is Record<string, unknown> => (
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
  );
  const exact = (candidate: unknown, expected: readonly string[]): candidate is Record<string, unknown> => (
    plain(candidate)
    && Object.keys(candidate).sort().length === expected.length
    && Object.keys(candidate).sort().every((key, index) => key === [...expected].sort()[index])
  );
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "bundle",
    "expected",
    "git_commit",
    "git_status_sha256",
    "manifest_hash",
    "release_files",
    "runtime",
    "schema",
    "source_state",
    "sources",
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("RELEASE_MANIFEST_INVALID:shape");
  }
  if (value.schema !== "synthia-worker-release-manifest.v1"
    || typeof value.git_commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.git_commit)
    || (value.source_state !== "clean" && value.source_state !== "dirty")
    || typeof value.git_status_sha256 !== "string" || !HASH_PATTERN.test(value.git_status_sha256)
    || (value.source_state === "clean" && value.git_status_sha256 !== createHash("sha256").update("").digest("hex"))
    || (value.source_state === "dirty" && value.git_status_sha256 === createHash("sha256").update("").digest("hex"))
    || !exact(value.bundle, ["path", "size_bytes", "sha256"])
    || value.bundle.path !== "server.bundle.mjs"
    || !Number.isSafeInteger(value.bundle.size_bytes) || Number(value.bundle.size_bytes) < 1
    || typeof value.bundle.sha256 !== "string" || !HASH_PATTERN.test(value.bundle.sha256)
    || !exact(value.runtime, ["kind", "version", "executable_name", "sha256"])
    || value.runtime.kind !== "bun" || value.runtime.version !== "1.4.1" || value.runtime.executable_name !== "bun.exe"
    || typeof value.runtime.sha256 !== "string" || !HASH_PATTERN.test(value.runtime.sha256)
    || !exact(value.release_files, ["config_template_sha256", "launcher_sha256", "windows_certifier_sha256"])
    || Object.values(value.release_files).some((hash) => typeof hash !== "string" || !HASH_PATTERN.test(hash))) {
    throw new Error("RELEASE_MANIFEST_INVALID:shape");
  }
  if (!Array.isArray(value.sources) || value.sources.length < 1) throw new Error("RELEASE_MANIFEST_INVALID:sources");
  const sourcePaths: string[] = [];
  for (const source of value.sources) {
    if (!exact(source, ["path", "sha256"])
      || !boundedIdentity(source.path, 512)
      || source.path.startsWith("/")
      || source.path.includes("\\")
      || !/^[\x20-\x7e]+$/.test(source.path)
      || source.path.split("/").some((segment) => !segment || segment === "." || segment === "..")
      || typeof source.sha256 !== "string" || !HASH_PATTERN.test(source.sha256)) {
      throw new Error("RELEASE_MANIFEST_INVALID:sources");
    }
    sourcePaths.push(source.path);
  }
  if (sourcePaths.some((source, index) => index > 0 && sourcePaths[index - 1]! >= source)) {
    throw new Error("RELEASE_MANIFEST_INVALID:sources");
  }
  if (!exact(value.expected, [
    "capabilities",
    "capability_map_version",
    "part",
    "part_catalog_hash",
    "protocol_version",
    "sdk_worker_build_hash",
    "toolchain_profile_hash",
    "vivado_patch",
    "vivado_version",
  ])
    || value.expected.protocol_version !== "connector.remote.v1"
    || value.expected.sdk_worker_build_hash !== value.bundle.sha256
    || !boundedIdentity(value.expected.capability_map_version, 128)
    || typeof value.expected.part_catalog_hash !== "string" || !HASH_PATTERN.test(value.expected.part_catalog_hash)
    || typeof value.expected.toolchain_profile_hash !== "string" || !HASH_PATTERN.test(value.expected.toolchain_profile_hash)
    || !boundedIdentity(value.expected.vivado_version, 64)
    || !boundedIdentity(value.expected.vivado_patch, 64)
    || !boundedIdentity(value.expected.part, 128)
    || !Array.isArray(value.expected.capabilities) || value.expected.capabilities.length === 0) {
    throw new Error("RELEASE_MANIFEST_INVALID:expected");
  }
  let previousOperation = "";
  for (const capability of value.expected.capabilities) {
    const runClasses = capability && typeof capability === "object"
      && "run_classes" in capability && Array.isArray(capability.run_classes)
      ? capability.run_classes as unknown[]
      : undefined;
    if (!exact(capability, ["operation", "run_classes", "version"])
      || typeof capability.operation !== "string" || !OPAQUE_ID_PATTERN.test(capability.operation)
      || capability.operation <= previousOperation
      || typeof capability.version !== "string" || !OPAQUE_ID_PATTERN.test(capability.version)
      || !runClasses || runClasses.length === 0
      || runClasses.some((runClass, index) => typeof runClass !== "string"
        || !OPAQUE_ID_PATTERN.test(runClass)
        || (index > 0 && typeof runClasses[index - 1] === "string"
          && (runClasses[index - 1] as string) >= runClass))) {
      throw new Error("RELEASE_MANIFEST_INVALID:capabilities");
    }
    previousOperation = capability.operation;
  }
  const manifestHash = value.manifest_hash;
  if (typeof manifestHash !== "string" || !HASH_PATTERN.test(manifestHash)) {
    throw new Error("RELEASE_MANIFEST_INVALID:manifest_hash");
  }
  const body = { ...value };
  delete body.manifest_hash;
  if (canonicalRequestHash(body) !== manifestHash) {
    throw new Error("RELEASE_MANIFEST_INVALID:canonical_hash");
  }
  return manifestHash;
}

async function assertCurrentVivadoToolchain(
  config: WorkerConfig,
  backingLock: ChildProcess | undefined,
): Promise<{ readonly attestation: VivadoToolchainAttestationV1; readonly rawSha256: string }> {
  if (process.platform === "win32" && (!backingLock || failedBackingLocks.has(backingLock)
    || backingLock.killed || backingLock.exitCode !== null || backingLock.signalCode !== null)) {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:backing_lock");
  }
  const live = await loadVivadoToolchainAttestation(
    required(config.vivado_toolchain_attestation_path, "vivado_toolchain_attestation_path"),
    required(config.vivado_toolchain_attestation_sha256, "vivado_toolchain_attestation_sha256"),
  );
  assertToolchainAttestationMatchesConfig(config, live.attestation);
  await pingToolchainCeremonyLock(config, live.attestation);
  await assertLiveWindowsToolchainMapping(live.attestation);
  return live;
}

function execution(
  config: WorkerConfig,
  identity: {
    readonly activeConfigSha256: string;
    readonly workerProcessInstanceId: string;
    readonly toolchain?: { readonly attestation: VivadoToolchainAttestationV1; readonly rawSha256: string };
    readonly backingLock?: ChildProcess;
  },
): WorkerExecution {
  const adapter = new VivadoBatchAdapter({ workspaceRoot: config.workspace_root, binary: config.vivado_binary, part: config.vivado_part, profileHash: config.toolchain_profile_hash });
  return {
    async discover(): Promise<DiscoverySnapshot> {
      let liveToolchain = identity.toolchain;
      if (config.evolution_eval_enabled === true) {
        try {
          liveToolchain = await assertCurrentVivadoToolchain(config, identity.backingLock);
        } catch {
          return { connector_id: config.connector_id, connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: config.capability_map_version, vivado_version: "unavailable", vivado_patch: "unavailable", part_catalog_hash: config.part_catalog_hash, sdk_worker_build_hash: config.sdk_worker_build_hash, active_config_sha256: identity.activeConfigSha256, worker_process_instance_id: identity.workerProcessInstanceId, vivado_toolchain_attestation_sha256: config.vivado_toolchain_attestation_sha256, live_mapping_health: "unavailable", capabilities: [], toolchain_profile_hash: config.toolchain_profile_hash, license_status: "unavailable", unsupported: ["vivado_toolchain_attestation"] };
        }
      }
      const remoteAttestation = {
        active_config_sha256: identity.activeConfigSha256,
        worker_process_instance_id: identity.workerProcessInstanceId,
        ...(liveToolchain ? { vivado_toolchain_attestation_sha256: liveToolchain.rawSha256, live_mapping_health: "healthy" as const } : {}),
      };
      try { await access(config.vivado_binary, constants.X_OK); } catch { return { connector_id: config.connector_id, connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: config.capability_map_version, vivado_version: "unavailable", vivado_patch: "unavailable", part_catalog_hash: config.part_catalog_hash, sdk_worker_build_hash: config.sdk_worker_build_hash, ...remoteAttestation, capabilities: [], toolchain_profile_hash: config.toolchain_profile_hash, license_status: "unavailable", unsupported: ["vivado_binary"] }; }
      if (config.evolution_eval_enabled === true && !liveToolchain) {
        return { connector_id: config.connector_id, connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: config.capability_map_version, vivado_version: "unavailable", vivado_patch: "unavailable", part_catalog_hash: config.part_catalog_hash, sdk_worker_build_hash: config.sdk_worker_build_hash, ...remoteAttestation, capabilities: [], toolchain_profile_hash: config.toolchain_profile_hash, license_status: "unavailable", unsupported: ["vivado_toolchain_attestation"] };
      }
      const facts = liveToolchain?.attestation.vivado;
      return { connector_id: config.connector_id, connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: config.capability_map_version, vivado_version: facts?.version ?? "2021.1", vivado_patch: facts?.sw_build ?? "3247384", part_catalog_hash: facts?.part_catalog_sha256 ?? config.part_catalog_hash, sdk_worker_build_hash: config.sdk_worker_build_hash, ...remoteAttestation, capabilities: DISCOVERY_CAPABILITIES, toolchain_profile_hash: liveToolchain?.attestation.toolchain_profile.derived_sha256 ?? config.toolchain_profile_hash, license_status: facts?.license.status === "passed" || !liveToolchain ? "available" : "unavailable" };
    },
    async execute(request: JobRequest, _workspace: string): Promise<WorkerExecutionResult> {
      const candidate = (request as JobRequest & { parameters?: unknown }).parameters;
      if (!candidate || typeof candidate !== "object") return { outcome: "failure", error_code: "VIVADO_PARAMETERS_REQUIRED", output: JSON.stringify({ status: "rejected", errorCode: "VIVADO_PARAMETERS_REQUIRED" }), evidence: { jobId: request.jobId ?? "worker", entries: [] } };
      if (!workerRequestBindingMatches(request, candidate, config.toolchain_profile_hash, { vivadoBinary: config.vivado_binary, part: config.vivado_part })) {
        const jobId = request.jobId ?? "worker";
        return { outcome: "failure", error_code: "FORMAL_BINDING_MISMATCH", output: JSON.stringify({ status: "rejected", jobId, errorCode: "FORMAL_BINDING_MISMATCH" }), evidence: { jobId, entries: [] } };
      }
      const vivadoRequest = {
        ...candidate as VivadoRequest,
        toolchain: {
          requiredLicense: (candidate as VivadoRequest).toolchain?.requiredLicense,
          vivadoBinary: config.vivado_binary,
          part: config.vivado_part,
          profileHash: config.toolchain_profile_hash,
        },
      } as VivadoRequest;
      let result;
      try {
        result = await adapter.execute(vivadoRequest);
      } catch (error) {
        const message = error instanceof Error ? error.message : "VIVADO_EXECUTION_ERROR";
        const errorCode = message.startsWith("VIVADO_POLICY_REJECTED:") ? message : "VIVADO_EXECUTION_ERROR";
        const jobId = request.jobId ?? "worker";
        return { outcome: "failure", error_code: errorCode, output: JSON.stringify({ status: "rejected", jobId, errorCode }), evidence: { jobId, entries: [] } };
      }
      const outcome = result.status === "succeeded" ? "success" : result.status === "timeout" ? "timeout" : result.status === "lost" ? "lost" : result.status === "unknown_effect" ? "unknown_effect" : "failure";
      const meta: Record<string, unknown> = { jobId: result.jobId, operation: result.operation, status: result.status, command: result.command, inputSha256: result.inputSha256, workspace: result.workspace, toolchain: result.toolchain };
      if (result.exitCode !== undefined) meta.exitCode = result.exitCode;
      if (result.phase !== undefined) meta.phase = result.phase;
      if (result.phaseExitCode !== undefined) meta.phaseExitCode = result.phaseExitCode;
      if (result.simulatorStdout !== undefined) meta.simulatorStdout = result.simulatorStdout;
      if (result.logDigest !== undefined) meta.logDigest = result.logDigest;
      if (result.stdout !== undefined) meta.stdout = result.stdout;
      if (result.stderr !== undefined) meta.stderr = result.stderr;
      if (result.errorCode !== undefined) meta.errorCode = result.errorCode;
      if (result.timeoutMs !== undefined) meta.timeoutMs = result.timeoutMs;
      if (result.timedOut !== undefined) meta.timedOut = result.timedOut;
      if (result.signal !== undefined) meta.signal = result.signal;
      if (result.unsupportedReason !== undefined) meta.unsupportedReason = result.unsupportedReason;
      if (result.output && typeof result.output === "object") { const o = result.output as { stdout?: unknown; stderr?: unknown }; if (o.stdout !== undefined) meta.output = o; }
      const errorCode = result.errorCode ?? (result.status === "unsupported" ? (result.unsupportedReason ?? "VIVADO_UNSUPPORTED") : undefined);
      return { outcome, error_code: errorCode, output: JSON.stringify(meta, null, 2), evidence: result.evidence, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

export async function startWorker(configPath?: string): Promise<{ server: Server; config: WorkerConfig }> {
  const resolvedConfigPath = configPath ?? process.env.SYNTHIA_WORKER_CONFIG ?? "D:/synthia-worker/config.json";
  const loaded = await loadExecutionConfig(resolvedConfigPath, true);
  const config = loaded.config;
  const workerProcessInstanceId = randomUUID();
  if (process.env.SYNTHIA_WORKER_VERIFY_BUNDLE === "1") {
    await verifyConfiguredBundleIdentity(config, process.argv[1] ?? "");
  }
  const privateKey = config.server_private_key_path.toLowerCase().endsWith(".pfx") || config.server_private_key_path.toLowerCase().endsWith(".p12");
  const tls = privateKey ? { pfx: await readFile(config.server_private_key_path), passphrase: required(process.env.SYNTHIA_WORKER_PFX_PASSWORD, "SYNTHIA_WORKER_PFX_PASSWORD"), ca: await readFile(config.trusted_client_ca_path), requestCert: true, rejectUnauthorized: true } : { cert: await readFile(config.server_certificate_path), key: await readFile(config.server_private_key_path), ca: await readFile(config.trusted_client_ca_path), requestCert: true, rejectUnauthorized: true };
  let backingLock: ChildProcess | undefined;
  backingLock = loaded.toolchain ? await holdProtectedVhdxBacking(loaded.toolchain.attestation) : undefined;
  try {
    if (loaded.toolchain) {
      await pingToolchainCeremonyLock(config, loaded.toolchain.attestation);
      await acknowledgeToolchainLockHandoff(config, loaded.toolchain.attestation, workerProcessInstanceId);
    }
  } catch (error) {
    backingLock?.kill();
    throw error;
  }
  const options: WorkerRuntimeOptions = {
    endpoint: config,
    workspaceRoot: config.workspace_root,
    execution: execution(config, {
      activeConfigSha256: loaded.sha256,
      workerProcessInstanceId,
      toolchain: loaded.toolchain,
      backingLock,
    }),
  };
  const runtime = new WorkerRuntime(options);
  const handler = runtime.handle.bind(runtime);
  const server = createServer(tls, async (req, res) => {
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      received += bytes.byteLength;
      chunks.push(bytes);
    }
    const request = new Request(`https://${req.headers.host ?? `${config.listen_host}:${config.listen_port}`}${req.url ?? "/"}`, { method: req.method, headers: Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"), body: chunks.length ? Buffer.concat(chunks) : undefined });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.listen_port, config.listen_host, resolve); });
  } catch (error) {
    backingLock?.kill();
    throw error;
  }
  return { server, config };
}

if (import.meta.main) {
  const [command, configPath, outputPath] = process.argv.slice(2);
  const run = command === "--verify-release-manifest"
      ? verifyWorkerReleaseManifest(configPath ?? "")
          .then((hash) => console.log(`synthia-worker release manifest verified hash=${hash}`))
    : command === "--verify-vivado-toolchain-attestation"
      ? verifyVivadoToolchainAttestationFromConfig(configPath ?? process.env.SYNTHIA_WORKER_CONFIG ?? "")
          .then((hash) => console.log(`synthia-worker Vivado toolchain attestation verified raw_sha256=${hash}`))
    : command === "--verify-vivado-toolchain-attestation-file"
      ? loadVivadoToolchainAttestation(required(configPath, "toolchain_attestation_path"), required(outputPath, "toolchain_attestation_sha256"))
          .then(({ attestation }) => console.log(`synthia-worker Vivado toolchain attestation verified canonical_sha256=${attestation.canonical_attestation_sha256}`))
    : command === "--build-vivado-full-tree-manifest"
      ? buildFullTreeManifest(required(configPath, "full_tree_root"))
          .then(async (manifest) => {
            await writeFile(required(outputPath, "full_tree_output"), `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
            console.log(`synthia-worker Vivado full-tree manifest built hash=${manifest.canonical_sha256}`);
          })
    : command === "--finalize-vivado-toolchain-attestation"
      ? readFile(required(configPath, "toolchain_attestation_draft"), "utf8")
          .then((bytes) => finalizeVivadoToolchainAttestation(JSON.parse(bytes)))
          .then(async (attestation) => {
            await writeFile(required(outputPath, "toolchain_attestation_output"), `${JSON.stringify(attestation)}\n`, { flag: "wx", mode: 0o600 });
            console.log(`synthia-worker Vivado toolchain attestation finalized canonical_sha256=${attestation.canonical_attestation_sha256}`);
          })
    : command === undefined
      ? startWorker().then(({ config }) => console.log(`synthia-worker listening on ${config.listen_host}:${config.listen_port} connector=${config.connector_id}`))
      : Promise.reject(new Error("CONFIG_INVALID:command"));
  run.catch(error => { console.error(`synthia-worker failed: ${error instanceof Error ? error.message : "startup"}`); process.exitCode = 1; });
}
