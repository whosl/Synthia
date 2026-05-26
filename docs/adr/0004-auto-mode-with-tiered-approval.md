# ADR-0004: Auto Mode with tiered risk and approval

- **Status:** Accepted
- **Date:** 2026-05-26

## Context

Pure manual approval blocks useful automation; pure auto mode is unsafe for RTL/XDC and hardware actions.

## Decision

Default **Auto Mode** with capability risk tiers:

| Risk | Behavior |
|------|----------|
| low | auto execute |
| medium | auto execute + audit log |
| high | human approval (patch, XDC, RTL, overwrite xpr) |
| critical | deny by default (`rm -rf`, destructive env) |

Concrete v1.0 rules: Tcl/manifest generation auto; **XDC/RTL patches require approval**; device program deferred to v1.1 with strong approval.

## Consequences

### Positive

- Matches spec demo flows (synth/impl/bitstream auto, patches gated).
- Aligns with existing `requires_approval` on capabilities and HITL hooks.

### Negative

- UX must surface pending approvals outside chat-only UI (already started in `/approvals`).

### Follow-ups

- Wire risk policy to connector capabilities and RBAC (Phase 9).

## References

- `SynthiaUpdate/spec.md` §3.4, §13.2
- `harness/vivado_hitl.py`
