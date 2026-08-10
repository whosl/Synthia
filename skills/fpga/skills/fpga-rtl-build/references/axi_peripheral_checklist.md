# AXI-Lite / Standard Bus Peripheral Checklist

For any module that implements AXI-Lite, APB, or similar standard bus interfaces, ALL of the following must be fully implemented.

## Write Transaction (AW → W → B)

- **Write address state machine:** `IDLE → ADDR_WAIT → DATA_WAIT → RESP` (or equivalent) with correct transition conditions (`awvalid/awready`, `wvalid/wready`, `bvalid/bready`)
- **AW ready path:** assert `awready` in correct state, clear on `awvalid & awready`
- **W strobe handling:** `wstrb` decoded per byte lane — each byte in `wdata` is written only if the corresponding `wstrb` bit is 1
- **Write data register:** capture `wdata` into internal register on `wvalid & wready`
- **B response:** assert `bvalid` with `bresp=0` (OKAY), wait for `bready`

## Read Transaction (AR → R)

- **Read address state machine:** `IDLE → ADDR_WAIT → DATA` with correct transition conditions
- **AR ready path:** assert `arready` in correct state, clear on `arvalid & arready`
- **Read data drive:** drive `rdata` and `rresp=0` (OKAY) on same cycle as `rvalid`
- **R valid must stay stable until `rready` is asserted**

## Register File

- Each address offset decoded with `case` or `if-else` chain — no partially-decoded registers
- Write-enable pulse for each register
- Read data mux selects correct source per address

## Anti-Patterns

- Do NOT abbreviate any of the above with `// ...` or omit the state transition logic.
- Do NOT implement only a subset of the transaction phases (e.g., skipping B response or AR path).
- Do NOT hard-code addresses — decode offsets from base address.
- Do NOT drive `rdata` before `rvalid` is asserted.
