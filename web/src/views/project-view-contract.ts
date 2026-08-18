/**
 * 三栏项目页（ProjectView.vue）与四个栏位组件的契约（v4 骨架批次 · 架构基线）。
 *
 * ProjectView 是唯一的数据编排者：项目详情、run 列表与详情、artifacts/revisions/
 * content、SSE 订阅全部由它持有；TopBar / FileTree / CodeEditor / ChatFeed 一律是
 * 受控组件——只吃 props、只吐 emits，不直接调用 api/index.ts 里的任何函数。
 *
 * 「受控」的边界：跨栏耦合的数据（当前 run、当前打开的文件、主题、视图模式……）
 * 必须提升到本文件定义的 props/emits，由 ProjectView 持有单一数据源；纯本地、
 * 不跨栏、不需要跨刷新保留的 UI 态（悬浮浮层开合、单张卡片展开/收起、下拉框
 * 开合……）留给各组件自己用 ref 管理即可，不必为此污染契约。
 *
 * 关联口径（spec §2 的警告）：`Artifact` 对象只有 id/artifact_type/created_at，
 * path 与 phase 只存在于当前 run 详情的 `docs[]`（`TaskDocRef`）。本文件导出的
 * `FileTreeEntry` 是两边按 artifact id 关联后的统一视图模型——ProjectView 负责
 * 关联，四个栏位组件与后续开发者不需要、也不应该自己再关联一遍。
 */

import type { ArtifactRevision, JobEvidenceContent, TaskAgentSummary } from "../api/types.ts";
import type { SynthiaPart } from "../domain/parts.ts";
import type { RecordJob } from "../domain/records.ts";
import type { StageChainNode } from "../domain/tasks.ts";
import type { StreamPhase } from "../domain/task-stream.ts";
import type { Theme } from "../domain/theme.ts";

// ─────────────────────────────────────────────────────────────────────────
// 文件树统一视图模型（左栏 + 中栏共用）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 文件树条目：artifact 与 revision 按 id 关联后的统一视图。
 *
 * 关联规则（ProjectView 在编排层一次性算好）：
 * - artifactId / artifactType / createdAt 来自 `GET .../artifacts`（`Artifact`，
 *   只有 id/artifact_type/created_at 三个字段）；
 * - revisions 来自 `GET .../artifacts/:aid/revisions`，按 version 升序；
 *   latestRevision 取其中 version 最大的一条——文件树上只展示最新版，完整版本
 *   历史在编辑器顶部下拉里通过 revisions 渲染；
 * - path / phase 来自**当前选中 run** 详情的 `docs[]`（`TaskDocRef`），按
 *   `artifact_id` 匹配；一个 artifact 可能被多个历史 run 的 docs 引用，这里只
 *   取当前选中 run 的引用——任务切换器切换 run 时，文件树的路径/阶段视图分组
 *   会随之变化，这是预期行为（每个 run 只看得到自己产出的文档归属）；
 * - 当前 run 没有引用到该 artifact 时（如项目还没有任何 run，或该 artifact 由
 *   其他历史 run 产出），path/phase 为 null——「路径」「阶段」视图下应将其归入
 *   「未关联当前任务」分组兜底，「产物类型」视图不受影响，因为它的分组键
 *   artifactType 不依赖 docs（对应 spec R7）。
 */
export interface FileTreeEntry {
  readonly artifactId: string;
  /** 产物类型原文（英文枚举），中文名用 domain/artifacts.ts:artifactGroupName / artifactDocName 转换。 */
  readonly artifactType: string;
  readonly createdAt: string;
  /** 最新版本（树上展示 + 默认打开的版本）。 */
  readonly latestRevision: ArtifactRevision;
  /** 该 artifact 的全部版本，按 version 升序（编辑器顶部版本下拉 / diff 对比用）。 */
  readonly revisions: readonly ArtifactRevision[];
  /** 当前选中 run 的 docs[] 关联到的文件路径；未关联为 null。 */
  readonly path: string | null;
  /** 当前选中 run 的 docs[] 关联到的阶段 id（对齐 domain/tasks.ts:STAGE_CHAIN 的 node.id）；未关联为 null。 */
  readonly phase: string | null;
}

/** 左栏三种视图（spec §3.2，默认「路径」）。 */
export type FileTreeViewMode = "path" | "type" | "stage";

/** 文件树状态点四态（spec §3.2：✅ 已批准 / 🔵 候选 / ⚠️ 已驳回 / ⊘ 已作废）。 */
export type ArtifactDotState = "approved" | "candidate" | "rejected" | "invalidated";

/**
 * `ArtifactRevision.state`（后端 revision.state 原文，见 domain/gates.ts:REVISION_STATE_TEXT
 * 的 key 集合：candidate/in_review/approved/rejected/superseded/invalidated）→ 文件树状态点四态。
 * 统一在这里做一次映射，避免四个栏位各自理解不一致：
 * - approved → 已批准；
 * - candidate / in_review → 候选（尚未定稿的两种在制状态，UI 上不需要区分）；
 * - rejected → 已驳回；
 * - superseded / invalidated → 已作废（被新版本替换 / 已失效，UI 上不需要区分）。
 */
export function artifactDotState(revisionState: string): ArtifactDotState {
  switch (revisionState) {
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "superseded":
    case "invalidated":
      return "invalidated";
    default:
      return "candidate"; // candidate / in_review 及未知值一律按候选兜底
  }
}

export const ARTIFACT_DOT_TEXT: Readonly<Record<ArtifactDotState, string>> = {
  approved: "已批准",
  candidate: "候选",
  rejected: "已驳回",
  invalidated: "已作废",
};

/** 状态点符号（spec §3.2 原样给出的四个符号）。 */
export const ARTIFACT_DOT_GLYPH: Readonly<Record<ArtifactDotState, string>> = {
  approved: "✅",
  candidate: "🔵",
  rejected: "⚠️",
  invalidated: "⊘",
};

// ─────────────────────────────────────────────────────────────────────────
// TopBar（顶栏：项目名 + 阶段条 + 任务切换 + 主题 + 用户）
// ─────────────────────────────────────────────────────────────────────────

export interface TopBarProps {
  /** 项目名称，来自 `GET /projects/:id`.name。 */
  readonly projectName: string;
  /**
   * 当前选中 run 的阶段链推导结果（`domain/tasks.ts:deriveStageChain` 的输出，
   * 15 个节点，顺序与 `STAGE_CHAIN` 一致）。项目尚无任何 run 时为 null——顶栏应
   * 显示「尚无任务」占位，不渲染阶段条（不要传空数组，null 明确表达“不存在”
   * 与“存在但全部 pending”的区别，后者是合法状态，前者不是）。
   */
  readonly stageChain: readonly StageChainNode[] | null;
  /**
   * 当前选中的 run 摘要（`GET .../tasks` 列表项）。驱动「③ RTL 编写 · 进行中 ·
   * 8/15」一类文案与任务切换器的高亮项；为 null 当且仅当 stageChain 也为 null。
   */
  readonly currentAgent: TaskAgentSummary | null;
  /** 项目全部 run（`GET .../tasks`，按 created_at 倒序），供任务切换器列出（含仍在后台跑的其它 run）。 */
  readonly agents: readonly TaskAgentSummary[];
  /** 当前生效主题，驱动 ☀/☾ 图标显示哪一个。 */
  readonly theme: Theme;
  /** <1024px 时文件树抽屉是否已展开（驱动汉堡按钮的开合态）。见 spec R3。 */
  readonly treeDrawerOpen: boolean;
  /** <1280px 时对话栏浮层是否已展开。见 spec R3。 */
  readonly chatOverlayOpen: boolean;
}

export interface TopBarEmits {
  /** 任务切换器选中另一个 run（其它 run 仍在后台继续跑，不受影响）。 */
  "select-agent": [agentId: string];
  /**
   * 点击阶段/门节点：左栏应联动切换到「阶段」视图并定位到该阶段的产物分组
   * （spec §3.1 末条）。stageId 对齐 `STAGE_CHAIN` 的 node.id（含门节点 G1/G3/G4）。
   */
  "select-stage": [stageId: string];
  /** 点击主题切换按钮（☀/☾）。 */
  "toggle-theme": [];
  /** <1024px 汉堡按钮：开合文件树抽屉。 */
  "toggle-tree-drawer": [];
  /** <1280px：开合对话浮层。 */
  "toggle-chat-overlay": [];
  /** 用户菜单里的退出登录（会话/路由跳转由 ProjectView 处理，TopBar 不直接碰 store）。 */
  logout: [];
}

// ─────────────────────────────────────────────────────────────────────────
// FileTree（左栏：产物导航，三种视图）
// ─────────────────────────────────────────────────────────────────────────

export interface FileTreeProps {
  /** ProjectView 已完成 artifact↔TaskDocRef 关联的统一视图模型（见上）。 */
  readonly entries: readonly FileTreeEntry[];
  /** 当前视图（受控：TopBar 的阶段点击会切换它，因此必须提升到 ProjectView）。 */
  readonly viewMode: FileTreeViewMode;
  /**
   * 项目是否存在至少一个 run。为 false 时「路径」「阶段」视图应降级提示
   * （path/phase 全部缺失，无法分组），「产物类型」视图仍可正常工作（spec R7）。
   */
  readonly hasAgent: boolean;
  /** 当前编辑器打开的 artifactId；树上据此高亮，未打开任何文件为 null。 */
  readonly openArtifactId: string | null;
  /** <1024px 抽屉模式：为 true 时组件可在用户选中文件后自行 emit close-drawer 收起浮层。 */
  readonly drawerMode: boolean;
  /**
   * 顶栏阶段条被点击后需要定位到的阶段 id（spec §3.1 末条：「点击阶段节点 →
   * 左栏切阶段视图并定位到该阶段产物组」）。ProjectView 收到 TopBar 的
   * `select-stage` 事件后把 viewMode 切到 "stage" 并把该值写进这里；不是一次性
   * 事件，而是「当前应聚焦的阶段」这一持续状态，值不变时 FileTree 不必重复滚动。
   * 未曾点击过任何阶段节点时为 null。
   */
  readonly focusStageId: string | null;
}

export interface FileTreeEmits {
  "update:viewMode": [mode: FileTreeViewMode];
  /** 点击文件 → 中栏编辑器打开该 artifact 的最新版本（ProjectView 负责取内容）。 */
  "open-file": [artifactId: string];
  /** 抽屉模式下选中文件后请求收起抽屉（drawerMode=false 时不应触发）。 */
  "close-drawer": [];
}

// ─────────────────────────────────────────────────────────────────────────
// CodeEditor（中栏上：Monaco 编辑器）
// ─────────────────────────────────────────────────────────────────────────

/** 编辑器只读原因：批准态只读 / agent 运行中只读 / null=可编辑（spec §3.3 三态表 + D19）。 */
export type EditorReadonlyReason = "approved" | "agent-running" | null;

/** 只读原因 → 顶部提示文案后半段（前半段是「vN · 」版本前缀，由 CodeEditor 自己拼）。 */
export const EDITOR_READONLY_BANNER: Readonly<Record<Exclude<EditorReadonlyReason, null>, string>> = {
  approved: "已批准 · 只读",
  "agent-running": "agent 正在工作，暂不可编辑",
};

export interface CodeEditorProps {
  /** 当前打开的文件条目；null 表示未选中任何文件（编辑器显示空态引导）。 */
  readonly file: FileTreeEntry | null;
  /**
   * 当前查看的版本——默认等于 file.latestRevision，但用户从版本下拉选择历史
   * 版本查看时会不同于 latestRevision；file 为 null 时也为 null。
   */
  readonly activeRevision: ArtifactRevision | null;
  /** activeRevision 对应的正文内容（`GET .../revisions/:rid/content`.content）；加载中为 null。 */
  readonly content: string | null;
  /** 内容是否正在加载（切换文件/版本时短暂为 true，用于骨架屏）。 */
  readonly loading: boolean;
  /** 只读原因，见上。为 null 时才允许编辑（本批次骨架只做只读展示，可编辑态先占位）。 */
  readonly readonlyReason: EditorReadonlyReason;
  /** Monaco 语言 id（verilog/systemverilog/tcl/markdown/json/yaml…），由 ProjectView 按文件后缀/产物类型推导。 */
  readonly language: string;
  /** 编辑器主题跟随全局：dark→"vs-dark"，light→"vs"（CodeEditor 直接用 theme==='dark' 判断即可）。 */
  readonly theme: Theme;
  /**
   * 版本对比态：非 null 时应改用 Monaco diff editor 渲染 base→head 差异；
   * 由 CodeEditor 发 compare-revisions 请求后，ProjectView 拉取两版内容回填。
   */
  readonly diffAgainst: { readonly base: ArtifactRevision; readonly baseContent: string; readonly head: ArtifactRevision } | null;
}

export interface CodeEditorEmits {
  /** 版本下拉选择另一版本查看（revisionId 必须是 file.revisions 中的一个 id）。 */
  "select-revision": [revisionId: string];
  /** 版本对比：选两版进 diff editor；ProjectView 补齐 baseContent 后回填 diffAgainst。 */
  "compare-revisions": [baseRevisionId: string, headRevisionId: string];
  /** 退出对比模式，回到单文件视图。 */
  "exit-diff": [];
  /**
   * 保存为新候选版本（`POST .../artifacts/:aid/revisions`，需 Idempotency-Key + 乐观锁，
   * 见 spec §3.3）——**批次二**功能。本批次骨架里 ProjectView 暂不监听/调用保存端点，
   * 这里只做契约占位，避免批次二给 CodeEditor 加保存按钮时又要回头改 ProjectView.vue。
   */
  save: [content: string];
}

// ─────────────────────────────────────────────────────────────────────────
// ChatFeed（右栏：对话流 + 插话/打断 + 就地审批占位）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 输入框行为模式（spec §3.5，D21 如实叫「插话/纠偏」，不伪装成排队）：
 * - "new-task"：项目尚无 run，发送即创建首个任务（`POST .../tasks`，mode=agent）；
 * - "prompt"：当前 run 空闲/终态，发送触发新一轮 `session.prompt`；
 * - "steer"：当前 run 运行中，发送即「插话」，走 `session.steer`（非排队，不保证
 *   按顺序生效，下一个工具调用结束后生效）。
 */
export type ChatComposerMode = "new-task" | "prompt" | "steer";

export interface ChatFeedProps {
  /**
   * 合成后的对话流：audit 事件物化（`domain/parts.ts:auditToParts`）与 SSE 流式
   * 增量（`domain/task-stream.ts:applyStreamEvent`）已由 ProjectView 按 turn 顺序
   * 合并去重，ChatFeed 只管按数组顺序渲染，不需要再关心两路数据的合并规则。
   */
  readonly parts: readonly SynthiaPart[];
  /** 当前 run 状态原文（`TaskAgentDetail.status`）；无 run 为 null。中文映射见 `domain/tasks.ts:TASK_STATUS_TEXT`。 */
  readonly agentStatus: string | null;
  /** SSE 实时连接阶段；"degraded" 时应提示「实时连接中断，已切换定时刷新」。 */
  readonly streamPhase: StreamPhase;
  /** 输入框行为模式，见上，直接决定占位文案与按钮语义（不得出现"排队"措辞，D21）。 */
  readonly composerMode: ChatComposerMode;
  /** 是否可点「⏹ 打断」（仅当前 run 运行中为 true）。 */
  readonly canAbort: boolean;
  /** 发送/打断请求进行中（禁用输入框与按钮，防重复提交）。 */
  readonly sending: boolean;
  /** 上一次发送/打断失败的人话文案（`domain/unified.ts:humanizeDecisionError`）；无失败为 null。 */
  readonly sendError: string | null;
  /** 空项目首屏示例任务文案（`domain/unified.ts:EXAMPLE_TASKS`），仅 composerMode="new-task" 时展示。 */
  readonly exampleTasks: readonly string[];
}

export interface ChatFeedEmits {
  /**
   * 发送消息。ChatFeed 不需要关心具体调哪个后端端点——composerMode="new-task"
   * 时 ProjectView 会调用 createTask 建首个任务；其余情况调用 sendMessage（服务端
   * 按 run 状态自动决定 prompt / steer 语义）。
   */
  send: [text: string];
  /** 点击「⏹ 打断」（`POST .../tasks/:agentId/abort`）；仅 canAbort=true 时应可点击。 */
  abort: [];
  /** 点击产物卡关联的文档 → 中栏编辑器打开（不再弹抽屉，这是三栏相对 v3 的主要收益）。 */
  "open-doc": [artifactId: string];
  /**
   * 打开运行记录面板（工具条上的「运行记录」链接、或证据摘要行）。带 jobId 时
   * 面板应展开并定位到该条；证据摘要行点击不定位任何一条，传 null。
   */
  "open-records": [jobId: string | null];
}

// ─────────────────────────────────────────────────────────────────────────
// 运行记录面板（右侧抽屉，复用 FileTree/ChatFeed 的 veil 抽屉视觉；ProjectView
// 用 `domain/records.ts:buildRecordJobs` 从当前 run 详情算出 jobs，证据内容按需
// 惰性拉取并以 key `${jobId}:${name}`（`domain/records.ts:recordEntryKey`）存入
// entryContent——同一受控组件契约：RecordsPanel 不直接调 api/index.ts。
// ─────────────────────────────────────────────────────────────────────────

/** 单条证据内容的惰性加载态（key 见 `domain/records.ts:recordEntryKey`）。 */
export type RecordEntryContentState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly content: JobEvidenceContent };

export interface RecordsPanelProps {
  /** 是否展示（veil/抽屉的显隐由 ProjectView 控制，与 FileTree 抽屉同构）。 */
  readonly open: boolean;
  /** 当前 run 的完整 job 列表，见 `domain/records.ts:buildRecordJobs`。 */
  readonly jobs: readonly RecordJob[];
  /** 打开面板时若来自某条工具条的「运行记录」链接，指定应展开定位的 jobId；否则 null。 */
  readonly focusJobId: string | null;
  /** 惰性证据内容缓存，key 为 `${jobId}:${name}`；未拉取过的条目不在此表中。 */
  readonly entryContent: Readonly<Record<string, RecordEntryContentState>>;
}

export interface RecordsPanelEmits {
  /** 关闭面板（veil 点击/关闭按钮）。 */
  close: [];
  /** 点击某条证据的「查看内容」；ProjectView 据此调 `getJobEvidenceContent` 并写回 entryContent。 */
  "view-entry": [jobId: string, name: string];
}
