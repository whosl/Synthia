# RTL 生成（fpga-rtl-build）

| 属性 | 内容 |
|---|---|
| 技能 ID | `fpga-rtl-build` |
| 版本/阶段 | 0.1.0 / G4 |
| 状态 | candidate |
| 所需权限 | `read`、`candidate_write` |
| 所需能力 | 无（纯候选生成技能；编译/仿真经 `fpga-compile-and-repair` / `fpga-sim-run` 交接 Connector 能力） |
| 失败策略 | `defer_to_human` |

## 1. 用途

按已确认的架构/接口/行为契约生成或修改可综合 Verilog RTL 候选；也可直接处理简单明确的单模块需求（计数器、分频器、简单 FSM）。**一次调用只产出一个模块**；架构定义了多个模块时逐次交接，前一模块候选登记完成后再进行下一个。

## 2. 边界

- 不改变已确认的端口、参数、层次、寄存器语义或时序契约；必要变更显式记录并回退 `fpga-architecture` 或 `fpga-register-spec`；
- 默认可综合 Verilog；仅仿真代码显式标记且不进入 RTL 交付物；
- 不做无关重写，聚焦最小修改集并保持既有行为；
- 优先沿用仓库已有的编码风格与模块模式；
- 本技能不执行任何工具命令，不发起编译/仿真（属 `fpga-compile-and-repair` / `fpga-sim-run`）；
- **板级 `top` 受硬件事实门禁**：`doc/arch/interface_contract.yaml` 只描述设计端口/模块契约，**不构成物理板级证据**，单独不足以充当硬件事实；仅当存在 Core 登记的 `doc/hw/extracted_facts.json`（每条事实带 `source_ref`/`evidence_kind`），或用户明确提交且带等价可追溯字段（来源引用、证据类别）的板级端口契约时，才可生成 `rtl/top.v` 候选，且仅例化内部模块并连接板级端口、不含业务逻辑；硬件事实缺失时不生成、不登记，以需补充输入收尾或回退 `fpga-hw-manual-extraction` / `fpga-architecture`。

## 3. 输入快照（按优先级，逐级命中）

1. `doc/intake/summary.md`：完整任务简报；
2. `doc/arch/interface_contract.yaml`、`doc/arch/connection_matrix.md`：端口契约、信号命名、时钟域、复位策略、子模块层次（intake 之后立即读取，不可跳过）；`interface_contract.yaml` 仅为设计端口/模块契约，不作为板级物理事实来源；
3. `doc/hw/config.json`（如存在）：器件/厂商约束；
4. `doc/reg/register_map.yaml`、`doc/reg/semantics_notes.md`（存在控制面时）；
5. `doc/spec/behavior_spec.md`、`doc/spec/wave_plan.yaml`、`doc/spec/wave_compare_rules.yaml`（存在行为/波形契约时）；
6. 修改场景：已有 RTL 文件与构建脚本；
7. **直接调用**（无 intake、无项目文件）：仅限纯内部单模块（计数器、分频器、简单 FSM、数据通路）；TaskPackage 中的请求为唯一事实来源：
   - 端口至少含 `clk` 与低有效 `rst_n`——这些默认仅是模块级行为约定，由请求语义推导，不得标注或暗示为板级时钟/复位/管脚事实；
   - 模块名从请求推导（如 "counter" → `counter`）；
   - 默认位宽 8 位（请求另有所指除外）；
   - 分频请求使用明确命名（如 `clk_div4`）；
   - 有歧义时做一个合理选择并记入 `doc/spec/behavior_spec.md`；
   - 请求涉及板级信号（LED、KEY、板载时钟、复位按钮、封装管脚等）而无已确认硬件事实（Core 登记的 `extracted_facts.json` 或用户明确板级契约，见 §2）时**不适用本路径**：不猜测板级 `top`，以需补充输入收尾，或建议回退 intake → `fpga-architecture` → `fpga-hw-manual-extraction`。
8. **多模块/协议重任务——仅在顶层端口未定义时拒绝**：架构产物已定义端口契约与子模块边界时逐模块生成；否则以需补充输入收尾，列出架构必须先定义的内容。
9. **协议时序敏感模块——契约未冻结时拒绝**：边沿语义、端口契约或相位次序未被 intake/architecture/spec 产物确认时不猜测，以需补充输入收尾并指明缺失的上游产物。

## 4. 工作流程

1. 读取架构、寄存器契约、行为规格、已有 RTL 与相关领域参考；
2. 确定最小新建/修改文件集；
3. 保持公开接口；接口变更不可避免时停止并回退架构/寄存器技能；
4. 时序逻辑显式复位行为，组合逻辑赋值完备；
5. 对齐 valid、数据、边带与流水线延迟；
6. 区分已确认事实、假设与开放问题；假设、延迟、资源敏感选择、验证挂点记入 `doc/spec/behavior_spec.md`；
7. 始终创建/更新 `doc/spec/behavior_spec.md`，使下游 TB 有明确契约；
8. RTL 源文件写到 `rtl/` 下并登记为候选修订。

### 何时生成 `rtl/top.v`

| 信号 | 判断 |
|---|---|
| 模块端口为纯内部信号，且 Core 登记的 `extracted_facts.json` 含板级信号名（`pin_map`、`clock_facts`、`electrical_facts`，每条带 `source_ref`/`evidence_kind`） | 生成 `top.v`，端口映射逐条来自已确认事实，无歧义 |
| 纯内部端口但无板级信号名 | 不生成 `top.v`；以需补充输入收尾或回退 `fpga-hw-manual-extraction` 补齐硬件事实 |
| 请求提到板级信号（LED、KEY、按钮、开关、时钟、复位） | 仅当板级端口/时钟/复位事实已确认（Core 登记的 `extracted_facts.json`，或用户明确提交且带等价可追溯字段的板级端口契约；架构接口契约单独不计）时生成 `top.v`；否则以需补充输入收尾或回退 intake → `fpga-architecture` → `fpga-hw-manual-extraction` |
| 来自 `fpga-architecture` 且产物树已有顶层定义 | 不生成新的 `top.v`，架构产物为准 |
| `rtl/top.v` 已存在 | 不覆盖 |
| 生成模块本身即为顶层设计（端口本就是板级意图） | 不再加封装层 |
| 用户聚焦单模块 TB/调试 | 不生成 `top.v` |

`top.v` 只允许组合连线：例化功能模块、连接信号；设计端口连接必须可回指 `interface_contract.yaml` 等设计契约，板级端口/时钟/复位映射必须逐条回指 Core 登记的 `extracted_facts.json`（`source_ref`/`evidence_kind` 齐备）或用户明确板级契约（带等价可追溯字段），零业务逻辑。**禁止**用接 0、上拉、分频等默认占位连接补齐无法推断的端口——任何无法回指来源的连接即硬件事实不足，不生成、不登记 `top.v`。不得与模块端口契约矛盾。

## 5. 输出产物

| 产物 | Artifact 类型 | 状态 |
|---|---|---|
| `rtl/<module>.v`（或 `.sv`） | `RTL_SOURCE_SET` | candidate |
| `doc/spec/behavior_spec.md` | `DETAILED_DESIGN` | candidate |
| `rtl/top.v`（仅硬件事实齐备时） | `RTL_SOURCE_SET` | candidate |

`behavior_spec.md` 章节（确实无关才可省略）：需求摘要、公开接口端口表（名称/方向/位宽/有效电平/描述）、参数与默认值、时钟与复位、逐周期/逐状态功能行为、时序延迟与吞吐、假设与所择默认、边界情形与错误处理、综合注记、验证计划、验收标准。

## 6. 完成闸门与证据要求

仅当以下全部成立时，候选批次才可登记为完整实现：

- RTL 含完整模块体，不是只有接口、空 `always` 块或占位连线；
- RTL 与行为规格中无 `TODO`/`FIXME`/`TBD`/`...`/stub/"待补全"/"省略"等占位语言——包括 AXI/握手/状态机中间阶段只写 `// ...` 的情形；
- FSM 逻辑闭合：无未完成状态分支，无静默省略必要赋值的分支；
- 顶层例化子模块时，所需子模块同样以真实端口映射产出，否则保持单模块；
- 产出 `top.v` 时所有端口物理连接完备（无悬空、无默认占位），顶层模块名为 `top`；每个端口映射可回指已确认来源：设计端口回指 `interface_contract.yaml`，板级端口/时钟/复位映射回指 Core 登记的 `extracted_facts.json`（每条带 `source_ref`/`evidence_kind`）或用户明确板级契约（等价可追溯字段）；架构接口契约单独不构成板级证据；**板级端口、时钟、复位、电气或物理信息缺失时不得登记板级 `top` 候选**，以需补充输入收尾或回退 intake → `fpga-architecture` → `fpga-hw-manual-extraction`；
- `behavior_spec.md` 具体 enough 供下游 TB 生成，不把关键行为推迟到后续迭代；
- 端口名、参数名、位宽、有效电平语义不与已确认契约漂移（除非显式记录理由）；
- 无目标语言明显非法构造；
- 无语义替代错误：构造必须直接表达意图语义（如不得以 `&vec` 替代 one-hot 判断、以 `a - b <= 0` 替代比较、以 `|` 归并替代逐 lane 标志组合、隐式位宽溢出算术等），完整目录见 `references/verilog_antipatterns.md`；
- 协议关键时序自洽：同一控制路径不得对同一边沿/相位决策既驱动又按矛盾方式解释。

任一不满足：真实但未完成的实现按部分实现处理；关键输入缺失按需补充输入处理。批次质量判定与重试规则见 `../../rules/00-skill-routing.md` 第 6 节。

以下信号表明应停止并回退架构/规格澄清，而非盲重试 RTL：命中协议时序敏感判定标准且边沿/相位/片选/帧规则/初始化仍属推断；端口或参数语义与已确认契约漂移；明显非法语言构造或自相矛盾的控制时序。

### AXI-Lite / 标准总线外设清单

实现 AXI-Lite、APB 或类似标准总线接口的模块必须完整实现以下全部内容（详细检查表见 `references/axi_peripheral_checklist.md`）：

- 写事务（AW → W → B）：写地址状态机及正确转移条件；`awready` 正确状态断言与清除；`wstrb` 按字节 lane 译码；`wvalid & wready` 捕获写数据；`bvalid` + `bresp=OKAY` 并等待 `bready`；
- 读事务（AR → R）：读地址状态机；`arready` 正确处理；`rvalid` 同拍驱动 `rdata` 与 `rresp=OKAY`；`rvalid` 保持稳定至 `rready`；
- 寄存器文件：每个地址偏移完整译码（`case`/`if-else`），无部分译码；每寄存器写使能脉冲；读数据 mux 按地址选源；
- 以上任何一项不得用 `// ...` 缩写或省略状态转移逻辑。

## 7. 失败处理

- 缺关键上游契约：以需补充输入收尾，指明缺失产物与建议上游技能，升级人类；
- 板级硬件事实不足（`extracted_facts.json` 未登记/非 `complete`/缺 `source_ref` 或 `evidence_kind`，且无用户明确等价板级契约）：不生成、不登记 `top.v`，以需补充输入收尾或回退 `fpga-hw-manual-extraction`；
- 批次含 stub：不登记，按规则 00 第 6 节提取 stub 清单注入补全指引后重试；
- 连续失败达上限：停止自动重试，向人类说明并建议拆解任务/补充约束/回退上游。

## 8. 交接

- RTL 完成后把 TB 生成、编译检查、仿真、约束列为可选后续任务建议；不因 RTL 完成自动继续；
- 仅当用户本轮明确要求对应阶段，或选择了前序交接中的选项时才继续。

## 9. 附带资源

- `references/synthesizable_verilog_rules.md`：可综合编码规则与常见陷阱；
- `references/rtl_integration_policy.md`：集成与修改范围策略；
- `references/verilog_antipatterns.md`：语义替代反模式目录；
- `references/axi_peripheral_checklist.md`：AXI-Lite/APB 外设完整检查表；
- `templates/`：`module.sv`、`fsm.sv`、`pipeline_stage.sv`、`assertions.sv`、`handoff_packet.md`、`rtl_notes.md`。
