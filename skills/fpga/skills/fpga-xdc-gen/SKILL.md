# 约束生成（fpga-xdc-gen）

| 属性 | 内容 |
|---|---|
| 技能 ID | `fpga-xdc-gen` |
| 版本/阶段 | 0.1.0 / G4 |
| 状态 | candidate |
| 所需权限 | `read`、`candidate_write` |
| 所需能力 | 无（纯候选生成技能；约束的综合验证属 post-mvp 未启用能力） |
| 失败策略 | `fail_closed` |

## 1. 用途

基于已确认 RTL 顶层端口与 `fpga-hw-manual-extraction` 产出的三组硬件事实，生成或更新物理约束候选（XDC/UCF/PCF/QSF/SDC 等）。适用于用户明确要求约束、管脚分配、板级 bring-up 约束，且硬件事实已提取的场景。本技能为可选步骤。

## 2. 边界

- `doc/hw/extracted_facts.json`（Core 登记的候选 ArtifactRevision）是 pin/XDC 事实的**唯一来源**，而非原始硬件文档；主约束中每条映射必须逐条回指其中的 `source_ref` 与 `evidence_kind`；
- 板卡目录 `skills/fpga/data/board-catalog.json` 只能作候选选择、上下文补全与硬件资料收集指引；其记录全部 `constraint_ready=false`，**禁止**作为 pin/XDC 事实或最终约束证据（见其 `usage_policy`）；
- 输出结构模板感知，非固定格式；
- 用户上传的约束模板用通配发现（`**/*.xdc`、`**/*.qsf`、`**/*.sdc`、`**/*.ucf`、`**/*.pcf`、`**/*.pin`），不硬编码目录；发现后按厂商、板卡系列、器件、命名模式过滤；
- **不臆造封装管脚、IO 标准、时钟、复位极性、Bank 电压或时序数值**；缺资料时按需补充输入收尾；
- 主约束按**两轴独立判定**（时钟轴与引脚/电气轴互不牵连）：
  - **时钟轴**：`clock_facts` 中主时钟有 `explicit`/`derived` 证据（`source_ref` 齐备）→ 时钟类约束内容（`create_clock`、`create_generated_clock`、`set_clock_groups`、`set_false_path` 等不承载板级物理映射事实的时序命令）可进入主约束；
  - **引脚/电气轴**：每个需要物理映射的顶层端口的 `PACKAGE_PIN` 与 `IOSTANDARD` 均有 `explicit`/`derived` 证据 → 引脚约束内容可进入主约束；任一端口缺口 → 引脚内容**整体不进入**主约束；
- 两轴均齐备 → 产出完整主约束候选（`XDC_CANDIDATE`）；
- 仅时钟轴齐备（引脚轴 `partial`/`needs_input`）→ 产出 **clock-only 主约束候选**（同路径 `prj/constr/top.xdc` 等，类型 `XDC_CANDIDATE`）：文件头必须显式声明 `timing-only / exploratory`、不含任何引脚映射、引脚未决按 NSTD-1/UCIO-1 豁免预期（对齐需求侧"XDC 至少包含时钟约束 + 引脚豁免显式声明"的处置，如 UART-DRQ-ENV-003 形态）；同时照旧产出 `pin_summary.md`（缺口）、`missing_info.md`、`handoff_packet.md`；
- 时钟轴亦缺（无 `explicit`/`derived` 时钟事实）→ 不产出任何主约束文件；`needs_input` 只写 `prj/constr/missing_info.md` 后停止，`partial` 只写 `pin_summary.md` + `missing_info.md` + `handoff_packet.md` 后停止；
- `fallback` 证据**不进入主约束**（两轴同规则），只记入缺口文档；
- 全部约束相关产物写 `prj/constr/`；
- 本技能不执行 Vivado；约束文件的综合验证（携带 XDC 的 synthesize）不在当前能力契约内，post-mvp 未启用（见 `../../rules/30-toolchain-and-tcl-boundary.md` 第 3 节）。

## 3. 输入快照（按优先级）

1. `doc/hw/extracted_facts.json`（`pin_map`、`clock_facts`、`electrical_facts`）；
2. `doc/hw/config.json`（厂商、器件、板卡名、工具链上下文）；
3. 用户上传的约束模板与硬件附件（通配发现 + 元数据/命名过滤）；
4. `doc/intake/summary.md` 交接章节；
5. `rtl/` 顶层候选源；
6. 其他硬件参考：**不直接消费**；必须先交给 `fpga-hw-manual-extraction` 提取、经 Core 登记进 `extracted_facts.json`（带 `source_ref`/`evidence_kind`）后，才能作为事实来源使用。

## 4. 模板处理

- 任何厂商默认回退之前，先用通配发现约束模板候选；
- 按厂商、板卡系列、器件、命名模式、板卡配置元数据匹配；多个命中取最具体者；
- 命中可用模板：保留其布局、命令风格、章节顺序、注释、命名约定与组织特有封装；
- 无命中：回退厂商默认生成。

## 5. 工作流程

1. 先读 `doc/hw/extracted_facts.json`（Core 登记的候选），分别评估两轴：时钟轴看 `clock_facts` 是否有 `explicit`/`derived` 主时钟事实；引脚/电气轴看每个物理端口的 `PACKAGE_PIN`/`IOSTANDARD` 是否齐备且非 `fallback`。两轴齐备产出完整主约束；仅时钟轴齐备产出 clock-only 主约束（文件头声明 timing-only/exploratory + 豁免预期）；时钟轴缺则不产主约束，按 `partial`/`needs_input` 路径写缺口文档并停止；
2. 读板卡配置确认厂商、器件、工具链；
3. 通配发现约束模板候选；
4. 读 `rtl/` 识别顶层端口与位宽；
5. **检查 RTL 顶层是否具备板级端口**：
   - 已有板级端口（LED/KEY/时钟/复位管脚）：继续步骤 6；
   - 仅内部信号但硬件事实/配置含板级信号名：写 `prj/constr/missing_top_module.md`，说明需要板级 `top` 模块桥接内部端口与板级信号，建议经 `fpga-rtl-build` 生成 `top.v`（硬件事实已备时），随后停止，不写主约束文件；
   - 仅内部信号且无板级信号名：写 `prj/constr/missing_info.md`，建议先 `fpga-hw-manual-extraction` 提取事实，再生成 `top.v`，再生成约束（自然三步顺序），随后停止，不写主约束文件；
6. 用板级信号名把 RTL 端口映射到 `pin_map` 与 `electrical_facts`；
7. 事实缺失时**不直接查证其他硬件参考**：按 `partial`/`needs_input` 路径停止，建议先将参考交给 `fpga-hw-manual-extraction` 提取并经 Core 登记进 `extracted_facts.json` 后再重新进入本技能；
8. 用已确认事实生成或适配约束文件；
9. 登记主约束文件与支撑摘要候选。

## 6. 生成规则

- 命中可用模板时适配模板，不输出固定格式文件；
- 保留不承载事实的模板内容（除非与已确认硬件事实冲突）；
- `evidence_kind` 处理：`explicit` 直接使用；`derived` 使用派生值并在 `pin_summary.md` 注明派生关系；`fallback` 或无来源缺失**不进入主约束**，记入 `missing_info.md`/`pin_summary.md` 缺口清单，整体按 `partial` 路径停止；
- 主约束文件中不得出现 `IOSTANDARD UNKNOWN`、`TODO` 或任何占位值；任何缺口一律走缺失文档路径；
- 保留板级命名，不改名为猜测的 RTL 名。

## 7. 输出位置与必备内容

- Vivado（Xilinx）：`prj/constr/top.xdc`；Quartus（Intel）：`prj/constr/top.qsf` 和/或 `top.sdc`；Tang Dynasty（Anlogic）：`prj/constr/top.xdc`；Gowin：`prj/constr/top.pin` 和/或 `top.sdc`；主约束文件在时钟轴齐备时生成（完整形态须两轴齐备；仅时钟轴齐备为 clock-only 形态）；
- 适用章节包括：`create_clock`、`create_generated_clock`、`set_input_delay`/`set_output_delay`、`set_property PACKAGE_PIN`/`IOSTANDARD`、`set_location`/`set_io`、`set_false_path`/`set_max_delay`、`set_clock_groups`；模板含组织特有封装/辅助命令/章节头时保留。

## 8. 输出产物

| 产物 | Artifact 类型 | 状态 |
|---|---|---|
| `prj/constr/top.xdc`（或厂商等价物；两轴齐备为完整形态；仅时钟轴齐备为 clock-only 形态，文件头声明 timing-only/exploratory 与 NSTD-1/UCIO-1 豁免预期） | `XDC_CANDIDATE` | candidate |
| `prj/constr/pin_summary.md` | `CONSTRAINT_DESIGN` | candidate |
| `prj/constr/handoff_packet.md` | `TASK_HANDOFF` | candidate |
| `prj/constr/missing_info.md`（needs_input / partial 时） | `OPEN_QUESTION_SET` | candidate |
| `prj/constr/missing_top_module.md`（顶层无板级端口时） | `OPEN_QUESTION_SET` | candidate |

- `pin_summary.md` 必须列出每个 RTL 顶层端口、映射管脚、IO 标准与 `source_ref`；fallback/缺失缺口显式记录；使用模板时记录命中模板与理由；
- `handoff_packet.md` 记录下一步、产物路径、模板驱动或厂商默认；交接只引用 Core 登记的候选路径与证据，不提供可复制执行的命令文本；后续工具链动作仅指向 `../../rules/30-toolchain-and-tcl-boundary.md` 第 2 节能力表（携带 XDC 的综合验证属 post-mvp 未启用）。

## 9. 完成闸门与缺失数据行为

完成判据（两轴独立判定，与 §2 一致）：完整主约束候选须两轴齐备（时钟轴：`clock_facts` 主时钟 `source_ref` 齐备且 `evidence_kind` 为 `explicit`/`derived`；引脚/电气轴：每条端口-管脚-电气映射可回指 `source_ref` 且非 `fallback`）；仅时钟轴齐备时登记 **clock-only 主约束候选**（文件头声明 timing-only/exploratory 与引脚豁免预期），引脚缺口只出现在 `missing_info.md`/`pin_summary.md`，不进入主约束；两轴中任何进入主约束的内容均不得为 `fallback` 或无来源；已确认主时钟域有对应时钟/复位约束（适用时）；命中模板时生成文件遵循模板布局与约定；输出对目标厂商工具链语法有效（语法验证属 post-mvp 能力，当前以人工评审为准）。

| 判定（时钟轴 / 引脚轴） | 行为 |
|---|---|
| 齐备 / 齐备（即 `complete`） | 生成并登记完整主约束候选 + `pin_summary.md` + `handoff_packet.md` |
| 齐备 / 缺（`partial` 或任一映射为 fallback/无来源） | 生成并登记 **clock-only 主约束候选**（timing-only/exploratory 声明 + NSTD-1/UCIO-1 豁免预期）+ `pin_summary.md`（已确认部分）+ `missing_info.md`（引脚缺口清单）+ `handoff_packet.md`（关闭路径） |
| 缺 / 任意（`needs_input` 或时钟事实全为 fallback） | 只写 `prj/constr/missing_info.md`（或 `partial` 三件套），不写任何主约束文件 |
| 顶层无板级端口 | 写 `prj/constr/missing_top_module.md`，不写主约束文件 |

停止时的后续建议按顺序给出：准备硬件信息（`fpga-hw-manual-extraction`）→ 生成板级顶层（`fpga-rtl-build`）→ 生成约束（本技能）。硬件信息已备但无顶层时只给后两项；约束生成成功时不给。

## 10. 失败处理（fail_closed）

- 事实不足：只产出缺失说明文档并停止，不生成猜测性约束；
- 模板冲突：以已确认硬件事实为准并记录冲突点；
- 产物未登记完整：按部分候选处理，不宣称完成。
