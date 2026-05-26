# ADR-0001: xpr-first UX, internal manifest for execution

- **Status:** Accepted
- **Date:** 2026-05-26

## Context

FPGA engineers work in Vivado with `.xpr` projects. EdAgent historically used an explicit `eda.yaml` manifest. Synthia must feel native to Vivado users while keeping a normalized model for agents, connectors, and batch flows.

## Decision

- **User-facing source of truth:** Vivado `.xpr` (and project directory).
- **System execution source of truth:** internal manifest under `.synthia/eda.yaml` (or equivalent), generated from `.xpr` or wizard/scan.
- **Sync policy (v1.0):** one-way import from `.xpr` → manifest before runs; fingerprint check on open/run; conflicts prompt the user (sync from xpr / keep manifest / review). **No automatic reverse write** into `.xpr` in v1.0.

## Consequences

### Positive

- Matches engineer mental model; lowers onboarding friction.
- Keeps agent/connector code on a stable Pydantic manifest.
- Avoids a full bidirectional sync engine in v1.0.

### Negative

- Changes made only in Vivado GUI may be stale until the user runs sync.
- Path mapping (local vs remote) must be explicit in project metadata.

### Follow-ups

- Phase 3 handbook: `xpr_importer`, scanner, wizard, `sync-xpr` API.
- ADR update if we add controlled manifest → xpr export later.

## References

- `SynthiaUpdate/spec.md` §3.2, §15.1
- `SynthiaUpdate/PHASE3_HANDBOOK.md`
