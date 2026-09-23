import type { TransactionClient } from "../db/repository.ts";
import { computeEvolutionEfficiency, type EvolutionEfficiencyV1, type EvaluationOutcome } from "../domain/self-evolution.ts";

interface EfficiencyRow {
  readonly skill_id: string;
  readonly outcome: EvaluationOutcome | null;
  readonly baseline_ms: string | null;
  readonly applied_ms: string | null;
}

/** Match the existing per-skill comparison: cap each positive event gap at ten minutes. */
export const EVOLUTION_ACTIVE_GAP_CAP_SECONDS = 600;

/** All versions, including archived skills. Exactly one primary attribution per application. */
export async function readEvolutionEfficiency(
  query: Pick<TransactionClient, "query">,
): Promise<EvolutionEfficiencyV1> {
  const result = await query.query(
    `WITH primary_applications AS MATERIALIZED (
       SELECT a.id,a.task_id,a.start_event_sequence,a.end_event_sequence,
              sas.skill_id,sas.version_id,current_eval.outcome
         FROM skill_application a
         JOIN skill_application_skill sas ON sas.application_id=a.id AND sas.role='primary'
         LEFT JOIN LATERAL (
           SELECT ce.outcome FROM curator_evaluation ce
            WHERE ce.application_id=a.id AND ce.version_id=sas.version_id
              AND NOT EXISTS (SELECT 1 FROM curator_evaluation newer WHERE newer.supersedes_id=ce.id)
            ORDER BY ce.created_at DESC,ce.id DESC LIMIT 1
         ) current_eval ON true
     ), baselines AS MATERIALIZED (
       SELECT ids.skill_id,baseline.active_ms
         FROM (SELECT DISTINCT skill_id FROM primary_applications WHERE outcome='success') ids
         LEFT JOIN learned_skill_version v ON v.skill_id=ids.skill_id AND v.version_no=1
         LEFT JOIN distillation_run d ON d.id=v.distillation_run_id
         LEFT JOIN learning_episode e ON e.id=d.episode_id
         LEFT JOIN LATERAL (
           SELECT floor(sum(least(gap.seconds, $1)) * 1000)::bigint AS active_ms
             FROM (
               SELECT EXTRACT(EPOCH FROM (ev.created_at - LAG(ev.created_at) OVER (ORDER BY ev.sequence))) AS seconds
                 FROM task_conversation_event ev
                WHERE ev.task_id=e.task_id AND ev.sequence<=e.end_event_sequence
             ) gap WHERE gap.seconds > 0
         ) baseline ON true
     )
     SELECT a.id,a.skill_id,a.outcome,b.active_ms AS baseline_ms,applied.active_ms AS applied_ms
       FROM primary_applications a
       LEFT JOIN baselines b ON b.skill_id=a.skill_id
       LEFT JOIN LATERAL (
         SELECT floor(sum(least(gap.seconds, $1)) * 1000)::bigint AS active_ms
           FROM (
             SELECT EXTRACT(EPOCH FROM (ev.created_at - LAG(ev.created_at) OVER (ORDER BY ev.sequence))) AS seconds
               FROM task_conversation_event ev
              WHERE a.outcome='success' AND ev.task_id=a.task_id
                AND ev.sequence>=a.start_event_sequence AND ev.sequence<=a.end_event_sequence
           ) gap WHERE gap.seconds > 0
       ) applied ON true`,
    [EVOLUTION_ACTIVE_GAP_CAP_SECONDS],
  );
  return computeEvolutionEfficiency((result.rows as EfficiencyRow[]).map((row) => ({
    skillId: String(row.skill_id),
    outcome: row.outcome ?? null,
    baselineMs: row.baseline_ms == null ? null : Number(row.baseline_ms),
    appliedMs: row.applied_ms == null ? null : Number(row.applied_ms),
  })));
}
