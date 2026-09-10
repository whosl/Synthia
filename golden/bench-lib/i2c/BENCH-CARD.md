# i2c — 基准卡

| 项 | 值 |
|---|---|
| 梯队 | T2 |
| 来源 | https://github.com/freecores/i2c |
| 许可证 | OpenCores（LGPL 类） |
| 参考顶层 | i2c_master_top / i2c_slave_top |
| 需求来源 | NXP I2C-bus specification (UM10204) + doc/ |

**出题要点**：多速率/仲裁/时钟拉伸语义丰富；注意与已跑的 SPI/p8 互补

**入库形态**：本目录为参考实现完整树（.git 已剥）。制作模板时：需求文档独立成篇（不引用本目录任何结构信息）；参考 RTL 摘出可综合核心（剥板级封装）登记为人工基线。
