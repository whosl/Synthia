# 编译检查与修复（fpga-compile-and-repair）

| 属性 | 内容 |
|---|---|
| 技能 ID | `fpga-compile-and-repair` |
| 版本/阶段 | 0.1.0 / G4 |
| 状态 | candidate |
| 所需权限 | `read`、`candidate_write`、`tool_submit` |
| 所需能力 | `vivado-batch-1:validate_sources` |
| 失败策略 | `fail_closed` |

## 1. 用途

对 RTL+TB 候选源集做编译检查（语法/展开），tool-first 定位错误并以最小补丁收敛修复。不运行仿真、不生成波形。

## 2. 边界

- 编译检查只通过 Core 构造 JobRequest 调用 `vivado-batch-1:validate_sources` 能力（`run_class=exploratory`）；本技能不直接执行任何工具命令或脚本；
- 诊断必须来自真实工具输出证据；
- 修复语法错误用最小补丁，不做大面积重写；
- 不忽略影响行为、综合、位宽、有符号性、锁存器推断、CDC、复位语义的警告；
- 连续 3 轮修复未通过后停止，写修复计划而不是继续空转；
- 不建议用系统包管理器安装工具链；工具可用性以 `vivado-batch-1:discover_toolchain` 快照为准，工具缺失是阻塞条件（见 `../../rules/30-toolchain-and-tcl-boundary.md`）。

## 3. 输入快照（按优先级，逐级命中）

1. `doc/intake/summary.md` 交接章节：模块名与任务上下文；
2. `doc/spec/behavior_spec.md`（若随 RTL 生成）：行为契约；
3. 直接调用：扫描候选工作区 `rtl/*.v|.sv`、`tb/*.v|.sv`；不因交接文档缺失而拒绝；
4. 修复场景：上一轮 validate_sources ToolRun 的 EvidenceManifest 与日志条目哈希、相关源文件路径。

任务参数可指定编译入口：顶层文件、`tb_top=<模块>`、`rtl_top=<模块>` 或组合；未提供时按候选源文件名推导。

## 4. 工作流程

### 步骤 1 — 准备输入 manifest

1. 收集 `rtl/` 与 `tb/` 全部候选源（相对路径 + 内容）；
2. 确定 TB 顶层模块名（默认 `tb_top` 或按文件名推导）。

### 步骤 2 — 提交编译检查

3. 通过 Core API 提交 `vivado-batch-1:validate_sources` JobRequest：`sources` 为候选源集 manifest，`top` 为 TB 顶层模块，`runClass=exploratory`；
4. Worker 返回后，Core 登记 ToolRun 与 EvidenceManifest（日志条目含 SHA-256）；本技能读取登记结果，不接触 Worker 本地路径。

### 步骤 3 — 诊断与修复

- **ToolRun succeeded（退出码 0）**：编译干净。写 `doc/compile/check_report.md`，状态 PASS，引用证据哈希。用户需要仿真证据时可建议 `fpga-sim-run`，否则出报告后停止；
- **ToolRun failed**：
  1. 解析日志证据中的错误（文件、行、原因）；
  2. 应用最小补丁（一个逻辑修复批次），登记为 RTL/TB 新候选修订；
  3. 回到步骤 2 重新提交；
  4. 连续 3 轮未通过：写 `doc/compile/repair_report.md`（诊断、补丁清单、收敛状态、根因分析），停止；
  5. 错误指向规格缺失或接口歧义：停止，携带诊断交接 `fpga-rtl-build`。

### 步骤 4 — 产出报告

`doc/compile/check_report.md` 含：编译状态（PASS/FAIL + ToolRun 退出码）、失败时的诊断摘要、修复时的补丁清单、建议的下一个技能。所有结论引用 EvidenceManifest 条目哈希。

## 5. 输出产物

| 产物 | Artifact 类型 | 状态 |
|---|---|---|
| validate_sources 运行记录 | `TOOL_RUN` | diagnostic |
| `doc/compile/check_report.md` | `STATIC_REPORT_SET` | diagnostic |
| `doc/compile/repair_report.md`（未收敛时） | `STATIC_REPORT_SET` | diagnostic |
| 修复后的 RTL/TB 新修订（需要时） | `RTL_SOURCE_SET` / `TB_SOURCE_SET` | candidate |

## 6. 完成闸门与证据要求

- ToolRun succeeded 且退出码 0 → check_report 写 PASS；或
- 收敛失败 → repair_report 写齐诊断与下一步；
- PASS 结论只在证据范围内成立；diagnostic 报告不等于门禁通过，正式结论由人类门禁产生。

## 7. 失败处理（fail_closed）

- 工具不可用（BINARY_UNAVAILABLE / LICENSE_UNAVAILABLE / PART_UNAVAILABLE）：立即阻塞，记录原因，不重试、不建议安装；
- 3 轮未收敛：停止并产出修复报告；后续路由按 `../../rules/50-compile-fail-routing.md`（TB 结构问题交 `fpga-tb-write`，DUT 逻辑问题交 `fpga-rtl-build`）。

## 8. 交接

- 编译通过：存在 TB 且用户要仿真证据时建议 `fpga-sim-run`；
- RTL 逻辑错误：携带诊断交接 `fpga-rtl-build`；
- TB 错误：携带诊断交接 `fpga-tb-write`。

## 9. 附带资源

- `references/minimal_patch_policy.md`：最小补丁策略；
- `references/tool_first_diagnostics.md`：tool-first 诊断方法；
- `templates/`：`check_report.md`、`repair_report.md`。
