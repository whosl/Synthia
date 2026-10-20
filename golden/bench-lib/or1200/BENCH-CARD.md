# or1200 — 基准卡

| 项 | 值 |
|---|---|
| 梯队 | T4（再验证轮，收敛极限） |
| 来源 | https://github.com/openrisc/or1200 |
| 许可证 | LGPL（OpenRISC 官方实现） |
| 参考顶层 | or1200_top（rtl/verilog/） |
| 需求来源 | OpenRISC 1000 架构手册（**完全公开开放**——权威性同 TI MSP430 手册之于 msp430） |

**出题要点**：~33k 行；原语仅 spram 系（存储推断可替换）；32 位 RISC+MMU 可裁剪（子题建议：无 MMU 的 ORBIS32 基础整数子集）；与 msp430（CISC）构成 CPU 族谱另一极
**入库形态**：参考实现完整树（.git 已剥）
