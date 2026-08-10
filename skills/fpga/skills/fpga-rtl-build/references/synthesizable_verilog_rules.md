# Synthesizable Verilog Rules

## General

- Provide reset behavior for all state, valid, counters, and control flops unless intentionally left unreset and documented.
- Use `parameter` for constants that should not be user parameters.
- Avoid implicit nets. Include `` `default_nettype none`` only if the local codebase already uses it or the build supports it consistently.

## Combinational Logic

- Assign defaults at the top of `always @(*)`.
- Cover all `case` branches or include `default`.
- Avoid incomplete assignment that infers latches.
- Avoid combinational loops through ready/valid unless the protocol contract explicitly allows the path and timing is reviewed.

## Sequential Logic

- Keep one clock per `always @(posedge clk)`.
- Do not mix blocking and nonblocking assignments in sequential logic.
- For pulse outputs, define pulse width and reset value.
- For counters, define wrap, saturate, clear, and enable behavior.
