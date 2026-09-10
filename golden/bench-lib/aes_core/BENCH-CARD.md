# aes_core — 基准卡

| 项 | 值 |
|---|---|
| 梯队 | T1 |
| 来源 | https://github.com/freecores/aes_core |
| 许可证 | OpenCores（LGPL 类，内部基准用） |
| 参考顶层 | aes_core / aes_cipher_top（rtl/verilog/） |
| 需求来源 | FIPS-197 标准（AES 规范本身即完整需求书）+ doc/ 目录 + bench 测试向量 |

**出题要点**：最理想的流程验证件：标准公开、行为可完整形式化、1.4k 行

**入库形态**：本目录为参考实现完整树（.git 已剥）。制作模板时：需求文档独立成篇（不引用本目录任何结构信息）；参考 RTL 摘出可综合核心（剥板级封装）登记为人工基线。
