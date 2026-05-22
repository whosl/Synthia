# Arty A7-35 (xc7a35ticsg324-1L) constraints
# 50 MHz system clock, UART RX/TX on PMOD

# Clock: 50 MHz on E3
create_clock -period 20.000 -name clk [get_ports clk]
set_property PACKAGE_PIN E3   [get_ports clk]
set_property IOSTANDARD LVCMOS33 [get_ports clk]

# Reset: active-low pushbutton
set_property PACKAGE_PIN C2   [get_ports rst_n]
set_property IOSTANDARD LVCMOS33 [get_ports rst_n]

# UART RX: PMOD JA1 (G13)
set_property PACKAGE_PIN G13  [get_ports rx]
set_property IOSTANDARD LVCMOS33 [get_ports rx]

# UART TX: PMOD JA2 (B11)
set_property PACKAGE_PIN B11  [get_ports tx]
set_property IOSTANDARD LVCMOS33 [get_ports tx]

# LEDs
set_property PACKAGE_PIN H5   [get_ports {led[0]}]
set_property PACKAGE_PIN J5   [get_ports {led[1]}]
set_property PACKAGE_PIN T9   [get_ports {led[2]}]
set_property PACKAGE_PIN T10  [get_ports {led[3]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[0]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[1]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[2]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[3]}]
