# Verilog Anti-Patterns

Common semantic substitution mistakes that produce syntactically valid but functionally wrong RTL. Each one looks plausible but fails under specific data patterns, widths, or timing conditions.

## Semantic Substitution Errors

These patterns look like shortcuts but encode the wrong mathematical or logical relationship. Always use the construct that directly expresses the intended semantics.

### Comparisons

**Bad:** Using `+` or `-` to fake a comparison.

```verilog
// WRONG — only works by accident when sum cannot overflow
assign ge = (a - b) <= 0;  // undefined when a<b, overflow wraps

// CORRECT — explicit comparison
assign ge = a >= b;
```

**Bad:** Using `!=` when the protocol requires `<=` (e.g., credit counters that must not go negative).

```verilog
// WRONG — protocol may require credit to stop at 0 and not wrap
assign dec_enable = (cnt != 0);

// CORRECT — explicit non-zero check or compare against 1
assign dec_enable = (cnt > 0);
```

**Bad:** Signed vs. unsigned comparison without explicit casting.

```verilog
// WRONG — when a or b is treated as unsigned but intended as signed
logic [7:0] a, b;
// ...
assign a_lt_b = a < b;  // unsigned comparison

// CORRECT — cast to signed when signed semantics are needed
assign a_lt_b = ($signed(a) < $signed(b));
```

### Bit Manipulation

**Bad:** Using `&` reduction to fake a one-hot check.

```verilog
// WRONG — true one-hot requires exactly one bit set
// &a is 1 when 1+0+...=odd (not what "one-hot" means)
// &a == 1'b1 is also wrong — it is "odd number of 1s"
assign is_one_hot = &a;

// CORRECT — exactly one bit is set
assign is_one_hot = (a != 0) && (&a == 0);
```

**Bad:** Using `|` reduction to fake a packed-OR or flag combination.

```verilog
// WRONG — |masked compresses the OR result to 1 bit, losing per-lane info
// Protocol may require each lane's valid flag, not just "any lane valid"
assign any_valid = |valid_lanes;

// CORRECT — use when "any" is the actual intent
// If the protocol needs per-lane processing, keep the vector, don't reduce it
```

**Bad:** Using `^` for parity when the width is not fixed or the parity convention is defined.

```verilog
// WRONG — ^data gives odd parity; if the protocol expects even parity, this is wrong
assign parity_bit = ^data;

// CORRECT — match the protocol's parity convention
assign parity_bit = ~^data;  // even parity
```

### Width and Extension

**Bad:** Omitting sign extension in operations that mix signed and unsigned operands.

```verilog
// WRONG — when s_data is signed and u_data is unsigned,
// (s_data + u_data) widens to the larger operand's width but does not sign-extend u_data
logic signed [15:0] s_data;
logic        [7:0]  u_data;
// ...
assign result = s_data + {{8{u_data[7]}}, u_data};  // manual sign extension

// CORRECT — use $signed() on the unsigned operand, or ensure both are same signedness
assign result = s_data + $signed({{8{1'b0}}, u_data});  // zero-extend, result stays signed
```

**Bad:** Relying on implicit extension in arithmetic that may overflow.

```verilog
// WRONG — adding two W-bit numbers produces a W-bit result in Verilog (bits lost)
logic [7:0] a, b;
assign sum = a + b;  // overflow silently discarded

// CORRECT — when overflow must be detected, widen the result
logic [8:0] sum;
assign sum = $signed({{1{a[7]}}, a}) + $signed({{1{b[7]}}, b});
```

**Bad:** Using concatenation to fake a barrel shifter.

```verilog
// WRONG — concatenation by a dynamic amount does not barrel-shift
// {data, data} >> shift is not a barrel shifter; it shifts by at most 1 bit per stage
assign shifted = data >> shift;  // only works for shift=0,1; wrong for larger shift

// CORRECT — implement a proper barrel shifter when shift amount is dynamic and variable
```

### Conditional and Mux Logic

**Bad:** Using `?:` for priority mux when all branches must be evaluated independently.

```verilog
// WRONG — ternary is a 2-to-1 mux, not a priority encoder
assign out = sel1 ? a : (sel2 ? b : c);

// CORRECT — if the intent is independent flag combination (e.g., error OR in both cases),
// write explicit AND/OR without the mux semantics
assign out = (sel1 && a) | (sel2 && b);
```

### State Machines

**Bad:** Encoding state transitions that are correct in simulation but may not be reached in synthesis due to combinational loops.

```verilog
// WRONG — a self-clearing transition that depends on the same-cycle deassertion of a signal
// that itself depends on this cycle's output
always_comb begin
    state_d = state_q;
    if (state_q == ST_RUN && done) begin
        state_d = ST_IDLE;    // clears in same cycle
        rdy_pulse = 1'b1;     // rdy_pulse feeds back into upstream logic
    end
end
// RISK — if rdy_pulse is used combinatorially to advance upstream FSM,
// this cycle of latency is consumed before upstream sees it
```

**Rule:** When a completion signal is consumed by an upstream handshaking peer, model the cycle delay explicitly in the protocol spec. Do not assume zero-latency propagation through `?:` or combinational outputs.

### Default Assignment Traps

**Bad:** Incomplete defaults in `always @(*)` causing unintentional latch inference for signals not assigned in all branches.

```verilog
// WRONG — out_data is not assigned in every branch, inferred latch
always_comb begin
    out_valid = 1'b0;
    if (in_ready) begin
        out_valid = in_valid;
        out_data  = in_data;  // out_data assigned here
    end
    // out_data not assigned in else — latch inferred
end

// CORRECT — assign defaults for every signal at the top
always_comb begin
    out_data  = '0;
    out_valid = 1'b0;
    if (in_ready) begin
        out_valid = in_valid;
        out_data  = in_data;
    end
end
```

## Rule Summary

| Anti-pattern | Symptom | Fix |
|---|---|---|
| `a - b <= 0` for comparison | Overflow, wrong result | Use `$signed(a) >= $signed(b)` or `a >= b` |
| `&vec` for one-hot | False positives (odd count) | `(vec != 0) && (&vec == 0)` |
| Implicit width extension | Silent overflow | Widen operands explicitly or check bounds |
| `?:` for multi-condition OR | Wrong mux semantics | Use explicit AND/OR |
| Incomplete always @(*) defaults | Latch inference | Assign all signals at top of block |
