# AGENTS.md

## Cursor Cloud specific instructions

### Project Overview

EdAgent-Vivado is a Python + React application for AI-powered Xilinx Vivado RTL debugging. It has:
- **Python backend** (FastAPI + LangChain/LangGraph) at `src/edagent_vivado/`
- **React frontend** (Vite + TypeScript) at `frontend/`
- Pre-built frontend assets committed in `src/edagent_vivado/web/static/`

### Running Services

- **Backend:** `edagent web --port 8484` (serves both API and pre-built SPA)
- **Frontend dev server:** `cd frontend && npm run dev` (Vite on port 5173, proxies API to 8484)

### Key Caveats

1. **`.env` loads automatically with `override=True`** via `python-dotenv` in `src/edagent_vivado/__init__.py`. The committed `.env` sets `VIVADO_REMOTE_HOST` which causes SSH connection attempts to an unreachable host. When testing locally, either unset `VIVADO_REMOTE_HOST` or use `force_mock=True` in VivadoRunner.

2. **Mock mode:** Vivado is not installed in this environment. The system auto-detects this and falls back to mock mode when `VIVADO_REMOTE_HOST` is empty and no local `vivado` binary exists. Use `force_mock=True` or clear `VIVADO_REMOTE_HOST` env var to ensure mock mode.

3. **`edagent` CLI:** Installed to `~/.local/bin/edagent`. Ensure `$HOME/.local/bin` is on PATH.

4. **Agent features require LLM API key:** The `edagent ask` and `edagent ask-multi` commands require `ANTHROPIC_API_KEY` to be set (copy `.env.example` to `.env` and fill in your key).

5. **Phase 0 (done):** Backend T1–T8 + frontend D1–D7. `pytest -k "not agent_smoke"` → 426+ passed. API auth uses `~/.synthia/token`. Frontend: warm/claude-dark themes, topbar, StatusPill, ToolCallBlock, Composer, ⌘K palette.

6. **API auth in tests (Phase 5.5):** The legacy "`PYTEST_CURRENT_TEST` disables auth" heuristic is gone. `tests/conftest.py` now sets `SYNTHIA_AUTH_TEST_MODE=1` autouse; opt in to the real middleware via the `enable_auth` fixture.

### Active development branch

- **`product/synthia-workbench`** — Synthia workbench: Phase 0–8 on this branch.
  `pytest -k "not agent_smoke"` → 540+ passed after Phase 8.

#### Phase 8 notes (RBAC + audit)

- **Users / roles:** `users`, `roles`, `project_members` tables; bootstrap admin on first
  `init_db()` (token in `~/.synthia/token`, legacy file reused when present).
- **Auth:** `IdentityMiddleware` resolves Bearer token → `request.state.identity`.
  `SYNTHIA_AUTH_TEST_MODE=1` injects anonymous-admin (pytest autouse).
- **Permissions:** `auth/permissions.py` + `require_perm()` / `require_role()` in
  `web/dependencies.py`. Project-level role overrides global role.
- **Audit:** `audit_logs` table + `auth/audit.log_audit`; mutate routes on
  projects / runs / patches / artifact download log actions.
- **API:** `GET /api/v1/me`, `/api/v1/admin/users`, `/api/v1/audit/logs`.
- **CLI:** `edagent admin create-user|list-users|rotate-token|add-member`.
- **Frontend:** `/login` page, `ProtectedRoute`, `usePermissions` / `canUserDo`.

#### Phase 7 notes (PatchProposal + approval)

- **Patch pipeline:** `patches/proposal.py` (state machine), `risk_classifier.py`,
  `diff_engine.py`, `applier.py`, `service.py`. Full proposal in `metadata_json.v7`;
  legacy `patch_proposals` columns kept for compat.
- **API:** `POST /api/v1/patches/propose`, `…/approve`, `…/reject`, `…/revert`,
  `GET /api/v1/patches/{id}`. Legacy `POST /api/v1/patches/{id}/apply` delegates to
  v7 when `metadata_json.v7` is present.
- **Risk matrix:** Tcl/manifest may auto-apply; XDC needs approval; RTL needs strong
  approval (reason required); delete (non-tcl) denied.
- **Audit:** `patch_audits` table + `patch_audit_log` / `patch_audits_for`.
- **Auto-rerun:** After RTL/XDC apply, `maybe_spawn_rerun` starts a background orchestrator run.
- **Frontend:** `DiffViewer`, `PatchApprovalCard`, timeline handler for `patch.proposed`.

#### Phase 6 notes (chat-first UI)

- **Intent dispatch:** `agent/intent.py` + `agent/task_planner.py` + `agent/intent_dispatch.py`.
  Vivado run keywords in chat short-circuit the LLM agent: create an orchestrator Run in the
  background and stream progress via SSE. Set `SYNTHIA_INTENT_DISPATCH=0` to disable.
- **Missing-info cards:** `missing_info_required` events render an inline form in the
  terminal timeline (`MissingInfoCard`); submit re-posts to `POST /sessions/{id}/tasks`.
- **Run / artifact cards:** `RunCard` polls `/runs/{id}/steps`; `ArtifactCard` links to
  artifact download. Wired through `timeline/handlers/chatOrchestration.ts` + `CustomEntryBlock`.
- **Events:** `intent.classified`, `missing_info_required`, orchestrator `run.*`, and
  `artifact.created` (with `ui_kind`) added to both backend and frontend event catalogs.

#### Phase 5.5 hotfix notes

- **Per-session run lock:** `edagent_vivado.runs.scheduler.run_in_session` /
  `start_run_serial` serialise runs that share a `session_id`. The routes
  `POST /api/v1/runs/{id}/rerun` and `POST /api/v1/vivado/commands/flow` now
  return HTTP **409** when the session is already executing a run. v1 is
  in-process; Phase 11 will swap to a Redis-backed lock + worker pool.
- **`$PSRCDIR` / `$PRUNDIR`:** Vivado GUI project-mode `.xpr` files use these
  placeholders. `_expand_path` now resolves them via `*.srcs` / `*.runs`
  glob lookup, with a project-dir fallback when no match exists.
- **Strict state machine:** `started` and `done` were removed from the
  `RunState` set; `assert_transition` now ALWAYS raises `InvalidTransition`
  unless `SYNTHIA_STATE_MACHINE_STRICT=0`. Callers needing a recovery
  path must use `safe_transition_or_log`. `runs/trend.py` still accepts
  legacy `'done'` rows from pre-P5.5 databases.

### Standard Commands

| Task | Command |
|------|---------|
| Install deps | `pip install -e ".[dev]"` |
| Run tests | `python3 -m pytest -k "not agent_smoke"` |
| Type check (Python) | `python3 -m mypy src/edagent_vivado --ignore-missing-imports` |
| Type check (TS) | `cd frontend && npx tsc -b --noEmit` |
| Build frontend | `cd frontend && npm run build` |
| Start backend | `edagent web --port 8484` |
| Start frontend dev | `cd frontend && npm run dev` |
| Run diagnosis | `edagent diagnose-log examples/uart_demo/logs/sample_vivado_error.log` |
| Run mock synth | Use Python API with `force_mock=True` or clear `VIVADO_REMOTE_HOST` |
