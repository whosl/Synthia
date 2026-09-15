import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA,
  canonicalEvolutionEvalHash,
  canonicalEvolutionEvalJson,
  evolutionEvalBindingFingerprint,
  evolutionEvalDiscardAuthorizationHash,
  type CoreIssuedEvalBinding,
  type EvalLedgerQuery,
  type EvolutionEvalExecutionState,
  type EvolutionEvalTerminalState,
  validateCoreIssuedEvalBinding,
  validateEvalLedgerQuery,
} from "./evolution-eval.ts";

const METADATA_SCHEMA = "evolution-eval-ledger-metadata.v2" as const;
const INDEX_SCHEMA = "evolution-eval-ledger-binding-index.v1" as const;
const RESERVATION_SCHEMA = "evolution-eval-ledger-reservation.v2" as const;
const ACCEPTANCE_HEAD_SCHEMA = "evolution-eval-ledger-acceptance-head.v1" as const;
const ACCEPTANCE_SCHEMA = "evolution-eval-ledger-acceptance.v2" as const;
const PROCESS_SCHEMA = "evolution-eval-ledger-process.v1" as const;
const STOP_INTENT_SCHEMA = "evolution-eval-ledger-stop-intent.v1" as const;
const OUTPUT_SCHEMA = "evolution-eval-ledger-output.v1" as const;
const ACK_SCHEMA = "evolution-eval-ledger-evidence-ack.v1" as const;
const QUARANTINE_SCHEMA = "evolution-eval-ledger-evidence-quarantine.v1" as const;
const EXPIRED_SCHEMA = "evolution-eval-ledger-evidence-expired.v1" as const;
const DISCARD_SCHEMA = "evolution-eval-ledger-evidence-discard.v1" as const;
const CLEANUP_SCHEMA = "evolution-eval-ledger-evidence-cleanup.v1" as const;
const PROCESS_EXIT_SCHEMA = "evolution-eval-ledger-process-exit.v1" as const;
const PROCESS_EXIT_HEAD_SCHEMA = "evolution-eval-ledger-process-exit-head.v1" as const;
const TERMINAL_HEAD_SCHEMA = "evolution-eval-ledger-terminal-head.v1" as const;
const TERMINAL_SCHEMA = "evolution-eval-ledger-terminal.v2" as const;
const MAX_FACT_BYTES = 1024 * 1024;
const EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
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
      SYNTHIA_EVOLUTION_MOVE_MUTEX: `Local\\SynthiaEvolutionMove-${createHash("sha256").update(target).digest("hex")}`,
    },
  });
  if (!result.error && result.stderr.trim() === "" && result.status === 0) {
    let sourceAbsent = false;
    try { lstatSync(source); } catch (error) { sourceAbsent = isErrno(error, "ENOENT"); }
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
  throw new LedgerUnavailableError(`MoveFileExW failed: ${result.stderr.trim() || result.error?.message || result.status}`);
}

const ERROR = Object.freeze({
  corrupt: "EVOLUTION_EVAL_LEDGER_CORRUPT",
  epochMismatch: "EVOLUTION_EVAL_LEDGER_EPOCH_MISMATCH",
  unavailable: "EVOLUTION_EVAL_LEDGER_UNAVAILABLE",
  bindingConflict: "EVOLUTION_EVAL_BINDING_CONFLICT",
  reservationConflict: "EVOLUTION_EVAL_LEDGER_RESERVATION_CONFLICT",
  acceptanceWithoutReservation: "EVOLUTION_EVAL_LEDGER_ACCEPTANCE_WITHOUT_RESERVATION",
  terminalWithoutAcceptance: "EVOLUTION_EVAL_LEDGER_TERMINAL_WITHOUT_ACCEPTANCE",
  terminalConflict: "EVOLUTION_EVAL_LEDGER_TERMINAL_CONFLICT",
  ownerMismatch: "EVOLUTION_EVAL_EFFECT_OWNER_MISMATCH",
  noProof: "EVOLUTION_EVAL_LEDGER_NO_PROOF",
});

type HashedFact<T> = T & { readonly fact_hash: string };

type LedgerMetadata = HashedFact<{
  readonly schema: typeof METADATA_SCHEMA;
  readonly ledger_epoch: string;
}>;

type BindingIndexFact = HashedFact<{
  readonly schema: typeof INDEX_SCHEMA;
  readonly ledger_epoch: string;
  readonly eval_job_id: string;
  readonly project_id: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly binding_fingerprint: string;
  readonly replay_permitted: boolean;
  readonly reserved_at: string;
  readonly reservation_fact_hash: string;
  readonly parent_fact_hash: string;
}>;

type ReservationFact = HashedFact<{
  readonly schema: typeof RESERVATION_SCHEMA;
  readonly ledger_epoch: string;
  readonly binding: CoreIssuedEvalBinding;
  readonly binding_fingerprint: string;
  readonly replay_permitted: boolean;
  readonly reserved_at: string;
  readonly parent_fact_hash: string;
}>;

type AcceptanceFact = HashedFact<{
  readonly schema: typeof ACCEPTANCE_SCHEMA;
  readonly ledger_epoch: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly binding_fingerprint: string;
  readonly execution_state: EvolutionEvalExecutionState;
  readonly accepted_at: string;
  readonly effect_owner_token_hash: string;
  readonly process_pid?: number;
  readonly process_group_id?: number;
  readonly process_start_token?: string;
  readonly parent_fact_hash: string;
}>;

type AcceptanceHeadFact = HashedFact<{
  readonly schema: typeof ACCEPTANCE_HEAD_SCHEMA;
  readonly ledger_epoch: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly binding_fingerprint: string;
  readonly execution_state: EvolutionEvalExecutionState;
  readonly accepted_at: string;
  readonly effect_owner_token_hash: string;
  readonly process_pid?: number;
  readonly process_group_id?: number;
  readonly process_start_token?: string;
  readonly parent_fact_hash: string;
  readonly acceptance_fact_hash: string;
}>;

type TerminalFact = HashedFact<{
  readonly schema: typeof TERMINAL_SCHEMA;
  readonly ledger_epoch: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly binding_fingerprint: string;
  readonly terminal_state: EvolutionEvalTerminalState;
  readonly process_stopped: true;
  readonly terminal_at: string;
  readonly error_code: string | null;
  readonly effect_owner_token_hash: string;
  readonly parent_fact_hash: string;
}>;

type ProcessFact = HashedFact<{
  readonly schema: typeof PROCESS_SCHEMA;
  readonly ledger_epoch: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly binding_fingerprint: string;
  readonly pid: number;
  readonly process_group_id: number;
  readonly process_start_token: string;
  readonly started_at: string;
  readonly effect_owner_token_hash: string;
  readonly parent_fact_hash: string;
}>;

type StopIntentFact = HashedFact<{
  readonly schema: typeof STOP_INTENT_SCHEMA;
  readonly ledger_epoch: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly binding_fingerprint: string;
  readonly reason: "cancelled" | "timeout";
  readonly requested_at: string;
  readonly effect_owner_token_hash: string;
  readonly parent_fact_hash: string;
}>;

type OutputFact = HashedFact<{
  readonly schema: typeof OUTPUT_SCHEMA;
  readonly ledger_epoch: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly binding_fingerprint: string;
  readonly spool_manifest_hash: string;
  readonly entry_count: number;
  readonly total_bytes: number;
  readonly retention_state: "pending_ack";
  readonly created_at: string;
  readonly effect_owner_token_hash: string;
  readonly parent_fact_hash: string;
}>;

type EvidenceAckFact = HashedFact<{
  readonly schema: typeof ACK_SCHEMA;
  readonly ledger_epoch: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly binding_fingerprint: string;
  readonly connector_manifest_hash: string;
  readonly core_manifest_hash: string;
  readonly core_ack_fact_hash: string;
  readonly acknowledged_at: string;
  readonly parent_fact_hash: string;
}>;

type EvidenceQuarantineFact = HashedFact<{
  readonly schema: typeof QUARANTINE_SCHEMA;
  readonly ledger_epoch: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly binding_fingerprint: string;
  readonly error_fact_hash: string;
  readonly core_quarantine_fact_hash: string;
  readonly quarantined_at: string;
  readonly delete_by: string;
  readonly parent_fact_hash: string;
}>;

type EvidenceExpiredFact = HashedFact<{
  readonly schema: typeof EXPIRED_SCHEMA;
  readonly ledger_epoch: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly binding_fingerprint: string;
  readonly manifest_hash: string;
  readonly terminal_fact_hash: string;
  readonly expired_at: string;
  readonly parent_fact_hash: string;
}>;

type EvidenceDiscardFact = HashedFact<{
  readonly schema: typeof DISCARD_SCHEMA;
  readonly ledger_epoch: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly binding_fingerprint: string;
  readonly reason: "unavailable_at_deadline" | "absolute_expiry";
  readonly core_conclusion_fact_hash: string;
  readonly core_cleanup_fact_hash: string;
  readonly discard_authorization_hash: string;
  readonly discarded_at: string;
  readonly parent_fact_hash: string;
}>;

type EvidenceCleanupFact = HashedFact<{
  readonly schema: typeof CLEANUP_SCHEMA;
  readonly ledger_epoch: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly binding_fingerprint: string;
  readonly authorization_fact_hash: string;
  readonly core_cleanup_fact_hash: string;
  readonly cleaned_at: string;
  readonly parent_fact_hash: string;
}>;

type ProcessExitFact = HashedFact<{
  readonly schema: typeof PROCESS_EXIT_SCHEMA;
  readonly ledger_epoch: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly binding_fingerprint: string;
  readonly pid: number;
  readonly process_group_id: number;
  readonly process_start_token: string;
  readonly stopped_at: string;
  readonly effect_owner_token_hash: string;
  readonly parent_fact_hash: string;
}>;

type ProcessExitHeadFact = HashedFact<{
  readonly schema: typeof PROCESS_EXIT_HEAD_SCHEMA;
  readonly ledger_epoch: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly binding_fingerprint: string;
  readonly effect_owner_token_hash: string;
  readonly parent_fact_hash: string;
  readonly process_exit_fact_hash: string;
}>;

type TerminalHeadFact = HashedFact<{
  readonly schema: typeof TERMINAL_HEAD_SCHEMA;
  readonly ledger_epoch: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly binding_fingerprint: string;
  readonly terminal_state: EvolutionEvalTerminalState;
  readonly process_stopped: true;
  readonly terminal_at: string;
  readonly error_code: string | null;
  readonly effect_owner_token_hash: string;
  readonly parent_fact_hash: string;
  readonly terminal_fact_hash: string;
}>;

export type EvolutionEvalLedgerFsOperation = "temp_write" | "file_fsync" | "link" | "directory_fsync";
export type EvolutionEvalLedgerFactKind =
  | "metadata"
  | "binding_index"
  | "reservation"
  | "acceptance_head"
  | "acceptance"
  | "process"
  | "stop_intent"
  | "output"
  | "evidence_ack"
  | "evidence_quarantine"
  | "evidence_expired"
  | "evidence_discard"
  | "evidence_cleanup"
  | "process_exit"
  | "process_exit_head"
  | "terminal_head"
  | "terminal";

export interface EvolutionEvalLedgerFaultPoint {
  readonly operation: EvolutionEvalLedgerFsOperation;
  readonly factKind: EvolutionEvalLedgerFactKind;
}

export interface FileEvolutionEvalLedgerOptions {
  readonly root: string;
  readonly ledgerEpoch: string;
  readonly now?: () => Date;
  /** Test/verification seam. Throwing simulates an I/O failure at the named durability boundary. */
  readonly faultInjector?: (point: EvolutionEvalLedgerFaultPoint) => void | Promise<void>;
}

export interface EvolutionEvalReservationOptions {
  readonly replayPermitted?: boolean;
}

export interface EvolutionEvalAcceptance {
  readonly executionState: EvolutionEvalExecutionState;
  readonly acceptedAt?: string;
  /** Inert guardian identity committed in the same acceptance fact/head. */
  readonly processIdentity?: EvolutionEvalProcessIdentity;
}

export interface EvolutionEvalAcceptanceResult {
  readonly observation: EvalLedgerQuery;
  readonly accepted_now: boolean;
  readonly effect_owner_token?: string;
}

export interface EvolutionEvalTerminal {
  readonly terminalState: EvolutionEvalTerminalState;
  readonly terminalAt?: string;
  readonly errorCode?: string | null;
}

export interface EvolutionEvalProcessIdentity {
  readonly pid: number;
  readonly processGroupId: number;
  readonly startToken: string;
}

export type EvolutionEvalStopObservation =
  | { readonly state: "absent" }
  | { readonly state: "stop_requested"; readonly reason: "cancelled" | "timeout" }
  | { readonly state: "unavailable" }
  | { readonly state: "corrupt" };
export type EvolutionEvalOutputObservation =
  | { readonly state: "absent" }
  | { readonly state: "pending_ack"; readonly totalBytes: number }
  | { readonly state: "unavailable" }
  | { readonly state: "corrupt" };
export type EvolutionEvalRetentionObservation =
  | { readonly state: "absent" }
  | { readonly state: "pending_ack"; readonly manifestHash: string; readonly totalBytes: number }
  | { readonly state: "acknowledged"; readonly manifestHash: string; readonly coreManifestHash: string; readonly authorizationHash: string; readonly factHash: string; readonly acknowledgedAt: string }
  | { readonly state: "quarantined"; readonly errorFactHash: string; readonly authorizationHash: string; readonly factHash: string; readonly quarantinedAt: string; readonly deleteBy: string }
  | { readonly state: "expired"; readonly manifestHash: string; readonly factHash: string; readonly expiredAt: string }
  | { readonly state: "discarded"; readonly reason: "unavailable_at_deadline" | "absolute_expiry"; readonly authorizationHash: string; readonly coreConclusionFactHash: string; readonly cleanupAuthorizationHash: string; readonly factHash: string; readonly discardedAt: string }
  | { readonly state: "cleaned"; readonly authorizationFactHash: string; readonly authorizationHash: string; readonly sourceKind: "ack" | "quarantine" | "expiry" | "discard"; readonly sourceAuthorizationHash: string; readonly sourceConnectorManifestHash: string | null; readonly sourceCoreManifestHash: string | null; readonly sourceErrorFactHash: string | null; readonly factHash: string; readonly cleanedAt: string }
  | { readonly state: "unavailable" }
  | { readonly state: "corrupt" };

export interface EvolutionEvalLedger {
  readonly ledgerEpoch: string;
  query(binding: CoreIssuedEvalBinding): Promise<EvalLedgerQuery>;
  queryOrReserve(binding: CoreIssuedEvalBinding, options?: EvolutionEvalReservationOptions): Promise<EvalLedgerQuery>;
  markAccepted(binding: CoreIssuedEvalBinding, acceptance: EvolutionEvalAcceptance): Promise<EvolutionEvalAcceptanceResult>;
  markProcessStarted(binding: CoreIssuedEvalBinding, identity: EvolutionEvalProcessIdentity, effectOwnerToken: string): Promise<boolean>;
  getProcessIdentity(binding: CoreIssuedEvalBinding): Promise<EvolutionEvalProcessIdentity | null>;
  getStopObservation(binding: CoreIssuedEvalBinding): Promise<EvolutionEvalStopObservation>;
  getOutputObservation(binding: CoreIssuedEvalBinding): Promise<EvolutionEvalOutputObservation>;
  getRetentionObservation(binding: CoreIssuedEvalBinding): Promise<EvolutionEvalRetentionObservation>;
  markEvidenceAcknowledged(binding: CoreIssuedEvalBinding, input: { readonly connectorManifestHash: string; readonly coreManifestHash: string; readonly coreAckFactHash: string }): Promise<EvolutionEvalRetentionObservation>;
  markEvidenceQuarantined(binding: CoreIssuedEvalBinding, input: { readonly errorFactHash: string; readonly coreQuarantineFactHash: string }): Promise<EvolutionEvalRetentionObservation>;
  markEvidenceExpired(binding: CoreIssuedEvalBinding): Promise<EvolutionEvalRetentionObservation>;
  markEvidenceDiscarded(binding: CoreIssuedEvalBinding, input: ({ readonly reason: "unavailable_at_deadline" } | { readonly reason: "absolute_expiry"; readonly coreManifestHash: string }) & { readonly coreConclusionFactHash: string; readonly coreCleanupFactHash: string; readonly discardAuthorizationHash: string }): Promise<EvolutionEvalRetentionObservation>;
  markEvidenceCleaned(binding: CoreIssuedEvalBinding, authorizationFactHash: string, coreCleanupFactHash: string): Promise<EvolutionEvalRetentionObservation>;
  markStopRequested(binding: CoreIssuedEvalBinding, reason: "cancelled" | "timeout", effectOwnerToken?: string): Promise<boolean>;
  markTerminalAfterConfirmedStop(binding: CoreIssuedEvalBinding, terminalState: "cancelled" | "timeout", errorCode: string): Promise<EvalLedgerQuery>;
  markOutput(binding: CoreIssuedEvalBinding, output: { readonly spoolManifestHash: string; readonly entryCount: number; readonly totalBytes: number }, effectOwnerToken: string): Promise<boolean>;
  markProcessExitConfirmed(binding: CoreIssuedEvalBinding, identity: EvolutionEvalProcessIdentity, effectOwnerToken?: string): Promise<boolean>;
  markTerminal(
    binding: CoreIssuedEvalBinding,
    terminal: EvolutionEvalTerminal,
    effectOwnerToken: string,
  ): Promise<EvalLedgerQuery>;
}

class LedgerCorruptError extends Error {}
class LedgerEpochMismatchError extends Error {}
class LedgerUnavailableError extends Error {}
class LedgerBindingConflictError extends Error {}
class LedgerReservationConflictError extends Error {}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  if (own.some((key) => typeof key !== "string")) return false;
  const actual = (own as string[]).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function rawSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashedFact<T extends Record<string, unknown>>(payload: T): HashedFact<T> {
  return { ...payload, fact_hash: canonicalEvolutionEvalHash(payload) };
}

function verifiedFact(value: unknown, keysWithoutHash: readonly string[]): Record<string, unknown> {
  if (!plain(value) || !exact(value, [...keysWithoutHash, "fact_hash"]) || !validHash(value.fact_hash)) {
    throw new LedgerCorruptError();
  }
  const payload: Record<string, unknown> = {};
  for (const key of keysWithoutHash) payload[key] = value[key];
  if (canonicalEvolutionEvalHash(payload) !== value.fact_hash) throw new LedgerCorruptError();
  return value;
}

function common(binding: CoreIssuedEvalBinding, epoch: string) {
  return {
    schema: EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA,
    connector_job_id: binding.dispatch.connector_job_id,
    connector_idempotency_key: binding.dispatch.connector_idempotency_key,
    dispatch_request_hash: binding.dispatch_request_hash,
    ledger_epoch: epoch,
  } as const;
}

function corrupt(binding: CoreIssuedEvalBinding, epoch: string, errorCode: string = ERROR.corrupt): EvalLedgerQuery {
  return {
    ...common(binding, epoch),
    state: "ledger_corrupt",
    replay_permitted: false,
    error_code: errorCode,
  };
}

function unavailable(binding: CoreIssuedEvalBinding, epoch: string): EvalLedgerQuery {
  return {
    ...common(binding, epoch),
    state: "transient_unavailable",
    retryable: true,
    error_code: ERROR.unavailable,
  };
}

function noProof(binding: CoreIssuedEvalBinding, epoch: string): EvalLedgerQuery {
  return {
    ...common(binding, epoch),
    state: "ambiguous",
    effect_possible: true,
    error_code: ERROR.noProof,
  };
}

function acceptanceResult(observation: EvalLedgerQuery): EvolutionEvalAcceptanceResult {
  return { observation, accepted_now: false };
}

/** Content-free stable key used for file names; it never exposes a Core identifier. */
export function evolutionEvalLedgerRecordKey(identifier: string): string {
  return rawSha256(identifier);
}

export class FileEvolutionEvalLedger implements EvolutionEvalLedger {
  private readonly root: string;
  private readonly facts: string;
  private readonly heads: string;
  private readonly indexes: string;
  private readonly clock: () => Date;
  private readonly faultInjector?: FileEvolutionEvalLedgerOptions["faultInjector"];
  private readonly locks = new Map<string, Promise<void>>();
  private initializationError?: string;

  private constructor(options: FileEvolutionEvalLedgerOptions) {
    this.root = resolve(options.root);
    this.facts = join(this.root, "facts");
    this.heads = join(this.root, "heads");
    this.indexes = join(this.root, "indexes");
    this.ledgerEpoch = options.ledgerEpoch;
    this.clock = options.now ?? (() => new Date());
    this.faultInjector = options.faultInjector;
  }

  readonly ledgerEpoch: string;

  /** Create a brand-new ledger. Existing or non-empty roots must use `reopen`. */
  static async initialize(options: FileEvolutionEvalLedgerOptions): Promise<FileEvolutionEvalLedger> {
    const ledger = new FileEvolutionEvalLedger(options);
    if (!EPOCH_PATTERN.test(options.ledgerEpoch)) throw new TypeError("ledgerEpoch is invalid");
    try {
      await mkdir(ledger.root, { recursive: true, mode: 0o700 });
      // Persist the new ledger-root directory entry itself. Syncing files and
      // directories below the root cannot make an un-synced parent entry
      // survive a host crash.
      await ledger.syncDirectory(dirname(ledger.root));
      await ledger.assertDirectory(ledger.root);
      if ((await readdir(ledger.root)).length !== 0) throw new LedgerCorruptError();
      const metadata = ledger.makeMetadata();
      const created = await ledger.atomicCreate(
        join(ledger.root, "ledger.json"),
        metadata,
        "metadata",
        dirname(ledger.root),
      );
      if (!created) throw new LedgerCorruptError();
      await mkdir(ledger.facts, { mode: 0o700 });
      await mkdir(ledger.heads, { mode: 0o700 });
      await mkdir(ledger.indexes, { mode: 0o700 });
      await ledger.syncDirectory(ledger.root);
    } catch (error) {
      ledger.initializationError = ledger.initializationCode(error);
    }
    return ledger;
  }

  /** Open an existing ledger. This method never creates or repairs metadata/layout. */
  static async reopen(options: FileEvolutionEvalLedgerOptions): Promise<FileEvolutionEvalLedger> {
    const ledger = new FileEvolutionEvalLedger(options);
    if (!EPOCH_PATTERN.test(options.ledgerEpoch)) throw new TypeError("ledgerEpoch is invalid");
    try {
      await ledger.validateLayout();
    } catch (error) {
      ledger.initializationError = ledger.initializationCode(error);
    }
    return ledger;
  }

  async query(input: CoreIssuedEvalBinding): Promise<EvalLedgerQuery> {
    const binding = validateCoreIssuedEvalBinding(input);
    return this.exclusive(binding.dispatch.connector_job_id, () => this.queryUnlocked(binding));
  }

  async queryOrReserve(
    input: CoreIssuedEvalBinding,
    options: EvolutionEvalReservationOptions = {},
  ): Promise<EvalLedgerQuery> {
    const binding = validateCoreIssuedEvalBinding(input);
    const replayPermitted = options.replayPermitted ?? true;
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.queryUnlocked(binding);
      if (before.state === "proven_never_accepted") {
        return before.replay_permitted === replayPermitted
          ? before
          : corrupt(binding, this.ledgerEpoch, ERROR.reservationConflict);
      }
      if (before.state === "accepted" || before.state === "terminal" || before.state === "transient_unavailable") {
        return before;
      }
      if (before.state === "ledger_corrupt") return before;
      if (before.state === "ambiguous" && before.error_code !== ERROR.noProof) return before;
      try {
        await this.ensureReservation(binding, replayPermitted);
        return await this.queryUnlocked(binding);
      } catch (error) {
        return this.errorObservation(binding, error);
      }
    });
  }

  async markAccepted(
    input: CoreIssuedEvalBinding,
    acceptance: EvolutionEvalAcceptance,
  ): Promise<EvolutionEvalAcceptanceResult> {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!(["queued", "preparing", "running"] as const).includes(acceptance.executionState)) {
      throw new TypeError("executionState is invalid");
    }
    if (acceptance.acceptedAt !== undefined && !validTimestamp(acceptance.acceptedAt)) {
      throw new TypeError("acceptedAt is invalid");
    }
    if (acceptance.processIdentity !== undefined && (!Number.isSafeInteger(acceptance.processIdentity.pid)
      || acceptance.processIdentity.pid < 1
      || !Number.isSafeInteger(acceptance.processIdentity.processGroupId)
      || acceptance.processIdentity.processGroupId < 1
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(acceptance.processIdentity.startToken))) {
      throw new TypeError("processIdentity is invalid");
    }
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.queryUnlocked(binding);
      if (before.state === "accepted" || before.state === "terminal" || before.state === "transient_unavailable") {
        return acceptanceResult(before);
      }
      if (before.state === "proven_never_accepted" && !before.replay_permitted) {
        return acceptanceResult(corrupt(binding, this.ledgerEpoch, ERROR.acceptanceWithoutReservation));
      }
      if (before.state === "ambiguous") {
        return acceptanceResult(corrupt(binding, this.ledgerEpoch, ERROR.acceptanceWithoutReservation));
      }
      if (before.state === "ledger_corrupt" && before.error_code !== ERROR.corrupt) {
        return acceptanceResult(before);
      }
      try {
        const ownership = await this.ensureAcceptance(binding, acceptance);
        const observation = await this.queryUnlocked(binding);
        if (
          ownership.createdHead
          && ownership.ownerToken !== undefined
          && observation.state === "accepted"
          && rawSha256(ownership.ownerToken) === ownership.head.effect_owner_token_hash
        ) {
          return { observation, accepted_now: true, effect_owner_token: ownership.ownerToken };
        }
        return acceptanceResult(observation);
      } catch (error) {
        return acceptanceResult(this.errorObservation(binding, error));
      }
    });
  }

  async markProcessStarted(
    input: CoreIssuedEvalBinding,
    identity: EvolutionEvalProcessIdentity,
    effectOwnerToken: string,
  ): Promise<boolean> {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!Number.isSafeInteger(identity.pid) || identity.pid < 1
      || !Number.isSafeInteger(identity.processGroupId) || identity.processGroupId < 1
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(identity.startToken)
      || !TOKEN_PATTERN.test(effectOwnerToken)) {
      throw new TypeError("process ownership is invalid");
    }
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        if (rawSha256(effectOwnerToken) !== acceptance.effect_owner_token_hash) throw new LedgerBindingConflictError(ERROR.ownerMismatch);
        if (acceptance.process_pid !== undefined && (acceptance.process_pid !== identity.pid
          || acceptance.process_group_id !== identity.processGroupId
          || acceptance.process_start_token !== identity.startToken)) throw new LedgerBindingConflictError();
        const planned = this.makeProcess(binding, acceptance, identity);
        await this.atomicCreate(this.factPath(binding, "process"), planned, "process");
        const stored = this.process(await this.readRequired(this.factPath(binding, "process")), binding, acceptance);
        if (stored.pid !== identity.pid || stored.process_group_id !== identity.processGroupId
          || stored.process_start_token !== identity.startToken) throw new LedgerBindingConflictError();
        const stopRaw = await this.readOptional(this.factPath(binding, "stop-intent"));
        if (stopRaw !== undefined) {
          this.stopIntent(stopRaw, binding, acceptance);
          return false;
        }
        return true;
      } catch {
        return false;
      }
    });
  }

  async getProcessIdentity(input: CoreIssuedEvalBinding): Promise<EvolutionEvalProcessIdentity | null> {
    const binding = validateCoreIssuedEvalBinding(input);
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const observation = await this.queryUnlocked(binding);
      if (observation.state !== "accepted") return null;
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        const processRaw = await this.readOptional(this.factPath(binding, "process"));
        if (processRaw === undefined && acceptance.process_pid !== undefined) {
          return {
            pid: acceptance.process_pid,
            processGroupId: acceptance.process_group_id!,
            startToken: acceptance.process_start_token!,
          };
        }
        const process = this.process(processRaw, binding, acceptance);
        return { pid: process.pid, processGroupId: process.process_group_id, startToken: process.process_start_token };
      } catch { return null; }
    });
  }

  async markStopRequested(
    input: CoreIssuedEvalBinding,
    reason: "cancelled" | "timeout",
    effectOwnerToken?: string,
  ): Promise<boolean> {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!(reason === "cancelled" || reason === "timeout")
      || (effectOwnerToken !== undefined && !TOKEN_PATTERN.test(effectOwnerToken))) {
      throw new TypeError("stop intent is invalid");
    }
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        if (effectOwnerToken !== undefined && rawSha256(effectOwnerToken) !== acceptance.effect_owner_token_hash) throw new LedgerBindingConflictError(ERROR.ownerMismatch);
        const planned = this.makeStopIntent(binding, acceptance, reason);
        const created = await this.atomicCreate(this.factPath(binding, "stop-intent"), planned, "stop_intent");
        const stored = this.stopIntent(await this.readRequired(this.factPath(binding, "stop-intent")), binding, acceptance);
        return created || stored.reason === reason;
      } catch {
        return false;
      }
    });
  }

  async getStopObservation(input: CoreIssuedEvalBinding): Promise<EvolutionEvalStopObservation> {
    const binding = validateCoreIssuedEvalBinding(input);
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        const raw = await this.readOptional(this.factPath(binding, "stop-intent"));
        return raw === undefined
          ? { state: "absent" }
          : { state: "stop_requested", reason: this.stopIntent(raw, binding, acceptance).reason };
      } catch (error) {
        return error instanceof LedgerUnavailableError || (error instanceof Error && "code" in error)
          ? { state: "unavailable" }
          : { state: "corrupt" };
      }
    });
  }

  async markTerminalAfterConfirmedStop(
    input: CoreIssuedEvalBinding,
    terminalState: "cancelled" | "timeout",
    errorCode: string,
  ): Promise<EvalLedgerQuery> {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!(terminalState === "cancelled" || terminalState === "timeout") || !ERROR_CODE_PATTERN.test(errorCode)) {
      throw new TypeError("confirmed stop terminal is invalid");
    }
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.queryUnlocked(binding);
      if (before.state === "terminal") return before;
      if (before.state !== "accepted") return before;
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        const stop = this.stopIntent(await this.readRequired(this.factPath(binding, "stop-intent")), binding, acceptance);
        if (stop.reason !== terminalState) throw new LedgerBindingConflictError();
        await this.ensureTerminal(binding, { terminalState, errorCode }, undefined, true);
        return this.queryUnlocked(binding);
      } catch (error) { return this.errorObservation(binding, error); }
    });
  }

  async markOutput(
    input: CoreIssuedEvalBinding,
    output: { readonly spoolManifestHash: string; readonly entryCount: number; readonly totalBytes: number },
    effectOwnerToken: string,
  ): Promise<boolean> {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!validHash(output.spoolManifestHash) || !Number.isSafeInteger(output.entryCount)
      || output.entryCount < 0 || output.entryCount > 128 || !Number.isSafeInteger(output.totalBytes)
      || output.totalBytes < 0 || output.totalBytes > 256 * 1024 * 1024 || !TOKEN_PATTERN.test(effectOwnerToken)) {
      throw new TypeError("output fact is invalid");
    }
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        if (rawSha256(effectOwnerToken) !== acceptance.effect_owner_token_hash) throw new LedgerBindingConflictError(ERROR.ownerMismatch);
        const process = this.process(await this.readRequired(this.factPath(binding, "process")), binding, acceptance);
        if (await this.readOptional(this.factPath(binding, "evidence-discard")) !== undefined) return false;
        const planned = this.makeOutput(binding, process, output);
        const created = await this.atomicCreate(this.factPath(binding, "output"), planned, "output");
        const stored = this.output(await this.readRequired(this.factPath(binding, "output")), binding, process);
        return created || (stored.spool_manifest_hash === output.spoolManifestHash
          && stored.entry_count === output.entryCount && stored.total_bytes === output.totalBytes);
      } catch {
        return false;
      }
    });
  }

  async getOutputObservation(input: CoreIssuedEvalBinding): Promise<EvolutionEvalOutputObservation> {
    const binding = validateCoreIssuedEvalBinding(input);
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        const process = this.process(await this.readRequired(this.factPath(binding, "process")), binding, acceptance);
        const raw = await this.readOptional(this.factPath(binding, "output"));
        if (raw === undefined) return { state: "absent" };
        const output = this.output(raw, binding, process);
        return { state: "pending_ack", totalBytes: output.total_bytes };
      } catch (error) {
        return error instanceof LedgerUnavailableError || (error instanceof Error && "code" in error)
          ? { state: "unavailable" }
          : { state: "corrupt" };
      }
    });
  }

  async getRetentionObservation(input: CoreIssuedEvalBinding): Promise<EvolutionEvalRetentionObservation> {
    const binding = validateCoreIssuedEvalBinding(input);
    return this.exclusive(binding.dispatch.connector_job_id, () => this.getRetentionObservationUnlocked(binding));
  }

  async markEvidenceAcknowledged(
    input: CoreIssuedEvalBinding,
    hashes: { readonly connectorManifestHash: string; readonly coreManifestHash: string; readonly coreAckFactHash: string },
  ): Promise<EvolutionEvalRetentionObservation> {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!validHash(hashes.connectorManifestHash) || !validHash(hashes.coreManifestHash)
      || !validHash(hashes.coreAckFactHash)) throw new TypeError("ack hashes are invalid");
    const expectedCoreAckFactHash = canonicalEvolutionEvalHash({
      schema: "evolution-eval-evidence-ack-intent.v1",
      eval_job_id: binding.dispatch.eval_job_id,
      manifest_hash: hashes.coreManifestHash,
    });
    if (hashes.coreAckFactHash !== expectedCoreAckFactHash) return { state: "corrupt" };
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.getRetentionObservationUnlocked(binding);
      if (before.state === "acknowledged") {
        return before.manifestHash === hashes.connectorManifestHash
          && before.coreManifestHash === hashes.coreManifestHash
          && before.authorizationHash === hashes.coreAckFactHash ? before : { state: "corrupt" };
      }
      if (before.state === "cleaned" && before.sourceKind === "ack") {
        return before.sourceConnectorManifestHash === hashes.connectorManifestHash
          && before.sourceCoreManifestHash === hashes.coreManifestHash
          && before.sourceAuthorizationHash === hashes.coreAckFactHash ? before : { state: "corrupt" };
      }
      if (before.state !== "pending_ack") return before.state === "absent" ? { state: "corrupt" } : before;
      if (before.manifestHash !== hashes.connectorManifestHash) return { state: "corrupt" };
      try {
        const { output } = await this.loadOutputChain(binding);
        await this.loadTerminalFact(binding);
        const planned = this.makeEvidenceAck(binding, output, hashes);
        await this.atomicCreate(this.factPath(binding, "evidence-ack"), planned, "evidence_ack");
        return this.getRetentionObservationUnlocked(binding);
      } catch (error) {
        return this.retentionErrorObservation(error);
      }
    });
  }

  async markEvidenceQuarantined(
    input: CoreIssuedEvalBinding,
    hashes: { readonly errorFactHash: string; readonly coreQuarantineFactHash: string },
  ): Promise<EvolutionEvalRetentionObservation> {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!validHash(hashes.errorFactHash) || !validHash(hashes.coreQuarantineFactHash)) throw new TypeError("quarantine hashes are invalid");
    const expectedCoreQuarantineFactHash = canonicalEvolutionEvalHash({
      schema: "evolution-eval-evidence-quarantine-intent.v1",
      eval_job_id: binding.dispatch.eval_job_id,
      error_fact_hash: hashes.errorFactHash,
    });
    if (hashes.coreQuarantineFactHash !== expectedCoreQuarantineFactHash) return { state: "corrupt" };
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.getRetentionObservationUnlocked(binding);
      if (before.state === "quarantined") {
        return before.errorFactHash === hashes.errorFactHash
          && before.authorizationHash === hashes.coreQuarantineFactHash ? before : { state: "corrupt" };
      }
      if (before.state === "cleaned" && before.sourceKind === "quarantine") {
        return before.sourceErrorFactHash === hashes.errorFactHash
          && before.sourceAuthorizationHash === hashes.coreQuarantineFactHash ? before : { state: "corrupt" };
      }
      if (before.state !== "pending_ack") return before.state === "absent" ? { state: "corrupt" } : before;
      try {
        const { output } = await this.loadOutputChain(binding);
        await this.loadTerminalFact(binding);
        const planned = this.makeEvidenceQuarantine(binding, output, hashes);
        await this.atomicCreate(this.factPath(binding, "evidence-quarantine"), planned, "evidence_quarantine");
        return this.getRetentionObservationUnlocked(binding);
      } catch (error) {
        return this.retentionErrorObservation(error);
      }
    });
  }

  async markEvidenceExpired(input: CoreIssuedEvalBinding): Promise<EvolutionEvalRetentionObservation> {
    const binding = validateCoreIssuedEvalBinding(input);
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.getRetentionObservationUnlocked(binding);
      if (before.state === "expired" || before.state === "cleaned") return before;
      if (before.state !== "pending_ack") return before.state === "absent" ? { state: "corrupt" } : before;
      try {
        const { output } = await this.loadOutputChain(binding);
        const terminal = await this.loadTerminalFact(binding);
        if (this.clock().getTime() < Date.parse(terminal.terminal_at) + 7 * 24 * 60 * 60 * 1000) {
          return before;
        }
        const planned = this.makeEvidenceExpired(binding, output, terminal);
        await this.atomicCreate(this.factPath(binding, "evidence-expired"), planned, "evidence_expired");
        return this.getRetentionObservationUnlocked(binding);
      } catch (error) {
        return this.retentionErrorObservation(error);
      }
    });
  }

  async markEvidenceDiscarded(
    input: CoreIssuedEvalBinding,
    discard: ({
      readonly reason: "unavailable_at_deadline";
    } | {
      readonly reason: "absolute_expiry";
      readonly coreManifestHash: string;
    }) & {
      readonly coreConclusionFactHash: string;
      readonly coreCleanupFactHash: string;
      readonly discardAuthorizationHash: string;
    },
  ): Promise<EvolutionEvalRetentionObservation> {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!validHash(discard.coreConclusionFactHash) || !validHash(discard.coreCleanupFactHash)
      || !validHash(discard.discardAuthorizationHash)) throw new TypeError("discard hashes are invalid");
    if (discard.reason === "absolute_expiry" && !validHash(discard.coreManifestHash)) {
      throw new TypeError("discard hashes are invalid");
    }
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      try {
        const before = await this.getRetentionObservationUnlocked(binding);
        if (before.state === "acknowledged" || before.state === "quarantined"
          || (before.state === "cleaned" && before.sourceKind !== "discard")) return { state: "corrupt" };
        const { reservation } = await this.loadReservationChain(binding);
        let expectedAuthorization: string;
        if (discard.reason === "unavailable_at_deadline") {
          if (this.clock().getTime() < Date.parse(binding.dispatch.deadline_at)) return { state: "corrupt" };
          const expectedConclusion = canonicalEvolutionEvalHash({
            schema: "evolution-eval-evidence-deadline.v1",
            eval_job_id: binding.dispatch.eval_job_id,
            deadline_at: binding.dispatch.deadline_at,
            error_code: "EVOLUTION_EVAL_EVIDENCE_UNAVAILABLE_AT_DEADLINE",
          });
          if (discard.coreConclusionFactHash !== expectedConclusion) return { state: "corrupt" };
          expectedAuthorization = evolutionEvalDiscardAuthorizationHash(binding, { reason: discard.reason });
        } else {
          const { output } = await this.loadOutputChain(binding);
          const terminal = await this.loadTerminalFact(binding);
          if (this.clock().getTime() < Date.parse(terminal.terminal_at) + 7 * 24 * 60 * 60 * 1000) {
            return { state: "corrupt" };
          }
          expectedAuthorization = evolutionEvalDiscardAuthorizationHash(binding, {
            reason: discard.reason,
            connectorManifestHash: output.spool_manifest_hash,
            terminalAt: terminal.terminal_at,
          });
          const expectedConclusion = canonicalEvolutionEvalHash({
            schema: "evolution-eval-evidence-expired.v1",
            eval_job_id: binding.dispatch.eval_job_id,
            manifest_hash: discard.coreManifestHash,
            terminal_at: terminal.terminal_at,
          });
          if (discard.coreConclusionFactHash !== expectedConclusion) return { state: "corrupt" };
        }
        const expectedCleanup = canonicalEvolutionEvalHash({
          schema: "evolution-eval-evidence-cleanup.v1",
          eval_job_id: binding.dispatch.eval_job_id,
          cause_fact_hash: discard.coreConclusionFactHash,
        });
        if (discard.discardAuthorizationHash !== expectedAuthorization
          || discard.coreCleanupFactHash !== expectedCleanup) return { state: "corrupt" };
        const planned = this.makeEvidenceDiscard(binding, reservation, discard);
        await this.atomicCreate(this.factPath(binding, "evidence-discard"), planned, "evidence_discard");
        const stored = this.evidenceDiscard(
          await this.readRequired(this.factPath(binding, "evidence-discard")),
          binding,
          reservation,
        );
        if (stored.reason !== discard.reason
          || stored.core_conclusion_fact_hash !== discard.coreConclusionFactHash
          || stored.core_cleanup_fact_hash !== discard.coreCleanupFactHash
          || stored.discard_authorization_hash !== discard.discardAuthorizationHash) return { state: "corrupt" };
        return this.getRetentionObservationUnlocked(binding);
      } catch (error) {
        return this.retentionErrorObservation(error);
      }
    });
  }

  async markEvidenceCleaned(
    input: CoreIssuedEvalBinding,
    authorizationFactHash: string,
    coreCleanupFactHash: string,
  ): Promise<EvolutionEvalRetentionObservation> {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!validHash(authorizationFactHash) || !validHash(coreCleanupFactHash)) throw new TypeError("cleanup hashes are invalid");
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.getRetentionObservationUnlocked(binding);
      if (before.state === "cleaned") {
        return before.authorizationFactHash === authorizationFactHash
          && before.authorizationHash === coreCleanupFactHash ? before : { state: "corrupt" };
      }
      if (!(before.state === "acknowledged" || before.state === "quarantined"
        || before.state === "discarded")) {
        return before.state === "absent" || before.state === "pending_ack" ? { state: "corrupt" } : before;
      }
      if (before.factHash !== authorizationFactHash) return { state: "corrupt" };
      try {
        await this.loadReservationChain(binding);
        await this.loadTerminalFact(binding);
        const causeFactHash = before.state === "acknowledged"
          ? canonicalEvolutionEvalHash({
              schema: "evolution-eval-evidence-acknowledged.v1",
              eval_job_id: binding.dispatch.eval_job_id,
              manifest_hash: before.coreManifestHash,
              connector_fact_hash: before.factHash,
            })
          : before.state === "quarantined"
            ? before.errorFactHash
            : before.coreConclusionFactHash;
        const expectedCoreCleanupFactHash = canonicalEvolutionEvalHash({
          schema: "evolution-eval-evidence-cleanup.v1",
          eval_job_id: binding.dispatch.eval_job_id,
          cause_fact_hash: causeFactHash,
        });
        if (coreCleanupFactHash !== expectedCoreCleanupFactHash) return { state: "corrupt" };
        const planned = this.makeEvidenceCleanup(binding, authorizationFactHash, coreCleanupFactHash);
        await this.atomicCreate(this.factPath(binding, "evidence-cleanup"), planned, "evidence_cleanup");
        return this.getRetentionObservationUnlocked(binding);
      } catch (error) {
        return this.retentionErrorObservation(error);
      }
    });
  }

  async markProcessExitConfirmed(
    input: CoreIssuedEvalBinding,
    identity: EvolutionEvalProcessIdentity,
    effectOwnerToken?: string,
  ): Promise<boolean> {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!Number.isSafeInteger(identity.pid) || identity.pid < 1
      || !Number.isSafeInteger(identity.processGroupId) || identity.processGroupId < 1
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(identity.startToken)
      || (effectOwnerToken !== undefined && !TOKEN_PATTERN.test(effectOwnerToken))) throw new TypeError("process exit is invalid");
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        if (effectOwnerToken !== undefined && rawSha256(effectOwnerToken) !== acceptance.effect_owner_token_hash) throw new LedgerBindingConflictError(ERROR.ownerMismatch);
        let processRaw = await this.readOptional(this.factPath(binding, "process"));
        if (processRaw === undefined && acceptance.process_pid !== undefined
          && acceptance.process_pid === identity.pid
          && acceptance.process_group_id === identity.processGroupId
          && acceptance.process_start_token === identity.startToken) {
          await this.atomicCreate(this.factPath(binding, "process"), this.makeProcess(binding, acceptance, identity), "process");
          processRaw = await this.readRequired(this.factPath(binding, "process"));
        }
        const process = this.process(processRaw, binding, acceptance);
        if (process.pid !== identity.pid || process.process_group_id !== identity.processGroupId || process.process_start_token !== identity.startToken) throw new LedgerBindingConflictError();
        const planned = this.makeProcessExit(binding, process);
        await this.atomicCreate(this.factPath(binding, "process-exit"), planned, "process_exit");
        const stored = this.processExit(await this.readRequired(this.factPath(binding, "process-exit")), binding, process);
        const exitHead = this.makeProcessExitHead(binding, process, stored);
        const exitHeadPath = this.headPath(binding, "process-exit");
        const existingHead = await this.readOptional(exitHeadPath);
        try {
          await this.atomicCreate(exitHeadPath, exitHead, "process_exit_head");
        } catch (error) {
          if (existingHead === undefined) {
            await unlink(exitHeadPath).catch(() => undefined);
            await this.syncDirectory(this.heads).catch(() => undefined);
          }
          throw error;
        }
        this.processExitHead(await this.readRequired(this.headPath(binding, "process-exit")), binding, process, stored);
        return true;
      } catch { return false; }
    });
  }

  async markTerminal(
    input: CoreIssuedEvalBinding,
    terminal: EvolutionEvalTerminal,
    effectOwnerToken: string,
  ): Promise<EvalLedgerQuery> {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!(["succeeded", "failed", "cancelled", "timeout"] as const).includes(terminal.terminalState)) {
      throw new TypeError("terminalState is invalid");
    }
    if (terminal.errorCode !== undefined && terminal.errorCode !== null && !ERROR_CODE_PATTERN.test(terminal.errorCode)) {
      throw new TypeError("errorCode is invalid");
    }
    if (terminal.terminalAt !== undefined && !validTimestamp(terminal.terminalAt)) {
      throw new TypeError("terminalAt is invalid");
    }
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.queryUnlocked(binding);
      if (before.state === "terminal") {
        return before.terminal_state === terminal.terminalState && before.error_code === (terminal.errorCode ?? null)
          ? before
          : corrupt(binding, this.ledgerEpoch, ERROR.terminalConflict);
      }
      if (before.state === "transient_unavailable") return before;
      if (!TOKEN_PATTERN.test(effectOwnerToken)) return corrupt(binding, this.ledgerEpoch, ERROR.ownerMismatch);
      if (before.state !== "accepted" && !(before.state === "ledger_corrupt" && before.error_code === ERROR.corrupt)) {
        return corrupt(binding, this.ledgerEpoch, ERROR.terminalWithoutAcceptance);
      }
      try {
        await this.ensureTerminal(binding, terminal, effectOwnerToken);
        const after = await this.queryUnlocked(binding);
        if (after.state !== "terminal") return after;
        return after.terminal_state === terminal.terminalState && after.error_code === (terminal.errorCode ?? null)
          ? after
          : corrupt(binding, this.ledgerEpoch, ERROR.terminalConflict);
      } catch (error) {
        return this.errorObservation(binding, error);
      }
    });
  }

  private async queryUnlocked(binding: CoreIssuedEvalBinding): Promise<EvalLedgerQuery> {
    if (this.initializationError !== undefined) {
      return this.initializationError === ERROR.unavailable
        ? unavailable(binding, this.ledgerEpoch)
        : corrupt(binding, this.ledgerEpoch, this.initializationError);
    }
    try {
      const metadata = await this.validateLayout();
      const indexRaw = await this.readOptional(this.indexPath(binding));
      const terminalHeadRaw = await this.readOptional(this.headPath(binding, "terminal"));
      const terminalRaw = await this.readOptional(this.factPath(binding, "terminal"));
      const acceptanceHeadRaw = await this.readOptional(this.headPath(binding, "acceptance"));
      let acceptanceRaw = await this.readOptional(this.factPath(binding, "accepted"));
      const processRaw = await this.readOptional(this.factPath(binding, "process"));
      const stopIntentRaw = await this.readOptional(this.factPath(binding, "stop-intent"));
      const outputRaw = await this.readOptional(this.factPath(binding, "output"));
      const processExitRaw = await this.readOptional(this.factPath(binding, "process-exit"));
      const processExitHeadRaw = await this.readOptional(this.headPath(binding, "process-exit"));
      const reservationRaw = await this.readOptional(this.factPath(binding, "reservation"));

      if (indexRaw === undefined) {
        if ([terminalHeadRaw, terminalRaw, acceptanceHeadRaw, acceptanceRaw, processRaw, stopIntentRaw, outputRaw, processExitRaw, processExitHeadRaw, reservationRaw].some((value) => value !== undefined)) {
          throw new LedgerCorruptError();
        }
        return noProof(binding, this.ledgerEpoch);
      }
      const index = this.bindingIndex(indexRaw, binding, metadata);
      await this.durabilityFence(this.indexes, "binding_index");
      if (reservationRaw === undefined) throw new LedgerCorruptError();
      const reservation = this.reservation(reservationRaw, binding, metadata, index);
      await this.durabilityFence(this.facts, "reservation");

      if (acceptanceHeadRaw === undefined) {
        if ([terminalHeadRaw, terminalRaw, acceptanceRaw, processRaw, stopIntentRaw, outputRaw, processExitRaw, processExitHeadRaw].some((value) => value !== undefined)) throw new LedgerCorruptError();
        return validateEvalLedgerQuery({
          ...common(binding, this.ledgerEpoch),
          state: "proven_never_accepted",
          replay_permitted: reservation.replay_permitted,
        }, binding, this.ledgerEpoch);
      }
      const acceptanceHead = this.acceptanceHead(acceptanceHeadRaw, binding, reservation);
      if (acceptanceRaw === undefined) {
        const reconstructed = this.makeAcceptance(
          binding,
          reservation,
          acceptanceHead.execution_state,
          acceptanceHead.accepted_at,
          acceptanceHead.effect_owner_token_hash,
          acceptanceHead.process_pid === undefined ? undefined : {
            pid: acceptanceHead.process_pid,
            processGroupId: acceptanceHead.process_group_id!,
            startToken: acceptanceHead.process_start_token!,
          },
        );
        if (reconstructed.fact_hash !== acceptanceHead.acceptance_fact_hash) throw new LedgerCorruptError();
        await this.atomicCreate(this.factPath(binding, "accepted"), reconstructed, "acceptance");
        acceptanceRaw = await this.readRequired(this.factPath(binding, "accepted"));
      }
      const acceptance = this.acceptance(acceptanceRaw, binding, reservation, acceptanceHead);
      await this.durabilityFence(this.heads, "acceptance_head");
      await this.durabilityFence(this.facts, "acceptance");
      let process: ProcessFact | undefined;
      let processExit: ProcessExitFact | undefined;
      if (stopIntentRaw !== undefined) {
        this.stopIntent(stopIntentRaw, binding, acceptance);
        await this.durabilityFence(this.facts, "stop_intent");
      }
      if (processRaw === undefined) {
        if (outputRaw !== undefined || processExitRaw !== undefined || processExitHeadRaw !== undefined) throw new LedgerCorruptError();
      } else {
        process = this.process(processRaw, binding, acceptance);
        await this.durabilityFence(this.facts, "process");
        if (outputRaw !== undefined) {
          this.output(outputRaw, binding, process);
          await this.durabilityFence(this.facts, "output");
        }
        if (processExitHeadRaw !== undefined && processExitRaw === undefined) throw new LedgerCorruptError();
        if (processExitRaw !== undefined) {
          const candidate = this.processExit(processExitRaw, binding, process);
          if (processExitHeadRaw !== undefined) {
            this.processExitHead(processExitHeadRaw, binding, process, candidate);
            await this.durabilityFence(this.heads, "process_exit_head");
            await this.durabilityFence(this.facts, "process_exit");
            processExit = candidate;
          }
        }
      }

      if (terminalHeadRaw === undefined) {
        if (terminalRaw !== undefined) throw new LedgerCorruptError();
        return validateEvalLedgerQuery({
          ...common(binding, this.ledgerEpoch),
          state: "accepted",
          execution_state: acceptance.execution_state,
          accepted_at: acceptance.accepted_at,
        }, binding, this.ledgerEpoch);
      }
      if (process === undefined || processExit === undefined) throw new LedgerCorruptError();
      const terminalHead = this.terminalHead(terminalHeadRaw, binding, processExit);
      if (terminalRaw === undefined) throw new LedgerCorruptError();
      const terminal = this.terminal(terminalRaw, binding, processExit, terminalHead);
      await this.durabilityFence(this.heads, "terminal_head");
      await this.durabilityFence(this.facts, "terminal");
      return validateEvalLedgerQuery({
        ...common(binding, this.ledgerEpoch),
        state: "terminal",
        terminal_state: terminal.terminal_state,
        process_stopped: true,
        terminal_at: terminal.terminal_at,
        error_code: terminal.error_code,
      }, binding, this.ledgerEpoch);
    } catch (error) {
      return this.errorObservation(binding, error);
    }
  }

  private async ensureReservation(binding: CoreIssuedEvalBinding, replayPermitted: boolean): Promise<void> {
    const metadata = await this.validateLayout();
    let indexRaw = await this.readOptional(this.indexPath(binding));
    let index: BindingIndexFact;
    if (indexRaw === undefined) {
      const reservedAt = this.isoNow();
      const reservation = this.makeReservation(binding, metadata, replayPermitted, reservedAt);
      const planned = this.makeBindingIndex(binding, metadata, reservation);
      await this.atomicCreate(this.indexPath(binding), planned, "binding_index");
      indexRaw = await this.readRequired(this.indexPath(binding));
      index = this.bindingIndex(indexRaw, binding, metadata);
    } else {
      index = this.bindingIndex(indexRaw, binding, metadata);
    }
    if (index.replay_permitted !== replayPermitted) throw new LedgerReservationConflictError();
    const reservation = this.makeReservation(binding, metadata, index.replay_permitted, index.reserved_at);
    if (reservation.fact_hash !== index.reservation_fact_hash) throw new LedgerCorruptError();
    const existing = await this.readOptional(this.factPath(binding, "reservation"));
    if (existing === undefined) await this.atomicCreate(this.factPath(binding, "reservation"), reservation, "reservation");
    this.reservation(await this.readRequired(this.factPath(binding, "reservation")), binding, metadata, index);
  }

  private async ensureAcceptance(
    binding: CoreIssuedEvalBinding,
    acceptance: EvolutionEvalAcceptance,
  ): Promise<{ readonly createdHead: boolean; readonly ownerToken?: string; readonly head: AcceptanceHeadFact }> {
    const { reservation } = await this.loadReservationChain(binding);
    let headRaw = await this.readOptional(this.headPath(binding, "acceptance"));
    const existingFact = await this.readOptional(this.factPath(binding, "accepted"));
    let createdHead = false;
    let ownerToken: string | undefined;
    let head: AcceptanceHeadFact;
    if (headRaw === undefined) {
      if (existingFact !== undefined) throw new LedgerCorruptError();
      ownerToken = randomBytes(32).toString("hex");
      const fact = this.makeAcceptance(
        binding,
        reservation,
        acceptance.executionState,
        acceptance.acceptedAt ?? this.isoNow(),
        rawSha256(ownerToken),
        acceptance.processIdentity,
      );
      const planned = this.makeAcceptanceHead(binding, reservation, fact);
      createdHead = await this.atomicCreate(this.headPath(binding, "acceptance"), planned, "acceptance_head");
      headRaw = await this.readRequired(this.headPath(binding, "acceptance"));
      head = this.acceptanceHead(headRaw, binding, reservation);
      if (!createdHead || head.effect_owner_token_hash !== rawSha256(ownerToken)) ownerToken = undefined;
    } else {
      head = this.acceptanceHead(headRaw, binding, reservation);
    }
    const fact = this.makeAcceptance(
      binding,
      reservation,
      head.execution_state,
      head.accepted_at,
      head.effect_owner_token_hash,
      head.process_pid === undefined ? undefined : {
        pid: head.process_pid,
        processGroupId: head.process_group_id!,
        startToken: head.process_start_token!,
      },
    );
    if (fact.fact_hash !== head.acceptance_fact_hash) throw new LedgerCorruptError();
    const current = await this.readOptional(this.factPath(binding, "accepted"));
    if (current === undefined) await this.atomicCreate(this.factPath(binding, "accepted"), fact, "acceptance");
    this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
    return ownerToken === undefined ? { createdHead, head } : { createdHead, ownerToken, head };
  }

  private async ensureTerminal(
    binding: CoreIssuedEvalBinding,
    terminal: EvolutionEvalTerminal,
    effectOwnerToken?: string,
    allowConfirmedStop = false,
  ): Promise<void> {
    const { reservation } = await this.loadReservationChain(binding);
    const acceptanceHeadRaw = await this.readRequired(this.headPath(binding, "acceptance"));
    const acceptanceHead = this.acceptanceHead(acceptanceHeadRaw, binding, reservation);
    const acceptance = this.acceptance(
      await this.readRequired(this.factPath(binding, "accepted")),
      binding,
      reservation,
      acceptanceHead,
    );
    const ownerHash = effectOwnerToken === undefined ? acceptance.effect_owner_token_hash : rawSha256(effectOwnerToken);
    if (effectOwnerToken === undefined && !allowConfirmedStop) throw new LedgerBindingConflictError(ERROR.ownerMismatch);
    if (ownerHash !== acceptance.effect_owner_token_hash) throw new LedgerBindingConflictError(ERROR.ownerMismatch);
    const process = this.process(
      await this.readRequired(this.factPath(binding, "process")),
      binding,
      acceptance,
    );
    const processExit = this.processExit(
      await this.readRequired(this.factPath(binding, "process-exit")),
      binding,
      process,
    );
    this.processExitHead(
      await this.readRequired(this.headPath(binding, "process-exit")),
      binding,
      process,
      processExit,
    );
    if (terminal.terminalState === "cancelled" || terminal.terminalState === "timeout") {
      const stop = this.stopIntent(
        await this.readRequired(this.factPath(binding, "stop-intent")),
        binding,
        acceptance,
      );
      if (stop.reason !== terminal.terminalState) throw new LedgerBindingConflictError();
    }

    let headRaw = await this.readOptional(this.headPath(binding, "terminal"));
    const existingFact = await this.readOptional(this.factPath(binding, "terminal"));
    let head: TerminalHeadFact;
    if (headRaw === undefined) {
      if (existingFact !== undefined) throw new LedgerCorruptError();
      const fact = this.makeTerminal(
        binding,
        processExit,
        terminal.terminalState,
        terminal.terminalAt ?? this.isoNow(),
        terminal.errorCode ?? null,
      );
      const planned = this.makeTerminalHead(binding, processExit, fact);
      await this.atomicCreate(this.headPath(binding, "terminal"), planned, "terminal_head");
      headRaw = await this.readRequired(this.headPath(binding, "terminal"));
      head = this.terminalHead(headRaw, binding, processExit);
    } else {
      head = this.terminalHead(headRaw, binding, processExit);
    }
    if (head.effect_owner_token_hash !== ownerHash) throw new LedgerBindingConflictError(ERROR.ownerMismatch);
    if (head.terminal_state !== terminal.terminalState || head.error_code !== (terminal.errorCode ?? null)) {
      throw new LedgerReservationConflictError(ERROR.terminalConflict);
    }
    const fact = this.makeTerminal(
      binding,
      processExit,
      head.terminal_state,
      head.terminal_at,
      head.error_code,
    );
    if (fact.fact_hash !== head.terminal_fact_hash) throw new LedgerCorruptError();
    const current = await this.readOptional(this.factPath(binding, "terminal"));
    if (current === undefined) await this.atomicCreate(this.factPath(binding, "terminal"), fact, "terminal");
    this.terminal(await this.readRequired(this.factPath(binding, "terminal")), binding, processExit, head);
  }

  private async loadReservationChain(binding: CoreIssuedEvalBinding): Promise<{
    readonly metadata: LedgerMetadata;
    readonly index: BindingIndexFact;
    readonly reservation: ReservationFact;
  }> {
    const metadata = await this.validateLayout();
    const index = this.bindingIndex(await this.readRequired(this.indexPath(binding)), binding, metadata);
    const reservation = this.reservation(
      await this.readRequired(this.factPath(binding, "reservation")),
      binding,
      metadata,
      index,
    );
    return { metadata, index, reservation };
  }

  private async loadProcessChain(binding: CoreIssuedEvalBinding): Promise<{
    readonly acceptance: AcceptanceFact;
    readonly process: ProcessFact;
  }> {
    const { reservation } = await this.loadReservationChain(binding);
    const head = this.acceptanceHead(
      await this.readRequired(this.headPath(binding, "acceptance")),
      binding,
      reservation,
    );
    const acceptance = this.acceptance(
      await this.readRequired(this.factPath(binding, "accepted")),
      binding,
      reservation,
      head,
    );
    const process = this.process(
      await this.readRequired(this.factPath(binding, "process")),
      binding,
      acceptance,
    );
    return { acceptance, process };
  }

  private async loadOutputChain(binding: CoreIssuedEvalBinding): Promise<{
    readonly acceptance: AcceptanceFact;
    readonly process: ProcessFact;
    readonly output: OutputFact;
  }> {
    const { acceptance, process } = await this.loadProcessChain(binding);
    const output = this.output(
      await this.readRequired(this.factPath(binding, "output")),
      binding,
      process,
    );
    return { acceptance, process, output };
  }

  private async loadTerminalFact(binding: CoreIssuedEvalBinding): Promise<TerminalFact> {
    const { process } = await this.loadProcessChain(binding);
    const processExit = this.processExit(
      await this.readRequired(this.factPath(binding, "process-exit")),
      binding,
      process,
    );
    const processExitHead = this.processExitHead(
      await this.readRequired(this.headPath(binding, "process-exit")),
      binding,
      process,
      processExit,
    );
    if (processExitHead.process_exit_fact_hash !== processExit.fact_hash) throw new LedgerCorruptError();
    const head = this.terminalHead(
      await this.readRequired(this.headPath(binding, "terminal")),
      binding,
      processExit,
    );
    return this.terminal(
      await this.readRequired(this.factPath(binding, "terminal")),
      binding,
      processExit,
      head,
    );
  }

  private async getRetentionObservationUnlocked(
    binding: CoreIssuedEvalBinding,
  ): Promise<EvolutionEvalRetentionObservation> {
    if (this.initializationError !== undefined) {
      return this.initializationError === ERROR.unavailable ? { state: "unavailable" } : { state: "corrupt" };
    }
    try {
      const paths = {
        output: this.factPath(binding, "output"),
        ack: this.factPath(binding, "evidence-ack"),
        quarantine: this.factPath(binding, "evidence-quarantine"),
        expired: this.factPath(binding, "evidence-expired"),
        discard: this.factPath(binding, "evidence-discard"),
        cleanup: this.factPath(binding, "evidence-cleanup"),
      };
      const [outputRaw, ackRaw, quarantineRaw, expiredRaw, discardRaw, cleanupRaw] = await Promise.all([
        this.readOptional(paths.output),
        this.readOptional(paths.ack),
        this.readOptional(paths.quarantine),
        this.readOptional(paths.expired),
        this.readOptional(paths.discard),
        this.readOptional(paths.cleanup),
      ]);
      if (outputRaw === undefined) {
        if ([ackRaw, quarantineRaw, expiredRaw].some((value) => value !== undefined)) {
          throw new LedgerCorruptError();
        }
        if (discardRaw === undefined) {
          if (cleanupRaw !== undefined) throw new LedgerCorruptError();
          return { state: "absent" };
        }
        const { reservation } = await this.loadReservationChain(binding);
        const discard = this.evidenceDiscard(discardRaw, binding, reservation);
        if (cleanupRaw !== undefined) {
          const cleanup = this.evidenceCleanup(cleanupRaw, binding, discard);
          return {
            state: "cleaned",
            authorizationFactHash: cleanup.authorization_fact_hash,
            authorizationHash: cleanup.core_cleanup_fact_hash,
            sourceKind: "discard",
            sourceAuthorizationHash: discard.discard_authorization_hash,
            sourceConnectorManifestHash: null,
            sourceCoreManifestHash: null,
            sourceErrorFactHash: null,
            factHash: cleanup.fact_hash,
            cleanedAt: cleanup.cleaned_at,
          };
        }
        return {
          state: "discarded",
          reason: discard.reason,
          authorizationHash: discard.discard_authorization_hash,
          coreConclusionFactHash: discard.core_conclusion_fact_hash,
          cleanupAuthorizationHash: discard.core_cleanup_fact_hash,
          factHash: discard.fact_hash,
          discardedAt: discard.discarded_at,
        };
      }
      const { output } = await this.loadOutputChain(binding);
      const ack = ackRaw === undefined ? undefined : this.evidenceAck(ackRaw, binding, output);
      const quarantine = quarantineRaw === undefined
        ? undefined
        : this.evidenceQuarantine(quarantineRaw, binding, output);
      let expired: EvidenceExpiredFact | undefined;
      if (expiredRaw !== undefined) {
        const terminal = await this.loadTerminalFact(binding);
        expired = this.evidenceExpired(expiredRaw, binding, output, terminal);
      }
      const { reservation } = await this.loadReservationChain(binding);
      const discard = discardRaw === undefined ? undefined : this.evidenceDiscard(discardRaw, binding, reservation);
      const allAuthorizations = [ack, quarantine, expired, discard].filter((value) => value !== undefined) as Array<
        EvidenceAckFact | EvidenceQuarantineFact | EvidenceExpiredFact | EvidenceDiscardFact
      >;
      const localExpirySuperseded = allAuthorizations.length === 2
        && expired !== undefined && discard?.reason === "absolute_expiry";
      if (allAuthorizations.length > 1 && !localExpirySuperseded) throw new LedgerCorruptError();
      const authorizations = localExpirySuperseded ? [discard!] : allAuthorizations;
      if (cleanupRaw !== undefined) {
        if (authorizations.length !== 1) throw new LedgerCorruptError();
        const cleanup = this.evidenceCleanup(cleanupRaw, binding, authorizations[0]!);
        return {
          state: "cleaned",
          authorizationFactHash: cleanup.authorization_fact_hash,
          authorizationHash: cleanup.core_cleanup_fact_hash,
          sourceKind: authorizations[0]!.schema === ACK_SCHEMA
            ? "ack" : authorizations[0]!.schema === QUARANTINE_SCHEMA
              ? "quarantine" : authorizations[0]!.schema === DISCARD_SCHEMA ? "discard" : "expiry",
          sourceAuthorizationHash: authorizations[0]!.schema === ACK_SCHEMA
            ? authorizations[0]!.core_ack_fact_hash
            : authorizations[0]!.schema === QUARANTINE_SCHEMA
              ? authorizations[0]!.core_quarantine_fact_hash
              : authorizations[0]!.schema === DISCARD_SCHEMA
                ? authorizations[0]!.discard_authorization_hash : authorizations[0]!.fact_hash,
          sourceConnectorManifestHash: authorizations[0]!.schema === ACK_SCHEMA
            ? authorizations[0]!.connector_manifest_hash : null,
          sourceCoreManifestHash: authorizations[0]!.schema === ACK_SCHEMA
            ? authorizations[0]!.core_manifest_hash : null,
          sourceErrorFactHash: authorizations[0]!.schema === QUARANTINE_SCHEMA
            ? authorizations[0]!.error_fact_hash : null,
          factHash: cleanup.fact_hash,
          cleanedAt: cleanup.cleaned_at,
        };
      }
      if (quarantine !== undefined) {
        return {
          state: "quarantined",
          errorFactHash: quarantine.error_fact_hash,
          authorizationHash: quarantine.core_quarantine_fact_hash,
          factHash: quarantine.fact_hash,
          quarantinedAt: quarantine.quarantined_at,
          deleteBy: quarantine.delete_by,
        };
      }
      if (discard !== undefined) {
        return {
          state: "discarded",
          reason: discard.reason,
          authorizationHash: discard.discard_authorization_hash,
          coreConclusionFactHash: discard.core_conclusion_fact_hash,
          cleanupAuthorizationHash: discard.core_cleanup_fact_hash,
          factHash: discard.fact_hash,
          discardedAt: discard.discarded_at,
        };
      }
      if (expired !== undefined) {
        return {
          state: "expired",
          manifestHash: expired.manifest_hash,
          factHash: expired.fact_hash,
          expiredAt: expired.expired_at,
        };
      }
      if (ack !== undefined) {
        return {
          state: "acknowledged",
          manifestHash: ack.connector_manifest_hash,
          coreManifestHash: ack.core_manifest_hash,
          authorizationHash: ack.core_ack_fact_hash,
          factHash: ack.fact_hash,
          acknowledgedAt: ack.acknowledged_at,
        };
      }
      return { state: "pending_ack", manifestHash: output.spool_manifest_hash, totalBytes: output.total_bytes };
    } catch (error) {
      return this.retentionErrorObservation(error);
    }
  }

  private retentionErrorObservation(error: unknown): EvolutionEvalRetentionObservation {
    return error instanceof LedgerUnavailableError || (error instanceof Error && "code" in error)
      ? { state: "unavailable" }
      : { state: "corrupt" };
  }

  private makeMetadata(): LedgerMetadata {
    return hashedFact({ schema: METADATA_SCHEMA, ledger_epoch: this.ledgerEpoch });
  }

  private makeReservation(
    binding: CoreIssuedEvalBinding,
    metadata: LedgerMetadata,
    replayPermitted: boolean,
    reservedAt: string,
  ): ReservationFact {
    return hashedFact({
      schema: RESERVATION_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      binding: copy(binding),
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      replay_permitted: replayPermitted,
      reserved_at: reservedAt,
      parent_fact_hash: metadata.fact_hash,
    });
  }

  private makeBindingIndex(
    binding: CoreIssuedEvalBinding,
    metadata: LedgerMetadata,
    reservation: ReservationFact,
  ): BindingIndexFact {
    return hashedFact({
      schema: INDEX_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      eval_job_id: binding.dispatch.eval_job_id,
      project_id: binding.project_id,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      replay_permitted: reservation.replay_permitted,
      reserved_at: reservation.reserved_at,
      reservation_fact_hash: reservation.fact_hash,
      parent_fact_hash: metadata.fact_hash,
    });
  }

  private makeAcceptance(
    binding: CoreIssuedEvalBinding,
    reservation: ReservationFact,
    executionState: EvolutionEvalExecutionState,
    acceptedAt: string,
    ownerHash: string,
    processIdentity?: EvolutionEvalProcessIdentity,
  ): AcceptanceFact {
    return hashedFact({
      schema: ACCEPTANCE_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      execution_state: executionState,
      accepted_at: acceptedAt,
      effect_owner_token_hash: ownerHash,
      ...(processIdentity === undefined ? {} : {
        process_pid: processIdentity.pid,
        process_group_id: processIdentity.processGroupId,
        process_start_token: processIdentity.startToken,
      }),
      parent_fact_hash: reservation.fact_hash,
    });
  }

  private makeAcceptanceHead(
    binding: CoreIssuedEvalBinding,
    reservation: ReservationFact,
    acceptance: AcceptanceFact,
  ): AcceptanceHeadFact {
    return hashedFact({
      schema: ACCEPTANCE_HEAD_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      execution_state: acceptance.execution_state,
      accepted_at: acceptance.accepted_at,
      effect_owner_token_hash: acceptance.effect_owner_token_hash,
      ...(acceptance.process_pid === undefined ? {} : {
        process_pid: acceptance.process_pid,
        process_group_id: acceptance.process_group_id,
        process_start_token: acceptance.process_start_token,
      }),
      parent_fact_hash: reservation.fact_hash,
      acceptance_fact_hash: acceptance.fact_hash,
    });
  }

  private makeProcess(
    binding: CoreIssuedEvalBinding,
    acceptance: AcceptanceFact,
    identity: EvolutionEvalProcessIdentity,
  ): ProcessFact {
    return hashedFact({
      schema: PROCESS_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      pid: identity.pid,
      process_group_id: identity.processGroupId,
      process_start_token: identity.startToken,
      started_at: this.isoNow(),
      effect_owner_token_hash: acceptance.effect_owner_token_hash,
      parent_fact_hash: acceptance.fact_hash,
    });
  }

  private makeStopIntent(
    binding: CoreIssuedEvalBinding,
    acceptance: AcceptanceFact,
    reason: "cancelled" | "timeout",
  ): StopIntentFact {
    return hashedFact({
      schema: STOP_INTENT_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      reason,
      requested_at: this.isoNow(),
      effect_owner_token_hash: acceptance.effect_owner_token_hash,
      parent_fact_hash: acceptance.fact_hash,
    });
  }

  private makeOutput(
    binding: CoreIssuedEvalBinding,
    process: ProcessFact,
    output: { readonly spoolManifestHash: string; readonly entryCount: number; readonly totalBytes: number },
  ): OutputFact {
    return hashedFact({
      schema: OUTPUT_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      spool_manifest_hash: output.spoolManifestHash,
      entry_count: output.entryCount,
      total_bytes: output.totalBytes,
      retention_state: "pending_ack",
      created_at: this.isoNow(),
      effect_owner_token_hash: process.effect_owner_token_hash,
      parent_fact_hash: process.fact_hash,
    });
  }

  private makeEvidenceAck(
    binding: CoreIssuedEvalBinding,
    output: OutputFact,
    hashes: { readonly connectorManifestHash: string; readonly coreManifestHash: string; readonly coreAckFactHash: string },
  ): EvidenceAckFact {
    return hashedFact({
      schema: ACK_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      connector_manifest_hash: hashes.connectorManifestHash,
      core_manifest_hash: hashes.coreManifestHash,
      core_ack_fact_hash: hashes.coreAckFactHash,
      acknowledged_at: this.isoNow(),
      parent_fact_hash: output.fact_hash,
    });
  }

  private makeEvidenceQuarantine(
    binding: CoreIssuedEvalBinding,
    output: OutputFact,
    hashes: { readonly errorFactHash: string; readonly coreQuarantineFactHash: string },
  ): EvidenceQuarantineFact {
    const quarantinedAt = this.isoNow();
    return hashedFact({
      schema: QUARANTINE_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      error_fact_hash: hashes.errorFactHash,
      core_quarantine_fact_hash: hashes.coreQuarantineFactHash,
      quarantined_at: quarantinedAt,
      delete_by: new Date(Date.parse(quarantinedAt) + 24 * 60 * 60 * 1000).toISOString(),
      parent_fact_hash: output.fact_hash,
    });
  }

  private makeEvidenceExpired(
    binding: CoreIssuedEvalBinding,
    output: OutputFact,
    terminal: TerminalFact,
  ): EvidenceExpiredFact {
    return hashedFact({
      schema: EXPIRED_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      manifest_hash: output.spool_manifest_hash,
      terminal_fact_hash: terminal.fact_hash,
      expired_at: this.isoNow(),
      parent_fact_hash: output.fact_hash,
    });
  }

  private makeEvidenceDiscard(
    binding: CoreIssuedEvalBinding,
    reservation: ReservationFact,
    input: {
      readonly reason: "unavailable_at_deadline" | "absolute_expiry";
      readonly coreConclusionFactHash: string;
      readonly coreCleanupFactHash: string;
      readonly discardAuthorizationHash: string;
    },
  ): EvidenceDiscardFact {
    return hashedFact({
      schema: DISCARD_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      reason: input.reason,
      core_conclusion_fact_hash: input.coreConclusionFactHash,
      core_cleanup_fact_hash: input.coreCleanupFactHash,
      discard_authorization_hash: input.discardAuthorizationHash,
      discarded_at: this.isoNow(),
      parent_fact_hash: reservation.fact_hash,
    });
  }

  private makeEvidenceCleanup(
    binding: CoreIssuedEvalBinding,
    authorizationFactHash: string,
    coreCleanupFactHash: string,
  ): EvidenceCleanupFact {
    return hashedFact({
      schema: CLEANUP_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      authorization_fact_hash: authorizationFactHash,
      core_cleanup_fact_hash: coreCleanupFactHash,
      cleaned_at: this.isoNow(),
      parent_fact_hash: authorizationFactHash,
    });
  }

  private makeProcessExit(binding: CoreIssuedEvalBinding, process: ProcessFact): ProcessExitFact {
    return hashedFact({
      schema: PROCESS_EXIT_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      pid: process.pid,
      process_group_id: process.process_group_id,
      process_start_token: process.process_start_token,
      stopped_at: this.isoNow(),
      effect_owner_token_hash: process.effect_owner_token_hash,
      parent_fact_hash: process.fact_hash,
    });
  }

  private makeProcessExitHead(
    binding: CoreIssuedEvalBinding,
    process: ProcessFact,
    processExit: ProcessExitFact,
  ): ProcessExitHeadFact {
    return hashedFact({
      schema: PROCESS_EXIT_HEAD_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      effect_owner_token_hash: process.effect_owner_token_hash,
      parent_fact_hash: process.fact_hash,
      process_exit_fact_hash: processExit.fact_hash,
    });
  }

  private makeTerminal(
    binding: CoreIssuedEvalBinding,
    processExit: ProcessExitFact,
    terminalState: EvolutionEvalTerminalState,
    terminalAt: string,
    errorCode: string | null,
  ): TerminalFact {
    return hashedFact({
      schema: TERMINAL_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      terminal_state: terminalState,
      process_stopped: true,
      terminal_at: terminalAt,
      error_code: errorCode,
      effect_owner_token_hash: processExit.effect_owner_token_hash,
      parent_fact_hash: processExit.fact_hash,
    });
  }

  private makeTerminalHead(
    binding: CoreIssuedEvalBinding,
    processExit: ProcessExitFact,
    terminal: TerminalFact,
  ): TerminalHeadFact {
    return hashedFact({
      schema: TERMINAL_HEAD_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      terminal_state: terminal.terminal_state,
      process_stopped: true,
      terminal_at: terminal.terminal_at,
      error_code: terminal.error_code,
      effect_owner_token_hash: terminal.effect_owner_token_hash,
      parent_fact_hash: processExit.fact_hash,
      terminal_fact_hash: terminal.fact_hash,
    });
  }

  private metadata(value: unknown): LedgerMetadata {
    const fact = verifiedFact(value, ["ledger_epoch", "schema"]);
    if (fact.schema !== METADATA_SCHEMA) throw new LedgerCorruptError();
    if (fact.ledger_epoch !== this.ledgerEpoch) throw new LedgerEpochMismatchError();
    return fact as unknown as LedgerMetadata;
  }

  private bindingIndex(value: unknown, binding: CoreIssuedEvalBinding, metadata: LedgerMetadata): BindingIndexFact {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "eval_job_id",
      "ledger_epoch",
      "parent_fact_hash",
      "project_id",
      "replay_permitted",
      "reservation_fact_hash",
      "reserved_at",
      "schema",
    ]);
    if (fact.schema !== INDEX_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.parent_fact_hash !== metadata.fact_hash || !validHash(fact.reservation_fact_hash)
      || typeof fact.replay_permitted !== "boolean" || !validTimestamp(fact.reserved_at)) throw new LedgerCorruptError();
    if (!this.factBindingMatches(fact, binding, true)) throw new LedgerBindingConflictError();
    return fact as unknown as BindingIndexFact;
  }

  private reservation(
    value: unknown,
    binding: CoreIssuedEvalBinding,
    metadata: LedgerMetadata,
    index: BindingIndexFact,
  ): ReservationFact {
    const fact = verifiedFact(value, [
      "binding",
      "binding_fingerprint",
      "ledger_epoch",
      "parent_fact_hash",
      "replay_permitted",
      "reserved_at",
      "schema",
    ]);
    if (fact.schema !== RESERVATION_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.parent_fact_hash !== metadata.fact_hash || fact.fact_hash !== index.reservation_fact_hash
      || fact.replay_permitted !== index.replay_permitted || fact.reserved_at !== index.reserved_at) {
      throw new LedgerCorruptError();
    }
    let storedBinding: CoreIssuedEvalBinding;
    try { storedBinding = validateCoreIssuedEvalBinding(fact.binding); } catch { throw new LedgerCorruptError(); }
    const fingerprint = evolutionEvalBindingFingerprint(binding);
    if (fact.binding_fingerprint !== fingerprint || evolutionEvalBindingFingerprint(storedBinding) !== fingerprint) {
      throw new LedgerBindingConflictError();
    }
    return { ...fact, binding: storedBinding } as unknown as ReservationFact;
  }

  private acceptanceHead(value: unknown, binding: CoreIssuedEvalBinding, reservation: ReservationFact): AcceptanceHeadFact {
    const record = value as Record<string, unknown>;
    const hasProcessIdentity = record?.process_pid !== undefined
      || record?.process_group_id !== undefined || record?.process_start_token !== undefined;
    const fact = verifiedFact(value, [
      "acceptance_fact_hash",
      "accepted_at",
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "execution_state",
      "ledger_epoch",
      "parent_fact_hash",
      ...(hasProcessIdentity ? ["process_group_id", "process_pid", "process_start_token"] : []),
      "schema",
    ]);
    if (fact.schema !== ACCEPTANCE_HEAD_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.parent_fact_hash !== reservation.fact_hash || !validHash(fact.acceptance_fact_hash)
      || !validHash(fact.effect_owner_token_hash) || !validTimestamp(fact.accepted_at)
      || (hasProcessIdentity && (!Number.isSafeInteger(fact.process_pid) || Number(fact.process_pid) < 1
        || !Number.isSafeInteger(fact.process_group_id) || Number(fact.process_group_id) < 1
        || typeof fact.process_start_token !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(fact.process_start_token)))
      || !(["queued", "preparing", "running"] as const).includes(fact.execution_state as EvolutionEvalExecutionState)) {
      throw new LedgerCorruptError();
    }
    if (!this.factBindingMatches(fact, binding)) throw new LedgerBindingConflictError();
    return fact as unknown as AcceptanceHeadFact;
  }

  private acceptance(
    value: unknown,
    binding: CoreIssuedEvalBinding,
    reservation: ReservationFact,
    head: AcceptanceHeadFact,
  ): AcceptanceFact {
    const record = value as Record<string, unknown>;
    const hasProcessIdentity = record?.process_pid !== undefined
      || record?.process_group_id !== undefined || record?.process_start_token !== undefined;
    const fact = verifiedFact(value, [
      "accepted_at",
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "execution_state",
      "ledger_epoch",
      "parent_fact_hash",
      ...(hasProcessIdentity ? ["process_group_id", "process_pid", "process_start_token"] : []),
      "schema",
    ]);
    if (fact.schema !== ACCEPTANCE_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.parent_fact_hash !== reservation.fact_hash || fact.fact_hash !== head.acceptance_fact_hash
      || fact.accepted_at !== head.accepted_at || fact.execution_state !== head.execution_state
      || fact.effect_owner_token_hash !== head.effect_owner_token_hash || !validHash(fact.effect_owner_token_hash)
      || fact.process_pid !== head.process_pid || fact.process_group_id !== head.process_group_id
      || fact.process_start_token !== head.process_start_token
      || (hasProcessIdentity && (!Number.isSafeInteger(fact.process_pid) || Number(fact.process_pid) < 1
        || !Number.isSafeInteger(fact.process_group_id) || Number(fact.process_group_id) < 1
        || typeof fact.process_start_token !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(fact.process_start_token)))
      || !validTimestamp(fact.accepted_at)
      || !(["queued", "preparing", "running"] as const).includes(fact.execution_state as EvolutionEvalExecutionState)) {
      throw new LedgerCorruptError();
    }
    if (!this.factBindingMatches(fact, binding)) throw new LedgerBindingConflictError();
    return fact as unknown as AcceptanceFact;
  }

  private terminalHead(value: unknown, binding: CoreIssuedEvalBinding, processExit: ProcessExitFact): TerminalHeadFact {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "error_code",
      "ledger_epoch",
      "parent_fact_hash",
      "process_stopped",
      "schema",
      "terminal_at",
      "terminal_fact_hash",
      "terminal_state",
    ]);
    if (fact.schema !== TERMINAL_HEAD_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.parent_fact_hash !== processExit.fact_hash || fact.process_stopped !== true
      || fact.effect_owner_token_hash !== processExit.effect_owner_token_hash
      || !validHash(fact.terminal_fact_hash) || !validTimestamp(fact.terminal_at)
      || !(["succeeded", "failed", "cancelled", "timeout"] as const).includes(fact.terminal_state as EvolutionEvalTerminalState)
      || (fact.error_code !== null && (typeof fact.error_code !== "string" || !ERROR_CODE_PATTERN.test(fact.error_code)))) {
      throw new LedgerCorruptError();
    }
    if (!this.factBindingMatches(fact, binding)) throw new LedgerBindingConflictError();
    return fact as unknown as TerminalHeadFact;
  }

  private process(value: unknown, binding: CoreIssuedEvalBinding, acceptance: AcceptanceFact): ProcessFact {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "ledger_epoch",
      "parent_fact_hash",
      "pid",
      "process_group_id",
      "process_start_token",
      "schema",
      "started_at",
    ]);
    if (fact.schema !== PROCESS_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.parent_fact_hash !== acceptance.fact_hash
      || fact.effect_owner_token_hash !== acceptance.effect_owner_token_hash
      || !Number.isSafeInteger(fact.pid) || Number(fact.pid) < 1
      || !Number.isSafeInteger(fact.process_group_id) || Number(fact.process_group_id) < 1
      || typeof fact.process_start_token !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(fact.process_start_token)
      || (acceptance.process_pid !== undefined && (fact.pid !== acceptance.process_pid
        || fact.process_group_id !== acceptance.process_group_id
        || fact.process_start_token !== acceptance.process_start_token))
      || !validTimestamp(fact.started_at)) throw new LedgerCorruptError();
    if (!this.factBindingMatches(fact, binding)) throw new LedgerBindingConflictError();
    return fact as unknown as ProcessFact;
  }

  private stopIntent(value: unknown, binding: CoreIssuedEvalBinding, acceptance: AcceptanceFact): StopIntentFact {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "ledger_epoch",
      "parent_fact_hash",
      "reason",
      "requested_at",
      "schema",
    ]);
    if (fact.schema !== STOP_INTENT_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.parent_fact_hash !== acceptance.fact_hash
      || fact.effect_owner_token_hash !== acceptance.effect_owner_token_hash
      || !(fact.reason === "cancelled" || fact.reason === "timeout")
      || !validTimestamp(fact.requested_at)) throw new LedgerCorruptError();
    if (!this.factBindingMatches(fact, binding)) throw new LedgerBindingConflictError();
    return fact as unknown as StopIntentFact;
  }

  private output(value: unknown, binding: CoreIssuedEvalBinding, process: ProcessFact): OutputFact {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "created_at",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "entry_count",
      "ledger_epoch",
      "parent_fact_hash",
      "retention_state",
      "schema",
      "spool_manifest_hash",
      "total_bytes",
    ]);
    if (fact.schema !== OUTPUT_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.parent_fact_hash !== process.fact_hash || fact.effect_owner_token_hash !== process.effect_owner_token_hash
      || !validHash(fact.spool_manifest_hash) || !Number.isSafeInteger(fact.entry_count)
      || Number(fact.entry_count) < 0 || Number(fact.entry_count) > 128
      || !Number.isSafeInteger(fact.total_bytes) || Number(fact.total_bytes) < 0 || Number(fact.total_bytes) > 256 * 1024 * 1024
      || fact.retention_state !== "pending_ack" || !validTimestamp(fact.created_at)) throw new LedgerCorruptError();
    if (!this.factBindingMatches(fact, binding)) throw new LedgerBindingConflictError();
    return fact as unknown as OutputFact;
  }

  private evidenceAck(
    value: unknown,
    binding: CoreIssuedEvalBinding,
    output: OutputFact,
  ): EvidenceAckFact {
    const fact = verifiedFact(value, [
      "acknowledged_at", "binding_fingerprint", "connector_idempotency_key", "connector_job_id",
      "connector_manifest_hash", "core_ack_fact_hash", "core_manifest_hash", "dispatch_request_hash",
      "ledger_epoch", "parent_fact_hash", "schema",
    ]);
    if (fact.schema !== ACK_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.parent_fact_hash !== output.fact_hash || fact.connector_manifest_hash !== output.spool_manifest_hash
      || !validHash(fact.core_manifest_hash) || !validHash(fact.core_ack_fact_hash)
      || !validTimestamp(fact.acknowledged_at)
      || Date.parse(String(fact.acknowledged_at)) < Date.parse(output.created_at)) throw new LedgerCorruptError();
    if (!this.factBindingMatches(fact, binding)) throw new LedgerBindingConflictError();
    return fact as unknown as EvidenceAckFact;
  }

  private evidenceQuarantine(
    value: unknown,
    binding: CoreIssuedEvalBinding,
    output: OutputFact,
  ): EvidenceQuarantineFact {
    const fact = verifiedFact(value, [
      "binding_fingerprint", "connector_idempotency_key", "connector_job_id", "delete_by",
      "core_quarantine_fact_hash", "dispatch_request_hash", "error_fact_hash", "ledger_epoch",
      "parent_fact_hash", "quarantined_at", "schema",
    ]);
    if (fact.schema !== QUARANTINE_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.parent_fact_hash !== output.fact_hash || !validHash(fact.error_fact_hash)
      || !validHash(fact.core_quarantine_fact_hash)
      || !validTimestamp(fact.quarantined_at) || !validTimestamp(fact.delete_by)
      || Date.parse(String(fact.quarantined_at)) < Date.parse(output.created_at)
      || Date.parse(String(fact.delete_by)) !== Date.parse(String(fact.quarantined_at)) + 24 * 60 * 60 * 1000) {
      throw new LedgerCorruptError();
    }
    if (!this.factBindingMatches(fact, binding)) throw new LedgerBindingConflictError();
    return fact as unknown as EvidenceQuarantineFact;
  }

  private evidenceExpired(
    value: unknown,
    binding: CoreIssuedEvalBinding,
    output: OutputFact,
    terminal: TerminalFact,
  ): EvidenceExpiredFact {
    const fact = verifiedFact(value, [
      "binding_fingerprint", "connector_idempotency_key", "connector_job_id", "dispatch_request_hash",
      "expired_at", "ledger_epoch", "manifest_hash", "parent_fact_hash", "schema", "terminal_fact_hash",
    ]);
    if (fact.schema !== EXPIRED_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.parent_fact_hash !== output.fact_hash || fact.manifest_hash !== output.spool_manifest_hash
      || fact.terminal_fact_hash !== terminal.fact_hash || !validTimestamp(fact.expired_at)
      || Date.parse(String(fact.expired_at)) < Date.parse(terminal.terminal_at) + 7 * 24 * 60 * 60 * 1000) {
      throw new LedgerCorruptError();
    }
    if (!this.factBindingMatches(fact, binding)) throw new LedgerBindingConflictError();
    return fact as unknown as EvidenceExpiredFact;
  }

  private evidenceDiscard(
    value: unknown,
    binding: CoreIssuedEvalBinding,
    reservation: ReservationFact,
  ): EvidenceDiscardFact {
    const fact = verifiedFact(value, [
      "binding_fingerprint", "connector_idempotency_key", "connector_job_id", "core_cleanup_fact_hash",
      "core_conclusion_fact_hash", "discard_authorization_hash", "discarded_at", "dispatch_request_hash",
      "ledger_epoch", "parent_fact_hash", "reason", "schema",
    ]);
    if (fact.schema !== DISCARD_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.parent_fact_hash !== reservation.fact_hash
      || !(fact.reason === "unavailable_at_deadline" || fact.reason === "absolute_expiry")
      || !validHash(fact.core_conclusion_fact_hash) || !validHash(fact.core_cleanup_fact_hash)
      || !validHash(fact.discard_authorization_hash) || !validTimestamp(fact.discarded_at)) {
      throw new LedgerCorruptError();
    }
    if (!this.factBindingMatches(fact, binding)) throw new LedgerBindingConflictError();
    return fact as unknown as EvidenceDiscardFact;
  }

  private evidenceCleanup(
    value: unknown,
    binding: CoreIssuedEvalBinding,
    authorization: EvidenceAckFact | EvidenceQuarantineFact | EvidenceExpiredFact | EvidenceDiscardFact,
  ): EvidenceCleanupFact {
    const fact = verifiedFact(value, [
      "authorization_fact_hash", "binding_fingerprint", "cleaned_at", "connector_idempotency_key",
      "core_cleanup_fact_hash",
      "connector_job_id", "dispatch_request_hash", "ledger_epoch", "parent_fact_hash", "schema",
    ]);
    const authorizationAt = authorization.schema === ACK_SCHEMA
      ? authorization.acknowledged_at
      : authorization.schema === QUARANTINE_SCHEMA
        ? authorization.quarantined_at
        : authorization.schema === EXPIRED_SCHEMA ? authorization.expired_at : authorization.discarded_at;
    if (fact.schema !== CLEANUP_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.authorization_fact_hash !== authorization.fact_hash
      || fact.parent_fact_hash !== authorization.fact_hash || !validHash(fact.core_cleanup_fact_hash)
      || !validTimestamp(fact.cleaned_at)
      || Date.parse(String(fact.cleaned_at)) < Date.parse(authorizationAt)) throw new LedgerCorruptError();
    if (!this.factBindingMatches(fact, binding)) throw new LedgerBindingConflictError();
    return fact as unknown as EvidenceCleanupFact;
  }

  private processExit(value: unknown, binding: CoreIssuedEvalBinding, process: ProcessFact): ProcessExitFact {
    const fact = verifiedFact(value, [
      "binding_fingerprint", "connector_idempotency_key", "connector_job_id", "dispatch_request_hash",
      "effect_owner_token_hash", "ledger_epoch", "parent_fact_hash", "pid", "process_group_id",
      "process_start_token", "schema", "stopped_at",
    ]);
    if (fact.schema !== PROCESS_EXIT_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.parent_fact_hash !== process.fact_hash || fact.effect_owner_token_hash !== process.effect_owner_token_hash
      || fact.pid !== process.pid || fact.process_group_id !== process.process_group_id
      || fact.process_start_token !== process.process_start_token || !validTimestamp(fact.stopped_at)) throw new LedgerCorruptError();
    if (!this.factBindingMatches(fact, binding)) throw new LedgerBindingConflictError();
    return fact as unknown as ProcessExitFact;
  }

  private processExitHead(
    value: unknown,
    binding: CoreIssuedEvalBinding,
    process: ProcessFact,
    processExit: ProcessExitFact,
  ): ProcessExitHeadFact {
    const fact = verifiedFact(value, [
      "binding_fingerprint", "connector_idempotency_key", "connector_job_id", "dispatch_request_hash",
      "effect_owner_token_hash", "ledger_epoch", "parent_fact_hash", "process_exit_fact_hash", "schema",
    ]);
    if (fact.schema !== PROCESS_EXIT_HEAD_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.parent_fact_hash !== process.fact_hash || fact.effect_owner_token_hash !== process.effect_owner_token_hash
      || fact.process_exit_fact_hash !== processExit.fact_hash) throw new LedgerCorruptError();
    if (!this.factBindingMatches(fact, binding)) throw new LedgerBindingConflictError();
    return fact as unknown as ProcessExitHeadFact;
  }

  private terminal(
    value: unknown,
    binding: CoreIssuedEvalBinding,
    processExit: ProcessExitFact,
    head: TerminalHeadFact,
  ): TerminalFact {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "error_code",
      "ledger_epoch",
      "parent_fact_hash",
      "process_stopped",
      "schema",
      "terminal_at",
      "terminal_state",
    ]);
    if (fact.schema !== TERMINAL_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch
      || fact.parent_fact_hash !== processExit.fact_hash || fact.fact_hash !== head.terminal_fact_hash
      || fact.process_stopped !== true || fact.terminal_state !== head.terminal_state
      || fact.terminal_at !== head.terminal_at || fact.error_code !== head.error_code
      || fact.effect_owner_token_hash !== processExit.effect_owner_token_hash
      || fact.effect_owner_token_hash !== head.effect_owner_token_hash || !validTimestamp(fact.terminal_at)
      || !(["succeeded", "failed", "cancelled", "timeout"] as const).includes(fact.terminal_state as EvolutionEvalTerminalState)
      || (fact.error_code !== null && (typeof fact.error_code !== "string" || !ERROR_CODE_PATTERN.test(fact.error_code)))) {
      throw new LedgerCorruptError();
    }
    if (!this.factBindingMatches(fact, binding)) throw new LedgerBindingConflictError();
    return fact as unknown as TerminalFact;
  }

  private factBindingMatches(
    fact: Record<string, unknown>,
    binding: CoreIssuedEvalBinding,
    includeEvalAndProject = false,
  ): boolean {
    return fact.connector_job_id === binding.dispatch.connector_job_id
      && fact.connector_idempotency_key === binding.dispatch.connector_idempotency_key
      && fact.dispatch_request_hash === binding.dispatch_request_hash
      && fact.binding_fingerprint === evolutionEvalBindingFingerprint(binding)
      && (!includeEvalAndProject || (
        fact.eval_job_id === binding.dispatch.eval_job_id
        && fact.project_id === binding.project_id
      ));
  }

  private errorObservation(binding: CoreIssuedEvalBinding, error: unknown): EvalLedgerQuery {
    if (error instanceof LedgerEpochMismatchError) return corrupt(binding, this.ledgerEpoch, ERROR.epochMismatch);
    if (error instanceof LedgerBindingConflictError) {
      const code = ERROR_CODE_PATTERN.test(error.message) ? error.message : ERROR.bindingConflict;
      return corrupt(binding, this.ledgerEpoch, code);
    }
    if (error instanceof LedgerReservationConflictError) {
      const code = ERROR_CODE_PATTERN.test(error.message) ? error.message : ERROR.reservationConflict;
      return corrupt(binding, this.ledgerEpoch, code);
    }
    if (error instanceof LedgerCorruptError) return corrupt(binding, this.ledgerEpoch, ERROR.corrupt);
    return unavailable(binding, this.ledgerEpoch);
  }

  private initializationCode(error: unknown): string {
    if (error instanceof LedgerEpochMismatchError) return ERROR.epochMismatch;
    if (error instanceof LedgerCorruptError) return ERROR.corrupt;
    return ERROR.unavailable;
  }

  private async validateLayout(): Promise<LedgerMetadata> {
    await this.assertDirectory(this.root);
    const metadata = this.metadata(await this.readRequired(join(this.root, "ledger.json")));
    await this.assertDirectory(this.facts);
    await this.assertDirectory(this.heads);
    await this.assertDirectory(this.indexes);
    return metadata;
  }

  private async assertDirectory(path: string): Promise<void> {
    let details;
    try { details = await lstat(path); } catch (error) {
      if (isErrno(error, "ENOENT")) throw new LedgerCorruptError();
      throw new LedgerUnavailableError();
    }
    if (!details.isDirectory() || details.isSymbolicLink()) throw new LedgerCorruptError();
  }

  private indexPath(binding: CoreIssuedEvalBinding): string {
    return join(this.indexes, `${evolutionEvalLedgerRecordKey(binding.dispatch.eval_job_id)}.json`);
  }

  private factPath(
    binding: CoreIssuedEvalBinding,
    kind: "reservation" | "accepted" | "process" | "stop-intent" | "output"
      | "evidence-ack" | "evidence-quarantine" | "evidence-expired" | "evidence-discard" | "evidence-cleanup"
      | "process-exit" | "terminal",
  ): string {
    const key = evolutionEvalLedgerRecordKey(binding.dispatch.connector_job_id);
    return join(this.facts, `${key}.${kind}.json`);
  }

  private headPath(binding: CoreIssuedEvalBinding, kind: "acceptance" | "process-exit" | "terminal"): string {
    const key = evolutionEvalLedgerRecordKey(binding.dispatch.connector_job_id);
    return join(this.heads, `${key}.${kind}.json`);
  }

  private isoNow(): string {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("ledger clock is invalid");
    return now.toISOString();
  }

  private async readRequired(path: string): Promise<unknown> {
    const value = await this.readOptional(path);
    if (value === undefined) throw new LedgerCorruptError();
    return value;
  }

  private async readOptional(path: string): Promise<unknown | undefined> {
    let details;
    try { details = await lstat(path); } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw new LedgerUnavailableError();
    }
    if (!details.isFile() || details.isSymbolicLink() || details.size < 2 || details.size > MAX_FACT_BYTES) {
      throw new LedgerCorruptError();
    }
    let body: string;
    try { body = await readFile(path, "utf8"); } catch { throw new LedgerUnavailableError(); }
    try { return JSON.parse(body) as unknown; } catch { throw new LedgerCorruptError(); }
  }

  /** The hard-link is the no-overwrite commit point; both data and directory are synced before success. */
  private async atomicCreate(
    path: string,
    value: unknown,
    factKind: EvolutionEvalLedgerFactKind,
    temporaryDirectory = dirname(path),
  ): Promise<boolean> {
    const directory = dirname(path);
    const temporary = join(temporaryDirectory, `.evolution-eval-${crypto.randomUUID()}.tmp`);
    const body = `${canonicalEvolutionEvalJson(value)}\n`;
    if (Buffer.byteLength(body, "utf8") > MAX_FACT_BYTES) throw new LedgerCorruptError();
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await this.inject("temp_write", factKind);
      await handle.writeFile(body, "utf8");
      await this.inject("file_fsync", factKind);
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (process.platform === "win32") {
        await this.inject("link", factKind);
        await this.inject("directory_fsync", factKind);
        const outcome = windowsMoveWriteThrough(temporary, path);
        if (outcome === "exists") {
          // The per-target Windows mutex is held across MoveFileExW. An
          // observer cannot receive ERROR_FILE_EXISTS until a competing
          // MOVEFILE_WRITE_THROUGH call has returned and released the mutex.
          return false;
        }
        return true;
      }
      try {
        await this.inject("link", factKind);
        await link(temporary, path);
      } catch (error) {
        if (isErrno(error, "EEXIST")) {
          // A competing process published the immutable winner. Its link may
          // still be between the commit point and its directory durability
          // fence, so the loser must provide that fence itself before it may
          // observe/return the winner as durable.
          await this.inject("directory_fsync", factKind);
          await this.syncDirectory(directory);
          return false;
        }
        throw error;
      }
      await this.inject("directory_fsync", factKind);
      await this.syncDirectory(directory);
      return true;
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async inject(operation: EvolutionEvalLedgerFsOperation, factKind: EvolutionEvalLedgerFactKind): Promise<void> {
    await this.faultInjector?.({ operation, factKind });
  }

  private async durabilityFence(path: string, factKind: EvolutionEvalLedgerFactKind): Promise<void> {
    await this.inject("directory_fsync", factKind);
    await this.syncDirectory(path);
  }

  private async syncDirectory(path: string): Promise<void> {
    if (process.platform === "win32") {
      // Windows cannot FlushFileBuffers on a directory handle (ERROR_ACCESS_DENIED).
      // Every mutable directory entry in this ledger is instead committed by
      // MoveFileExW(MOVEFILE_WRITE_THROUGH); this probe verifies the directory
      // remains addressable without pretending to provide an independent fence.
      const details = await lstat(path);
      if (!details.isDirectory() || details.isSymbolicLink()) throw new LedgerUnavailableError();
      return;
    }
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const queued = previous.then(() => gate);
    this.locks.set(key, queued);
    await previous;
    try { return await operation(); } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}
