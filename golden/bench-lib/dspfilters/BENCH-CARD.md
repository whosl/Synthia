# dspfilters — 基准卡

| 项 | 值 |
|---|---|
| 梯队 | T2 |
| 来源 | https://github.com/ZipCPU/dspfilters |
| 许可证 | GPL（ZipCPU 系） |
| 参考顶层 | fastfir / slowfil（rtl/） |
| 需求来源 | README + 滤波器组设计文档 |

**出题要点**：DSP 密集，多通道时序收敛压力；ZipCPU 配套文档质量高

**入库形态**：本目录为参考实现完整树（.git 已剥）。制作模板时：需求文档独立成篇（不引用本目录任何结构信息）；参考 RTL 摘出可综合核心（剥板级封装）登记为人工基线。
