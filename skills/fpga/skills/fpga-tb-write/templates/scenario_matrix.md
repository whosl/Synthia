# 仿真场景矩阵

<!--
HOW TO FILL THIS TABLE:
- Copy this template to tb/scenario_matrix.md in the workspace
- Add one row per scenario (reset_smoke is mandatory for all designs)
- Scenario name: use snake_case, be specific (e.g. led_shift_once, not test1)
- Stimulus: describe EXACTLY what inputs are driven and when
  (e.g. "assert rst_n=0 for 5 cycles, release at posedge clk")
- Checks: describe EXACTLY what is observed and compared on the clock edge
  (e.g. "after reset release, led == 8'b0000_0001")
- Rules: reference the behavior spec rule ID (e.g. BEH-001) if available, otherwise "-"

For a simple module (counter, LED chaser, divider): 2–3 rows is sufficient.
For a complex module (AXI bus, image processor): add rows for backpressure, corner cases, etc.
-->

| Scenario | Stimulus | Checks | Rules |
| --- | --- | --- | --- |
| reset_smoke | assert rst_n=0 for 5 cycles, release at next posedge clk | after reset release: led == 8'b0000_0001 (first LED on) | - |
| nominal_shift_once | after reset, wait MAX_COUNT clock cycles | led == 8'b0000_0010 (shifted left by 1) | - |
| nominal_shift_twice | after reset, wait 2×MAX_COUNT clock cycles | led == 8'b0000_0100 (shifted left by 2) | - |

<!--
GOOD examples of rows (copy this style):

| led_shift_once | after reset, wait MAX_COUNT cycles at posedge clk | led == 8'b0000_0010 | BEH-003 |
| counter_wrap | after reset, wait MAX_COUNT cycles | counter == 0 (wrap-around to 0) | BEH-002 |
| uart_byte_tx | drive tx_start=1, tx_data=8'hA5, wait for tx_done=1 | tx_pin shows start+8bits+stop pattern | BEH-005 |

BAD examples — never use these:

| test1 | test reset | check output | - |           ← vague
| basic_test | run some tests | verify output | - |            ← no detail
| edge_case | edge case | TODO | - |                           ← placeholder
-->
