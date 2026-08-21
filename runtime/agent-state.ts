/**
 * Synthia Runtime — Agent-state persistence.
 *
 * Persists loop progress to `runtime/.runs/<agentId>.json` so that
 * `bun run runtime/cli.ts --resume <agentId>` can continue a paused agent after
 * a human approves a gate (G1–G4).
 *
 * The file is small, human-readable JSON: stage, registered artifacts, gate
 * submission ids, and the current status (running / awaiting_approval /
 * terminal). The loop writes to it at every stage boundary and gate stop.
 *
 * Note: the on-disk directory is still `.runs/` and the env override is still
 * `SYNTHIA_RUNS_DIR`. Renaming those is a storage migration (live state files
 * exist), not a rename — deliberately out of scope here.
 */

import { mkdir, readFile, writeFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { GateId, StageId, AgentState, RegisteredRevision } from "./types.ts";
import type { RuntimeTaskKind, TaskAuthorizationScope } from "./task-workspace-client.ts";

function agentsDir(): string {
  const override = process.env.SYNTHIA_RUNS_DIR;
  if (override) return override;
  return join(import.meta.dirname ?? new URL(".runs", import.meta.url).pathname, ".runs");
}

export function newAgentId(): string {
  return `agent-${randomUUID()}`;
}
export function agentStatePath(agentId: string): string {
  // Defensive: callers may pass an agent id derived from a directory listing that
  // includes the conversation sidecar suffix — always address the main file.
  const id = agentId.endsWith(".conversation") ? agentId.slice(0, -".conversation".length) : agentId;
  return join(agentsDir(), `${id}.json`);
}

const MESSAGE_IDEMPOTENCY_DIRECTORY = ".message-idempotency";

export interface RuntimeMessageIdempotencyRecord {
  readonly fingerprint: string;
  /**
   * `in_progress` is a durable intent written before message dispatch. Its
   * stored 409 response is deliberately replayable by older Runtime versions
   * that do not understand this discriminator, so rollback cannot re-run the
   * message either.
   */
  readonly state: "in_progress" | "completed";
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export function agentMessageIdempotencyPath(agentId: string): string {
  const id = agentId.endsWith(".conversation") ? agentId.slice(0, -".conversation".length) : agentId;
  return join(agentsDir(), MESSAGE_IDEMPOTENCY_DIRECTORY, `${id}.json`);
}

/**
 * Load the durable response ledger for Core→Runtime message dispatches.
 * Corruption fails closed: silently treating an unreadable ledger as empty
 * could execute an already-accepted user message a second time.
 */
export async function loadMessageIdempotencyRecords(
  agentId: string,
): Promise<Readonly<Record<string, RuntimeMessageIdempotencyRecord>>> {
  let raw: string;
  try {
    raw = await readFile(agentMessageIdempotencyPath(agentId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid message idempotency ledger for ${agentId}`);
  }
  const envelope = parsed as Record<string, unknown>;
  if (
    envelope.schema !== "runtime-message-idempotency.v1" ||
    !envelope.records ||
    typeof envelope.records !== "object" ||
    Array.isArray(envelope.records)
  ) {
    throw new Error(`invalid message idempotency ledger for ${agentId}`);
  }
  const records: Record<string, RuntimeMessageIdempotencyRecord> = Object.create(null);
  for (const [key, value] of Object.entries(envelope.records as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`invalid message idempotency record for ${agentId}`);
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.fingerprint) ||
      (record.state !== undefined &&
        record.state !== "in_progress" &&
        record.state !== "completed") ||
      typeof record.status !== "number" ||
      !Number.isInteger(record.status) ||
      !record.body ||
      typeof record.body !== "object" ||
      Array.isArray(record.body) ||
      typeof record.createdAt !== "string"
    ) {
      throw new Error(`invalid message idempotency record for ${agentId}`);
    }
    records[key] = {
      fingerprint: record.fingerprint,
      // Ledgers created before the intent protocol contain completed response
      // records without a state field. Treating those as completed preserves
      // the existing replay contract during rolling upgrades.
      state: record.state === "in_progress" ? "in_progress" : "completed",
      status: record.status,
      body: record.body as Readonly<Record<string, unknown>>,
      createdAt: record.createdAt,
    };
  }
  return records;
}

/** Atomically replace one agent's lightweight message-response ledger. */
export async function saveMessageIdempotencyRecords(
  agentId: string,
  records: Readonly<Record<string, RuntimeMessageIdempotencyRecord>>,
): Promise<void> {
  const path = agentMessageIdempotencyPath(agentId);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, JSON.stringify({
    schema: "runtime-message-idempotency.v1",
    records,
  }, null, 2) + "\n", "utf8");
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

/** The ordered stage chain. */
export const STAGE_ORDER: readonly StageId[] = [
  "intake",
  "behavior_wave",
  "architecture",
  "register_spec",
  "rtl_build",
  "validate",
  "tb",
  "simulate",
  "xdc",
  "synthesize",
  "implement",
];

export function nextStage(stage: StageId): StageId | undefined {
  const idx = STAGE_ORDER.indexOf(stage);
  return idx >= 0 && idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1] : undefined;
}

export function createAgentState(opts: {
  agentId: string;
  taskId?: string;
  taskKind?: RuntimeTaskKind;
  parentTaskId?: string;
  workspaceId?: string;
  authorization?: TaskAuthorizationScope;
  inputHash?: string;
  taskDescriptorHash?: string;
  task: string;
  part: string;
  projectId: string;
  processInstanceId?: string;
  projectType?: string;
  processVersionId?: string | null;
  processProfileId?: string | null;
  processProfileName?: string | null;
  processProfileVersion?: string | null;
  executionMode?: "free" | "engineering";
}): AgentState {
  const now = new Date().toISOString();
  return {
    agentId: opts.agentId,
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.taskKind ? { taskKind: opts.taskKind } : {}),
    ...(opts.parentTaskId ? { parentTaskId: opts.parentTaskId } : {}),
    ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    ...(opts.authorization ? { authorization: opts.authorization } : {}),
    ...(opts.inputHash ? { inputHash: opts.inputHash } : {}),
    ...(opts.taskDescriptorHash ? { taskDescriptorHash: opts.taskDescriptorHash } : {}),
    task: opts.task,
    part: opts.part,
    projectId: opts.projectId,
    ...(opts.projectType ? { projectType: opts.projectType } : {}),
    ...(opts.processVersionId !== undefined ? { processVersionId: opts.processVersionId } : {}),
    ...(opts.processProfileId !== undefined ? { processProfileId: opts.processProfileId } : {}),
    ...(opts.processProfileName !== undefined ? { processProfileName: opts.processProfileName } : {}),
    ...(opts.processProfileVersion !== undefined ? { processProfileVersion: opts.processProfileVersion } : {}),
    ...(opts.executionMode ? { executionMode: opts.executionMode } : {}),
    ...(opts.processInstanceId ? { processInstanceId: opts.processInstanceId } : {}),
    createdAt: now,
    updatedAt: now,
    currentStage: "intake",
    status: "running",
    docs: {},
    gateSubmissions: {},
    gateDecisions: {},
  };
}

export async function loadAgentState(agentId: string): Promise<AgentState> {
  const raw = await readFile(agentStatePath(agentId), "utf8");
  const state = JSON.parse(raw) as AgentState;
  // Back-compat: pre-rename files persisted the id under `runId`, not `agentId`.
  // Stamp it from the (always-correct, filename-derived) parameter so callers
  // never see a missing agentId.
  return state.agentId ? state : { ...state, agentId };
}

export async function saveAgentState(state: AgentState): Promise<void> {
  const updated: AgentState = { ...state, updatedAt: new Date().toISOString() };
  await mkdir(agentsDir(), { recursive: true });
  await writeFile(agentStatePath(state.agentId), JSON.stringify(updated, null, 2) + "\n", "utf8");
}

/** List all saved agent ids (newest file first). */
export async function listAgents(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(agentsDir());
  } catch {
    return [];
  }
  return entries
    .filter(f =>
      f.endsWith(".json") &&
      !f.endsWith(".conversation.json")
    )
    .map(f => f.replace(/\.json$/, ""));
}

/** Remove an agent-state file. No-op if it doesn't exist. */
export async function deleteAgent(agentId: string): Promise<void> {
  try { await unlink(agentStatePath(agentId)); } catch { /* no-op */ }
  try { await unlink(agentMessageIdempotencyPath(agentId)); } catch { /* no-op */ }
}

// ----- Functional updates for the loop -----

export function withStage(state: AgentState, stage: StageId): AgentState {
  return { ...state, currentStage: stage, status: "running" };
}

export function withAwaitingApproval(state: AgentState, gate: GateId): AgentState {
  return { ...state, status: "awaiting_approval", awaitingGate: gate };
}

export function withTerminal(state: AgentState, status: "succeeded" | "failed" | "fail_closed", reason?: string): AgentState {
  return { ...state, status, endedReason: reason, awaitingGate: undefined };
}

export function withDocArtifact(state: AgentState, stage: StageId, rev: RegisteredRevision): AgentState {
  const docs = { ...(state.docs ?? {}), [stage]: rev };
  return { ...state, docs };
}

export function withRtlRevision(state: AgentState, rev: RegisteredRevision): AgentState {
  return { ...state, rtlRevision: rev };
}

export function withGateSubmission(state: AgentState, gate: GateId, submissionId: string): AgentState {
  const gateSubmissions = { ...(state.gateSubmissions ?? {}), [gate]: submissionId };
  return { ...state, gateSubmissions };
}

export function withGateDecision(state: AgentState, gate: GateId, decision: "approved" | "rejected" | "withdrawn"): AgentState {
  const gateDecisions = { ...(state.gateDecisions ?? {}), [gate]: decision };
  return { ...state, gateDecisions };
}
