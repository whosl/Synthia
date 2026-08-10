# Register Semantics

## Access Types

| Type | Meaning | RTL/TB implication |
| --- | --- | --- |
| RW | Software read/write | Reset, write strobe, readback. |
| RO | Hardware-owned read-only | Software writes ignored or error per bus policy. |
| WO | Write-only command/data | Reads return 0, last value, or error; document choice. |
| RC | Read-clear | Clear timing and priority against new hardware set must be explicit. |
| W1C | Write 1 to clear | Hardware set usually wins over software clear unless specified. |
| W0C | Write 0 to clear | Use rarely; document mask semantics. |
| RS/WSC | Write side-effect command | Doorbell, kick, start, restart; command may auto-clear. |
| SHADOW | Software writes staging value | Apply at frame/packet/idle boundary or explicit commit. |

## Priority Rules

Always state priority when events collide:

- hardware set vs software clear
- new error latch vs clear
- snapshot/freeze vs live counter update
- soft reset vs in-flight transaction
- shadow commit vs software write
- read-clear vs simultaneous new event

## Counter and Snapshot Rules

- Use snapshot/freeze for multiword counters or cross-domain counters.
- Define whether counters saturate or wrap.
- Define clear timing and whether clear is per-counter or global.
- For performance windows, define measurement period and rollover.

## Doorbell and Command Rules

A doorbell field must define:

- what software writes
- whether write value is data, index, pulse, or bit mask
- whether repeated writes are allowed while busy
- which status bit acknowledges acceptance
- timeout or error behavior if the target cannot accept
