import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";

export type OuterHarnessCeremony09 = "diagnostic" | "parse";

export interface OuterHarnessRequest09 {
  evidenceRoot: string;
  attemptId: string;
  ceremony: OuterHarnessCeremony09;
}

export interface OuterHarnessFaults09 {
  beforeAttemptDirectory?(): void;
  afterAttemptDirectorySync?(): void;
  afterStdoutCreate?(): void;
  afterStderrCreate?(): void;
  beforeMarkerTempWrite?(): void;
  afterMarkerTempWrite?(): void;
  afterMarkerTempFsync?(): void;
  beforeMarkerLink?(): void;
  afterMarkerLink?(): void;
  afterMarkerDirectoryFsync?(): void;
  beforeLaunch?(): void;
  afterChildCloseBeforeStreamFsync?(): void;
  beforeStdoutFsync?(): void;
  beforeStderrFsync?(): void;
  beforeResultTempWrite?(): void;
  afterResultTempWrite?(): void;
  afterResultTempFsync?(): void;
  beforeResultLink?(): void;
  afterResultLink?(): void;
  afterResultDirectoryFsync?(): void;
  beforeFinalizationTempWrite?(): void;
  afterFinalizationTempWrite?(): void;
  afterFinalizationTempFsync?(): void;
  beforeFinalizationLink?(): void;
  afterFinalizationLink?(): void;
  afterFinalizationDirectoryFsync?(): void;
}

export interface OuterHarnessResult09 {
  attemptDirectory: string;
  markerPath: string;
  resultPath: string;
  finalizationPath: string;
  outerExitCode: number;
}

export interface OuterHarnessChildOutcome09 {
  childStartState: "not_started_proven" | "started" | "unknown";
  exitStatus: number | null;
  signal: string | null;
  errorCode: string | null;
  stdoutLimitExceeded: boolean;
  stderrLimitExceeded: boolean;
  timedOut: boolean;
  drainComplete: boolean;
}

export interface OuterHarnessChildInvocation09 {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdoutDescriptor: number;
  stderrDescriptor: number;
}

export interface OuterHarnessRuntime09 {
  runChild(invocation: OuterHarnessChildInvocation09): Promise<unknown>;
}

export type OuterHarnessRecoveryState09 =
  | "absent_retry_safe"
  | "precheck_failed_not_started_no_retry"
  | "unknown_no_retry"
  | "result_complete_unfinalized_no_retry"
  | "finalized_no_retry";

interface CeremonyDefinition09 {
  phase: string;
  confirmationEnvName: string;
  confirmationEnvValue: string;
  confirmationTokenId: string;
  sourcePath: string;
}

interface FilePin09 {
  length: number;
  sha256: string;
}

interface RuntimePin09 extends FilePin09 {
  owner_uid: number;
  path_sha256: string;
  version: string;
}

interface AuthorityPayload09 {
  schema: "synthia-m4f-outer-harness-pin-authority-09.v1";
  authority_id: "receiver-representation-09";
  files: Record<string, FilePin09>;
  artifacts: Record<string, FilePin09>;
  runtime: RuntimePin09;
}

interface VerifiedAuthority09 {
  manifestSha256: string;
  payload: AuthorityPayload09;
  pins: Record<string, unknown>;
}

interface PublishHooks09 {
  beforeTempWrite?(): void;
  afterTempWrite?(): void;
  afterTempFsync?(): void;
  beforeLink?(): void;
  afterLink?(): void;
  afterDirectoryFsync?(): void;
}

const HASH = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const OUTER_WATCHDOG_MILLISECONDS = 105_000;
const OUTER_KILL_DRAIN_MILLISECONDS = 5_000;
const ZERO_HASH = "0".repeat(64);
const SCRIPTS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CONNECTOR_DIRECTORY = resolve(SCRIPTS_DIRECTORY, "..");
const AUTHORITY_PATH = join(SCRIPTS_DIRECTORY, "m4f-outer-harness-authority-09.json");
const AUTHORITY_PUBLIC_KEY = createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAM7aLNxSSTgBVXZdaLZIpxZgJZUaYl1mDJKaE2zbUzu8=
-----END PUBLIC KEY-----
`);

const FILE_PATHS = {
  diagnostic_source_09: join(SCRIPTS_DIRECTORY, "invoke-m4f-jump-local-receiver-representation-diagnostic-09.ts"),
  diagnostic_test_09: join(CONNECTOR_DIRECTORY, "m4f-jump-local-receiver-representation-diagnostic-09.test.ts"),
  parse_source_09: join(SCRIPTS_DIRECTORY, "invoke-m4f-jump-local-receiver-representation-parse-gate-09.ts"),
  parse_test_09: join(CONNECTOR_DIRECTORY, "m4f-jump-local-receiver-representation-parse-gate-09.test.ts"),
  transport_source_09: join(SCRIPTS_DIRECTORY, "m4f-bound-jump-transport-09.ts"),
  transport_test_09: join(CONNECTOR_DIRECTORY, "m4f-bound-jump-transport-09.test.ts"),
  diagnostic_artifact_file_09: join(SCRIPTS_DIRECTORY, "m4f-jump-local-receiver-representation-diagnostic-09.ps1"),
  parse_artifact_file_09: join(SCRIPTS_DIRECTORY, "m4f-jump-local-receiver-representation-parse-gate-09.ps1"),
  recorder_source_09: fileURLToPath(import.meta.url),
  recorder_test_09: join(CONNECTOR_DIRECTORY, "m4f-ceremony-outer-harness-09.test.ts"),
  diagnostic_source_08: join(SCRIPTS_DIRECTORY, "invoke-m4f-jump-local-receiver-representation-diagnostic-08.ts"),
  diagnostic_test_08: join(CONNECTOR_DIRECTORY, "m4f-jump-local-receiver-representation-diagnostic-08.test.ts"),
  parse_source_08: join(SCRIPTS_DIRECTORY, "invoke-m4f-jump-local-receiver-representation-parse-gate-08.ts"),
  parse_test_08: join(CONNECTOR_DIRECTORY, "m4f-jump-local-receiver-representation-parse-gate-08.test.ts"),
  legacy_transport: join(SCRIPTS_DIRECTORY, "m4f-bound-jump-transport.ts"),
} as const;

const FILE_PIN_IDS = Object.keys(FILE_PATHS).sort();
const ARTIFACT_PIN_IDS = ["diagnostic_artifact_09", "parse_artifact_09"] as const;

const DEFINITIONS: Readonly<Record<OuterHarnessCeremony09, CeremonyDefinition09>> = {
  diagnostic: {
    phase: "jump-local-receiver-representation-09:diagnose",
    confirmationEnvName: "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_CONFIRMATION_09",
    confirmationEnvValue: "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_20260827_09",
    confirmationTokenId: "receiver-representation-diagnostic-09",
    sourcePath: FILE_PATHS.diagnostic_source_09,
  },
  parse: {
    phase: "jump-local-receiver-representation-parse-gate-09:parse",
    confirmationEnvName: "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_PARSE_GATE_CONFIRMATION_09",
    confirmationEnvValue: "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_PARSE_GATE_20260827_09",
    confirmationTokenId: "receiver-representation-parse-09",
    sourcePath: FILE_PATHS.parse_source_09,
  },
};

const ALLOWED_SIGNALS = new Set([
  "SIGABRT", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE",
  "SIGQUIT", "SIGSEGV", "SIGTERM", "SIGTRAP",
]);
const SPAWN_REFUSAL_CODES = new Set(["EACCES", "ENOENT"]);

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function decodeCanonicalBase64(value: unknown): Buffer {
  if (typeof value !== "string" || !BASE64.test(value)) throw new Error("M4F_OUTER_HARNESS_09_AUTHORITY_INVALID");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("M4F_OUTER_HARNESS_09_AUTHORITY_INVALID");
  return decoded;
}

function requireSecureRegularFile(path: string): ReturnType<typeof lstatSync> {
  const facts = lstatSync(path);
  if (!facts.isFile() || facts.isSymbolicLink() || facts.uid !== (process.getuid?.() ?? -1)
    || (facts.mode & 0o022) !== 0) throw new Error("M4F_OUTER_HARNESS_09_PIN_TARGET_INVALID");
  return facts;
}

function requireOwnedMode(path: string, mode: number): void {
  const facts = lstatSync(path);
  if (!facts.isDirectory() || facts.isSymbolicLink() || facts.uid !== (process.getuid?.() ?? -1)
    || (facts.mode & 0o777) !== mode) throw new Error("M4F_OUTER_HARNESS_09_DIRECTORY_INVALID");
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
}

function publishDurableNoReplace(path: string, value: unknown, hooks: PublishHooks09 = {}): void {
  const directory = dirname(path);
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${sha256(encoded).slice(0, 16)}.tmp`);
  let descriptor: number | null = null;
  let publicationDurable = false;
  hooks.beforeTempWrite?.();
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeAll(descriptor, encoded);
    hooks.afterTempWrite?.();
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    hooks.afterTempFsync?.();
    closeSync(descriptor);
    descriptor = null;
    hooks.beforeLink?.();
    linkSync(temporary, path);
    hooks.afterLink?.();
    syncDirectory(directory);
    publicationDurable = true;
    hooks.afterDirectoryFsync?.();
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* retain the incomplete temp file */ }
    }
    if (publicationDurable) {
      unlinkSync(temporary);
      syncDirectory(directory);
    }
  }
}

function fileFact(path: string, maximum = Number.MAX_SAFE_INTEGER): FilePin09 {
  requireSecureRegularFile(path);
  const size = statSync(path).size;
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) return { length: size, sha256: ZERO_HASH };
  const bytes = readFileSync(path);
  return { length: bytes.length, sha256: sha256(bytes) };
}

function validateFilePin(value: unknown): value is FilePin09 {
  const item = record(value);
  return Boolean(item && exactKeys(item, ["length", "sha256"])
    && Number.isSafeInteger(item.length) && (item.length as number) >= 0 && HASH.test(item.sha256 as string));
}

function readAuthorityPayload(readBytes: (path: string) => Buffer = (path) => readFileSync(path)): {
  manifestSha256: string;
  payload: AuthorityPayload09;
} {
  requireSecureRegularFile(AUTHORITY_PATH);
  const envelopeBytes = readBytes(AUTHORITY_PATH);
  if (envelopeBytes.length < 1 || envelopeBytes.length > 256 * 1024) throw new Error("M4F_OUTER_HARNESS_09_AUTHORITY_INVALID");
  let envelopeValue: unknown;
  try { envelopeValue = JSON.parse(envelopeBytes.toString("utf8")); } catch { throw new Error("M4F_OUTER_HARNESS_09_AUTHORITY_INVALID"); }
  const envelope = record(envelopeValue);
  if (!envelope || !exactKeys(envelope, ["payload_base64", "schema", "signature_base64"])
    || envelope.schema !== "synthia-m4f-outer-harness-signed-authority-09.v1") {
    throw new Error("M4F_OUTER_HARNESS_09_AUTHORITY_INVALID");
  }
  const payloadBytes = decodeCanonicalBase64(envelope.payload_base64);
  const signature = decodeCanonicalBase64(envelope.signature_base64);
  if (!verifySignature(null, payloadBytes, AUTHORITY_PUBLIC_KEY, signature)) {
    throw new Error("M4F_OUTER_HARNESS_09_AUTHORITY_SIGNATURE_INVALID");
  }
  let payloadValue: unknown;
  try { payloadValue = JSON.parse(payloadBytes.toString("utf8")); } catch { throw new Error("M4F_OUTER_HARNESS_09_AUTHORITY_INVALID"); }
  if (JSON.stringify(payloadValue) !== payloadBytes.toString("utf8")) throw new Error("M4F_OUTER_HARNESS_09_AUTHORITY_INVALID");
  const payload = record(payloadValue);
  if (!payload || !exactKeys(payload, ["artifacts", "authority_id", "files", "runtime", "schema"])
    || payload.schema !== "synthia-m4f-outer-harness-pin-authority-09.v1"
    || payload.authority_id !== "receiver-representation-09") throw new Error("M4F_OUTER_HARNESS_09_AUTHORITY_INVALID");
  const files = record(payload.files);
  const artifacts = record(payload.artifacts);
  const runtime = record(payload.runtime);
  if (!files || !exactKeys(files, FILE_PIN_IDS) || !Object.values(files).every(validateFilePin)
    || !artifacts || !exactKeys(artifacts, ARTIFACT_PIN_IDS) || !Object.values(artifacts).every(validateFilePin)
    || !runtime || !exactKeys(runtime, ["length", "owner_uid", "path_sha256", "sha256", "version"])
    || !Number.isSafeInteger(runtime.length) || (runtime.length as number) < 1 || !HASH.test(runtime.sha256 as string)
    || !Number.isSafeInteger(runtime.owner_uid) || (runtime.owner_uid as number) < 0
    || !HASH.test(runtime.path_sha256 as string) || typeof runtime.version !== "string"
    || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(runtime.version)) {
    throw new Error("M4F_OUTER_HARNESS_09_AUTHORITY_INVALID");
  }
  return { manifestSha256: sha256(envelopeBytes), payload: payload as unknown as AuthorityPayload09 };
}

function verifyStaticPins(readBytes: (path: string) => Buffer = (path) => readFileSync(path)): VerifiedAuthority09 {
  const authority = readAuthorityPayload(readBytes);
  const observedFiles: Record<string, FilePin09> = {};
  for (const id of FILE_PIN_IDS) {
    const path = FILE_PATHS[id as keyof typeof FILE_PATHS];
    requireSecureRegularFile(path);
    const bytes = readBytes(path);
    observedFiles[id] = { length: bytes.length, sha256: sha256(bytes) };
  }
  if (JSON.stringify(observedFiles) !== JSON.stringify(authority.payload.files)) {
    throw new Error("M4F_OUTER_HARNESS_09_PIN_MISMATCH");
  }
  const runtimeFacts = requireSecureRegularFile(process.execPath);
  const runtimeBytes = readBytes(process.execPath);
  const observedRuntime: RuntimePin09 = {
    length: runtimeBytes.length,
    sha256: sha256(runtimeBytes),
    owner_uid: Number(runtimeFacts!.uid),
    path_sha256: sha256(process.execPath),
    version: process.versions.bun ?? "",
  };
  if (JSON.stringify(observedRuntime) !== JSON.stringify(authority.payload.runtime)) {
    throw new Error("M4F_OUTER_HARNESS_09_RUNTIME_DRIFT");
  }
  const observedArtifacts = {
    diagnostic_artifact_09: observedFiles.diagnostic_artifact_file_09,
    parse_artifact_09: observedFiles.parse_artifact_file_09,
  };
  if (JSON.stringify(observedArtifacts) !== JSON.stringify(authority.payload.artifacts)) {
    throw new Error("M4F_OUTER_HARNESS_09_ARTIFACT_DRIFT");
  }
  return {
    ...authority,
    pins: { files: observedFiles, artifacts: observedArtifacts, runtime: observedRuntime },
  };
}

export function verifyStaticPins09ForTest(readBytes: (path: string) => Buffer): void {
  verifyStaticPins(readBytes);
}

function safeSpawnErrorCode(value: unknown): "EACCES" | "ENOENT" | "OTHER" {
  return value === "EACCES" || value === "ENOENT" ? value : "OTHER";
}

function runBoundedChild(
  invocation: OuterHarnessChildInvocation09,
  watchdogMilliseconds = OUTER_WATCHDOG_MILLISECONDS,
  killDrainMilliseconds = OUTER_KILL_DRAIN_MILLISECONDS,
  spawnChild: typeof spawn = spawn,
): Promise<OuterHarnessChildOutcome09> {
  return new Promise((resolvePromise) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    let childStartState: OuterHarnessChildOutcome09["childStartState"] = "unknown";
    let exitStatus: number | null = null;
    let signal: string | null = null;
    let errorCode: string | null = null;
    let stdoutLength = 0;
    let stderrLength = 0;
    let stdoutLimitExceeded = false;
    let stderrLimitExceeded = false;
    let timedOut = false;
    let settled = false;
    let spawnSeen = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let drainWatchdog: ReturnType<typeof setTimeout> | null = null;

    const finish = (drainComplete: boolean): void => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      if (drainWatchdog) clearTimeout(drainWatchdog);
      resolvePromise({ childStartState, exitStatus, signal, errorCode, stdoutLimitExceeded, stderrLimitExceeded, timedOut, drainComplete });
    };
    const terminate = (reason: "timeout" | "stdout" | "stderr" | "write"): void => {
      if (reason === "timeout") { timedOut = true; errorCode = "ETIMEDOUT"; }
      else if (reason === "stdout") { stdoutLimitExceeded = true; errorCode = "EOVERFLOW"; }
      else if (reason === "stderr") { stderrLimitExceeded = true; errorCode = "EOVERFLOW"; }
      else errorCode = "OTHER";
      try { child.kill("SIGKILL"); } catch { childStartState = "unknown"; }
      if (!drainWatchdog) {
        drainWatchdog = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(false);
        }, killDrainMilliseconds);
      }
    };
    const recordChunk = (descriptor: number, chunkValue: Buffer | string, stream: "stdout" | "stderr"): void => {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      const current = stream === "stdout" ? stdoutLength : stderrLength;
      const remaining = Math.max(0, MAX_STREAM_BYTES - current);
      if (remaining > 0) {
        try { writeAll(descriptor, chunk.subarray(0, remaining)); } catch { terminate("write"); return; }
      }
      if (stream === "stdout") stdoutLength = current + Math.min(chunk.length, remaining);
      else stderrLength = current + Math.min(chunk.length, remaining);
      if (chunk.length > remaining) terminate(stream);
    };

    try {
      child = spawnChild(invocation.executable, [...invocation.args], {
        cwd: invocation.cwd,
        env: { ...invocation.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const code = safeSpawnErrorCode(error && typeof error === "object" && "code" in error ? error.code : null);
      childStartState = SPAWN_REFUSAL_CODES.has(code) ? "not_started_proven" : "unknown";
      errorCode = code;
      finish(true);
      return;
    }
    child.once("spawn", () => { spawnSeen = true; childStartState = "started"; });
    child.once("error", (error) => {
      const code = safeSpawnErrorCode(error && typeof error === "object" && "code" in error ? error.code : null);
      if (!spawnSeen) {
        childStartState = SPAWN_REFUSAL_CODES.has(code) ? "not_started_proven" : "unknown";
        errorCode = code;
      } else if (!timedOut && !stdoutLimitExceeded && !stderrLimitExceeded) {
        errorCode = "OTHER";
      }
    });
    child.once("exit", (status, observedSignal) => { exitStatus = status; signal = observedSignal; });
    child.stdout.on("data", (chunk: Buffer | string) => recordChunk(invocation.stdoutDescriptor, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer | string) => recordChunk(invocation.stderrDescriptor, chunk, "stderr"));
    child.once("close", () => finish(true));
    watchdog = setTimeout(() => terminate("timeout"), watchdogMilliseconds);
    if (settled) clearTimeout(watchdog);
  });
}

export function runBoundedChild09ForTest(
  invocation: OuterHarnessChildInvocation09,
  watchdogMilliseconds: number,
  killDrainMilliseconds: number,
  spawnChild: typeof spawn = spawn,
): Promise<OuterHarnessChildOutcome09> {
  return runBoundedChild(invocation, watchdogMilliseconds, killDrainMilliseconds, spawnChild);
}

const defaultRuntime: OuterHarnessRuntime09 = {
  runChild: runBoundedChild,
};

function sanitizeChildOutcome(value: unknown): OuterHarnessChildOutcome09 & { valid: boolean } {
  const item = record(value);
  const unknown = (): OuterHarnessChildOutcome09 & { valid: false } => ({
    childStartState: "unknown", exitStatus: null, signal: null, errorCode: "OTHER",
    stdoutLimitExceeded: false, stderrLimitExceeded: false, timedOut: false, drainComplete: false, valid: false,
  });
  if (!item || !exactKeys(item, [
    "childStartState", "drainComplete", "errorCode", "exitStatus", "signal", "stderrLimitExceeded",
    "stdoutLimitExceeded", "timedOut",
  ])) return unknown();
  const { childStartState, exitStatus, signal, errorCode, stdoutLimitExceeded, stderrLimitExceeded, timedOut, drainComplete } = item;
  if ((childStartState !== "not_started_proven" && childStartState !== "started" && childStartState !== "unknown")
    || (exitStatus !== null && (!Number.isInteger(exitStatus) || (exitStatus as number) < 0 || (exitStatus as number) > 255))
    || (signal !== null && (typeof signal !== "string" || !ALLOWED_SIGNALS.has(signal)))
    || (errorCode !== null && errorCode !== "EACCES" && errorCode !== "ENOENT" && errorCode !== "ETIMEDOUT"
      && errorCode !== "EOVERFLOW" && errorCode !== "OTHER")
    || typeof stdoutLimitExceeded !== "boolean" || typeof stderrLimitExceeded !== "boolean"
    || typeof timedOut !== "boolean" || typeof drainComplete !== "boolean") return unknown();
  const refusal = childStartState === "not_started_proven" && exitStatus === null && signal === null
    && SPAWN_REFUSAL_CODES.has(errorCode as string) && !stdoutLimitExceeded && !stderrLimitExceeded && !timedOut
    && drainComplete;
  const normalExit = childStartState === "started" && Number.isInteger(exitStatus) && signal === null
    && errorCode === null && !stdoutLimitExceeded && !stderrLimitExceeded && !timedOut && drainComplete;
  const signaled = childStartState === "started" && exitStatus === null && typeof signal === "string"
    && errorCode === null && !stdoutLimitExceeded && !stderrLimitExceeded && !timedOut && drainComplete;
  const timed = childStartState === "started" && exitStatus === null && (signal === null || signal === "SIGKILL")
    && errorCode === "ETIMEDOUT" && timedOut;
  const capped = childStartState === "started" && exitStatus === null && (signal === null || signal === "SIGKILL")
    && errorCode === "EOVERFLOW" && !timedOut && (stdoutLimitExceeded || stderrLimitExceeded);
  const conservativeUnknown = childStartState === "unknown" && exitStatus === null && signal === null
    && errorCode === "OTHER" && !stdoutLimitExceeded && !stderrLimitExceeded && !timedOut && !drainComplete;
  if (!refusal && !normalExit && !signaled && !timed && !capped && !conservativeUnknown) return unknown();
  return {
    childStartState, exitStatus: exitStatus as number | null, signal: signal as string | null,
    errorCode: errorCode as string | null, stdoutLimitExceeded, stderrLimitExceeded, timedOut, drainComplete, valid: true,
  };
}

function validateRequest(request: OuterHarnessRequest09): CeremonyDefinition09 {
  const definition = DEFINITIONS[request.ceremony];
  if (!definition || !isAbsolute(request.evidenceRoot) || !IDENTIFIER.test(request.attemptId)
    || !exactKeys(request as unknown as Record<string, unknown>, ["attemptId", "ceremony", "evidenceRoot"])) {
    throw new Error("M4F_OUTER_HARNESS_09_REQUEST_INVALID");
  }
  requireOwnedMode(request.evidenceRoot, 0o700);
  return definition;
}

function publisherHooks(kind: "Marker" | "Result" | "Finalization", faults: OuterHarnessFaults09): PublishHooks09 {
  return {
    beforeTempWrite: faults[`before${kind}TempWrite`], afterTempWrite: faults[`after${kind}TempWrite`],
    afterTempFsync: faults[`after${kind}TempFsync`], beforeLink: faults[`before${kind}Link`],
    afterLink: faults[`after${kind}Link`], afterDirectoryFsync: faults[`after${kind}DirectoryFsync`],
  };
}

function precheckFailure(attemptDirectory: string, attemptId: string): void {
  publishDurableNoReplace(join(attemptDirectory, "precheck-failure.json"), {
    schema: "synthia-m4f-outer-harness-precheck-failure-09.v1", attempt_id: attemptId,
    launch_invoked: false, child_start_state: "not_started_proven", effect_state: "not_started",
    retry_permitted: false, code: "M4F_OUTER_HARNESS_09_PRECHECK_FAILED",
  });
}

export async function runOuterHarness09(
  request: OuterHarnessRequest09,
  faults: OuterHarnessFaults09 = {},
  runtime: OuterHarnessRuntime09 = defaultRuntime,
): Promise<OuterHarnessResult09> {
  const definition = validateRequest(request);
  const attemptDirectory = join(request.evidenceRoot, request.attemptId);
  faults.beforeAttemptDirectory?.();
  mkdirSync(attemptDirectory, { mode: 0o700 });
  requireOwnedMode(attemptDirectory, 0o700);
  syncDirectory(request.evidenceRoot);
  faults.afterAttemptDirectorySync?.();
  const markerPath = join(attemptDirectory, "attempt.json");
  const resultPath = join(attemptDirectory, "child-result.json");
  const finalizationPath = join(attemptDirectory, "finalization.json");
  const stdoutPath = join(attemptDirectory, "child.stdout");
  const stderrPath = join(attemptDirectory, "child.stderr");
  let verified: VerifiedAuthority09;
  try { verified = verifyStaticPins(); }
  catch { precheckFailure(attemptDirectory, request.attemptId); throw new Error("M4F_OUTER_HARNESS_09_PRECHECK_FAILED"); }

  const stdoutDescriptor = openSync(stdoutPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let stderrDescriptor: number | null = null;
  let stdoutClosed = false;
  let stderrClosed = false;
  try {
    fchmodSync(stdoutDescriptor, 0o600);
    fsyncSync(stdoutDescriptor);
    faults.afterStdoutCreate?.();
    stderrDescriptor = openSync(stderrPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    fchmodSync(stderrDescriptor, 0o600);
    fsyncSync(stderrDescriptor);
    faults.afterStderrCreate?.();
    syncDirectory(attemptDirectory);
    const argv = [process.execPath, definition.sourcePath];
    publishDurableNoReplace(markerPath, {
      schema: "synthia-m4f-outer-harness-attempt-09.v1", attempt_id: request.attemptId, state: "launching",
      invocation_count: 1, retry_permitted: false, effect_state_if_incomplete: "unknown", ceremony: request.ceremony,
      phase: definition.phase, cwd_sha256: sha256(CONNECTOR_DIRECTORY), argv_count: argv.length,
      argv_sha256: sha256(JSON.stringify(argv)), confirmation_env_name: definition.confirmationEnvName,
      confirmation_token_id: definition.confirmationTokenId, confirmation_token_sha256: sha256(definition.confirmationEnvValue),
      pins_manifest_sha256: verified.manifestSha256, verified_pins: verified.pins, started_utc: new Date().toISOString(),
    }, publisherHooks("Marker", faults));
    faults.beforeLaunch?.();
    const rawOutcome = await runtime.runChild({
      executable: process.execPath, args: [definition.sourcePath], cwd: CONNECTOR_DIRECTORY,
      env: { [definition.confirmationEnvName]: definition.confirmationEnvValue }, stdoutDescriptor, stderrDescriptor,
    });
    const child = sanitizeChildOutcome(rawOutcome);
    faults.afterChildCloseBeforeStreamFsync?.();
    faults.beforeStdoutFsync?.();
    fsyncSync(stdoutDescriptor);
    closeSync(stdoutDescriptor);
    stdoutClosed = true;
    faults.beforeStderrFsync?.();
    fsyncSync(stderrDescriptor);
    closeSync(stderrDescriptor);
    stderrClosed = true;
    const stdout = fileFact(stdoutPath, MAX_STREAM_BYTES);
    const stderr = fileFact(stderrPath, MAX_STREAM_BYTES);
    const outcomeAmbiguous = !child.valid || child.childStartState !== "started" || child.exitStatus === null
      || child.signal !== null || child.errorCode !== null || child.stdoutLimitExceeded || child.stderrLimitExceeded
      || child.timedOut || !child.drainComplete || stdout.sha256 === ZERO_HASH || stderr.sha256 === ZERO_HASH;
    publishDurableNoReplace(resultPath, {
      schema: "synthia-m4f-outer-harness-child-result-09.v1", attempt_id: request.attemptId, launch_invoked: true,
      child_start_state: child.childStartState, child_exit_status: child.exitStatus, child_signal: child.signal,
      child_error_code: child.errorCode, stdout_limit_exceeded: child.stdoutLimitExceeded,
      stderr_limit_exceeded: child.stderrLimitExceeded, timed_out: child.timedOut, drain_complete: child.drainComplete,
      outcome_ambiguous: outcomeAmbiguous, effect_state: "unknown", retry_permitted: false,
      stdout_length: stdout.length, stdout_sha256: stdout.sha256, stderr_length: stderr.length,
      stderr_sha256: stderr.sha256, finished_utc: new Date().toISOString(),
    }, publisherHooks("Result", faults));
    const marker = fileFact(markerPath);
    const childResult = fileFact(resultPath);
    const finalStdout = fileFact(stdoutPath, MAX_STREAM_BYTES);
    const finalStderr = fileFact(stderrPath, MAX_STREAM_BYTES);
    publishDurableNoReplace(finalizationPath, {
      schema: "synthia-m4f-outer-harness-finalization-09.v1", attempt_id: request.attemptId, state: "finalized",
      finalization_exit_code: 0, attempt: marker, child_result: childResult, stdout: finalStdout, stderr: finalStderr,
      pins_manifest_sha256: verified.manifestSha256, finalized_utc: new Date().toISOString(),
    }, publisherHooks("Finalization", faults));
    return { attemptDirectory, markerPath, resultPath, finalizationPath, outerExitCode: 0 };
  } finally {
    if (!stdoutClosed) { try { closeSync(stdoutDescriptor); } catch { /* preserve earlier failure */ } }
    if (stderrDescriptor !== null && !stderrClosed) { try { closeSync(stderrDescriptor); } catch { /* preserve earlier failure */ } }
  }
}

function canonicalJson(path: string, maximum = 4 * 1024 * 1024): Record<string, unknown> | null {
  try {
    const facts = lstatSync(path);
    if (!facts.isFile() || facts.isSymbolicLink() || facts.uid !== (process.getuid?.() ?? -1)
      || (facts.mode & 0o777) !== 0o600 || facts.size < 1 || facts.size > maximum) return null;
    const bytes = readFileSync(path);
    if (bytes.length !== facts.size) return null;
    const value = JSON.parse(bytes.toString("utf8"));
    const item = record(value);
    if (!item || `${JSON.stringify(value)}\n` !== bytes.toString("utf8")) return null;
    return item;
  } catch { return null; }
}

function exactEvidenceFact(path: string, maximum = Number.MAX_SAFE_INTEGER): FilePin09 {
  const facts = lstatSync(path);
  if (!facts.isFile() || facts.isSymbolicLink() || facts.uid !== (process.getuid?.() ?? -1)
    || (facts.mode & 0o777) !== 0o600 || !Number.isSafeInteger(facts.size) || facts.size < 0 || facts.size > maximum) {
    throw new Error("M4F_OUTER_HARNESS_09_EVIDENCE_FILE_INVALID");
  }
  const bytes = readFileSync(path);
  if (bytes.length !== facts.size) throw new Error("M4F_OUTER_HARNESS_09_EVIDENCE_FILE_CHANGED");
  return { length: bytes.length, sha256: sha256(bytes) };
}

function utcMilliseconds(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null;
  return milliseconds;
}

interface ValidatedMarker09 {
  item: Record<string, unknown>;
  attemptId: string;
  manifestSha256: string;
  startedMilliseconds: number;
}

function validateRetainedMarker09(attemptDirectory: string, markerPath: string): ValidatedMarker09 | null {
  const item = canonicalJson(markerPath);
  if (!item || !exactKeys(item, [
    "argv_count", "argv_sha256", "attempt_id", "ceremony", "confirmation_env_name", "confirmation_token_id",
    "confirmation_token_sha256", "cwd_sha256", "effect_state_if_incomplete", "invocation_count", "phase",
    "pins_manifest_sha256", "retry_permitted", "schema", "started_utc", "state", "verified_pins",
  ])) return null;
  const attemptId = basename(attemptDirectory);
  const ceremony = item.ceremony;
  const definition = ceremony === "diagnostic" || ceremony === "parse" ? DEFINITIONS[ceremony] : null;
  const startedMilliseconds = utcMilliseconds(item.started_utc);
  if (!definition || !IDENTIFIER.test(attemptId) || item.schema !== "synthia-m4f-outer-harness-attempt-09.v1"
    || item.attempt_id !== attemptId || item.state !== "launching" || item.invocation_count !== 1
    || item.retry_permitted !== false || item.effect_state_if_incomplete !== "unknown"
    || item.phase !== definition.phase || item.cwd_sha256 !== sha256(CONNECTOR_DIRECTORY)
    || item.argv_count !== 2 || item.argv_sha256 !== sha256(JSON.stringify([process.execPath, definition.sourcePath]))
    || item.confirmation_env_name !== definition.confirmationEnvName
    || item.confirmation_token_id !== definition.confirmationTokenId
    || item.confirmation_token_sha256 !== sha256(definition.confirmationEnvValue)
    || startedMilliseconds === null) return null;
  try {
    const authority = readAuthorityPayload();
    const expectedPins = {
      files: authority.payload.files,
      artifacts: authority.payload.artifacts,
      runtime: authority.payload.runtime,
    };
    if (item.pins_manifest_sha256 !== authority.manifestSha256
      || JSON.stringify(item.verified_pins) !== JSON.stringify(expectedPins)) return null;
    return { item, attemptId, manifestSha256: authority.manifestSha256, startedMilliseconds };
  } catch {
    return null;
  }
}

interface ValidatedResult09 {
  item: Record<string, unknown>;
  finishedMilliseconds: number;
  stdout: FilePin09;
  stderr: FilePin09;
}

function validateRetainedResult09(
  attemptDirectory: string,
  resultPath: string,
  marker: ValidatedMarker09,
): ValidatedResult09 | null {
  const item = canonicalJson(resultPath);
  if (!item || !exactKeys(item, [
    "attempt_id", "child_error_code", "child_exit_status", "child_signal", "child_start_state", "drain_complete",
    "effect_state", "finished_utc", "launch_invoked", "outcome_ambiguous", "retry_permitted", "schema",
    "stderr_length", "stderr_limit_exceeded", "stderr_sha256", "stdout_length", "stdout_limit_exceeded",
    "stdout_sha256", "timed_out",
  ]) || item.schema !== "synthia-m4f-outer-harness-child-result-09.v1" || item.attempt_id !== marker.attemptId
    || item.launch_invoked !== true || item.retry_permitted !== false || item.effect_state !== "unknown") return null;
  const finishedMilliseconds = utcMilliseconds(item.finished_utc);
  if (finishedMilliseconds === null || finishedMilliseconds < marker.startedMilliseconds) return null;
  try {
    const stdout = exactEvidenceFact(join(attemptDirectory, "child.stdout"), MAX_STREAM_BYTES);
    const stderr = exactEvidenceFact(join(attemptDirectory, "child.stderr"), MAX_STREAM_BYTES);
    if (item.stdout_length !== stdout.length || item.stdout_sha256 !== stdout.sha256
      || item.stderr_length !== stderr.length || item.stderr_sha256 !== stderr.sha256) return null;
    const sanitized = sanitizeChildOutcome({
      childStartState: item.child_start_state,
      exitStatus: item.child_exit_status,
      signal: item.child_signal,
      errorCode: item.child_error_code,
      stdoutLimitExceeded: item.stdout_limit_exceeded,
      stderrLimitExceeded: item.stderr_limit_exceeded,
      timedOut: item.timed_out,
      drainComplete: item.drain_complete,
    });
    if (!sanitized.valid) return null;
    const expectedAmbiguous = sanitized.childStartState !== "started" || sanitized.exitStatus === null
      || sanitized.signal !== null || sanitized.errorCode !== null || sanitized.stdoutLimitExceeded
      || sanitized.stderrLimitExceeded || sanitized.timedOut || !sanitized.drainComplete;
    if (item.outcome_ambiguous !== expectedAmbiguous) return null;
    return { item, finishedMilliseconds, stdout, stderr };
  } catch {
    return null;
  }
}

export function classifyAttemptEvidence09(attemptDirectory: string): OuterHarnessRecoveryState09 {
  if (!existsSync(attemptDirectory)) return "absent_retry_safe";
  try { requireOwnedMode(attemptDirectory, 0o700); } catch { return "unknown_no_retry"; }
  const markerPath = join(attemptDirectory, "attempt.json");
  const resultPath = join(attemptDirectory, "child-result.json");
  const finalizationPath = join(attemptDirectory, "finalization.json");
  const precheckPath = join(attemptDirectory, "precheck-failure.json");
  if (!existsSync(markerPath) && !existsSync(resultPath) && !existsSync(finalizationPath)) {
    const failure = canonicalJson(precheckPath);
    if (failure && exactKeys(failure, [
      "attempt_id", "child_start_state", "code", "effect_state", "launch_invoked", "retry_permitted", "schema",
    ]) && failure.schema === "synthia-m4f-outer-harness-precheck-failure-09.v1" && failure.attempt_id === basename(attemptDirectory)
      && failure.launch_invoked === false && failure.child_start_state === "not_started_proven"
      && failure.effect_state === "not_started" && failure.retry_permitted === false
      && failure.code === "M4F_OUTER_HARNESS_09_PRECHECK_FAILED") return "precheck_failed_not_started_no_retry";
    return "unknown_no_retry";
  }
  const marker = validateRetainedMarker09(attemptDirectory, markerPath);
  if (!marker) return "unknown_no_retry";
  const result = validateRetainedResult09(attemptDirectory, resultPath, marker);
  if (!result) return "unknown_no_retry";
  try {
    if (!existsSync(finalizationPath)) return "result_complete_unfinalized_no_retry";
    const finalization = canonicalJson(finalizationPath);
    const finalizedMilliseconds = finalization ? utcMilliseconds(finalization.finalized_utc) : null;
    if (!finalization || !exactKeys(finalization, [
        "attempt", "attempt_id", "child_result", "finalization_exit_code", "finalized_utc", "pins_manifest_sha256",
        "schema", "state", "stderr", "stdout",
      ]) || finalization.schema !== "synthia-m4f-outer-harness-finalization-09.v1"
      || finalization.attempt_id !== marker.attemptId || finalization.state !== "finalized"
      || finalization.finalization_exit_code !== 0 || finalizedMilliseconds === null
      || finalizedMilliseconds < result.finishedMilliseconds
      || JSON.stringify(finalization.attempt) !== JSON.stringify(fileFact(markerPath))
      || JSON.stringify(finalization.child_result) !== JSON.stringify(fileFact(resultPath))
      || JSON.stringify(finalization.stdout) !== JSON.stringify(result.stdout)
      || JSON.stringify(finalization.stderr) !== JSON.stringify(result.stderr)
      || finalization.pins_manifest_sha256 !== marker.manifestSha256) return "unknown_no_retry";
    return "finalized_no_retry";
  } catch {
    return "unknown_no_retry";
  }
}

function parseCli(args: readonly string[]): OuterHarnessRequest09 {
  if (args.length !== 3) throw new Error("M4F_OUTER_HARNESS_09_ARGUMENTS_INVALID");
  return { evidenceRoot: args[0]!, attemptId: args[1]!, ceremony: args[2] as OuterHarnessCeremony09 };
}

export function reportOuterHarnessResult09(
  result: OuterHarnessResult09,
  write: (value: string) => unknown = (value) => process.stdout.write(value),
): void {
  write(`${JSON.stringify({
    schema: "synthia-m4f-outer-harness-report-09.v1", attempt_id: basename(result.attemptDirectory),
    outer_exit_code: result.outerExitCode, retry_permitted: false,
  })}\n`);
}

if (import.meta.main) {
  try { const result = await runOuterHarness09(parseCli(process.argv.slice(2))); reportOuterHarnessResult09(result); }
  catch {
    process.stderr.write('{"schema":"synthia-m4f-outer-harness-failure-09.v1","code":"M4F_OUTER_HARNESS_09_FAILED","retry_permitted":false}\n');
    process.exitCode = 1;
  }
}
