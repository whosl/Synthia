# FPGA 硬件参考库

本目录统一保存 Synthia FPGA 工程使用的板卡原理图、用户手册、器件数据手册、管脚表和接口规范。文件是候选硬件事实的来源，不代表已经建立受控基线或获得人类批准。

## 目录约定

```text
hardware/
├── hardware-documents.json     # 机器可读清单、目标标识、来源和 SHA-256
├── boards/<vendor>/<board>/    # 开发板原理图、手册、参考约束
├── parts/<vendor>/<part>/      # FPGA、时钟、电源、接口芯片等器件资料
└── interfaces/<name>/           # 与特定板卡/器件无关的接口资料
```

## 已入库资料

| 目标 | 文档 | 类型 | 状态 |
|---|---|---|---|
| Xilinx VC709 Rev 1.0 / XC7VX690T-FFG1761 | XTP213 - VC709 Schematics Rev 1.0 | 官方板级原理图，57 页 | available |
| Xilinx VC709 Rev 1.0 / XC7VX690T-FFG1761 | VC709 Master XDC Rev 1.0 | 官方参考约束 | available |

精确文件名、目标 part、页数、来源和哈希见 [`hardware-documents.json`](./hardware-documents.json)。

## 入库规则

1. 按资料真实归属放入 `boards`、`parts` 或 `interfaces`，不将板级原理图误当作器件数据手册。
2. 每份资料必须在机器清单中记录目标标识、版本、页数、SHA-256、来源文件和来源边界。
3. PDF 只作为资料读取；不执行嵌入脚本、表单动作、附件或外部链接。
4. 修订版不覆盖旧版；使用稳定文件名并新增清单记录。
5. 提取管脚、Bank 电压、时钟或 I/O 标准时，必须记录页码/网络名/表格名等可回溯位置，并对照官方参考约束或网表（如可用）。
