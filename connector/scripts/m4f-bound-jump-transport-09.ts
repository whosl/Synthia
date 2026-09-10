import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  BOUND_JUMP_RECEIVER_ENCODED,
  type BoundJumpPhaseInputEvidence,
  type BoundJumpPhaseResult,
  CeremonyFailure,
  JUMP_COMPUTER,
  JUMP_HOST,
  JUMP_IDENTITY_NAME,
  JUMP_IDENTITY_SID,
  type MasterAuditEvidence,
  type ProcessObservation,
  type RawProcessResult,
  SSH_PATH,
  auditBoundJumpMaster,
  buildBoundJumpPhaseInput,
} from "./m4f-bound-jump-transport.ts";

export type BoundJumpTransportStage09 = "pre_audit" | "child_execution" | "post_audit" | "output_validation" | "unknown";
export type BoundJumpChildState09 = "not_started_proven" | "started" | "unknown";
export type BoundJumpChildOutcome09 = "not_started" | "known" | "ambiguous" | "unknown";
export type BoundJumpEffectState09 = "not_started" | "unknown";
export type BoundJumpSignal09 = "SIGABRT" | "SIGALRM" | "SIGBUS" | "SIGFPE" | "SIGHUP" | "SIGILL" | "SIGINT" | "SIGKILL" | "SIGPIPE" | "SIGQUIT" | "SIGSEGV" | "SIGTERM" | "SIGTRAP" | "OTHER";
export type BoundJumpErrorCode09 = "E2BIG" | "EACCES" | "EAGAIN" | "EMFILE" | "ENFILE" | "ENOBUFS" | "ENOENT" | "ENOMEM" | "ETIMEDOUT" | "OTHER";
export type BoundJumpUnderlyingReason09 = "local-termination-or-buffer-bound" | "post-master-audit-failed" | null;
export type BoundJumpUnexpectedType09 = "error" | "non_error" | null;
export type BoundJumpUnderlyingCode09 =
  | "M4F_BOUND_PHASE_NAME_INVALID"
  | "M4F_BOUND_PHASE_INPUT_INVALID"
  | "M4F_BOUND_PHASE_PRE_AUDIT_FAILED"
  | "M4F_BOUND_PHASE_SPAWN_SYNC_FAILED"
  | "M4F_BOUND_PHASE_POST_AUDIT_FAILED"
  | "M4F_BOUND_PHASE_OUTCOME_AMBIGUOUS"
  | "M4F_BOUND_PHASE_FAILED"
  | "M4F_BOUND_PHASE_STDERR_NOT_EMPTY"
  | "M4F_BOUND_PHASE_OUTPUT_INVALID"
  | "M4F_BOUND_UNKNOWN_FAILURE"
  | "M4F_BOUND_AUDIT_FAILED_OTHER"
  | "M4F_BOUND_EFFECTIVE_CONFIG_AUDIT_FAILED"
  | "M4F_BOUND_EFFECTIVE_CONFIG_HASH_MISMATCH"
  | "M4F_BOUND_HOST_KEY_COUNT_INVALID"
  | "M4F_BOUND_HOST_KEY_INVALID"
  | "M4F_BOUND_KNOWN_HOSTS_AUDIT_FAILED"
  | "M4F_BOUND_MASTER_CHECK_FAILED"
  | "M4F_BOUND_MASTER_EXECUTABLE_AUDIT_FAILED"
  | "M4F_BOUND_MASTER_NETWORK_AUDIT_FAILED"
  | "M4F_BOUND_MASTER_PROCESS_AUDIT_FAILED"
  | "M4F_BOUND_MASTER_SOCKET_AUDIT_FAILED";

export interface RedactedProcessObservation09 {
  schema: "synthia-m4f-redacted-process-observation-09.v1";
  exit_status: number | null;
  signal: BoundJumpSignal09 | null;
  error_code: BoundJumpErrorCode09 | null;
  stdout_length: number;
  stdout_sha256: string;
  stderr_length: number;
  stderr_sha256: string;
  timed_out: boolean;
  outcome_ambiguous: boolean;
  retry_permitted: false;
}

export interface RedactedMasterEvidence09 {
  schema: "synthia-m4f-redacted-master-evidence-09.v1";
  master_pid: 87062;
  host_key_fingerprint: "SHA256:I37M/4mZJwdlChfZyay+GSbhTuRKEQthOZW7sHmugh8";
  master_effective_config_sha256: "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
  child_effective_config_sha256: "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
  network_sha256: string;
  network_process: RedactedProcessObservation09;
  network_connection: {
    schema: "synthia-m4f-redacted-network-connection-09.v1";
    fd: number;
    protocol: "TCP";
    local_address: "100.123.31.75";
    local_port: number;
    remote_address: "100.66.198.60";
    remote_port: 22;
    state: "ESTABLISHED";
  };
}

export interface BoundJumpFailureDetail09 {
  schema: "synthia-m4f-bound-phase-failure-09.v1";
  code: "M4F_BOUND_PHASE_09_FAILED";
  phase: string;
  transport_stage: BoundJumpTransportStage09;
  child_state: BoundJumpChildState09;
  child_outcome_state: BoundJumpChildOutcome09;
  effect_state: BoundJumpEffectState09;
  retry_permitted: false;
  underlying_code: BoundJumpUnderlyingCode09;
  underlying_reason: BoundJumpUnderlyingReason09;
  unexpected_type: BoundJumpUnexpectedType09;
  unexpected_message_length: number | null;
  redacted_trace_length: number;
  redacted_trace_sha256: string;
  process: RedactedProcessObservation09 | null;
  input: BoundJumpPhaseInputEvidence | null;
  master_before: RedactedMasterEvidence09 | null;
  master_after: RedactedMasterEvidence09 | null;
}

export interface RedactedSuccessfulPhase09 {
  schema: "synthia-m4f-bound-phase-redacted-09.v1";
  phase: string;
  process: RedactedProcessObservation09;
  input: BoundJumpPhaseInputEvidence;
  master_before: RedactedMasterEvidence09;
  master_after: RedactedMasterEvidence09;
}

export interface BoundJumpRuntime09 {
  auditMaster(): MasterAuditEvidence;
  spawn(executable: string, args: readonly string[], stdin: Uint8Array): RawProcessResult;
}

export interface BoundJumpTransport09Dependencies {
  invokePhase(phase: string, artifact: string): BoundJumpPhaseResult;
}

const HASH = /^[0-9a-f]{64}$/u;
const PHASE = /^[a-z0-9][a-z0-9:_-]{0,127}$/u;
const PROCESS_KEYS = ["error_code", "exit_status", "outcome_ambiguous", "retry_permitted", "signal", "stderr_base64", "stdout_base64", "timed_out"] as const;
const INPUT_KEYS = ["artifact_length", "artifact_sha256", "receiver_command_length", "receiver_command_maximum", "receiver_encoded_length", "receiver_encoded_sha256", "receiver_source_length", "receiver_source_sha256", "stdin_length", "stdin_sha256"] as const;
const MASTER_KEYS = ["child_effective_config_sha256", "host_key_fingerprint", "known_hosts_path", "master_effective_config_sha256", "master_pid", "master_socket", "network_connection", "network_process", "network_sha256", "schema", "ssh_executable"] as const;
const CONNECTION_KEYS = ["fd", "local_address", "local_port", "protocol", "remote_address", "remote_port", "state"] as const;
const AUDIT_CODES = new Set<BoundJumpUnderlyingCode09>([
  "M4F_BOUND_EFFECTIVE_CONFIG_AUDIT_FAILED",
  "M4F_BOUND_EFFECTIVE_CONFIG_HASH_MISMATCH",
  "M4F_BOUND_HOST_KEY_COUNT_INVALID",
  "M4F_BOUND_HOST_KEY_INVALID",
  "M4F_BOUND_KNOWN_HOSTS_AUDIT_FAILED",
  "M4F_BOUND_MASTER_CHECK_FAILED",
  "M4F_BOUND_MASTER_EXECUTABLE_AUDIT_FAILED",
  "M4F_BOUND_MASTER_NETWORK_AUDIT_FAILED",
  "M4F_BOUND_MASTER_PROCESS_AUDIT_FAILED",
  "M4F_BOUND_MASTER_SOCKET_AUDIT_FAILED",
]);
const SIGNALS = new Set<BoundJumpSignal09>(["SIGABRT", "SIGALRM", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGTERM", "SIGTRAP"]);
const ERROR_CODES = new Set<BoundJumpErrorCode09>(["E2BIG", "EACCES", "EAGAIN", "EMFILE", "ENFILE", "ENOBUFS", "ENOENT", "ENOMEM", "ETIMEDOUT"]);
const MAX_BUFFER = 8 * 1024 * 1024;
const SSH_TIMEOUT_MS = 90_000;
const MASTER_PID = 87_062;
const MASTER_SOCKET = "/private/tmp/synthia-m4f-jump.sock";
const KNOWN_HOSTS_PATH = "/Users/wenzhuolin/.ssh/known_hosts";
const HOST_KEY_FINGERPRINT = "SHA256:I37M/4mZJwdlChfZyay+GSbhTuRKEQthOZW7sHmugh8";
const MASTER_EFFECTIVE_CONFIG_SHA256 = "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
const CHILD_EFFECTIVE_CONFIG_SHA256 = "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
const MASTER_LOCAL_ADDRESS = "100.123.31.75";
const MASTER_REMOTE_ADDRESS = "100.66.198.60";

export const BOUND_JUMP_ARGUMENTS_09 = [
  "-T",
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
  JUMP_HOST,
  "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", BOUND_JUMP_RECEIVER_ENCODED,
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function canonicalBase64(value: unknown): Buffer | null {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length <= MAX_BUFFER && bytes.toString("base64") === value ? bytes : null;
}

function safePhase(value: string): string {
  return PHASE.test(value) ? value : "unknown";
}

function safeSignal(value: unknown): BoundJumpSignal09 | null {
  if (value === null) return null;
  return typeof value === "string" && SIGNALS.has(value as BoundJumpSignal09) ? value as BoundJumpSignal09 : "OTHER";
}

function safeErrorCode(value: unknown): BoundJumpErrorCode09 | null {
  if (value === null) return null;
  return typeof value === "string" && ERROR_CODES.has(value as BoundJumpErrorCode09) ? value as BoundJumpErrorCode09 : "OTHER";
}

function rawProcess(raw: RawProcessResult, forceAmbiguous = false): ProcessObservation {
  const timedOut = raw.errorCode === "ETIMEDOUT";
  return {
    exit_status: raw.status,
    signal: raw.signal,
    error_code: raw.errorCode,
    stdout_base64: Buffer.from(raw.stdout).toString("base64"),
    stderr_base64: Buffer.from(raw.stderr).toString("base64"),
    timed_out: timedOut,
    outcome_ambiguous: forceAmbiguous || timedOut || raw.signal !== null || raw.errorCode !== null || raw.status === null,
    retry_permitted: false,
  };
}

export function redactProcessObservation09(value: unknown): RedactedProcessObservation09 | null {
  const process = record(value);
  if (!process || !exactKeys(process, PROCESS_KEYS)) return null;
  const stdout = canonicalBase64(process.stdout_base64);
  const stderr = canonicalBase64(process.stderr_base64);
  if (!stdout || !stderr
    || (process.exit_status !== null && !integer(process.exit_status, 0, 255))
    || typeof process.timed_out !== "boolean"
    || typeof process.outcome_ambiguous !== "boolean"
    || process.retry_permitted !== false) return null;
  return {
    schema: "synthia-m4f-redacted-process-observation-09.v1",
    exit_status: process.exit_status as number | null,
    signal: safeSignal(process.signal),
    error_code: safeErrorCode(process.error_code),
    stdout_length: stdout.length,
    stdout_sha256: createHash("sha256").update(stdout).digest("hex"),
    stderr_length: stderr.length,
    stderr_sha256: createHash("sha256").update(stderr).digest("hex"),
    timed_out: process.timed_out,
    outcome_ambiguous: process.outcome_ambiguous,
    retry_permitted: false,
  };
}

function redactInput09(value: BoundJumpPhaseInputEvidence | null): BoundJumpPhaseInputEvidence | null {
  const input = record(value);
  if (!input || !exactKeys(input, INPUT_KEYS)
    || !integer(input.artifact_length, 0, 1_048_576) || !HASH.test(String(input.artifact_sha256))
    || !integer(input.stdin_length, 1, 2_000_000) || !HASH.test(String(input.stdin_sha256))
    || !integer(input.receiver_source_length, 1, 8_192) || !HASH.test(String(input.receiver_source_sha256))
    || !integer(input.receiver_encoded_length, 1, 16_384) || !HASH.test(String(input.receiver_encoded_sha256))
    || !integer(input.receiver_command_length, 1, 8_191) || input.receiver_command_maximum !== 8_192) return null;
  return {
    artifact_length: input.artifact_length,
    artifact_sha256: input.artifact_sha256 as string,
    stdin_length: input.stdin_length,
    stdin_sha256: input.stdin_sha256 as string,
    receiver_source_length: input.receiver_source_length,
    receiver_source_sha256: input.receiver_source_sha256 as string,
    receiver_encoded_length: input.receiver_encoded_length,
    receiver_encoded_sha256: input.receiver_encoded_sha256 as string,
    receiver_command_length: input.receiver_command_length,
    receiver_command_maximum: 8_192,
  };
}

function expectedNetworkBytes(fd: number, localPort: number): Buffer {
  return Buffer.from([
    `p${MASTER_PID}`,
    "cssh",
    `f${fd}`,
    "tIPv4",
    "PTCP",
    `n${MASTER_LOCAL_ADDRESS}:${localPort}->${MASTER_REMOTE_ADDRESS}:22`,
    "TST=ESTABLISHED",
    "TQR=0",
    "TQS=0",
    "",
  ].join("\n"), "utf8");
}

function redactMaster09(value: MasterAuditEvidence | null): RedactedMasterEvidence09 | null {
  const master = record(value);
  if (!master || !exactKeys(master, MASTER_KEYS)
    || master.schema !== "synthia-m4f-bound-master-audit.v1"
    || master.master_pid !== MASTER_PID || master.master_socket !== MASTER_SOCKET
    || master.known_hosts_path !== KNOWN_HOSTS_PATH || master.ssh_executable !== SSH_PATH
    || master.host_key_fingerprint !== HOST_KEY_FINGERPRINT
    || master.master_effective_config_sha256 !== MASTER_EFFECTIVE_CONFIG_SHA256
    || master.child_effective_config_sha256 !== CHILD_EFFECTIVE_CONFIG_SHA256) return null;
  const connection = record(master.network_connection);
  const rawNetworkProcess = record(master.network_process);
  const process = redactProcessObservation09(master.network_process);
  if (!connection || !exactKeys(connection, CONNECTION_KEYS)
    || !integer(connection.fd, 0, 1_048_575)
    || connection.protocol !== "TCP" || connection.local_address !== MASTER_LOCAL_ADDRESS
    || !integer(connection.local_port, 49_152, 65_535)
    || connection.remote_address !== MASTER_REMOTE_ADDRESS || connection.remote_port !== 22
    || connection.state !== "ESTABLISHED" || !rawNetworkProcess || !process
    || process.exit_status !== 0 || process.signal !== null || process.error_code !== null
    || process.stderr_length !== 0 || process.timed_out || process.outcome_ambiguous
    || rawNetworkProcess.retry_permitted !== false) return null;
  const networkBytes = expectedNetworkBytes(connection.fd, connection.local_port);
  const expectedNetworkSha256 = createHash("sha256").update(networkBytes).digest("hex");
  if (process.stdout_length !== networkBytes.length || process.stdout_sha256 !== expectedNetworkSha256
    || master.network_sha256 !== expectedNetworkSha256) return null;
  return {
    schema: "synthia-m4f-redacted-master-evidence-09.v1",
    master_pid: MASTER_PID,
    host_key_fingerprint: HOST_KEY_FINGERPRINT,
    master_effective_config_sha256: MASTER_EFFECTIVE_CONFIG_SHA256,
    child_effective_config_sha256: CHILD_EFFECTIVE_CONFIG_SHA256,
    network_sha256: expectedNetworkSha256,
    network_process: process,
    network_connection: {
      schema: "synthia-m4f-redacted-network-connection-09.v1",
      fd: connection.fd,
      protocol: "TCP",
      local_address: MASTER_LOCAL_ADDRESS,
      local_port: connection.local_port,
      remote_address: MASTER_REMOTE_ADDRESS,
      remote_port: 22,
      state: "ESTABLISHED",
    },
  };
}

function safeUnexpected(error: unknown): { type: BoundJumpUnexpectedType09; messageLength: number | null } {
  if (!(error instanceof Error)) return { type: "non_error", messageLength: null };
  const length = Buffer.byteLength(error.message, "utf8");
  return { type: "error", messageLength: length <= 1_048_576 ? length : null };
}

function auditCause(error: unknown): { code: BoundJumpUnderlyingCode09; process: unknown } {
  if (!(error instanceof CeremonyFailure)) return { code: "M4F_BOUND_AUDIT_FAILED_OTHER", process: null };
  const detail = record(error.detail);
  if (!detail || typeof detail.code !== "string" || !AUDIT_CODES.has(detail.code as BoundJumpUnderlyingCode09)) {
    return { code: "M4F_BOUND_AUDIT_FAILED_OTHER", process: null };
  }
  return {
    code: detail.code as BoundJumpUnderlyingCode09,
    process: detail.process,
  };
}

function failureDetail(
  phase: string,
  state: Pick<BoundJumpFailureDetail09, "transport_stage" | "child_state" | "child_outcome_state" | "effect_state">,
  underlyingCode: BoundJumpUnderlyingCode09,
  underlyingReason: BoundJumpUnderlyingReason09,
  processValue: unknown,
  inputValue: BoundJumpPhaseInputEvidence | null,
  beforeValue: MasterAuditEvidence | null,
  afterValue: MasterAuditEvidence | null,
  unexpectedType: BoundJumpUnexpectedType09 = null,
  unexpectedMessageLength: number | null = null,
): BoundJumpFailureDetail09 {
  const process = redactProcessObservation09(processValue);
  const input = redactInput09(inputValue);
  const before = redactMaster09(beforeValue);
  const after = redactMaster09(afterValue);
  const safeState = (state.effect_state === "not_started"
    && state.child_state === "not_started_proven"
    && state.child_outcome_state === "not_started"
    && state.transport_stage === "pre_audit")
    || (state.effect_state === "unknown" && state.child_state !== "not_started_proven")
    ? state
    : { transport_stage: "unknown" as const, child_state: "unknown" as const, child_outcome_state: "unknown" as const, effect_state: "unknown" as const };
  const trace = {
    schema: "synthia-m4f-redacted-failure-trace-09.v1",
    ...safeState,
    underlying_code: underlyingCode,
    underlying_reason: underlyingReason,
    unexpected_type: unexpectedType,
    unexpected_message_length: unexpectedMessageLength,
    process,
    input,
    master_before: before,
    master_after: after,
  };
  const bytes = Buffer.from(JSON.stringify(trace), "utf8");
  return {
    schema: "synthia-m4f-bound-phase-failure-09.v1",
    code: "M4F_BOUND_PHASE_09_FAILED",
    phase: safePhase(phase),
    ...safeState,
    retry_permitted: false,
    underlying_code: underlyingCode,
    underlying_reason: underlyingReason,
    unexpected_type: unexpectedType,
    unexpected_message_length: unexpectedMessageLength,
    redacted_trace_length: bytes.length,
    redacted_trace_sha256: createHash("sha256").update(bytes).digest("hex"),
    process,
    input,
    master_before: before,
    master_after: after,
  };
}

function throwFailure(...args: Parameters<typeof failureDetail>): never {
  throw new CeremonyFailure(failureDetail(...args) as unknown as Record<string, unknown>);
}

function conservativeFailure(error: unknown, phase: string): BoundJumpFailureDetail09 {
  const unexpected = safeUnexpected(error);
  return failureDetail(
    phase,
    { transport_stage: "unknown", child_state: "unknown", child_outcome_state: "unknown", effect_state: "unknown" },
    "M4F_BOUND_UNKNOWN_FAILURE",
    null,
    null,
    null,
    null,
    null,
    unexpected.type,
    unexpected.messageLength,
  );
}

export function normalizeBoundJumpFailure09(error: unknown, phase: string): BoundJumpFailureDetail09 {
  return conservativeFailure(error, phase);
}

const defaultRuntime: BoundJumpRuntime09 = {
  auditMaster: auditBoundJumpMaster,
  spawn: (executable, args, stdin) => {
    const result = spawnSync(executable, [...args], {
      encoding: "buffer",
      input: stdin,
      maxBuffer: MAX_BUFFER,
      timeout: SSH_TIMEOUT_MS,
      windowsHide: true,
    });
    return {
      status: result.status,
      signal: result.signal,
      errorCode: result.error && "code" in result.error && typeof result.error.code === "string" ? result.error.code : null,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: result.stderr ?? Buffer.alloc(0),
    };
  },
};

export function createBoundJumpTransport09(runtime: BoundJumpRuntime09 = defaultRuntime) {
  return {
    invokeBoundJumpPhase09(phase: string, artifact: string): BoundJumpPhaseResult {
      if (!PHASE.test(phase)) {
        throwFailure(phase, { transport_stage: "pre_audit", child_state: "not_started_proven", child_outcome_state: "not_started", effect_state: "not_started" }, "M4F_BOUND_PHASE_NAME_INVALID", null, null, null, null, null);
      }
      let built: ReturnType<typeof buildBoundJumpPhaseInput>;
      try {
        built = buildBoundJumpPhaseInput(artifact);
      } catch {
        throwFailure(phase, { transport_stage: "pre_audit", child_state: "not_started_proven", child_outcome_state: "not_started", effect_state: "not_started" }, "M4F_BOUND_PHASE_INPUT_INVALID", null, null, null, null, null);
      }
      let before: MasterAuditEvidence;
      try {
        before = runtime.auditMaster();
      } catch (error) {
        const cause = auditCause(error);
        const unexpected = safeUnexpected(error);
        throwFailure(phase, { transport_stage: "pre_audit", child_state: "not_started_proven", child_outcome_state: "not_started", effect_state: "not_started" }, cause.code === "M4F_BOUND_AUDIT_FAILED_OTHER" ? "M4F_BOUND_PHASE_PRE_AUDIT_FAILED" : cause.code, null, cause.process, built.evidence, null, null, unexpected.type, unexpected.messageLength);
      }
      let raw: RawProcessResult;
      try {
        raw = runtime.spawn(SSH_PATH, BOUND_JUMP_ARGUMENTS_09, built.stdin);
      } catch (error) {
        const unexpected = safeUnexpected(error);
        throwFailure(phase, { transport_stage: "child_execution", child_state: "unknown", child_outcome_state: "unknown", effect_state: "unknown" }, "M4F_BOUND_PHASE_SPAWN_SYNC_FAILED", null, null, built.evidence, before, null, unexpected.type, unexpected.messageLength);
      }
      let after: MasterAuditEvidence;
      try {
        after = runtime.auditMaster();
      } catch (error) {
        const cause = auditCause(error);
        const unexpected = safeUnexpected(error);
        throwFailure(phase, { transport_stage: "post_audit", child_state: raw.errorCode === null ? "started" : "unknown", child_outcome_state: "ambiguous", effect_state: "unknown" }, cause.code === "M4F_BOUND_AUDIT_FAILED_OTHER" ? "M4F_BOUND_PHASE_POST_AUDIT_FAILED" : cause.code, "post-master-audit-failed", rawProcess(raw, true), built.evidence, before, null, unexpected.type, unexpected.messageLength);
      }
      const observed = rawProcess(raw);
      if (raw.errorCode !== null) {
        throwFailure(phase, { transport_stage: "child_execution", child_state: "unknown", child_outcome_state: "ambiguous", effect_state: "unknown" }, "M4F_BOUND_PHASE_OUTCOME_AMBIGUOUS", "local-termination-or-buffer-bound", observed, built.evidence, before, after);
      }
      if (observed.outcome_ambiguous) {
        throwFailure(phase, { transport_stage: "child_execution", child_state: "started", child_outcome_state: "ambiguous", effect_state: "unknown" }, "M4F_BOUND_PHASE_OUTCOME_AMBIGUOUS", "local-termination-or-buffer-bound", observed, built.evidence, before, after);
      }
      if (raw.status !== 0) {
        throwFailure(phase, { transport_stage: "child_execution", child_state: "started", child_outcome_state: "known", effect_state: "unknown" }, "M4F_BOUND_PHASE_FAILED", null, observed, built.evidence, before, after);
      }
      if (raw.stderr.length !== 0) {
        throwFailure(phase, { transport_stage: "child_execution", child_state: "started", child_outcome_state: "known", effect_state: "unknown" }, "M4F_BOUND_PHASE_STDERR_NOT_EMPTY", null, observed, built.evidence, before, after);
      }
      let output: string;
      try {
        output = new TextDecoder("utf-8", { fatal: true }).decode(raw.stdout);
      } catch {
        throwFailure(phase, { transport_stage: "output_validation", child_state: "started", child_outcome_state: "known", effect_state: "unknown" }, "M4F_BOUND_PHASE_OUTPUT_INVALID", null, observed, built.evidence, before, after);
      }
      const framed = /^([^\r\n]+)\r\n([^\r\n]+)\r\n$/u.exec(output);
      let identity: unknown;
      let payload: unknown;
      try {
        identity = JSON.parse(framed?.[1] ?? "");
        payload = JSON.parse(framed?.[2] ?? "");
      } catch {
        throwFailure(phase, { transport_stage: "output_validation", child_state: "started", child_outcome_state: "known", effect_state: "unknown" }, "M4F_BOUND_PHASE_OUTPUT_INVALID", null, observed, built.evidence, before, after);
      }
      const identityRecord = record(identity);
      const payloadRecord = record(payload);
      if (!framed || !identityRecord || !payloadRecord
        || !exactKeys(identityRecord, ["computer_name", "identity_name", "identity_sid", "schema"])
        || identityRecord.schema !== "synthia-m4f-jump-identity.v1"
        || identityRecord.computer_name !== JUMP_COMPUTER
        || identityRecord.identity_name !== JUMP_IDENTITY_NAME
        || identityRecord.identity_sid !== JUMP_IDENTITY_SID) {
        throwFailure(phase, { transport_stage: "output_validation", child_state: "started", child_outcome_state: "known", effect_state: "unknown" }, "M4F_BOUND_PHASE_OUTPUT_INVALID", null, observed, built.evidence, before, after);
      }
      return {
        schema: "synthia-m4f-bound-phase.v1",
        phase,
        identity: identityRecord,
        payload: payloadRecord,
        process: observed,
        input: built.evidence,
        master_before: before,
        master_after: after,
      };
    },
  };
}

const defaultTransport = createBoundJumpTransport09();

export function invokeBoundJumpPhase09(
  phase: string,
  artifact: string,
  overrides: Partial<BoundJumpTransport09Dependencies> = {},
): BoundJumpPhaseResult {
  if (!overrides.invokePhase) return defaultTransport.invokeBoundJumpPhase09(phase, artifact);
  try {
    return overrides.invokePhase(phase, artifact);
  } catch (error) {
    throw new CeremonyFailure(conservativeFailure(error, phase) as unknown as Record<string, unknown>);
  }
}

export function redactSuccessfulPhase09(observation: BoundJumpPhaseResult): RedactedSuccessfulPhase09 {
  const process = redactProcessObservation09(observation.process);
  const input = redactInput09(observation.input);
  const before = redactMaster09(observation.master_before);
  const after = redactMaster09(observation.master_after);
  if (!process || !input || !before || !after || !PHASE.test(observation.phase)) {
    throw new CeremonyFailure(conservativeFailure(new Error("invalid phase evidence"), observation.phase) as unknown as Record<string, unknown>);
  }
  return {
    schema: "synthia-m4f-bound-phase-redacted-09.v1",
    phase: observation.phase,
    process,
    input,
    master_before: before,
    master_after: after,
  };
}
