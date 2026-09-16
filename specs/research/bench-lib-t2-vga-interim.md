# Synthia vs 手工参考 — bench-lib T2·vga_lcd 中期报告（黄金侧收官 / 盲测在途）

- 日期：2026-09-15（黄金侧 2026-09-11 收官；盲测侧进行中）
- 数据：p21（黄金基线，FreeCores vga_lcd 手写参考经平台四步）与 p22（盲测，用户消息式需求投递），同 part xc7k70tfbv676-1、同 worker 66 Vivado 2021.1、同一份需求文档 v1.0（131 行，哈希固定）
- 状态注记：盲测侧 simulate 未收敛（errors=4），本报告的质量对比为**手工参考侧完整数值 + 盲测侧过程信号**；终版对比待 p22 四步落定

## 1. 复杂度画像

| 维度 | 数值 |
|---|---|
| 手工参考（FreeCores vga_lcd，冻结于 p21） | **4,900 行 RTL**（15 文件：WB 主/从 460/465、pgen 585、colproc 505、dpram/spram 512/407、curproc 309、双 FIFO 253+228、vtim/csm/tgen/clkgen/cur_cregs ~700）——全功能：硬件光标、CLUT、地址发生器、双时钟域 FIFO |
| 需求文档（唯一输入） | 131 行（8×32b 寄存器契约 + VESA 640×480 数值进 TST + PERF-003 预算）——**刻意裁剪的功能子集** |
| 黄金封装 + 自检 TB | 395 + 442 行（agent 产出，(a)-(j) 十场景） |
| 盲测独立实现 | **805 行 RTL**（fetch 251 / regs 240 / timing 159 / top 155）+ 694 行 TB |

对照口径警示：参考 4,900 行是"全家桶"（光标/CLUT/双 FIFO 全在），盲测 805 行是需求子集的直接映射——**行数差是功能域差，不是质量差**；质量对比只看物理指标与场景通过率。

## 2. 手工参考基线（p21，四步全绿）

| 指标 | 参考实测 | 预算（PERF-003） | 占用 |
|---|---|---|---|
| WNS | **+2.389 ns**（TNS 0，WHS +0.059） | ≥0（时序收敛） | 满足 |
| Slice LUTs | **643** | ≤ 10000 | 6.4% |
| Slice Registers | **543** | ≤ 6000 | 9.1% |
| BRAM | **0** | ≤ 16（行缓冲） | 0% |
| DSPs | **1** | **不用 DSP** | **参考自身越预算** |

注：手工参考自己映射了 1 个 DSP，与 PERF-003"不用 DSP"相抵——需求侧预算与参考实际综合行为存在分歧，属黄金侧应当拦截的需求级缺陷（本次由操作者提取指标时发现；会话未能自取，见 §5）。盲测侧预算仍按文档原文执行。

黄金侧轨迹：staging 09-10 22:19 → 四步全绿 09-11 02:47，**≈ 4.5 小时无人值守**（封装 v1→v6、TB v1→v4，两次失败 job 各一步收敛：FIX-5 RTL / FIX-T2 TB）。

## 3. 盲测侧现状（p22，进行中）

- 发车 09-14 09:50（用户消息式 5 段投递），至本报告 **≈ 25 小时**、10 个用户轮、177 条会话消息
- validate ✅；simulate **13 次失败未收敛**，当前 errors=4（c_vtim + d_8/16/24bpp）
- 过程质量信号（正面）：需求复述保真；自建探针走 WARNING 通道绕开 digest 盲区（H15 适应）；用探针数据完成三场景互证并把嫌疑从 timing 计数收敛到 fetch 欠载/ping-pong 身份（推理链自建，无外部线索）；触发停止规则后诚实请示
- 平台故障税（已入台账）：worker 楔死致提交超时 ×2、evidence 通道内存丢失（操作者两度 SSH 直取磁盘原件转发）、H15 digest 盲区迫使探针化

## 4. 效率（中期口径）

- 黄金侧（参考封装+验证）：4.5h 无人值守
- 盲测侧：25h+ 未收敛——慢于 T1 全部三件（AES/SHA3/DES 盲测均四步绿），主因两分：**平台故障税**（上述）与**显示类时序闭环的固有难度**（帧级场景的期望值构造比密码 KAT 复杂一个量级）
- "实现时间缩短"的终值待 p22 收敛后计算；本中期不虚算

## 5. 会话读文件被 Core 拒绝——根因（三道闸门串联）

会话自取三件套失败（baseline-summary 记录 8 次尝试全拒）的完整链路：

1. **RULE-25 路径校验**（`core/src/workspace/paths.ts:77`）：workspace 读只接受 `rtl/tb/sim/doc/prj/constr` 下的相对路径。tool run 结果里悬挂的证据 URI 是 `workspace://job-…/output/sta.rpt` 形态——不是 workspace 相对路径 → `WORKSPACE_PATH_INVALID`（"invalid workspace path"）
2. **主会话授权域**（`core/src/api/task-proxy.ts:755`）：`MAIN_AUTHORIZATION_SCOPE.read_paths = ["rtl/**","tb/**","doc/**","prj/constr/**"]`——即使过了 RULE-25，`sim/**`（设计上放证据引用的目录）也不在 read_paths 内 → "不在 read_paths"。**设计文档（paths.ts:62 注释"sim/ 下的东西是证据…只留相对路径引用"）与授权域自相矛盾**
3. **证据 API 不是会话工具**：`GET /jobs/:jobId/evidence(/content)` 存在（router.ts:829-856）但只面向 REST/admin 面；会话工具面没有任何证据读取工具。且该通道路由到 worker **内存** job 表（H25）——worker 重启即 `connector: JOB_NOT_FOUND`（本报告取数时两次实证）

修复方向：① 给会话工具面加 evidence-fetch（走 Core dispatcher，配 `evidence/freeze` 落盘解决 H25）；② `sim/**` 进 read_paths 对齐设计意图；③ UI 证据查看器（H27 已移交 web 线）。

## 6. 台账增量

- H29（拟）：黄金指标提取断链——黄金会话物理指标全靠操作者代取（本次 WNS/LUT/FF 即 SSH 直取磁盘原件）；系 §5 三道闸门的直接后果
- 需求勘误候选：PERF-003"不用 DSP" vs 参考实测 1 DSP（等盲测收敛后统一裁定是否出 v1.1）
