import { describe, expect, test } from "bun:test";
import type { Artifact, ArtifactRevision, TaskDocRef, WorkspaceFileStatus, WorkspaceTreeFile } from "../src/api/types.ts";
import {
  artifactTypeForWorkspacePath,
  buildDocSection,
  buildGenericDocSection,
  buildFileTree,
  buildFileTreeEntries,
  buildPathTree,
  buildSplitFileTree,
  buildStageTree,
  buildTypeTree,
  FILE_TREE_UNLINKED_GROUP_KEY,
  isSourceEntry,
  isWorkspaceEntryId,
  pathFromRevisionTitle,
  pathGroupKey,
  phaseFromArtifactId,
  stageFocusGroupKey,
  workspaceEntryId,
  workspaceEntryPath,
  type FileTreeEntry,
} from "../src/domain/file-tree.ts";
import {
  ARTIFACT_DOT_GLYPH,
  ARTIFACT_DOT_TEXT,
  ARTIFACT_DOT_TONE,
  artifactDotState,
} from "../src/views/project-view-contract.ts";

// ─────────────────────────────────────────────────────────────────────────
// 测试夹具
// ─────────────────────────────────────────────────────────────────────────

function revision(id: string, version: number, state: string, title?: string): ArtifactRevision {
  return {
    id,
    version,
    state,
    content_hash: `sha-${id}`,
    content_location: `blob://${id}`,
    ...(title === undefined ? {} : { title }),
    created_at: `2026-08-1${version}T00:00:00Z`,
  };
}

function artifact(id: string, artifactType: string, createdAt = "2026-08-10T00:00:00Z"): Artifact {
  return { id, artifact_type: artifactType, created_at: createdAt };
}

function doc(artifactId: string, path: string, phase: string, revisionId = `${artifactId}-r`): TaskDocRef {
  return { artifact_id: artifactId, path, phase, revision_id: revisionId };
}

/** `GET workspace/tree`.files 的一行。artifact 侧字段默认全空 = 盘上有、还没登记。 */
function wsFile(path: string, status: WorkspaceFileStatus, artifactId: string | null = null): WorkspaceTreeFile {
  return {
    path,
    status,
    bytes: 128,
    modified_at: "2026-08-19T00:00:00Z",
    artifact_id: artifactId,
    revision_id: null,
    version: null,
    revision_state: null,
    content_hash: null,
  };
}

/** 快捷构造一个已完成关联的 FileTreeEntry（跳过 buildFileTreeEntries，直接测分组逻辑用）。 */
function entry(partial: {
  artifactId: string;
  artifactType: string;
  path?: string | null;
  phase?: string | null;
  state?: string;
  status?: WorkspaceFileStatus | null;
  revisions?: readonly ArtifactRevision[];
}): FileTreeEntry {
  const revisions = partial.revisions ?? [revision(`${partial.artifactId}-v1`, 1, partial.state ?? "approved")];
  return {
    artifactId: partial.artifactId,
    artifactType: partial.artifactType,
    createdAt: "2026-08-10T00:00:00Z",
    latestRevision: revisions[revisions.length - 1] ?? null,
    revisions,
    path: partial.path ?? null,
    phase: partial.phase ?? null,
    status: partial.status ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// buildFileTreeEntries：artifact ↔ TaskDocRef 关联（本模块的核心难点）
// ─────────────────────────────────────────────────────────────────────────

describe("buildFileTreeEntries：artifact 与 TaskDocRef 按 artifact_id 关联", () => {
  test("docs 命中时贴上 path/phase；revisions 按 version 升序，latestRevision 取最大版本", () => {
    const artifacts = [artifact("a1", "RTL_SOURCE_SET")];
    const revisionsByArtifact = {
      a1: [revision("a1-v2", 2, "candidate"), revision("a1-v1", 1, "approved")], // 故意乱序
    };
    const docs = [doc("a1", "rtl/uart_tx.v", "rtl")];

    const [result] = buildFileTreeEntries(artifacts, revisionsByArtifact, docs);

    expect(result).toBeDefined();
    expect(result!.artifactId).toBe("a1");
    expect(result!.artifactType).toBe("RTL_SOURCE_SET");
    expect(result!.path).toBe("rtl/uart_tx.v");
    expect(result!.phase).toBe("rtl");
    expect(result!.revisions.map((r) => r.version)).toEqual([1, 2]); // 升序
    expect(result!.latestRevision!.id).toBe("a1-v2"); // 最大 version
    expect(result!.status).toBeNull(); // 没传工作区树 = 这个产物不在盘上
  });

  test("artifact 没有被当前 run 的 docs 引用时，path/phase 为 null（不是漏字段，也不崩）", () => {
    const artifacts = [artifact("a1", "RTL_SOURCE_SET")];
    const revisionsByArtifact = { a1: [revision("a1-v1", 1, "approved")] };

    const [result] = buildFileTreeEntries(artifacts, revisionsByArtifact, []); // docs 为空

    expect(result!.path).toBeNull();
    expect(result!.phase).toBeNull();
  });

  test("项目完全没有 run（docs=[]）时批量关联不崩，全部条目 path/phase 为 null", () => {
    const artifacts = [artifact("a1", "RTL_SOURCE_SET"), artifact("a2", "TB_SOURCE_SET")];
    const revisionsByArtifact = {
      a1: [revision("a1-v1", 1, "approved")],
      a2: [revision("a2-v1", 1, "candidate")],
    };

    const entries = buildFileTreeEntries(artifacts, revisionsByArtifact, []);

    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.path === null && e.phase === null)).toBe(true);
  });

  test("没有 revision、盘上也没有文件的 artifact 被防御性跳过（不产出半成品条目）", () => {
    const artifacts = [artifact("a1", "RTL_SOURCE_SET"), artifact("a2", "TB_SOURCE_SET")];
    const revisionsByArtifact = { a1: [revision("a1-v1", 1, "approved")] }; // a2 无 revision

    const entries = buildFileTreeEntries(artifacts, revisionsByArtifact, []);

    expect(entries.map((e) => e.artifactId)).toEqual(["a1"]);
  });

  test("docs 里引用了不存在的 artifact_id 时被忽略，不产生幽灵条目", () => {
    const artifacts = [artifact("a1", "RTL_SOURCE_SET")];
    const revisionsByArtifact = { a1: [revision("a1-v1", 1, "approved")] };
    const docs = [doc("a1", "rtl/uart_tx.v", "rtl"), doc("ghost", "rtl/ghost.v", "rtl")];

    const entries = buildFileTreeEntries(artifacts, revisionsByArtifact, docs);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.artifactId).toBe("a1");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildFileTreeEntries：磁盘工作区（`GET workspace/tree`）
//
// 工作区是路径的第一来源，也带来一类新条目：盘上有、还没登记的文件。
// ─────────────────────────────────────────────────────────────────────────

describe("buildFileTreeEntries：路径与状态以磁盘工作区为准", () => {
  test("工作区树里有这个 artifact → path 取盘上那条，压过 docs[] 与标题反解", () => {
    const artifacts = [artifact("a1", "RTL_SOURCE_SET")];
    const revisionsByArtifact = { a1: [revision("a1-v1", 1, "candidate", "skill: rtl/from_title.v")] };
    const docs = [doc("a1", "rtl/from_docs.v", "rtl")];
    const files = [wsFile("rtl/from_disk.v", "dirty", "a1")];

    const [result] = buildFileTreeEntries(artifacts, revisionsByArtifact, docs, files);

    // 盘上那条是事实，另外两条是推断——推断不该盖过事实。
    expect(result!.path).toBe("rtl/from_disk.v");
    expect(result!.status).toBe("dirty");
    // phase 不在工作区树里，仍旧走 docs[]。
    expect(result!.phase).toBe("rtl");
  });

  test("产物不在工作区（流水线产出的 art-*）→ status 为 null，不是 registered", () => {
    // null 与 registered 差着一整层语义：前者根本没有「改动/登记」这回事，
    // 后者是「盘上这份就是登记在册的那份」。混起来会让 art-* 显示成可编辑。
    const artifacts = [artifact("art-rtl-d6841ba9", "RTL_SOURCE_SET")];
    const revisionsByArtifact = { "art-rtl-d6841ba9": [revision("r1", 1, "approved")] };

    const [result] = buildFileTreeEntries(artifacts, revisionsByArtifact, [], [wsFile("rtl/other.v", "registered", "a-other")]);

    expect(result!.status).toBeNull();
  });

  test("盘上有、还没登记的文件各出一行（否则「工作区有 N 个改动」指着的东西是隐形的）", () => {
    const files = [wsFile("rtl/scratch.v", "untracked"), wsFile("doc/notes.md", "untracked")];

    const entries = buildFileTreeEntries([], {}, [], files);

    expect(entries.map((e) => e.path)).toEqual(["rtl/scratch.v", "doc/notes.md"]);
    expect(entries.every((e) => e.latestRevision === null && e.revisions.length === 0)).toBe(true);
    expect(entries.every((e) => e.status === "untracked")).toBe(true);
  });

  test("未登记行的 artifactId 是合成的 `ws:<path>`，可原样取回路径", () => {
    const [result] = buildFileTreeEntries([], {}, [], [wsFile("rtl/scratch.v", "untracked")]);

    expect(result!.artifactId).toBe(workspaceEntryId("rtl/scratch.v"));
    expect(isWorkspaceEntryId(result!.artifactId)).toBe(true);
    expect(workspaceEntryPath(result!.artifactId)).toBe("rtl/scratch.v");
  });

  test("真 artifact id 不会被误认成合成 id（三种真 id 都不含冒号）", () => {
    for (const id of ["art-rtl-d6841ba9", "fpga-p1-fpga-rtl-build-rtl-pwm.v", "ws-p1-rtl-pwm.v"]) {
      expect(isWorkspaceEntryId(id)).toBe(false);
      expect(workspaceEntryPath(id)).toBeNull();
    }
  });

  test("同一路径既有 artifact 又在盘上时只出一行，不重复", () => {
    const artifacts = [artifact("a1", "RTL_SOURCE_SET")];
    const revisionsByArtifact = { a1: [revision("a1-v1", 1, "candidate")] };
    const files = [wsFile("rtl/pwm.v", "dirty", "a1")];

    const entries = buildFileTreeEntries(artifacts, revisionsByArtifact, [], files);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.artifactId).toBe("a1");
  });

  test("`sim/` 下的文件（ignored）不进文件树——那是证据不是产物（rules/25 §1）", () => {
    // 给它挂「○ 未登记」是句谎话：它永远不会被登记，人却会一直盯着那个角标。
    const files = [wsFile("sim/wave.vcd", "ignored"), wsFile("rtl/pwm.v", "untracked")];

    const entries = buildFileTreeEntries([], {}, [], files);

    expect(entries.map((e) => e.path)).toEqual(["rtl/pwm.v"]);
  });

  test("ignored 文件即使挂着 artifact 也不解析该 artifact 的路径", () => {
    const artifacts = [artifact("a1", "RTL_SOURCE_SET")];
    const revisionsByArtifact = { a1: [revision("a1-v1", 1, "candidate", "skill: rtl/pwm.v")] };
    const files = [wsFile("sim/dump.vcd", "ignored", "a1")];

    const [result] = buildFileTreeEntries(artifacts, revisionsByArtifact, [], files);

    expect(result!.path).toBe("rtl/pwm.v"); // 退回标题反解，而不是拿 sim/ 那条当路径
    expect(result!.status).toBeNull();
  });

  test("工作区没建起来（老项目）时传 [] 一切照旧，全页仍从 DB 渲染", () => {
    const artifacts = [artifact("a1", "RTL_SOURCE_SET")];
    const revisionsByArtifact = { a1: [revision("a1-v1", 1, "candidate", "skill: rtl/pwm.v")] };

    const [result] = buildFileTreeEntries(artifacts, revisionsByArtifact, [], []);

    expect(result!.path).toBe("rtl/pwm.v");
    expect(result!.status).toBeNull();
  });
});

describe("artifactTypeForWorkspacePath：未登记文件按目录猜类型", () => {
  test.each([
    ["rtl/pwm.v", "RTL_SOURCE_SET"],
    ["tb/tb_top.v", "TB_SOURCE_SET"],
    ["prj/constr/top.xdc", "XDC_CANDIDATE"],
    ["doc/notes.md", "DETAILED_DESIGN"],
    ["prj/build.tcl", "DETAILED_DESIGN"], // prj/ 下非 constr/ 的没有专属类型
    ["readme.md", "DETAILED_DESIGN"],
  ])("%p → %p", (path, expected) => {
    expect(artifactTypeForWorkspacePath(path)).toBe(expected);
  });

  test("必须与服务端 workspace-handlers.ts:artifactTypeForPath 同口径", () => {
    // 两边不一致的话，点一下【登记】文件就会从一个分组跳到另一个分组，看着像文件被移动了。
    // 这里锁住的是本地这一半；服务端那一半由 core/tests 的登记用例锁。
    const [result] = buildFileTreeEntries([], {}, [], [wsFile("tb/tb_uart.sv", "untracked")]);
    expect(result!.artifactType).toBe("TB_SOURCE_SET");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildPathTree：路径视图（默认），目录约定 rtl/ tb/ sim/ doc/ prj/constr/
// ─────────────────────────────────────────────────────────────────────────

describe("buildPathTree：路径视图", () => {
  const entries: FileTreeEntry[] = [
    entry({ artifactId: "a1", artifactType: "RTL_SOURCE_SET", path: "rtl/uart_tx.v", state: "approved" }),
    entry({ artifactId: "a2", artifactType: "RTL_SOURCE_SET", path: "rtl/uart_rx.v", state: "approved" }),
    entry({ artifactId: "a3", artifactType: "TB_SOURCE_SET", path: "tb/uart_tb.sv", state: "candidate" }),
    entry({ artifactId: "a4", artifactType: "ARCHITECTURE_DESIGN", path: "doc/架构设计.md", state: "approved" }),
    entry({ artifactId: "a5", artifactType: "CONSTRAINT_DESIGN", path: "prj/constr/uart.xdc", state: "candidate" }),
  ];

  test("按目录前缀分组，展示顺序 rtl/ → tb/ → doc/ → prj/constr/", () => {
    const result = buildPathTree(entries, true);
    expect(result.degraded).toBe(false);
    expect(result.groups.map((g) => g.key)).toEqual(["rtl", "tb", "doc", "prj/constr"]);
    expect(result.groups.map((g) => g.label)).toEqual(["rtl/", "tb/", "doc/", "prj/constr/"]);
    expect(result.groups[0]!.files.map((f) => f.name)).toEqual(["uart_rx.v", "uart_tx.v"]); // 组内按名排序
  });

  test("prj/constr/ 下的文件整体归入 prj/constr 一组，不再按更深层级细分", () => {
    const key = pathGroupKey("prj/constr/sub/uart.xdc");
    expect(key).toBe("prj/constr");
  });

  test("没有目录层级的路径归入「根目录」分组，排在已知目录之后", () => {
    const withRoot = [...entries, entry({ artifactId: "a6", artifactType: "RTL_SOURCE_SET", path: "readme.md" })];
    const result = buildPathTree(withRoot, true);
    expect(result.groups.at(-1)!.key).toBe("__root__");
    expect(result.groups.at(-1)!.label).toBe("根目录");
  });

  test("path=null 的条目归入「未标注路径」兜底分组，排在最后", () => {
    const withUnlinked = [...entries, entry({ artifactId: "a7", artifactType: "SYNTH_RESULT", path: null })];
    const result = buildPathTree(withUnlinked, true);
    const last = result.groups.at(-1)!;
    expect(last.key).toBe(FILE_TREE_UNLINKED_GROUP_KEY);
    // 路径视图缺的是路径而非归属：这些产物就属于当前任务，只是没有文件路径。
    // 阶段视图同一个 key 才叫「未关联当前任务」，见 buildStageTree 的用例。
    expect(last.label).toBe("未标注路径");
    expect(last.files.map((f) => f.artifactId)).toEqual(["a7"]);
  });

  test("空分组不出现在结果里（D22）：没有 sim/ 数据时不应有 sim 分组", () => {
    const result = buildPathTree(entries, true);
    expect(result.groups.some((g) => g.key === "sim")).toBe(false);
  });

  test("R7 边界：项目无 run（hasAgent=false）时降级，groups 为空、给出提示文案，不崩不丢数据", () => {
    const result = buildPathTree(entries, false);
    expect(result.degraded).toBe(true);
    expect(result.groups).toEqual([]);
    expect(result.degradedMessage).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildTypeTree：产物类型视图，不依赖 docs，R7 边界下仍可用
// ─────────────────────────────────────────────────────────────────────────

describe("buildTypeTree：产物类型视图", () => {
  test("用 artifactGroupName 中文分组，未映射类型归「其他」", () => {
    const entries: FileTreeEntry[] = [
      entry({ artifactId: "a1", artifactType: "RTL_SOURCE_SET" }),
      entry({ artifactId: "a2", artifactType: "TB_SOURCE_SET" }),
      entry({ artifactId: "a3", artifactType: "SOME_UNKNOWN_TYPE" }),
    ];
    const result = buildTypeTree(entries);
    expect(result.degraded).toBe(false);
    const rtlGroup = result.groups.find((g) => g.key === "RTL");
    expect(rtlGroup?.files.map((f) => f.artifactId).sort()).toEqual(["a1", "a2"]);
    expect(result.groups.find((g) => g.key === "其他")?.files.map((f) => f.artifactId)).toEqual(["a3"]);
  });

  test("按 ARTIFACT_GROUP_ORDER 顺序展示（需求 → 行为 → 架构 → RTL → 约束 → 其他）", () => {
    const entries: FileTreeEntry[] = [
      entry({ artifactId: "a1", artifactType: "CONSTRAINT_DESIGN" }), // 架构
      entry({ artifactId: "a2", artifactType: "RTL_SOURCE_SET" }), // RTL
      entry({ artifactId: "a3", artifactType: "DEVELOPMENT_REQUIREMENTS" }), // 需求
    ];
    const result = buildTypeTree(entries);
    expect(result.groups.map((g) => g.key)).toEqual(["需求", "架构", "RTL"]);
  });

  test("R7 边界：即使项目无 run（全部 entry path/phase=null），产物类型视图依旧正常分组，不降级", () => {
    const entries: FileTreeEntry[] = [
      entry({ artifactId: "a1", artifactType: "RTL_SOURCE_SET", path: null, phase: null }),
      entry({ artifactId: "a2", artifactType: "TB_SOURCE_SET", path: null, phase: null }),
    ];
    const result = buildTypeTree(entries);
    expect(result.degraded).toBe(false);
    expect(result.groups.map((g) => g.key)).toEqual(["RTL"]);
    expect(result.groups[0]!.files).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildStageTree：阶段视图，与顶栏阶段条一一对应
// ─────────────────────────────────────────────────────────────────────────

describe("buildStageTree：阶段视图", () => {
  test("按 STAGE_CHAIN 顺序展示，中文名取自 STAGE_NAME_TEXT", () => {
    const entries: FileTreeEntry[] = [
      entry({ artifactId: "a1", artifactType: "RTL_SOURCE_SET", phase: "tb" }),
      entry({ artifactId: "a2", artifactType: "RTL_SOURCE_SET", phase: "intake" }),
      entry({ artifactId: "a3", artifactType: "RTL_SOURCE_SET", phase: "architecture" }),
    ];
    const result = buildStageTree(entries, true);
    expect(result.degraded).toBe(false);
    expect(result.groups.map((g) => g.key)).toEqual(["intake", "architecture", "tb"]); // 阶段链顺序，非输入顺序
    expect(result.groups[0]!.label).toBe("需求解析");
  });

  test("runtime 阶段别名 rtl_build 归一化为 rtl，与 phase=rtl 的条目合并到同一组", () => {
    const entries: FileTreeEntry[] = [
      entry({ artifactId: "a1", artifactType: "RTL_SOURCE_SET", phase: "rtl_build" }),
      entry({ artifactId: "a2", artifactType: "RTL_SOURCE_SET", phase: "rtl" }),
    ];
    const result = buildStageTree(entries, true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.key).toBe("rtl");
    expect(result.groups[0]!.files.map((f) => f.artifactId).sort()).toEqual(["a1", "a2"]);
  });

  test("未关联当前 run（phase=null）的条目归入兜底分组，排在最后", () => {
    const entries: FileTreeEntry[] = [
      entry({ artifactId: "a1", artifactType: "RTL_SOURCE_SET", phase: "rtl" }),
      entry({ artifactId: "a2", artifactType: "RTL_SOURCE_SET", phase: null }),
    ];
    const result = buildStageTree(entries, true);
    expect(result.groups.at(-1)!.key).toBe(FILE_TREE_UNLINKED_GROUP_KEY);
    // 阶段视图缺的才是归属关系，文案与路径视图的「未标注路径」刻意不同。
    expect(result.groups.at(-1)!.label).toBe("未关联当前任务");
    expect(result.groups.at(-1)!.files.map((f) => f.artifactId)).toEqual(["a2"]);
  });

  test("R7 边界：项目无 run（hasAgent=false）时降级，groups 为空、给出提示文案", () => {
    const entries: FileTreeEntry[] = [entry({ artifactId: "a1", artifactType: "RTL_SOURCE_SET", phase: "rtl" })];
    const result = buildStageTree(entries, false);
    expect(result.degraded).toBe(true);
    expect(result.groups).toEqual([]);
    expect(result.degradedMessage).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 文件节点状态点（四态映射，走 artifactDotState）
// ─────────────────────────────────────────────────────────────────────────

describe("文件节点状态点：四态映射到 dotState/dotGlyph/dotText", () => {
  test.each([
    ["approved", "approved", "✅", "已批准"],
    ["candidate", "candidate", "🔵", "候选"],
    ["in_review", "candidate", "🔵", "候选"],
    ["rejected", "rejected", "⚠️", "已驳回"],
    ["superseded", "invalidated", "⊘", "已作废"],
    ["invalidated", "invalidated", "⊘", "已作废"],
  ] as const)("revision.state=%s → dotState=%s", (rawState, dotState, glyph, text) => {
    const entries: FileTreeEntry[] = [entry({ artifactId: "a1", artifactType: "RTL_SOURCE_SET", state: rawState })];
    const result = buildTypeTree(entries);
    const node = result.groups[0]!.files[0]!;
    expect(node.dotState).toBe(dotState);
    expect(node.dotGlyph).toBe(glyph);
    expect(node.dotText).toBe(text);
  });

  test("没有任何修订（盘上有、还没登记）→ unregistered，不是 candidate", () => {
    // 候选是已经登记、能进快照的东西；未登记的文件进不了任何一道门。
    // 归进 candidate 会是实打实的谎：树上标着「🔵 候选」，提交快照时它却不在里面。
    expect(artifactDotState(null)).toBe("unregistered");
    expect(artifactDotState(undefined)).toBe("unregistered");

    const [wsEntry] = buildFileTreeEntries([], {}, [], [wsFile("rtl/scratch.v", "untracked")]);
    const node = buildTypeTree([wsEntry!]).groups[0]!.files[0]!;
    expect(node.dotState).toBe("unregistered");
    expect(node.dotGlyph).toBe("○");
    expect(node.dotText).toBe("未登记");
    expect(node.revisionCount).toBe(0);
    expect(node.latestRevision).toBeNull();
    expect(node.status).toBe("untracked");
  });

  test("未知 state 仍按候选兜底（后端加了新状态也不会画成空白）", () => {
    expect(artifactDotState("some_future_state")).toBe("candidate");
  });

  test("五种状态点在符号/文案/语气色三张表里都有，不会画出空白角标", () => {
    for (const state of ["approved", "candidate", "rejected", "invalidated", "unregistered"] as const) {
      expect(ARTIFACT_DOT_GLYPH[state]).toBeTruthy();
      expect(ARTIFACT_DOT_TEXT[state]).toBeTruthy();
      expect(ARTIFACT_DOT_TONE[state]).toBeTruthy();
    }
    // 未登记与已作废同为 neutral：两者都不在治理链上，都不该用告警色抢注意力——
    // 真正要人动手的提示在文件树顶栏那条横幅上，不在行内。
    expect(ARTIFACT_DOT_TONE.unregistered).toBe("neutral");
    expect(ARTIFACT_DOT_TONE.rejected).toBe("danger");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildFileTree：统一入口 + stageFocusGroupKey：顶栏阶段点击联动定位
// ─────────────────────────────────────────────────────────────────────────

describe("buildFileTree：统一入口按 viewMode 分发", () => {
  const entries: FileTreeEntry[] = [entry({ artifactId: "a1", artifactType: "RTL_SOURCE_SET", path: "rtl/x.v", phase: "rtl" })];

  test("path/type/stage 三种 viewMode 均正确分发", () => {
    expect(buildFileTree(entries, "path", true).groups[0]!.key).toBe("rtl");
    expect(buildFileTree(entries, "type", true).groups[0]!.key).toBe("RTL");
    expect(buildFileTree(entries, "stage", true).groups[0]!.key).toBe("rtl");
  });

  test("hasAgent=false 时 path/stage 降级，type 不受影响", () => {
    expect(buildFileTree(entries, "path", false).degraded).toBe(true);
    expect(buildFileTree(entries, "stage", false).degraded).toBe(true);
    expect(buildFileTree(entries, "type", false).degraded).toBe(false);
  });
});

describe("stageFocusGroupKey：顶栏点击阶段节点后左栏定位用", () => {
  test("普通阶段 id 原样返回", () => {
    expect(stageFocusGroupKey("architecture")).toBe("architecture");
  });

  test("runtime 别名归一化，与阶段视图分组 key 对齐", () => {
    expect(stageFocusGroupKey("rtl_build")).toBe("rtl");
  });

  test("门节点 id（G1/G3/G4）原样返回——阶段视图里不会有对应分组，FileTree.vue 据此判断无处可定位", () => {
    expect(stageFocusGroupKey("G3")).toBe("G3");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 持久兜底：runtime 重启后 docs[] 为空，path/phase 必须还能从落库字段反解
// ─────────────────────────────────────────────────────────────────────────

describe("pathFromRevisionTitle：从 revision 标题反解路径", () => {
  test.each([
    ["fpga-rtl-build: rtl/pwm.v", "rtl/pwm.v"],
    ["fpga-tb-write: tb/tb_top.v", "tb/tb_top.v"],
    ["fpga-compile-and-repair: doc/compile/check_report.md", "doc/compile/check_report.md"],
    ["fpga-xdc: prj/constr/top.xdc", "prj/constr/top.xdc"],
  ])("skill 登记的标题 %p → %p", (title, expected) => {
    expect(pathFromRevisionTitle(title)).toBe(expected);
  });

  test.each([
    ["intake document"], // loop.ts:493 —— "document" 不是文件名
    ["RTL top=pwm"], // loop.ts:513 —— 会造出一个叫 top=pwm 的假文件
    ["architecture document"],
    [""],
  ])("流水线登记的标题 %p 解析失败，返回 null", (title) => {
    expect(pathFromRevisionTitle(title)).toBeNull();
  });

  test("标题缺失（老数据没有 title 字段）时返回 null，不抛", () => {
    expect(pathFromRevisionTitle(null)).toBeNull();
    expect(pathFromRevisionTitle(undefined)).toBeNull();
  });

  test("裸路径（没有 skill 前缀）也认，但裸词不认", () => {
    expect(pathFromRevisionTitle("rtl/pwm.v")).toBe("rtl/pwm.v");
    expect(pathFromRevisionTitle("readme.md")).toBe("readme.md"); // 有扩展名，算根目录文件
    expect(pathFromRevisionTitle("document")).toBeNull(); // 无目录无扩展名
  });

  test("前导 ./ 与 / 被剥掉，与 pathGroupKey 的口径一致", () => {
    expect(pathFromRevisionTitle("skill: ./rtl/pwm.v")).toBe("rtl/pwm.v");
  });
});

describe("phaseFromArtifactId：从流水线 artifact id 反解阶段", () => {
  test.each([
    ["art-intake-d6841ba9", "intake"],
    ["art-behavior_wave-d6841ba9", "behavior_wave"],
    ["art-register_spec-d6841ba9", "register_spec"],
    ["art-rtl-d6841ba9", "rtl"],
  ])("%p → %p", (id, expected) => {
    expect(phaseFromArtifactId(id)).toBe(expected);
  });

  test("skill 产出的 id 不走这条（它们靠标题里的路径显示）", () => {
    expect(phaseFromArtifactId("fpga-p1-fpga-rtl-build-rtl-pwm.v")).toBeNull();
  });

  test("末段不是 8 位 hex 的普通 id 不被误吃掉最后一段", () => {
    expect(phaseFromArtifactId("art-foo-bar")).toBeNull();
    expect(phaseFromArtifactId("art-intake-d6841ba")).toBeNull(); // 7 位
  });
});

describe("buildFileTreeEntries：docs[] 为空时退到持久兜底（runtime 重启回归）", () => {
  test("skill 产物从标题拿回路径，流水线产物从 id 拿回阶段", () => {
    const artifacts = [
      artifact("fpga-p1-fpga-rtl-build-rtl-pwm.v", "RTL_SOURCE_SET"),
      artifact("art-register_spec-d6841ba9", "DETAILED_DESIGN"),
    ];
    const revisionsByArtifact = {
      "fpga-p1-fpga-rtl-build-rtl-pwm.v": [revision("r1", 1, "candidate", "fpga-rtl-build: rtl/pwm.v")],
      "art-register_spec-d6841ba9": [revision("r2", 1, "approved", "register_spec document")],
    };

    const entries = buildFileTreeEntries(artifacts, revisionsByArtifact, []); // docs 空 = runtime 刚重启

    expect(entries[0]!.path).toBe("rtl/pwm.v");
    expect(entries[1]!.path).toBeNull(); // 标题里没有路径，不硬编
    expect(entries[1]!.phase).toBe("register_spec");
  });

  test("docs[] 命中时以 docs 为准，兜底不覆盖第一手记录", () => {
    const artifacts = [artifact("art-rtl-d6841ba9", "RTL_SOURCE_SET")];
    const revisionsByArtifact = { "art-rtl-d6841ba9": [revision("r1", 1, "approved", "skill: rtl/from_title.v")] };
    const docs = [doc("art-rtl-d6841ba9", "rtl/from_docs.v", "rtl_build")];

    const [entry0] = buildFileTreeEntries(artifacts, revisionsByArtifact, docs);

    expect(entry0!.path).toBe("rtl/from_docs.v");
    expect(entry0!.phase).toBe("rtl_build");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 上下分栏：上「源文件」按路径，下「文档产物」按 GJB 文档名
// ─────────────────────────────────────────────────────────────────────────

describe("isSourceEntry：源文件 / 文档产物二分", () => {
  test("有路径时路径说了算：doc/ 下的报告归文档，哪怕类型不带 DOC 字样", () => {
    expect(isSourceEntry(entry({ artifactId: "a", artifactType: "STATIC_REPORT_SET", path: "doc/compile/check_report.md" }))).toBe(false);
  });

  test("有路径时路径说了算：rtl/ 与 tb/ 下的文件归源文件", () => {
    expect(isSourceEntry(entry({ artifactId: "a", artifactType: "RTL_SOURCE_SET", path: "rtl/pwm.v" }))).toBe(true);
    expect(isSourceEntry(entry({ artifactId: "b", artifactType: "TB_SOURCE_SET", path: "tb/tb_top.v" }))).toBe(true);
  });

  test("按扩展名兜底：约束文件即使不在已知目录下也算源文件", () => {
    expect(isSourceEntry(entry({ artifactId: "a", artifactType: "XDC_CANDIDATE", path: "custom/top.xdc" }))).toBe(true);
  });

  test("无路径时按产物类型：RTL/TB/XDC 归源文件，其余归文档", () => {
    expect(isSourceEntry(entry({ artifactId: "a", artifactType: "RTL_SOURCE_SET", path: null }))).toBe(true);
    expect(isSourceEntry(entry({ artifactId: "b", artifactType: "DEVELOPMENT_REQUIREMENTS", path: null }))).toBe(false);
    expect(isSourceEntry(entry({ artifactId: "c", artifactType: "ARCHITECTURE_DESIGN", path: null }))).toBe(false);
  });

  test("CONSTRAINT_DESIGN 是说明书正文（归文档），XDC_CANDIDATE 才是 .xdc 文件——两者 GJB 文档名相同，只能靠类型分", () => {
    expect(isSourceEntry(entry({ artifactId: "a", artifactType: "CONSTRAINT_DESIGN", path: null }))).toBe(false);
    expect(isSourceEntry(entry({ artifactId: "b", artifactType: "XDC_CANDIDATE", path: null }))).toBe(true);
  });
});

describe("buildDocSection：下栏按 GJB 正式文档名分组", () => {
  test("组名是 GJB 文档名，组序沿用研制流程顺序（需求 → 行为 → 架构）", () => {
    const entries: FileTreeEntry[] = [
      entry({ artifactId: "a1", artifactType: "ARCHITECTURE_DESIGN", phase: "architecture" }),
      entry({ artifactId: "a2", artifactType: "DEVELOPMENT_REQUIREMENTS", phase: "intake" }),
      entry({ artifactId: "a3", artifactType: "DETAILED_DESIGN", phase: "behavior_wave" }),
    ];
    const result = buildDocSection(entries);
    expect(result.groups.map((g) => g.label)).toEqual([
      "研制（开发）技术要求",
      "PLDS 详细设计说明",
      "PLDS 结构设计说明",
    ]);
  });

  test("同一份 GJB 文档出现两次时靠阶段中文名区分，不出现两行同名", () => {
    const entries: FileTreeEntry[] = [
      entry({ artifactId: "a1", artifactType: "DETAILED_DESIGN", phase: "behavior_wave" }),
      entry({ artifactId: "a2", artifactType: "DETAILED_DESIGN", phase: "register_spec" }),
    ];
    const result = buildDocSection(entries);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.files.map((f) => f.name)).toEqual(["寄存器规格", "行为与波形设计"]);
  });

  test("有路径的文档行名用 basename，不用阶段名", () => {
    const entries: FileTreeEntry[] = [
      entry({ artifactId: "a1", artifactType: "STATIC_REPORT_SET", path: "doc/compile/check_report.md", phase: "rtl" }),
    ];
    expect(buildDocSection(entries).groups[0]!.files[0]!.name).toBe("check_report.md");
  });

  test("下栏为空时给提示而不是空白（degraded 保持 false，它不是降级）", () => {
    const result = buildDocSection([]);
    expect(result.groups).toEqual([]);
    expect(result.degraded).toBe(false);
    expect(result.degradedMessage).toBeTruthy();
  });
});

describe("buildGenericDocSection：自由/兼容项目使用中性文档语义", () => {
  test("无路径条目只显示通用分组和短 id，不泄漏 PLDS/GJB 正式文档名", () => {
    const result = buildGenericDocSection([
      entry({ artifactId: "legacy-requirements-1", artifactType: "DEVELOPMENT_REQUIREMENTS" }),
      entry({ artifactId: "legacy-design-1", artifactType: "DETAILED_DESIGN" }),
    ]);
    expect(result.groups.map((group) => group.label)).toEqual(["需求", "行为"]);
    const text = result.groups.flatMap((group) => group.files.map((file) => file.name)).join(" ");
    expect(text).not.toContain("PLDS");
    expect(text).not.toContain("研制（开发）技术要求");
  });
});

describe("buildSplitFileTree：p1 现场数据的完整分栏", () => {
  /** 与 GET /api/v1/projects/p1/artifacts 现场返回一致（runtime 重启后，docs[] 为空）。 */
  const p1: FileTreeEntry[] = [
    entry({ artifactId: "art-intake-d6841ba9", artifactType: "DEVELOPMENT_REQUIREMENTS", phase: "intake" }),
    entry({ artifactId: "art-behavior_wave-d6841ba9", artifactType: "DETAILED_DESIGN", phase: "behavior_wave" }),
    entry({ artifactId: "art-architecture-d6841ba9", artifactType: "ARCHITECTURE_DESIGN", phase: "architecture" }),
    entry({ artifactId: "art-register_spec-d6841ba9", artifactType: "DETAILED_DESIGN", phase: "register_spec" }),
    entry({ artifactId: "art-rtl-d6841ba9", artifactType: "RTL_SOURCE_SET", phase: "rtl" }),
    entry({ artifactId: "fpga-p1-fpga-tb-write-tb-tb_top.v", artifactType: "TB_SOURCE_SET", path: "tb/tb_top.v" }),
    entry({ artifactId: "fpga-p1-fpga-rtl-build-rtl-pwm.v", artifactType: "RTL_SOURCE_SET", path: "rtl/pwm.v" }),
    entry({
      artifactId: "fpga-p1-fpga-compile-and-repair-doc-compile-check_report.md",
      artifactType: "STATIC_REPORT_SET",
      path: "doc/compile/check_report.md",
    }),
  ];

  test("上栏只有源文件，按 rtl/ → tb/ 排；无路径的 RTL 落「未标注路径」", () => {
    const { source } = buildSplitFileTree(p1, "path", true);
    expect(source.groups.map((g) => g.key)).toEqual(["rtl", "tb", FILE_TREE_UNLINKED_GROUP_KEY]);
    expect(source.groups[0]!.files.map((f) => f.name)).toEqual(["pwm.v"]);
    expect(source.groups[1]!.files.map((f) => f.name)).toEqual(["tb_top.v"]);
    expect(source.groups[2]!.label).toBe("未标注路径");
    // 没有路径就退到阶段中文名，不要 `PLDS 源代码（RTL）·art-rtl-` 这种半截 id。
    expect(source.groups[2]!.files.map((f) => f.name)).toEqual(["RTL 生成"]);
  });

  test("下栏是全部 GJB 文档，含 doc/ 下的报告；源文件一份都不漏进来", () => {
    const { docs } = buildSplitFileTree(p1, "path", true);
    const names = docs.groups.flatMap((g) => g.files.map((f) => f.name));
    expect(names).toContain("check_report.md");
    expect(names).not.toContain("pwm.v");
    expect(names).not.toContain("tb_top.v");
    expect(docs.groups.flatMap((g) => g.files)).toHaveLength(5);
  });

  test("两栏加起来不多不少就是全部产物（不丢件、不重复）", () => {
    const { source, docs } = buildSplitFileTree(p1, "path", true);
    const ids = [...source.groups, ...docs.groups].flatMap((g) => g.files.map((f) => f.artifactId));
    expect(new Set(ids).size).toBe(p1.length);
  });

  test("viewMode 只作用于上栏；下栏恒按 GJB 文档名，不受影响", () => {
    const byPath = buildSplitFileTree(p1, "path", true);
    const byStage = buildSplitFileTree(p1, "stage", true);
    expect(byStage.source.groups.map((g) => g.key)).not.toEqual(byPath.source.groups.map((g) => g.key));
    expect(byStage.docs.groups.map((g) => g.label)).toEqual(byPath.docs.groups.map((g) => g.label));
  });

  test("generic 文档上下文按中性产物组展示", () => {
    const { docs } = buildSplitFileTree(p1, "path", true, "generic");
    expect(docs.groups.map((group) => group.label)).toEqual(["需求", "行为", "架构", "其他"]);
    expect(docs.groups.flatMap((group) => group.files.map((file) => file.name)).join(" ")).not.toContain("PLDS");
  });

  test("hasAgent=false 也不再一律降级：路径已能从标题反解，有路径就照常分组", () => {
    const { source } = buildSplitFileTree(p1, "path", false);
    expect(source.degraded).toBe(false);
    expect(source.groups.map((g) => g.key)).toContain("rtl");
  });

  test("一个路径都反解不出来时上栏才降级，并给出提示文案", () => {
    const pathless = p1.filter((e) => e.path === null);
    const { source } = buildSplitFileTree(pathless, "path", false);
    expect(source.degraded).toBe(true);
    expect(source.degradedMessage).toBeTruthy();
  });

  test("项目一个源文件都没有时上栏给提示而不是空白", () => {
    const docsOnly = p1.filter((e) => !isSourceEntry(e));
    const { source } = buildSplitFileTree(docsOnly, "path", true);
    expect(source.groups).toEqual([]);
    expect(source.degradedMessage).toBeTruthy();
  });
});

describe("路径视图组内排序：按完整路径而非文件名", () => {
  test("同名文件分处不同目录时按目录序排，不因 basename 相同而乱序", () => {
    const entries: FileTreeEntry[] = [
      entry({ artifactId: "a1", artifactType: "RTL_SOURCE_SET", path: "rtl/sub/b.v" }),
      entry({ artifactId: "a2", artifactType: "RTL_SOURCE_SET", path: "rtl/a.v" }),
    ];
    const result = buildPathTree(entries, true);
    expect(result.groups[0]!.files.map((f) => f.path)).toEqual(["rtl/a.v", "rtl/sub/b.v"]);
  });
});
