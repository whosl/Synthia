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

import type { ArtifactRevision, JobEvidenceContent, WorkspaceFileStatus } from "../api/types.ts";
import type { SynthiaPart } from "../domain/parts.ts";
import type { RecordJob } from "../domain/records.ts";
import type { StreamPhase } from "../domain/task-stream.ts";
import type { Theme } from "../domain/theme.ts";
import type { ApprovalCardState, ApprovalMember, DecisionFailure } from "../domain/unified.ts";

// ─────────────────────────────────────────────────────────────────────────
// 文件树统一视图模型（左栏 + 中栏共用）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 文件树条目：**一个工作区文件**（或一个没有落盘的历史产物）的统一视图。
 *
 * 关联规则（ProjectView 在编排层一次性算好）：
 * - 路径与状态以 `GET .../workspace/tree` 为准——那是真实磁盘上的东西。同一个
 *   artifact 在树里有对应文件时，`path` / `status` 都取自它；
 * - artifactId / artifactType / createdAt 来自 `GET .../artifacts`（`Artifact`，
 *   只有 id/artifact_type/created_at 三个字段）；
 * - revisions 来自 `GET .../artifacts/:aid/revisions`，按 version 升序；
 *   latestRevision 取其中 version 最大的一条——文件树上只展示最新版，完整版本
 *   历史在编辑器顶部下拉里通过 revisions 渲染；
 * - phase 来自**当前选中 run** 详情的 `docs[]`（`TaskDocRef`），按 `artifact_id`
 *   匹配；一个 artifact 可能被多个历史 run 的 docs 引用，这里只取当前选中 run
 *   的引用——任务切换器切换 run 时，「阶段」视图分组会随之变化，这是预期行为；
 * - 当前 run 没有引用到该 artifact 时（如项目还没有任何 run，或该 artifact 由
 *   其他历史 run 产出），phase 为 null——「阶段」视图归入「未关联当前任务」兜底，
 *   「产物类型」视图不受影响，因为它的分组键 artifactType 不依赖 docs（spec R7）。
 *
 * 两类条目的 latestRevision 会是 null，含义完全不同，别混：
 * - **盘上有、还没登记**（`status` 为 `untracked` 或某次登记还没走完）——是文件，
 *   只是还不是修订；
 * - 反过来，**登记了但盘上没有**（`status` 为 null）是流水线产出的 `art-*`，
 *   它有修订、没有文件。
 */
export interface FileTreeEntry {
  readonly artifactId: string;
  /** 产物类型原文（英文枚举），中文名用 domain/artifacts.ts:artifactGroupName / artifactDocName 转换。 */
  readonly artifactType: string;
  readonly createdAt: string;
  /**
   * 最新版本（树上展示 + 默认打开的版本）。
   *
   * **为 null 表示这个文件在盘上、但还没有任何修订**——人刚用编辑器新建、或
   * agent 写了还没登记。它是文件树上必须看得见的一行（否则「工作区有 N 个改动」
   * 指向的东西是隐形的），但它没有版本、没有状态点、也不能进快照。
   */
  readonly latestRevision: ArtifactRevision | null;
  /** 该 artifact 的全部版本，按 version 升序（编辑器顶部版本下拉 / diff 对比用）；尚未登记时为空。 */
  readonly revisions: readonly ArtifactRevision[];
  /** 工作区相对路径。以 `workspace/tree` 为准，其次当前 run 的 docs[]，再次从标题反解；都没有为 null。 */
  readonly path: string | null;
  /** 当前选中 run 的 docs[] 关联到的阶段 id（对齐 domain/tasks.ts:STAGE_CHAIN 的 node.id）；未关联为 null。 */
  readonly phase: string | null;
  /**
   * 这个文件在磁盘工作区里的处境（`GET workspace/tree`）。
   *
   * 为 null 表示它**根本不在工作区里**——流水线产出的 `art-*` 产物只有 DB 里的
   * 正文、从来没有落过盘。这类产物照常显示、照常可读，只是没有「改动/登记」这层
   * 语义，不该被算进待登记计数，也不该显示角标。
   */
  readonly status: WorkspaceFileStatus | null;
}

/** 左栏三种视图（spec §3.2，默认「路径」）。 */
export type FileTreeViewMode = "path" | "type" | "stage";

/**
 * 打开哪一版：审批场景必须能钉住快照当时的修订。
 *
 * - 不传 revisionId（文件树、对话流产物卡）→ 最新版，既有行为不变；
 * - 传了且命中 → 就是那一版。快照钉的是**提交那一刻**的修订，agent 之后可能又写了
 *   新版，按最新版审等于审了一份不是被提交的内容；
 * - 传了但没命中（历史版本已被清理）→ 回落最新版。总比什么都不打开强，且调用方
 *   拿到的永远是一个真实存在的 revision。
 *
 * 返回 null 只有一种情况：这个条目还没有任何修订（盘上有、没登记）。那时正文得走
 * `GET workspace/file` 从工作区读，不是从修订读。
 */
export function pickRevision(entry: FileTreeEntry, revisionId?: string): ArtifactRevision | null {
  if (!revisionId) return entry.latestRevision;
  return entry.revisions.find((r) => r.id === revisionId) ?? entry.latestRevision;
}

/**
 * 某一版的前一版修订 id——对话流产物卡据此决定要不要给出「查看改动」，点了之后
 * 它就是中栏 diff 的 base（head 是卡片自己那一版）。
 *
 * revisions 按版本升序（domain/file-tree.ts:buildFileTreeEntries），所以前驱就是
 * 命中项的前一个元素。首版、或这一版已不在版本链里 → null：宁可不出这个入口，也
 * 不要给出一个点了会落空的按钮。
 */
export function prevRevisionId(entry: FileTreeEntry, revisionId: string): string | null {
  const at = entry.revisions.findIndex((r) => r.id === revisionId);
  return at > 0 ? entry.revisions[at - 1]!.id : null;
}

/**
 * 文件树状态点（spec §3.2 的四态 ✅ 已批准 / 🔵 候选 / ⚠️ 已驳回 / ⊘ 已作废，
 * 外加 ○ 未登记）。
 *
 * `unregistered` 不是第五种「修订状态」——恰恰相反，它表示**这个文件还没有任何
 * 修订**。它和另外四个并列在同一个位置，是因为用户在树上要回答的是同一个问题：
 * 「这一行现在算数吗」。把它并进 candidate 会是实打实的谎：候选是已经登记、能进
 * 快照的东西，未登记的文件进不了任何一道门。
 */
export type ArtifactDotState = "approved" | "candidate" | "rejected" | "invalidated" | "unregistered";

/**
 * `ArtifactRevision.state`（后端 revision.state 原文，见 domain/gates.ts:REVISION_STATE_TEXT
 * 的 key 集合：candidate/in_review/approved/rejected/superseded/invalidated）→ 文件树状态点。
 * 统一在这里做一次映射，避免四个栏位各自理解不一致：
 * - approved → 已批准；
 * - candidate / in_review → 候选（尚未定稿的两种在制状态，UI 上不需要区分）；
 * - rejected → 已驳回；
 * - superseded / invalidated → 已作废（被新版本替换 / 已失效，UI 上不需要区分）。
 *
 * 传 null（该条目还没有修订）→ 未登记。
 */
export function artifactDotState(revisionState: string | null | undefined): ArtifactDotState {
  if (!revisionState) return "unregistered";
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
  unregistered: "未登记",
};

/** 状态点符号（spec §3.2 原样给出的四个符号，外加未登记的空心圈）。 */
export const ARTIFACT_DOT_GLYPH: Readonly<Record<ArtifactDotState, string>> = {
  approved: "✅",
  candidate: "🔵",
  rejected: "⚠️",
  invalidated: "⊘",
  unregistered: "○",
};

/**
 * 状态点 → `ui/AppBadge.vue` 的语气色。定义在这里而不是各组件里，是因为文件树行、
 * 编辑器版本条都要画同一个点，抄三份迟早会各自漂移。
 *
 * `unregistered` 与 `invalidated` 同为 neutral 不是偷懒：两者都是「不在治理链上」，
 * 都不该用告警色抢注意力——真正要人动手的提示在文件树顶栏那条横幅上，不在行内。
 */
export const ARTIFACT_DOT_TONE: Readonly<Record<ArtifactDotState, "ok" | "info" | "danger" | "neutral">> = {
  approved: "ok",
  candidate: "info",
  rejected: "danger",
  invalidated: "neutral",
  unregistered: "neutral",
};

// ─────────────────────────────────────────────────────────────────────────
// TopBar（顶栏：项目名 + 主题 + 用户；G0-G4 阶段条已上移到顶部进度带）
// ─────────────────────────────────────────────────────────────────────────

export interface TopBarProps {
  /** 项目名称，来自 `GET /projects/:id`.name。 */
  readonly projectName: string;
  /** 当前生效主题，驱动 ☀/☾ 图标显示哪一个。 */
  readonly theme: Theme;
  /** <1024px 时文件树抽屉是否已展开（驱动汉堡按钮的开合态）。见 spec R3。 */
  readonly treeDrawerOpen: boolean;
  /** <1280px 时对话栏浮层是否已展开。见 spec R3。 */
  readonly chatOverlayOpen: boolean;
}

export interface TopBarEmits {
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
  /** 新版 GJB 工程按正式文档名分组；自由/兼容项目使用中性产物分组。 */
  readonly documentContext: "gjb" | "generic";
  /** 当前视图（受控：TopBar 的阶段点击会切换它，因此必须提升到 ProjectView）。 */
  readonly viewMode: FileTreeViewMode;
  /**
   * 项目是否存在至少一个 run。为 false 时「路径」「阶段」视图应降级提示
   * （path/phase 全部缺失，无法分组），「产物类型」视图仍可正常工作（spec R7）。
   *
   * 注意这只是**下限**而非充要条件：`buildFileTreeEntries` 会在 run 详情的
   * `docs[]` miss 时从 revision 标题 / artifact id 反解 path 与 phase，所以
   * hasAgent=false 也可能拿得到分组键。`buildSplitFileTree` 因此按「一个都没
   * 反解出来」来决定是否降级，而不是只看这个标志。
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
  /**
   * 工作区里待登记的文件数（`GET workspace/tree`.pending_count）——顶栏
   * 「工作区有 N 个改动 [登记]」的 N。为 0 时不出这条横幅。
   *
   * 由 ProjectView 直接传服务端的计数，而不是让 FileTree 数 entries 里的
   * dirty/untracked：服务端知道 `sim/` 该排除、也知道二进制文件的处境，前端数
   * 一遍只会在边界上和后端不一致。
   */
  readonly pendingCount: number;
  /** 登记请求进行中：横幅按钮应置灰，避免重复提交（幂等键不同就是两次真登记）。 */
  readonly registering: boolean;
  /** 上一次登记失败的人话；无失败为 null。不给这个字段的话，点了没反应是唯一的反馈。 */
  readonly registerError: string | null;
}

export interface FileTreeEmits {
  "update:viewMode": [mode: FileTreeViewMode];
  /** 点击文件 → 中栏编辑器打开该 artifact 的最新版本（ProjectView 负责取内容）。 */
  "open-file": [artifactId: string];
  /** 抽屉模式下选中文件后请求收起抽屉（drawerMode=false 时不应触发）。 */
  "close-drawer": [];
  /** 一键登记：把工作区当前全部改动收成一个 commit + N 条候选修订。说明可为空串。 */
  register: [changeReason: string];
}

// ─────────────────────────────────────────────────────────────────────────
// CodeEditor（中栏上：Monaco 编辑器）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 编辑器只读原因（spec §3.3 三态表 + D19），null=可编辑：
 * - `approved` / `agent-running`：治理原因，不该改；
 * - `not-in-workspace` / `historical`：**没有可写的目标**——保存只能写工作区文件，
 *   流水线产出的 `art-*` 从没落过盘，历史版本的正文也不是盘上那份字节。这两种
 *   情况下放开编辑，用户敲下的字没有任何地方可去。
 */
export type EditorReadonlyReason = "approved" | "agent-running" | "not-in-workspace" | "historical" | null;

/** 只读原因 → 顶部提示文案后半段（前半段是「vN · 」版本前缀，由 CodeEditor 自己拼）。 */
export const EDITOR_READONLY_BANNER: Readonly<Record<Exclude<EditorReadonlyReason, null>, string>> = {
  approved: "已批准 · 只读",
  "agent-running": "agent 正在工作，暂不可编辑",
  "not-in-workspace": "不在工作区 · 只读",
  historical: "历史版本 · 只读",
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
  /**
   * `content` 是从哪儿取的——**只有编辑器自己知道这件事，用户看不出来**，所以必须
   * 由编排层如实告知：
   * - `"workspace"`：`GET workspace/file` 的**盘上当前字节**，含还没登记的改动。
   *   这是唯一可写回的来源，也是文件树点开一个工作区文件时的默认来源；
   * - `"revision"`：某一条修订的正文（审批卡/产物卡钉版本、或用户从版本下拉选了
   *   历史版本）。它可能与盘上的字节不同，保存回去等于悄悄回滚，因此恒只读。
   */
  readonly contentSource: "workspace" | "revision";
  /** 内容是否正在加载（切换文件/版本时短暂为 true，用于骨架屏）。 */
  readonly loading: boolean;
  /** 只读原因，见上。为 null 时才允许编辑，并出「保存」按钮。 */
  readonly readonlyReason: EditorReadonlyReason;
  /** 保存请求进行中：按钮置灰显示「保存中…」。 */
  readonly saving: boolean;
  /** 上一次保存失败的人话；无失败为 null。 */
  readonly saveError: string | null;
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
  "dirty-change": [dirty: boolean];
  /** 版本下拉选择另一版本查看（revisionId 必须是 file.revisions 中的一个 id）。 */
  "select-revision": [revisionId: string];
  /** 版本对比：选两版进 diff editor；ProjectView 补齐 baseContent 后回填 diffAgainst。 */
  "compare-revisions": [baseRevisionId: string, headRevisionId: string];
  /** 退出对比模式，回到单文件视图。 */
  "exit-diff": [];
  /**
   * 保存到工作区（`PUT .../workspace/file`）：**只落盘、不 commit**，字节随即变成
   * 待登记改动，等人在文件树顶栏点【登记】才成为候选修订。
   *
   * 分两步是刻意的：保存是编辑动作，登记是治理动作。存一次就出一版修订会把版本链
   * 冲成一堆半成品，而人改文件本来就是改几行存一下、再改几行再存一下。
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

// ─────────────────────────────────────────────────────────────────────────
// ApprovalCard（就地审批卡：钉在输入框上方，滚动区之外）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 就地审批卡（spec §3.5）。渲染在 ChatFeed 的滚动容器**外面**、输入框上面，
 * 所以往上翻历史时它不滚走——等待批准是当前唯一的阻塞点，不该翻两屏才找得到。
 *
 * 与其它栏位组件同一条契约：只吃 props、只吐 emits。提交拉取、请求体组装
 * （`domain/unified.ts:buildApproveBody`）、幂等键冻结、批准后刷新，全部在
 * ProjectView 里；本组件连 submission id 都不需要知道。
 */
export interface ApprovalCardProps {
  /** `domain/unified.ts:deriveApprovalCard` 的输出；"hidden" 时整卡不渲染。 */
  readonly state: ApprovalCardState;
  /** 门 id 原文（"G4"），仅用于 title 悬浮与 `approvalButtonLabel` 取里程碑文案。 */
  readonly gate: string;
  /** 门审查中文名（`GATE_REVIEW_NAMES[gate]` → "RTL审查"），卡片标题用这个。 */
  readonly review: string;
  /** 待审产物（快照成员修订）；null = 仍在加载，[] = 快照为空。 */
  readonly members: readonly ApprovalMember[] | null;
  /** 产物列表加载失败的人话；失败不挡审批操作，只在展开区提示。 */
  readonly membersError: string | null;
  /** 提交时刻（`submitted_at`），用于「已等待 X」；缺失为 null 则不显示等待时长。 */
  readonly submittedAt: string | null;
  /** 批准/驳回请求进行中：两个按钮都禁用并显示加载态。 */
  readonly deciding: boolean;
  /** 上一次决策失败的人话 + 建议（`humanizeDecisionError`）；无失败为 null。 */
  readonly decisionError: DecisionFailure | null;
  /** state="rejected" 时回显的驳回理由（`loadRejectionReason`）；未取到为 null。 */
  readonly rejectionReason: string | null;
}

export interface ApprovalCardEmits {
  /** 点击批准。里程碑门会同时建立里程碑，但那是 ProjectView 组装请求体时的事。 */
  approve: [];
  /** 点击驳回（reason 已由组件保证非空白，见 `domain/unified.ts:rejectDisabled`）。 */
  reject: [reason: string];
  /**
   * 点击某个待审产物 → 中栏编辑器打开。**必须带 revisionId**：快照钉的是提交那一
   * 刻的版本，agent 之后可能又写了新版，按最新版审等于审错内容。
   */
  "open-doc": [artifactId: string, revisionId: string];
}

export interface ChatFeedProps {
  readonly draft?: string;
  readonly closable?: boolean;
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
  /**
   * 就地审批卡的全部入参（收成一个嵌套对象，免得 props 列表被审批的 9 个字段撑爆）。
   * 无待审提交时为 null；ChatFeed 只负责把它原样透传给 ApprovalCard 并把
   * approve/reject 冒泡上去，自己不解读其中任何字段。
   */
  readonly approval: ApprovalCardProps | null;
  /** 上下文水位（环形指示）；runtime 未回报或旧会话为 null。 */
  readonly contextUsage: { readonly promptTokens: number | null; readonly contextWindow: number } | null;
  /** 「跳过所有权限」开关当前态（红线操作不受它影响）。 */
  readonly permissionSkipAll: boolean;
}

export interface ChatFeedEmits {
  close: [];
  "update:draft": [draft: string];
  /**
   * 发送消息。ChatFeed 不需要关心具体调哪个后端端点——composerMode="new-task"
   * 时 ProjectView 会调用 createTask 建首个任务；其余情况调用 sendMessage（服务端
   * 按 run 状态自动决定 prompt / steer 语义）。
   */
  send: [text: string];
  /** 点击「⏹ 打断」（`POST .../tasks/:agentId/abort`）；仅 canAbort=true 时应可点击。 */
  abort: [];
  /** 流内权限卡裁决（允许/拒绝一次挂起的工具调用）。 */
  "resolve-permission": [callId: string, allow: boolean];
  /** 「跳过所有权限」开关切换。 */
  "toggle-skip-permissions": [skip: boolean];
  /**
   * 点击产物卡关联的文档 → 中栏编辑器打开（不再弹抽屉，这是三栏相对 v3 的主要收益）。
   *
   * 两个来源都会带上 revisionId 钉住「当时登记的那一版」：审批卡钉的是快照那一刻，
   * 对话流产物卡钉的是 agent 登记那一刻。都不按最新版打开——同一张卡上的
   * `open-diff` 比的就是这一版与它的上一版，若「打开」跳到最新版，两个动作会指向
   * 不同的东西。第二参可选只为兼容不关心版本的调用方。
   */
  "open-doc": [artifactId: string, revisionId?: string];
  /**
   * 产物卡的「查看改动」→ 中栏 Monaco 的 diff 模式（这一版 vs 上一版）。
   *
   * 流内**不做**行级 diff：对话流是过程叙事，逐行改动属于编辑器的活，重复实现一套
   * 只会多一份要维护的高亮逻辑（对标结论 P1 的取舍，见 specs/agent-stream-benchmark.md §4）。
   * `revisionId` 是 head（这一版），base 由 ProjectView 按版本链取其前驱。
   */
  "open-diff": [artifactId: string, revisionId: string];
  /**
   * 打开运行记录面板（工具条上的「运行记录」链接、或证据摘要行）。带 jobId 时
   * 面板应展开并定位到该条；证据摘要行点击不定位任何一条，传 null。
   */
  "open-records": [jobId: string | null];
  /** 就地审批卡的批准（原样冒泡自 ApprovalCard）。 */
  approve: [];
  /** 就地审批卡的驳回（原样冒泡自 ApprovalCard）。 */
  reject: [reason: string];
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
