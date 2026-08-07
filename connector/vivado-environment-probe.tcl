puts "SYNTHIA_BATCH_PROBE_BEGIN"
puts "vivado_version=[version -short]"
puts "os=$::tcl_platform(os)"
puts "architecture=$::tcl_platform(machine)"
set parts [get_parts *]
puts "part_count=[llength $parts]"
puts "target_part_present=[expr {[lsearch -exact $parts xc7vx690tffg1761-2] >= 0}]"
puts "parts_begin"
foreach p $parts { puts $p }
puts "parts_end"
puts "SYNTHIA_BATCH_PROBE_END"
exit 0
