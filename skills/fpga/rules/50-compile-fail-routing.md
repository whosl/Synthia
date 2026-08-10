# FPGA 编译失败条件路由

| 属性 | 内容 |
|---|---|
| 规则编号 | SYNTHIA-FPGA-RULE-50 |
| 版本/状态 | v0.1 / candidate |
| 适用对象 | `fpga-compile-and-repair` 修复循环未收敛后的路由 |

当 `fpga-compile-and-repair` 内编译检查循环 3 轮未能通过时：

- 不要在 Runtime 主流程中直接尝试修复 RTL/TB；
- 下一步必须重新交接 `fpga-compile-and-repair`，并把前序 ToolRun 的证据引用（validate_sources 日志 EvidenceManifest 条目、输入哈希）与相关源文件路径作为输入；
- 如果是 TB 结构问题导致反复失败：交接 `fpga-tb-write` 重写 TB 候选，再回到 `fpga-compile-and-repair`；
- 如果是 DUT 逻辑问题：交接 `fpga-rtl-build` 修复 RTL 候选，再回到 `fpga-compile-and-repair`；
- 修复循环每次产生的是新的候选修订（candidate），不覆盖既有候选；诊断报告保持 diagnostic 状态并完整保留历史，禁止删除失败证据。
