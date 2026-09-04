# Synthia (GLM-4.6) vs Golden 人工基线 — 同需求盲测对比（p5 vs p3/p2）

> **v2 更新（2026-09-04）**：诊断链修复（log-digest）后新增 p6 全新盲测，仿真收敛、全场景 PASS。
> 三方对比见 §5；§1–§4 保留 p5 原始实验记录作为"诊断链缺陷"对照。

- 日期：2026-09-03/04
- 实验性质：exploratory 质量评估，非正式放行
- 输入控制：p5/p6 与 p2 使用逐字节相同的需求输入 `doc/01-开发技术要求.md`（SHA-256 `55435408…f11ef`，入库双向核验）；p3 为冻结人工 Golden 基线（同源需求）
- 工具链控制：同一 worker 66（Vivado 2021.1，xc7k70tfbv676-1），同一 mTLS Connector 通道，同一 Core 治理
- 模型：GLM-4.6（智谱 open.bigmodel.cn Anthropic 兼容端点，`pi-anthropic-model.ts` 适配器，`pi-agent/1.0` 请求头），thinking 默认开启

## 1. 总览

| 维度 | p3 人工 Golden | p5 Synthia+GLM 盲测 | p2 此前 Synthia 评估（参考） |
|---|---|---|---|
| RTL 文件 / 行数 | 4 文件 320 行（含 baud_gen） | 4 文件 397 行（分频内联在 top） | 5 文件 471 行 |
| Testbench | 1 件 104 行 | 2 件 560 行（10 场景 + 冒烟） | 1 件 301 行 |
| XDC 处理 | 26 行，时钟约束 + DRC 豁免声明 | 28 行，时钟约束 + 逐条 DRQ 引用的 fail-closed 声明 | 18 行 |
| 生成文档 | —（基线验证任务，不产文档） | 13 件（intake/arch/spec/compile/最终报告），44 次登记修订 | — |
| validate_sources | 5/5 通过 | 2 次 1 过（首轮 `.vh` 语言被拒→内联修复） | 7/7 通过 |
| synthesize | 6/6 通过 | 1/1 通过 | 1/1 通过 |
| simulate | 5/5 通过（100%） | 7 次 1 过：冒烟 PASS；全场景 6 次未收敛 | 6 次 1 过 |
| implement | 4/7 通过（出 synthia.bit） | 0/2（布线完成、时序达标，仅 UCIO-1/NSTD-1 预期内拒绝出码流） | 1/1 |
| WNS / TNS | +6.752 ns / 0 | +6.758 ns / 0 | — |
| LUT / FF | 59 / 69 | 95 / 75（LUT +61%） | — |
| 端到端耗时 | 人工多日 | 2 h 25 m（含 ~35 min 连接器故障期） | — |
| 模型交互 | — | 53 轮对话、1017 次工具调用 | — |
| 门禁/治理 | 冻结基线 | 全程 candidate、不批门禁、盲测合规（audit 可溯） | candidate |

## 2. 关键发现

### 2.1 GLM 做到的
1. **全流程自主走通**：需求分析 → 架构（模块划分/接口契约/CDC）→ 行为规格 → RTL → TB → XDC → exploratory 四步工具验证 → 修复循环 → 如实收尾报告，全程无人工干预（连接器故障修复除外）。
2. **fail-closed 合规质量高**：XDC 中不臆造任何 PACKAGE_PIN/IOSTANDARD，28 行约束每条都回引需求编号（UART-DRQ-IF-003/OQ-001/PERF-002），并预判 implement 的 UCIO-1/NSTD-1 结果。implement 拒绝出码流是**正确行为**，与人工 Golden 的豁免声明口径一致。
3. **物理指标与人工基线相当**：时序同样收敛（WNS +6.758 vs +6.752 ns，TNS 均为 0）；FF 75 vs 69；LUT 95 vs 59（+61%，主因分频逻辑内联与参数化差异，仍在需求预算 FF≤200/LUT≤300 内）。
4. **文档深度超预期**：13 件制品含接口契约 YAML、场景矩阵、波形比较规则、风险登记、缺失信息登记（missing_info.md），每件都有上游修订哈希追踪与假设记录（AS-01~06 provisional）。
5. **诚实的自我报告**：最终报告明确区分"冒烟 PASS"与"全场景未收敛"，未把未验证内容表述为通过；过时的 NOT RUN 报告被真实结果覆盖。

### 2.2 GLM 没做到的（与人工 Golden 的差距）
1. **全场景仿真未收敛（最大差距，但主因在平台而非模型）**：10 场景 TB 迭代 7 版、6 次真实仿真失败后按停止规则放弃。事后复核对话记录确认：**agent 从未看到过任何失败断言**——runtime 的 `capDiagnostic` 保头截断恰好切掉了 TB 断言（实测 ERROR 行位于 stdout 第 3391/3666 字符，截断点 2000），worker-result 中现成的 `simulatorStdout` 字段（1709 字符、含全部断言）也没被读取。agent 在"errorCode + exitCode=0 + 噪声日志"的条件下盲修六轮并如实抱怨日志截断，其"平台侧兼容性问题"的最终归因基本正确。冒烟 TB 通过已排除 RTL 因素。
2. **修复效率偏低**：即便考虑证据缺失，六轮修复未升级观测策略（自建冒烟 TB 是对的方向，但未把"场景拆分复跑"（其 run_report §4 自己提出的方案）执行到底）。
3. **长思考 token 风险**：GLM thinking 计入 max_tokens，默认 16 k 预算曾被思考耗尽导致空回复（已通过 32 k 预算规避）；单轮思考最长 ~8 min；长上下文下出现工具名格式退化（畸形 tool call 名）。

### 2.3 平台侧根因与修复（实验直接产物）
1. **诊断截断保头不保尾**（`vivado-tool.ts` capDiagnostic `slice(0,2000)` vs 注释声称的 tails）：位置窗口对 Vivado 日志形态（长噪声头+断言尾）结构性失效。已修复：内容感知 excerpt（分类行提取+上下文+相位标记+终局，任意位置错误均捕获）。
2. **字段浪费**：worker 早已产出纯仿真输出 `simulatorStdout`，runtime 只解析 `stdout`。已修复：优先消费。
3. **新增 worker 侧结构化日志摘要（synthia-log-digest.v1）**：worker 判定 PASS/FAIL 时顺手产出 `log-digest.json` 证据（failureLines/warningLines/passLines/phaseMarkers/counts，带场景上下文、有界、含截断标记），并嵌入 worker-result.json。runtime 消费链：log-digest.json → worker-result.logDigest → simulatorStdout → 智能截断。已部署 worker 66 并端到端验证：agent 现在能收到 `ERROR [txfmt] tx_done missing at t=537342000`（含 `INFO [BUSY] begin` 场景上下文）级别的断言信息。
4. **mTLS 客户端证书恢复**（`~/.synthia/certs/worker-66/`）与 **PiAnthropicRuntimeModel**（`SYNTHIA_MODEL_API=anthropic-messages`）为本次实验的另两项基础设施产物。

## 3. 结论

- **工程可用性**：GLM 驱动的 Synthia 已能独立完成"需求→文档→RTL→约束→综合→实现→时序收敛"全链路，物理结果与人工基线同一量级；作为初稿生成器价值明确。
- **验证闭环的短板归因需修正**：对比实验当时的"1/7 仿真通过"主要由平台诊断链缺陷造成（agent 全程未见断言），修复诊断通道后 GLM 获得了 `ERROR [场景] 期望 vs 实测` 级别的证据，修复循环质量有待新一轮实验量化。TB 收敛能力的最终结论应以诊断修复后的重跑为准。
- **治理价值得到验证**：candidate 产物、修订追踪、fail-closed、盲测隔离在全自动运行下全部保持，Agent 未越权；对"证据不足即如实上报/停止"的纪律执行良好。

## 4. 复现

```sh
# Core（mTLS 已恢复）
DATABASE_URL=… SYNTHIA_CONNECTOR_CONFIG=~/.synthia/certs/worker-66/worker-66.client.json \
  bun run core/scripts/serve.ts
# Runtime（GLM via 智谱 Anthropic 端点）
SYNTHIA_MODEL_URL=https://open.bigmodel.cn/api/anthropic \
SYNTHIA_MODEL_API=anthropic-messages SYNTHIA_MODEL_NAME=glm-4.6 \
SYNTHIA_MODEL_CHAT_MAX_TOKENS=32768 \
  bun run runtime/server.ts
# 触发：POST /api/v1/projects/p5/tasks（盲测指令）→ /message 驱动
```

证据：p5 workspace git 46 commits、tool_run 12 jobs（job-8009243c…dfc0b8f9）、audit 200+ 条、conversation.json 53 轮。

## 5. p6 重跑（诊断链修复后）— 三方最终对比

### 5.1 p6 实验设置

- 全新项目 p6、全新 agent（无 p5 的污染上下文），输入哈希与 p2/p5 逐字节一致（`55435408…`）
- 平台差异仅有：vivado_run 失败结果携带结构化 logDigest（failureLines+场景上下文+期望/实测值），成功结果携带 passLines/phaseMarkers
- 相同盲测指令、相同模型配置（GLM-4.6 / 32k chat 预算）
- 运行窗口 04:10–06:33 UTC（2 h 23 m），一次人工推动（RX 根因提示）后收敛

### 5.2 三方总表

| 维度 | p3 人工 Golden | p5 GLM（盲修） | p6 GLM（log-digest） |
|---|---|---|---|
| validate_sources | 5/5 | 1/2 | **2/2** |
| synthesize | 6/6 | 1/1 | **1/1** |
| simulate | 5/5 全过 | 1/7（仅冒烟，全场景未收敛） | **1/5 收敛，S1~S9 全场景 PASS** |
| implement | 4/7（出 bit） | 0/2（布线+时序达标，UCIO/NSTD 预期内） | 0/1（fail-closed TIMING_UNCONSTRAINED，无主 XDC） |
| WNS | +6.752 ns | +6.758 ns | n/a（未约束） |
| LUT / FF | 59 / 69 | 95 / 75 | **66 / 74**（贴近人工） |
| RTL 结构 | baud_gen+rx+tx+top 320 行 | 分频内联 397 行 | **独立 baud_gen+rx+tx+top 342 行（与 golden 同构）** |
| TB | 104 行 | 560 行 7 版未收敛 | **347 行 7 版收敛** |
| 生成文档 | — | 13 件 | **19 件（+hw 事实/追踪矩阵/评审记录）** |
| 工具调用总数 | — | 1017 | **71** |
| 畸形工具调用名 | — | 861 | **0** |
| 模型对话轮 | — | 53 | 53 |
| 端到端 | 人工多日 | 2 h 25 m | 2 h 23 m |

### 5.3 关键结论

1. **仿真收敛性的翻转是决定性的**：p5 七轮盲修未收敛 vs p6 五轮内收敛且全场景 PASS。p6 的根因报告达到工程可用质量——准确定位到"TB 等待晚于 DUT 停止位中点的 done 脉冲 19 周期"+ v6 自伤（lb_en 误恢复），修复为 fork/join 并行激励（F1/F2/F3 三处最小改动）。这类时序级根因在盲修条件下不可达。
2. **效率天壤之别**：71 vs 1017 次工具调用；畸形工具名 0 vs 861。p5 的"模型退化"很大程度是"盲修挫败"的症状而非独立缺陷（注意 p6 同时具备干净上下文，两个变量未完全分离，见 5.4）。
3. **RTL 结构质量提升**：p6 自主选择了独立 baud_gen（与人工 golden 同构），LUT 66 贴近人工 59（p5 内联分频为 95）。
4. **文档更完整**：19 件含硬件事实登记（partial 状态如实）、双向追踪矩阵、设计评审记录。
5. **p6 未产出主 XDC 是 harness 规则所致，且 p5 才是违规方**（初版报告判断有误，已修正）：fpga-xdc-gen SKILL §9 规定 `extracted_facts.status=partial` 时"不生成、不登记主约束文件"。p6 严格合规（其 missing_info.md 明确声明"top.xdc 不存在是预期正确状态"），且其 clock_facts 已含 clk 100 MHz（evidence_kind=derived，技能本认可 derived 可用），被全局闸门禁止输出。p5 在 extracted_facts 缺失（needs_input，按契约只应写 missing_info）的情况下直接写了 top.xdc——违规但恰好满足需求 ENV-003"XDC 应至少包含时钟约束"，因此拿到了 STA 证据。两个 agent 在"技能契约"与"需求输入"的冲突规则前各选一边，暴露的是 harness 缺陷：技能把 pin/电气事实闸门与时钟约束闸门捆在同一全局 status 上，与需求 ENV-003/OQ-001 的豁免路径（NSTD-1/UCIO-1 显式豁免 + 至少时钟约束）矛盾。修复方向：拆分两轴闸门——pin/电气轴保持 fail-closed，时钟轴允许 derived 证据产出 clock-only 约束（显式标记 exploratory），implement 在该形态下保留 STA 证据但不产码流。
6. **治理纪律全程保持**：candidate 登记、fail-closed、盲测隔离、根因链可回溯（run_report v3 记录 5 轮迭代史）。

### 5.4 局限

- p5 与 p6 有两个同时变化的变量：诊断链修复 + 干净上下文（p5 中途经历连接器故障与 steer 混乱）。"收敛翻转"归因于两者合力，单独贡献未分离。
- 单次采样：GLM 的结构选择（内联 vs 独立 baud_gen）与 XDC 完整性在两代间波动，需要多次运行才能给出稳定排序。
- RX 根因提示由人工给出一次（"沿三条线索定位"）；线索本身是常规 debug 方法论，但严格说 p6 非完全无人工介入。

## 6. p7（两轴约束闸门 + 平台修复加固）— 最终轮

### 6.1 实验设置

- 全新项目 p7 / agent，输入哈希一致（`55435408…`），相同盲测指令与模型配置
- 平台差异（相对 p6）：① fpga-xdc-gen 契约改为**两轴闸门**（时钟轴 explicit/derived 可产 clock-only 约束；引脚/电气轴保持 fail-closed）；② Core 连接器过期客户端自动重建（NOT_REGISTERED/LEASE_EXPIRED 等一律驱逐重注）；③ Bun `Response.bytes()` >64KB 返回裸 ArrayBuffer 导致 `sha256Hex` 崩溃的登记通道缺陷修复
- 运行中额外遭遇并修复两个平台缺陷（见 6.3），全程两次人工推动（连接器/登记故障修复告知 + RX 根因方法论提示未给，仅故障通报）

### 6.2 结果

| 维度 | p3 人工 | p5 盲修 | p6（诊断修复） | **p7（两轴闸门）** |
|---|---|---|---|---|
| validate / synthesize | 全过 | 过 | 全过 | **全过** |
| simulate | 5/5 | 未收敛 | 全场景 PASS | **8/9 场景类 PASS；发现真实设计缺陷** |
| implement | 出 bit | 时序达标 | TIMING_UNCONSTRAINED | **succeeded（clock-only XDC，WNS +6.996）** |
| LUT / FF | 59 / 69 | 95 / 75 | 66 / 74 | **57 / 87** |
| XDC | 26 行时钟+豁免 | 28 行（违规产出） | 无（合规但保守） | **33 行 clock-only（两轴判定头+source_ref+豁免预期，完全合规）** |
| 码流 | 有 | 无 | 无 | **无（stopBeforeBitstream，fail-closed）** |

**simulate 的定性结论（p7 最有价值产出）**：经 TB v1→v10 演化，隔离并修复 3 个 TB 检查器缺陷（电平采样误增、done 迟到入账、rx_done_seen 误置位）后，以收发完全分离的 v10 复现确证 **RX 背靠背采样相位逐帧漂移 + 帧结束检测失效**（`rx_data=0x96` 于首个 rx_done，172.186µs 逐 ps 复现）→ UART-DRQ-PERF-003 未满足；根因定位到架构决策 ARB-01，建议架构回退。TX 通道以工具证据排除（8 帧=8 busy=8 done，0 空闲下探）。**不声明仿真 PASS** —— 这是正确行为：它在自己的 RTL 里找到了真 bug。

### 6.3 本轮暴露并修复的平台缺陷（p7 中途两次登记/连接中断的根因）

1. **Core 过期客户端死锁**：worker 重启后旧客户端 heartbeat 收 `NOT_REGISTERED`，但重建路径只认 `LEASE_EXPIRED` → 坏客户端永久缓存、作业全挂。修复：`NOT_REGISTERED/ENDPOINT_NOT_APPROVED/ENDPOINT_REVOKED` 一律驱逐重注（connector-adapter.ts `isStaleClientError`）。
2. **Bun 大输出类型陷阱**：`Response.bytes()` 对 >64KB 输出返回裸 `ArrayBuffer`，`sha256Hex` 直接崩溃；毒源是 HEAD 里一份 116KB 转写损坏的 RTL 文件，全树读取使**所有后续登记** 500。修复：showAt 统一包 Uint8Array 视图 + sha256Hex 防 ArrayBuffer（defense in depth）。
3. 两轴闸门契约落地（SKILL.md §2/§5/§7/§9 + skill-pack.json + skill-tools guidance），p7 的 XDC 产出质量验证了设计：33 行、两轴判定头、逐条 source_ref、NSTD/UCIO 豁免预期声明、异步 rxd 的 false_path 附 REL-001 论证。

### 6.4 最终结论

- **三轮迭代后的完整能力画像**：GLM + 完整诊断链 + 两轴约束闸门 = 一次盲测跑通 validate/synthesize/implement 全链并拿到与人工同量级的物理证据（LUT 57 vs 59，WNS +6.996 vs +6.752），且能以工程纪律定位到自己 RTL 的真实设计缺陷并如实关门。
- **调试方法论的出现**：p7 主动采用"取证强化 TB"（证据行紧邻 Fatal 以被 logDigest 捕获）、收发分离隔离运行、逐 ps 复现 —— p5 时代的盲修模式完全消失。
- **harness 仍是主要故障源**：三轮实验共暴露并修复 6 个平台缺陷（诊断截断 ×2、字段浪费、stale-client、ArrayBuffer、约束契约矛盾），每个都曾直接决定实验成败。"模型上限受 harness 质量约束"是本轮最一致的结论。
