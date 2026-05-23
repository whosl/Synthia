create_clock -period 10.000 -name sys_clk [get_ports clk]

set_property PACKAGE_PIN H17 [get_ports led]
set_property IOSTANDARD LVCMOS33 [get_ports led]
