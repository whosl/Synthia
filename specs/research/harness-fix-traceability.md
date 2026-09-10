# Harness 缺陷修复 — 可追溯性与消融矩阵

- 维护规则：**每个缺陷修复一个独立 commit**，commit message 尾部带 `[H#]` 标签与 *Ablation note*；本矩阵是缺陷 → commit → 影响面 → 消融方法 → 验证实验的权威索引。
- 目的：① 任何修复可单独 revert 做消融（测它对模型行为的真实贡献）；② 防止"堆特性导致模型退化"——凡进入模型上下文或控制环路的改动都在"模型环路影响"列显式标注。

## 1. 矩阵

| 缺陷 | commit | 一句话 | 模型环路影响 | 消融方法 | 验证实验 |
|---|---|---|---|---|---|
| 诊断截断保头不保尾（p5 盲修根因） | `37e7d41` | vivado_run 失败诊断改为内容感知提取（分类行+上下文+相位+终局） | **高**：失败工具结果的字节内容完全改变 | revert 后重跑盲测，预期复现"七轮盲修不收敛" | p5 vs p6 对照 |
| worker 无结构化日志摘要 | `a7a06a7` | synthia-log-digest.v1（failureLines/passLines/warningLines/phaseMarkers） | **高**：新增 digest 进上下文（有界，~几 KB） | revert 该 commit 但保留 `37e7d41`，退化到智能截断路径 | p6/p7 全程由 digest 驱动 |
| 约束契约与需求矛盾（全局 status 闸门） | `4f34a7f` | 两轴判定：时钟轴齐备可产 clock-only 约束 | **高**：XDC 产出路径的 prompt 契约（SKILL.md/_pack/guidance） | revert 后 partial 事实下无主 XDC（p6 形态） | p6（无XDC）vs p7（clock-only，WNS+6.996） |
| 豁免措辞 vs worker 政策 | `7c5c32d` [H6] | 明示"豁免=注释声明，SEVERITY 改写会被拒收（错误码点名）" | 中：契约一句话，减少一次试错 | revert 测 agent 是否再猜 severity 形态 | p9 F4 首撞 |
| Core 过期客户端死锁 | `1f20fe0` | NOT_REGISTERED 等生命周期错误一律驱逐重注 | 无（基础设施） | revert 后 worker 重启即永久 500，需重启 Core | 部署期两次实撞 |
| Bun ArrayBuffer（>64KB git show） | `77dee47` | showAt 统一 Uint8Array 视图 + sha256Hex 防 ArrayBuffer | 无（注册通道） | revert 后任一 >64KB 文件毒化全部后续登记 | p7 116KB 损坏文件实撞 |
| xvlog 语法错误不可见 | `5b50935` [H2] | simulate TCL catLog 回显 compile/elaborate 日志 | **高**：编译错误以 VRFC 原始行进入 digest | revert 后语法错误降级为误导性 XSIM 43-3225 | p10 拿 `VRFC 10-8492` 一次修复收敛 |
| FATAL: 大写不匹配 | `ae6c1fe` [H4] | 失败行正则大小写不敏感 | 中：TB 可用自然前缀，无需改写为 `ERROR:` | revert 复现"failed 但 digest 空" | p9 首撞（被迫改前缀） |
| 空回复静默终止 | `7aa06c8` [H3] | 空文本轮一次 nudge+重试 | **高**：向对话注入一条系统纠错消息（幂等边界=1/轮） | revert 复现 p8/p10 中途停摆 | p8/p10 双中招实录 |
| 重启将 free agent 标 failed | `d1bd665` [H7] | 恢复为 awaiting_user + sidecar 幂等系统说明 | 中：恢复后对话多一条"重启中断"说明 | revert 复现误报 failed + 人工恢复 | p9 实撞 |
| worker 证据随进程蒸发 | `b608035` [H8] | jobs-registry.json 快照（写链序列化+终态 await+恢复 lost 语义） | 无（证据可达性） | revert 后重启即历史证据 404 | 两次部署实撞；跨重启 API 测试 |
| 进程静默死亡 | `7b3392b` [H1] | 入口崩溃兜底日志 + supervise.sh 重启循环 | 无（进程存活） | revert 处理器复现无痕死亡 | Core+Runtime 同窗实撞 |
| 认证层 500 零日志 | `89ed48d` [H9] | authenticate catch 打日志 | 无（可观测性） | — | DB 密码变更实撞 |
| Anthropic 兼容模型接入 | `23d56c0` | PiAnthropicRuntimeModel（pi-agent 头） | **高**：新模型通道（默认不启用） | 不设 `SYNTHIA_MODEL_API=anthropic-messages` 即完全旁路 | 三轮探针+全实验 |
| worker scope 手工供给 | `c9ee781` | p1→p16 扩容（机制未改，见 §3-U1） | 无 | — | p9/p10 撞 PROJECT_NOT_ALLOWED |

## 2. 模型行为风险的消融设计（防"堆特性退化"）

**进入模型上下文/控制环路的改动共 6 个**（上表"高/中"）：`a7a06a7`、`37e7d41`、`4f34a7f`、`5b50935`、`7aa06c8`、`ae6c1fe`。建议的标准消融组合：

| 组合 | revert 集合 | 度量什么 |
|---|---|---|
| A0 全开（基线） | — | 当前平台完整能力 |
| A1 无 digest | `a7a06a7`+`ae6c1fe` | 结构化摘要 vs 纯智能截断的贡献 |
| A2 无诊断修复 | A1 + `37e7d41`+`5b50935` | 复现盲修时代（应接近 p5 形态） |
| A3 无行为守卫 | `7aa06c8`+`d1bd665` | 空回复/恢复语义对任务完成率的影响 |
| A4 无约束契约改动 | `4f34a7f`+`7c5c32d` | XDC 产出率与 STA 证据可得性 |

度量口径（沿用本轮实验）：仿真收敛轮数、工具调用总数、畸形工具名数、四步通过率、XDC 产出形态、最终汇报的诚实性（声称 vs TOOL_RUN 记录）。同一需求输入（SHA-256 固定）+ 同模型 + 同 worker。

## 3. 未修事项（记录在案）

| 编号 | 事项 | 状态 |
|---|---|---|
| U1 | worker scope 供给机制（双侧配置+双进程重启，无 API） | 手工 runbook；需 admin API 或自动发现 |
| U2 | Core/Runtime 同窗静默死亡根因（疑 OOM） | H1 缓解；需内存画像复现 |
| U3 | 共享基础设施隔离（并行会话改 DB 密码） | 已用独立角色绕开；流程问题 |
| U4 | 64k 预算下空回复仍偶发 | H3 是 nudge 不是根治；根治需预算自适应/分段思考 |
