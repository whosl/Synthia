-- Synthia Core — platform-internal identity & API auth (IF-001 first slice)
-- Adds the user_account / auth_token identity layer (Q-011 decision) and widens
-- the actor_type vocabulary so platform *service* identities can hold scoped
-- role assignments and idempotency slots alongside humans.
-- Safe to re-run; fully transactional. Depends on 0000 (core tables + actor_type
-- enum), 0001 (idempotency_records), 0002 (approval slice hardening).
BEGIN;

-- ── widen actor_type: add 'service' for non-human platform identities ─────────
-- LDAP-forward: a service account is a first-class platform identity (not an
-- agent/connector runtime). PG 12+ permits ALTER TYPE ... ADD VALUE inside a
-- transaction block; the new value is simply unusable until commit, which this
-- migration never requires. IF NOT EXISTS guards partial / re-applied state.
ALTER TYPE actor_type ADD VALUE IF NOT EXISTS 'service';

-- idempotency_records.actor_type is a text column with an inline CHECK (not the
-- enum), so the CHECK must be widened explicitly to accept 'service' identities.
-- Drop whatever actor_type CHECK exists, then re-add the inclusive one idempotently.
DO $$
DECLARE
  c text;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'public.idempotency_records'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%actor_type%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.idempotency_records DROP CONSTRAINT %I', c);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'idempotency_records_actor_type_check'
       AND conrelid = 'public.idempotency_records'::regclass
  ) THEN
    ALTER TABLE public.idempotency_records
      ADD CONSTRAINT idempotency_records_actor_type_check
      CHECK (actor_type IN ('human','agent','connector','system','service'));
  END IF;
END;
$$;

-- ── user_account: platform-internal identity (LDAP-forward field names) ───────
-- Fields are named per LDAP attribute conventions so a future LDAP bind can map
-- 1:1 without a rename migration. The login identity is `uid` (unique); human vs
-- service is distinguished by `actor_type`. memberOf is carried as a text[] of
-- group DNs for group-based RBAC resolution later.
CREATE TABLE IF NOT EXISTS user_account (
    id              text PRIMARY KEY,                 -- internal stable id
    uid             text NOT NULL UNIQUE,             -- LDAP uid (login identity)
    cn              text NOT NULL DEFAULT '',         -- LDAP common name
    display_name    text NOT NULL DEFAULT '',         -- LDAP displayName
    member_of       text[] NOT NULL DEFAULT '{}',     -- LDAP memberOf groups
    mail            text NOT NULL DEFAULT '',
    actor_type      actor_type NOT NULL,              -- 'human' | 'service'
    status          text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','disabled','locked')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_account_uid ON user_account (uid);
CREATE INDEX IF NOT EXISTS idx_user_account_actor_type ON user_account (actor_type);

-- ── auth_token: bearer tokens, SHA-256 hash only (never plaintext) ───────────
-- The bearer token presented in `Authorization: Bearer <token>` is SHA-256
-- hashed on arrival and matched against token_hash (the PK). The plaintext is
-- shown exactly once at provisioning time (bootstrap-admin) and never stored or
-- logged. A token is invalid when revoked_at IS NOT NULL or when expires_at has
-- passed; both surface as a single 401 to avoid leaking token state.
CREATE TABLE IF NOT EXISTS auth_token (
    token_hash      text PRIMARY KEY,                 -- sha256(plaintext bearer)
    user_id         text NOT NULL REFERENCES user_account(id),
    scope           text[] NOT NULL DEFAULT '{}',     -- permission scopes
    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz,                      -- NULL = no expiry
    revoked_at      timestamptz,                      -- NULL = not revoked
    last_used_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_auth_token_user ON auth_token (user_id);

INSERT INTO schema_migrations(version) VALUES ('0003_identity_and_api') ON CONFLICT (version) DO NOTHING;
COMMIT;
