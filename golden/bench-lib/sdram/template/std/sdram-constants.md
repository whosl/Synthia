# SDR SDRAM 控制器常量附录

- 文档编号：SDR-SDC-CONST；版本 1.0（2026-10-25）
- 与《01-开发技术要求》同等约束力。**权威性：协议语义按 SDR SDRAM 器件公开数据手册（Micron TN-46/TN-47 类）及本子题冻结口径；出入按阻塞上报。** 保险丝：TST 场景全覆盖 + 黄金侧四步双暴露
- 期望值一律由 TB 器件模型/软件参考阵列生成，本文不预置数据向量

## A.1 命令真值表（信号全部低有效）

| 命令 | sd_cs_l | sd_ras_l | sd_cas_l | sd_we_l | 地址条件 |
|---|---|---|---|---|---|
| NOP（空操作） | H | H | H | H | —（CS=H 亦为 NOP） |
| ACTIVE（行激活） | L | L | H | H | sd_ba=bank，sd_a[10:0]=row |
| READ | L | H | L | H | sd_ba=bank，sd_a[7:0]=col，sd_a[10]=0 |
| WRITE | L | H | L | L | 同 READ |
| PRECHARGE | L | L | H | L | sd_a[10]=1 全 bank 预充；=0 仅 sd_ba 指定 bank |
| AUTO REFRESH | L | L | L | H | — |
| LOAD MODE REG（MRS） | L | L | L | L | sd_a[10:0]=模式字（A.2） |
| BURST TERMINATE | L | H | H | L | **范围外**（出现即 TB 报错） |

⚠️ 转录保险丝：本表为器件手册语义转写，黄金侧四步与 TB 场景 (a) 双暴露；冲突时阻塞上报。

## A.2 模式寄存器位定义（MRS 命令时的 sd_a[10:0] / mode_set_l 写时的 hb_din[10:0]）

| 位 | 字段 | 语义 |
|---|---|---|
| 2:0 | BL 突发长度 | 000=1（**本子题冻结 1**）；001=2/010=4/011=8 为范围外值（发射路径须完整，行为不定义） |
| 3 | BT 突发类型 | 0=顺序（**冻结**）；1=交错（范围外） |
| 6:4 | CL 列潜伏期 | 010=2（**本子题冻结 2**）；011=3 范围外 |
| 9 | WBM 写突发模式 | 0=写突发长度同读（冻结 0） |
| 10,8,7 | 保留 | 写 0 |

复位默认模式字（初始化 MRS 必发）：BL=1/BT=0/CL=2/WBM=0 → **11'b00001000000 = 11'h020**（位 5=1 即 CL=2）。

## A.3 上电初始化序列（顺序冻结）

1. 复位释放：全部命令信号 NOP 态（全高），busy_l=忙
2. 上电等待：≥5000 个 sys_clk 周期（等效 100µs）内只发 NOP
3. PRECHARGE ALL（sd_a[10]=1）
4. AUTO REFRESH ≥2 次（间隔满足 A.5 tRC）
5. MRS（默认模式字 A.2）
6. tMRD（A.5）后进入就绪：busy_l 撤忙，可接受主机访问

## A.4 访问尺寸与 lane 语义（不低位对齐）

| hb_size | 宽度 | 数据通道 | DQM（低=通） |
|---|---|---|---|
| 0 | 32 位 | sd_dq[31:0] 全通道 | 4'b0000 |
| 1 | 8 位 | lane = hb_addr[1:0]：00→sd_dq[7:0]，01→[15:8]，10→[23:16]，11→[31:24] | 对应字节位 0，其余 1 |
| 2 | 16 位 | half = hb_addr[1]：0→sd_dq[15:0]，1→sd_dq[31:16] | 对应半字 0，其余 1 |
| 3 | 保留 | —— | TB 不测 |

读访问返回数据落在同语义通道；写访问写同语义通道。hb_addr[1:0] 为字内字节地址，仅用于 lane 选择，不参与行列译码。

## A.5 时序常量（50MHz，20ns/周期；周期数冻结）

| 参数 | 含义 | 周期数 |
|---|---|---|
| tRCD | ACTIVE → READ/WRITE | 2 |
| tRP | PRECHARGE → 下一 ACTIVE | 2 |
| tRAS | 行活跃最短时间（ACTIVE→PRECHARGE） | 4 |
| tRC | REFRESH/ACTIVE 周期（命令到命令） | 6 |
| tDPL | WRITE 最后数据 → PRECHARGE | 2 |
| CL | READ → 数据有效 | 2 |
| tMRD | MRS → 下一命令 | 2 |

判据口径：以上为**下限**（满足即合规，等待更长不判 FAIL）；TB 器件模型按此下限检查违规（早于下限发命令置协议违规标志）。

## A.6 自动刷新规格

- 器件：4096 行 / 64ms → 平均 15.625µs 必须完成一行刷新
- 控制器调度：AUTO REFRESH 发起间隔 **≤781 周期（均值口径）**
- 仲裁放宽：主机访问进行中可推迟，但**两次 AUTO REFRESH 命令间隔 ≤2×781=1562 周期**；超限 TB 置 REFRESH_VIOL=1（判 FAIL）
- 上电刷新次数：≥2（A.3 第 4 步）

## A.7 器件几何与地址映射（冻结）

- 2M×32（8MB）：4 bank × 2048 行 × 256 列 × 32 位
- 主机字节地址 hb_addr[22:0] 映射：
  - bank = hb_addr[22:21]
  - row = hb_addr[20:10]（11 位，ACTIVE 时经 sd_a[10:0]）
  - col = hb_addr[9:2]（8 位，READ/WRITE 时经 sd_a[7:0]）
  - hb_addr[1:0] = 字内字节（lane 选择用，A.4）

## A.8 器件与约束

- xc7k160tffg676-1；XDC clock-only：

```tcl
create_clock -period 20.000 -name clk_sys -waveform {0.000 10.000} [get_ports sys_clk]
```
