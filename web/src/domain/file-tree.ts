/**
 * 左栏文件树纯逻辑（spec §3.2 + §2 末尾警告）。
 *
 * ⚠️ 关联口径（原规格漏掉的坑）：`Artifact` 对象只有 id/artifact_type/created_at，
 * **没有 path 和 phase**——这两个字段只存在于当前选中 run 详情的 `docs[]`
 * （`TaskDocRef`），必须按 `artifact_id` 关联后才拿得到「路径」「阶段」两种视图
 * 的分组键。`buildFileTreeEntries` 就是这道关联，关联规则与契约
 * `views/project-view-contract.ts:FileTreeEntry` 顶部注释完全一致：
 * - revisions 按 version 升序，latestRevision 取最大 version；
 * - 当前 run 的 docs 按 artifact_id 匹配不到时，path/phase 为 null（可能是项目
 *   尚无 run，也可能是该 artifact 由其他历史 run 产出、未被当前 run 引用）。
 *
 * 现在路径**首选磁盘工作区**（`GET .../workspace/tree`）：产物落在真实的盘上，
 * 内容与版本谱系归 git，那棵树上的路径是事实而非推断。工作区同时带来一类新条目
 * ——**盘上有、还没登记的文件**（人刚新建的、agent 写了还没登记的），它们没有
 * revision，却必须在树上看得见，否则顶栏「工作区有 N 个改动」指着的东西是隐形的。
 *
 * ⚠️⚠️ 但两道**持久兜底**仍然留着，因为它们兜的不是同一件事：`docs[]` 只活在
 * runtime 进程内存里（registry handle 上的 `detail.docs`），**runtime 一重启就全没了**；
 * 而流水线产出的 `art-*` 从来就没有落过盘，工作区树里根本没有它们。这两类产物的
 * 路径/阶段只能从落库了的东西里反解，见 {@link pathFromRevisionTitle} /
 * {@link phaseFromArtifactId}。
 *
 * ProjectView.vue 已经内联实现了一份同等逻辑喂给 FileTree.vue（架构基线批次
 * 的注意事项 6 已说明"关联口径已实现，无需重做"）；这里额外导出纯函数版本，
 * 是为了把这条关联规则单独锁进测试用例，不依赖 Vue 组件树、不用等三栏拼起来
 * 才能验证「取不到分组键」这类坑有没有被处理好。
 *
 * 三种分组视图（buildPathTree / buildTypeTree / buildStageTree，或统一入口
 * buildFileTree）都以契约的 `FileTreeEntry` 为输入——也就是 FileTree.vue 实际
 * 拿到的 `props.entries`，可以直接喂给这里的函数，不需要重新关联一遍。
 *
 * 边界情况（spec R7）：项目无 run 时（`hasAgent=false`）docs 为空，全部 entry 的
 * path/phase 都是 null，「路径」「阶段」视图此时**降级**（返回空分组 + 提示
 * 文案，不崩、不静默丢数据）；「产物类型」视图的分组键 artifactType 不依赖
 * docs，不受影响，始终可用。
 */

import type { Artifact, ArtifactRevision, TaskDocRef, WorkspaceFileStatus, WorkspaceTreeFile } from "../api/types.ts";
import { artifactGroupName, ARTIFACT_GROUP_ORDER, artifactDocName } from "./artifacts.ts";
import { normalizeStageId, STAGE_CHAIN, STAGE_NAME_TEXT } from "./tasks.ts";
import {
  ARTIFACT_DOT_GLYPH,
  ARTIFACT_DOT_TEXT,
  artifactDotState,
  type ArtifactDotState,
  type FileTreeEntry,
  type FileTreeViewMode,
} from "../views/project-view-contract.ts";

export type { FileTreeEntry, FileTreeViewMode };

// ─────────────────────────────────────────────────────────────────────────
// artifact ↔ TaskDocRef 关联（左栏三视图分组键的唯一来源）
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// 持久兜底：从落库字段反解 path / phase（runtime 重启后 docs[] 为空时的唯一来源）
// ─────────────────────────────────────────────────────────────────────────

/** 看起来像文件路径：只含路径安全字符，且要么有目录层级、要么有扩展名。 */
const PATH_SHAPE = /^[\w.@+-]+(?:\/[\w.@+-]+)*$/;

/**
 * 从 `revision.title` 反解文件路径。
 *
 * skill 登记候选时把路径写进了标题（`runtime/skill-tools.ts:343`
 * `title: \`${skillId}: ${filename}\``），这是目前**唯一**持久带住路径的字段：
 *
 *     "fpga-rtl-build: rtl/pwm.v"                       → "rtl/pwm.v"
 *     "fpga-compile-and-repair: doc/compile/check.md"   → "doc/compile/check.md"
 *
 * 流水线（`runtime/loop.ts:493,513`）登记的标题里没有路径，必须解析失败返回
 * null——否则 `"intake document"` 会被当成文件名塞进路径视图，
 * `"RTL top=pwm"` 更会造出一个叫 `top=pwm` 的假文件。
 */
export function pathFromRevisionTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const sep = title.indexOf(": ");
  const candidate = (sep >= 0 ? title.slice(sep + 2) : title).trim();
  if (!candidate || !PATH_SHAPE.test(candidate)) return null;
  // 既无目录层级又无扩展名的裸词（"document"）不是路径，是标题残片。
  if (!candidate.includes("/") && !/\.[A-Za-z0-9]+$/.test(candidate)) return null;
  return candidate.replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * 从流水线 artifact id 反解阶段。
 *
 * `runtime/loop.ts:488` 的 id 形如 `art-<stage>-<8位hex>`（`art-register_spec-d6841ba9`），
 * stage 段就是 `TaskDocRef.phase` 的取值，且 id 是落库的主键——比内存里的
 * `docs[]` 可靠。skill 产出的 id（`fpga-<projectId>-<skillId>-<文件名>`）不走这条，
 * 它们靠标题里的路径显示，不需要 phase。
 *
 * 末段严格要求 8 位 hex，避免把 `art-foo-bar` 这种普通 id 的最后一段吃掉当哈希。
 */
export function phaseFromArtifactId(artifactId: string): string | null {
  const m = /^art-(.+)-[0-9a-f]{8}$/.exec(artifactId);
  return m?.[1] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// 盘上有、还没登记的文件：给它一个能进文件树的身份
// ─────────────────────────────────────────────────────────────────────────

/** 未登记文件的合成 id 前缀。artifact id 是 `art-*` / `fpga-*` / `ws-*`，都不含冒号。 */
const WORKSPACE_ENTRY_PREFIX = "ws:";

/**
 * 未登记文件的合成 `artifactId`。
 *
 * 它不是任何 artifact 的 id——这个文件还没有 artifact。但文件树的选中态、
 * `open-file` 事件、编辑器的"当前打开的是哪一行"全都以 artifactId 为键，所以未登记
 * 的行也得有一个**稳定且唯一**的键。用路径本身：登记之后这一行会换成真 artifact id，
 * 而在那之前，路径就是它全部的身份。
 */
export function workspaceEntryId(path: string): string {
  return `${WORKSPACE_ENTRY_PREFIX}${path}`;
}

/** 这个 id 是未登记文件的合成 id 吗（是则用 {@link workspaceEntryPath} 取回路径）。 */
export function isWorkspaceEntryId(artifactId: string): boolean {
  return artifactId.startsWith(WORKSPACE_ENTRY_PREFIX);
}

/** 从合成 id 取回工作区路径；不是合成 id 则返回 null。 */
export function workspaceEntryPath(artifactId: string): string | null {
  return isWorkspaceEntryId(artifactId) ? artifactId.slice(WORKSPACE_ENTRY_PREFIX.length) : null;
}

/**
 * 未登记文件按目录猜产物类型。
 *
 * **必须与服务端 `core/src/api/workspace-handlers.ts:artifactTypeForPath` 保持一致**：
 * 这一行在登记后会拿到服务端给的类型，两边不一致的话，点一下【登记】文件就会从一个
 * 分组跳到另一个分组，看着像文件被移动了。`doc/` 下究竟是哪种 GJB 文档从路径上猜不
 * 出来，服务端也只是落 `DETAILED_DESIGN` 占位，这里照抄。
 */
export function artifactTypeForWorkspacePath(path: string): string {
  if (path.startsWith("rtl/")) return "RTL_SOURCE_SET";
  if (path.startsWith("tb/")) return "TB_SOURCE_SET";
  if (path.startsWith("prj/constr/")) return "XDC_CANDIDATE";
  return "DETAILED_DESIGN";
}

/**
 * 按 artifact_id 把当前选中 run 的 `docs[]`（TaskDocRef）关联到 artifact + 其
 * revisions 上，产出契约定义的统一视图模型 `FileTreeEntry[]`。
 *
 * 路径的三条线索按可靠性排序：**工作区树 → 当前 run 的 docs[] → revision 标题**。
 * 工作区树是盘上的事实，排第一；后两条是它铺开之前（老项目、尚未迁移的修订）的
 * 兜底，仍然要留着——流水线产出的 `art-*` 从来就没有落过盘，只有标题这一条线索。
 *
 * 除了 artifact 侧的条目，工作区里**还没接上任何 artifact 的文件**也会各出一行
 * （`latestRevision: null`）。不出这些行的话，「工作区有 N 个改动」指着的东西在树上
 * 是隐形的，点了【登记】才凭空冒出来。
 *
 * @param artifacts           `GET .../artifacts`（仅 id/artifact_type/created_at）
 * @param revisionsByArtifact `GET .../artifacts/:aid/revisions` 按 artifact id 建的索引，值任意顺序
 * @param docs                当前选中 run 详情的 `docs[]`；项目无 run 或 run 详情未拉到时传 `[]`
 * @param workspaceFiles      `GET .../workspace/tree`.files；工作区还没建起来时传 `[]`
 */
export function buildFileTreeEntries(
  artifacts: readonly Artifact[],
  revisionsByArtifact: Readonly<Record<string, readonly ArtifactRevision[]>>,
  docs: readonly TaskDocRef[],
  workspaceFiles: readonly WorkspaceTreeFile[] = [],
): FileTreeEntry[] {
  const docByArtifact = new Map<string, TaskDocRef>();
  for (const doc of docs) docByArtifact.set(doc.artifact_id, doc);

  // `sim/` 下是证据不是产物（rules/25 §1），永远不会登记。放进文件树只会多出一类
  // 「永远变不成修订」的行，给它挂「○ 未登记」是句谎话——证据有运行记录面板。
  const onDisk = workspaceFiles.filter((f) => f.status !== "ignored");
  const wsByArtifact = new Map<string, WorkspaceTreeFile>();
  for (const file of onDisk) if (file.artifact_id) wsByArtifact.set(file.artifact_id, file);

  const entries: FileTreeEntry[] = [];
  const claimedPaths = new Set<string>();
  for (const artifact of artifacts) {
    const revisions = [...(revisionsByArtifact[artifact.id] ?? [])].sort((a, b) => a.version - b.version);
    const latestRevision = revisions[revisions.length - 1] ?? null;
    const workspaceFile = wsByArtifact.get(artifact.id) ?? null;
    // 既没有修订、盘上也没有文件：这个 artifact 没有任何可展示的东西，跳过不崩。
    if (!latestRevision && !workspaceFile) continue;
    if (workspaceFile) claimedPaths.add(workspaceFile.path);
    const doc = docByArtifact.get(artifact.id) ?? null;
    entries.push({
      artifactId: artifact.id,
      artifactType: artifact.artifact_type,
      createdAt: artifact.created_at,
      latestRevision,
      revisions,
      path: workspaceFile?.path ?? doc?.path ?? pathFromRevisionTitle(latestRevision?.title) ?? null,
      phase: doc?.phase ?? phaseFromArtifactId(artifact.id) ?? null,
      status: workspaceFile?.status ?? null,
    });
  }

  // 盘上有、还没接上 artifact 的文件——人刚新建的、agent 写了还没登记的。
  for (const file of onDisk) {
    if (file.artifact_id !== null || claimedPaths.has(file.path)) continue;
    entries.push({
      artifactId: workspaceEntryId(file.path),
      artifactType: artifactTypeForWorkspacePath(file.path),
      createdAt: file.modified_at,
      latestRevision: null,
      revisions: [],
      path: file.path,
      phase: null,
      status: file.status,
    });
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────
// 分组树输出模型
// ─────────────────────────────────────────────────────────────────────────

export interface FileTreeFileNode {
  readonly artifactId: string;
  /** 展示名：优先取 path 的 basename；path 缺失时退化为「中文文档名·id前8位」。 */
  readonly name: string;
  readonly path: string | null;
  readonly phase: string | null;
  readonly artifactType: string;
  readonly dotState: ArtifactDotState;
  readonly dotGlyph: string;
  readonly dotText: string;
  /** 为 null 表示这个文件在盘上、还没有任何修订（dotState 此时是 `unregistered`）。 */
  readonly latestRevision: ArtifactRevision | null;
  /** 该 artifact 的版本数（>1 时编辑器顶部应给出版本下拉）；未登记为 0。 */
  readonly revisionCount: number;
  /** 在磁盘工作区里的处境；为 null 表示这个产物根本不在工作区（只有 DB 里的正文）。 */
  readonly status: WorkspaceFileStatus | null;
}

export interface FileTreeGroupNode {
  /** 分组标识（路径视图为目录前缀，产物类型视图为中文分组名，阶段视图为 STAGE_CHAIN 节点 id）。 */
  readonly key: string;
  /** 展示文案。 */
  readonly label: string;
  readonly files: readonly FileTreeFileNode[];
}

export interface FileTreeResult {
  /** 空分组默认不出现在这里（D22 简约取向），因此永远不需要调用方再过滤一遍。 */
  readonly groups: readonly FileTreeGroupNode[];
  /** true 时该视图因缺少 run 数据而降级：groups 恒为空数组，UI 应渲染 degradedMessage。 */
  readonly degraded: boolean;
  readonly degradedMessage: string | null;
}

/** 取不到分组键的产物兜底分组 key（path/phase 视图专用，见契约注释）。 */
export const FILE_TREE_UNLINKED_GROUP_KEY = "__unlinked__";

/**
 * 两个视图的兜底分组文案**故意不同**：缺的东西不一样，说成一句话会误导。
 *
 * 路径视图缺的只是路径——流水线产出的 `art-*` 从来就没有文件路径，可它明明属于
 * 当前任务，写「未关联当前任务」等于告诉用户"这些产物跟你在跑的任务无关"，
 * 而这正是 runtime 重启那次故障给人的错误印象。阶段视图缺的才是归属关系。
 */
const UNPATHED_GROUP_LABEL = "未标注路径";
const UNLINKED_GROUP_LABEL = "未关联当前任务";

const PATH_ROOT_GROUP_KEY = "__root__";
const ROOT_GROUP_LABEL = "根目录";

const DEGRADED_MESSAGE = "项目暂无任务运行，尚无产物的路径/阶段归属信息；可切换到「产物类型」视图查看已有产物。";

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function displayName(entry: FileTreeEntry): string {
  if (entry.path) return basename(entry.path);
  // 没有路径时优先用阶段中文名：`DETAILED_DESIGN` 一个项目里会出现两次
  // （behavior_wave 与 register_spec），只写 GJB 文档名会得到两行一模一样的
  // 「PLDS 详细设计说明」；而 `文档名·id前8位` 这种兜底在 `art-rtl-d6841ba9`
  // 上会截出「·art-rtl-」这样的半截 id，可读性还不如阶段名。
  const stage = entry.phase ? STAGE_NAME_TEXT[normalizeStageId(entry.phase)] : undefined;
  if (stage) return stage;
  return `${artifactDocName(entry.artifactType)}·${entry.artifactId.slice(0, 8).replace(/-+$/, "")}`;
}

function toFileNode(entry: FileTreeEntry): FileTreeFileNode {
  const dotState = artifactDotState(entry.latestRevision?.state);
  return {
    artifactId: entry.artifactId,
    name: displayName(entry),
    path: entry.path,
    phase: entry.phase,
    artifactType: entry.artifactType,
    dotState,
    dotGlyph: ARTIFACT_DOT_GLYPH[dotState],
    dotText: ARTIFACT_DOT_TEXT[dotState],
    latestRevision: entry.latestRevision,
    revisionCount: entry.revisions.length,
    status: entry.status,
  };
}

function byName(a: FileTreeFileNode, b: FileTreeFileNode): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** 路径视图组内排序：按完整路径字典序（同目录下才退到文件名）。 */
function byPath(a: FileTreeFileNode, b: FileTreeFileNode): number {
  const pa = a.path ?? a.name;
  const pb = b.path ?? b.name;
  return pa < pb ? -1 : pa > pb ? 1 : byName(a, b);
}

function pushBucket(buckets: Map<string, FileTreeFileNode[]>, key: string, node: FileTreeFileNode): void {
  const bucket = buckets.get(key);
  if (bucket) bucket.push(node);
  else buckets.set(key, [node]);
}

// ─────────────────────────────────────────────────────────────────────────
// 路径视图（默认）：rtl/ tb/ sim/ doc/ prj/constr/（skills/fpga/rules/25-workspace-layout.md）
// ─────────────────────────────────────────────────────────────────────────

/** 已知目录前缀的展示顺序；未列出的前缀按字母序排在它们之后、根目录/未关联分组之前。 */
const PATH_GROUP_ORDER: readonly string[] = ["rtl", "tb", "sim", "doc", "prj/constr", "prj"];

/** 从 TaskDocRef.path 取目录分组 key（`prj/constr/` 下的文件整体归入 `prj/constr`，不再细分）。 */
export function pathGroupKey(path: string): string {
  const trimmed = path.replace(/^\.\//, "").replace(/^\/+/, "");
  if (trimmed.startsWith("prj/constr/")) return "prj/constr";
  const slash = trimmed.indexOf("/");
  if (slash < 0) return PATH_ROOT_GROUP_KEY;
  return trimmed.slice(0, slash);
}

function orderPathKeys(keys: readonly string[]): string[] {
  const known = PATH_GROUP_ORDER.filter((k) => keys.includes(k));
  const rest = keys
    .filter((k) => !PATH_GROUP_ORDER.includes(k) && k !== PATH_ROOT_GROUP_KEY && k !== FILE_TREE_UNLINKED_GROUP_KEY)
    .sort();
  const tail = [
    ...(keys.includes(PATH_ROOT_GROUP_KEY) ? [PATH_ROOT_GROUP_KEY] : []),
    ...(keys.includes(FILE_TREE_UNLINKED_GROUP_KEY) ? [FILE_TREE_UNLINKED_GROUP_KEY] : []),
  ];
  return [...known, ...rest, ...tail];
}

/** 路径视图（默认）。`hasAgent=false` 时降级：无 run 就没有 docs，path 全部缺失，无法分组。 */
export function buildPathTree(entries: readonly FileTreeEntry[], hasAgent: boolean): FileTreeResult {
  if (!hasAgent) return { groups: [], degraded: true, degradedMessage: DEGRADED_MESSAGE };

  const buckets = new Map<string, FileTreeFileNode[]>();
  for (const entry of entries) {
    const key = entry.path ? pathGroupKey(entry.path) : FILE_TREE_UNLINKED_GROUP_KEY;
    pushBucket(buckets, key, toFileNode(entry));
  }

  const groups: FileTreeGroupNode[] = orderPathKeys([...buckets.keys()]).map((key) => ({
    key,
    label: key === PATH_ROOT_GROUP_KEY ? ROOT_GROUP_LABEL : key === FILE_TREE_UNLINKED_GROUP_KEY ? UNPATHED_GROUP_LABEL : `${key}/`,
    files: [...buckets.get(key)!].sort(byPath),
  }));
  return { groups, degraded: false, degradedMessage: null };
}

// ─────────────────────────────────────────────────────────────────────────
// 产物类型视图：不依赖 docs，无 run 时同样可用（spec R7）
// ─────────────────────────────────────────────────────────────────────────

/** 产物类型视图，分组用 `domain/artifacts.ts:artifactGroupName` 取中文名，恒可用（不受 hasAgent 影响）。 */
export function buildTypeTree(entries: readonly FileTreeEntry[]): FileTreeResult {
  const buckets = new Map<string, FileTreeFileNode[]>();
  for (const entry of entries) {
    pushBucket(buckets, artifactGroupName(entry.artifactType), toFileNode(entry));
  }

  const keys = [...buckets.keys()];
  const orderedKeys = [
    ...ARTIFACT_GROUP_ORDER.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !ARTIFACT_GROUP_ORDER.includes(k)).sort(),
  ];
  const groups: FileTreeGroupNode[] = orderedKeys.map((key) => ({
    key,
    label: key,
    files: [...buckets.get(key)!].sort(byName),
  }));
  return { groups, degraded: false, degradedMessage: null };
}

// ─────────────────────────────────────────────────────────────────────────
// 阶段视图：与顶栏阶段条一一对应（STAGE_CHAIN 顺序）
// ─────────────────────────────────────────────────────────────────────────

const STAGE_ORDER_INDEX: ReadonlyMap<string, number> = new Map(STAGE_CHAIN.map((node, i) => [node.id, i]));

/** 阶段视图。`hasAgent=false` 时降级：无 run 就没有 docs，phase 全部缺失，无法分组。 */
export function buildStageTree(entries: readonly FileTreeEntry[], hasAgent: boolean): FileTreeResult {
  if (!hasAgent) return { groups: [], degraded: true, degradedMessage: DEGRADED_MESSAGE };

  const buckets = new Map<string, FileTreeFileNode[]>();
  for (const entry of entries) {
    const key = entry.phase ? normalizeStageId(entry.phase) : FILE_TREE_UNLINKED_GROUP_KEY;
    pushBucket(buckets, key, toFileNode(entry));
  }

  const knownKeys = [...buckets.keys()].filter((k) => k !== FILE_TREE_UNLINKED_GROUP_KEY);
  knownKeys.sort((a, b) => {
    const ia = STAGE_ORDER_INDEX.get(a);
    const ib = STAGE_ORDER_INDEX.get(b);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return a < b ? -1 : a > b ? 1 : 0; // 双方都不在 STAGE_CHAIN 上的未知 phase：字母序兜底
  });
  const orderedKeys = [...knownKeys, ...(buckets.has(FILE_TREE_UNLINKED_GROUP_KEY) ? [FILE_TREE_UNLINKED_GROUP_KEY] : [])];

  const groups: FileTreeGroupNode[] = orderedKeys.map((key) => ({
    key,
    label: key === FILE_TREE_UNLINKED_GROUP_KEY ? UNLINKED_GROUP_LABEL : (STAGE_NAME_TEXT[key] ?? key),
    files: [...buckets.get(key)!].sort(byName),
  }));
  return { groups, degraded: false, degradedMessage: null };
}

// ─────────────────────────────────────────────────────────────────────────
// 统一入口 + 阶段定位辅助（顶栏点击阶段节点 → 左栏切阶段视图并定位）
// ─────────────────────────────────────────────────────────────────────────

/** 三种视图的统一入口，FileTree.vue 按 viewMode 调这一个函数即可。 */
export function buildFileTree(entries: readonly FileTreeEntry[], viewMode: FileTreeViewMode, hasAgent: boolean): FileTreeResult {
  if (viewMode === "path") return buildPathTree(entries, hasAgent);
  if (viewMode === "type") return buildTypeTree(entries);
  return buildStageTree(entries, hasAgent);
}

/**
 * 顶栏 `select-stage` 传来的 stageId（对齐 STAGE_CHAIN 节点 id，含门节点 G1/G3/G4）
 * → 阶段视图分组 key。门节点（G1/G3/G4）本身不是任何 TaskDocRef.phase 的取值，
 * 阶段视图里不会出现对应分组，FileTree.vue 据此可判断"点了门节点、树上无处可
 * 定位"，不必特殊报错。
 */
export function stageFocusGroupKey(stageId: string): string {
  return normalizeStageId(stageId);
}

// ─────────────────────────────────────────────────────────────────────────
// 上下分栏：上「源文件」按路径，下「文档产物」按 GJB 文档名
// ─────────────────────────────────────────────────────────────────────────

/**
 * 无路径时按产物类型判定为源码的类型集合。
 *
 * `CONSTRAINT_DESIGN` 故意不在内：它是《PLDS 接口与约束设计说明》正文，
 * 是文档；真正的 `.xdc` 文件走 `XDC_CANDIDATE`（两者的 GJB 文档名相同，
 * 只能靠类型区分）。
 */
const SOURCE_ARTIFACT_TYPES: ReadonlySet<string> = new Set([
  "RTL_SOURCE_SET",
  "TB_SOURCE_SET",
  "XDC_CANDIDATE",
]);

/** 源码扩展名（Verilog/SystemVerilog/VHDL/约束/脚本）。 */
const SOURCE_EXT = /\.(?:v|sv|vh|svh|vhd|vhdl|xdc|sdc|tcl|do)$/i;

/** 源码目录前缀（`skills/fpga/rules/25-workspace-layout.md` 的工作区约定）。 */
const SOURCE_DIRS: ReadonlySet<string> = new Set(["rtl", "tb", "sim", "prj", "prj/constr"]);

/**
 * 该产物归上栏（源文件）还是下栏（文档产物）。
 *
 * **有路径时路径说了算**——`doc/compile/check_report.md` 的类型是
 * `STATIC_REPORT_SET`，靠类型判不出来，但路径一眼就是文档；反过来
 * `rtl/pwm.v` 无论登记成什么类型都是源码。只有路径缺失（流水线产出的
 * `art-*` 从来没有路径）才退回按产物类型判定。
 */
export function isSourceEntry(entry: FileTreeEntry): boolean {
  if (entry.path) return SOURCE_EXT.test(entry.path) || SOURCE_DIRS.has(pathGroupKey(entry.path));
  return SOURCE_ARTIFACT_TYPES.has(entry.artifactType);
}

/** 上下两栏的构建结果。 */
export interface FileTreeSections {
  /** 上栏：源文件。分组方式跟随 viewMode（默认路径视图）。 */
  readonly source: FileTreeResult;
  /** 下栏：文档产物，恒按 GJB 正式文档名分组，不受 viewMode 影响。 */
  readonly docs: FileTreeResult;
}

const DOC_SECTION_EMPTY = "本项目尚无文档产物。";

/**
 * 下栏「文档产物」：按 GJB 正式文档名分组。
 *
 * 组序沿用 `ARTIFACT_GROUP_ORDER`（需求 → 行为 → 架构 → RTL → 约束 → 其他），
 * 也就是研制流程顺序；同组内多份文档按文档名字典序。
 *
 * 行名优先 basename；无路径时用阶段中文名——`DETAILED_DESIGN` 在一个项目里会
 * 出现两次（behavior_wave 与 register_spec），只写 GJB 文档名会得到两行一模一样
 * 的「PLDS 详细设计说明」，加上阶段名才分得开。
 */
export function buildDocSection(entries: readonly FileTreeEntry[]): FileTreeResult {
  const buckets = new Map<string, FileTreeFileNode[]>();
  for (const entry of entries) {
    pushBucket(buckets, artifactDocName(entry.artifactType), toFileNode(entry));
  }
  if (buckets.size === 0) return { groups: [], degraded: false, degradedMessage: DOC_SECTION_EMPTY };

  const groupRank = new Map<string, number>();
  for (const entry of entries) {
    const docName = artifactDocName(entry.artifactType);
    const rank = ARTIFACT_GROUP_ORDER.indexOf(artifactGroupName(entry.artifactType));
    const normalized = rank < 0 ? ARTIFACT_GROUP_ORDER.length : rank;
    const prev = groupRank.get(docName);
    if (prev === undefined || normalized < prev) groupRank.set(docName, normalized);
  }

  const orderedKeys = [...buckets.keys()].sort((a, b) => {
    const ra = groupRank.get(a) ?? ARTIFACT_GROUP_ORDER.length;
    const rb = groupRank.get(b) ?? ARTIFACT_GROUP_ORDER.length;
    return ra !== rb ? ra - rb : a < b ? -1 : a > b ? 1 : 0;
  });

  const groups: FileTreeGroupNode[] = orderedKeys.map((key) => ({
    key,
    label: key,
    files: [...buckets.get(key)!].sort(byName),
  }));
  return { groups, degraded: false, degradedMessage: null };
}

/** 自由/兼容项目的中性文档分组，不展示 GJB/PLDS 正式文档名称。 */
export function buildGenericDocSection(entries: readonly FileTreeEntry[]): FileTreeResult {
  const buckets = new Map<string, FileTreeFileNode[]>();
  for (const entry of entries) {
    const key = artifactGroupName(entry.artifactType);
    const node = toFileNode(entry);
    pushBucket(buckets, key, {
      ...node,
      name: entry.path
        ? basename(entry.path)
        : `${key}·${entry.artifactId.slice(0, 8).replace(/-+$/, "")}`,
    });
  }
  if (buckets.size === 0) return { groups: [], degraded: false, degradedMessage: DOC_SECTION_EMPTY };
  const keys = [...buckets.keys()];
  const orderedKeys = [
    ...ARTIFACT_GROUP_ORDER.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !ARTIFACT_GROUP_ORDER.includes(key)).sort(),
  ];
  return {
    groups: orderedKeys.map((key) => ({
      key,
      label: key,
      files: [...buckets.get(key)!].sort(byName),
    })),
    degraded: false,
    degradedMessage: null,
  };
}

const SOURCE_SECTION_EMPTY = "本项目尚无源文件产物。";

/**
 * 上下分栏的统一入口：先把产物二分，再各自建树。
 *
 * `viewMode` 只作用于上栏——下栏是「符合 GJB 的文档都在这儿」的固定视图，
 * 换分组方式没有意义。上栏走路径视图时 `hasAgent` 已经不再是硬门槛：路径现在
 * 有 revision 标题这条持久来源，没有 run 详情也可能拿得到（见
 * {@link pathFromRevisionTitle}），所以只在**一个路径都没有**时才降级。
 */
export function buildSplitFileTree(
  entries: readonly FileTreeEntry[],
  viewMode: FileTreeViewMode,
  hasAgent: boolean,
  documentContext: "gjb" | "generic" = "gjb",
): FileTreeSections {
  const sourceEntries: FileTreeEntry[] = [];
  const docEntries: FileTreeEntry[] = [];
  for (const entry of entries) (isSourceEntry(entry) ? sourceEntries : docEntries).push(entry);

  let source: FileTreeResult;
  if (viewMode === "type") {
    source = buildTypeTree(sourceEntries);
  } else if (viewMode === "stage") {
    source = buildStageTree(sourceEntries, hasAgent || sourceEntries.some((e) => e.phase !== null));
  } else {
    source = buildPathTree(sourceEntries, hasAgent || sourceEntries.some((e) => e.path !== null));
  }
  if (!source.degraded && source.groups.length === 0) {
    source = { groups: [], degraded: false, degradedMessage: SOURCE_SECTION_EMPTY };
  }

  return {
    source,
    docs: documentContext === "gjb" ? buildDocSection(docEntries) : buildGenericDocSection(docEntries),
  };
}
