# TB 生成交接文档

## Read First

- `tb/tb_top.v` — TB top module
- `tb/dut_inst.vh` — DUT instantiation
- `tb/scenario_matrix.md` — scenario coverage

## 编译检查交接（fpga-compile-and-repair）

- TB 顶层模块：`tb_top`（与 `module tb_top;` 一致）
- RTL 顶层模块：`<module_name>`
- 候选源集：`rtl/**/*.v(.sv)` + `tb/**/*.v(.sv)` 的全部路径与内容哈希（写入交接清单）

编译检查不直接执行任何工具命令；由 `fpga-compile-and-repair` 通过 Core API 提交 `vivado-batch-1:validate_sources` JobRequest（sources 为上述候选源集，top 为 TB 顶层模块），诊断以 Connector 返回的 EvidenceManifest 与日志哈希为准。

## DUT Information

| Field | Value |
| --- | --- |
| RTL Module | TODO: fill in module name |
| Clock | TODO: fill in frequency (e.g. 50MHz) |
| Reset | TODO: fill in (e.g. async low-active) |
| Parameters | TODO: list all parameters and their values |

## Optional Next Stages

- 编译检查：`fpga-compile-and-repair`（经 `vivado-batch-1:validate_sources`）
- 仿真运行：`fpga-sim-run`（经 `vivado-batch-1:simulate`）
- VCD 波形导出：当前能力契约未覆盖，post-mvp 未启用

## Open Risks

| Risk | Impact | Mitigation |

## Stop Conditions For Next Skill

- If compile fails: `fpga-compile-and-repair` will fix TB syntax and retry
- If simulation fails: route diagnostics to `fpga-rtl-build` for RTL logic issues or `fpga-tb-write` for TB expectation issues
- If DUT ports are wrong: route back to `fpga-rtl-build`
