# Minimal Patch Policy

## Patch Order

1. Syntax and parse blockers
2. Missing declarations, package imports, include paths
3. Port width/direction mismatches
4. Signedness and width warnings with behavioral impact
5. Latch or incomplete assignment issues
6. Style warnings only after functional blockers are gone

## Do Not

- Rename public ports to satisfy a local typo without checking call sites.
- Change reset polarity because a tool warning is confusing.
- Remove logic just to silence unused warnings when the signal is part of a planned contract.
- Collapse a module boundary unless the architecture contract allows it.

## Convergence

- Keep each repair batch small and rerunnable.
- If the same diagnostic class reappears after two attempts, summarize the likely root cause.
- If logs show missing vendor primitives or encrypted IP, stop and request the tool/library path.
