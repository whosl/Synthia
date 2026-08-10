# Hardware Fact Extraction Notes

This skill exists to separate two different stages that were previously mixed together:

- locating and extracting constraint-relevant board-level hardware facts from manuals and reference documents
- generating the final project constraint file from RTL plus those facts

## Why This Separation Matters

A finished XDC often contains information that cannot be extracted from the hardware manual alone, including:

- RTL top-level port names
- generated clocks
- false-path or multicycle exceptions
- interface-specific input/output delays
- project-specific implementation properties

Those items belong to downstream constraint generation, not to manual extraction.

## Scope Discipline

This skill should reason from the user's current FPGA task and infer the minimum hardware facts needed to support that task.

Typical inferred targets include:

- interface pin mapping for board-facing IO
- electrical facts needed for later IO standard selection
- board clock facts needed for later clock constraint generation
- target device/package facts needed before constraint work can proceed

If the task scope is ambiguous between multiple unrelated hardware targets, the skill should stop with `needs_input` instead of silently switching to full-board extraction.

## Source Priority

When multiple hardware references disagree, prefer this order unless the user says otherwise:

1. Official vendor or board reference XDC / official pin table
2. Official board schematic
3. Official board datasheet or user manual
4. User-curated extracted tables or notes

If two sources conflict at the same confidence level, record the conflict in `doc/hw/extracted_facts.missing.md` and do not silently choose one.

## Document Navigation

When the source document is long, actively locate the relevant evidence using cues such as:

- table of contents
- section titles
- interface names
- pin assignment tables
- clock sections
- reset sections
- connector definitions

The skill may inspect more of the source internally, but the final extraction result should remain limited to the minimum facts needed for the user's current task.

## Practical Field Guidance

### `device_facts`

Use normalized vendor IDs such as:

- `xilinx`
- `intel`
- `gowin`
- `anlogic`

Capture the exact visible part number whenever possible. Keep package and speed grade separate if the document distinguishes them.

### `pin_map`

Use board-level signal names from the source material. Avoid speculative renaming to guessed RTL names. If a bus is shown as individual bits, preserve them as individual `signal` entries.

### `electrical_facts`

Prefer explicit `io_standard`. If unavailable, preserve the strongest evidence available, such as:

- `bank`
- `bank_voltage`
- `interface_voltage`
- `differential`
- `interface_type`

### `clock_facts`

Prefer storing both period and frequency when one can be derived exactly from the other. If only one is stated in the source, derive the other carefully and keep the source reference.

## Downstream Consumers

The expected downstream consumer is still `fpga-xdc-gen`, which should:

- consume extracted board-level facts as hardware evidence
- stop when the extraction result is incomplete for the requested task scope
- combine board-level facts with RTL top-level ports to generate final constraints

If the wider workspace still keeps `doc/hw/config.json` for broader board context, treat it as separate from this skill's task-scoped extraction result rather than the required output target of this skill.
