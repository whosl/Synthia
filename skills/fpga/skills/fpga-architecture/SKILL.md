# 架构设计（fpga-architecture）

| 属性 | 内容 |
|---|---|
| 技能 ID | `fpga-architecture` |
| 版本/阶段 | 0.1.0 / G3 |
| 状态 | candidate |
| 所需权限 | `read`、`candidate_write` |
| 所需能力 | 无（纯候选生成技能，不发起 ToolRun） |
| 失败策略 | `defer_to_human` |

## 1. 用途

在进入 RTL 之前冻结系统结构：模块拆分、接口契约、时钟复位与 CDC 策略，并产出 RTL 顶层骨架。适用于多模块系统、协议/初始化时序、板级接口或顶层边界尚未稳定的复杂任务；命中 `../../rules/00-skill-routing.md` 第 3 节协议时序敏感判定标准且关键契约未冻结时，也必须先进入本阶段。

## 2. 边界

- 只生成架构产物与 RTL 骨架候选，不实现业务逻辑。
- 不产出已实现的子模块 RTL（如滤波、复位同步、FIFO、PLL 包装、编码器逻辑或完整数据通路）。
- 不生成 `rtl/top.v`；架构阶段唯一的 RTL 文件是 `rtl/top_skeleton.sv`。
- 不改变用户已确认的端口、寄存器、时钟域或协议语义；必要变更记录为需要上游决策。
- 厂商硬核 IP、收发器、存储控制器、CPU 核、PHY、板级原语一律按黑盒处理（除非提供源码）。
- CDC 决策必须显式：控制同步、数据 FIFO、复位同步或同域证明。
- 硬件细节缺失时做保守架构假设并记入 `doc/arch/risks.md`；仅当某个选择连安全架构草稿都无法得出时才提问。

## 3. 输入快照（按优先级）

1. `doc/intake/summary.md` 及其交接章节；
2. `doc/hw/config.json`（如存在：器件、厂商、资源、IO 标准——先读）；
3. 产品需求、寄存器表、协议说明、数据手册或已有 RTL 头文件；
4. 更新场景下的既有顶层/模块文件；
5. 相关领域的架构模式参考（视频、DSP、CDC）。

新候选工作区中输出路径尚不存在，不要读取待生成的输出路径。

## 4. 默认假设

仅在用户与板卡配置都未提供更强事实时使用：

- 摄像头到显示练习默认 640x480@60Hz 作为第一目标，保证小板卡时序与存储可行；
- RGB565 摄像头输入默认 8 位 DVP 风格流、两字节拼帧，除非来源明确 MIPI/AXI/并行 16 位；
- HDMI 输出的 TMDS/串化器/厂商输出原语按黑盒处理，只定义其包装接口；
- Sobel 等 3x3 图像滤波优先纯流式 + 行缓存架构，不因分辨率、时钟差异、叠加或随机访问需求之外的原因引入 DDR/帧缓存；
- 摄像头像素钟与显示像素钟不同时，像素载荷加帧/行边带经异步 FIFO 桥接，帧级控制单独同步；
- 阈值、旁路、测试图、分辨率控制默认作为可选控制面信号，除非用户明确要求寄存器地图。

## 5. 工作流程

1. 识别顶层模块、外部接口、内部子模块、黑盒与归属边界；
2. 把架构假设与已确认需求分开记录；
3. 写 `doc/arch/interface_contract.yaml`：每个外部端口与子模块端口含方向、位宽、时钟域、复位域、协议、语义注记；
4. 写 `doc/arch/clock_reset_cdc.md`：全部时钟域、复位同步器、数据 CDC、控制 CDC 与验证证据要求；
5. 写 `doc/arch/module_partition.md`：模块表、职责归属、状态/FIFO/RAM 归属、黑盒清单；
6. 写 `doc/arch/connection_matrix.md`：生产者、信号组、消费者、协议、时钟域、延迟/反压注记；
7. 写 `rtl/top_skeleton.sv`：面向编译的顶层骨架（参数、端口、本地连线、黑盒实例），无业务逻辑；
8. 写 `doc/arch/risks.md`：假设、未决硬件事实、时序/资源风险、下游证据要求；
9. 写 `doc/arch/handoff_packet.md`：指向上述产物的简洁交接。

禁用输出路径：`doc/arch/architecture.md`、`doc/arch/cdc_strategy.md`、`doc/arch/interface_contract.md`、`rtl/top.v`、`rtl/reset_sync.v`。如需写这些路径，改写为标准七件套。

## 6. 输出产物

| 产物 | Artifact 类型 | 状态 |
|---|---|---|
| `doc/arch/interface_contract.yaml` | `ARCHITECTURE_DESIGN` | candidate |
| `doc/arch/clock_reset_cdc.md` | `ARCHITECTURE_DESIGN` | candidate |
| `doc/arch/module_partition.md` | `ARCHITECTURE_DESIGN` | candidate |
| `doc/arch/connection_matrix.md` | `ARCHITECTURE_DESIGN` | candidate |
| `rtl/top_skeleton.sv` | `RTL_SOURCE_SET` | candidate |
| `doc/arch/risks.md` | `ISSUE_RISK_DECISION` | candidate |
| `doc/arch/handoff_packet.md` | `TASK_HANDOFF` | candidate |

## 7. 完成闸门与证据要求

架构完成的判据：每个外部端口与子模块接口都有归属、时钟/复位域、协议规则和下游验证挂点；任何未决决策以开放问题显式可见，不隐藏在 RTL 注释中。

只要直接实现会导致猜测以下任一项，就必须先走架构：顶层外部端口或板级封装、子模块拆分与归属边界、协议初始化时序、CDC 方法选择或复位树归属、行缓存/帧缓存/异步 FIFO 等存储缓冲策略、黑盒 IP 包装边界、协议时序敏感控制器的边沿语义/片选生命周期/相位次序/命令响应边界。

## 8. 失败处理

- 关键契约缺失到无法形成安全架构草稿：以需补充输入收尾，列出最小缺失集，升级人类；
- 部分契约可冻结：产出部分架构候选并在 risks.md 显式列出未决项，不宣称完成。

## 9. 附带资源

- `references/clock_reset_cdc_patterns.md`：CDC 与复位决策模式；
- `references/architecture_patterns.md`：来自 FPGA 需求样本的架构模式；
- `templates/`：七件套对应模板（`interface_contract.yaml`、`clock_reset_cdc.md`、`module_partition.md`、`connection_matrix.md`、`top_skeleton.sv`、`risks.md`、`handoff_packet.md`）。
