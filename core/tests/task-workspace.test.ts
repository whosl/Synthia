import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, headSha } from "../src/workspace/git.ts";
import { projectWorkspaceDir } from "../src/workspace/paths.ts";
import {
  createIsolatedTaskWorkspace,
  readTaskWorkspaceFile,
  snapshotTaskWorkspace,
  taskWorkspaceDir,
  writeTaskWorkspaceFiles,
} from "../src/workspace/task-store.ts";
import { ensureWorkspace, writeAndCommit } from "../src/workspace/store.ts";

describe("P3 isolated task workspace", () => {
  let root: string;
  let previousRoot: string | undefined;
  const author = { name: "P3 Test", email: "p3@test.local" };

  beforeEach(async () => {
    previousRoot = process.env.SYNTHIA_WORKSPACES_DIR;
    root = await mkdtemp(join(tmpdir(), "synthia-task-workspace-"));
    process.env.SYNTHIA_WORKSPACES_DIR = root;
  });

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env.SYNTHIA_WORKSPACES_DIR;
    else process.env.SYNTHIA_WORKSPACES_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  });

  async function seed(projectId: string): Promise<string> {
    await ensureWorkspace(projectId);
    const outcome = await writeAndCommit(
      projectId,
      [{ path: "rtl/a.v", content: "module a; endmodule\n" }],
      "seed",
      author,
    );
    if (!outcome.commit) throw new Error("missing seed commit");
    return outcome.commit;
  }

  test("writes and snapshots only the clone; same-content writes are a safe no-op", async () => {
    const projectId = "p3-isolation";
    const baseCommit = await seed(projectId);
    const created = await createIsolatedTaskWorkspace(projectId, "ws-one", baseCommit);
    expect(created.baseCommit).toBe(baseCommit);

    const unchanged = await writeTaskWorkspaceFiles(
      projectId,
      "ws-one",
      [{ path: "rtl/a.v", content: "module a; endmodule\n" }],
      "same bytes",
      author,
    );
    expect(unchanged.changed).toEqual([]);
    expect(unchanged.commit).toBe(baseCommit);

    const changed = await writeTaskWorkspaceFiles(
      projectId,
      "ws-one",
      [
        { path: "rtl/a.v", content: "module a; wire changed; endmodule\n" },
        { path: "tb/a_tb.sv", content: "module a_tb; endmodule\n" },
      ],
      "explore",
      author,
    );
    expect(changed.changed).toEqual(["rtl/a.v", "tb/a_tb.sv"]);
    expect(await headSha(projectWorkspaceDir(projectId))).toBe(baseCommit);
    expect((await readTaskWorkspaceFile(projectId, "ws-one", "rtl/a.v")).content).toContain("changed");

    const snapshot = await snapshotTaskWorkspace(projectId, "ws-one", baseCommit, {
      taskId: "task-one",
      workspaceId: "ws-one",
      summary: "done",
      tests: [{ name: "lint", status: "passed" }],
    });
    expect(snapshot.changes.map((file) => [file.path, file.change_kind])).toEqual([
      ["rtl/a.v", "modified"],
      ["tb/a_tb.sv", "added"],
    ]);
    expect(snapshot.output_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects stale base, deletions, symlinks and submodules", async () => {
    const staleProject = "p3-stale";
    const staleBase = await seed(staleProject);
    await writeAndCommit(
      staleProject,
      [{ path: "rtl/b.v", content: "module b; endmodule\n" }],
      "advance",
      author,
    );
    await expect(createIsolatedTaskWorkspace(staleProject, "ws-stale", staleBase))
      .rejects.toThrow("base_commit");

    const deleteProject = "p3-delete";
    const deleteBase = await seed(deleteProject);
    await createIsolatedTaskWorkspace(deleteProject, "ws-delete", deleteBase);
    const deleteDir = taskWorkspaceDir(deleteProject, "ws-delete");
    await git(deleteDir, ["rm", "--quiet", "--", "rtl/a.v"]);
    await git(deleteDir, ["commit", "--no-verify", "--quiet", "-m", "delete"]);
    await expect(snapshotTaskWorkspace(deleteProject, "ws-delete", deleteBase, {
      taskId: "task-delete",
      workspaceId: "ws-delete",
      summary: "",
      tests: [],
    })).rejects.toThrow("只支持新增或修改");

    const symlinkProject = "p3-symlink";
    await seed(symlinkProject);
    const symlinkRoot = projectWorkspaceDir(symlinkProject);
    await symlink("a.v", join(symlinkRoot, "rtl/link.v"));
    await git(symlinkRoot, ["add", "--", "rtl/link.v"]);
    await git(symlinkRoot, ["commit", "--no-verify", "--quiet", "-m", "symlink"]);
    await expect(createIsolatedTaskWorkspace(
      symlinkProject,
      "ws-symlink",
      (await headSha(symlinkRoot))!,
    )).rejects.toThrow("符号链接");

    const submoduleProject = "p3-submodule";
    const submoduleCommit = await seed(submoduleProject);
    const submoduleRoot = projectWorkspaceDir(submoduleProject);
    await git(submoduleRoot, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${submoduleCommit},rtl/vendor`,
    ]);
    await git(submoduleRoot, ["commit", "--no-verify", "--quiet", "-m", "gitlink"]);
    await expect(createIsolatedTaskWorkspace(
      submoduleProject,
      "ws-submodule",
      (await headSha(submoduleRoot))!,
    )).rejects.toThrow("submodule");
  });

  test("rejects binary and oversized base files before cloning", async () => {
    const binaryProject = "p3-binary";
    await seed(binaryProject);
    const binaryRoot = projectWorkspaceDir(binaryProject);
    await writeFile(join(binaryRoot, "rtl/binary.v"), new Uint8Array([0xff, 0xfe, 0xfd]));
    await git(binaryRoot, ["add", "--", "rtl/binary.v"]);
    await git(binaryRoot, ["commit", "--no-verify", "--quiet", "-m", "binary"]);
    await expect(createIsolatedTaskWorkspace(
      binaryProject,
      "ws-binary",
      (await headSha(binaryRoot))!,
    )).rejects.toThrow("非 UTF-8");

    const largeProject = "p3-large";
    await seed(largeProject);
    const largeRoot = projectWorkspaceDir(largeProject);
    await writeFile(join(largeRoot, "rtl/large.v"), "x".repeat(1024 * 1024 + 1), "utf8");
    await git(largeRoot, ["add", "--", "rtl/large.v"]);
    await git(largeRoot, ["commit", "--no-verify", "--quiet", "-m", "large"]);
    await expect(createIsolatedTaskWorkspace(
      largeProject,
      "ws-large",
      (await headSha(largeRoot))!,
    )).rejects.toThrow("1 MiB");
  });
});
