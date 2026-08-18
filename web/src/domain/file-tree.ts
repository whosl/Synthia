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

import type { Artifact, ArtifactRevision, TaskDocRef } from "../api/types.ts";
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

/**
 * 按 artifact_id 把当前选中 run 的 `docs[]`（TaskDocRef）关联到 artifact + 其
 * revisions 上，产出契约定义的统一视图模型 `FileTreeEntry[]`。
 *
 * @param artifacts           `GET .../artifacts`（仅 id/artifact_type/created_at）
 * @param revisionsByArtifact `GET .../artifacts/:aid/revisions` 按 artifact id 建的索引，值任意顺序
 * @param docs                当前选中 run 详情的 `docs[]`；项目无 run 或 run 详情未拉到时传 `[]`
 */
export function buildFileTreeEntries(
  artifacts: readonly Artifact[],
  revisionsByArtifact: Readonly<Record<string, readonly ArtifactRevision[]>>,
  docs: readonly TaskDocRef[],
): FileTreeEntry[] {
  const docByArtifact = new Map<string, TaskDocRef>();
  for (const doc of docs) docByArtifact.set(doc.artifact_id, doc);

  const entries: FileTreeEntry[] = [];
  for (const artifact of artifacts) {
    const revisions = [...(revisionsByArtifact[artifact.id] ?? [])].sort((a, b) => a.version - b.version);
    const latestRevision = revisions[revisions.length - 1];
    if (!latestRevision) continue; // 理论上每个 artifact 至少有一条 revision，防御性跳过，不崩
    const doc = docByArtifact.get(artifact.id) ?? null;
    entries.push({
      artifactId: artifact.id,
      artifactType: artifact.artifact_type,
      createdAt: artifact.created_at,
      latestRevision,
      revisions,
      path: doc?.path ?? null,
      phase: doc?.phase ?? null,
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
  readonly latestRevision: ArtifactRevision;
  /** 该 artifact 的版本数（>1 时编辑器顶部应给出版本下拉）。 */
  readonly revisionCount: number;
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

/** 未关联到当前 run 的产物兜底分组 key（path/phase 视图专用，见契约注释）。 */
export const FILE_TREE_UNLINKED_GROUP_KEY = "__unlinked__";
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
  return `${artifactDocName(entry.artifactType)}·${entry.artifactId.slice(0, 8)}`;
}

function toFileNode(entry: FileTreeEntry): FileTreeFileNode {
  const dotState = artifactDotState(entry.latestRevision.state);
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
  };
}

function byName(a: FileTreeFileNode, b: FileTreeFileNode): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
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
    label: key === PATH_ROOT_GROUP_KEY ? ROOT_GROUP_LABEL : key === FILE_TREE_UNLINKED_GROUP_KEY ? UNLINKED_GROUP_LABEL : `${key}/`,
    files: [...buckets.get(key)!].sort(byName),
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
