read_verilog {D:\synthia-worker-vc709\workspaces\vc709-sim-9600-direct-20260828\input\rtl\baud_gen.v}
read_verilog {D:\synthia-worker-vc709\workspaces\vc709-sim-9600-direct-20260828\input\rtl\uart_tx.v}
read_verilog {D:\synthia-worker-vc709\workspaces\vc709-sim-9600-direct-20260828\input\rtl\uart_rx.v}
read_verilog {D:\synthia-worker-vc709\workspaces\vc709-sim-9600-direct-20260828\input\rtl\uart_top.v}
read_verilog -sv {D:\synthia-worker-vc709\workspaces\vc709-sim-9600-direct-20260828\input\tb\uart_tb.sv}
create_project synthia_batch {D:\synthia-worker-vc709\workspaces\vc709-sim-9600-direct-20260828\vivado-project} -part {xc7vx690tffg1761-2} -force
add_files -fileset sources_1 {D:\synthia-worker-vc709\workspaces\vc709-sim-9600-direct-20260828\input\rtl\baud_gen.v} {D:\synthia-worker-vc709\workspaces\vc709-sim-9600-direct-20260828\input\rtl\uart_tx.v} {D:\synthia-worker-vc709\workspaces\vc709-sim-9600-direct-20260828\input\rtl\uart_rx.v} {D:\synthia-worker-vc709\workspaces\vc709-sim-9600-direct-20260828\input\rtl\uart_top.v}
add_files -fileset sim_1 {D:\synthia-worker-vc709\workspaces\vc709-sim-9600-direct-20260828\input\tb\uart_tb.sv}
set_property top {uart_top} [get_filesets sources_1]
set_property top {uart_tb} [get_filesets sim_1]
set_property xsim.simulate.runtime {100ms} [get_filesets sim_1]
update_compile_order -fileset sources_1
update_compile_order -fileset sim_1
launch_simulation -mode behavioral -scripts_only -absolute_path
set simRoot [file normalize [file join {D:\synthia-worker-vc709\workspaces\vc709-sim-9600-direct-20260828\vivado-project} "synthia_batch.sim" "sim_1" "behav" "xsim"]]
cd $simRoot
proc phaseExitCode {options} {
  if {[dict exists $options -errorcode]} {
    set ec [dict get $options -errorcode]
    if {[llength $ec] >= 3 && [lindex $ec 0] eq "CHILDSTATUS"} { return [lindex $ec 2] }
  }
  return 1
}
set phase compile
if {[catch {exec cmd.exe /d /c [list call [file join $simRoot compile.bat]] 2>@1} sim_output sim_options]} { puts "PHASE=compile"; puts "PHASE_EXIT_CODE=[phaseExitCode $sim_options]"; puts $sim_output; return -options $sim_options $sim_output }
set phase elaborate
if {[catch {exec cmd.exe /d /c [list call [file join $simRoot elaborate.bat]] 2>@1} sim_output sim_options]} { puts "PHASE=elaborate"; puts "PHASE_EXIT_CODE=[phaseExitCode $sim_options]"; puts $sim_output; return -options $sim_options $sim_output }
set phase simulate
if {[catch {exec cmd.exe /d /c [list call [file join $simRoot simulate.bat]] 2>@1} sim_output sim_options]} { puts "PHASE=simulate"; puts "PHASE_EXIT_CODE=[phaseExitCode $sim_options]"; puts "SIMULATOR_OUTPUT_BEGIN"; puts $sim_output; puts "SIMULATOR_OUTPUT_END"; return -options $sim_options $sim_output }
puts "PHASE=simulate"
puts "PHASE_EXIT_CODE=0"
puts "SIMULATOR_OUTPUT_BEGIN"
puts $sim_output
puts "SIMULATOR_OUTPUT_END"
puts SIMULATION_OK