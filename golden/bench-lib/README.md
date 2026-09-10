# FPGA 黄金模板基准库（bench-lib）

- 归库日期：2026-09-09
- 用途：测试 Synthia 的收敛能力 —— 每个模板 = **需求文档（隐实现）+ 参考实现 RTL**，跑 p 系列盲测
- 体量原因不进 git（104MB）；原始克隆保留在 `~/dev/fpga-golden-lib/`（含 .git 可追溯上游）

## 主 Agent 任务书（意图与做法）

### 意图

用这些真实复杂设计构建黄金模板：**从公开规范/文档提炼一份"开发技术要求"（DRQ 编号条目，隐去一切实现细节），把参考 RTL 作为 golden 基线**，然后按 p5-p10 的盲测协议让 Synthia 从需求独立生成，对比收敛轮数、四步通过率、资源/时序差距。UART 系列已证明该方法的区分度（同模型在诊断链修复前后 7 轮不收敛 → 5 轮收敛）；本库把难度阶梯从 ~400 行拉到 10 万行。

### 每个模板的制作步骤

1. **提炼需求文档**：`doc/01-开发技术要求.md`，格式照抄 `golden/uart/docs/01-*.md`（范围/引用文件/功能/性能/接口/器件/环境/可靠性/测试/交付/开放问题，DRQ 编号）。素材来源见各设计 BENCH-CARD 的"需求来源"栏。**红线：不得把参考 RTL 的结构信息写进需求**（模块划分、状态机形态、流水线级数都属于实现）。
2. **登记参考实现**：参考 RTL 入工作区并登记哈希（作为 p3 型"人工基线"），跑四步验证拿到 golden 指标（WNS/LUT/FF/通过场景）。
3. **盲测**：新项目只种入需求文档，用 p 系列协议（见下）。
4. **对比报告**：进 `specs/research/`，沿用 p5-p10 的度量口径。

### 盲测协议（已在 p5-p10 验证）

- 项目 `free` 类型，part `xc7k70tfbv676-1`，输入仅 `doc/01-开发技术要求.md`（哈希固定）
- 指令模板：p5 的盲测 objective（禁读项目外目录/golden/历史；candidate 登记；fail-closed；不替人批门禁）
- 环境：`sh deploy/supervise/dev-up.sh`（Core 5130 / Runtime 8791 / Web 5180；worker 66 = Vivado 2021.1）
- 模型：GLM-4.6 经智谱 Anthropic 端点，`CHAT_MAX_TOKENS=65536`（thinking 计入预算，16k/32k 会空回复——已修 nudge 守卫，但预算别降）
- 修复循环依赖 `failureDiagnostics.logDigest`（H2/H4 修复后 VRFC/断言直达模型）；XDC 走两轴闸门（clock-only 合规形态）
- 中途不干预；只修平台故障（参考 harness-fix-traceability.md 的消融矩阵判断哪些是平台问题）

## 难度阶梯与起跑顺序

| 梯队 | 设计 | 起跑建议 |
|---|---|---|
| T1 验证流程 | aes_core → sha3 → des | 先把模板制作流程在 aes 上完整走一遍 |
| T2 标准压力 | i2c → can → vga_lcd → dspfilters → picorv32 | 寄存器接口类（can）与 CPU 类（picorv32）分开对比 |
| T3 收敛极限 | jpegencode → usbhostslave → openmsp430 → fpganes | 预期 Synthia 无法一次收敛——此时**测量差距形态**（哪类需求缺失/错误最多）比通过率更有价值 |
| 竞赛对照 | vdf-fpga | 规格书天然严谨；另见 FPL'26 Agentic 竞赛（与参数寻优方案同域）|

注意事项：
- openmsp430 / usbhostslave / fpganes 的厂商原语在 FPGA 移植层（BENCH-CARD 已标注文件），核心 RTL 纯净；做模板时**剥掉板级封装**，需求按核心定义
- 大设计（>10k 行）sim 时长会显著拉长（XSIM_RUNTIME_CAP 限制要评估）；openmsp430 建议裁剪外设子集出题
- 参考实现的 bench 目录多有测试向量（aes/des/can/picorv32），交叉验证时用；但盲测 TB 必须模型自写
