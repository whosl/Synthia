# H38 模型输出超限处置（2026-10-08，platform-ops，本地完成，未部署）

本批包含模型结束信号透传、free-agent 确定性续跑、智谱端点思考参数调研和 FPGA 大文件生成纪律。未重启任何生产服务，未发送 p32 会话消息，未修改生产部署目录或 Worker bundle。

## 1. 三种观测形态与处置矩阵

用户提供 p28/p32 实测：空回复、模型请求挂起、预告式收口；另有 p32 tb_top.v 生成截断/乱码（约 3,016B，对比完整约 33KB）。旧 conversation 未保存模型结束原因，不能由冒号结尾反推 max_tokens。部署后 assistant 消息保存 stopReason，便于区分机器截断与正常结束的语义性收口。

| 观测/机器信号 | 处置 | 上限及审计 |
|---|---|---|
| 纯文本为空或只有空白（包括 max_tokens） | 原有 empty-reply nudge；现在重试前也先持久化 | 每个 prompt 1 次，独立计数 |
| 非空纯文本且 stopReason=max_tokens | P1：保留部分 assistant 文本，回灌继续提示并续轮 | 每个 prompt 最多 2 次；stderr 与 conversation 记录 retry=1/2、2/2，耗尽记 disposition=exhausted |
| 模型请求楔死 | 保留 H36 watchdog，仅覆盖模型请求窗口 | 默认 15 分钟，abort + 持久化系统注记 + 重试一次；工具运行不计时 |
| 非空文本正常 end_turn，但只是预告下一步/冒号结尾 | 暂不自动判断或续跑 | P1 上线后按保存的 stopReason 统计，之后决定是否增加 Cline 式保守门控 |
| 大文件生成截断/乱码残骸 | P3：骨架工作副本 + 每段 ≤8 KiB，登记后读回核验 | 最终必须完整、无 stub；不改变候选质量闸门/冻结域 |

空回复和非空截断互斥匹配，使用独立重试额度；混合序列不占用对方额度。没有适用额度时沿原回合结束路径回到 idle（持久 AgentState 为 awaiting_user），保留现有 claim-check、取消、权限和总轮数上限。tool_calls 不进入文本续跑分支，照常经过工具执行和治理。

## 2. 两项实现

- `runtime/pi-anthropic-model.ts` 将 pi-ai 的 length（上游 max_tokens）映射为 ChatTurn.stopReason=max_tokens，stop/toolUse 分别映射 end_turn/tool_use；chat 和 chatStream 同一转换。流水线转为 Chat Completions 回执时 length 也保留。
- `runtime/model-client.ts` 的 buffered/SSE Chat Completions 路径同步保留 finish_reason，length 归一为 max_tokens；结束原因缺失保持未知，不猜测截断。
- `runtime/free-agent.ts` 对非空 text + max_tokens 保留部分输出并自动续跑至多两次。继续提示作为 user 角色的系统回灌消息紧跟部分 assistant 文本，避免 Anthropic 将多个 system 消息折叠到请求头而失去中断顺序。
- 每次续跑前持久化 conversation，assistant 元数据保存 stopReason；stderr 采用 `[free-agent] <agentId>: model output limit stop_reason=max_tokens; retry=1/2` 格式，耗尽附 exhausted。额度覆盖一个 prompt 的整个工具循环，不因工具成功而重置。
- 耗尽后仍经过原 claim-check，不允许用截断规避“声称仿真通过但无证据”的保护。空回复沿原 nudge，额外保证重试前落盘。

## 3. P2 思考参数调研

2026-10-08 查阅智谱官方[核心参数](https://docs.bigmodel.cn/cn/guide/start/concept-param)、[思考模式](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode)和 [Claude API 兼容说明](https://docs.bigmodel.cn/cn/guide/develop/claude/introduction)。官方模型能力表：GLM-4.6 支持 thinking 开关；reasoning_effort 仅 GLM-5.2 及以上。公开核心参数未给 GLM-4.6 提供可执行的 thinking budget_tokens 契约；Claude 兼容说明也未承诺该预算控制。

通过现有平台 systemd 模型配置的 URL/key，独立直接请求 `https://open.bigmodel.cn/api/anthropic/v1/messages`，显式指定 glm-4.6；不读 `/tmp/synthia-tokens.txt`，不通过 Runtime，不占 p32 的会话用量统计或发送基准消息。共 7 个同一整数乘法小请求，每个 max_tokens=512，总计 203 输入/1281 输出 tokens。平台 unit 当时配置的模型名为 glm-5.3-flash；本调研仅在独立请求中指定 glm-4.6，没有改动 unit 或运行中会话配置，不能据 unit 文件推断当前进程/已有会话的实际模型。

| 参数形态 | HTTP | 返回思考字符数 | 输出 tokens | 结论 |
|---|---:|---:|---:|---|
| thinking disabled | 200 | 160 | 117 | 仍有非空 thinking block |
| thinking enabled, budget_tokens=1 | 200 | 603 | 362 | 明显没有按 1 token 硬预算截住思考 |
| thinking enabled, budget_tokens=128 | 200 | 436 | 240 | 接受参数不能证明其控制有效 |
| thinking enabled, reasoning_effort=low | 200 | 445 | 222 | GLM-4.6 未有官方 effort 契约，样本不足以推断效果 |
| 不传思考参数 | 200 | 348 | 177 | 默认对照；响应 model=glm-4.6 |
| thinking disabled（复核） | 200 | 106 | 80 | 仍有 thinking block；响应 model=glm-4.6 |
| 故意无效的 thinking.type/budget/effort | 200 | 113 | 83 | 未拒绝无效字段，支持兼容层忽略字段的推断 |

**结论：本次所测智谱 Anthropic 兼容端点没有可验证有效的 GLM-4.6 思考关闭/预算能力。** 根据无效参数仍被接受、disabled 仍返回思考的对照，推断这些字段未被兑现；不把 200 当能力证明，也不泛化为所有 GLM 接口都不支持 thinking。预算是“硬限制”还是提示性参数均没有可靠契约，故本批不增加 SYNTHIA_MODEL_THINKING_*，默认请求行为保持。P1 是本批对真实 max_tokens 的唯一确定性自动处置。

智谱当前通用文档列 glm-4.6 默认 65,536、最大 131,072；本批不据此改变 T3 已配置/实测的 65,536 上限，也不把通用文档当成该兼容端点的 128K 认证。JSON 探针记录见 [platform-h38-thinking-probe.json](platform-h38-thinking-probe.json)，无凭据或思考全文。

## 4. P3 模板固化

`skills/fpga/skills/fpga-tb-write/SKILL.md`、`fpga-rtl-build/SKILL.md` 固化：预计 >8 KiB（8192 UTF-8 字节）先落模块/端口/场景桩骨架，再以新增/替换段 ≤8 KiB 保存工作副本小版本；组装完成后登记，登记后读回路径/hash/UTF-8/结构完整性，发现截断/乱码停止修复。

按原规则 00 第 6 节，partial/stub 不登记；骨架只属于工作副本，不借此放宽候选判定或板级硬件事实门禁。本项为技能生成纪律，不新增工具权限、编辑 API、机器强制 8 KiB 限额或质量判定。`read_skill_doc` 路径回归确认模型能读到完整新纪律。

## 5. 验证与生效范围

- 受影响 8 个 Runtime 测试文件：**210 pass / 0 fail**。新覆盖：两次截断后文本结束/进入工具、重试耗尽及后续 prompt 重置、空回复混合序列、空白仅 nudge、end_turn/未知不续跑、tool_calls 不被替换、claim-check 保持、续跑前落盘、stderr 次数，以及 buffered/SSE adapter 和技能读取。
- 根目录 `bun run test`（不设置 DATABASE_URL）：**979 pass / 400 skip / 0 fail**，400 个数据库相关测试未执行；本批没有数据库/schema/Core API 改动。
- `bun run check`（undefined names/GJB docs/Core TypeScript）、`bunx tsc --noEmit -p runtime/tsconfig.json`、`git diff --check` 均通过。
- canonical Worker bundle SHA-256 仍为 `15c430a29177b3fb44c3820ba48cc8cf557121cee8a87fd193693e03d169514c`，未修改 bundle 或远端 Worker。
- 生产 Runtime PID `2313413`、Core `1672674`、evolution workers `2313547`、Web `2050169` 均保持本轮开始时的进程；生产 checkout 仍 `42cf5fa`。

**需要后续部署窗口重启 Runtime**，加载模型适配/循环代码与技能模板缓存。Core、Worker、Web 无本批生效所需重启；evolution workers 不执行 free-agent 续跑，暂无本批必需重启。没有数据库迁移。用户协调窗口，本批未部署。

测试日志：`/tmp/synthia-h38-tests.log`、`/tmp/synthia-h38-root-tests.log`、`/tmp/synthia-h38-core-check.log`、`/tmp/synthia-h38-runtime-check.log`。
