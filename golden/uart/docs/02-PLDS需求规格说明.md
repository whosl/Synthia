# UART 收发器 PLDS 需求规格说明

| 属性 | 内容 |
|---|---|
| 文档编号 | UART-DOC-002 |
| 制品类型 | PLDS_SRS（见 ARTIFACT-CONTRACTS §4.2） |
| 版本/状态 | v1.2 / candidate（未经人工批准） |
| 候选拟制 | Agent 辅助生成，已进行技术整改 |
| 待审核 | PLDS 设计、验证角色 |
| 待批准 | PLDS 设计负责人 |
| 修订日期 | 2026-08-26 |
| 上游 | UART-DOC-001《开发技术要求》v1.2 candidate |
| 下游 | UART-DOC-003《结构设计说明》、UART-DOC-004《详细设计说明》、UART-DOC-005《测试计划与说明》、UART-DOC-006《追踪矩阵》 |

## 1. 范围

### 1.1 标识

- PLDS 名称：UART 收发器（uart_top）
- 项目标识：GOLDEN-UART
- 目标器件：xc7k70tfbv676-1
- 本文档对应黄金流程 G2 阶段（GOLDEN-FLOW-SPEC §5.3）

### 1.2 PLDS 概述

UART 收发器 PLDS 在单一 100 MHz 时钟域内实现 9600 8N1 全双工异步串行收发。发送通道由 `uart_tx`（内含波特率节拍发生器 `baud_gen`）将并行字节转换为 8N1 串行帧输出至 txd；接收通道 `uart_rx` 对 rxd 做两级同步，以同步后下降沿检测起始位，再经半位偏移在每位中点采样，恢复并行字节并指示帧错误。位时基准由参数化分频产生（每帧/每位以系统时钟计数，无独立过采样时钟）。

### 1.3 需求编号规则

需求编号格式为 `UART-SRS-<域>-<序号>`，域取值：FUN（功能）、IF（接口）、CKR（时钟复位）、TIM（时序）、RES（资源）、REL（可靠性）、TST（测试性）。编号在项目内唯一且不可复用（TRACEABILITY-DATA-MODEL §4）。每条需求给出来源（`derived_from`）和验证方法（方法到用例/活动的映射详见 UART-DOC-005 §3）。

### 1.4 基线

本文档 v1.2 仅是 G2 候选输入。它尚未经过冻结快照检查和授权人类批准，不属于批准阶段结果，也未纳入 B1。

## 2. 引用文件

同 UART-DOC-001 §2。

## 3. 需求

### 3.1 功能需求

| 编号 | 需求文本 | 来源 | 验证方法 |
|---|---|---|---|
| UART-SRS-FUN-001 | 当 tx_start 输入出现单时钟周期高脉冲且发送通道空闲（处于 IDLE）时，发送通道应锁存 tx_data 并开始发送一帧 8N1 串行数据。 | UART-DRQ-FUN-001、UART-DRQ-IF-001 | 仿真 |
| UART-SRS-FUN-002 | 发送帧格式应为：1 位起始位（低电平）、8 位数据位（LSB 先发）、1 位停止位（高电平）；发送期间 tx_busy 保持高电平；停止位发送完成当拍产生单时钟周期 tx_done 脉冲并将 tx_busy 拉低。 | UART-DRQ-FUN-002 | 仿真 |
| UART-SRS-FUN-003 | 发送进行中出现的 tx_start 脉冲应被忽略，不得打断正在进行的帧发送（tx_start 仅在 IDLE 状态被采样）。 | UART-DRQ-IF-001 | 审查 |
| UART-SRS-FUN-004 | 接收通道应对同步后的 rxd（rxd_sync）进行起始位检测：在 IDLE 检测到 `rxd_sync_d=1 && rxd_sync=0` 的同步后下降沿后，计数半位时间到达起始位中点再次采样；若仍为低电平则确认起始位有效，否则判定为假起始位（毛刺）并返回 IDLE。持续低电平不得被重复判定为新起始位。 | UART-DRQ-FUN-003、UART-DRQ-REL-003 | 审查、分析、仿真（旁证） |
| UART-SRS-FUN-005 | 接收通道应在每个数据位的中点采样（起始位中点确认后每隔一个整位时间采样一次），共采样 8 位，LSB 先收，组成接收字节。 | UART-DRQ-FUN-003 | 仿真 |
| UART-SRS-FUN-006 | 接收通道应在停止位中点校验帧：采样为高电平时，当拍将接收字节更新至 rx_data 并产生单时钟周期 rx_done 脉冲；采样为低电平时，仅产生单时钟周期 frame_err 脉冲，不得更新 rx_data，也不得产生 rx_done。rx_done 表示有效字节，frame_err 表示被丢弃的错误帧，二者互斥。 | UART-DRQ-FUN-003、UART-DRQ-FUN-004、UART-DRQ-IF-002 | 仿真、审查 |
| UART-SRS-FUN-007 | 无论停止位校验结果如何，接收通道均应在帧完成当拍返回 IDLE，不得死锁；坏停止位后线路持续为低时不得误触发新帧，线路先恢复高电平后才可由下一次同步后下降沿开始接收。 | UART-DRQ-FUN-004、UART-DRQ-REL-003 | 审查、仿真 |
| UART-SRS-FUN-008 | 发送通道与接收通道应相互独立，允许同时发送和接收不同字节（全双工）。 | UART-DRQ-FUN-001 | 仿真（独立 TX/RX 激励） |
| UART-SRS-FUN-009 | 串行线路空闲及复位状态下 txd 应输出高电平；rxd_sync 复位值为高电平（线路空闲），复位后接收通道保持空闲监视。 | UART-DRQ-FUN-005 | 仿真、审查 |

### 3.2 接口需求

| 编号 | 需求文本 | 来源 | 验证方法 |
|---|---|---|---|
| UART-SRS-IF-001 | PLDS 顶层端口应恰好包括：clk（时钟输入）、rst（复位输入，同步高有效）、tx_start、tx_data[7:0]、txd、tx_busy、tx_done、rxd、rx_data[7:0]、rx_done、frame_err。端口方向、位宽与极性以结构设计说明（UART-DOC-003 §4）为准。 | UART-DRQ-IF-001、UART-DRQ-IF-002、UART-DRQ-IF-003、UART-DRQ-IF-004 | 审查 |
| UART-SRS-IF-002 | tx_start 为电平采样型启动信号，仅在发送通道 IDLE 状态的时钟上升沿被采样；外部逻辑应保证其至少维持一个时钟周期。tx_done、rx_done、frame_err 均为单时钟周期脉冲，外部逻辑应在脉冲当拍捕获。 | UART-DRQ-IF-001、UART-DRQ-IF-002 | 审查、仿真 |
| UART-SRS-IF-003 | 串行数据位序为 LSB 先发/先收；txd/rxd 电平标准与引脚分配由 XDC 板级约束定义（未决板级项，见 UART-DOC-001 §11）。 | UART-DRQ-IF-003 | 审查 |

### 3.3 时钟与复位需求

| 编号 | 需求文本 | 来源 | 验证方法 |
|---|---|---|---|
| UART-SRS-CKR-001 | PLDS 内部应为单一时钟域，全部时序逻辑使用 clk 上升沿；标称频率 100 MHz。 | UART-DRQ-PERF-002 | 静态检查、STA |
| UART-SRS-CKR-002 | 复位 rst 为同步、高有效，在 clk 上升沿采样；复位期间全部状态寄存器和输出应处于确定初始值：state=IDLE，txd=1，tx_busy=0，tx_done=0，rx_data=8'h00，rx_done=0，frame_err=0，rxd_meta=1，rxd_sync=1，rxd_sync_d=1，各计数器=0。 | UART-DRQ-IF-004、UART-DRQ-REL-002 | 仿真、审查 |
| UART-SRS-CKR-003 | rxd 为异步输入，进入功能逻辑前应依次经过 `rxd_meta`、`rxd_sync` 两级寄存器，两级均标记 `ASYNC_REG=TRUE` 且复位为高；状态机不得直接使用 rxd 或 rxd_meta。`rxd_sync_d` 仅保存同步后信号的历史值用于下降沿检测，不属于 CDC 同步级，也不得标记为 ASYNC_REG。tx_start、tx_data 按同步输入处理，由外部接口集成负责保证。 | UART-DRQ-REL-001 | 审查、静态检查（CDC） |

### 3.4 时序需求

| 编号 | 需求文本 | 来源 | 验证方法 |
|---|---|---|---|
| UART-SRS-TIM-001 | 位时基准由 `CLKS_PER_BIT = CLK_FREQ / BAUD_RATE`（整数向下取整）产生；默认参数下 CLKS_PER_BIT=10416、位时间 104.16 µs、实际波特率约 9600.61 bit/s、相对误差约 +0.0064%，满足 ±0.5%。选择向下取整同时为 960 byte/s 最低吞吐要求保留确定余量。 | UART-DRQ-PERF-001、UART-DRQ-PERF-002 | 分析、仿真 |
| UART-SRS-TIM-002 | 发送每一位应保持 CLKS_PER_BIT 个时钟周期；baud_tick 应作为同拍组合使能被发送状态机消费，不得因注册 tick 引入额外周期。连续控制下相邻帧起始沿间隔应不大于 1,041,666 ns。 | UART-DRQ-PERF-001、UART-DRQ-PERF-003 | 分析、仿真 |
| UART-SRS-TIM-003 | 在对端相对标称波特率偏差 +2% 和 −2% 两个端点，接收通道均应正确接收且不报告帧错误；至少以独立外部串行激励动态验证。 | UART-DRQ-PERF-001 | 分析、仿真 |
| UART-SRS-TIM-004 | 设计应在 xc7k70tfbv676-1 上以 ≥100 MHz 收敛时序；组合逻辑级数应保持最小（计数器比较 + 状态译码级别）。 | UART-DRQ-PERF-002、UART-DRQ-DEV-001 | 分析、STA |

### 3.5 资源需求

| 编号 | 需求文本 | 来源 | 验证方法 |
|---|---|---|---|
| UART-SRS-RES-001 | 资源预算：触发器 ≤ 200，LUT ≤ 300；不使用 Block RAM、DSP、MMCM/PLL 等硬核资源。 | UART-DRQ-DEV-001、UART-DRQ-DEV-002 | 综合报告审查 |

### 3.6 可靠性与异常需求

| 编号 | 需求文本 | 来源 | 验证方法 |
|---|---|---|---|
| UART-SRS-REL-001 | 发送与接收状态机均应包含 default 分支：进入任何非法状态时，下一时钟回到 IDLE，不得死锁。 | UART-DRQ-REL-002、UART-DRQ-REL-003 | 审查 |
| UART-SRS-REL-002 | frame_err 为单时钟周期脉冲，不应锁存；其有效时 rx_done 必须为低且 rx_data 保持不变。帧错误仅丢弃当前帧，不得影响线路恢复高电平后的后续帧接收。 | UART-DRQ-FUN-004 | 审查、仿真 |
| UART-SRS-REL-003 | 收发过程中施加复位时，状态机应在下一时钟沿回到初始状态，txd 恢复空闲高电平；复位释放后可正常收发。 | UART-DRQ-REL-002 | 审查、仿真 |

### 3.7 测试性需求

| 编号 | 需求文本 | 来源 | 验证方法 |
|---|---|---|---|
| UART-SRS-TST-001 | PLDS 应支持 txd 直连 rxd 的环回仿真验证，无需额外测试逻辑。 | UART-DRQ-TST-002 | 仿真 |
| UART-SRS-TST-002 | 时钟频率与波特率参数（CLK_FREQ、BAUD_RATE）应通过 Verilog parameter 可配置，CLKS_PER_BIT 应由参数表达式自动生成，便于适配其他时钟/波特率组合。 | UART-DRQ-PERF-002、UART-DRQ-TST-001 | 审查、仿真 |

## 4. 合格性规定

每条需求的验证方法见 §3 各表"验证方法"列；验证方法到测试用例/审查分析活动的完整映射、通过准则见 UART-DOC-005《测试计划与说明》；需求—设计—RTL—测试的双向追踪见 UART-DOC-006《追踪矩阵》。

## 5. 需求可追踪性

- 正向：每条 UART-SRS 需求在 §3 中注明 `derived_from` 来源（UART-DRQ）；无孤立需求。
- 反向：UART-DRQ 到 UART-SRS 的完整分配见 UART-DOC-006 §2；无未分配系统需求。
- 派生需求：本版本无派生需求（DERIVED_REQUIREMENT_SET 为空）。

## 6. 注释

无。
