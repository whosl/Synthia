# spi — 基准卡

| 项 | 值 |
|---|---|
| 梯队 | T4（再验证轮） |
| 来源 | https://github.com/freecores/spi |
| 许可证 | OpenCores（LGPL 类） |
| 参考顶层 | spi_top（rtl/verilog/） |
| 需求来源 | Motorola/Freescale SPI 总线规范（公开）+ 各厂商器件时序公开文档 |

**出题要点**：1.4k 行、零原语；主从双拓扑（本库已有 i2c——同为两线/四线串行协议，可作协议族横向）；四模式 CPOL/CPHA 全矩阵、片选分频、中断/状态寄存器面
**入库形态**：参考实现完整树（.git 已剥）
