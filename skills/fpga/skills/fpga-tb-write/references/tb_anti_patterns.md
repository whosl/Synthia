# TB Anti-Patterns

Common mistakes that always result in `status: "partial"` or rejection. Read this before generating any TB code.

## Port Direction Errors (Fatal)

`in`/`out`/`inout` are NOT Verilog-2001 keywords for module port declarations.

```verilog
// WRONG
module tb_top;
    in clk;
    out led;
    inout data;
endmodule

// CORRECT: TB uses reg (drives RTL input) and wire (observes RTL output)
module tb_top;
    reg  clk;
    reg  rst_n;
    wire [7:0] led;
endmodule
```

## Clock Generation Errors

```verilog
// WRONG: forever inside always block — clk set to 0 once, then delays, never toggles
always begin
    clk = 0;
    forever #(1000000000 / CLK_FREQ) clk = ~clk;
end

// WRONG: half-period inverted (always #2 = 250MHz, not 2MHz)
always #2 clk = ~clk;

// CORRECT
parameter CLK_FREQ = 50_000_000;          // Hz
parameter CLK_PERIOD = 1_000_000_000 / CLK_FREQ;  // ns
initial clk = 1'b0;
always #(CLK_PERIOD / 2) clk = ~clk;     // 50MHz = 20ns period
```

## Defparam Placement

```verilog
// WRONG: defparam before instantiation (simulator-dependent)
defparam dut.MAX_COUNT = 10;
example_module dut (...);

// CORRECT: preferred — pass at instantiation
example_module #(.MAX_COUNT(10)) dut (...);

// OR: defparam AFTER instantiation
example_module dut (...);
defparam dut.MAX_COUNT = 10;
```

## Stub / Placeholder Patterns

These always cause `status: "partial"`:
```verilog
    // Steps 4-8 omitted
    // ...
    // TODO: implement remaining steps
    // Stub — implement checker logic
    repeat (1000);  // wait without observing any signal change
```

## Wait Style

```verilog
// WRONG: raw time units
#1000;

// CORRECT: clock cycles
repeat (N) @(posedge clk);

// CORRECT: explicit time with calculation
parameter CLK_PERIOD = 20;  // ns for 50MHz
#(MAX_COUNT * CLK_PERIOD);
```

## Large localparam Values

`localparam MAX_COUNT = 25_000_000` cannot be overridden. Do NOT write `repeat(25_000_000) @(posedge clk)`.

**Correct approach**: verify behavioral correctness (reset state, shift direction, wrap-around) with 2-3 observations, not exhaustive cycle counting. Set `TIMEOUT_CYCLES` to allow a few iterations. The TB should PASS when behavioral logic is correct.
