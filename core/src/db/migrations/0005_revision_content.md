# Migration 0005 — ArtifactRevision inline content column (Web UI-1 slice)

Numbered migration `0005_revision_content.sql` adds a single nullable column to
the existing `artifact_revision` table so an ArtifactRevision may carry its full
content inline, enabling the read-only Web UI-1 product library and the approval
center to fetch revision content from Core without an external content store:

| column    | type | nullable | written by                                                |
|-----------|------|----------|-----------------------------------------------------------|
| `content` | text | yes      | `POST .../artifacts/:artifactId/revisions` (when supplied) |

## Version

- **File:** `0005_revision_content.sql`
- **Version string:** `0005_revision_content`
- **Applies after:** `0004_tool_run_evidence`
- **Properties:** transactional (`BEGIN`/`COMMIT`), idempotent
  (`ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO NOTHING`), non-destructive — the
  column is nullable and defaults to NULL, so existing rows and every existing
  write path (`createRevision` in `repository.ts`, which now passes `content`)
  are unaffected.

## Rationale

`artifact_revision` (migration 0000) recorded only a content-addressed proof of
the revision (`content_hash`) and its out-of-band location (`content_location`,
e.g. a git ref or object-storage URI). The runtime historically registered
candidate revisions by supplying both; Core never held the bytes themselves.

Web UI-1 needs the UI to display the actual revision content (the approval
center renders every revision inside a gate snapshot, and the product library
lets a reviewer browse versions). Routing those reads through an external
content store is unnecessary for document-sized artifacts. This migration lets a
revision carry its content inline:

1. When the client supplies `content`, the handler stores it in `content`,
   computes `content_hash = sha256(content)` (rejecting a mismatched client
   hash with 400), and defaults `content_location` to
   `db://artifact_revision/<id>`.
2. When `content` is omitted, behavior is unchanged: the client supplies
   `content_hash` + `content_location` and `content` stays NULL.

`GET .../revisions/:revId/content` returns `{content, content_hash}`; a revision
with NULL content yields 404 (content lives out-of-band, addressed by
`content_location`).

`content` is the only writer-touched column here; it is read by the new content
endpoint and never participates in the manifest hash (that still uses the
stable `content_hash`, preserving snapshot determinism).

## Schema mirror

`schema.sql` is mirrored: the `content text` column appears in the
`CREATE TABLE artifact_revision` definition right after `content_location`, so a
fresh `schema.sql` apply and a migrated 0000→0005 database have identical
`artifact_revision` shapes.
