# =============================================================================
# 文件名称 : uart_exploratory.xdc
# 用途说明 : 非交付、非门禁的 exploratory Vivado 试跑专用约束。
#            该文件允许在缺少板级事实时收集资源/STA/DRC 诊断，不得进入
#            B2～B4、正式码流、板测或交付清单。
# =============================================================================

create_clock -name sys_clk -period 10.000 [get_ports clk]

# 仅为 exploratory 证据收集降低严重度。报告中必须保留全部违规，不得将
# write_bitstream 成功表述为设计满足板级约束或具备发布条件。
set_property SEVERITY WARNING [get_drc_checks NSTD-1]
set_property SEVERITY WARNING [get_drc_checks UCIO-1]
