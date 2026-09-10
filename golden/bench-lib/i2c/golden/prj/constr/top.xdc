# =============================================================================
# prj/constr/top.xdc — CLOCK-ONLY main constraint (timing-only / exploratory)
# Project : I2C master golden baseline (bench-lib T2) [p17]
# Part    : xc7k70tfbv676-1
# Top RTL : rtl/i2c_top.v (golden wrapper around FreeCores i2c reference)
# -----------------------------------------------------------------------------
# SCOPE DECLARATION (timing-only / exploratory):
#   * This file intentionally contains NO pin mappings and NO IOSTANDARD
#     properties. No board-level pin_map / electrical_facts exist for this
#     run: it is a frozen golden-baseline toolchain comparison on RTL only,
#     not a board bring-up. SCL/SDA board pull-up values are an open
#     question (I2C-OQ-001) and do not affect RTL-level metrics.
#   * Expected DRC exemption items at bitstream-stage DRC: UCIO-1 and
#     NSTD-1 (unconstrained I/O ports / ports without IOSTANDARD).
#     These exemptions are DECLARED HERE AS COMMENTS ONLY. No
#     `set_property SEVERITY` overrides are used anywhere in this file.
#   * Consequence: the accompanying implement job runs with
#     stop-before-bitstream. Place/route, DRC-exploration, STA (WNS) and
#     utilization (LUT/FF) reports are still produced and are the metrics
#     of record for the baseline comparison.
# -----------------------------------------------------------------------------

# System clock: 100 MHz (I2C-DRQ-PERF-001)
create_clock -period 10.000 -name clk -waveform {0.000 5.000} [get_ports clk]

# Asynchronous I2C serial inputs cross into the clk domain inside the DUT
# (synchronizer + glitch filter, I2C-DRQ-REL-001). The pads themselves are
# unconstrained IO (see SCOPE DECLARATION above).
