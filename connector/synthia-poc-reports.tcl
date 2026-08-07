read_verilog D:/synthia-probe/synthia-poc.v
synth_design -top synthia_probe -part xc7k70tfbv676-1
create_clock -name clk -period 10.000 [get_ports clk]
report_drc -file D:/synthia-probe/poc-drc.rpt
report_timing_summary -file D:/synthia-probe/poc-sta.rpt
report_utilization -file D:/synthia-probe/poc-resources.rpt
write_checkpoint -force D:/synthia-probe/poc.dcp
puts "SYNTHIA_SYNTH_REPORT_SUCCESS"
exit 0
