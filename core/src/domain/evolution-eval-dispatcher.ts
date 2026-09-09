export const EVOLUTION_EVAL_DISPATCHER_EVENT_TYPES = [
  "evolution_eval.dispatch_requested",
  "evolution_eval.reconcile_requested",
  "evolution_eval.dispatch_tombstoned",
  "evolution_eval.evidence.freeze_requested",
  "evolution_eval.evidence.ack_requested",
  "evolution_eval.evidence.quarantine_requested",
  "evolution_eval.evidence.cleanup_requested",
] as const;

export type EvolutionEvalDispatcherEventType =
  (typeof EVOLUTION_EVAL_DISPATCHER_EVENT_TYPES)[number];

export const EVOLUTION_EVAL_DISPATCHER_DUTIES = [
  "dispatch",
  "reconcile",
  "tombstone",
  "freeze_evidence",
  "ack_evidence",
  "quarantine_evidence",
  "cleanup_evidence",
] as const;

export type EvolutionEvalDispatcherDuty =
  (typeof EVOLUTION_EVAL_DISPATCHER_DUTIES)[number];

export const EVOLUTION_EVAL_LEDGER_STATES = [
  "proven_never_accepted",
  "accepted",
  "terminal",
  "transient_unavailable",
  "ambiguous",
  "ledger_corrupt",
] as const;

export type EvolutionEvalLedgerState =
  (typeof EVOLUTION_EVAL_LEDGER_STATES)[number];

export const EVOLUTION_EVAL_DISPATCHER_DEFAULT_LEASE_MS = 30_000;
export const EVOLUTION_EVAL_DISPATCHER_MAX_LEASE_MS = 5 * 60_000;

const DUTY_BY_EVENT: Readonly<Record<
  EvolutionEvalDispatcherEventType,
  EvolutionEvalDispatcherDuty
>> = Object.freeze({
  "evolution_eval.dispatch_requested": "dispatch",
  "evolution_eval.reconcile_requested": "reconcile",
  "evolution_eval.dispatch_tombstoned": "tombstone",
  "evolution_eval.evidence.freeze_requested": "freeze_evidence",
  "evolution_eval.evidence.ack_requested": "ack_evidence",
  "evolution_eval.evidence.quarantine_requested": "quarantine_evidence",
  "evolution_eval.evidence.cleanup_requested": "cleanup_evidence",
});

export interface EvolutionEvalDispatcherLease {
  readonly eventId: string;
  readonly eventType: EvolutionEvalDispatcherEventType;
  readonly duty: EvolutionEvalDispatcherDuty;
  readonly aggregateId: string;
  readonly holderId: string;
  readonly leaseNonce: string;
  readonly leaseExpiresAt: string;
  readonly attemptCount: number;
}

export function isEvolutionEvalDispatcherEventType(
  value: string,
): value is EvolutionEvalDispatcherEventType {
  return Object.hasOwn(DUTY_BY_EVENT, value);
}

export function evolutionEvalDispatcherDutyForEvent(
  eventType: string,
): EvolutionEvalDispatcherDuty | null {
  return isEvolutionEvalDispatcherEventType(eventType)
    ? DUTY_BY_EVENT[eventType]
    : null;
}

export function requireEvolutionEvalDispatcherLeaseMs(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < 1_000
    || value > EVOLUTION_EVAL_DISPATCHER_MAX_LEASE_MS
  ) {
    throw new TypeError("dispatcher lease duration must be an integer between 1000 and 300000 ms");
  }
  return value;
}

export function mayReplayEvolutionEvalDispatch(
  state: EvolutionEvalLedgerState,
  replayPermitted: boolean,
): boolean {
  return state === "proven_never_accepted" && replayPermitted;
}

export function isEvolutionEvalDefinitiveCancelBoundary(
  cancelReason: "tombstoned" | "deadline" | null,
  deadlineValid: boolean,
): boolean {
  return cancelReason === "deadline" || !deadlineValid;
}
