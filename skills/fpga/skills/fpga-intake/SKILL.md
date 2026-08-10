# 需求梳理（fpga-intake）

| 属性 | 内容 |
|---|---|
| 技能 ID | `fpga-intake` |
| 版本/阶段 | 0.1.0 / G1 |
| 状态 | candidate |
| 所需权限 | `read`、`candidate_write` |
| 所需能力 | 无（纯分析技能，不发起 ToolRun） |
| 失败策略 | `defer_to_human` |

## 1. 用途

把原始 FPGA/RTL/Verilog 需求澄清为一份稳定的需求梳理摘要候选，在架构、RTL、TB、约束或调试工作开始前冻结工程简报。适用于：信息不足、目标含混、验收口径不明确，或需要先判断下一步工程阶段时。

## 2. 边界

- 只产出一份面向用户的 intake 文档候选：`doc/intake/summary.md`。缺失信息、证据需求、假设、硬件依赖、下一步交接全部作为其中章节，不拆分为多个文件。
- 本技能不生成架构、RTL、TB、约束或修复补丁。
- 不臆造板卡、管脚、时钟、复位、总线、时序、吞吐、寄存器或验收事实。
- 信息足够推进暂定稿时，逐条把假设标记为 provisional 并注明确认责任人。
- 只问阻塞性问题；存在合理暂定路径时把假设记入摘要并继续。
- 若某章节无阻塞内容，简要说明即可，不堆砌与用户无关的内容。

## 3. 输入扫描

读取冻结 TaskPackage 中的用户请求及随附资料（需求、代码、日志、波形、寄存器表、板卡说明、既有项目上下文），提取：

- 任务类型：新 RTL、RTL 修改、TB 生成、编译失败、仿真失配、波形诊断、时序/约束问题、板级 bring-up、文档、合规审计；
- 功能目标：模块行为、协议、数据格式、速率、延迟、吞吐、错误处理；
- 接口：端口、总线、valid/ready 规则、包边界、寄存器、中断、存储、时钟、复位、CDC 点；
- 验证目标：场景、PASS/FAIL 标准、波形检查点、golden model、所需证据；
- 交付目标：RTL、TB、报告、约束或后续流程。

## 4. 工作流程

1. **先判定硬件依赖**。涉及约束规划、管脚映射、约束文件生成、具体时钟频率、IOSTANDARD、板载外设、bring-up、硬件调试的任务通常需要板级信息；纯 RTL 行为、无物理约束的架构、TB 生成、仿真、编译修复通常不需要。结果记入摘要 `hw_dependency: none | partial | required` 并附一句理由。
2. **仅在硬件依赖为 required/partial 时检查板卡配置**：读取 `doc/hw/config.json`（如存在），提取 `status`、`chip`、`vendor`、`toolchain`、已上传资料。配置完备且需提取约束事实时路由 `fpga-hw-manual-extraction`；配置缺失时判断是否阻塞当前任务：阻塞则写入缺失信息并以需补充输入收尾，非阻塞则记入非阻塞确认项并继续。
3. **分类并路由**：选择最窄的下一个技能（见 `../../rules/00-skill-routing.md` 第 4 节路由表）。
4. **简单任务走快速路径**：满足 `../../rules/10-intake-gate.md` 第 3 节条件时不追问，直接写摘要，临时默认值记入 `## Assumptions and Defaults`。
5. **写汇总摘要**：`doc/intake/summary.md` 必须详细到下游技能或工程师无需打开其他 intake 文件即可继续。章节顺序（文档总标题用中文，章节标题保持英文以维持下游解析兼容）：
   - `# <task> 需求梳理摘要`
   - `## Task Summary`
   - `## Confirmed Facts`
   - `## Hardware Dependency`
   - `## Assumptions and Defaults`
   - `## Missing Information`
   - `## Evidence Needed`
   - `## Acceptance Criteria`
   - `## Handoff and Next Step`

   板级约束类任务在交接章节附简短说明：约束生成通常需要带板级端口（LED、KEY、时钟、复位、UART 等）的板级顶层 `top.v`。此为信息提示，除非缺失顶层契约确实阻塞下一步，否则不作硬阻塞。

## 5. 输出产物

| 产物 | Artifact 类型 | 状态 |
|---|---|---|
| `doc/intake/summary.md` | `DEVELOPMENT_REQUIREMENTS` | candidate |
| 摘要内 Missing Information 章节 | `OPEN_QUESTION_SET` | candidate |
| 摘要内 Handoff and Next Step 章节 | `TASK_HANDOFF` | candidate |

## 6. 证据要求

- 每条 Confirmed Fact 必须可回指到 TaskPackage 输入或上传资料路径；
- 验收标准必须可通过代码评审、编译输出、仿真结果、波形证据、板级测试或文档评审观测；
- 仅当继续推进必须臆造关键事实时才以"需补充输入"收尾。

## 7. 失败处理

- 阻塞信息缺失：在 `## Missing Information` 写明最小缺失集（按优先级排序），状态按需补充输入处理，升级人类补齐；
- 摘要不足以确定下一步：提出最少澄清问题，不得直接进入实现类技能。

## 8. 交接

- 推荐的下一个技能及理由写入 `## Handoff and Next Step`；
- 下游技能把 `doc/intake/summary.md` 视为完整 intake 简报；
- 交接只形成任务建议，不自动执行后续阶段（见 `../../rules/40-post-intake-handoff.md`）。

## 9. 附带资源

- `checklists/intake_questions.md`：按任务类型组织的问题库；
- `references/requirement_patterns.md`：来自 FPGA 案例与研发需求样本的需求模式；
- `templates/intake_summary.md`：汇总摘要稳定模板。
