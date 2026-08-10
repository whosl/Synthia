# 行为与波形规划（fpga-behavior-and-wave-plan）

| 属性 | 内容 |
|---|---|
| 技能 ID | `fpga-behavior-and-wave-plan` |
| 版本/阶段 | 0.1.0 / G2 |
| 状态 | candidate |
| 所需权限 | `read`、`candidate_write` |
| 所需能力 | 无（纯分析/规划技能，不发起 ToolRun） |
| 失败策略 | `defer_to_human` |

## 1. 用途

把需求语言转化为 RTL、TB、波形分析都能检验的规则：带规则 ID 的行为规格、FSM/事务规则/不变量、波形检查计划与首失配比对规则。适用于协议握手、状态机切换、无撕裂切换、shadow 更新、故障锁存/清除等需要前置明确预期行为的场景。

## 2. 边界

- 不在本技能实现 RTL 或 TB；
- 不强制统一格式：按设计选择 FSM 表、事务规则、不变量、时序窗口或场景表；
- 每条规则必须有可观测信号和 PASS/FAIL 条件；
- DUT 错误、TB 激励错误、期望规则错误、外部既有波形证据缺失/采样错误必须分开分类；
- 不配置 dump、不产出波形文件；已有外部波形仅作输入证据，经 Core 登记后引用。

## 3. 输入快照（按优先级）

1. `doc/intake/summary.md` 及交接章节；
2. `doc/arch/interface_contract.yaml`、`rtl/top_skeleton.sv`；
3. 存在控制面时：`doc/reg/register_map.yaml`、`doc/reg/semantics_notes.md`；
4. 诊断既有失配时：已有 RTL/TB 头部、失败仿真日志证据、外部既有 VCD/FST（仅作输入证据，经 Core 登记后引用；平台不生成波形）。

任务参数可指定聚焦模块名，用于规则命名、波形信号范围与场景命名；未提供时从 intake/architecture 产物推导，不臆造模块名。

## 4. 工作流程

1. 读取 intake、架构、寄存器契约、已有 RTL/TB 或失败仿真记录；
2. 识别外部可见事务、值得观测的内部状态、配置更新点；
3. 区分已确认事实、假设与开放问题；阻塞性事实缺失时显式记录在规格产物中，不臆造；
4. 写带规则 ID 的行为规格：复位行为、正常流程、边界情形、错误处理、恢复、非法条件；
5. 定义波形计划：信号、别名、触发事件、窗口、期望序列、最小观察/检查点范围（仅计划语义，不配置 dump、不产出波形）。有外部既有参考波形证据（经 Core 登记）时用以校验计划；没有时本计划作为 TB 构建依据；
6. 定义首失配比对规则：采样沿、容差、延迟、无关窗口、分类；
7. 写交接包：推荐下游技能与其应读取的产物路径。

注：本技能产出的 scenario_matrix 覆盖**规格级**测试场景（行为与期望信号）；`fpga-tb-write` 的 scenario_matrix 覆盖**实现级**测试用例（具体激励序列）。两者用途不同，均为必要产物。

## 5. 输出产物

| 产物 | Artifact 类型 | 状态 |
|---|---|---|
| `doc/spec/behavior_spec.md` | `DETAILED_DESIGN` | candidate |
| `doc/spec/wave_plan.yaml` | `VERIFICATION_METHOD_MAP` | candidate |
| `doc/spec/wave_compare_rules.yaml` | `VERIFICATION_METHOD_MAP` | candidate |
| `doc/spec/scenario_matrix.md` | `VERIFICATION_METHOD_MAP` | candidate |
| `doc/spec/handoff_packet.md` | `TASK_HANDOFF` | candidate |

## 6. 完成闸门与证据要求

每个关键行为都有规则 ID、触发、可观测信号、期望结果、合法容差/窗口与验证方法；下游 TB 无需重新解读需求即可实现检查器。

## 7. 失败处理

- 阻塞性事实缺失：在规格产物中显式记录开放问题并以需补充输入收尾，升级人类；
- 不允许用假设填补影响 PASS/FAIL 判定的关键行为。

## 8. 附带资源

- `references/spec_patterns.md`：规则编写模式；
- `templates/`：`behavior_spec.md`、`wave_plan.yaml`、`wave_compare_rules.yaml`、`scenario_matrix.md`、`handoff_packet.md`。
