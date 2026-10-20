# uart16550 — 基准卡

| 项 | 值 |
|---|---|
| 梯队 | T4（再验证轮） |
| 来源 | https://github.com/freecores/uart16550 |
| 许可证 | OpenCores（LGPL 类） |
| 参考顶层 | uart_top（rtl/verilog/，含 wishbone 接口层） |
| 需求来源 | NS16550A UART 数据手册（公开域）+ PC16550D 原文 |

**出题要点**：~11k 行（含 wb 接口/仿真模型，核心约 3-4k）；寄存器接口+FIFO 深度类（16 字收发 FIFO/触发中断/Modem 状态/波特小数分频）；FIFO 可编程触发级中断是收敛难点
**入库形态**：参考实现完整树（.git 已剥）；制作模板时剥 wb 封装与 sim 模型
