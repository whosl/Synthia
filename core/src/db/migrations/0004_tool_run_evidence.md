# Migration 0004 — ToolRun execution-result columns (IF-002 run/connector slice)

Numbered migration `0004_tool_run_evidence.sql` adds three nullable columns to the
existing `tool_run` table so the Core↔Connector run/Job API (SYNTHIA-IF-002) can
persist the execution outcome Core observes when it proxies the Connector:

| column          | type  | nullable | written by                                  |
|-----------------|-------|----------|---------------------------------------------|
| `error_code`    | text  | yes      | `GET /jobs/:jobId` (status refresh, terminal failure) |
| `output_sha256` | text  | yes      | `GET /jobs/:jobId` (status refresh, terminal success) |
| `evidence`      | jsonb | yes      | `GET /jobs/:jobId/evidence` (frozen terminal manifest) |

## Version

- **File:** `0004_tool_run_evidence.sql`
- **Version string:** `0004_tool_run_evidence`
- **Applies after:** `0003_identity_and_api`
- **Properties:** transactional (`BEGIN`/`COMMIT`), idempotent (`ADD COLUMN IF NOT
  EXISTS`, `ON CONFLICT DO NOTHING`), non-destructive — all three columns are
  nullable and default to NULL, so existing rows and every existing write path
  (`createToolRun` in `repository.ts`) are unaffected.

## Rationale

`tool_run` (migration 0000) captures the lifecycle of a Connector-driven tool
execution. The original schema persisted the *request* (operation, run_class,
input manifest hash, authorization context, parameters) and the Core-internal
state machine, but not the *result* the Connector reports back. The run/connector
slice (IF-002) makes Core the single authority callers talk to: Core submits the
Job to the Connector, polls its status, and fetches its evidence manifest. The
observed outcome must be durably persisted so that:

1. A terminal `state` is accompanied by its `error_code` (why it failed) and
   `output_sha256` (content-addressed proof of what it produced).
2. The evidence manifest returned once by the Connector is frozen on the row
   (`evidence` jsonb), giving Core a stable, auditable record without re-querying
   the Connector for every read.

All three columns are written exclusively by the run/Job handlers
(`getJobStatusHandler`, `getJobEvidenceHandler`). `POST /jobs` creates the row in
state `submitted` and leaves them NULL, matching the API contract that the
submission response carries only `{ jobId, runClass, state: "submitted" }`.

## Schema mirror

`schema.sql` is mirrored: the three columns appear in the `CREATE TABLE tool_run`
definition between `end_time` and `correlation_id`, so a fresh `schema.sql` apply
and a migrated 0000→0004 database have identical `tool_run` shapes.
