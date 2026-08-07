puts "SYNTHIA_PART_PROBE_BEGIN"
puts "vivado_version=[version -short]"
foreach pattern {xc7vx* xc7v*} {
  set matches [get_parts -quiet $pattern]
  puts "pattern=$pattern count=[llength $matches]"
  foreach p $matches { puts $p }
}
puts "SYNTHIA_PART_PROBE_END"
exit 0
