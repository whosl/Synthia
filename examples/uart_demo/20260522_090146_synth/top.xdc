# top.xdc — Demo constraints
create_clock -period 20.000 [get_ports clk]
set_property PACKAGE_PIN Y18 [get_ports clk]
set_property PACKAGE_PIN Y19 [get_ports rst_n]
set_property PACKAGE_PIN W18 [get_ports rx]
set_property PACKAGE_PIN W19 [get_ports tx]
set_property PACKAGE_PIN [list R18 R19 T18 T19 U18 U19 V18 V19] [get_ports [list led[7] led[6] led[5] led[4] led[3] led[2] led[1] led[0]]]
