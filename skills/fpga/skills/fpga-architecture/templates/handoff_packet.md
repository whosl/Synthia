# 架构交接文档

## Stable Contracts

- Interface contract: `doc/arch/interface_contract.yaml`
- Clock/reset/CDC plan: `doc/arch/clock_reset_cdc.md`
- Module partition: `doc/arch/module_partition.md`
- Connection matrix: `doc/arch/connection_matrix.md`
- Top skeleton: `rtl/top_skeleton.sv`
- Risks and assumptions: `doc/arch/risks.md`

## Recommended Next Steps

- 进入 RTL 实现：按接口契约实现各子模块，不自动生成 TestBench 或运行仿真。
- 细化行为规格：补充边界条件、帧同步、阈值和波形检查计划。
- 生成 XDC：在硬件配置和管脚资料齐全后生成约束文件。

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
