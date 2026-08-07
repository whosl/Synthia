create_project -force synthia_poc D:/synthia-probe/project -part xc7k70tfbv676-1
add_files [list D:/synthia-probe/synthia-poc.v D:/synthia-probe/synthia-poc-tb.v]
set_property top synthia_probe_tb [current_fileset -simset]
update_compile_order -fileset sim_1
launch_simulation -mode behavioral
run all
close_sim
synth_design -top synthia_probe -part xc7k70tfbv676-1
create_clock -name clk -period 10.000 [get_ports clk]
report_drc -file D:/synthia-probe/poc-drc.rpt
report_timing_summary -file D:/synthia-probe/poc-sta.rpt
report_utilization -file D:/synthia-probe/poc-resources.rpt
write_checkpoint -force D:/synthia-probe/poc.dcp
puts "SYNTHIA_POC_SUCCESS"
exit 0
