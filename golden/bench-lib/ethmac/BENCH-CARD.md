# ethmac — 基准卡

| 项 | 值 |
|---|---|
| 梯队 | T4（再验证轮，收敛极限） |
| 来源 | https://github.com/freecores/ethmac |
| 许可证 | OpenCores（LGPL 类） |
| 参考顶层 | eth_top（rtl/verilog/） |
| 需求来源 | IEEE 802.3 帧格式/MII 规范（公开镜像广泛）；CRC-32 公开多项式 |

**出题要点**：~44k 行（含 wb/spram/TB，MAC 核心约 15k）；原语仅 spram+defines；数据通路+协议混合类（发送/接收 FIFO、CRC、流量控制、MII 时序）；IEEE 标准正文付费——以公开镜像+器件手册为权威，附录须含帧格式/CRC 常量
**入库形态**：参考实现完整树（.git 已剥）
