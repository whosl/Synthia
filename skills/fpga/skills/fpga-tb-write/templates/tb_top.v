`timescale 1ns/1ps

// Template: tb_top.v
// ─────────────────────────────────────────────────────────────────────────────
// This is a reference implementation. Copy it to tb/tb_top.v, then adapt
// signal names, port widths, parameter values, and stimulus logic to match
// the actual RTL module under test.
// ─────────────────────────────────────────────────────────────────────────────
//
// CLOCK FORMULA (copy exactly — do not change):
//   parameter CLK_FREQ   = 50_000_000;                    // Hz
//   parameter CLK_PERIOD = 1_000_000_000 / CLK_FREQ;    // ns → 20
//   initial clk = 1'b0;
//   always #(CLK_PERIOD / 2) clk = ~clk;
//
// WAIT STYLE:
//   repeat (N) @(posedge clk);       // preferred: N clock cycles
//   #(N * CLK_PERIOD);               // explicit: N * clock_period ns
//
// PORT DIRECTION IN TB:
//   RTL input  → TB reg   (TB drives)
//   RTL output → TB wire  (TB observes)
// ─────────────────────────────────────────────────────────────────────────────

module tb_top;
    // ── Clock / Reset parameters ────────────────────────────────────────────
    parameter CLK_FREQ   = 50_000_000;                 // Hz — adapt to DUT
    parameter CLK_PERIOD = 1_000_000_000 / CLK_FREQ;  // ns — auto-calculated
    parameter TIMEOUT_CYCLES = 10000;                  // watch-dog limit

    // ── DUT parameter (from RTL source) ────────────────────────────────────
    // Extract from the RTL module declaration. If the DUT has no parameters,
    // remove this localparam and the corresponding .PARAM_NAME() at instantiation.
    localparam MAX_COUNT = 10;                         // from RTL: localparam MAX_COUNT = 10

    // ── DUT port signals ─────────────────────────────────────────────────────
    // Match the RTL module declaration EXACTLY — copy port names and widths verbatim.
    reg  clk;
    reg  rst_n;
    wire [7:0] led;   // replace with actual RTL output port name and width

    // ── Internal TB state ─────────────────────────────────────────────────────
    integer cycle_count;
    integer error_count;

    // ── Clock generation ─────────────────────────────────────────────────────
    initial clk = 1'b0;
    always #(CLK_PERIOD / 2) clk = ~clk;              // correct: no forever, no always begin...end

    // ── Waveform export ─────────────────────────────────────────────────────
    // Waveform export (VCD/FST) is post-MVP and currently NOT enabled.
    // Do NOT add $dumpfile/$dumpvars, dump macros, plusargs, or any waveform
    // switches here, and do not promise waveform output. If external waveform
    // material already exists, it is input evidence only and must be
    // registered via Core before use.

    // ── Reset sequence ───────────────────────────────────────────────────────
    initial begin
        rst_n = 1'b0;
        repeat (5) @(posedge clk);                    // hold reset for 5 cycles
        rst_n = 1'b1;
    end

    // ── Cycle counter ────────────────────────────────────────────────────────
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            cycle_count <= 0;
        else
            cycle_count <= cycle_count + 1;
    end

    // ── DUT instantiation ───────────────────────────────────────────────────
    // Copy port names EXACTLY from the RTL module declaration.
    // Use .PARAM_NAME(value) to pass parameters — NOT defparam before instantiation.
    led_chaser #(
        .MAX_COUNT(MAX_COUNT)                         // pass parameter at instantiation
    ) dut (
        .clk  (clk),
        .rst_n(rst_n),
        .led  (led)                                    // must match RTL port name EXACTLY
    );

    // ── Self-checking stimulus ───────────────────────────────────────────────
    initial begin
        wait (rst_n);                                  // wait for reset release
        repeat (2) @(posedge clk);

        // ── Scenario: reset smoke ────────────────────────────────────────────
        // After reset release the outputs must be at known idle state.
        // Adapt the expected value and port name to match the RTL.
        if (led !== 8'b0000_0001) begin
            $display("ERROR [reset_smoke] at t=%0t: expected 8'b0000_0001, got %b", $time, led);
            error_count = error_count + 1;
        end

        // ── Scenario: first shift ────────────────────────────────────────────
        // Wait MAX_COUNT clock cycles (the time for one LED shift).
        repeat (MAX_COUNT) @(posedge clk);
        if (led !== 8'b0000_0010) begin
            $display("ERROR [first_shift] at t=%0t: expected 8'b0000_0010, got %b", $time, led);
            error_count = error_count + 1;
        end

        // ── Scenario: second shift ──────────────────────────────────────────
        repeat (MAX_COUNT) @(posedge clk);
        if (led !== 8'b0000_0100) begin
            $display("ERROR [second_shift] at t=%0t: expected 8'b0000_0100, got %b", $time, led);
            error_count = error_count + 1;
        end

        // ── Report ───────────────────────────────────────────────────────────
        if (error_count == 0) begin
            $display("PASS");
        end else begin
            $display("FAIL errors=%0d", error_count);
        end
        $finish;
    end

    // ── Timeout watchdog ─────────────────────────────────────────────────────
    always @(posedge clk) begin
        if (rst_n && cycle_count > TIMEOUT_CYCLES) begin
            $display("TIMEOUT at cycle %0d", cycle_count);
            $finish;
        end
    end

endmodule
