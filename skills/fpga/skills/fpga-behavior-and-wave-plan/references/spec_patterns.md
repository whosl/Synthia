# Behavior Specification Patterns

## FSM Rule

Use when states and transitions are explicit.

| Current state | Event/condition | Next state | Outputs | Illegal transitions |
| --- | --- | --- | --- | --- |

Include reset state, timeout behavior, retry count, and error-state recovery.

## Transaction Rule

Use for bus, packet, descriptor, or command flows.

- Trigger: command accepted, descriptor valid, SOP, frame start, register write.
- Obligations: output sequence, completion, counter update, interrupt, error code.
- Ordering: same ID order, packet order, frame order, or relaxed order.
- Backpressure: what must hold stable and when progress may pause.

## Invariant

Use for safety conditions that must always hold.

- `valid && !ready` holds payload stable.
- FIFO count never exceeds depth.
- One-hot state encoding has exactly one active bit after reset.
- Complementary PWM outputs are never high at the same time.
- Frame switch takes effect only at frame boundary.

## Timing Window Rule

Use for latency, synchronization, and waveform comparisons.

- Define start event and end event.
- Define min/max cycles or fixed pipeline latency.
- Define clock domain and sampling edge.
- Define allowed don't-care or warm-up cycles.

## Configuration Update Rule

Use for shadow registers and dynamic configuration.

- Immediate update: takes effect on next clock.
- Idle update: takes effect after no transaction is active.
- Packet update: takes effect at next packet boundary.
- Frame update: takes effect at next frame start/end.
- Explicit commit: staged values apply only after commit/doorbell.
