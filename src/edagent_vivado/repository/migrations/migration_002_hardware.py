"""Phase 12 — hardware_targets / hardware_sessions / program_jobs."""

from __future__ import annotations


def apply(conn) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS hardware_targets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            serial TEXT NOT NULL,
            part TEXT NOT NULL,
            description TEXT DEFAULT '',
            host TEXT DEFAULT '',
            xvc_url TEXT DEFAULT '',
            capabilities_json TEXT DEFAULT '{}',
            state TEXT DEFAULT 'available',
            last_seen_at BIGINT,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_hw_targets_state ON hardware_targets(state);
        CREATE INDEX IF NOT EXISTS idx_hw_targets_host ON hardware_targets(host);

        CREATE TABLE IF NOT EXISTS hardware_sessions (
            id TEXT PRIMARY KEY,
            target_id TEXT NOT NULL,
            project_id TEXT DEFAULT '',
            opened_by TEXT NOT NULL,
            state TEXT DEFAULT 'open',
            metadata_json TEXT DEFAULT '{}',
            opened_at BIGINT NOT NULL,
            closed_at BIGINT
        );
        CREATE INDEX IF NOT EXISTS idx_hw_sess_target ON hardware_sessions(target_id);

        CREATE TABLE IF NOT EXISTS program_jobs (
            id TEXT PRIMARY KEY,
            hardware_session_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            bitstream_artifact_id TEXT NOT NULL,
            bitstream_sha256 TEXT NOT NULL,
            bitstream_path TEXT DEFAULT '',
            approval_id TEXT NOT NULL,
            requested_by TEXT NOT NULL,
            approved_by TEXT DEFAULT '',
            state TEXT DEFAULT 'pending_approval',
            error_message TEXT DEFAULT '',
            log_artifact_id TEXT DEFAULT '',
            started_at BIGINT,
            completed_at BIGINT,
            created_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pjobs_target ON program_jobs(target_id);
        CREATE INDEX IF NOT EXISTS idx_pjobs_state ON program_jobs(state);
        """
    )
    conn.commit()
