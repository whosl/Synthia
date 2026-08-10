# TestBench 生成（fpga-tb-write）

| 属性 | 内容 |
|---|---|
| 技能 ID | `fpga-tb-write` |
| 版本/阶段 | 0.1.0 / G4 |
| 状态 | candidate |
| 所需权限 | `read`、`candidate_write` |
| 所需能力 | 无（纯候选生成技能；编译/仿真经 `fpga-compile-and-repair` / `fpga-sim-run` 交接 Connector 能力） |
| 失败策略 | `fail_closed` |

## 1. 用途

生成自检 TestBench 源码候选。本技能不编译、不运行、不验证仿真：编译检查交 `fpga-compile-and-repair`，仿真运行交 `fpga-sim-run`。**一次调用产出一套 TB 产物**。

## 2. 边界

- 只生成 TB 源码候选；TB 必须能在仿真运行时产生显式 PASS/FAIL；
- 不在本技能修复 RTL/TB 语法错误（交 `fpga-compile-and-repair`）；
- 不执行任何工具命令；
- 目录契约：TB 源在 `tb/`，禁止写入 `doc/sim/`（见 `../../rules/25-workspace-layout.md`）。

### 硬闸门——产物必须真实登记（不可协商）

**只输出"TB 已生成"之类的文字而没有真实登记候选 ArtifactRevision，即为失败**，即使收尾文字声称完成。具体：

- "输出产物"列出的每个文件必须作为候选修订经 Core API 登记（路径 + 内容哈希）；仅在文字中描述文件内容不满足要求；
- 收尾前逐项核对声明产物与已登记候选清单；任何必需文件缺失或含 stub 时，批次按部分实现处理并列出缺失文件清单；
- 不得在产物不全时以暗示成功的总结收尾。用户信任的是登记状态，不是叙述。

该闸门防止的失败模式：声称完成但 `tb/` 无任何登记候选；只写叙述不登记文件造成静默丢失；部分完成（如只有 `tb_top.v` 没有 `dut_inst.vh`）却声称完成。

## 3. 输入快照（按优先级，逐级命中）

1. `doc/intake/summary.md` 交接章节：任务简报；
2. `doc/arch/interface_contract.yaml`、`doc/arch/connection_matrix.md`：端口契约、时钟域、复位策略；
3. `doc/spec/behavior_spec.md`、`doc/spec/scenario_matrix.md`：测试计划；
4. **直接调用**：直接读取 `rtl/` 下 RTL 候选源。不拒绝、不要求澄清；若无 RTL，按需补充输入收尾并指明缺失输入。

## 4. 工作流程

### 步骤 0 — 先读 RTL 源（不可协商）

生成任何 TB 代码前必须完成：

1. 定位 `rtl/*.v` / `rtl/*.sv` 候选；
2. 逐行读取模块声明，提取：精确模块名（大小写敏感）、每个端口的名称/方向/位宽、每个 `parameter`（名称与默认值）、每个 `localparam`（仅参考，不可覆盖）；
3. RTL 不存在：按需补充输入收尾；
4. RTL 使用 AXI/Avalon 等标准总线时，先读 `references/tb_selfcheck_patterns.md` 再生成总线激励。

### 步骤 1 — 读取上下文

读取行为规格、RTL 源、既有仿真相关产物；记录时钟频率、复位极性、关键协议信号。

### 步骤 2 — 规划 TB 结构

确定最小 TB 文件集：时钟与复位、全部端口（名称/位宽/方向）、协议（valid/ready 握手）、可经输出观测的关键内部状态。

### 步骤 3 — 生成 `tb/dut_inst.vh`

- 按 RTL 声明做**精确端口映射**；
- `parameter` 用 `.PARAM_NAME(value)` 在例化处覆盖；
- `localparam` 接受定值，不覆盖；
- 禁止在例化前使用 `defparam`；
- 参数值从 RTL 源提取，不臆造。

### 步骤 4 — 生成 `tb/tb_top.v`

- 时钟：一律 `#(CLK_PERIOD / 2)` 形式；`parameter CLK_PERIOD = 1_000_000_000 / CLK_FREQ`（ns）；
- 复位：断言 `rst_n=0`，等待 N 拍，释放 `rst_n=1`；
- 超时看门狗：`#TIMEOUT_CYCLES` 触发致命结束；
- DUT 经 `` `include "dut_inst.vh" `` 例化；
- 驱动：等待时钟周期（`repeat (N) @(posedge clk)`），不用裸时间单位；
- 检查器：在时钟沿观测输出，用 `!==` 比较；
- 结束：`$display("PASS")` 或 `$display("FAIL errors=%0d", error_count)` 后 `$finish`；
- 无 stub 语言：无 `// ...`、`// TODO`、`// FIXME`、`// stub`。

### 步骤 5 — 生成 `tb/scenario_matrix.md`

- 每行是具体激励描述，非占位；
- 场景名具体（如 `led_oneshot` 而非 `test1`）；
- 简单模块 2-3 行即可（reset_smoke + 标称 + 边界）；
- 不允许只有表头的空表。

### 步骤 6 — 生成 `tb/handoff_packet.md`

记录源集清单（路径 + 内容哈希）、TB/RTL 顶层模块名、风险与下游停止条件，供 `fpga-compile-and-repair` / `fpga-sim-run` 消费。

### 步骤 7 — 自检（收尾前强制）

1. 逐项核对"输出产物"清单与已登记候选（路径 + 哈希）；
2. 每个文件确认非平凡内容：Verilog 文件含真实代码而非占位；scenario_matrix 至少 2 行具体场景；
3. 缺失或含 stub 的文件：立即补齐登记，或按部分实现收尾并列出缺失/ stub 明细；不得静默丢弃。

## 5. 输出产物

| 产物 | Artifact 类型 | 状态 |
|---|---|---|
| `tb/tb_top.v` | `TB_SOURCE_SET` | candidate |
| `tb/dut_inst.vh` | `TB_SOURCE_SET` | candidate |
| `tb/scenario_matrix.md` | `VERIFICATION_METHOD_MAP` | candidate |
| `tb/handoff_packet.md` | `TASK_HANDOFF` | candidate |

## 6. 证据要求

- 全部声明产物必须真实登记为候选修订，文字描述不视为已产出；
- `dut_inst.vh` 端口映射逐信号可回指 RTL 声明；
- 大 `localparam`（如 MAX_COUNT > 1_000_000）时 TB 验证行为正确性而非精确周期数。

## 7. 失败处理（fail_closed）

- 缺 RTL 输入：需补充输入，指明缺失；
- 产物缺失或含 stub：按部分实现收尾，列出缺失文件与 stub 明细，不宣称完成；
- 内部错误：如实报告原因。

## 8. 附带资源

- `references/tb_anti_patterns.md`：端口方向错误、时钟错误、defparam 误用、stub 模式、等待风格、大 localparam 处理；
- `references/tb_selfcheck_patterns.md`：场景类型、记分板规则、时钟周期参考、时序计算、PASS/FAIL 模式；
- `templates/`：`tb_top.v`、`dut_inst.vh`、`scenario_matrix.md`、`handoff_packet.md`。
