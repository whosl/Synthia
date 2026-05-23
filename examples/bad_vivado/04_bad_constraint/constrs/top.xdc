# INTENTIONAL: wrong port names / out-of-range bit index
create_clock -period 8.000 -name clk_100mhz [get_ports clk_100mhz]

set_property PACKAGE_PIN U16 [get_ports {led[8]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[8]}]

set_property PACKAGE_PIN H17 [get_ports {led[0]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[0]}]
