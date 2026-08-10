# Synthia FPGA 板卡/器件数据目录

## 概述

本目录存放 Synthia FPGA 技能包的**板卡/器件参考数据**，核心产物是
`board-catalog.json`（`schema_version: synthia.fpga-board-catalog.v1`）。

定位：**候选选择、上下文补全、硬件资料收集指引**。本目录：

- 不是最终 pin/XDC 事实源；
- 不代表硬件事实已验证（全部板卡 `constraint_ready: false`）；
- 不代表 Connector 执行能力（Vivado 等是外部执行工具链）。

## 来源与 provenance

| 项 | 值 |
| --- | --- |
| 上游来源 | 外部 FPGA 工程参考数据快照 |
| 源文件 1 | `featured-boards.json`（2 块 featured 板卡的板级描述） |
| 源文件 2 | `boards.js`（主数据，上游 version 1.2.12，last_updated 2026-06-11，上游基准 `boards(1).js version 1.2.6`） |
| 规范化日期 | 2026-08-10 |
| 规范化方式 | 人工审读 + 静态结构化改写；未执行上游 JS，未复制原始文件入库 |

上游引用的供应商资料共 59 条，全部保留在 `board-catalog.json.references[]`
（含 title/url/used_for 与稳定 `ref_id`）。

## 覆盖范围

- featured 板卡 7 块：安路 EF2L45 EVB、康芯 HX4S20（即安路 PANG EG4S20）、
  米联客 MLK-F3P-CZ02 DR1、Digilent Arty A7-35T、AMD ZCU102、
  Terasic DE10-Nano、Intel MAX 10 10M50 Kit。
- 器件覆盖索引 `device_coverage[]`：上游 `chips[]` 共 398 行
  （xilinx 178 / intel 164 / anlogic 56），本目录**不复制逐器件行**，
  只保留供应商→系列→器件数量、类别与封装数据状态的可审计索引。
- 上游明确排除：AMD/Intel 每封装×速度等级的完整订货号；XC4000、
  Spartan-3/6、Virtex-4/5/6、Cyclone I/II/III、Stratix I/II/III、
  MAX 7000/3000 等旧系列。AMD CPLD（CoolRunner-II/XC9500）Vivado 不支持，
  仅作 ISE legacy 记录。

## 字段语义（要点）

- `vendors[]`：`vendor_id` 取上游三值 `xilinx`/`intel`/`anlogic`，
  `canonical_name` 固定为 “AMD / Xilinx”、“Intel / Altera”、“安路科技”，
  消除供应商边界歧义；`also_known_as` 保留上游别名。
- `toolchains[]`：上游工具链声明。`execution: external` 表示外部执行工具链；
  `synthia_boundary` 说明与 Connector 的边界。上游 `iverilog` 的
  `install_method=bundled` 是插件运行时概念，已归一化为外部工具。
- `featured_boards[]`：
  - `silicon`：芯片供应商/系列/器件/类别（与板卡厂商 `board_manufacturer` 分离；
    上游 featured-boards.json 把 `vendor=milianke` 与 `vendor_name=安路科技` 混写，
    已拆分）。
  - `resource_summary[]`：资源量级摘要，每项含 `value/unit/display_text`、
    `source_field`（上游字段名）与 `confidence`（见下“证据等级”）。
    **仅用于候选比较与上下文，不是 pin/XDC 事实。**
  - `board_manual_claims[]`：来自板卡手册的声明（外设、内存配置等），
    手册未随数据包提供，统一标记 `unverified_board_manual`。
  - `constraint_ready`：当前全部为 `false`；`constraint_blockers` 列出缺口，
    `required_materials_to_close` 列出关闭缺口所需资料。
  - `feature_hints[]`：上游 `supported_features` 的归一化命名，属未验证提示。
- `device_coverage[]`：系列级索引；`package_data_status_dominant` 取值见
  `data_status_enums.package_data_status`。
- `data_status_enums`：`package_data_status`、`resource_data_status`、
  `metric_confidence`、`constraint_ready` 的取值定义。

## 证据等级（confidence）

| 等级 | 含义 | 可否作约束证据 |
| --- | --- | --- |
| `official_table` | 芯片级官方产品表/选型指南数据 | 否（只是器件资源量级，不是板级管脚事实） |
| `unverified_board_manual` | 板卡手册声明，手册未随包提供、未核对 | 否 |
| `estimated` | 推算值（如上游 `io_banks_source_type=estimated_from_user_io_or_package_pins`） | 否，且上游明确要求最终约束前用 pinout/原理图确认 |

即使数值标为 `official_table`，也只是**器件级**事实；板级管脚映射
（连接器、Bank、电平、时钟走线）一律不在本目录的事实范围内。

## `constraint_ready` 语义

`constraint_ready: false` 的记录禁止下游直接生成最终约束
（XDC/SDC/ADC 等）。当前 7 块板卡全部为 `false`，原因：目录内无板级
pinout/原理图，featured 板卡手册未随包提供，部分 IO Bank 数据为估算。
关闭路径：按 `required_materials_to_close` 收集资料 → 由硬件资料抽取流程
产出带证据的结构化事实 → 在 Core 流程中评审/批准为基线后，约束类技能方可
引用。

## 边界

### 与 `doc/hw/extracted_facts.json` 的边界

`doc/hw/extracted_facts.json`（由硬件手册抽取流程产出）是**带证据链的
硬件事实层**：每条事实对应手册/原理图的出处，可经评审成为基线。本目录是
**候选与上下文层**：只回答“有哪些板卡/器件可选、资源量级多大、还缺什么
资料”。两者冲突时，以 `extracted_facts.json` 中经确认的事实为准；本目录
的 `board_manual_claims` 在对应手册被抽取并核对前不得升级为事实。

### 与 Core Artifact 的边界

本目录是**静态参考数据**，不是 Core Artifact，不进入 ToolRun 产物链。
Skill 运行中引用本目录时，应把所用记录（`board_id`/`ref_id`/目录版本）
写入 Skill 输出的输入快照与 provenance，由 Core 按 Artifact 契约存证；
本目录自身的变更走仓库版本控制与评审，不走 Artifact 审批流。

### 与 Connector capability 的边界

`toolchains[]` 仅表示上游数据声明的板卡/器件—工具链适配关系。Vivado 是
外部执行工具链，Synthia 侧能否执行以 Connector 已注册能力为准（当前仅
`vivado-batch-1` 能力档的 8 项真实能力）。Skill 描述 `required_capabilities`
时必须引用 Connector 能力 ID（如 `vivado-batch-1:validate_sources`），
不得引用本目录的工具链条目，也不得由此派生自由 Tcl 入口。

## 转换取舍

- 未复制：原始 `boards.js`（约 2.5MB / 79,543 行）、`featured-boards.json`
  的 UI 颜色与高亮字段、`ui_selectable`/`ui_metric_cards`/
  `selection_schema`/`resource_display_schema` 等 UI 契约、
  `__MACOSX`/`.DS_Store`/`node_modules`/插件运行时。
- 乱码处理：上游 `data_scope` 中 4 个中文说明字段编码损坏（连续 `?`），
  未纳入；语义以保留的英文字段与 `exclusions` 为准。
- 命名归一：`vendor=milianke` 拆为板卡厂商；`anlogic-pang-eg4s20` 双名称
  （康芯 HX4S20 / 安路 PANG EG4S20）合并保留。
- 全量 chips[] 以系列级索引替代，完整行数据留在上游包备查。

## 已知风险

1. featured 板卡的两份手册未随包提供，`board_manual_claims` 全部未验证；
   需补手册并走抽取流程后才能支撑约束类工作。
2. 上游 `last_updated=2026-06-11`，供应商产品表后续可能更新，目录不承诺
   时效性；引用时应在输出中携带目录版本与上游版本。
3. 上游大量 `io_banks` 为估算值；任何依赖 Bank 划分的分析必须显式降级为
   候选并提示补料。
4. 康芯 HX4S20 与安路 PANG EG4S20 的同一性未获上游确认，合并记录保留了
   双名称，待手册到位后核实。
