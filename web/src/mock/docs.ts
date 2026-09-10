/**
 * mock 四份中文设计文档的正文（**手写**，不是模型产出——本地没有模型后端在跑）。
 * 单独成文件是为了让 scripts/gen-mock-hashes.ts 能直接 import 它算真 SHA-256，
 * 而不是在 data.ts 里写死一串编出来的十六进制。
 */

import { VIVADO_FIXTURE } from "./vivado-fixture.ts";

const PART = VIVADO_FIXTURE.toolchain.part;

export const DOC_INTAKE = `# PWM 发生器 需求梳理摘要

## Task Summary
实现一个 8 位 PWM 发生器 \`pwm_gen\`，占空比由输入端口 \`duty\` 运行时可配，
复位低有效，使能拉低时输出恒零。目标器件 ${PART}，
时钟 100 MHz（周期 10 ns）。

## Acceptance Criteria
- A1：\`duty\` 取值 D 时，每 256 个时钟周期内 \`pwm_out\` 为高的周期数等于 D（±4 容差）。
- A2：\`rst_n\` 拉低后一个时钟内 \`pwm_out\` 归零，计数器清零。
- A3：\`en\` 为低时 \`pwm_out\` 恒为 0，且不消耗计数器状态。
- A4：综合后无 latch、无 timing violation（WNS ≥ 0）。
- A5：实现阶段 DRC 无 error，可产出比特流。

## Out of Scope
- 死区插入、互补输出、相位对齐。
- AXI/APB 寄存器接口（本轮 \`duty\` 直接由端口给出，见寄存器规格文档）。
`;

export const DOC_BEHAVIOR = `# 行为与波形规格

## Rules
- R1：\`cnt\` 在每个 \`clk\` 上升沿自增；\`cnt\` 位宽 = \`WIDTH\`，自然回绕。
- R2：\`pwm_out\` 组合于 \`cnt < duty\`，寄存一拍后输出（避免毛刺）。
- R3：\`rst_n\` 异步低有效；断言期间 \`cnt <= 0\`、\`pwm_out <= 0\`。
- R4：\`en\` 为低时 \`pwm_out <= 0\`，\`cnt\` 保持不变。

## 时序波形（duty = 64，WIDTH = 8）

\`\`\`
clk      _|‾|_|‾|_|‾|_|‾|_ …
cnt      0   1   2   3  …  63  64  65 … 255  0
pwm_out  ‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾ …  ‾‾  __  __ …  __  ‾‾
         └────── 64 拍高 ──────┘└──── 192 拍低 ────┘
\`\`\`

## 关键边界
- \`duty = 0\`：输出恒低。
- \`duty = 255\`：256 拍中 255 拍为高（不是恒高，符合 R2 的严格小于语义）。
- \`duty\` 中途变更：不做双缓冲，下一拍即生效，允许该周期占空比是过渡值。
`;

export const DOC_ARCH = `# 架构设计

## Modules
- \`pwm_gen\`：唯一模块，即顶层。参数 \`WIDTH\`（默认 8）。

## Ports
| 方向 | 名称 | 位宽 | 说明 |
| --- | --- | --- | --- |
| in | \`clk\` | 1 | 100 MHz 系统时钟 |
| in | \`rst_n\` | 1 | 异步复位，低有效 |
| in | \`en\` | 1 | 使能，低时输出恒零 |
| in | \`duty\` | \`WIDTH\` | 占空比阈值 |
| out | \`pwm_out\` | 1 | PWM 输出，寄存器输出 |

## 内部结构
单一 \`always @(posedge clk or negedge rst_n)\` 时序块，内含一个 \`WIDTH\` 位自由运行
计数器与一级输出寄存器。无跨时钟域、无存储器、无 DSP。

## 约束
\`create_clock -period 10.000\`。本轮为 smoke 验证，不绑定物理引脚，
因此在 XDC 中显式把 \`NSTD-1\`/\`UCIO-1\` 降级为 Warning，否则 \`write_bitstream\`
会被 DRC 挡下（这是 Vivado 的既定行为，不是设计缺陷）。
`;

export const DOC_REG = `# 寄存器规格

本轮 \`pwm_gen\` **不含软件可访问寄存器**：\`duty\` 与 \`en\` 均为硬件端口，由上层
模块或顶层引脚直接驱动。

| 地址 | 名称 | 说明 |
| --- | --- | --- |
| — | — | 无 |

## 后续演进（不在本轮范围）
若要挂总线，建议 offset 0x00 放 \`CTRL\`（bit0 = en），offset 0x04 放 \`DUTY\`
（低 \`WIDTH\` 位），并对 \`DUTY\` 做写-影子寄存器 + 周期边界更新，以消除
行为规格中提到的过渡周期。
`;

