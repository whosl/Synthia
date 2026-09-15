import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";

export const JUMP_HOST = "Administrator@100.66.198.60";
export const JUMP_COMPUTER = "DESKTOP-E380LR7";
export const JUMP_IDENTITY_NAME = "desktop-e380lr7\\administrator";
export const JUMP_IDENTITY_SID = "S-1-5-21-3442870711-319385569-2277832987-500";
export const MASTER_PID = 87062;
export const MASTER_SOCKET = "/private/tmp/synthia-m4f-jump.sock";
export const KNOWN_HOSTS_PATH = "/Users/wenzhuolin/.ssh/known_hosts";
export const SSH_PATH = "/usr/bin/ssh";
export const SCP_PATH = "/usr/bin/scp";

const EXPECTED_HOST = "100.66.198.60";
const EXPECTED_HOST_KEY_ALGORITHM = "ssh-ed25519";
const EXPECTED_HOST_KEY_FINGERPRINT = "SHA256:I37M/4mZJwdlChfZyay+GSbhTuRKEQthOZW7sHmugh8";
const EXPECTED_MASTER_EFFECTIVE_CONFIG_SHA256 = "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
const EXPECTED_CHILD_EFFECTIVE_CONFIG_SHA256 = "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
const EXPECTED_MASTER_LOCAL_ADDRESS = "100.123.31.75";
const EXPECTED_MASTER_REMOTE_ADDRESS = "100.66.198.60";
const EXPECTED_MASTER_COMMAND = "ssh -N -M -S /private/tmp/synthia-m4f-jump.sock -o ControlMaster=yes -o ControlPersist=45m -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes -o ForwardAgent=no Administrator@100.66.198.60";
const SSH_TIMEOUT_MS = 90_000;
const SCP_TIMEOUT_MS = 120_000;
const AUDIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 8 * 1024 * 1024;
export const MAX_BOUND_JUMP_ARTIFACT_BYTES = 1_048_576;
export const MAX_BOUND_JUMP_RECEIVER_STDIN_BYTES = 2_000_000;
export const MAX_BOUND_JUMP_RECEIVER_COMMAND_LENGTH = 8_192;
export const BOUND_JUMP_RECEIVER_SOURCE_LENGTH = 1_220;
export const BOUND_JUMP_RECEIVER_SOURCE_SHA256 = "bdb544d7befe5dc6e162c7bcf98e314096b8ffa4e331c12a0b75248d05ad1e00";
export const BOUND_JUMP_RECEIVER_ENCODED_LENGTH = 3_256;
export const BOUND_JUMP_RECEIVER_ENCODED_SHA256 = "ec4bb477e8e7bd0c08551837b21ad90e06aaa3bab11e95b44cef5dee0b6a22bb";

const NO_AUTH_FALLBACK_OPTIONS = [
  "-o", `ControlPath=${MASTER_SOCKET}`,
  "-o", "ControlMaster=no",
  "-o", "ControlPersist=no",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-o", "ConnectionAttempts=1",
  "-o", "ServerAliveInterval=10",
  "-o", "ServerAliveCountMax=2",
  "-o", "NumberOfPasswordPrompts=0",
  "-o", "IdentityAgent=none",
  "-o", "IdentityFile=/dev/null",
  "-o", "IdentitiesOnly=yes",
  "-o", "PubkeyAuthentication=no",
  "-o", "PasswordAuthentication=no",
  "-o", "KbdInteractiveAuthentication=no",
  "-o", "GSSAPIAuthentication=no",
  "-o", "HostbasedAuthentication=no",
  "-o", "PreferredAuthentications=none",
  "-o", "StrictHostKeyChecking=yes",
  "-o", `UserKnownHostsFile=${KNOWN_HOSTS_PATH}`,
  "-o", "GlobalKnownHostsFile=/dev/null",
  "-o", "ForwardAgent=no",
  "-o", "ClearAllForwardings=yes",
  "-o", "PermitLocalCommand=no",
  "-o", "ProxyCommand=none",
  "-o", "ProxyJump=none",
] as const;

const MASTER_EFFECTIVE_CONFIG_OPTIONS = [
  "-N",
  "-M",
  "-S", MASTER_SOCKET,
  "-o", "ControlMaster=yes",
  "-o", "ControlPersist=45m",
  "-o", "PubkeyAuthentication=no",
  "-o", "PreferredAuthentications=password",
  "-o", "NumberOfPasswordPrompts=1",
  "-o", "ServerAliveInterval=20",
  "-o", "ServerAliveCountMax=3",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "ForwardAgent=no",
] as const;

export interface PathFacts {
  isSocket: boolean;
  isSymbolicLink: boolean;
  isRegularFile: boolean;
  uid: number;
  mode: number;
}

export interface RawProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  errorCode: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface BoundJumpRuntime {
  uid(): number;
  pathFacts(path: string): PathFacts;
  readText(path: string): string;
  sha256(bytes: Uint8Array): string;
  spawn(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
    maxBuffer: number,
    stdin?: Uint8Array,
  ): RawProcessResult;
}

export interface ProcessObservation {
  exit_status: number | null;
  signal: NodeJS.Signals | null;
  error_code: string | null;
  stdout_base64: string;
  stderr_base64: string;
  timed_out: boolean;
  outcome_ambiguous: boolean;
  retry_permitted: false;
}

export interface MasterAuditEvidence {
  schema: "synthia-m4f-bound-master-audit.v1";
  master_pid: number;
  master_socket: string;
  known_hosts_path: string;
  host_key_fingerprint: string;
  ssh_executable: string;
  master_effective_config_sha256: string;
  child_effective_config_sha256: string;
  network_sha256: string;
  network_process: ProcessObservation;
  network_connection: {
    fd: number;
    protocol: "TCP";
    local_address: string;
    local_port: number;
    remote_address: string;
    remote_port: 22;
    state: "ESTABLISHED";
  };
}

export interface BoundJumpPhaseResult {
  schema: "synthia-m4f-bound-phase.v1";
  phase: string;
  identity: Record<string, unknown>;
  payload: Record<string, unknown>;
  process: ProcessObservation;
  input: BoundJumpPhaseInputEvidence;
  master_before: MasterAuditEvidence;
  master_after: MasterAuditEvidence;
}

export interface BoundJumpPhaseInputEvidence {
  artifact_length: number;
  artifact_sha256: string;
  stdin_length: number;
  stdin_sha256: string;
  receiver_source_length: number;
  receiver_source_sha256: string;
  receiver_encoded_length: number;
  receiver_encoded_sha256: string;
  receiver_command_length: number;
  receiver_command_maximum: number;
}

export interface BoundJumpCopyResult {
  schema: "synthia-m4f-bound-copy.v1";
  status: "passed";
  remote_directory: string;
  source_count: number;
  process: ProcessObservation;
  master_before: MasterAuditEvidence;
  master_after: MasterAuditEvidence;
  identity_before: BoundJumpPhaseResult;
  identity_after: BoundJumpPhaseResult;
}

export class CeremonyFailure extends Error {
  readonly detail: Record<string, unknown>;

  constructor(detail: Record<string, unknown>) {
    super(typeof detail.code === "string" ? detail.code : "M4F_CEREMONY_FAILURE");
    this.name = "CeremonyFailure";
    this.detail = detail;
  }
}

function defaultPathFacts(path: string): PathFacts {
  const facts = lstatSync(path);
  return {
    isSocket: facts.isSocket(),
    isSymbolicLink: facts.isSymbolicLink(),
    isRegularFile: facts.isFile(),
    uid: facts.uid,
    mode: facts.mode & 0o777,
  };
}

const defaultRuntime: BoundJumpRuntime = {
  uid: () => process.getuid?.() ?? -1,
  pathFacts: defaultPathFacts,
  readText: (path) => readFileSync(path, "utf8"),
  sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
  spawn: (executable, args, timeoutMs, maxBuffer, stdin) => {
    const result = spawnSync(executable, [...args], {
      encoding: "buffer",
      maxBuffer,
      timeout: timeoutMs,
      windowsHide: true,
      input: stdin,
    });
    return {
      status: result.status,
      signal: result.signal,
      errorCode: result.error && "code" in result.error && typeof result.error.code === "string"
        ? result.error.code
        : null,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: result.stderr ?? Buffer.alloc(0),
    };
  },
};

function utf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

function processObservation(raw: RawProcessResult, forceAmbiguous = false): ProcessObservation {
  const timedOut = raw.errorCode === "ETIMEDOUT";
  const ambiguous = forceAmbiguous
    || timedOut
    || raw.signal !== null
    || raw.errorCode === "ENOBUFS";
  return {
    exit_status: raw.status,
    signal: raw.signal,
    error_code: raw.errorCode,
    stdout_base64: Buffer.from(raw.stdout).toString("base64"),
    stderr_base64: Buffer.from(raw.stderr).toString("base64"),
    timed_out: timedOut,
    outcome_ambiguous: ambiguous,
    retry_permitted: false,
  };
}

function transportFailure(code: string, extra: Record<string, unknown> = {}): never {
  throw new CeremonyFailure({
    schema: "synthia-m4f-bound-transport-failure.v1",
    code,
    ...extra,
  });
}

function requireSuccessfulLocalProcess(
  raw: RawProcessResult,
  code: string,
  operation: string,
): string {
  if (raw.status !== 0 || raw.signal !== null || raw.errorCode !== null || raw.stderr.length !== 0) {
    transportFailure(code, {
      operation,
      process: processObservation(raw),
    });
  }
  return utf8(raw.stdout);
}

function auditKnownHosts(runtime: BoundJumpRuntime, uid: number): void {
  let facts: PathFacts;
  try {
    facts = runtime.pathFacts(KNOWN_HOSTS_PATH);
  } catch (error) {
    transportFailure("M4F_BOUND_KNOWN_HOSTS_AUDIT_FAILED", { reason: String(error) });
  }
  if (!facts.isRegularFile
    || facts.isSymbolicLink
    || facts.uid !== uid
    || (facts.mode & 0o022) !== 0) {
    transportFailure("M4F_BOUND_KNOWN_HOSTS_AUDIT_FAILED", {
      path: KNOWN_HOSTS_PATH,
      facts,
    });
  }

  let contents: string;
  try {
    contents = runtime.readText(KNOWN_HOSTS_PATH);
  } catch (error) {
    transportFailure("M4F_BOUND_KNOWN_HOSTS_AUDIT_FAILED", { reason: String(error) });
  }
  const entries = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split(/\s+/u))
    .filter((fields) => fields[0]?.split(",").includes(EXPECTED_HOST));
  if (entries.length !== 1) {
    transportFailure("M4F_BOUND_HOST_KEY_COUNT_INVALID", { count: entries.length });
  }
  const entry = entries[0];
  const algorithm = entry?.[1];
  const encodedKey = entry?.[2];
  if (algorithm !== EXPECTED_HOST_KEY_ALGORITHM || typeof encodedKey !== "string") {
    transportFailure("M4F_BOUND_HOST_KEY_INVALID", { algorithm });
  }
  let fingerprint: string;
  try {
    fingerprint = `SHA256:${createHash("sha256")
      .update(Buffer.from(encodedKey, "base64"))
      .digest("base64")
      .replace(/=+$/u, "")}`;
  } catch (error) {
    transportFailure("M4F_BOUND_HOST_KEY_INVALID", { reason: String(error) });
  }
  if (fingerprint !== EXPECTED_HOST_KEY_FINGERPRINT) {
    transportFailure("M4F_BOUND_HOST_KEY_INVALID", { fingerprint });
  }
}

function auditEffectiveSshConfig(
  runtime: BoundJumpRuntime,
  kind: "master" | "child",
): string {
  const options = kind === "master"
    ? MASTER_EFFECTIVE_CONFIG_OPTIONS
    : NO_AUTH_FALLBACK_OPTIONS;
  const effective = runtime.spawn(SSH_PATH, [
    "-G",
    "-T",
    ...options,
    JUMP_HOST,
  ], AUDIT_TIMEOUT_MS, MAX_BUFFER);
  const output = requireSuccessfulLocalProcess(
    effective,
    "M4F_BOUND_EFFECTIVE_CONFIG_AUDIT_FAILED",
    "ssh-effective-config",
  );
  const selected = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf(" ");
    if (separator <= 0 || separator === line.length - 1 || line !== line.trim()) {
      transportFailure("M4F_BOUND_EFFECTIVE_CONFIG_AUDIT_FAILED", {
        reason: "invalid-config-framing",
        process: processObservation(effective),
      });
    }
    const key = line.slice(0, separator).toLowerCase();
    if ([
      "host",
      "hostname",
      "user",
      "controlpath",
      "controlmaster",
      "controlpersist",
      "localcommand",
      "proxycommand",
      "proxyjump",
      "forwardagent",
      "clearallforwardings",
      "permitlocalcommand",
      "localforward",
      "remoteforward",
      "dynamicforward",
    ].includes(key)) {
      const values = selected.get(key) ?? [];
      values.push(line.slice(separator + 1));
      selected.set(key, values);
    }
  }
  const singleton = (key: string, expected: string): void => {
    const values = selected.get(key) ?? [];
    if (values.length !== 1 || values[0] !== expected) {
      transportFailure("M4F_BOUND_EFFECTIVE_CONFIG_AUDIT_FAILED", {
        key,
        expected,
        actual: values,
        process: processObservation(effective),
      });
    }
  };
  singleton("host", EXPECTED_HOST);
  singleton("hostname", EXPECTED_HOST);
  singleton("user", "Administrator");
  singleton("controlpath", MASTER_SOCKET);
  singleton("forwardagent", "no");
  singleton("controlmaster", kind === "master" ? "true" : "false");
  singleton("controlpersist", kind === "master" ? "2700" : "no");
  singleton("clearallforwardings", kind === "master" ? "no" : "yes");
  singleton("permitlocalcommand", "no");
  for (const absent of [
    "localcommand",
    "proxycommand",
    "proxyjump",
    "localforward",
    "remoteforward",
    "dynamicforward",
  ]) {
    if ((selected.get(absent) ?? []).length !== 0) {
      transportFailure("M4F_BOUND_EFFECTIVE_CONFIG_AUDIT_FAILED", {
        key: absent,
        expected: [],
        actual: selected.get(absent),
        process: processObservation(effective),
      });
    }
  }
  const actualSha256 = runtime.sha256(effective.stdout);
  const expectedSha256 = kind === "master"
    ? EXPECTED_MASTER_EFFECTIVE_CONFIG_SHA256
    : EXPECTED_CHILD_EFFECTIVE_CONFIG_SHA256;
  if (actualSha256 !== expectedSha256) {
    transportFailure("M4F_BOUND_EFFECTIVE_CONFIG_HASH_MISMATCH", {
      kind,
      expected_sha256: expectedSha256,
      actual_sha256: actualSha256,
      process: processObservation(effective),
    });
  }
  return actualSha256;
}

function auditMasterNetwork(runtime: BoundJumpRuntime): {
  sha256: string;
  process: ProcessObservation;
  connection: MasterAuditEvidence["network_connection"];
} {
  const network = runtime.spawn("/usr/sbin/lsof", [
    "-nP",
    "-a",
    "-p", String(MASTER_PID),
    "-iTCP",
    "-FpcfPtTn",
  ], AUDIT_TIMEOUT_MS, MAX_BUFFER);
  const output = requireSuccessfulLocalProcess(
    network,
    "M4F_BOUND_MASTER_NETWORK_AUDIT_FAILED",
    "lsof-network",
  );
  const match = output.match(
    /^p87062\ncssh\nf(\d+)\ntIPv4\nPTCP\nn100\.123\.31\.75:(\d+)->100\.66\.198\.60:22\nTST=ESTABLISHED\nTQR=(\d+)\nTQS=(\d+)\n$/u,
  );
  const fd = Number(match?.[1]);
  const localPort = Number(match?.[2]);
  if (!match
    || !Number.isSafeInteger(fd)
    || fd < 0
    || !Number.isSafeInteger(localPort)
    || localPort < 49_152
    || localPort > 65_535) {
    transportFailure("M4F_BOUND_MASTER_NETWORK_AUDIT_FAILED", {
      expected_local_address: EXPECTED_MASTER_LOCAL_ADDRESS,
      expected_remote: `${EXPECTED_MASTER_REMOTE_ADDRESS}:22`,
      process: processObservation(network),
    });
  }
  return {
    sha256: runtime.sha256(network.stdout),
    process: processObservation(network),
    connection: {
      fd,
      protocol: "TCP",
      local_address: EXPECTED_MASTER_LOCAL_ADDRESS,
      local_port: localPort,
      remote_address: EXPECTED_MASTER_REMOTE_ADDRESS,
      remote_port: 22,
      state: "ESTABLISHED",
    },
  };
}

function auditMaster(runtime: BoundJumpRuntime): MasterAuditEvidence {
  const uid = runtime.uid();
  let socket: PathFacts;
  try {
    socket = runtime.pathFacts(MASTER_SOCKET);
  } catch (error) {
    transportFailure("M4F_BOUND_MASTER_SOCKET_AUDIT_FAILED", { reason: String(error) });
  }
  if (!socket.isSocket
    || socket.isSymbolicLink
    || socket.uid !== uid
    || socket.mode !== 0o600) {
    transportFailure("M4F_BOUND_MASTER_SOCKET_AUDIT_FAILED", { socket });
  }
  auditKnownHosts(runtime, uid);
  const masterEffectiveConfigSha256 = auditEffectiveSshConfig(runtime, "master");
  const childEffectiveConfigSha256 = auditEffectiveSshConfig(runtime, "child");

  const check = runtime.spawn(SSH_PATH, [
    "-S", MASTER_SOCKET,
    "-o", "BatchMode=yes",
    "-o", "IdentityAgent=none",
    "-o", "IdentityFile=/dev/null",
    "-o", "ClearAllForwardings=yes",
    "-O", "check",
    JUMP_HOST,
  ], AUDIT_TIMEOUT_MS, MAX_BUFFER);
  if (check.status !== 0
    || check.signal !== null
    || check.errorCode !== null
    || check.stdout.length !== 0
    || !Buffer.from(check.stderr).equals(Buffer.from("Master running (pid=87062)\r\n", "utf8"))) {
    transportFailure("M4F_BOUND_MASTER_CHECK_FAILED", {
      operation: "control-check",
      process: processObservation(check),
    });
  }

  const ps = runtime.spawn("/bin/ps", ["-ww", "-o", "uid=", "-o", "command=", "-p", String(MASTER_PID)], AUDIT_TIMEOUT_MS, MAX_BUFFER);
  const psLine = requireSuccessfulLocalProcess(ps, "M4F_BOUND_MASTER_PROCESS_AUDIT_FAILED", "ps").trim();
  const match = psLine.match(/^(\d+)\s+(.+)$/u);
  if (!match || Number(match[1]) !== uid || match[2] !== EXPECTED_MASTER_COMMAND) {
    transportFailure("M4F_BOUND_MASTER_PROCESS_AUDIT_FAILED", {
      process_line_base64: Buffer.from(psLine).toString("base64"),
      process: processObservation(ps),
    });
  }

  const lsof = runtime.spawn("/usr/sbin/lsof", ["-a", "-p", String(MASTER_PID), "-d", "txt", "-Fn"], AUDIT_TIMEOUT_MS, MAX_BUFFER);
  const textPaths = requireSuccessfulLocalProcess(lsof, "M4F_BOUND_MASTER_EXECUTABLE_AUDIT_FAILED", "lsof")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
  const sshExecutables = textPaths.filter((path) => path === SSH_PATH || /(^|\/)ssh$/u.test(path));
  if (sshExecutables.length !== 1 || sshExecutables[0] !== SSH_PATH) {
    transportFailure("M4F_BOUND_MASTER_EXECUTABLE_AUDIT_FAILED", {
      text_paths: textPaths,
      ssh_executables: sshExecutables,
      process: processObservation(lsof),
    });
  }
  const network = auditMasterNetwork(runtime);

  return {
    schema: "synthia-m4f-bound-master-audit.v1",
    master_pid: MASTER_PID,
    master_socket: MASTER_SOCKET,
    known_hosts_path: KNOWN_HOSTS_PATH,
    host_key_fingerprint: EXPECTED_HOST_KEY_FINGERPRINT,
    ssh_executable: SSH_PATH,
    master_effective_config_sha256: masterEffectiveConfigSha256,
    child_effective_config_sha256: childEffectiveConfigSha256,
    network_sha256: network.sha256,
    network_process: network.process,
    network_connection: network.connection,
  };
}

function powershellEncodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export const BOUND_JUMP_RECEIVER_SOURCE = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$encodedArtifact = [Console]::In.ReadToEnd()
if ($encodedArtifact.Length -lt 2 -or
  $encodedArtifact.Length -gt 2000000 -or
  -not [Text.RegularExpressions.Regex]::IsMatch(
    $encodedArtifact,
    '\A(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\n\z',
    [Text.RegularExpressions.RegexOptions]::CultureInvariant
  )) {
  throw "M4F_BOUND_RECEIVER_STDIN_INVALID"
}
$artifactBytes = [Convert]::FromBase64String(
  $encodedArtifact.Substring(0, $encodedArtifact.Length - 1)
)
if ($artifactBytes.Length -gt 1048576 -or
  (([Convert]::ToBase64String($artifactBytes) + [char]10) -cne $encodedArtifact)) {
  throw "M4F_BOUND_RECEIVER_ARTIFACT_INVALID"
}
$artifactSource = [Text.UTF8Encoding]::new($false, $true).GetString($artifactBytes)
$artifactScriptBlock = [ScriptBlock]::Create($artifactSource)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
[Console]::Out.WriteLine(([ordered]@{
  schema = "synthia-m4f-jump-identity.v1"
  computer_name = [Environment]::MachineName
  identity_name = $identity.Name.ToLowerInvariant()
  identity_sid = $identity.User.Value
} | ConvertTo-Json -Compress))
& $artifactScriptBlock
`;

export const BOUND_JUMP_RECEIVER_ENCODED = powershellEncodedCommand(BOUND_JUMP_RECEIVER_SOURCE);
const BOUND_JUMP_RECEIVER_ARGUMENTS = [
  "powershell.exe",
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
  BOUND_JUMP_RECEIVER_ENCODED,
] as const;
export const BOUND_JUMP_RECEIVER_COMMAND_LENGTH = BOUND_JUMP_RECEIVER_ARGUMENTS.join(" ").length;
const receiverSourceBytes = Buffer.from(BOUND_JUMP_RECEIVER_SOURCE, "utf8");
const receiverEncodedBytes = Buffer.from(BOUND_JUMP_RECEIVER_ENCODED, "ascii");
if (receiverSourceBytes.length !== BOUND_JUMP_RECEIVER_SOURCE_LENGTH
  || exactSha256(receiverSourceBytes) !== BOUND_JUMP_RECEIVER_SOURCE_SHA256
  || receiverEncodedBytes.length !== BOUND_JUMP_RECEIVER_ENCODED_LENGTH
  || exactSha256(receiverEncodedBytes) !== BOUND_JUMP_RECEIVER_ENCODED_SHA256
  || BOUND_JUMP_RECEIVER_COMMAND_LENGTH !== 3_346
  || BOUND_JUMP_RECEIVER_COMMAND_LENGTH >= MAX_BOUND_JUMP_RECEIVER_COMMAND_LENGTH) {
  throw new Error("M4F_BOUND_RECEIVER_COMMAND_TOO_LONG");
}

function exactSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalizeBoundJumpIdentityName(identityName: string): string {
  if (!/^[A-Za-z0-9._-]+\\[A-Za-z0-9._-]+$/u.test(identityName)) {
    throw new Error("M4F_BOUND_REMOTE_IDENTITY_NAME_INVALID");
  }
  return identityName.toLowerCase();
}

export function decodeBoundJumpReceiverInput(stdin: Uint8Array): Buffer {
  if (stdin.length < 2 || stdin.length > MAX_BOUND_JUMP_RECEIVER_STDIN_BYTES) {
    throw new Error("M4F_BOUND_RECEIVER_STDIN_INVALID");
  }
  const encoded = Buffer.from(stdin).toString("ascii");
  if (!Buffer.from(encoded, "ascii").equals(Buffer.from(stdin))
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\n$/u.test(encoded)) {
    throw new Error("M4F_BOUND_RECEIVER_STDIN_INVALID");
  }
  const artifact = Buffer.from(encoded.slice(0, -1), "base64");
  if (artifact.length > MAX_BOUND_JUMP_ARTIFACT_BYTES
    || `${artifact.toString("base64")}\n` !== encoded) {
    throw new Error("M4F_BOUND_RECEIVER_ARTIFACT_INVALID");
  }
  const decoded = artifact.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(artifact)) {
    throw new Error("M4F_BOUND_RECEIVER_ARTIFACT_UTF8_INVALID");
  }
  return artifact;
}

export function buildBoundJumpPhaseInput(script: string): {
  stdin: Buffer;
  evidence: BoundJumpPhaseInputEvidence;
} {
  const artifact = Buffer.from(script, "utf8");
  if (artifact.length > MAX_BOUND_JUMP_ARTIFACT_BYTES) {
    transportFailure("M4F_BOUND_PHASE_ARTIFACT_TOO_LARGE", {
      artifact_length: artifact.length,
      artifact_sha256: exactSha256(artifact),
      maximum: MAX_BOUND_JUMP_ARTIFACT_BYTES,
    });
  }
  const stdin = Buffer.from(`${artifact.toString("base64")}\n`, "ascii");
  decodeBoundJumpReceiverInput(stdin);
  if (receiverSourceBytes.length !== BOUND_JUMP_RECEIVER_SOURCE_LENGTH
    || exactSha256(receiverSourceBytes) !== BOUND_JUMP_RECEIVER_SOURCE_SHA256
    || receiverEncodedBytes.length !== BOUND_JUMP_RECEIVER_ENCODED_LENGTH
    || exactSha256(receiverEncodedBytes) !== BOUND_JUMP_RECEIVER_ENCODED_SHA256) {
    transportFailure("M4F_BOUND_RECEIVER_IDENTITY_DRIFT");
  }
  return {
    stdin,
    evidence: {
      artifact_length: artifact.length,
      artifact_sha256: exactSha256(artifact),
      stdin_length: stdin.length,
      stdin_sha256: exactSha256(stdin),
      receiver_source_length: BOUND_JUMP_RECEIVER_SOURCE_LENGTH,
      receiver_source_sha256: BOUND_JUMP_RECEIVER_SOURCE_SHA256,
      receiver_encoded_length: BOUND_JUMP_RECEIVER_ENCODED_LENGTH,
      receiver_encoded_sha256: BOUND_JUMP_RECEIVER_ENCODED_SHA256,
      receiver_command_length: BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
      receiver_command_maximum: MAX_BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
    },
  };
}

function parseRemoteOutput(
  raw: RawProcessResult,
  phase: string,
  input: BoundJumpPhaseInputEvidence,
): {
  identity: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const output = utf8(raw.stdout);
  const framed = output.match(/^([^\r\n]+)\r?\n([^\r\n]+)\r?\n$/u);
  const identityLine = framed?.[1];
  const payloadLine = framed?.[2];
  if (typeof identityLine !== "string"
    || typeof payloadLine !== "string"
    || identityLine !== identityLine.trim()
    || payloadLine !== payloadLine.trim()
    || !identityLine.startsWith("{")
    || !identityLine.endsWith("}")
    || !payloadLine.startsWith("{")
    || !payloadLine.endsWith("}")) {
    transportFailure("M4F_BOUND_PHASE_OUTPUT_INVALID", {
      phase,
      process: processObservation(raw),
      input,
    });
  }
  let identity: unknown;
  let payload: unknown;
  try {
    identity = JSON.parse(identityLine);
    payload = JSON.parse(payloadLine);
  } catch (error) {
    transportFailure("M4F_BOUND_PHASE_OUTPUT_INVALID", {
      phase,
      reason: String(error),
      process: processObservation(raw),
      input,
    });
  }
  if (!identity || typeof identity !== "object" || Array.isArray(identity)
    || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    transportFailure("M4F_BOUND_PHASE_OUTPUT_INVALID", {
      phase,
      process: processObservation(raw),
      input,
    });
  }
  const identityRecord = identity as Record<string, unknown>;
  if (Object.keys(identityRecord).sort().join("|") !== "computer_name|identity_name|identity_sid|schema"
    || identityRecord.schema !== "synthia-m4f-jump-identity.v1"
    || identityRecord.computer_name !== JUMP_COMPUTER
    || identityRecord.identity_name !== JUMP_IDENTITY_NAME
    || identityRecord.identity_sid !== JUMP_IDENTITY_SID) {
    transportFailure("M4F_BOUND_REMOTE_IDENTITY_MISMATCH", {
      phase,
      identity: identityRecord,
      process: processObservation(raw),
      input,
    });
  }
  return {
    identity: identityRecord,
    payload: payload as Record<string, unknown>,
  };
}

function ambiguousPhaseFailure(
  phase: string,
  raw: RawProcessResult,
  reason: string,
  input: BoundJumpPhaseInputEvidence,
  extra: Record<string, unknown> = {},
): never {
  transportFailure("M4F_BOUND_PHASE_OUTCOME_AMBIGUOUS", {
    phase,
    reason,
    process: processObservation(raw, true),
    input,
    ...extra,
  });
}

export function createBoundJumpTransport(runtime: BoundJumpRuntime = defaultRuntime): {
  auditMaster(): MasterAuditEvidence;
  invokeBoundJumpPhase(phase: string, script: string): BoundJumpPhaseResult;
  copyBoundJumpFiles(localSources: readonly string[], remoteDirectory: string): BoundJumpCopyResult;
} {
  const invokePhase = (phase: string, script: string): BoundJumpPhaseResult => {
    if (!/^[a-z0-9][a-z0-9:_-]{0,127}$/u.test(phase)) {
      transportFailure("M4F_BOUND_PHASE_NAME_INVALID", { phase });
    }
    const phaseInput = buildBoundJumpPhaseInput(script);
    let masterBefore: MasterAuditEvidence;
    try {
      masterBefore = auditMaster(runtime);
    } catch (error) {
      transportFailure("M4F_BOUND_PHASE_PRE_AUDIT_FAILED", {
        phase,
        input: phaseInput.evidence,
        audit_failure: error instanceof CeremonyFailure ? error.detail : String(error),
      });
    }
    const raw = runtime.spawn(SSH_PATH, [
      "-T",
      ...NO_AUTH_FALLBACK_OPTIONS,
      JUMP_HOST,
      ...BOUND_JUMP_RECEIVER_ARGUMENTS,
    ], SSH_TIMEOUT_MS, MAX_BUFFER, phaseInput.stdin);

    let masterAfter: MasterAuditEvidence;
    try {
      masterAfter = auditMaster(runtime);
    } catch (error) {
      ambiguousPhaseFailure(phase, raw, "post-master-audit-failed", phaseInput.evidence, {
        post_audit_failure: error instanceof CeremonyFailure ? error.detail : String(error),
      });
    }
    const observation = processObservation(raw);
    if (observation.outcome_ambiguous) {
      ambiguousPhaseFailure(phase, raw, "local-termination-or-buffer-bound", phaseInput.evidence);
    }
    if (raw.status !== 0 || raw.errorCode !== null) {
      transportFailure("M4F_BOUND_PHASE_FAILED", {
        phase,
        process: observation,
        input: phaseInput.evidence,
      });
    }
    if (raw.stderr.length !== 0) {
      transportFailure("M4F_BOUND_PHASE_STDERR_NOT_EMPTY", {
        phase,
        process: observation,
        input: phaseInput.evidence,
      });
    }
    const parsed = parseRemoteOutput(raw, phase, phaseInput.evidence);
    return {
      schema: "synthia-m4f-bound-phase.v1",
      phase,
      identity: parsed.identity,
      payload: parsed.payload,
      process: observation,
      input: phaseInput.evidence,
      master_before: masterBefore,
      master_after: masterAfter,
    };
  };

  const identityProbe = (label: string): BoundJumpPhaseResult => invokePhase(label, String.raw`
[Console]::Out.WriteLine(([ordered]@{
  schema = "synthia-m4f-jump-identity-probe.v1"
  status = "passed"
} | ConvertTo-Json -Compress))
`);

  const copyFiles = (localSources: readonly string[], remoteDirectory: string): BoundJumpCopyResult => {
    if (localSources.length === 0 || localSources.some((source) => !isAbsolute(source))) {
      transportFailure("M4F_BOUND_COPY_SOURCE_INVALID", { source_count: localSources.length });
    }
    if (!/^C:\\Windows\\Temp\\synthia-m4f-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(remoteDirectory)) {
      transportFailure("M4F_BOUND_COPY_REMOTE_DIRECTORY_INVALID", { remote_directory: remoteDirectory });
    }

    const identityBefore = identityProbe("copy:identity-before");
    const masterBefore = auditMaster(runtime);
    const remoteTarget = `${JUMP_HOST}:${remoteDirectory.replaceAll("\\", "/")}/`;
    const raw = runtime.spawn(SCP_PATH, [
      ...NO_AUTH_FALLBACK_OPTIONS,
      "--",
      ...localSources,
      remoteTarget,
    ], SCP_TIMEOUT_MS, MAX_BUFFER);

    let masterAfter: MasterAuditEvidence;
    try {
      masterAfter = auditMaster(runtime);
    } catch (error) {
      transportFailure("M4F_BOUND_COPY_OUTCOME_AMBIGUOUS", {
        reason: "post-master-audit-failed",
        process: processObservation(raw, true),
        post_audit_failure: error instanceof CeremonyFailure ? error.detail : String(error),
      });
    }
    const observation = processObservation(raw);
    if (observation.outcome_ambiguous) {
      transportFailure("M4F_BOUND_COPY_OUTCOME_AMBIGUOUS", {
        reason: "local-termination-or-buffer-bound",
        process: processObservation(raw, true),
      });
    }
    if (raw.status !== 0 || raw.errorCode !== null) {
      transportFailure("M4F_BOUND_COPY_FAILED", { process: observation });
    }
    if (raw.stderr.length !== 0) {
      transportFailure("M4F_BOUND_COPY_STDERR_NOT_EMPTY", { process: observation });
    }

    let identityAfter: BoundJumpPhaseResult;
    try {
      identityAfter = identityProbe("copy:identity-after");
    } catch (error) {
      transportFailure("M4F_BOUND_COPY_OUTCOME_AMBIGUOUS", {
        reason: "post-copy-identity-verification-failed",
        process: processObservation(raw, true),
        identity_failure: error instanceof CeremonyFailure ? error.detail : String(error),
      });
    }
    return {
      schema: "synthia-m4f-bound-copy.v1",
      status: "passed",
      remote_directory: remoteDirectory,
      source_count: localSources.length,
      process: observation,
      master_before: masterBefore,
      master_after: masterAfter,
      identity_before: identityBefore,
      identity_after: identityAfter,
    };
  };

  return {
    auditMaster: () => auditMaster(runtime),
    invokeBoundJumpPhase: invokePhase,
    copyBoundJumpFiles: copyFiles,
  };
}

const defaultTransport = createBoundJumpTransport();

export const invokeBoundJumpPhase = defaultTransport.invokeBoundJumpPhase;
export const copyBoundJumpFiles = defaultTransport.copyBoundJumpFiles;
export const auditBoundJumpMaster = defaultTransport.auditMaster;

export function runCeremony(operation: () => void): void {
  try {
    operation();
  } catch (error) {
    const detail = error instanceof CeremonyFailure
      ? error.detail
      : {
        schema: "synthia-m4f-ceremony-failure.v1",
        code: "M4F_CEREMONY_UNEXPECTED_FAILURE",
        reason: String(error),
      };
    process.stderr.write(`${JSON.stringify(detail)}\n`);
    process.exitCode = 1;
  }
}
