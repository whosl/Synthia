-- Human-controlled requeue: an evaluated application may return to
-- pending_evaluation for re-evaluation (audited via the requeue endpoint's
-- outbox event; close facts and identity stay immutable).

CREATE OR REPLACE FUNCTION public.synthia_validate_skill_application_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'skill application rejects delete' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.task_id IS DISTINCT FROM NEW.task_id
     OR OLD.observation_key IS DISTINCT FROM NEW.observation_key
     OR OLD.local_goal IS DISTINCT FROM NEW.local_goal
     OR OLD.primary_tool_call_id IS DISTINCT FROM NEW.primary_tool_call_id
     OR OLD.start_event_sequence IS DISTINCT FROM NEW.start_event_sequence
     OR OLD.started_at IS DISTINCT FROM NEW.started_at
     OR OLD.created_by_type IS DISTINCT FROM NEW.created_by_type
     OR OLD.created_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'skill application identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.episode_id IS NOT NULL AND OLD.episode_id IS DISTINCT FROM NEW.episode_id THEN
    RAISE EXCEPTION 'skill application episode binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.end_event_sequence IS NOT NULL
     AND (
       OLD.end_event_sequence IS DISTINCT FROM NEW.end_event_sequence
       OR OLD.outcome_claim IS DISTINCT FROM NEW.outcome_claim
       OR OLD.human_corrections IS DISTINCT FROM NEW.human_corrections
       OR OLD.evidence_refs IS DISTINCT FROM NEW.evidence_refs
       OR OLD.tool_run_refs IS DISTINCT FROM NEW.tool_run_refs
       OR OLD.closed_at IS DISTINCT FROM NEW.closed_at
     ) THEN
    RAISE EXCEPTION 'skill application close facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'open' AND NEW.state IN ('closed_pending_episode','pending_evaluation') THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'closed_pending_episode' AND NEW.state = 'pending_evaluation' THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'pending_evaluation' AND NEW.state = 'evaluated' THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'evaluated' AND NEW.state = 'pending_evaluation' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal skill application transition: % -> %', OLD.state, NEW.state USING ERRCODE = '55000';
END;
$function$;

INSERT INTO schema_migrations(version) VALUES ('0039_application_requeue_transition') ON CONFLICT (version) DO NOTHING;
