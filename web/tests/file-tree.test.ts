import { describe, expect, test } from "bun:test";
import type { Artifact, ArtifactRevision, TaskDocRef } from "../src/api/types.ts";
import {
  buildFileTree,
  buildFileTreeEntries,
  buildPathTree,
  buildStageTree,
  buildTypeTree,
  FILE_TREE_UNLINKED_GROUP_KEY,
  pathGroupKey,
  stageFocusGroupKey,
  type FileTreeEntry,
} from "../src/domain/file-tree.ts";

// ─────────────────────────────────────────────────────────────────────────
// 测试夹具
// ─────────────────────────────────────────────────────────────────────────

function revision(id: string, version: number, state: string): ArtifactRevision {
  return {
    id,
    version,
    state,
    content_hash: `sha-${id}`,
    content_location: `blob://${id}`,
    created_at: `2026-08-1${version}T00:00:00Z`,
  };
}

function artifact(id: string, artifactType: string, createdAt = "2026-08-10T00:00:00Z"): Artifact {
  return { id, artifact_type: artifactType, created_at: createdAt };
}

function doc(artifactId: string, path: string, phase: string, revisionId = `${artifactId}-r`): TaskDocRef {
  return { artifact_id: artifactId, path, phase, revision_id: revisionId };
}

/** 快捷构造一个已完成关联的 FileTreeEntry（跳过 buildFileTreeEntries，直接测分组逻辑用）。 */
function entry(partial: {
  artifactId: string;
  artifactType: string;
  path?: string | null;
  phase?: string | null;
  state?: string;
  revisions?: readonly ArtifactRevision[];
}): FileTreeEntry {
  const revisions = partial.revisions ?? [revision(`${partial.artifactId}-v1`, 1, partial.state ?? "approved")];
  return {
    artifactId: partial.artifactId,
    artifactType: partial.artifactType,
    createdAt: "2026-08-10T00:00:00Z",
    latestRevision: revisions[revisions.length - 1]!,
    revisions,
    path: partial.path ?? null,
    phase: partial.phase ?? null,
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
    expect(result!.latestRevision.id).toBe("a1-v2"); // 最大 version
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

  test("没有 revision 的 artifact 被防御性跳过（不产出半成品条目）", () => {
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

  test("未被当前 run 关联（path=null）的条目归入「未关联当前任务」兜底分组，排在最后", () => {
    const withUnlinked = [...entries, entry({ artifactId: "a7", artifactType: "SYNTH_RESULT", path: null })];
    const result = buildPathTree(withUnlinked, true);
    const last = result.groups.at(-1)!;
    expect(last.key).toBe(FILE_TREE_UNLINKED_GROUP_KEY);
    expect(last.label).toBe("未关联当前任务");
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
