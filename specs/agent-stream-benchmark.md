# Agent 信息流对标（Synthia vs Claude Code / Codex）

- 状态：§4 四项取舍**已拍板**（2026-08-19）——「工具调用持久化」「diff 呈现」已交付，「推理强度」已落配置，「思考过程」挂起待多模型适配；§3 其余条目未开工
- 日期：2026-08-19
- 对标对象：Claude Code（CLI / 桌面端 / IDE 扩展）、Codex（CLI / 桌面 app，2026-07 起并入 ChatGPT 桌面端）
- 方法：Synthia 侧逐文件通读 + 浏览器实测 + 直连模型网关探针；对标侧以公开文档与实际使用为准
- 相关：`specs/projects-page-v4.md` §3.5（对话流）、`web/src/domain/parts.ts`（part 判别联合）

---

## 0. 一句话结论

Synthia 的信息流**骨架是对的**（part 判别联合、SSE 增量、工具四态、upsert 不重排都照着 opencode / AI SDK 的成熟语义抄的），差距不在架构而在**三件事**：

1. **等待期是纯黑屏**——实测长思考 prompt 5 分钟内流里零反馈，连"在忙"都看不出来；本该填满这段的思考过程卡因为上游不吐 `reasoning_content` 而**从未在生产中出现过**；
2. **信息流是只读的**——Claude Code / Codex 的流里每个条目都是**可操作的**（改文件就给 diff + Apply/Discard，跑命令就能中途叫停，走错了能 rewind 回去），Synthia 的流只能看；
3. **回合是不可回溯的**——没有 checkpoint、没有重发/重试、没有分支，一轮走歪只能从头再来。

---

## 1. Synthia 现状盘点（逐项核实，非印象）

### 1.1 已经有的 part 类型（`web/src/domain/parts.ts`，11 种）

| kind | 来源 | 说明 |
|---|---|---|
| `text` | audit + SSE | user 气泡 / agent 叙述；流式走 `markdown-stream.ts` 增量块投影，**token 级追加不整量重渲染**（这一点做得比很多实现好） |
| `reasoning` | 仅 SSE | 思考过程卡，streaming 默认展开、定稿自动收起 |
| `agent_tool` | 仅 SSE | agent 自身 tool_calls，三态 + 入参/结果折叠，**失败默认展开** |
| `tool` | audit | 流水线阶段工具条（validate_sources / simulate / synthesize / implement），四态 + 耗时 |
| `gate` | audit | 门审查状态卡 |
| `doc` | audit | 产物卡，点开中栏 Monaco |
| `evidence` | evidence | 证据摘要，跳记录面板 |
| `governance` | audit | 治理登记事件 |
| `lifecycle` | audit | 终态卡（成功附码流 sha256 + 证据数） |
| `note` | audit | 提示卡（纠偏注入 / 回复出错） |
| `interrupt` | audit | 打断留痕 |

### 1.2 已经做对的地方

- **纯函数 + 稳定 id**：`auditToParts` 每次轮询整量重算，part id 跨轮询稳定 → Vue `:key` 复用 DOM，等价增量渲染。
- **upsert 不重排**：part 首次出现即固定位置，后续事件原地替换（照抄 opencode 语义）。这是长会话流不跳动的关键。
- **SSE 降级链完整**：`Last-Event-ID` 续传 → 指数退避重连 → 连续 3 次失败降级轮询 + 横幅提示，且**不会永久放弃**。
- **未知事件不清流**：`toFeedEvent` 的 `default` 返回 `unknown` 而非 `reset`——避免"服务端新增一种事件就把前端整条流清空"的向前兼容陷阱。
- **用户输入不解析 Markdown**：user 气泡纯文本渲染，防注入。
- **审批卡钉在滚动区外**：等待批准是唯一阻塞点，翻历史不会把它翻走。

### 1.3 实测发现的硬缺陷

**① 思考过程卡在生产中从未出现过。** 直连网关探针（`grok-4.6`，同一道推理题）：

| reasoning_effort | delta 字段 | reasoning chunks | reasoning_tokens | 墙钟 |
|---|---|---|---|---|
| `xhigh` | `['content','role']` | **0** | 4424 | 53s |
| `low` | `['content','role']` | **0** | 1475 | 25s |

模型**确实在推理**（`reasoning_tokens` 计费了），但网关**只转发 `content`**，一个 `reasoning_content` delta 都没有。所以 `ReasoningItem.vue` 连同 `model-client.ts` 里那套 `onReasoningStart/onReasoning` 管线，是**建好了但永远不触发**的死路径。

> **这是一个已标记的待解问题，不是本轮要修的**（§4.1）：管线原样保留、三处打了 `TODO(reasoning)`，留到多模型适配时换上游一并解决。与 ⑤ 的 504 同一条根因——这个网关的 SSE 通道既慢，又只转发 `content`。

**② 等待期零反馈。** 浏览器实测：00:54:57 发出长思考 prompt，00:59:52 才出现回复——**中间 5 分钟对话流一动不动**，没有 spinner、没有计时、没有"正在思考"。而且发送按钮仍是可用的「↑ 发送」，abort 按钮也没出现（`composerMode` 由 agent `status` 推导，free-agent 回复中 status 没翻成 running）。用户唯一能得到的信号是"什么都没发生"。

**③ 实时流不落 audit。** `reasoning` 与 `agent_tool` 只来自 SSE，刷新页面即消失（代码注释里写明这是有意的）。但结果是：**关掉页面再回来，就再也看不到 agent 这轮到底调了什么工具**，只剩最终文本。Claude Code / Codex 的工具调用记录是持久的。

> 已按 §4.3 处理：`agent_tool` 现在会在工具结束时落一条截断后的 audit，刷新可回看（runtime 重启仍会丢——audit 在进程内存里）。`reasoning` 维持不落 audit，因为它在当前上游根本不产生（见 ①）。

**④ 附件通道完全缺失。** `ChatComposer.vue` 只有一个自适应 `<textarea>` + 发送/打断。不能贴图、不能拖文件、不能引用产物、没有 `@` 提及、没有斜杠命令、没有历史草稿。

**⑤ 流式通道本身就是失败源——与推理强度无关。** 同一 prompt 在同一网关上交叉对照两条通道：

| 通道 | 首字节 | 结果 |
|---|---|---|
| 非流式（`stream: false`） | —（一次性返回） | **4/4 成功**，约 26s 出全文 |
| 流式（`stream: true`） | **55–65s** | **5 次里 504 了 4 次**（网关首字节上限 60s） |

首字节耗时恰好骑在网关的 60s 上限上，所以失败是概率性的。**这不是 `reasoning_effort` 造成的**：`low`（1475 reasoning tokens / 25s）一样 504，把强度调低并不能把首字节压回 60s 以内——慢的是这个网关的 SSE 通道本身（比 buffered 慢约 2.6 倍），不是模型思考得久。

重试也治不了：每次重试都要再赔一个 60s 的等待。所以 `runtime/model-client.ts` 做的是**降级**而非重试——流式建连失败即改发一次非流式（`streamFallbackToBuffered`，默认开），代价是那一轮没有打字机效果，回复一次性出现。同一条根因也解释了 ①：这个网关的 SSE 通道既慢，又只转发 `content`。

---

## 2. 逐维度对标

图例：●=完整 ◐=部分 ○=没有

| 维度 | Synthia | Claude Code | Codex | 差距说明 |
|---|---|---|---|---|
| **思考过程可见** | ○（组件在，上游不吐） | ● 思考块实时流式，可展开 | ● thinking 摘要，随任务复杂度自适应 | 见 §1.3① |
| **等待期反馈** | ○ 5 分钟黑屏 | ● 转轮 + 计时 + 当前动作 + token 计数 | ● 状态行 + 阶段提示 | **体感差距最大的一项** |
| **工具调用可见** | ◐ 三态 + 入参/结果，刷新可回看 | ● 每次调用一条，参数摘要 + 结果 + 耗时，持久 | ● 格式化的 tool call | 已落 audit（§4.3）；runtime 重启仍会丢 |
| **文件改动呈现** | ◐ 产物卡跳中栏 Monaco diff | ● 行级 diff（+/− 着色）内联在流里 | ● file-edit capsule，unified / side-by-side diff | 流内不做行级 diff 是有意的取舍（§4.4） |
| **改动可操作** | ○ | ● 权限提示：允许 / 拒绝 / 总是允许 | ● Apply / Apply with review / Discard，可在 diff 上评论 | 流里不能决策 |
| **中途打断** | ◐ 有 abort，但 free-agent 回复中按钮不出现 | ● Esc 随时打断，保留已完成部分 | ● | 见 §1.3② |
| **回溯/撤销** | ○ | ● checkpoint + `/rewind`：恢复对话 / 恢复代码 / 从此分支 | ● 线程隔离 + worktree | 走歪只能重来 |
| **任务计划可见** | ○ | ● TodoList 实时勾选 | ● 任务列表 + 分区 | 多步任务看不到"还剩几步" |
| **子任务 / 并行** | ○ | ● subagent 独立汇报 | ● 多线程 agent，各自 worktree | Synthia 有 agent 分层模型（D24–D26）但流里无体现 |
| **消息可编辑重发** | ○ | ● rewind 后原 prompt 回填输入框 | ● | 打错字只能重打一遍 |
| **附件 / 引用** | ○ | ● 图片、文件、`@` 引用、斜杠命令 | ● | 见 §1.3④ |
| **代码块体验** | ◐ >15 行折叠成卡 | ● 语法高亮 + 复制 + 行号 | ● 高亮 + 应用 | 没有语法高亮、没有一键复制 |
| **错误可诊断** | ● 已按原因分类给下一步 | ● | ● | **本轮刚补齐，已追平** |
| **流式增量渲染** | ● token 级块投影 | ● | ● | **已追平，实现质量不输** |
| **断线恢复** | ● 续传 + 退避 + 降级 | ● | ● | **已追平** |
| **长会话导航** | ◐ 只有"回到最新 ↓" | ● 折叠 + 搜索 | ● 分区 + 增量浏览长记录 | 几百条后无法定位 |

---

## 3. 改造清单（按性价比排序）

### P0 —— 让等待可见（改动小，体感提升最大）

1. **等待指示器**：SSE `status` 到达但首个 delta 未到时，流尾渲染一条"思考中 · 已 12s"的活动条，带计时。**不依赖上游 reasoning**，纯前端可做。
2. **修 free-agent 回复中的 composer 状态**：回复进行中 `composerMode` 应进 running、露出「⏹ 打断」。当前因为 agent `status` 停在 `awaiting_approval` 而失效。
3. ~~**思考过程降级方案**~~ → **挂起**（§4.1）：既不换上游也不做降级，组件与管线原样留着并打了 `TODO(reasoning)` 标记，留到多模型适配时一并解决。在那之前仍是"组件留着但永远不显示"，等待期的反馈由上面第 1 条的活动条独立承担。

### P1 —— 让流可操作

4. ~~**内联 diff**~~ → **已交付，但换了形态**（§4.4）：不在流内渲染行级 diff，改为产物卡上的「查看改动 ⇄」跳中栏 Monaco diff。**改动仍不可操作**（无 Apply / Discard），这一格只补上了一半。
5. ~~**工具调用持久化**~~ → **已交付**（§4.3）：`agent_tool` 在工具结束时落一条截断后的 audit，刷新可回看；runtime 重启仍会丢（audit 在进程内存里）。
6. **代码块语法高亮 + 一键复制**：中栏已经有 Monaco，流里的代码块却是裸 `<pre>`。

### P2 —— 让回合可回溯

7. **消息编辑重发**：user 气泡加"编辑重发"，重发即截断其后的流。
8. **checkpoint / rewind**：Synthia 已有产物修订链（`revisions`），做"回到这一轮之前的产物状态"比 Claude Code 从零做 checkpoint 更容易——**这是 Synthia 的结构性优势，目前没用上**。
9. **计划可见**：多步任务在流里维护一个 TODO part，实时勾选。

### P3 —— 输入侧

10. 附件（图片/文件）、`@` 引用产物、斜杠命令、草稿持久化。

---

## 4. 取舍（owner 已拍板，2026-08-19）

| 议题 | 结论 | 状态 |
|---|---|---|
| **思考过程** | 先标记，不做降级方案；留到多模型适配时一并解决 | 挂起（代码里已打标记） |
| **推理强度** | 保 `xhigh`，并把输出上限调高 | 已落配置 |
| **工具调用持久化** | 落 audit | 已交付 |
| **diff 呈现** | 复用中栏 Monaco 的 diff，流内不做行级 diff | 已交付 |

### 4.1 思考过程：挂起，只标记

不选「换上游」，也不选「放弃并用活动条替代」——**两个都先不做**，把 §1.3① 作为一个已知待解问题标记下来，等 4.2 的多模型适配落地时一并处理（换一个转发 `reasoning_content` 的上游是那件事的自然副产品）。

在那之前刻意**保留现状**：`ReasoningItem.vue`、`consumeChatSSE` 的 `onReasoningStart/onReasoning` 管线、`SynthiaReasoningPart` 全部原样留着不删。理由是这套管线本身没有错——错的是上游不吐；删掉等于换上游那天要重写一遍。代价是它在当前部署下是死代码，所以三个位置都打了 `TODO(reasoning)` 标记，便于换上游时一次捞全：

- `runtime/model-client.ts` — `reasoningFragment()`（解析入口）
- `web/src/domain/parts.ts` — `SynthiaReasoningPart`
- `web/src/views/ProjectView.vue` — `toProcessPart`

**等待期的反馈不指望它**：§3 P0.1 的活动条不依赖上游 reasoning，是纯前端能做的，仍应单独排期。

### 4.2 推理强度：保 `xhigh`，调高上限

保 `xhigh`（质量优先），**并把输出上限调高**——两件事一起做才成立。

⚠️ 这里要纠正一个直觉上的因果错误：`xhigh` **不是** §1.3⑤ 那批 504 的原因。降到 `low` 一样 504，首字节慢是网关 SSE 通道的固有开销，不是模型思考得久。所以「为了少失败而降强度」是无效的止损，真正兜住失败的是非流式降级（`streamFallbackToBuffered`）。既然强度换不来成功率，就按质量选，选 `xhigh`。

上限的现状（`runtime/model-client.ts`，均可用环境变量覆盖）：

| 用途 | 字段 | 默认 | 环境变量 |
|---|---|---|---|
| 对话（free-agent chat / chatStream） | `chatMaxTokens` | **16384** | `SYNTHIA_MODEL_CHAT_MAX_TOKENS` |
| 文档阶段（intake/behavior/architecture/register） | `docMaxTokens` | 8192 | — |
| 工具阶段（RTL/TB/XDC/repair） | `toolMaxTokens` | 4096 | `SYNTHIA_MODEL_TOOL_MAX_TOKENS` |

对话路径单独拆出来给到 16384，是因为一个对话轮可能整份贴进一个源文件，而流水线阶段每次只吐一个有界的 action。**实测这个网关上 `max_tokens` 只约束可见 token，reasoning token 另计**——也就是说调高上限并不会被推理消耗掉，`xhigh` 与高上限不冲突。

`reasoning_effort` 本身走 `SYNTHIA_MODEL_REASONING_EFFORT`，不设即不发该字段，非推理模型不受影响。

**后续方向（待办，非本轮）**：要做多模型适配。届时 `reasoning_effort`、`max_tokens`、思维链字段名这三样都得按模型分档，而不是像现在这样一套默认值打天下。可能可以复用 **pi agent 的多模型接口**，不必从零写一层适配。§4.1 的思考过程问题挂在这件事上一起解。

### 4.3 工具调用持久化：落 audit

选落 audit，不单开表。审计库膨胀用**截断**控制而不是用另一张表控制：入参 400 字符、结果 800 字符、单轮 audit 响应 200 条（`runtime/server.ts` 的 `AUDIT_TOOL_ARGS_MAX` / `AUDIT_TOOL_RESULT_MAX` / `AUDIT_RESPONSE_LIMIT`）。这几个阈值比 SSE 的 `STREAM_PAYLOAD_MAX`（2000）更紧，因为 audit 每 3s 被整量重发一次，而 SSE 载荷只发一次。

只在**工具结束时**写一条（不写开始），因为 `StreamHub.subscribeCurrentTurn()` 从最后一个 `done` 事件起重放，实时三态由 SSE 负责，audit 只需保证刷新后能回看「这轮调了什么」。合流规则见 `SynthiaAgentToolPart` 的注释：按 callId 去重，位置听 audit、内容优先听 SSE。

⚠️ 已知限制：runtime 的 audit 是**进程内存**，runtime 重启即丢（`detail.docs` 同理）。这不是本项引入的，但它意味着「持久化」目前只跨页面刷新、不跨 runtime 重启。

### 4.4 diff 呈现：复用中栏 Monaco

不在流内渲染行级 diff。对话流是过程叙事，逐行改动是编辑器的活——流内自建一套高亮等于多一份要维护的实现，而中栏的 `diffAgainst` 已经是能用的 Monaco diff。

落地形态：产物卡在**有上一版可比**时多一枚「查看改动 ⇄」，点了直接把中栏切进 diff 模式（head = 卡片这一版，base = 版本链里它的前驱，见 `project-view-contract.ts:prevRevisionId`）。首版、或这一版已不在版本链里 → 不出这个入口，不给点了会落空的按钮。

连带的行为变更：产物卡的「打开」从此钉**当时登记的那一版**，不再跳最新版。否则同一张卡上「打开」和「查看改动」会指向不同的东西。

这条只关掉了 §2 里「文件改动呈现」那一格的一半——**改动仍然不可操作**（没有 Apply / Discard / 在 diff 上评论），那是 §3 P1 之外的事。

---

## 5. 不在本文范围

信息流之外的部分（文件树、编辑器、门禁审批、记录面板）不在对标范围。`specs/projects-page-v4.md` §8 第三批（步骤 10–13）与本文的 P1/P2 有重叠，实施时需合并排期。
