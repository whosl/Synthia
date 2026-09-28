# =============================================================================
# prj/constr/top.xdc — vga_golden_top 物理约束（候选 v1）
# 顶层: vga_golden_top | 器件: xc7k70tfbv676-1（VGA-DRQ-DEV-001）
# 形态: clock-only 主约束（引脚/电气轴缺口，VGA-OQ-001）
# 时钟方案: 单时钟域 100 MHz 主时钟 create_clock；像素节拍为时钟使能
#           （rtl vga_golden_top.v PIXDIV=4，PERF-001），无生成时钟 →
#           不需要 create_generated_clock。
# 缺口声明: 引脚/电气事实缺失（VGA-OQ-001"引脚/电气/实际像素时钟未决"）。
#           本文件不含任何 PACKAGE_PIN/IOSTANDARD 映射。
# =============================================================================

# ---------- 主时钟（explicit: 系统 100 MHz 单时钟域，PERF-001/REL-001）---------
create_clock -period 10.000 -name sys_clk -waveform {0.000 5.000} [get_ports clk]

# ---------- 时钟域交互 ----------
# 单时钟域设计；fb_* 与 psel 同域同步协议（VGA-DRQ-REL-001），无 CDC。
# pix_ce 为 CE 而非生成时钟，内部跨 pix_ce 边界路径由工具按 sys_clk 单域分析。

# ---------- 复位 ----------
# rst 为同步高有效；若板级复位为异步输入，由板级约束阶段补充
# set_false_path -from [get_ports rst]（本候选不预设）。

# ---------- 未决引脚 DRC 豁免预期（注释级，不改写 DRC 严重度）-----------------
# VGA-DRQ-ENV-002：引脚未决以 NSTD-1/UCIO-1 注释级豁免预期：
#   - implement 阶段 DRC 将报 NSTD-1（无 IOSTANDARD）与 UCIO-1（无 PACKAGE_PIN）
#   - 处置: 板级事实到位后补 PACKAGE_PIN/IOSTANDARD 映射并移除豁免预期
#   - 不使用 set_property SEVERITY {Warning} 改写 DRC 严重度（红线）
# =============================================================================

# =================== 以下为引脚映射缺口（VGA-OQ-001）=======================
# [GAP] 未决板级项：
#   - 全部端口 PACKAGE_PIN / IOSTANDARD 未决（OQ-001）
#   - 无第二时钟源；无 fb 端口方向外的电气参数（驱动/摆率）要求
# [GAP] 端口清单（须映射，共 18 类/约 50 引脚）: clk/rst/psel/penable/pwrite/
#       paddr[5:0]/pwdata[31:0]/prdata[31:0]/pready/hsync/vsync/blank/
#       rgb[23:0]/pix_ce/fb_addr[31:0]/fb_rdata[ GAP-DONE ]/fb_rd/fb_rvalid/irq
# =============================================================================
