# RTL Integration Policy

## Preserve Contracts

Confirmed contracts include:

- module name, ports, parameter names, widths, and polarity
- register offsets, fields, reset values, side effects
- clock/reset domains and CDC choices
- packet/transaction ordering and latency guarantees
- TB-visible signals and wave plan aliases

## Edit Scope

- Modify the smallest ownership area needed.
- Avoid formatting-only churn in unrelated modules.
- If existing user changes are present, work with them and do not revert.
- Create leaf modules when they reduce complexity or match architecture; do not add abstraction for its own sake.

## Behavior Spec Notes To Leave

Record in `doc/spec/behavior_spec.md`:

- fixed latency
- assumptions not encoded in RTL
- synthesis-sensitive choices
- CDC strategy implemented
- unimplemented optional features
- recommended tests
