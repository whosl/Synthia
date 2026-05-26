# ADR-0002: Stay on Vite + React for v1.0 (no Next.js rewrite)

- **Status:** Accepted
- **Date:** 2026-05-26

## Context

`SynthiaUpdate/update.md` originally proposed `apps/web` with Next.js, Vercel AI SDK, and shadcn. The repo already ships a substantial Vite + React 19 + TypeScript frontend with timeline/SSE, monitor, approvals, and i18n. A framework migration would delay security and execution-path work by weeks.

## Decision

**Do not migrate to Next.js for Synthia v1.0.** Continue evolving `frontend/` (Vite) toward a Cursor-like workbench: design tokens, three-column shell, tool/approval cards, command palette. Revisit Next.js only if we need SSR, built-in auth routes, or a separate marketing site.

## Consequences

### Positive

- Saves an estimated 4–8 weeks of rewrite risk.
- Keeps one SPA served from FastAPI static + dev proxy.
- AI SDK patterns can be adapted without changing bundler.

### Negative

- No SSR/SEO for marketing (acceptable for an engineering workbench).
- Auth/route guards are shared with FastAPI (token middleware in Phase 0).

### Follow-ups

- Phase 0 frontend tasks D1–D7 in `PHASE0_HANDBOOK.md`.
- Document in `frontend/README.md`.

## References

- `SynthiaUpdate/PHASE0_HANDBOOK.md` T7
- `frontend/README.md`
