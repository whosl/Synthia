BEGIN;

-- Synthia Core — inline content column for artifact_revision (Web UI-1 slice)
-- Adds a nullable `content` column so an ArtifactRevision may carry its full
-- content inline. When content is supplied the server computes content_hash and
-- content_location defaults to db://artifact_revision/<id>; when content is
-- omitted the content continues to live out-of-band (git / object storage) and
-- is addressed by content_location, leaving `content` NULL.
-- Safe to re-run; fully transactional. Depends on 0000 (artifact_revision table).
ALTER TABLE artifact_revision ADD COLUMN IF NOT EXISTS content text;

INSERT INTO schema_migrations(version) VALUES ('0005_revision_content') ON CONFLICT (version) DO NOTHING;
COMMIT;
