# Synthia 前端重写规格（v4 · 历史版本）

- 状态：**部分替代**；用户可见产品模型以 [`product-baseline-v1.md`](product-baseline-v1.md) 为准
- 分支：`feat/projects-page-rewrite`
- 前身：v3（`UnifiedProjectView.vue` 单页对话流）——本版**推翻其信息架构**，不是增量修改
- 对齐轮次：2026-08-17 / 08-18 与 owner 逐轮确认，决策见 §1
- 后端契约已逐条核实，见 §6（与初稿的出入已在正文修正）
- **2026-08-18 增补**：D24–D26（agent 分层）+ §1.1 模型 + §3.7 前端落地 + §8 第三批；D17 由 D24 取代
- **术语**：本版起 agent 会话统一称 **agent**，不再叫 run；`run_class` / `ToolRun` 仍指 Vivado 工具执行，**是另一个概念**，未改

> **基线说明（2026-08-20）**：三栏工作台、编辑器和审批交互仍可参考；D24–D26 的“正式道/探索道/多 Agent 切换器”不作为用户界面模型。用户看到一个主 Agent 和侧边探索任务；工程项目只有一条正式推进线，自由项目不显示强制阶段条。流程和阶段由项目选择的版本化 profile 决定，首版为精简 G0～G4。

---

## 1. 已对齐的决策

| # | 议题 | 决策 |
|---|---|---|
| D1 | 重写范围 | **整个前端 `web/`**——路由、样式系统、登录、审批页一并重做 |
| D2 | 重写动机 | 信息架构错了 + 交互流程不顺 + 视觉质感差（三者并列） |
| D3 | 目标用户 | 工程师与评审者**同一个页面**，同一人不同时刻切换身份 |
| D4 | 页面主心骨 | **三栏：文件树 \| 代码编辑器 \| 对话**，阶段进度提升至顶栏 |
| D5 | 选此形态的原因 | 后期需**嵌入自研工业软件**，此形态与最终目标最契合 |
| D6 | 两种机制关系 | **闸口流程是本体，free-agent 是内部引擎** |
| D7 | 阶段链模板 | 多套模板、建项目时选（**后端暂不支持，见 R1**） |
| D8 | 审批位置 | 页内可批 + 另有跨项目待办列表 |
| D9 | 编辑器可写性 | **可直接编辑并保存** |
| D10 | 文件树组织 | 文件路径为主 + 可切换视图（产物类型 / 阶段） |
| D11 | 证据位置 | 编辑器**下方面板**（IDE 终端区形态） |
| D12 | 保存语义 | 存为**新候选版本**（走现有 revision 链，作者=人类） |
| D13 | 第一轮范围 | 先做**能跑的骨架** |
| D14 | 旧代码处置 | UI 全推，**保留 `domain/` 纯逻辑** |
| D15 | 主题 | **双主题可切换** |
| D16 | 编辑器实现 | **Monaco Editor** |
| ~~D17~~ | ~~多任务~~ | ~~任务切换器，后台并行~~ → **已由 D24 取代**：并行仍成立，但 agent 分两道，切换器按道分组，见 §1.1 |
| **D18** | **阶段条显示** | **PC：里程碑门为主、中间阶段折叠成段；移动端：只显示当前阶段，全览开弹层** |
| **D19** | **人机写冲突** | **agent 运行时编辑器锁定为只读**，idle 时才可编辑（R2 由此关闭） |
| **D20** | **视觉参考** | **Claude 风格**——简约明了，暖中性底色 + 克制的强调色 |
| **D21** | **运行中发言** | **如实叫「插话 / 纠偏」**，不伪装成排队；另给「打断」按钮走 abort |
| **D22** | **密度取舍** | **Claude 的色，IDE 的密度**——配色/圆角/留白学 Claude，字号行高按工具走 |
| **D23** | **第一批边界** | **只做 §8 的 1–5 步**：先把形态立起来验证，确认后再做 6–9 |
| **D24** | **agent 分层** | **一个项目可并行多个 agent，但分两道**：探索道（数量不限、隔离、可弃、产出**不进**受控产物集）/ 正式道（每个「段声明」至多 1 个、产出**即**受控产物集、**只有它能提门**） |
| **D25** | **隔离方式** | **worktree 式副本隔离只用于探索道**；正式道直接在受控产物集上工作，不隔离 |
| **D26** | **闸口语义** | **闸口是选举，不是合并**——基线之间没有合并代数。探索成果必须先「**采纳**」进正式道，再由正式道提门 |

> D24–D26 是 2026-08-18 关于「一个项目如何走完全部里程碑」讨论的收敛结果，模型展开见 **§1.1**，前端落地见 **§3.7**。

### 1.1 agent 分层模型（D24–D26 展开）

#### 1.1.1 问题

`Claude Code` 式的做法是「一个仓库开很多 agent，各自 worktree，最后 merge 回主干」。这套在 Synthia 上**直接照搬会塌**，因为终点不是 merge，是**过门建基线**：

- 基线（`baseline`）是**被审批签字的一组产物版本的快照**，`memberRevisionIds` + `manifestHash` 一起构成不可分割的整体
- 两条 worktree 各自改了 RTL，**没有任何合并算法**能把两个已签字的快照合成第三个仍然「被签过字」的快照——签字是对**那一组具体版本**的签字
- 所以 worktree 模型的收敛动作（merge）在这里**不存在**

竞品对照：Claude Code / Cursor / Devin 这类都停在「代码合并」层，没有签字-基线概念，因此 merge 就是终点；航天/汽车侧的 PLM/ALM（Windchill、Polarion、Codebeamer）有基线概念，但把并行探索完全挡在受控库之外——工程师在本地随便玩，**受控库里永远只有一条线**。Synthia 要的是两者都要：探索的自由 + 受控的单线。D24 就是这个折中。

#### 1.1.2 两个词

| 词 | 含义 | 落到数据上 |
|---|---|---|
| **前提**（premise） | 这个 agent 是**从哪个基线出发**工作的 | `fromBaselineId` |
| **主张**（claim） | 这个 agent 打算**把哪个门推过去** | `targetGate` |

**核心不变量**：

> 一个 agent 的产出，**只有在它的前提仍是 active 基线时**，才允许提交到门。

前提被别人换掉（`baseline.state` 从 `active` 变成 `superseded`）→ 这个 agent 的工作**过期**，必须 rebase（换前提重跑）或作废。这是整套并行模型唯一的强制约束，其余都是 UI 约定。

#### 1.1.3 两条道

| | 探索道 exploratory | 正式道 formal |
|---|---|---|
| 数量 | 不限 | **每个（前提, 主张）至多 1 个** |
| 工作区 | **副本隔离**（worktree 式，D25） | 直接在受控产物集上 |
| 产出去向 | 隔离区，**不进** artifact/revision 受控链 | **就是** artifact/revision 受控链 |
| 能否提门 | **否** | 是 |
| 结束方式 | 被**采纳** / 被丢弃 | 过门 / 被驳回 / 前提过期 |
| 对应 `run_class` | `exploratory` | `gate_check` / `formal` |

> 领域层已经在说这套话了：`core/src/domain/enums.ts:70` 的 `RunClass = "exploratory" | "gate_check" | "formal"`。D24 只是把它从「工具运行的分级」提升为「agent 的分道」。

#### 1.1.4 采纳（adopt）——两道之间唯一的通道

探索道 → 正式道**不是 merge，是复制**：

1. 人选中某个探索 agent 的产出
2. 把它选中的文件，以**新候选版本**（`POST .../artifacts/:aid/revisions`，走 D12 的 revision 链）写入正式道
3. 作者是**人**（`created_by = identity.actorId`），理由字段写明「采纳自 agent `<id>`」
4. 探索 agent 落到终态 `adopted`，其余竞争者落 `discarded`

采纳是**人的动作**，不是自动的。理由：这是唯一把非受控内容送进受控链的入口，必须有人签名。

#### 1.1.5 三种冲突形态与处置

| 形态 | 场景 | 处置 |
|---|---|---|
| **A. 同段竞争** | 两个 agent 都想推 G4 | 探索道随便并行；正式道抢占——第二个只能建成探索道，或等第一个终结 |
| **B. 前提过期** | agent 从 B1 出发，期间 B1 被 B1' 取代 | 提门时**拒绝**（前提非 active）；UI 提示「基线已更新，[重新对齐] [作废]」 |
| **C. 跨段并行** | 一个推 G3、一个推 G4 | 允许，但 G4 的前提必须是 G3 已产出的基线；G3 若被驳回，下游 agent 自动落入形态 B |

**不做的事**：不做基线合并、不做三路 diff 自动融合、不做「两个 agent 各批一半」。

#### 1.1.6 已知后端缺口（实现前必须处理）

按当前 `core/` 源码核实，这四项都还不成立：

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| **B1** | agent 会话**完全不落 Core**，只活在 Runtime 的 `AgentState` | `core/src/api/task-proxy.ts` 全程转发不落库 | `premise` / `claim` 没有存放处，跨会话不可查 |
| **B2** | `process_instance.current_gate` 写死 `'G0'` 后**再无任何代码路径更新它** | 建库时一次写入，全仓无 UPDATE | 项目里程碑**不能**读这个字段，只能从 `GET .../baselines` 反推 |
| **B3** | `baseline` 同时有 `(project_id, kind) WHERE state='active'` 唯一索引**和**无条件 append-only 触发器 | `0002_approval_slice_hardening.sql:57-62` / `:79-80`；触发器函数 `0001_d1_hardening.sql:42-47` 无列豁免 | **换基线当前物理上做不到**——旧行改不成 `superseded`，新行插不进去。根因：`superseded_by_baseline_id` 挂在**旧行**上指向前方，append-only 要求方向反过来（新行上放 `supersedes_baseline_id`） |
| **B4** | `POST /tasks` 只校验 `project_id` 存在，**不查同项目是否已有活跃 agent** | `runtime/server.ts` 创建分支 | D24「正式道至多 1 个」**无处强制** |

> B3 是这四项里唯一的**结构性**缺陷：不修，项目连第二个里程碑都建不起来，D24 之上的一切都是空谈。修法是一次迁移（反转列方向 + 给触发器加列豁免），不在本 spec 范围，另立切片。



---

## 2. 布局

```text
┌────────────────────────────────────────────────────────────────┐
│ ◂ UART控制器   ①━━G1━━━◆━━G3━━━━━◆ ○G4   [任务▾] ☀/☾ ⚙ 👤 │  顶栏
├──────────────┬──────────────────────────────┬──────────────────┤
│ 文件树        │ uart_tx.v      v3·已批准·只读 │ 💬 对话           │
│ [路径▾]      │ ──────────────────────────── │                  │
│              │  1 module uart_tx (          │ 🤖 按 AXI 规范   │
│ 📁 rtl/      │  2   input  clk,             │    拆了三个模块   │
│   uart_tx.v ✅│  3   input  rst_n,           │  ▸ fpga-rtl-build│
│   uart_rx.v ✅│  4   output reg tx,          │  ▸ 写入 uart_tx.v│
│   baud_gen.v✅│  5 );                        │                  │
│ 📁 tb/       │  6                           │ 🤖 综合通过 ✅   │
│   uart_tb.sv🔵│  7 reg [3:0] state;          │                  │
│ 📁 doc/      │  8 always @(posedge clk) …    │ ⚠ 待你批准：      │
│   架构设计.md✅│                              │   进入仿真阶段    │
│ 📁 prj/constr│ ─────────────────────────────│  [ 批准 ][ 打回 ] │
│   uart.xdc 🔵│ ▸ vivado synth   ✅  12.4s   │                  │
│              │ ▾ xsim 仿真      ⏳ 运行中    │ 💬 说点什么…  [↑]│
│              │   INFO: 波特率误差 0.16%     │                  │
└──────────────┴──────────────────────────────┴──────────────────┘
   240px              flex: 1                      380px
```

| 区域 | 职责 | 数据源 |
|---|---|---|
| 顶栏 | 项目名、阶段进度、任务切换、主题、用户 | `GET /projects/:id` + `GET .../tasks` + `GET .../gate-submissions` |
| 左栏 | 产物导航，三种视图可切 | `GET .../artifacts` + `GET .../artifacts/:id/revisions` + **`GET .../tasks/:agentId` 的 `docs[]`**（path/phase 只在这里） |
| 中栏上 | Monaco 编辑器 | `GET .../artifacts/:aid/revisions/:rid/content` |
| 中栏下 | 工具运行与证据面板 | `GET .../jobs` + `GET .../jobs/:jid/evidence` + `?name=` 取内容 |
| 右栏 | 对话流 + 就地审批 | SSE `GET .../tasks/:agentId/stream` + `POST .../message` |

> ⚠️ 左栏的关键依赖：`artifact` 对象只有 `id / artifact_type / created_at`，**没有 path 和 phase**。三种视图的分组键必须从 task 详情的 `docs[]`（`TaskDocRef`）取，需把两边按 artifact id 关联。

---

## 3. 各区细则

### 3.1 顶栏 · 阶段进度条（D18）

数据驱动，单一来源 `web/src/domain/process-profile.ts` 导出 `ProcessProfile { id, name, nodes: StageNode[] }`。第一轮只有 `fpga-full` 一套，值取自 `domain/tasks.ts:25` 的 `STAGE_CHAIN`（15 节点）。

**链上的门只有 G1 / G2 / G3 / G4**，其中里程碑门是 **G1 / G3 / G4**（G2 是普通门）。`gates.ts:19` 里的 `MILESTONE_GATES` 含 G7/G9，但那两个**不在执行阶段链上**，顶栏不显示。

PC 端分三段，里程碑门为锚点：

| 段 | 中间阶段（折叠） | 终点门 |
|---|---|---|
| 1 | `intake` | **G1** 需求评审 |
| 2 | `behavior_wave · G2 · architecture · register_spec`（4） | **G3** 设计评审 |
| 3 | `rtl · validate · tb · simulate · xdc · synthesize · implement`（7） | **G4** 实现评审 |

- 折叠段渲染为一条带进度的短轨（如 `设计 3/4`），hover 展开浮层列出该段全部节点及状态
- 门节点用实心菱形 ◆ 加重，hover 显示门编号与门名
- 移动端（<768px）：顶栏只渲染一行 `③ RTL 编写 · 进行中 · 8/15`，点击开全屏弹层看完整阶段图
- 节点五态 `done / running / waiting / pending / failed`，沿用 `tasks.ts:88` 的 `deriveStageChain`
- 点击阶段节点 → 左栏切「阶段视图」并定位到该阶段产物组
- 任务切换器：列出 `GET .../tasks` 的全部 agent，切换后对话流与阶段条同步换源，其他 agent 后台继续

### 3.2 左栏 · 文件树（D10）

三种视图，默认「路径」：

| 视图 | 分组键 | 说明 |
|---|---|---|
| 路径（默认） | `TaskDocRef.path` 目录前缀 | `rtl/ tb/ sim/ doc/ prj/constr/`，遵循 `skills/fpga/rules/25-workspace-layout.md` |
| 产物类型 | `artifact_type` | 用 `domain/artifacts.ts:artifactGroupName` 取中文名 |
| 阶段 | `TaskDocRef.phase` | 与顶栏阶段条一一对应 |

- 文件右侧状态点：`✅ 已批准` / `🔵 候选` / `⚠️ 已驳回` / `⊘ 已作废`（映射 `ArtifactRevisionState`）
- 多 revision 时树上显示最新版，版本历史在编辑器顶部下拉
- 空分组默认隐藏（D22 简约取向）

### 3.3 中栏上 · Monaco 编辑器（D9 / D19）

- 语言：Verilog / SystemVerilog / TCL / Markdown / XDC(→tcl) / JSON / YAML
- **三种可写状态**：
  | 状态 | 条件 | 顶部提示 |
  |---|---|---|
  | 只读·已批准 | revision 已批准 | `v3 · 已批准 · 只读` |
  | 只读·agent 运行中 | 当前 agent 非终态 **(D19)** | `agent 正在工作，暂不可编辑` |
  | 可编辑 | 候选 revision 且 agent idle | 改动后出现 `[保存为 v4]` |
- **保存**：`POST /api/v1/projects/:id/artifacts/:aid/revisions`
  - 必带 **`Idempotency-Key` 请求头**
  - body：`{ id, version: n+1, content, expected_version: n, change_reason, parent_revision_id }`，服务端算 sha256
  - **作者取自鉴权上下文**（`created_by=identity.actorId`），不放 body
  - 乐观锁冲突 → **409 `REVISION_VERSION_CONFLICT`** → 弹「远端已更新至 v5，[查看 diff] [覆盖] [放弃]」
- 版本对比：顶部下拉选两版进 Monaco 原生 diff editor
- `.md` 默认渲染视图，`[源码/预览]` 切换

### 3.4 中栏下 · 证据面板（D11）

- 可折叠，**默认折叠**（D22 简约取向），展开后默认 180px，可拖拽
- 列 `GET .../jobs`：`operation / runClass / state / 耗时 / errorCode`
  - ⚠️ **没有退出码字段**，只有 `errorCode`；耗时前端用 `endTime - startTime` 自己算
- 展开一条 → `GET .../jobs/:jid/evidence` 拿清单，点条目 `GET .../jobs/:jid/evidence/content?name=<name>` 拉内容
- ⚠️ **非终态 job 请求证据返回 404**（"evidence not available: job not terminal"）。因此 **agent 运行中的实时输出只能来自 SSE 的 tool part 事件**，不能轮询 evidence 端点
- 错误行可点击 → 能解析出 `文件:行号` 时跳转编辑器对应位置

### 3.5 右栏 · 对话 + 就地审批（D21）

复用 v3 已验证的流式能力：`domain/parts.ts`（audit→时序 part）、`domain/task-stream.ts`（SSE 订阅 + 断线退避 + `Last-Event-ID` 续传）、`domain/markdown-stream.ts`（增量 markdown）、`domain/reply-segments.ts`（>15 行代码折叠为卡片）。严格回合制排序（v3 已修，`8b81173`）。

- 产物卡点击 → **不再弹抽屉**，改为在中栏编辑器打开（三栏相对 v3 的主要收益）
- **就地审批**：`awaiting_approval` 时对话流底部出现审批卡
  - 待审产物列表 → 点击在中栏打开阅读
  - 里程碑门按钮写明后果：「✓ 批准并建立 B2 里程碑」
  - 驳回理由必填（后端强制非空，非 `in_review` 态返回 409）
  - `POST .../gate-submissions/:subId/approve`：body 需 `configuration_snapshot_id, approved_gate_result_id, approver_role, check_results_hash, signed_at, signature_method, baseline_id`（里程碑门必填 `baseline_id`）、`reason?`
- **输入区**（D21，如实反映 steer 语义）：
  | agent 状态 | 输入框文案 | 行为 |
  |---|---|---|
  | idle / 终态 | `说点什么…` | `POST .../message` → 触发新一轮 `session.prompt`，走 SSE 拿结果 |
  | running | `插一句（当前步骤结束后生效）` | `POST .../message` → `session.steer(text)`，同步返回，下一个工具调用结束后生效 |
  - 插话发出后在对话流里渲染为一条带 `↗ 纠偏` 标记的消息，视觉上与普通用户消息区分
  - running 时另给 `⏹ 打断` 按钮 → `POST .../tasks/:agentId/abort`
  - **不使用"排队"措辞**——steer 不保证按顺序逐条送达

### 3.6 跨项目待办列表（D8）

- 路由 `/inbox`，替代现有 `/approvals`
- ⚠️ **后端无跨项目聚合端点**（已核实）。前端先 `GET /projects` 拿列表，再对每个项目并发 `GET .../gate-submissions?state=in_review`，本地合并
- 每条：项目名 · 门 · 待审产物数 · 等待时长
- 点击 → `/projects/:id?sub=<subId>`，落地即打开该审批
- 项目数上百时此方案会退化 → 届时向后端提聚合端点（见 R6）

### 3.7 双道在各区的体现（D24–D26）

**治理原则：正式道是主视图，探索道是叠加层。**

页面**默认永远显示正式道**——文件树、编辑器、阶段条、审批卡，全都只反映受控产物集。探索道不是另一个页面，是套在同一个三栏上的一层「对比态」。类比：主分支视图 vs `与分支对比` 模式。

这条原则的收益是**几乎不需要新组件**——已有各区加一层状态即可。

#### 3.7.1 各区改动

| 区域 | 正式态（默认） | 探索叠加态 | 改动量 |
|---|---|---|---|
| **StageRail** | 数据源从「当前 agent」改为**项目级**（由 `GET .../baselines` 推导，见 B2） | 不变——探索 agent **不影响**阶段条 | 中：换数据源 |
| **TaskSwitcher** | 扁平列表 | **两段式分组**：`正式` 段（0–1 条，置顶，带前提/主张）+ `探索` 段（N 条，带来源前提） | 中：分组 + 副标题 |
| **FileTree** | 受控产物 + 状态点（§3.2） | 每个文件追加 diff 角标 `~M` 改动 / `+A` 新增；未改动的文件淡化 | 小：多一个角标位 |
| **CodeEditor** | 单文件视图 | **默认进 Monaco 原生 diff**（左=正式道当前版，右=探索产出）——D16 已引入的能力，直接复用 | 小：切 `createDiffEditor` |
| **VersionBar** | `v3 · 已批准 · 只读` | `探索 agent a1b2c3d4 · 基于 B1` + **`[采纳为 v4]`** 按钮 | 小：多一种状态 |
| **ChatFeed** | 正常对话 | 顶部常驻警示条：`这是探索 agent，产出不进受控链，需采纳后才能提门` | 小：一个条 |
| **ApprovalCard** | 正常显示 | **永不出现**——探索 agent 没有提门能力（D24） | 零：条件渲染 |
| **EvidencePanel** | jobs 列表 | 不变（探索 agent 的 job 也是真 job，照常显示） | 零 |

#### 3.7.2 对比态形态

```text
┌────────────────────────────────────────────────────────────────┐
│ ◂ UART控制器  ①━━G1━━━◆━━G3━━━━━◆ ○G4  [探索 a1b2c3d4▾] ☀ 👤│
├──────────────┬──────────────────────────────┬──────────────────┤
│ 文件树        │ uart_tx.v   探索 a1b2c3d4·基于B1│ ⚠ 探索 agent    │
│ [路径▾]      │              [采纳为 v4] [丢弃] │   产出不进受控链  │
│              │ ── 正式 v3 ──┊── 探索产出 ──── │   需采纳后提门    │
│ 📁 rtl/      │  12 state<=IDLE┊12 state<=IDLE  │ ────────────────│
│   uart_tx.v ~M│ 13 -          ┊13 +reg [1:0] p;│ 🤖 换成两级同步  │
│   uart_rx.v   │ 14  always @( ┊14  always @(   │    器，亚稳态更稳│
│   baud_gen.v +A│                              │                  │
│ 📁 tb/       │                              │ 💬 说点什么… [↑]│
│   uart_tb.sv  │ ─────────────────────────────│                  │
│              │ ▸ vivado synth   ✅  11.8s   │                  │
└──────────────┴──────────────────────────────┴──────────────────┘
   淡化=未改动         Monaco 原生 diff             无审批卡
```

#### 3.7.3 「采纳」与「过门」必须视觉可辨

两个按钮语义完全不同，绝不能长得像：

| | `[采纳为 v4]` | `[✓ 批准并建立 B2 里程碑]` |
|---|---|---|
| 语义 | 把非受控内容**复制**进受控链 | 给一组受控版本**签字** |
| 后果 | 产生新候选版本，仍需走门 | 建立基线，**不可撤销** |
| 位置 | 编辑器 VersionBar | 对话流审批卡 |
| 样式 | 次级按钮（`variant="secondary"`） | 主按钮 + 后果文案（§3.5 已定） |
| 权限 | 有写权限即可 | 需 `core:approve` |

#### 3.7.4 前提过期的表达（冲突形态 B）

agent 的前提基线被取代时，**不静默失败**：

- TaskSwitcher 中该条置灰，副标题变 `前提已过期（B1 → B1'）`
- 打开时编辑器顶部出现橙色条：`此 agent 基于 B1，项目已推进到 B1'。[重新对齐] [作废]`
- 提门按钮禁用，tooltip 写明原因
- 后端应在提门时同样拒绝（§1.1.2 不变量）——**前端提示不能替代后端校验**

#### 3.7.5 新增纯函数模块

沿用 D14「UI 全推、`domain/` 保留纯逻辑」的分工，三个新模块都不 import vue、不碰 DOM：

```
web/src/domain/milestone.ts     baselines[] → 项目里程碑进度（绕开 B2 的死字段）
web/src/domain/agent-lanes.ts   agents[] → { formal, exploratory[] }，含前提过期判定
web/src/domain/tree-overlay.ts  正式产物集 + 探索产出 → 带 diff 角标的树
```


---

## 4. 视觉系统（D15 / D20 / D22）

**方针：Claude 的色，IDE 的密度。** 配色、圆角、留白节奏学 Claude（暖中性 + 克制强调色 + 少边框）；字号、行高、控件尺寸按专业工具走。

### 4.1 色板

全部走 CSS 变量，语义命名（不用 `--c-blue` 这类具体色名），便于将来替换为宿主软件色板（D5）。

| 语义 | 深色 | 亮色 |
|---|---|---|
| `--surface-base` | `#1F1E1D` | `#FAF9F7` |
| `--surface-panel` | `#262624` | `#FFFFFF` |
| `--surface-raised` | `#30302E` | `#FFFFFF` |
| `--surface-hover` | `#3A3A37` | `#F0EEE9` |
| `--border-subtle` | `#35352F` | `#E8E5DE` |
| `--border-strong` | `#4A4A45` | `#D4D0C7` |
| `--text-primary` | `#F5F4EF` | `#1F1E1D` |
| `--text-secondary` | `#A8A49B` | `#6B6862` |
| `--text-muted` | `#78746B` | `#97938B` |
| `--accent` | `#D97757` | `#C15F3C` |
| `--accent-hover` | `#E08A6E` | `#A94E2E` |
| `--accent-subtle` | `rgba(217,119,87,.12)` | `rgba(193,95,60,.09)` |
| `--state-ok` | `#7FB069` | `#4F7942` |
| `--state-warn` | `#D9A757` | `#9A7128` |
| `--state-danger` | `#D97070` | `#B5453D` |
| `--state-info` | `#7A9CC6` | `#4A6FA5` |

正文与次要文字在两套主题下均满足 WCAG AA（≥4.5:1）。

### 4.2 密度与形状

| 项 | 值 | 说明 |
|---|---|---|
| 基准字号 | 13px | IDE 级，非 SaaS 的 15–16px |
| 代码字号 | 12.5px mono | |
| 行高 | 对话 1.55 / 列表 1.4 / 代码 1.6 | |
| 间距网格 | 4px | |
| 圆角 | 6px | Claude 感；不是 IDE 的 2px，也不是 SaaS 的 12px |
| 分区手段 | **优先底色差异，其次极淡边框** | 避免满屏硬线 |
| 动效 | 120–180ms ease-out，仅用于展开/切换 | 不做装饰性动画 |

- 主题：`:root[data-theme="dark"|"light"]`，跟随系统 + 手动切换 + localStorage 记忆
- Monaco 主题跟随：深色 `vs-dark`、亮色 `vs`
- 现有 `style.css` 1605 行全部重写

---

## 5. 代码组织

### 5.1 保留（已核实：11 个 domain 模块**全部不 import vue、不碰 DOM**）

```
web/src/domain/parts.ts            470行  audit 事件 → 时序 part
web/src/domain/task-stream.ts      184行  SSE 订阅、断线退避、Last-Event-ID  ⚠️无测试
web/src/domain/markdown-stream.ts  150行  增量 markdown 投影
web/src/domain/reply-segments.ts   206行  代码卡折叠
web/src/domain/gates.ts            167行  门/里程碑常量与推导
web/src/domain/tasks.ts            310行  STAGE_CHAIN + deriveStageChain
web/src/domain/band.ts              88行  当前动作文案
web/src/domain/artifacts.ts         82行  产物类型 → 中文名
web/src/domain/events.ts            42行  事件叙述
web/src/domain/markdown.ts          19行  markdown 渲染  ⚠️无测试、不做 sanitize
web/src/api/*                             API 契约层
```

**两处待处理：**
- `markdown.ts` 注释写明"输出供 v-html 使用、内网可信内容故不 sanitize"。重写时接入 DOMPurify（成本极低），不再依赖信任假设
- `task-stream.ts` / `markdown.ts` 缺测试，第一批补上

### 5.2 部分保留

```
web/src/domain/unified.ts   342行
  ├─ 保留：审批卡推导、按钮文案、错误人话化（deriveApprovalCard / approvalButtonLabel /
  │        rejectDisabled / humanizeDecisionError / humanizeLoadError / buildApproveBody）
  └─ 作废：LEGACY_ROUTES + unifiedRedirectTarget（绑定旧 vue-router 结构）
```

### 5.3 删除

```
web/src/views/UnifiedProjectView.vue    1022行，v3 单页对话流
web/src/views/ProjectListView.vue       重写
web/src/views/ApprovalsView.vue         → 并入 /inbox
web/src/views/ApprovalDetailView.vue    → 并入项目页就地审批
web/src/views/demos/                    A/B/C/D 布局 demo，选型已定
web/src/components/GateSwimlane.vue     被顶栏阶段条取代
web/src/style.css                       1605行重写
```

### 5.4 新增

```
web/src/domain/process-profile.ts    阶段 profile（数据驱动阶段条 + 分段规则）
web/src/domain/file-tree.ts          artifact + TaskDocRef → 三种视图树（纯函数）
web/src/domain/theme.ts              主题状态与持久化
web/src/domain/milestone.ts          baselines[] → 项目里程碑进度（§3.7.5，第三批）
web/src/domain/agent-lanes.ts        agents[] → 正式/探索分道 + 前提过期判定（§3.7.5，第三批）
web/src/domain/tree-overlay.ts       正式 + 探索 → 带 diff 角标的树（§3.7.5，第三批）

web/src/views/ProjectView.vue        三栏主页面（编排）
web/src/views/ProjectsView.vue       项目列表
web/src/views/InboxView.vue          跨项目待办

web/src/components/layout/{TopBar,StageRail,TaskSwitcher,Splitter}.vue
web/src/components/tree/{FileTree,ViewSwitcher}.vue
web/src/components/editor/{CodeEditor,VersionBar,DocPreview}.vue
web/src/components/evidence/EvidencePanel.vue
web/src/components/chat/{ChatFeed,ChatComposer,ApprovalCard}.vue
web/src/components/ui/{Badge,Button,Dropdown,Tooltip}.vue
```

### 5.5 测试留用

| 直接留用 | 需局部调整 | 部分失效 | 待补 |
|---|---|---|---|
| `gates` `tasks` `parts` `code-collapse` `streaming` | `redesign` `redesign-v2`（改名合并） | `unified` `v3-unified`（路由相关用例） | `task-stream` `markdown` |

### 5.6 新依赖

```
monaco-editor   ^0.52   代码编辑器（Vite 动态 import，仅打开文件时加载）
dompurify       ^3      markdown 输出净化
```

---

## 6. 后端契约（已逐条核实）

| 用途 | 端点 | 备注 |
|---|---|---|
| 项目详情 | `GET /api/v1/projects/:id` | 含 `process_instances[]`，**无阶段进度字段**，需自行推导 |
| 产物列表 | `GET .../artifacts` | **仅 `id / artifact_type / created_at`** |
| 版本列表 | `GET .../artifacts/:aid/revisions` | |
| 版本内容 | `GET .../artifacts/:aid/revisions/:rid/content` | 返回 `{content, content_hash}`；走 content_location 寻址的 → 404 |
| **保存新版本** | `POST .../artifacts/:aid/revisions` | **需 `Idempotency-Key` 头**；`expected_version` 乐观锁；冲突 409 |
| 工具运行 | `GET .../jobs?limit=` | `id/operation/runClass/state/startTime/endTime/errorCode` |
| 证据清单 | `GET .../jobs/:jid/evidence` | **非终态 job → 404** |
| 证据内容 | `GET .../jobs/:jid/evidence/content?name=<name>` | query 参数，非路径段 |
| agent 列表 | `GET .../tasks` | `agent_id/status/current_stage/awaiting_gate/created_at` |
| agent 详情 | `GET .../tasks/:agentId` | **`docs[]` 是 path/phase 的唯一来源** |
| SSE 流 | `GET .../tasks/:agentId/stream` | 5 种事件 `status / part / delta / done / reset`，支持 `Last-Event-ID`，15s 心跳 |
| 发消息 | `POST .../tasks/:agentId/message` | idle→`session.prompt`；running→**`session.steer`（非排队）** |
| 打断 | `POST .../tasks/:agentId/abort` | |
| 门提交 | `GET .../gate-submissions?state=` · `GET .../gate-submissions/:subId` | |
| 批准 / 驳回 | `POST .../gate-submissions/:subId/approve` · `/reject` | 需 `core:approve` 权限；里程碑门 approve 必填 `baseline_id` |
| 提交 / 撤回 | `POST .../gate-submissions/:subId/submit` · `/withdraw` | 初稿未提及，实际存在 |
| 里程碑 | `GET .../baselines` | |
| 跨项目待审 | **不存在** | 只能 N 次请求合并 |

**顺带修一处代码库漂移**：`web/src/api/types.ts` 的 `SendMessageResult.reply` 已过时——runtime 改流式后不再返回该字段。

---

## 7. 风险与边界

| # | 风险 | 处置 |
|---|---|---|
| R1 | **多套阶段模板后端不支持**（D7）。阶段链硬编码在 `runtime/types.ts:231` 与 `web/src/domain/tasks.ts:25` 两处，DB `process_instance` 只有 `gate_profile_version` 字段，无模板表 | 前端按数据驱动写，第一轮只有 `fpga-full`。模板选择器与后端模板表另立切片 |
| ~~R2~~ | ~~人类保存后 agent 不知情~~ | **已由 D19 关闭**：agent 运行时编辑器只读 |
| R3 | 三栏在 1440px 以下拥挤（240+380=620px 固定） | <1280px 右栏可折叠为浮层；<1024px 降级「编辑器+对话」两栏，文件树抽屉化；<768px 走 D18 移动端阶段条 |
| R4 | Monaco 体积 ~300KB（gzip ~80KB） | Vite 动态 import，仅打开文件时加载 |
| R5 | 嵌入宿主软件的技术形态未定（iframe / web component / 直接编译） | 第一轮不做特殊设计，但**颜色全走变量层**、**不假设自己占满视口** |
| R6 | `/inbox` 无聚合端点，项目多时 N 次请求退化 | 第一批不做 `/inbox`（D23）。做时先 N 次请求，项目数上百再提后端端点 |
| R7 | 左栏三视图依赖 `TaskDocRef`，若项目无 agent 则 path/phase 缺失 | 无 agent 时「路径/阶段」视图降级提示，「产物类型」视图仍可用 |
| **R8** | **§3.7 全部依赖 §1.1.6 的四项后端缺口**，其中 B3（基线换代物理上不可能）是硬阻塞 | 第三批**不得早于** B3 迁移落地。B1/B4 可先在前端用约定兜（前提/主张存 agent 的 `task` 文本、正式道唯一性靠 UI 不给入口），但**必须标注为临时** |
| **R9** | 探索 agent 的隔离区（D25）后端尚无对应存储——`.runs/` 只存会话状态，不存产物副本 | 第三批前需定：探索产出走「不挂 artifact 的游离 revision」还是「Runtime 侧文件区」。前者能复用现有 revision 链，后者要新端点 |

**明确不做（第一轮）**：阶段模板选择、项目创建向导、Skill 进化提案界面、交付摘要导出、全局搜索。

---

## 8. 交付计划

### 第一批（D23）——验证形态

| 步 | 内容 | 验收 |
|---|---|---|
| 1 | 主题系统 + 基础组件 + 三栏骨架 | 双主题可切，三栏可拖拽调宽，色板满足 AA |
| 2 | 顶栏：项目名 + 阶段条（数据驱动 + 分段折叠）+ 任务切换 | 阶段状态正确反映真实 agent；PC 分段、移动端弹层各自正确 |
| 3 | 左栏：文件树三视图 | 三种视图分组正确，状态点正确，artifact↔TaskDocRef 关联正确 |
| 4 | 中栏：Monaco 只读 + 版本下拉 + markdown 预览 | 点树上文件能正确打开并高亮；agent 运行时锁定只读 |
| 5 | 右栏：对话流 + SSE 流式 + 插话/打断 | 与 v3 同等流式体验，回合制正确，steer 与 abort 语义正确 |

**到此暂停，交付评审。** 形态确认后再继续。

### 第二批——补齐能力

| 步 | 内容 |
|---|---|
| 6 | 就地审批（批准/驳回、里程碑门 baseline） |
| 7 | 证据面板（jobs 列表 + 证据内容 + 错误跳转） |
| 8 | 编辑器写入（Idempotency-Key、乐观锁、409 冲突 UI） |
| 9 | 项目列表页 + `/inbox` |

### 第三批——agent 分层（D24–D26 / §3.7）

⚠️ **前置条件：§1.1.6 的 B3 迁移必须先落地**（否则项目建不出第二个里程碑，整批无意义）。

| 步 | 内容 | 验收 |
|---|---|---|
| 10 | `domain/milestone.ts` + StageRail 换项目级数据源 | 阶段条不再随 agent 切换而变；里程碑从 `baselines` 正确推导 |
| 11 | `domain/agent-lanes.ts` + TaskSwitcher 两段式分组 | 正式/探索正确分道；前提过期条目正确置灰 |
| 12 | `domain/tree-overlay.ts` + FileTree diff 角标 + 编辑器 diff 态 | 探索 agent 打开即进 diff；未改动文件淡化 |
| 13 | 采纳流程（`[采纳为 v4]` → 新候选版本，理由写明来源 agent） | 采纳后产出进受控链、作者为人、探索 agent 落 `adopted` |

每步跑通 `bun test` + `vue-tsc --noEmit`（**分两条命令跑，不要用管道**——管道会把 `vue-tsc` 的退出码吃掉）。
