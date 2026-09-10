import type { StageId } from "./types.ts";
import type {
  P4GateId,
  ProcessActivity,
  ProcessProfileV1,
} from "./process-profile.ts";
import type { ProcessStateV1 } from "./types.ts";

/**
 * The model-facing stages which implement each Core-owned profile activity.
 * Some profile activities deliberately share one generated artifact: the
 * behavior/wave document also carries the verification plan, and the detailed
 * design document carries the constraint strategy. `implement` expands to an
 * independent synthesis followed by implementation, as required by the P4
 * formal-flow contract.
 */
const ACTIVITY_STAGES: Readonly<Record<ProcessActivity, readonly StageId[]>> = {
  prepare_project: [],
  intake: ["intake"],
  behavior_wave: ["behavior_wave"],
  verification_plan: ["behavior_wave"],
  architecture: ["architecture"],
  register_spec: ["register_spec"],
  constraint_strategy: ["register_spec"],
  rtl_build: ["rtl_build"],
  validate: ["validate"],
  tb: ["tb"],
  simulate: ["simulate"],
  xdc: ["xdc"],
  implement: ["synthesize", "implement"],
  delivery: [],
};

export interface RuntimeProcessPlan {
  readonly profileHash: string;
  readonly stages: readonly StageId[];
  readonly stagesByGate: Readonly<Record<P4GateId, readonly StageId[]>>;
  readonly gateAfterStage: Readonly<Partial<Record<StageId, P4GateId>>>;
}

function uniqueStages(activities: readonly ProcessActivity[]): StageId[] {
  const stages: StageId[] = [];
  for (const activity of activities) {
    for (const stage of ACTIVITY_STAGES[activity]) {
      if (!stages.includes(stage)) stages.push(stage);
    }
  }
  return stages;
}

/** Derive Runtime ordering and gate boundaries solely from process-profile.v1. */
export function buildRuntimeProcessPlan(profile: ProcessProfileV1): RuntimeProcessPlan {
  const stages: StageId[] = [];
  const stagesByGate = {} as Record<P4GateId, readonly StageId[]>;
  const gateAfterStage: Partial<Record<StageId, P4GateId>> = {};

  for (const node of profile.nodes) {
    const nodeStages = uniqueStages(node.activities);
    stagesByGate[node.id] = nodeStages;
    for (const stage of nodeStages) {
      if (stages.includes(stage)) {
        throw new Error(`process profile maps stage ${stage} to more than one gate`);
      }
      stages.push(stage);
    }
    const boundary = nodeStages.at(-1);
    if (boundary !== undefined) gateAfterStage[boundary] = node.id;
  }

  return Object.freeze({
    profileHash: profile.profileHash,
    stages: Object.freeze(stages),
    stagesByGate: Object.freeze(stagesByGate),
    gateAfterStage: Object.freeze(gateAfterStage),
  });
}

export function firstStageForGate(
  plan: RuntimeProcessPlan,
  gate: P4GateId,
): StageId | undefined {
  return plan.stagesByGate[gate][0];
}

export function stageAfterGate(
  plan: RuntimeProcessPlan,
  gate: P4GateId,
): StageId | undefined {
  const boundary = plan.stagesByGate[gate].at(-1);
  if (boundary === undefined) return undefined;
  const index = plan.stages.indexOf(boundary);
  return index >= 0 ? plan.stages[index + 1] : undefined;
}

export class ProcessReadinessError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ProcessReadinessError";
  }
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Modern snapshots accept only the canonical SHA-256 policy binding. */
export function assertModernToolModelPolicyHash(value: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new ProcessReadinessError(
      "modern engineering requires SYNTHIA_TOOL_MODEL_POLICY_HASH to be a 64-character lowercase SHA-256 digest",
      "TOOL_MODEL_POLICY_HASH_INVALID",
    );
  }
}

/**
 * Validate the Core projection before any modern engineering activity runs.
 * G0 intentionally does not require complete constraints; that stricter fact
 * is consumed only by Core when it authorizes a formal G4 input.
 */
export function assertModernProcessReady(input: {
  readonly state: ProcessStateV1;
  readonly profile: ProcessProfileV1;
  readonly projectId: string;
  readonly processInstanceId: string;
}): void {
  const { state, profile, projectId, processInstanceId } = input;
  if (state.projectId !== projectId || state.processInstanceId !== processInstanceId) {
    throw new ProcessReadinessError(
      "Core process state does not belong to this Runtime project/process instance",
      "PROCESS_STATE_OWNERSHIP_MISMATCH",
    );
  }
  if (state.profileId !== profile.id || state.profileHash !== profile.profileHash) {
    throw new ProcessReadinessError(
      "Core process state does not match the frozen process profile",
      "PROCESS_PROFILE_HASH_MISMATCH",
    );
  }
  if (!(state.readiness?.status === "confirmed" && state.readiness.ready)) {
    throw new ProcessReadinessError(
      "G0 readiness must be confirmed and ready before engineering execution",
      "G0_READINESS_REQUIRED",
    );
  }
}
