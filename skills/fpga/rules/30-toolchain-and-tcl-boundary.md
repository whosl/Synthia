# FPGA 工具链与 Tcl 边界

| 属性 | 内容 |
|---|---|
| 规则编号 | SYNTHIA-FPGA-RULE-30 |
| 版本/状态 | v0.1 / candidate |
| 适用对象 | 全部 FPGA 技能的工具使用与 Tcl 相关行为 |
| 上游 | SYNTHIA-ARC-001（平台总体架构 §7 安全与信任边界） |

## 1. 总原则

- 技能**不直接执行任何工具命令、脚本或 Tcl**。所有工程命令和 Vivado 操作必须经过版本化 Core API → 厂商无关 Connector Port → Adapter → Worker 的链路，由 Core 根据权限、输入状态和项目策略构造 JobRequest。
- 技能不得引导用户使用 brew/apt/yum 等系统包管理器安装工具链；工具可用性以 `vivado-batch-1:discover_toolchain` 产生的 toolchain_snapshot 证据为准。
- 工具缺失（BINARY_UNAVAILABLE / LICENSE_UNAVAILABLE / PART_UNAVAILABLE）是**阻塞条件**，不是可恢复错误：立即停止、记录阻塞原因与证据，不反复重试、不尝试替代路径。

## 2. 当前可用的强类型能力（vivado-batch-1）

| 能力 ID | 用途 | 典型使用技能 |
|---|---|---|
| `vivado-batch-1:discover_toolchain` | 工具链/器件快照 | 工具可用性判定 |
| `vivado-batch-1:query_parts` | 器件查询 | 器件确认 |
| `vivado-batch-1:validate_sources` | 源码语法/展开检查 | `fpga-compile-and-repair` |
| `vivado-batch-1:simulate` | XSim 行为仿真 | `fpga-sim-run` |
| `vivado-batch-1:synthesize` | 综合 | post-mvp 交接预留，当前技能包未启用 |
| `vivado-batch-1:report_drc` | DRC 报告 | post-mvp 交接预留，当前技能包未启用 |
| `vivado-batch-1:report_sta` | 时序报告 | post-mvp 交接预留，当前技能包未启用 |
| `vivado-batch-1:report_resources` | 资源报告 | post-mvp 交接预留，当前技能包未启用 |

技能声明 `required_capabilities` 时只能引用上表能力 ID；生成/分析类技能不需要 Connector 能力，声明为空数组。

## 3. 未启用能力（post-mvp，禁止宣称可用）

以下能力当前**未实现/未启用**，任何技能不得声明依赖、不得伪造其产物：

- 实现（place & route / implement_design）；
- 码流生成（bitstream）；
- 硬件下载/烧写（program device，属硬件写权，需独立授权）；
- VCD/波形导出（当前 `simulate` 强类型契约未覆盖波形文件产出）；
- 携带 XDC 的综合验证（当前 `synthesize` 契约不含约束输入）。

在报告、交接或用户可见总结中提及上述能力时，必须明确标注 post-mvp/未启用。

## 4. 自定义 Tcl 边界（propose → check → authorize → execute）

技能可以**提出** Tcl 候选文本（`propose_tcl`），但执行链路是：

```text
propose_tcl（技能产出 Tcl 候选文本，candidate）
  → static check（确定性静态检查：命令白名单、副作用分析、参数边界）
  → policy/human authorize（策略 + 人类目的绑定授权记录）
  → execute_approved_tcl（Worker 按授权记录执行已批准 Tcl）
```

- 平台不提供、技能不得创建 `execute_tcl(any_string)` 形式的任意 Tcl 执行入口。
- `execute_approved_tcl` 当前未启用；在启用前，所有工具行为只走第 2 节的强类型能力。
- 授权记录与用途绑定；Worker 不判断工程结论，技能不持有授权。

## 5. 运行级别约束

- 技能发起的工具请求默认 `run_class=exploratory`；`gate_check`/`formal` 只能由 Core 在门禁上下文中构造，且要求 Worker 处于 `ready` 状态。
- ToolRun `succeeded` 只表示执行成功，不产生任何批准结论；工程结论由 GateSubmission 与人类批准产生。
