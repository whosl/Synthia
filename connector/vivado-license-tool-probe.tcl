set target_part xc7k70tfbv676-1
puts "SYNTHIA_LICENSE_TOOL_PROBE_BEGIN"
puts "vivado_version=[version -short]"
puts "target_part=$target_part"
read_verilog synthia-probe.v
synth_design -top synthia_probe -part $target_part
report_utilization -file synthia-probe-utilization.rpt
report_drc -file synthia-probe-drc.rpt
write_checkpoint -force synthia-probe.dcp
puts "SYNTHIA_LICENSE_TOOL_PROBE_SUCCESS"
exit 0
