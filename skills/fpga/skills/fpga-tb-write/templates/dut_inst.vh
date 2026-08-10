`ifndef DUT_MODULE
`define DUT_MODULE led_chaser   // replace with actual RTL module name
`endif

// ─────────────────────────────────────────────────────────────────────────────
// dut_inst.vh — DUT instantiation include
// ─────────────────────────────────────────────────────────────────────────────
// Copy this file to tb/dut_inst.vh in the workspace, then adapt:
//   1. Change ` DUT_MODULE to the actual RTL module name
//   2. Fill in the parameter block if the RTL has parameters
//   3. Map every port from the RTL module declaration EXACTLY
// ─────────────────────────────────────────────────────────────────────────────
//
// PORT DIRECTION IN TB:
//   RTL input  → TB reg   (TB drives)
//   RTL output → TB wire  (TB observes)
//
// PARAMETER PASSING (use ONLY one of these two forms):
//   Preferred — pass at instantiation:
//     MODULE_NAME #(
//         .PARAM_NAME(param_value)
//     ) dut (.port(signal), ...);
//
//   Safe alternative — defparam AFTER instantiation:
//     MODULE_NAME dut (.port(signal), ...);
//     defparam dut.PARAM_NAME = param_value;
//
//   AVOID: defparam BEFORE instantiation — simulator-dependent
// ─────────────────────────────────────────────────────────────────────────────

`DUT_MODULE #(
    // ── Parameter block ────────────────────────────────────────────────────
    // Only include parameters that exist in the RTL module declaration.
    // If the RTL uses localparam (not parameter), do NOT try to override it —
    // accept the fixed value from the RTL source.
    .MAX_COUNT(MAX_COUNT)        // example: localparam MAX_COUNT = 10
) dut (
    // ── Port mapping ───────────────────────────────────────────────────────
    // Copy port names EXACTLY as they appear in the RTL module declaration.
    // Do NOT invent or rename ports. If a port name seems wrong, re-read the RTL.
    .clk  (clk),
    .rst_n(rst_n),
    .led  (led)                   // wire [7:0] led — replace with actual RTL port name
);
