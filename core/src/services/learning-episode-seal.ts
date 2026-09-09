import type { TransactionClient } from "../db/repository.ts";
import { canonicalRequestHash } from "../hashing.ts";

interface SealTask {
  readonly id: string;
  readonly project_id: string;
  readonly agent_role: "project" | "run" | "side";
}

export interface SealLearningEpisodeInput {
  readonly task: SealTask;
  readonly sequence: number;
  readonly payload: Record<string, unknown>;
  readonly actorType: string;
  readonly actorId: string;
}

function normalizedStatus(task: SealTask, payload: Record<string, unknown>): string {
  const raw = String(payload.status ?? "");
  if (task.agent_role === "project" && (raw === "succeeded" || raw === "completed")) {
    return "awaiting_user";
  }
  if (raw === "idle" || raw === "interrupted" || raw === "awaiting_approval") return "awaiting_user";
  if (raw === "aborted") return "cancelled";
  if (raw === "completed") return "succeeded";
  return raw;
}

/** Seal a qualifying status boundary in the same transaction as the event. */
export async function sealLearningEpisodeAtStatus(
  tx: TransactionClient,
  input: SealLearningEpisodeInput,
): Promise<{ episodeId: string; created: boolean } | null> {
  const { task, sequence, payload } = input;
  const status = normalizedStatus(task, payload);
  const projectTurn = task.agent_role === "project";
  const boundedTerminal = new Set(["succeeded", "failed", "cancelled", "fail_closed"]).has(status);
  if ((projectTurn && status !== "awaiting_user") || (!projectTurn && !boundedTerminal)) return null;
  const turnId = projectTurn && typeof payload.turn_id === "string" && payload.turn_id.trim() !== ""
    ? payload.turn_id
    : null;
  if (projectTurn && turnId === null) return null;
  const observationKey = projectTurn ? `turn:${turnId}` : `task:${task.id}`;
  const episodeKey = projectTurn ? `${observationKey}:${sequence}` : `terminal:${sequence}`;

  const eventResult = await tx.query(
    `SELECT created_at FROM task_conversation_event
      WHERE task_id=$1 AND sequence=$2 AND event_kind='status'`,
    [task.id, sequence],
  );
  const event = eventResult.rows[0] as { created_at?: unknown } | undefined;
  if (!event) throw new Error("episode boundary status event is missing");
  const rangeResult = await tx.query(
    `SELECT min(sequence)::bigint AS start_sequence,max(sequence)::bigint AS end_sequence
       FROM task_conversation_event
      WHERE task_id=$1 AND sequence <= $2
        AND event_kind IN ('tool_call','tool_result')
        AND ($3::text IS NULL OR payload->>'turn_id'=$3)`,
    [task.id, sequence, turnId],
  );
  const range = rangeResult.rows[0] as { start_sequence?: unknown; end_sequence?: unknown };
  const toolStart = range.start_sequence === null || range.start_sequence === undefined
    ? null
    : Number(range.start_sequence);
  const toolEnd = range.end_sequence === null || range.end_sequence === undefined
    ? null
    : Number(range.end_sequence);
  const episodeId = `lep_${canonicalRequestHash({ taskId: task.id, observationKey }).slice(0, 40)}`;
  const inserted = await tx.query(
    `INSERT INTO learning_episode
      (id,project_id,task_id,observation_key,episode_key,turn_id,end_event_sequence,
       content_hash,outcome_claim,tool_event_start_sequence,tool_event_end_sequence,
       evidence_refs,created_by_type,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,'[]'::jsonb,$11,$12)
     ON CONFLICT (task_id,observation_key) DO NOTHING
     RETURNING id`,
    [
      episodeId,
      task.project_id,
      task.id,
      observationKey,
      episodeKey,
      turnId,
      sequence,
      canonicalRequestHash({
        schema: "learning-episode-boundary.v1",
        task_id: task.id,
        observation_key: observationKey,
        episode_key: episodeKey,
        status,
        payload,
      }),
      toolStart,
      toolEnd,
      input.actorType,
      input.actorId,
    ],
  );
  if (inserted.rows.length === 0) {
    const existing = await tx.query(
      `SELECT id FROM learning_episode WHERE task_id=$1 AND observation_key=$2`,
      [task.id, observationKey],
    );
    return { episodeId: String((existing.rows[0] as { id: unknown }).id), created: false };
  }
  await tx.query(
    `UPDATE skill_application
        SET episode_id=$3,
            state=CASE WHEN state IN ('open','closed_pending_episode') THEN 'pending_evaluation' ELSE state END,
            end_event_sequence=CASE WHEN state='open' THEN $4 ELSE end_event_sequence END,
            outcome_claim=CASE WHEN state='open' THEN NULL ELSE outcome_claim END,
            human_corrections=CASE WHEN state='open' THEN 0 ELSE human_corrections END,
            evidence_refs=CASE WHEN state='open' THEN '[]'::jsonb ELSE evidence_refs END,
            tool_run_refs=CASE WHEN state='open' THEN '[]'::jsonb ELSE tool_run_refs END,
            closed_at=CASE WHEN state='open' THEN $5 ELSE closed_at END
      WHERE task_id=$1 AND observation_key=$2 AND episode_id IS NULL`,
    [task.id, observationKey, episodeId, sequence, event.created_at],
  );
  const distillationId = `dst_${canonicalRequestHash({ episodeId }).slice(0, 40)}`;
  await tx.query(
    `INSERT INTO distillation_run(id,episode_id,state,ready_at,created_at,updated_at)
     VALUES ($1,$2,'queued',now()+interval '30 seconds',now(),now())
     ON CONFLICT (episode_id) DO NOTHING`,
    [distillationId, episodeId],
  );
  return { episodeId, created: true };
}
