# 仿真运行（fpga-sim-run）

| 属性 | 内容 |
|---|---|
| 技能 ID | `fpga-sim-run` |
| 版本/阶段 | 0.1.0 / G4 |
| 状态 | candidate |
| 所需权限 | `read`、`candidate_write`、`tool_submit` |
| 所需能力 | `vivado-batch-1:simulate` |
| 失败策略 | `fail_closed` |

## 1. 用途

在用户明确要求运行仿真时，对已有 RTL+TB 候选源集发起行为仿真，产出运行记录、日志证据与运行报告。本阶段可选且成本敏感：不因 RTL 或 TB 生成完成而自动触发。

## 2. 边界

- 只对已有 RTL 与 TB 候选运行仿真；
- 不生成 RTL 源（缺失路由 `fpga-rtl-build`）；不生成 TB 源（缺失路由 `fpga-tb-write`）；
- 仿真只通过 Core 构造 JobRequest 调用 `vivado-batch-1:simulate` 能力（`run_class=exploratory`）；本技能不直接执行任何工具命令或脚本；
- **VCD/波形导出当前未启用**：`simulate` 强类型契约不包含波形文件产出（post-mvp）。用户要求波形时如实说明该能力未启用，不得在报告中承诺或伪造波形文件；
- 工具可用性以 `vivado-batch-1:discover_toolchain` 快照为准；工具缺失是阻塞条件，立即停止并报告原因。

## 3. 输入快照

1. `doc/intake/summary.md`、`doc/compile/check_report.md`、`tb/handoff_packet.md`（如存在）；
2. `rtl/` 至少一个 RTL 候选源；
3. `tb/` 至少一个 TB 候选源（含自检 PASS/FAIL）。

## 4. 工作流程

1. 确认用户本轮明确要求运行仿真；
2. 校验 `rtl/` 与 `tb/` 候选源齐备；缺失按边界路由；
3. 通过 Core API 提交 `vivado-batch-1:simulate` JobRequest：`sources` 为 RTL+TB 候选源集 manifest，`top` 为 RTL 顶层，`testbench` 为 TB 顶层模块，`runClass=exploratory`；
4. Worker 在独立工作区执行 XSim 编译/展开/运行，Core 登记 ToolRun、输入哈希与 EvidenceManifest；
5. 写 `doc/compile/run_report.md`：请求参数、PASS/FAIL（以 ToolRun 退出状态与 TB 自检输出为据）、日志证据引用、失败阶段与建议下一步；
6. 编译失败：不在此修复，路由 `fpga-compile-and-repair`；
7. 仿真失败：TB 期望错误路由 `fpga-tb-write`；DUT 行为错误路由 `fpga-rtl-build`。

## 5. 输出产物

| 产物 | Artifact 类型 | 状态 |
|---|---|---|
| simulate 运行记录 | `TOOL_RUN` | diagnostic |
| `doc/compile/run_report.md` | `TEST_RUN` | diagnostic |

## 6. 完成闸门与证据要求

- ToolRun succeeded 且 TB 自检 PASS → 报告写 PASS 并引用证据；或
- 失败 → 报告记录失败阶段（编译/展开/运行）、日志证据路径与建议修复技能；
- PASS/FAIL 必须标注证据范围（jobId、输入哈希、日志条目 SHA-256）；
- ToolRun succeeded 不自动产生任何批准结论（Core 不变量 6）。

## 7. 失败处理（fail_closed）

- 工具/许可证/器件不可用：阻塞并记录，不重试；
- ToolRun failed / timeout / lost / unknown_effect：如实报告状态与证据；`unknown_effect` 禁止自动重试（平台安全边界）。

## 8. 附带资源

- 无独立模板；报告结构参照 `../fpga-compile-and-repair/templates/check_report.md` 的证据引用风格。
