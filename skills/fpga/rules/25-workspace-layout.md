# FPGA 候选工作区布局契约

| 属性 | 内容 |
|---|---|
| 规则编号 | SYNTHIA-FPGA-RULE-25 |
| 版本/状态 | v0.1 / candidate |
| 适用对象 | 全部 FPGA 技能的候选产物路径 |

## 1. 总原则

- 源码目录只使用候选工作区根目录的 `rtl/` 与 `tb/`：`rtl/` 放可综合 RTL 候选源码；`tb/` 放 TestBench 候选源码与 TB 相关 include。
- 仿真/工具运行产物只使用 `sim/` 与 Core 登记的工具证据：日志、结果 JSON、波形等以 EvidenceManifest 条目登记，候选工作区内只保留相对路径引用。
- `doc/` 目录只用于"分析/规范/交接"候选工件（markdown/yaml/json 等），不要把 RTL/TB 源码或仿真产物放在 `doc/` 下。
- 约束相关候选统一放 `prj/constr/`（`.xdc`/`.qsf`/`.sdc`/`.pin` 及摘要/交接文档）。

## 2. 路径格式规则（重要）

- 所有路径一律使用候选工作区相对路径（`rtl/`、`tb/`、`sim/`、`doc/`、`prj/constr/`）。
- 禁止硬编码绝对路径与平台相关前缀（`/d/`、`/c/`、`D:\`、`C:\`、`/cygdrive/` 等）。
- 数据域标签（DataClassification）沿 TaskPackage → 候选 Artifact → JobRequest → Evidence 继承；跨数据域读写由 Core 策略判定，技能不得自行拼接路径穿越边界。

## 3. 必须遵守

- 不要把 TB 源码写到 `doc/sim/*.v`；不要新建 `doc/sim/` 作为 TB/仿真目录。
- 不要把可综合 RTL 源码写到 `doc/rtl/*.v`；`doc/rtl/` 仅允许 `notes.md`、交接等说明文件。
- TB 源码写入 `tb/`（如 `tb/tb_top.v`、`tb/dut_inst.vh`）。
- 编译/仿真检查报告写入 `doc/compile/`（如 `check_report.md`、`run_report.md`、`repair_report.md`）。

## 4. 兼容与迁移

发现历史项目存在 `doc/rtl/*.v`、`doc/sim/*.v` 或根目录散落波形/仿真可执行文件时：不要沿用旧布局生成新文件；新增/改动按本规则落到 `rtl/`、`tb/`、`sim/`。如需迁移旧文件，先输出迁移计划候选并等待人类确认。
