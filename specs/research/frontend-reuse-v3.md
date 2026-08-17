# 前端复用可行性调研报告：Synthia 统一项目页 v3 选型

- 状态：调研定稿（2026-08-17）
- 服务对象：specs/unified-project-page-v3.md 选型决策
- 候选：①anomalyco/opencode session-ui + web 分享页；②DeepSeek 官方前端；③assistant-ui + Vercel AI SDK useChat 生态
- 本栈基线：Vue 3.5 + pinia + vue-router + marked + Vite 6，自研组件零 UI 库（web/package.json）；后端契约 = runtime audit 六类事件（`AuditCategory = "model" | "tool_call" | "gate" | "loop" | "lifecycle" | "governance"`，runtime/types.ts:175）+ `DocGeneration`/`EvidenceSummary`；v3 交付形态 = 3s 轮询准直播（spec §3），真流式后续换 SSE
- 证据方式：全部结论来自候选仓库源码逐文件读取（路径标注为 `repo 相对路径`），无臆测接口

---

## 候选 1：opencode session-ui（SolidJS）+ web 分享页

仓库 `anomalyco/opencode`（monorepo）。**许可证：MIT 已核原文**——根 LICENSE「Copyright (c) 2025 opencode」；`packages/session-ui/package.json`、`packages/web/package.json`、`packages/ui/package.json` 均声明 `"license": "MIT"`。

### ① 消息/part 数据模型 ↔ audit 六类映射难度：中低

权威定义 `packages/schema/src/v1/session.ts`（Effect Schema 判别联合）：

- **Part 联合 12 类**：`TextPart | SubtaskPart | ReasoningPart | FilePart | ToolPart | StepStartPart | StepFinishPart | SnapshotPart | PatchPart | AgentPart | RetryPart | CompactionPart`（discriminator `type`）。
- **ToolState 四态判别联合**（discriminator `status`）：
  - `pending`：`{ input, raw }`（参数流式解析中）
  - `running`：`{ input, title?, metadata?, time.start }`
  - `completed`：`{ input, output, title, metadata, time.{start,end,compacted?}, attachments? }`
  - `error`：`{ input, error, metadata?, time.{start,end} }`
- **流式事件契约**：`message.part.updated`（整 part 替换）、`message.part.delta`（`{partID, field, delta}` 字符串增量）、`message.part.removed`（同文件 events 定义）——「part 级 upsert + 字段级 delta」，与 spec §3 增量渲染同构。
- 消息级 `Assistant` 自带 `time.completed/cost/tokens/error`（判别联合：APIError/AuthError/AbortedError/ContextOverflowError/ContentFilterError…）。

映射结论：`tool_call`→ToolPart **四态一一对应零适配**；`model`→text/reasoning/step-start/step-finish；`gate/lifecycle/governance/loop` + docs/evidence→**无原生类型**，需自定义 part kind（借其判别联合模式自持 TS union，不动其 Effect Schema——后者是后端依赖）。

注：任务上下文提及的 `groupParts` 在当前 master 已无此符号（全库检索无命中）；分组现落在 `session-ui/src/components/session-turn.tsx` + `tool-count-summary.tsx`（按轮聚合工具条）与 `web/src/components/Share.tsx` 内联 `filteredParts`（step-start 仅保留首条、隐藏 pending/running 工具、隐藏空 text 与 synthetic text）。

### ② 流式渲染实现质量：高（三方最佳）

- **增量追加**：`packages/web/src/components/Share.tsx`——WebSocket `share_poll` 按 key 路由 `session/info|message/<id>|part/<id>`，part 数组按 id upsert（`setStore("messages", messageID, "parts", arr => ...)` + `reconcile`）；含 v1→v2 `fromV1()` 映射层（旧 `tool-invocation` 三态→新四态的转换实例，可作我们 reducer 的参照）。
- **流式 Markdown**：`session-ui/src/components/markdown-stream.ts` 为**纯 TS 模块**（仅 import marked + remend，零框架依赖）：`project(previous, text, live)` 输出稳定块（`full`/`code`）+ 活动尾块（`live`），代码围栏增量续写不重排（`closesFence` 判定），未闭合围栏特殊处理；配套 `markdown-projection.ts`/`markdown-worker.ts`（Web Worker 全套带测试）。
- **四态工具条**：`session-ui/src/components/basic-tool.tsx` `BasicTool`：pending/running 用 `TextShimmer` 微光标题且禁止展开（`handleOpenChange` 拦截 pending）；`defer` + rAF 延迟挂载重内容（`scheduleDeferredMount` 自底向上）；motion 弹簧高度动画；`GenericTool` 用 `label()/args()` 从任意 input 提取展示键值。
- **长输出折叠**：`session-ui/src/components/part-default-open.ts`（纯 TS）——bash 默认收起、edit/write/patch 默认收起且「纯删除 diff 强制收起」；分享页 `ResultsButton`（show/hide results 折叠）+ `ToolFooter` 耗时脚注（`MIN_DURATION = 2000`，>2s 才显示）。
- 高亮：shiki + `@shikijs/stream` 流式高亮。

### ③ 框架匹配度：低（Solid → Vue = 组件逐个重写）

组件全部 Solid `.tsx`（createSignal/createMemo/Show/For/Switch + kobalte）。但两样东西**框架无关**：
1. 纯 TS 逻辑模块：markdown-stream、part-default-open、message-part-text、session-diff；
2. **样式**：独立 `.css` 文件（basic-tool.css、message-part.css…），选择器全基于 `data-component`/`data-slot` 属性而非工具类框架——移植零框架耦合（本次调研最重要的意外收获）。

### ④ 许可证：MIT（根 LICENSE + 三包声明，均已核原文）

### ⑤ 依赖体积与外网依赖

- session-ui 运行时依赖 20+：`@kobalte/core`、shiki 三件套、motion、morphdom、remeda/remend、luxon、marked、diff、dompurify、fuzzysort、strip-ansi、solid-list、4×@solid-primitives，以及 workspace 内部件（`@opencode-ai/core/sdk/ui` + vendored `@opencode-ai/client` tgz）。
- `@opencode-ai/ui` 再带 katex、solid-sonner、tailwind 样式出口、字体/图标 sprite。
- session-ui **`"private": true` 未发 npm**——只能抄源码；无 CDN 运行时依赖（全 npm，可内网镜像）；shiki 体积需 worker+按需裁剪控制。

### ⑥ 抽出复用真实工程量

- **整包抽到 Vue**：重写全部 .tsx + 重实现 @opencode-ai/ui 的 Collapsible/Icon/TextShimmer + 替换 @pierre/diffs + 剥离 workspace 依赖 → **30–60 人日**，且永久背离上游。
- **只借数据模型 + 纯 TS 模块 + CSS 语义**：自持 SynthiaPart 类型联合 + markdown-stream 移植 + 按其 CSS 语义重写四态工具条 → **3–6 人日**并入现有 Vue 代码。

### 可行性评分

- 直接复用（抽组件进 Vue）：**低**——跨框架 + monorepo 私有耦合 + 20+ 传递依赖。
- 借鉴模式自研（模型/纯模块/样式语义）：**高**——①②④⑤ 的精华均可低成本吸收。

---

## 候选 2：DeepSeek 官方前端（deepseek-harness / dsh）

**事实修正：DeepSeek 有官方开源前端。** `deepseek-ai/deepseek-harness`（2026-08 开发者预览，版本线 `0.1.0-rc.5`）。**许可证：MIT 已核原文**（根 LICENSE「Copyright (c) 2026 DeepSeek」；`apps/web/package.json` 亦声明 MIT）。前端 = `apps/web`（Vite 壳，`react ^18.2.0` + `@vitejs/plugin-react`）+ `packages/client/` 下约 40 个 UI 插件包（ui-conversation/ui-tool/ui-trajectory/ui-plan/ui-goal/ui-skill/ui-jobs/ui-workflow-run/ui-subagent…）。

### ① 数据模型 ↔ audit 映射难度：低（贴合）但不可移植

`packages/client/ui-conversation/src/client/conversation-nodes/tool.ts`：durable 事件 `tool/call`（start）/ `tool/result`（update，按 callId 配对）/ `tool/code-dispatch(-start)`（递归子调用），`ConversationNodeDefinition` 以 `match/start/update/buildViewNode` 把事件流折叠为节点，seq 定序 + turn/step Location——**与 audit 六类事件折叠同构**（含 MAX_DEPTH=256 环防护、WeakMap 投影缓存等防御细节）。但折叠器运行在 cordis 插件 Context 上（`ctx.conversationEvents.register`、声明合并 `ChatNodeDataMap`、`useProjection` 投影），无独立纯函数边界，抽走即散架。

### ② 流式渲染质量：高（工程深度极高）

`packages/client/ui-conversation/README.md`（规格书级）+ `apps/web/tests/` e2e 清单证实：流式尾隔离、`use-throttled-visual-update.ts` 视觉节流、Think 行折叠跟随、Compaction 折叠行、**QueueDock 排队消息（「<n> 条排队消息」折叠 + 逐条 strict-steer + FIFO 整队 steer）**、**steering 气泡以用户气泡样式落在流中**、**ApprovalPanel 审批接管 composer（amber 条 + refuse/allow + 驳回理由）**、重试投影为单行状态。与 v3 spec §3「可插话/入队/打断标记卡」、§5「审批抽屉」语义逐条对得上——**最佳行为规格参照物**。

### ③ 框架匹配度：低（React 18 + cordis「一切皆插件」）

组件经 slot 注册（`ctx.slots.register`）与声明合并类型表组装；抽任何一块都要连 cordis runtime 一起搬。Vue 复用 = 100% 渲染重写 + 架构翻译。

### ④ 许可证：MIT（已核原文）。注意 `THIRD_PARTY_NOTICES.md` 与 `vendor/`（cordis 系）声明，若抄代码需遵其第三方条款。

### ⑤ 依赖体积与外网依赖

React 18 + 40 个 workspace 包 + vendored cordis；样式 = CSS Modules + `--dsw-*` 令牌（`docs/web-styling.md`：明确「CSS Modules 和 clsx，不加组件库与 Tailwind」）。无 CDN 依赖。`0.1.0-rc.5` 预览版、API 高速变动（决策笔记时间戳集中在近两周）。

### ⑥ 抽出工程量：不可抽取（只能读不能搬）；抄行为语义需自建数据通路。

### 可行性评分

- 直接复用：**低**（React + 预览版 + 插件架构三重不匹配）。
- 作为行为规格参照：**高**——实现 v3 §3 插话/打断与 §5 审批抽屉前，建议通读其 ui-conversation README 与 `apps/web/tests/{steering,queue-actions,approval-composer,subagent-interrupt}.e2e.ts`。

---

## 候选 3：assistant-ui + Vercel AI SDK useChat 生态

### 3a. assistant-ui

仓库 `assistant-ui/assistant-ui`，LICENSE = **MIT**（「Copyright (c) 2025 AgentbaseAI Inc.」，已核原文）。40+ 包 React 生态（react/react-ai-sdk/react-markdown/react-opencode…），无头原语 + Radix/Tailwind 样式体系。

- **③ 框架匹配度（关键否决项）**：仓库确有 `packages/vue/`（`@assistant-ui/vue`）与 `examples/with-vue`，**但其 package.json 为 `"version": "0.0.0"` + `"private": true`，README 首行明言「Not published yet. This package is the in-repo preview of the Vue bridge and stays private until the Vue integration is complete.」**，且要求 vite alias 把 `react` 映射到 `@assistant-ui/tap/standalone-shim`。→ **今天无法作为 npm 依赖引入**。
- ① 模型映射：external-store 适配器模式，任意数据源可接；React 组件不可用使其对当前无意义。
- ⑤ 依赖：React + Radix + Tailwind 体系，与内网自研组件栈冲突。
- **评分：低（现状）/ 中（Vue 桥正式发布后重评——其 Thread/Message/Composer/BranchPicker 无头原语集与 v3 需求吻合）**。

### 3b. Vercel AI SDK（`ai` + `@ai-sdk/vue`）

仓库 `vercel/ai`，LICENSE = **Apache-2.0**（已核原文；商用保留版权声明即可，内网部署无障碍）。`packages/vue/package.json`：`@ai-sdk/vue` **已正式发布**（4.0.22，peer `vue ^3.3.4`，依赖仅 `ai` + `swrv` + provider-utils，node>=22 仅构建期约束）。

- **① 模型映射：中高。** `packages/ai/src/ui/ui-messages.ts`（权威源码）：`UIMessagePart` 联合 11 类（text/reasoning/file/reasoning-file/source-url/source-document/`tool-${name}`/dynamic-tool/`data-${name}`/custom/step-start）；**工具状态 7 态**：`input-streaming`、`input-available`、`approval-requested`、`approval-responded`、`output-available`（含 `preliminary` 预发标志）、`output-error`、`output-denied`——**审批（HITL）是一等工具状态**，与「门审批等待/批准/驳回」可直接对齐；`text.state: 'streaming'|'done'` 支持增量。gate/lifecycle/governance/loop/docs/evidence 走泛型 `data-${name}` 自定义 part（类型安全）。旁证：opencode v2 消息模型正在向它收敛（`packages/opencode/src/session/message-v2.ts` 直接 import `convertToModelMessages`/`UIMessage` from "ai"），它是行业收敛点。
- **② 流式：数据层有、渲染层无。** `packages/vue/src/use-chat.ts`（已读全文）：`VueChat extends AbstractChat`，shallowRef + triggerRef 的 ChatState（pushMessage/popMessage/replaceMessage），暴露 sendMessage/regenerate/stop/resumeStream/**addToolOutput/addToolApprovalResponse**。渲染完全自理——对我们没有组件可抄。
- **③ 框架匹配度：高（官方 Vue 支持，AI SDK 5 起一等公民）。**
- **④ 许可证：Apache-2.0。**
- **⑤ 依赖：** `ai` 包本体较大（含 provider 层）；无 CDN 运行时依赖。**但传输层假定 AI SDK UI 消息流协议（SSE UIMessage chunk）或自定义 ChatTransport**——v3 的 3s 轮询模式下 useChat 的流式机制基本用不上，只能当「类型 + 本地状态容器」用，与现有 pinia + 轮询客户端功能重叠。
- **⑥ 工程量：** 轮询期引入 = +3–5 人日（类型/胶水）但收益有限；真到 SSE 阶段，若后端肯产出 UIMessage chunk 协议（或写 ChatTransport 适配 audit SSE），它就是现成的规范协议与 Vue composable，届时再引入。

### 可行性评分

- assistant-ui：**低**（Vue 桥未发布；React 组件跨框架不可用）。
- @ai-sdk/vue：**中**（官方 Vue + Apache-2.0 + 模型先进；但轮询期收益小、依赖偏重、传输协议不匹配，宜 SSE 切片时再评）。

---

## 最终建议：**借鉴模式自研**（borrow patterns, build in Vue）

**不整库复用任何候选**（三者组件层均不可入 Vue：Solid/React/React-cordis）；**不纯自研闭门造车**。推荐分三层吸收：

1. **数据层（抄 opencode 的形，借 AI SDK 的词表）**：自持 `SynthiaPart` 判别联合 TS 类型——
   - `tool` part 四态照抄 opencode `ToolState`（pending/running/completed/error，含 time.start/end 满足 spec「四态+耗时」）；
   - `text` part 带 `state: 'streaming'|'done'`（AI SDK 词表）；
   - gate/lifecycle/governance/loop/docs/evidence 定义为自定义 part kind（AI SDK `data-*` 的思路 + opencode 判别联合的形），audit→part 的折叠写成**纯函数 reducer**（参照 opencode part-upsert 语义与 deepseek ConversationNodeDefinition 的 match/start/update 折叠模式），配单测。
2. **纯逻辑模块直接移植（MIT，保留版权声明）**：opencode `markdown-stream.ts`（流式 Markdown 块投影，我们已用 marked，适配成本极低）、`part-default-open.ts`（折叠默认值语义，对齐 spec §3「工具原始输出默认折叠」）。
3. **样式与交互语义**：opencode 的 `data-component`/`data-slot` 属性选择器 CSS 模式 + BasicTool 的 pending 微光/延迟挂载；deepseek harness 的 queue/steer/approval 行为规格（实现前通读其 README 与 e2e）。
4. **SSE 切片时重评 @ai-sdk/vue**：若 Runtime 侧产出 UIMessage chunk 协议，官方 Vue composable + 工具审批状态机可直接采用。

### 工程量对比表（对话流 v3 核心范围：part 折叠 reducer + 四态工具条 + 流式 MD + 审批抽屉 + 状态带）

| 路径 | 预估工程量 | 主要风险 | 结论 |
|---|---|---|---|
| A. 整包抽 opencode session-ui 到 Vue | 30–60 人日 | 重写全部 Solid 组件 + @opencode-ai/ui 依赖 + 私有包耦合，永久背离上游 | ✗ 否决 |
| B. 借鉴模式自研（推荐） | **8–15 人日** | 自担流式折叠边界（靠移植 markdown-stream + reducer 单测压住） | ✓ 采用 |
| C. 纯自研（不看参考） | 15–25 人日 | 重踩流式围栏/四态/折叠全部坑 | ✗ 无必要 |
| D. assistant-ui（React） | = 换框架重写全站 | Vue 栈作废 | ✗ 否决 |
| E. @ai-sdk/vue 数据层（轮询期引入） | +3–5 人日 | 依赖偏重、传输协议不匹配、与 pinia 重叠 | △ 缓议（SSE 期再评） |
| F. deepseek-harness | 不可抽取 | 仅作行为规格参照 | △ 参照物 |

B 路径拆解（粗粒度）：part 模型 + audit reducer（2–3 天）｜四态工具条 + 折叠 CSS（2–3 天）｜markdown-stream 移植 + 接 marked（1–2 天）｜审批抽屉 + 状态带（3–4 天，复用现有 web/src/domain/unified.ts 审批域逻辑与 gates.ts）｜可插话/打断标记卡（1–2 天，参照 deepseek steering 语义）。

### 六维速查矩阵

| 维度 | opencode | DeepSeek dsh | assistant-ui | @ai-sdk/vue |
|---|---|---|---|---|
| ① audit 映射 | 中低（工具四态零适配；六类需自定义 part） | 低难度但不可移植（事件折叠同构） | 中（Vue 桥不可用） | 中高（data-* 全可装，工具 7 态含审批） |
| ② 流式质量 | 高（delta+upsert+纯 TS 流式 MD） | 高（尾隔离+节流+队列/steer） | 高（React） | 数据层高、无渲染 |
| ③ Vue 匹配 | 低（Solid） | 低（React+cordis） | 低（React；Vue 桥未发布） | 高（官方） |
| ④ 许可证 | MIT（已核） | MIT（已核） | MIT（已核） | Apache-2.0（已核） |
| ⑤ 依赖/内网 | 20+ 依赖、session-ui 未发 npm、无 CDN | 40 包+vendor、无 CDN | React+Radix+Tailwind | ai+swrv、无 CDN |
| ⑥ 抽出工程量 | 借鉴 3–6 天 / 整包 30–60 天 | 不可抽取 | 换框架 | 轮询期 3–5 天收益小 |

### 残留风险与后续动作

1. opencode session-ui 为 `"private": true` 源码级借鉴：抄代码文件（markdown-stream 等）须保留 MIT 头与来源注释；只借模式则无义务。
2. deepseek-harness 处于 rc 快速变动期：其 README 行为规格按快照理解，勿依赖其实现细节。
3. assistant-ui Vue 桥与 @ai-sdk/vue 的演进值得在 v3 SSE 切片立项时做一次 30 分钟重评（检查 @assistant-ui/vue 是否已发布、@ai-sdk/vue 是否仍与 vue 3.5 兼容）。
