-- 0036: relax task_conversation_event.event_kind CHECK (harness ledger H24).
--
-- The DB enumerated every legal event_kind, which couples schema to code:
-- adding a conversation event type in Runtime (e.g. permission_request,
-- which arrived with the in-stream permission cards) requires a matching
-- migration, and a code-first deploy window writes fail on the constraint
-- (observed 2026-09-11 00:32:57, 11-minute job-flow interruption).
--
-- Ownership moves to code: keep NOT NULL, drop the enum CHECK. New kinds
-- become readable without schema changes; kind validation stays in the
-- writers where it belongs.

ALTER TABLE task_conversation_event
  DROP CONSTRAINT IF EXISTS task_conversation_event_event_kind_check;
