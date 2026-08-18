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

import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { GateId, StageId, AgentState, RegisteredRevision } from "./types.ts";

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
  task: string;
  part: string;
  projectId: string;
  processInstanceId?: string;
}): AgentState {
  const now = new Date().toISOString();
  return {
    agentId: opts.agentId,
    task: opts.task,
    part: opts.part,
    projectId: opts.projectId,
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
  return JSON.parse(raw) as AgentState;
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
    .filter(f => f.endsWith(".json") && !f.endsWith(".conversation.json"))
    .map(f => f.replace(/\.json$/, ""));
}

/** Remove an agent-state file. No-op if it doesn't exist. */
export async function deleteAgent(agentId: string): Promise<void> {
  try { await unlink(agentStatePath(agentId)); } catch { /* no-op */ }
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
