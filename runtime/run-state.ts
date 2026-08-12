/**
 * Synthia Runtime — Run-state persistence.
 *
 * Persists loop progress to `runtime/.runs/<runId>.json` so that
 * `bun run runtime/cli.ts --resume <runId>` can continue a paused run after
 * a human approves a gate (G1–G4).
 *
 * The file is small, human-readable JSON: stage, registered artifacts, gate
 * submission ids, and the current status (running / awaiting_approval /
 * terminal). The loop writes to it at every stage boundary and gate stop.
 */

import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { GateId, StageId, RunState, RegisteredRevision } from "./types.ts";

const RUNS_DIR = join(import.meta.dirname ?? new URL(".runs", import.meta.url).pathname, ".runs");

export function newRunId(): string {
  return `run-${randomUUID()}`;
}

export function runStatePath(runId: string): string {
  return join(RUNS_DIR, `${runId}.json`);
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

export function createRunState(opts: {
  runId: string;
  task: string;
  part: string;
  projectId: string;
}): RunState {
  const now = new Date().toISOString();
  return {
    runId: opts.runId,
    task: opts.task,
    part: opts.part,
    projectId: opts.projectId,
    createdAt: now,
    updatedAt: now,
    currentStage: "intake",
    status: "running",
    docs: {},
    gateSubmissions: {},
    gateDecisions: {},
  };
}

export async function loadRunState(runId: string): Promise<RunState> {
  const raw = await readFile(runStatePath(runId), "utf8");
  return JSON.parse(raw) as RunState;
}

export async function saveRunState(state: RunState): Promise<void> {
  const updated: RunState = { ...state, updatedAt: new Date().toISOString() };
  await mkdir(RUNS_DIR, { recursive: true });
  await writeFile(runStatePath(state.runId), JSON.stringify(updated, null, 2) + "\n", "utf8");
}

/** List all saved run ids (newest file first). */
export async function listRuns(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(RUNS_DIR);
  } catch {
    return [];
  }
  return entries
    .filter(f => f.endsWith(".json"))
    .map(f => f.replace(/\.json$/, ""));
}

/** Remove a run-state file. No-op if it doesn't exist. */
export async function deleteRun(runId: string): Promise<void> {
  try { await unlink(runStatePath(runId)); } catch { /* no-op */ }
}

// ----- Functional updates for the loop -----

export function withStage(state: RunState, stage: StageId): RunState {
  return { ...state, currentStage: stage, status: "running" };
}

export function withAwaitingApproval(state: RunState, gate: GateId): RunState {
  return { ...state, status: "awaiting_approval", awaitingGate: gate };
}

export function withTerminal(state: RunState, status: "succeeded" | "failed" | "fail_closed", reason?: string): RunState {
  return { ...state, status, endedReason: reason, awaitingGate: undefined };
}

export function withDocArtifact(state: RunState, stage: StageId, rev: RegisteredRevision): RunState {
  const docs = { ...(state.docs ?? {}), [stage]: rev };
  return { ...state, docs };
}

export function withRtlRevision(state: RunState, rev: RegisteredRevision): RunState {
  return { ...state, rtlRevision: rev };
}

export function withGateSubmission(state: RunState, gate: GateId, submissionId: string): RunState {
  const gateSubmissions = { ...(state.gateSubmissions ?? {}), [gate]: submissionId };
  return { ...state, gateSubmissions };
}

export function withGateDecision(state: RunState, gate: GateId, decision: "approved" | "rejected" | "withdrawn"): RunState {
  const gateDecisions = { ...(state.gateDecisions ?? {}), [gate]: decision };
  return { ...state, gateDecisions };
}
