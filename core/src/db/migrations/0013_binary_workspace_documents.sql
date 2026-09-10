-- Govern exact binary workspace artifacts (notably OOXML .docx) without
-- coercing their bytes through UTF-8 text columns.

ALTER TABLE artifact_revision
  ADD COLUMN IF NOT EXISTS content_encoding text NOT NULL DEFAULT 'utf8';

ALTER TABLE artifact_revision
  DROP CONSTRAINT IF EXISTS artifact_revision_content_encoding_check;

ALTER TABLE artifact_revision
  ADD CONSTRAINT artifact_revision_content_encoding_check
  CHECK (content_encoding IN ('utf8','base64'));

ALTER TABLE task_workspace_file
  DROP CONSTRAINT IF EXISTS task_workspace_file_content_size;

ALTER TABLE task_workspace_file
  DROP CONSTRAINT IF EXISTS task_workspace_file_content_digest;

ALTER TABLE task_workspace_file
  DROP CONSTRAINT IF EXISTS task_workspace_file_content_shape;

ALTER TABLE task_workspace_file
  ALTER COLUMN content_text DROP NOT NULL;

ALTER TABLE task_workspace_file
  ADD COLUMN IF NOT EXISTS content_encoding text NOT NULL DEFAULT 'utf8',
  ADD COLUMN IF NOT EXISTS content_base64 text,
  ADD COLUMN IF NOT EXISTS media_type text NOT NULL DEFAULT 'text/plain';

ALTER TABLE task_workspace_file
  ADD CONSTRAINT task_workspace_file_content_shape CHECK (
    (content_encoding='utf8' AND content_text IS NOT NULL AND content_base64 IS NULL)
    OR (content_encoding='base64' AND content_text IS NULL AND content_base64 IS NOT NULL)
  ),
  ADD CONSTRAINT task_workspace_file_content_size CHECK (
    size_bytes = CASE WHEN content_encoding='utf8'
      THEN octet_length(content_text)
      ELSE octet_length(decode(content_base64,'base64')) END
  ),
  ADD CONSTRAINT task_workspace_file_content_digest CHECK (
    content_hash = CASE WHEN content_encoding='utf8'
      THEN encode(digest(convert_to(content_text,'UTF8'),'sha256'),'hex')
      ELSE encode(digest(decode(content_base64,'base64'),'sha256'),'hex') END
  );

INSERT INTO schema_migrations(version)
VALUES ('0013_binary_workspace_documents')
ON CONFLICT (version) DO NOTHING;
