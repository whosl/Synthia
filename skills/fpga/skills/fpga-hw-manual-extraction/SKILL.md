# 硬件信息提取（fpga-hw-manual-extraction）

| 属性 | 内容 |
|---|---|
| 技能 ID | `fpga-hw-manual-extraction` |
| 版本/阶段 | 0.1.0 / G1 |
| 状态 | candidate |
| 所需权限 | `read`、`candidate_write` |
| 所需能力 | 无（纯分析技能，不发起 ToolRun） |
| 失败策略 | `fail_closed` |

## 1. 用途

从板卡手册、原理图、管脚表、参考约束中只提取当前 FPGA 任务所需的板级硬件事实，产出 `doc/hw/extracted_facts.json` 候选（必要时附 `doc/hw/extracted_facts.missing.md`）。适用于约束生成、板级 bring-up 或接口验证需要可信管脚/时钟/IOSTANDARD 证据时。

不适用于：不依赖板级硬件事实的纯 RTL 行为设计、协议设计、TB 生成、编译修复。

## 2. 边界

- 只提取事实，不生成最终 XDC/UCF/PCF/QSF/SDC；
- 提取范围限定为用户当前硬件相关任务；
- 不改写 `doc/hw/config.json`；
- 必需事实不齐：写 `extracted_facts.missing.md`，`status: partial`；
- 任务范围本身歧义：`status: needs_input`，只问缺失的范围定义。

## 3. 必需事实组

范围内每个信号都必须评估三组事实：

1. **`pin_map`**：板级信号到封装管脚的映射；未确认即标记缺失，不猜测；
2. **`clock_facts`**：每个必需时钟的频率与管脚关联；仅在关系显式时允许派生值（如由频率推周期）；
3. **`electrical_facts`**：优先显式 `io_standard`；只有 bank/接口电压等电气证据时记录证据本身，不臆造 IOSTANDARD。

### 不可协商规则

- 不写来源材料未确认的管脚号；
- 不写来源中不存在的时钟频率（即使看起来是惯例）；
- 不写来源未显式给出的 IOSTANDARD；
- 不把板级信号名改写成猜测的 RTL 端口名；
- 事实不可用时记录缺口并保持 `status: partial`。

## 4. 范围选择与输入

范围判定优先级：用户当前消息显式请求 → 用户显式提供的硬件文件/路径 → 既有 `doc/intake/summary.md` → 既有 `extracted_facts.json`（同范围保留已确认事实）→ 其他明确缩小硬件目标的项目上下文。无关硬件范围之间歧义时以 needs_input 停止。

输入优先级：用户提供的硬件参考（手册/数据手册 PDF、原理图、管脚表 CSV/Excel/Markdown、参考约束文件）→ `doc/hw/` 下既有资料 → intake 摘要 → 既有 `extracted_facts.json` → `doc/hw/config.json`（仅背景，不作输出目标）。来源优先级与字段归一化细节见 `references.md`。

## 5. 工作流程

1. 读取用户请求，识别具体硬件相关任务；
2. 推断范围内信号及各自适用的事实组；
3. `extracted_facts.json` 已存在时先读，保留已确认事实（除非更强证据矛盾）；
4. 按置信度排列硬件来源；
5. 定位相关章节、表格或参考片段；
6. 只提取并归一化当前任务所需事实；
7. 板级信号名保持来源原样；
8. 每条事实记录 `source_ref`；
9. 登记 `doc/hw/extracted_facts.json` 候选；
10. 任一范围内信号缺必需事实组：写 `extracted_facts.missing.md`，`status: partial`；
11. 全部范围内信号事实齐备：`status: complete`。

## 6. 输出契约

`extracted_facts.json` 至少含以下三节（允许附加字段）：

- `pin_map`：`{signal, package_pin, source_ref}`；
- `clock_facts`：`{signal, frequency_mhz 或 period_ns（至少其一）, package_pin（可得时）, source_ref}`；
- `electrical_facts`：`{signal, io_standard（仅显式时）, bank_voltage/interface_voltage/interface_type（回退字段）, evidence_kind: explicit|derived|fallback, source_ref}`。

状态规则：`complete` 仅当每个范围内信号三组事实齐备；任一缺失为 `partial`；范围无法安全确定为 `needs_input`。绝不用惯例或推断替代不可用事实。

## 7. 输出产物

| 产物 | Artifact 类型 | 状态 |
|---|---|---|
| `doc/hw/extracted_facts.json` | `PROJECT_PROFILE` | candidate |
| `doc/hw/extracted_facts.missing.md`（有缺口时） | `OPEN_QUESTION_SET` | candidate |

## 8. 交接与板级顶层缺口提示

- 提取完成：下游约束生成可消费 `extracted_facts.json` + RTL + 用户约束模板；
- 有缺失：停在 `extracted_facts.missing.md`，只问阻塞性参考资料；
- XDC 把**板级信号**映射到物理管脚，因此需要端口与 `extracted_facts.json` 信号名一致的板级顶层 `top.v`。常见缺口（本技能不检测）：RTL 已可编译仿真，但顶层端口是内部总线信号而非板级信号。此时 `extracted_facts.json` 可为 `complete`，项目仍不能生成可用约束。写 `extracted_facts.missing.md` 时若发现该情况，在独立"板级顶层缺口"标题下加软提示（信息性，不改变 status、不阻塞提取完成）：说明需要板级顶层模块，可经 `fpga-rtl-build`（板级信号已知时）或 `fpga-architecture`（需规划顶层结构）生成。

## 9. 失败处理（fail_closed）

- 范围歧义：needs_input，只问范围定义；
- 事实缺失：partial + missing 文档，不按惯例补值。

## 10. 附带资源

- `references.md`：来源优先级、字段归一化、下游消费者注记。
