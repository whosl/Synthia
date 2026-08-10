# FPGA 需求入口后交接规则

| 属性 | 内容 |
|---|---|
| 规则编号 | SYNTHIA-FPGA-RULE-40 |
| 版本/状态 | v0.1 / candidate |
| 适用对象 | `fpga-intake` 完成后的阶段交接 |

如果本回合已经执行过 `fpga-intake`：

- 不要在同一流程中绕过技能直接生成/修改 RTL 或 TB 候选，也不要直接发起工具运行。
- 必须根据 intake 摘要中的交接章节选择下一步技能：
  - 下一步依赖模块拆分、顶层边界、协议初始化时序、CDC/复位策略、板级接口封装、黑盒 IP 包装或存储架构选择：优先 `fpga-architecture`；
  - RTL 实现或改动：仅当接口边界、模块职责、初始化/CDC/缓存策略已经稳定时，`fpga-rtl-build`；
  - TB 源码生成：`fpga-tb-write`；
  - 编译检查：`fpga-compile-and-repair`；
  - 仿真运行：`fpga-sim-run`。
- 若 RTL 阶段暴露出协议时序敏感契约未冻结问题（端口/参数语义漂移、launch/sample 边沿不明确、相位次序自相矛盾、片选生命周期或命令/响应边界靠猜测补全），不要在同层盲重试 `fpga-rtl-build`；回退到 `fpga-architecture` 或补行为规格后再交接。
- 不要把交接建议中的推荐阶段全部自动执行：只执行用户本轮明确要求的阶段；其余阶段作为可选后续任务建议（workflow options）写入交接产物，由用户或 Workflow Engine 显式选择。
- 若交接信息不足以确定下一步：补充最少澄清问题，或再次走 `fpga-intake` 更新摘要候选。
