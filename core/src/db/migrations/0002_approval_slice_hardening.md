# Migration 0002 — Approval Slice Hardening

Numbered migration `0002_approval_slice_hardening.sql` adds database-level
constraints for the ApprovalRecord → ApprovedGateResult → Baseline vertical
slice, plus the monotonic Outbox and scoped Idempotency that the service layer
relies on (the latter two tables were introduced by 0001; 0002 does not alter
them).

## Version

- **File:** `0002_approval_slice_hardening.sql`
- **Version string:** `0002_approval_slice_hardening`
- **Applies after:** `0001_d1_hardening`
- **Properties:** transactional (`BEGIN`/`COMMIT`), idempotent (re-runnable),
  non-destructive to existing data.

## Constraints added

### Consistency CHECK

| Table | Constraint | Rule | Purpose |
|-------|-----------|------|---------|
| `baseline` | `baseline_no_candidate` (`CHECK`) | `state::text <> 'candidate'` | Baselines are created exclusively by approval events and always start `active`; a candidate baseline is a domain impossibility (ARC-002 §5.3). The cast to `text` is required because the `baseline_state` enum does not include `'candidate'`, so the literal would otherwise be coerced to the enum and raise `22P02`. Added idempotently (guarded by `pg_constraint` lookup). |

### Append-only triggers (`BEFORE UPDATE OR DELETE`)

All use the shared `synthia_reject_append_only_mutation()` function from 0001
(re-declared `CREATE OR REPLACE` so 0002 is self-contained). Rejection raises
SQLSTATE `55000` (object_not_in_prerequisite_state).

| Table | Trigger name |
|-------|--------------|
| `approval_record` | `approval_record_append_only` |
| `approved_gate_result` | `approved_gate_result_append_only` |
| `baseline` | `baseline_append_only` |

### Deterministic uniqueness (unique indexes)

| Index name | Table | Columns / predicate | Prevents |
|-----------|-------|---------------------|----------|
| `approved_gate_result_unique_submission` | `approved_gate_result` | `(gate_submission_id)` | A second approved result for the same submission. |
| `baseline_unique_active_project_kind` | `baseline` | `(project_id, kind) WHERE state = 'active'` | Concurrent duplicate active baseline of the same kind per project (milestone gates G1/G3/G4/G7/G9 → B0/B1/B2/B3/B4). Exactly one concurrent transaction commits; the other receives a unique violation. |
| `baseline_unique_approved_gate_result` | `baseline` | `(approved_gate_result_id)` | A single approval event producing more than one baseline row, in any state. |

### Pre-existing constraints relied upon (from 0000 / 0001)

These are **not** re-created by 0002 but are load-bearing for the slice:

- `outbox_events UNIQUE (aggregate_type, aggregate_id, sequence)` + `CHECK (sequence > 0)` — per-aggregate monotonic ordering, enforced atomically via `pg_advisory_xact_lock` in `repository.appendOutboxEvent`.
- `idempotency_records` PK `(actor_type, actor_id, project_id, operation, idempotency_key)` + `request_hash CHECK '^[0-9a-f]{64}$'` — same scope key with a different canonical request hash is a stable conflict; same key + same hash replays the stored `response` jsonb.

## Boundaries the business/service layer must handle

The DB enforces the structural invariants below; the service layer
(`repository.ts` / approval use-case) remains the authority for cross-row
semantic consistency that cannot be expressed as a static constraint:

1. **Cross-table project/gate/snapshot consistency.** `approved_gate_result` and
   `baseline` rows carry their own `project_id`, but the DB does not verify that
   `approval_record.project_id = gate_submission.project_id =
   configuration_snapshot.project_id` or that `result.gate = submission.gate`.
   `repository.createBaseline` performs this cross-row check with `FOR UPDATE`
   inside the approval transaction. The unique indexes above assume the service
   has already validated the chain.

2. **Human-only approval.** `approver_id` is a plain `text`; there is no
   `actor_type` column on `approval_record`. The "only humans approve" invariant
   (ARC-002 §6) is enforced by the service layer against `role_assignment`
   (`actor_type = 'human'` AND `actor_id = approver_id` AND
   `role = approver_role`). Agent/connector/system approvers are rejected before
   INSERT. This is an intentional soft constraint — adding `approver_actor_type`
   would not strengthen it because the value would come from the same caller.

3. **Milestone-gate → baseline-kind mapping.** G1→B0, G3→B1, G4→B2, G7→B3,
   G9→B4 (see `GATE_TO_BASELINE` in `domain/enums.ts`). G2/G5/G6/G8 produce no
   baseline. The DB cannot express "kind B0 requires gate G1" without a join to
   the approved result's gate; `repository.createBaseline` enforces this. The
   `baseline_unique_active_project_kind` index only guarantees at most one active
   baseline per kind, not that the kind is correct for the gate.

4. **Snapshot member/trace membership equality.** `baseline.manifest_hash` /
   `member_revision_ids` / `trace_relation_ids` must match the originating
   `configuration_snapshot`. Array-equality is not a static constraint;
   `repository.createBaseline` compares sorted sets. The service layer must pass
   the snapshot's exact values.

5. **Idempotency replay vs. conflict.** The DB PK provides deterministic
   "same key" deduplication. The service layer must (a) compute the canonical
   request hash (`hashing.canonicalRequestHash`), (b) INSERT with
   `status = 'in_progress'`, (c) on completion UPDATE the same row to
   `completed` with `response` **before** the transaction commits — and (d) on a
   PK conflict, compare `request_hash`: equal hash returns the stored response,
   differing hash is surfaced as `ConflictError`. Note: `idempotency_records` is
   not append-only (it needs a single `in_progress → completed` transition), so
   it is intentionally **not** covered by an append-only trigger.

6. **Revocation / supersession are new events.** Because the three governed
   tables are append-only, revoking an approval or superseding a baseline must
   insert a **new** `approval_record` (`decision = 'revoke'`) or a **new**
   `baseline` (linked via `superseded_by_baseline_id`). The old row is never
   mutated. The service layer must not attempt `UPDATE`/`DELETE`.

## Authoritative schema view

`schema.sql` has been updated to mirror 0001 + 0002 (outbox_events,
idempotency_records, append-only function/triggers, and the three unique
indexes), and the `baseline_no_candidate` CHECK is now guarded for
idempotent re-application. `schema.sql` is the fresh-install authoritative view;
numbered migrations remain the migration runner path.
