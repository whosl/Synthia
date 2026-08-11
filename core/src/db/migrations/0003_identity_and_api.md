# Migration 0003 — Identity & API Auth (IF-001 first slice)

Numbered migration `0003_identity_and_api.sql` introduces the platform-internal
identity layer required to expose the Core API (SYNTHIA-IF-001): a `user_account`
table with LDAP-forward field names and an `auth_token` table that stores only
SHA-256 hashes of bearer tokens. It also widens the `actor_type` vocabulary with
`service` so non-human platform identities can hold scoped role assignments and
idempotency slots.

The decision follows **Q-011**: platform-internal identity is the first slice;
an LDAP bind backend can be layered on later because the column names already
follow LDAP attribute conventions (`uid` / `cn` / `displayName` / `memberOf` /
`mail`).

## Version

- **File:** `0003_identity_and_api.sql`
- **Version string:** `0003_identity_and_api`
- **Applies after:** `0002_approval_slice_hardening`
- **Properties:** transactional (`BEGIN`/`COMMIT`), idempotent (re-runnable),
  non-destructive to existing data.

## Changes

### 1. `actor_type` enum widened with `service`

```sql
ALTER TYPE actor_type ADD VALUE IF NOT EXISTS 'service';
```

A platform **service** account is a first-class identity (a long-lived machine
principal that calls the Core API with its own token), distinct from the
`agent` / `connector` / `system` runtime actor types. PostgreSQL 12+ permits
`ALTER TYPE ... ADD VALUE` inside a transaction block; the new value is merely
unusable until commit, which this migration never requires. `IF NOT EXISTS`
guards partial or re-applied state.

This is additive only — existing enum values and every column typed `actor_type`
(`role_assignment.actor_type`, `artifact_revision.created_by_type`) keep their
existing semantics.

### 2. `idempotency_records.actor_type` CHECK widened

`idempotency_records.actor_type` is a plain `text` column with an inline
`CHECK` (introduced in 0001), **not** the enum type, so the enum widening above
does not reach it. The migration drops whatever `actor_type` CHECK currently
exists on the table and re-adds an inclusive one:

```sql
CHECK (actor_type IN ('human','agent','connector','system','service'))
```

This is required because every Core API write operation is idempotency-scoped on
`(actor_type, actor_id, project_id, operation, key)`, and service identities
must be able to claim their own slots. The drop/re-add is idempotent
(guarded by `pg_constraint` lookup).

### 3. `user_account` — platform identity (LDAP-forward)

| Column | Type | Notes |
|--------|------|-------|
| `id` | `text PK` | internal stable id |
| `uid` | `text NOT NULL UNIQUE` | LDAP `uid` — the login identity returned as `actorId` |
| `cn` | `text` | LDAP `cn` (common name) |
| `display_name` | `text` | LDAP `displayName` |
| `member_of` | `text[]` | LDAP `memberOf` group DNs (group RBAC, future) |
| `mail` | `text` | LDAP `mail` |
| `actor_type` | `actor_type` | `human` \| `service` |
| `status` | `text CHECK` | `active` \| `disabled` \| `locked` |
| `created_at` / `updated_at` | `timestamptz` | |

Field names follow LDAP attribute conventions so a future LDAP bind maps 1:1
without a rename migration. `uid` is the single login identity; human vs service
is distinguished by `actor_type`.

### 4. `auth_token` — bearer tokens, hash only

| Column | Type | Notes |
|--------|------|-------|
| `token_hash` | `text PK CHECK ^[0-9a-f]{64}$` | `sha256(plaintext bearer)` |
| `user_id` | `text FK→user_account(id)` | owning identity |
| `scope` | `text[]` | permission scopes (e.g. `core:write`, `core:read`) |
| `issued_at` / `created_at` | `timestamptz` | |
| `expires_at` | `timestamptz NULL` | NULL = no expiry |
| `revoked_at` | `timestamptz NULL` | NULL = not revoked |
| `last_used_at` | `timestamptz NULL` | |

The plaintext bearer token is presented in `Authorization: Bearer <token>`,
SHA-256 hashed on arrival, and matched against `token_hash` (the PK). The
plaintext is shown **exactly once** at provisioning time
(`core/scripts/bootstrap-admin.ts`) and is never stored or logged. A token is
invalid when `revoked_at IS NOT NULL` or when `expires_at < now()`; both surface
as a single `401` so the API never leaks token lifecycle state.

## Boundaries the API/service layer enforces

The DB guarantees structural integrity; the API layer
(`core/src/api/auth.ts`, handlers) remains the authority for identity resolution
and human-exclusive operations:

1. **Actor identity is resolved from the token only.** Handlers MUST NOT accept
   `actor_id` / `actor_type` in a request body as the *requester* identity. The
   `Authorization` header → `sha256` → `auth_token` lookup → `user_account` is
   the sole source of the requester's `actorType` and `actorId` (= `uid`).
   (A role *assignment* body legitimately names a *different* actor — the
   assignee — which is domain data, not the requester.)

2. **Service identities cannot approve.** Approval, revocation and waiver
   (SYNTHIA-IF-001 §3, P4 human-exclusive) are rejected with `403
   authorization` when the resolved `actor_type !== 'human'`, before the
   approval service is reached. The approval service additionally hard-denes
   any `approver.actorType !== 'human'` (defence in depth, ARC-002 §6).

3. **Token secrecy.** `auth_token` stores only `sha256(plaintext)`; no column,
   log line, idempotency record or outbox payload ever carries the plaintext.
   `bootstrap-admin.ts` prints it once to stdout and exits.

4. **Idempotency scope for API writes.** Every write handler claims an
   `idempotency_records` slot scoped on `(actorType, actorId=uid, projectId,
   operation, key=<Idempotency-Key header>)`. Same key + same canonical
   request hash replays the stored response; same key + different hash is a
   stable `409 conflict`.

5. **Scope execution (coarse three-tier).** The router enforces a minimal
   API-level scope guard: `GET` requires `core:read`, non-approval `POST`
   requires `core:write`, and approve requires `core:approve`. A token lacking
   the required scope is rejected with `403 authorization` before the handler
   runs. `bootstrap-admin.ts` provisions these scopes. **Project-level ACL**
   (per-project authorization — whether this identity may touch *this* project)
   is explicitly deferred to a dedicated RBAC slice; the first slice runs
   inside the trusted intranet domain where coarse identity + operation tier
   is sufficient.

6. **Enum pre-validation at the API boundary.** Classification (`D1`–`D4` /
   `UNCLASSIFIED`), `gate`, trace `state`, and `data_classification` are
   validated before any DB write so an illegal value surfaces as a stable
   `400 validation` — never as a raw PG constraint violation (23514) leaking
   as a `500`.

7. **Internal-error hardening.** Any unexpected error returns a fixed
   `"internal error"` message with the `correlation_id`; the real
   `err.message` goes only to the server log. PostgreSQL unique-violation
   (SQLSTATE `23505`) is mapped to a stable `409 conflict`.

## Known boundaries (explicitly deferred, by design)

- **`auth_token.last_used_at` is not updated** on use. The first slice does
  not record token usage telemetry; rotating this column on the read path is a
  later concern. The column exists for future use.
- **Request body has no size limit.** No `Content-Length` cap is enforced at
  the API layer in this slice; a reverse proxy / gateway is expected to bound
  payload size in deployment.
- **`expectedVersion` optimistic concurrency is implemented only for
  artifact revisions.** Other write endpoints do not yet expose an
  `expected_version` field; project-level optimistic concurrency is a later
  slice.
- **Gate review workflow.** `gate_submission` state progression
  (`preparing → submitted → checking → in_review`) is not exposed as endpoints
  in this slice; the approval handler consumes a submission already in a
  reviewable state.

## Authoritative schema view

`schema.sql` has been updated to mirror 0003: the `actor_type` enum `CREATE
TYPE` now lists `service`, the `idempotency_records` inline CHECK is widened,
and `user_account` / `auth_token` (+ indexes) are present. `schema.sql` is the
fresh-install authoritative view; numbered migrations remain the migration
runner path.
