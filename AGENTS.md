# Repository Guidelines

## Project Structure & Module Organization

Synthia is a Bun/TypeScript system split by responsibility. `core/src/` owns domain rules, persistence, and the HTTP API; tests live in `core/tests/`. `runtime/` contains the agent loop and governance adapters. `connector/` implements the remote Vivado worker. The Vue 3/Vite client is under `web/src/`, with tests in `web/tests/`. FPGA workflows and templates are in `skills/fpga/`; reference HDL projects are in `golden/`. Plans belong in `specs/`, and deployment assets in `deploy/`.

## Build, Test, and Development Commands

- `bun test`: run Core, Runtime, and Connector tests from the repository root.
- `(cd web && bun test)`: run the browser/UI unit tests.
- `bun run check`: check undefined names and type-check Core.
- `bunx tsc --noEmit -p runtime/tsconfig.json`: type-check Runtime separately.
- `(cd web && bun run check && bun run build)`: validate and build the UI.
- `(cd web && bun run dev:mock)`: start the UI with mock data on port 5180 (or the next free port).
- `bun run runtime/cli.ts "<task>" --offline --no-governance`: run a local Runtime smoke test.

## Coding Style & Naming Conventions

Use strict TypeScript and ES modules: two-space indentation, double quotes, semicolons, and trailing commas in multiline constructs. Use `camelCase` for variables/functions, `PascalCase` for types, classes, and Vue components, and kebab-case for most modules (for example, `model-client.ts`). Keep domain policy in Core; do not bypass governance through Runtime or Connector. No repository-wide formatter is configured, so preserve nearby formatting.

## Testing Guidelines

Tests use Bun's `bun:test`. Name files `*.test.ts`; place Core and Web tests in their `tests/` directories and colocate Runtime/Connector tests with source. Cover behavioral changes, including authorization and failure paths. No coverage threshold is declared, but all affected tests must pass.

## Commit & Pull Request Guidelines

History uses Conventional Commit-style subjects such as `feat(web): ...`, `fix: ...`, and `docs(spec): ...`. Keep commits focused and imperative. Pull requests should explain behavior and architectural impact, reference the issue or spec, list verification commands, and include screenshots for UI changes. Call out schema, environment, or protocol changes.

## Security & Configuration

Never commit `.env` files, service tokens, certificates, model credentials, or generated Runtime state. Use documented environment variables and keep connector secrets in managed secret storage. Treat formal FPGA runs as governed operations; local bypass flags are for development only.
