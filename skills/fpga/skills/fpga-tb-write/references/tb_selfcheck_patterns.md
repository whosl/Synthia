# TB Self-Check Patterns

## Required Building Blocks

- clock/reset generation
- timeout watchdog
- driver that respects ready/valid or protocol timing
- monitor that samples on the correct edge
- checker or scoreboard with expected values
- final PASS/FAIL summary

## Scenario Types

| Type | Examples |
| --- | --- |
| Reset | reset values, reset during transaction, reset recovery |
| Nominal | one command, one packet, one frame, one sample block |
| Backpressure | stalled input, stalled output, long pause |
| Boundary | min/max length, first/last pixel, 0/100% duty, saturation |
| Dynamic config | threshold update, coefficient switch, shadow commit |
| Error | malformed packet, overflow, timeout, illegal register access |
| Recovery | soft reset, clear error, link restart, safe pattern |

## Scoreboard Rules

- Compare only after fixed latency or when expected valid is asserted.
- Track metadata (`last`, frame ID, channel ID, timestamp) with data.
- Include tolerance for fixed-point/DSP comparisons.
- Classify failure as stimulus violation, DUT mismatch, or checker limitation.

## Clock Period Reference Table

| Frequency | CLK_PERIOD (ns) | Half-period | `always #` |
| --- | --- | --- | --- |
| 1 MHz | 1000 | 500ns | `#500` |
| 10 MHz | 100 | 50ns | `#50` |
| 25 MHz | 40 | 20ns | `#20` |
| 50 MHz | 20 | 10ns | `#10` |
| 100 MHz | 10 | 5ns | `#5` |
| 200 MHz | 5 | 2.5ns | `#2.5` |

**Formula:** `parameter CLK_PERIOD = 1_000_000_000 / CLK_FREQ;`

## Timing Calculation Examples

### Example 1: LED Chaser with MAX_COUNT=10 at 50MHz

The LED shifts one position every `MAX_COUNT` clock cycles.

```
CLK_PERIOD = 20ns (50MHz)
MAX_COUNT  = 10
Time per LED shift = 10 × 20ns = 200ns
```

Wait for 3 shifts:
```verilog
repeat (3) begin
    repeat (MAX_COUNT) @(posedge clk);  // wait MAX_COUNT cycles
end
// OR, time-based:
#(3 * MAX_COUNT * CLK_PERIOD);
```

### Example 2: UART Baud Rate Generator at 9600 baud

```
BAUD_RATE  = 9600
bit_period  = 1_000_000_000 / 9600 ≈ 104_167ns ≈ 104µs
```

Wait for 10 bits (one UART frame):
```verilog
repeat (10) begin
    #(BIT_PERIOD);
    // sample here
end
```

### Example 3: Counter with Terminal Count

For a counter that counts from 0 to `MAX_COUNT-1`:
```
After reset:  counter = 0
After 1 cycle: counter = 1
...
After MAX_COUNT cycles: counter wraps to 0
```

```verilog
// Wait for wrap-around
repeat (MAX_COUNT) @(posedge clk);
if (counter !== 0) begin
    $display("ERROR: counter did not wrap");
    error_count++;
end
```

### Example 4: Ready/Valid Handshake

```verilog
// Drive transaction
@(posedge clk);
s_valid = 1'b1;
s_data  = 32'hDEADBEEF;

// Wait for handshake (backpressure-safe)
while (!s_ready) @(posedge clk);
s_valid = 1'b0;

// Check response after fixed latency of 2 cycles
repeat (2) @(posedge clk);
if (m_data !== 32'hDEADBEEF) begin
    $display("ERROR: data mismatch");
    error_count++;
end
```

## Common Wait Patterns

| Pattern | Use Case | Example |
| --- | --- | --- |
| `repeat (N) @(posedge clk)` | Wait N clock cycles | `repeat (10) @(posedge clk);` |
| `#(N * CLK_PERIOD)` | Explicit time-based wait | `#(5 * 20); // wait 100ns` |
| `wait (condition)` | Event-driven | `wait (done_flag);` |
| `@(posedge clk)` | Single cycle step | `@(posedge clk);` |
| `while (!cond) @(posedge clk)` | Backpressure-safe wait | `while (!s_ready) @(posedge clk);` |

## PASS/FAIL Pattern

Always end the TB with a clear verdict:

```verilog
if (error_count == 0) begin
    $display("PASS");
end else begin
    $display("FAIL errors=%0d", error_count);
end
$finish;
```

Never just `$display("Test done")` without a PASS/FAIL decision.
