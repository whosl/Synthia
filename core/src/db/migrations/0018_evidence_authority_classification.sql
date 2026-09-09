BEGIN;

-- Generic governed evidence carries its own immutable classification even
-- though evolution-eval evidence lives in a separate table.  This gives every
-- formal selector an independent decision input in addition to run_class.
ALTER TABLE tool_run_evidence_entry
  ADD COLUMN IF NOT EXISTS artifact_classification text NOT NULL
    DEFAULT 'tool_run_evidence'
    CHECK (artifact_classification IN (
      'tool_run_evidence','experimental/evolution_eval','evolution_eval_evidence'
    )),
  ADD COLUMN IF NOT EXISTS usage_classification text NOT NULL
    DEFAULT 'run_class_governed'
    CHECK (usage_classification IN ('run_class_governed','evolution_eval_only'));

ALTER TABLE bitstream_result
  ADD COLUMN IF NOT EXISTS artifact_classification text NOT NULL
    DEFAULT 'tool_run_evidence'
    CHECK (artifact_classification IN (
      'tool_run_evidence','experimental/evolution_eval'
    )),
  ADD COLUMN IF NOT EXISTS usage_classification text NOT NULL
    DEFAULT 'run_class_governed'
    CHECK (usage_classification IN ('run_class_governed','evolution_eval_only'));

CREATE OR REPLACE FUNCTION synthia_validate_tool_run_evidence_classification()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_run_class run_class;
BEGIN
  SELECT run_class INTO source_run_class
    FROM tool_run
   WHERE id=NEW.tool_run_id AND project_id=NEW.project_id;
  IF NOT FOUND
     OR source_run_class='evolution_eval'
     OR NEW.artifact_classification<>'tool_run_evidence'
     OR NEW.usage_classification<>'run_class_governed' THEN
    RAISE EXCEPTION 'generic evidence requires a non-evolution classification'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tool_run_evidence_classification_guard
  ON tool_run_evidence_entry;
CREATE TRIGGER tool_run_evidence_classification_guard
  BEFORE INSERT ON tool_run_evidence_entry
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_tool_run_evidence_classification();

CREATE OR REPLACE FUNCTION synthia_validate_bitstream_result_classification()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_run_class run_class;
  source_artifact_classification text;
  source_usage_classification text;
BEGIN
  SELECT run.run_class,evidence.artifact_classification,evidence.usage_classification
    INTO source_run_class,source_artifact_classification,source_usage_classification
    FROM tool_run run
    JOIN tool_run_evidence_entry evidence
      ON evidence.tool_run_id=run.id AND evidence.project_id=run.project_id
   WHERE run.id=NEW.tool_run_id AND run.project_id=NEW.project_id
     AND evidence.manifest_id=NEW.evidence_manifest_id
     AND evidence.name=NEW.evidence_entry_name;
  IF NOT FOUND
     OR source_run_class='evolution_eval'
     OR (NEW.class='formal' AND source_run_class<>'formal')
     OR NEW.artifact_classification<>'tool_run_evidence'
     OR NEW.usage_classification<>'run_class_governed'
     OR source_artifact_classification IS DISTINCT FROM NEW.artifact_classification
     OR source_usage_classification IS DISTINCT FROM NEW.usage_classification THEN
    RAISE EXCEPTION 'bitstream classification does not match governed source evidence'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bitstream_result_classification_guard ON bitstream_result;
CREATE TRIGGER bitstream_result_classification_guard
  BEFORE INSERT ON bitstream_result
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_bitstream_result_classification();

CREATE OR REPLACE FUNCTION synthia_validate_delivery_item_classification()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_type='tool_run' AND NOT EXISTS (
    SELECT 1 FROM tool_run run
     WHERE run.id=NEW.source_id AND run.project_id=NEW.project_id
       AND run.run_class='formal'
  ) THEN
    RAISE EXCEPTION 'delivery run result requires a formal ToolRun'
      USING ERRCODE='23514';
  END IF;
  IF NEW.source_type='tool_run_evidence_manifest' AND NOT EXISTS (
    SELECT 1
      FROM tool_run_evidence_manifest manifest
      JOIN tool_run run
        ON run.id=manifest.tool_run_id AND run.project_id=manifest.project_id
     WHERE manifest.id=NEW.source_id AND manifest.project_id=NEW.project_id
       AND run.run_class='formal'
       AND NOT EXISTS (
         SELECT 1 FROM tool_run_evidence_entry evidence
          WHERE evidence.manifest_id=manifest.id
            AND evidence.project_id=manifest.project_id
            AND (
              evidence.artifact_classification<>'tool_run_evidence'
              OR evidence.usage_classification<>'run_class_governed'
            )
       )
  ) THEN
    RAISE EXCEPTION 'delivery evidence manifest requires formal non-evolution classification'
      USING ERRCODE='23514';
  END IF;
  IF NEW.source_type='tool_run_evidence_entry' AND NOT EXISTS (
    SELECT 1
      FROM tool_run_evidence_entry evidence
      JOIN tool_run run
        ON run.id=evidence.tool_run_id AND run.project_id=evidence.project_id
     WHERE evidence.id=NEW.source_id AND evidence.project_id=NEW.project_id
       AND run.run_class='formal'
       AND evidence.artifact_classification='tool_run_evidence'
       AND evidence.usage_classification='run_class_governed'
  ) THEN
    RAISE EXCEPTION 'delivery evidence requires formal non-evolution classification'
      USING ERRCODE='23514';
  END IF;
  IF NEW.source_type='bitstream_result' AND NOT EXISTS (
    SELECT 1
      FROM bitstream_result bitstream
      JOIN tool_run run
        ON run.id=bitstream.tool_run_id AND run.project_id=bitstream.project_id
     WHERE bitstream.id=NEW.source_id AND bitstream.project_id=NEW.project_id
       AND bitstream.class='formal' AND run.run_class='formal'
       AND bitstream.artifact_classification='tool_run_evidence'
       AND bitstream.usage_classification='run_class_governed'
  ) THEN
    RAISE EXCEPTION 'delivery bitstream requires formal non-evolution classification'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS delivery_release_item_classification_guard
  ON delivery_release_item;
CREATE TRIGGER delivery_release_item_classification_guard
  BEFORE INSERT ON delivery_release_item
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_delivery_item_classification();

CREATE OR REPLACE FUNCTION synthia_validate_delivery_release_classification()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM bitstream_result bitstream
      JOIN tool_run run
        ON run.id=bitstream.tool_run_id AND run.project_id=bitstream.project_id
     WHERE bitstream.id=NEW.bitstream_result_id
       AND bitstream.project_id=NEW.project_id
       AND bitstream.class='formal' AND run.run_class='formal'
       AND bitstream.artifact_classification='tool_run_evidence'
       AND bitstream.usage_classification='run_class_governed'
  ) THEN
    RAISE EXCEPTION 'delivery release rejects evolution-eval classified bitstreams'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS delivery_release_classification_guard ON delivery_release;
CREATE TRIGGER delivery_release_classification_guard
  BEFORE INSERT ON delivery_release
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_delivery_release_classification();

INSERT INTO schema_migrations(version)
VALUES ('0018_evidence_authority_classification')
ON CONFLICT (version) DO NOTHING;

COMMIT;
