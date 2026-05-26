# ADR-0003: Internal Python Connector, external MCP

- **Status:** Accepted
- **Date:** 2026-05-26

## Context

Industrial EDA tools need transactions, run steps, artifacts, approvals, and audit trails. MCP is ideal for Cursor/Claude Code/WorkBuddy but is a poor fit as the only internal abstraction.

## Decision

- **Internal execution:** Python `ToolConnector` protocol (`connectors/base/`), capabilities, `RunOrchestrator` (planned), SQLite/Postgres state.
- **External integration:** MCP server (Phase 10+) calls Synthia HTTP API / orchestrator — never shells directly into Vivado.
- **Do not** MCP-wrap every internal code path.

## Consequences

### Positive

- Strong typing, testability, and policy hooks on the hot path.
- MCP clients get a stable, audited surface.

### Negative

- Two surfaces to maintain (HTTP + MCP) until codegen or shared OpenAPI client exists.

### Follow-ups

- Phase 2 handbook: single entry through VivadoConnector.
- Phase 10: `apps/mcp/`.

## References

- `SynthiaUpdate/spec.md` §10
- `src/edagent_vivado/connectors/base/connector.py`
