# vdf-fpga — 基准卡

| 项 | 值 |
|---|---|
| 梯队 | 竞赛 |
| 来源 | https://github.com/supranational/vdf-fpga |
| 许可证 | Apache（竞赛官方基线） |
| 参考顶层 | vdf（msu/rtl/） |
| 需求来源 | VDF 联盟竞赛规格书（repo 内 + supranational 官网） |

**出题要点**：低延迟模乘运算器；竞赛获奖实现可公开对照；与参数寻优方案第三支柱同域——FPL'26 竞赛（xilinx.github.io/fpl26_optimization_contest）是其放大版

**入库形态**：本目录为参考实现完整树（.git 已剥）。制作模板时：需求文档独立成篇（不引用本目录任何结构信息）；参考 RTL 摘出可综合核心（剥板级封装）登记为人工基线。
