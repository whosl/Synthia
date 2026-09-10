# C 系列复杂需求盲测 — Harness 缺陷清单（p8 SPI / p9 双时钟FIFO / p10 PWM）

- 日期：2026-09-04
- 输入：三份新编制的复杂需求（寄存器接口+FIFO、双时钟域 CDC、时序精确+安全态），同盲测规则
- 模型：GLM-4.6（64k chat 预算 + 空回复守卫），平台含 p5-p7 全部修复
- 目的：以更复杂需求压测 harness，专找平台问题

## 1. 三次运行结果

| | p8 SPI 主控（C1） | p9 双时钟 FIFO（C2） | p10 三通道 PWM（C3） |
|---|---|---|---|
| validate | ✅ | ✅×3 | ✅×2 |
| synthesize | ✅ | ✅（1 修后） | ✅ |
| implement | ✅ | ✅×3（三次一致复现） | ✅×1 |
| simulate | ❌×5 未收敛（真功能 bug 调试中，被 runtime 死亡中断） | ✅ 收敛（含检查器过约束的语义级修复） | ✅ 收敛（10 次失败后） |
| 制品数 | 16 文件 | 31 文件 | 23 文件 |
| 特点 | 断言粒度达 nss_release_timing ±200ns | 自纠"误标通过"+ 对照实验方法论 | 用 VRFC 原始错误行修复语法 |

## 2. 新暴露的 harness 缺陷（按严重度）

### H1（严重）进程静默死亡，无诊断无监督
Core 与 Runtime 在同一窗口（~23:4x）先后静默退出：日志停在启动行，无错误输出；在途 agent 轮次丢失、状态悬空；无进程监督/自动重启/告警。疑与三 agent 并行的内存压力有关，根因未定。
**处置**：未修。需要：未捕获异常兜底日志、OOM 探针、supervisor（launchd/pm2）+ 启动恢复。

### H2（严重）xvlog 语法错误对诊断通道完全不可见
xvlog 对 VRFC ERROR 返回 exit 0，compile.bat 只写 compile.log 不回显 stdout → 语法错误降级为误导性 elaborate "XSIM 43-3225 Cannot find design unit"，原始错误任何通道都看不到。p9 因此做了整套对照实验仍判"harness 侧无法修复"；p7 当初的"SV 兼容性"猜测也是这个盲区逼出来的。
**处置**：已修（simulate TCL catLog 回显 compile/elaborate 日志，commit 5b50935）。p10 验证闭环：模型拿到 `VRFC 10-8492 illegal operator '!=='`（带文件路径）后一次修复、仿真收敛。

### H3（严重）空回复静默终止任务
thinking 模型耗尽输出预算返回空文本轮 → runtime 视为完成、静默 idle，无错误无重试无痕迹。p8/p10 双双中招（32k 预算下），64k 后仍出现。
**处置**：已修（一次纠正性 nudge + 重试，commit 7aa06c8）。未做：预算自适应/分段思考。

### H4（中）log-digest 失败行正则漏 `FATAL:` 大写形态
p9 实录：TB `$fatal` 打印 `FATAL:` 前缀行，digest 的 `FAILURE_LINE_RE` 只匹配 `Fatal:`（大小写敏感）→ "跑到 $finish 但 state=failed 且 digest 无失败行"，TB 被迫改前缀为 `ERROR: TB FAIL` 才被捕获。
**处置**：未修。一行修复：正则加 `i` 标志或补 `FATAL:` 分支。

### H5（中）worker project scope 双侧手工供给
新项目 p9/p10 直接 PROJECT_NOT_ALLOWED。修复需要：改 worker 侧 config + 重启 worker 任务 + 改 Mac 侧 client config + 重启 Core —— 两侧、两个文件、两个进程，无 API、无供给流程、错误信息不指路。
**处置**：本次手工扩容 p1-p16（commit c9ee781）。机制未改。

### H6（中）XDC "豁免"措辞与 worker 政策冲突
需求模板写"以 NSTD-1/UCIO-1 豁免方式显式声明"，agent 按字面实现为 `set_property SEVERITY` 豁免 → worker 政策正确拒绝（UNSAFE_XDC_DRC_SEVERITY_OVERRIDE）→ 改注释声明后通过。政策是对的，但需求/技能模板应明示"注释级声明，禁止 severity 改写"。
**处置**：未修（改需求模板措辞 + SKILL.md 补一句）。

### H7（中）runtime 重启把 in-flight agent 标记 failed
为部署修复重启 runtime 时，p9 正在跑 → 恢复后 status=failed（对话完整、可继续，但状态语义错误且无自动恢复）。
**处置**：未修。恢复逻辑应将"running"状态恢复为 awaiting_user 并记录中断事件。

### H8（中）worker 重启丢失全部历史 job evidence
job 注册表纯内存：worker 一重启，全部历史 job 的 evidence API 不可达（磁盘文件还在，需 SSH 手工取）。Core 的 tool_run 行持久化了 manifest，但内容回源依赖活 worker。
**处置**：未修。需要 worker 启动时从 workspace 目录重建 job 注册表，或 Core 侧缓存 evidence 内容。

### H9（低）认证层 500 零日志
authenticate() 的 catch 返回固定 internal envelope 不打日志。DB 密码被并行会话变更后全部请求 500，是今晚排查最久的故障。
**处置**：已修（日志，commit 89ed48d）。

### H10（环境）共享基础设施无隔离
并行会话（self-evolution 实验）直接改了共享 postgres 的 postgres 用户密码，Synthia Core 全挂。已用独立角色 synthia_core 绕开。属工作区治理问题：数据库/端口等共享资源应有项目级隔离或变更通告。

## 3. 与 UART 系列（p5-p7）的对照结论

- UART 系列修掉的诊断盲区（截断/字段浪费）在 C 系列没有复发；p9/p10 的修复循环全程由 logDigest failureLines 驱动，包括两处语义级根因（检查器过约束、时序断言）。
- 复杂度上升后，**新的瓶颈全部在 harness**：进程存活（H1）、工具日志可见性（H2）、预算管理（H3）。模型侧表现反而稳定：三次运行的断言粒度、方法论（对照实验、事件台账、精确时间测量）和诚实性（p9 自纠误标）都在线。
- 累计两轮实验（UART×3 + C×3）：暴露 harness 缺陷 16 项，修复 9 项。"模型上限受 harness 质量约束"持续成立，且复杂度越高越成立。
