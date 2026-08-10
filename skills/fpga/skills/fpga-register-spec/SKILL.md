# 寄存器契约生成与审计（fpga-register-spec）

| 属性 | 内容 |
|---|---|
| 技能 ID | `fpga-register-spec` |
| 版本/阶段 | 0.1.0 / G3 |
| 状态 | candidate |
| 所需权限 | `read`、`candidate_write` |
| 所需能力 | 无（纯候选生成技能，不发起 ToolRun） |
| 失败策略 | `fail_closed` |

## 1. 用途

生成软件、RTL、TB、文档共享的寄存器契约候选。适用于设计包含 AXI-Lite/APB/自定义寄存器总线、Offset、RW/RC/W1C/WO、shadow、doorbell、计数器或软件可见状态时。

## 2. 边界

- 需求只需语义寄存器时，不强制 AXI-Lite/APB 或特定总线实现；
- 不静默默认复位值、访问类型或字段优先级，缺失事实显式标记；
- 每个读写副作用必须含触发、优先级、时钟域、清除机制与验证挂点；
- 生成的 Markdown 与结构化 YAML 必须保持一致。

任务参数可提供寄存器表文件作为主事实来源（Markdown 表/CSV/YAML/JSON regmap 优先；纯文本保守解析并标记缺失）。未提供时从 intake 摘要、架构交接与已有 RTL 头部推导初始地图；不臆造偏移/复位值/访问类型。

## 3. 工作流程

1. 读取需求、架构交接、既有寄存器表、RTL 或文档；
2. 把所有寄存器归一化为结构化地图：偏移、位宽、复位值、访问类型、字段、副作用、属主时钟域；
3. 审计：地址对齐、重复偏移、保留空洞、字段重叠、复位一致性、非法访问行为；
4. 定义特殊语义：RC、W1C、W0C、WO、RO、shadow apply、doorbell、首错锁存、快照/冻结、计数器清零、软复位；
5. 写 TB 访问计划：合法读写、非法访问、字节选通、副作用检查、复位检查、CDC 可见性；
6. `doc/reg/register_map.yaml` 生成后须经验证再渲染：
   - 结构校验：`tools/regmap_validate.py`；
   - 渲染：`tools/regmap_render_md.py`。
   两个工具是确定性本地校验/渲染辅助，由 Runtime 受控环境执行，技能不直接运行脚本；校验失败先修 YAML 再重新校验与渲染。

以下信息缺失且阻塞正确性时只问最少阻塞问题：总线类型预期（AXI-Lite/APB/自定义/仅语义）、基地址与地址宽度/对齐规则、复位值/访问类型/非法访问策略、副作用触发/优先级与时钟域归属。

## 4. 输出产物

| 产物 | Artifact 类型 | 状态 |
|---|---|---|
| `doc/reg/register_map.yaml` | `DETAILED_DESIGN` | candidate |
| `doc/reg/register_map.md` | `DETAILED_DESIGN` | candidate |
| `doc/reg/semantics_notes.md` | `DETAILED_DESIGN` | candidate |
| `doc/reg/tb_access_plan.md` | `VERIFICATION_METHOD_MAP` | candidate |
| `doc/reg/handoff_packet.md` | `TASK_HANDOFF` | candidate |

## 5. 完成闸门与证据要求

每个字段具备：复位值、访问类型、位域、属主时钟域、副作用规则（触发、优先级、清除机制）、非法访问行为、验证挂点。字段跨时钟域影响硬件时，CDC 可见性规则必须显式。

## 6. 失败处理

- 结构校验不通过：不登记渲染产物，先修正 YAML（fail_closed）；
- 关键事实缺失且阻塞：以需补充输入收尾，列出最小阻塞问题集。

## 7. 附带资源

- `references/register_semantics.md`：语义与优先级规则；
- `templates/`：`register_map.yaml`、`register_map.md`、`semantics_notes.md`、`tb_access_plan.md`、`handoff_packet.md`；
- `tools/`：`regmap_validate.py`（结构校验）、`regmap_render_md.py`（渲染 Markdown），仅依赖 Python 标准库。
