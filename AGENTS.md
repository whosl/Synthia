# Repository Guidelines

## Project Structure & Module Organization

This repository contains a Python backend for the EdAgent Vivado RTL debugging agent plus a Vite/React frontend. Core Python code lives in `src/edagent_vivado/`, organized by domain: `agent/`, `harness/`, `parsers/`, `tools/`, `memory/`, `evolution/`, `connectors/`, and `web/`. Tests live in `tests/`, with connector tests in `tests/connectors/` and evaluation fixtures in `tests/eval_set/`. Frontend code is under `frontend/src/`; static assets are in `frontend/public/`. Example projects are in `examples/`, and config templates are in `configs/`.

## Build, Test, and Development Commands

- `python -m venv .venv && source .venv/bin/activate`: create and enter a local Python environment.
- `pip install -e ".[dev,all]"`: install the backend, CLI, test tools, web extras, and optional SSH support.
- `./scripts/dev.sh web`: start the backend web service, defaulting to port `8484`.
- `./scripts/dev.sh frontend`: start the Vite frontend on `127.0.0.1:5173`.
- `python -m pytest tests/ -v -k "not agent_smoke"`: run the standard test suite without LLM-backed smoke tests.
- `python -m edagent_vivado.cli diagnose-log examples/uart_demo/logs/sample_vivado_error.log`: run a CLI smoke command.
- `cd frontend && npm install && npm run build`: install and build the frontend.

## Coding Style & Naming Conventions

Use Python 3.11+ and the existing `src/` package layout. Keep modules focused by subsystem and prefer typed interfaces for public helpers. Python files and functions use `snake_case`; classes use `PascalCase`; tests follow `test_*.py` and `test_*` names. Frontend code uses TypeScript and React components in `PascalCase`. CI runs `ruff check src/ tests/` and `mypy src/edagent_vivado --ignore-missing-imports`; address reported issues even though these lint steps are currently non-blocking.

## Testing Guidelines

Add focused pytest coverage next to related behavior in `tests/`. Use fixtures or sample projects from `examples/` for Vivado flows. Avoid requiring a real Vivado installation unless the test is explicitly integration-oriented; mock Vivado paths support offline development. LLM-dependent tests belong in `tests/test_agent_smoke.py` or must be gated by variables such as `ANTHROPIC_API_KEY`.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style messages such as `feat(phase-6): ...`, `fix(chat): ...`, and `build(frontend): ...`. Follow that pattern with a concise scope. Pull requests should describe the user-visible change, list validation commands, link issues or spec sections, and include screenshots for UI changes. Note skipped tests or required external services.

## Security & Configuration Tips

Copy `.env.example` to `.env` for local secrets; never commit `.env`, API keys, LangSmith tokens, or machine-specific Vivado paths. Use `VIVADO_PATH` only when automatic discovery is insufficient.
