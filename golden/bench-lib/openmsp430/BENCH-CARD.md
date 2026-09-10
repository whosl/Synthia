# openmsp430 — 基准卡

| 项 | 值 |
|---|---|
| 梯队 | T3 |
| 来源 | https://github.com/freecores/openmsp430 |
| 许可证 | LICENSE.txt（BSD 类） |
| 参考顶层 | openMSP430（core/rtl/verilog/） |
| 需求来源 | TI MSP430 用户手册（指令集+外设寄存器，公开 PDF） |

**出题要点**：108k 行完整 MCU；**原语在 fpga/ 移植层（3 处），核心纯净**；建议裁剪外设子集出题（如仅 timer+uart）

**入库形态**：本目录为参考实现完整树（.git 已剥）。制作模板时：需求文档独立成篇（不引用本目录任何结构信息）；参考 RTL 摘出可综合核心（剥板级封装）登记为人工基线。
