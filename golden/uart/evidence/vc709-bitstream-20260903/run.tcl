read_verilog {D:\synthia-worker-vc709\workspaces\vc709-implement-bit-formal-20260828\input\rtl\baud_gen.v}
read_verilog {D:\synthia-worker-vc709\workspaces\vc709-implement-bit-formal-20260828\input\rtl\uart_tx.v}
read_verilog {D:\synthia-worker-vc709\workspaces\vc709-implement-bit-formal-20260828\input\rtl\uart_rx.v}
read_verilog {D:\synthia-worker-vc709\workspaces\vc709-implement-bit-formal-20260828\input\rtl\uart_top.v}
read_verilog {D:\synthia-worker-vc709\workspaces\vc709-implement-bit-formal-20260828\input\rtl\uart_board_top.v}
read_xdc {D:\synthia-worker-vc709\workspaces\vc709-implement-bit-formal-20260828\input\xdc\uart.xdc}
synth_design -part {xc7vx690tffg1761-2} -top {uart_board_top}
write_checkpoint -force {D:\synthia-worker-vc709\workspaces\vc709-implement-bit-formal-20260828\output\synth.dcp}
opt_design
place_design
route_design
report_methodology -file {D:\synthia-worker-vc709\workspaces\vc709-implement-bit-formal-20260828\output\methodology.rpt}
report_cdc -details -file {D:\synthia-worker-vc709\workspaces\vc709-implement-bit-formal-20260828\output\cdc.rpt}
report_drc -file {D:\synthia-worker-vc709\workspaces\vc709-implement-bit-formal-20260828\output\drc.rpt}
report_timing_summary -file {D:\synthia-worker-vc709\workspaces\vc709-implement-bit-formal-20260828\output\sta.rpt}
report_utilization -file {D:\synthia-worker-vc709\workspaces\vc709-implement-bit-formal-20260828\output\resources.rpt}
set drcErrors [get_drc_violations -quiet -filter {SEVERITY == Error}]
if {[llength $drcErrors] > 0} { error "SYNTHIA_DRC_FAILED" }
set timingClocks [get_clocks -quiet]
if {[llength $timingClocks] == 0} { error "SYNTHIA_TIMING_UNCONSTRAINED" }
set failingPaths [get_timing_paths -quiet -max_paths 1 -slack_lesser_than 0]
if {[llength $failingPaths] > 0} { error "SYNTHIA_TIMING_FAILED" }
write_checkpoint -force {D:\synthia-worker-vc709\workspaces\vc709-implement-bit-formal-20260828\output\routed.dcp}
write_bitstream -force {D:\synthia-worker-vc709\workspaces\vc709-implement-bit-formal-20260828\output\synthia.bit}
puts IMPLEMENT_OK