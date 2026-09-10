# fpganes — 基准卡

| 项 | 值 |
|---|---|
| 梯队 | T3 |
| 来源 | https://github.com/strigeus/fpganes |
| 许可证 | GPLv2 |
| 参考顶层 | NES_top（src/NES_Nexys4.v 为板级封装） |
| 需求来源 | NES 硬件反汇编级文档（nesdev.org 权威公开） |

**出题要点**：6502 CPU+PPU+APU 三核协同；**原语 2 处在板级文件**（clk_wiz/Master.ucf），核心纯净；子题建议：仅 6502 或仅 PPU

**入库形态**：本目录为参考实现完整树（.git 已剥）。制作模板时：需求文档独立成篇（不引用本目录任何结构信息）；参考 RTL 摘出可综合核心（剥板级封装）登记为人工基线。
