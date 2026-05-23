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

4. **Agent features require LLM API key:** The `edagent ask` and `edagent ask-multi` commands require `ANTHROPIC_API_KEY` to be set. The `.env` ships with a Zhipu GLM-5-turbo key that may or may not be valid.

5. **Pre-existing test failures (3):** `test_e2e_cases.py::test_case6_remote_runner_check` (missing class export), `test_integration.py::test_vivado_runner_mock_synth_with_parse` and `test_vivado_runner_mock_synth_failure_parse` (tests expect keys not present in runner return dict). These are code issues, not env issues.

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
