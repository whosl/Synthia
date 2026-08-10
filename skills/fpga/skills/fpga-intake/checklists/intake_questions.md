# Intake Questions

Use only the questions that are blocking. Keep the user interview short.

## Scope

- Is this new RTL, modification, TB, simulation debug, compile repair, waveform diagnosis, documentation, or compliance work?
- What is explicitly out of scope?
- Which files or directories are authoritative?

## Interfaces

- What are the top module name, ports, directions, widths, parameters, and reset values?
- Which bus or stream protocol is used: AXI-Lite, APB, AXI4, AXI-Stream-like, custom valid/ready, video sync, or pin-level protocol?
- For valid/ready streams, what defines a transaction and packet boundary? Is `tlast` or an equivalent signal required?
- For registers, which access types exist: RW, RO, RC, W1C, WO, shadow, doorbell, snapshot, counter, or clear-on-read?

## Clock, Reset, CDC

- What are all clock domains, nominal frequencies, and reset polarities?
- Are resets async assert / sync deassert, fully synchronous, or board-dependent?
- Which signals cross clock domains? Which need synchronizers, async FIFO, toggle/handshake, or Gray pointer logic?

## Behavior

- What are the key states, events, invariants, and illegal states?
- What must happen on error, timeout, overflow, underflow, malformed packet, or soft reset?
- Which configuration changes must take effect immediately, at frame boundary, at packet boundary, or after idle?

## Verification

- What is the PASS/FAIL rule for each required scenario?
- Is a golden model needed? If yes, what language or source is authoritative?
- Which signals must be observable for first-mismatch analysis? Note: waveform export (VCD/FST) is post-MVP and currently unavailable — do not offer to generate or promise waveforms; if the user already has external waveform material, it may only be used as input evidence registered via Core.
- Which compile/sim tool is available in the environment?

## Delivery

- What final artifacts are expected: RTL, TB, scripts, register map, report, wiki, validation evidence, board procedure, or compliance audit?
- Is this a draft, review-ready delivery, or strict customer handoff?
