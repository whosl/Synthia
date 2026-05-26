# ADR-0006: RTL in prompts allowed for v1.0 (Policy A)

- **Status:** Accepted
- **Date:** 2026-05-26

## Context

Agents read RTL via `read_file_tool`, semantic KB indexing, and log excerpts. External LLMs (Claude, GLM, etc.) may receive proprietary RTL unless restricted. Lab use wants maximum debugging quality; enterprise deploy needs opt-out.

## Decision

**v1.0 Policy A — permissive:** RTL may enter prompts and retrieval chunks. Document risks in `futureWork.md` with a planned v1.1 `project.rtl_visibility` switch (`local_only` / `outbound_ok` / `never`) and prompt audit.

## Consequences

### Positive

- Best diagnosis quality for open/lab environments.
- No blocking work on redaction pipelines in Phase 0.

### Negative

- Compliance risk for customer IP on external APIs.
- No fine-grained audit of which lines left the boundary yet.

### Follow-ups

- Implement `rtl_visibility` before non-lab enterprise rollout.
- `knowledge.index_rtl` default review for production configs.

## References

- `futureWork.md` §1
- `agent/context.py`, `knowledge/semantic_kb.py`
