/**
 * Synthia Core — 工作区路径契约 + git 层测试
 *
 * 不需要数据库：本层只碰文件系统和 git，DB 侧的登记在 api 测试里覆盖。
 * 每个用例用 `SYNTHIA_WORKSPACES_DIR` 指向临时目录，互不干扰。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceError,
  artifactIdForPath,
  formatGitLocation,
  isRegisterablePath,
  parseGitLocation,
  projectWorkspaceDir,
  validateProjectId,
  validateWorkspacePath,
  workspacesRoot,
} from "../src/workspace/paths.ts";
import {
  failNextWorkspacePublishAfterHeadUpdateForTest,
  failNextWorkspacePublishBeforeHeadUpdateForTest,
  failNextWorkspacePublishCheckoutForTest,
  git,
  gitRaw,
  headSha,
  listTree,
  statusMap,
} from "../src/workspace/git.ts";
import {
  commitPending,
  ensureWorkspace,
  listWorkspace,
  pendingChanges,
  readAtLocation,
  readRegularFileAtLocation,
  readWorkingFile,
  writeAndCommit,
  writeWorkingFile,
} from "../src/workspace/store.ts";
import { sha256Hex } from "../src/hashing.ts";

const AUTHOR = { name: "测试", email: "test@synthia.local" } as const;
let root: string;
let savedRoot: string | undefined;

beforeEach(async () => {
  savedRoot = process.env.SYNTHIA_WORKSPACES_DIR;
  root = await mkdtemp(join(tmpdir(), "synthia-ws-"));
  process.env.SYNTHIA_WORKSPACES_DIR = root;
});

afterEach(async () => {
  if (savedRoot === undefined) delete process.env.SYNTHIA_WORKSPACES_DIR;
  else process.env.SYNTHIA_WORKSPACES_DIR = savedRoot;
  await rm(root, { recursive: true, force: true });
});

function reason(fn: () => unknown): string {
  try {
    fn();
    return "(没有抛错)";
  } catch (err) {
    return err instanceof WorkspaceError ? `${err.code}: ${err.message}` : String(err);
  }
}

describe("路径契约（SYNTHIA-FPGA-RULE-25）", () => {
  test("五个合法目录都放行，`./` 前缀被规范化掉", () => {
    expect(validateWorkspacePath("rtl/pwm.v")).toBe("rtl/pwm.v");
    expect(validateWorkspacePath("tb/tb_top.v")).toBe("tb/tb_top.v");
    expect(validateWorkspacePath("sim/run.log")).toBe("sim/run.log");
    expect(validateWorkspacePath("doc/compile/check_report.md")).toBe("doc/compile/check_report.md");
    expect(validateWorkspacePath("prj/constr/top.xdc")).toBe("prj/constr/top.xdc");
    expect(validateWorkspacePath("./rtl/pwm.v")).toBe("rtl/pwm.v");
  });

  test("§3：doc/ 下不许放 RTL/TB 源码，但 notes.md 可以", () => {
    expect(reason(() => validateWorkspacePath("doc/rtl/pwm.v"))).toContain("WORKSPACE_PATH_INVALID");
    expect(reason(() => validateWorkspacePath("doc/sim/tb_top.sv"))).toContain("RULE-25 §3");
    expect(validateWorkspacePath("doc/rtl/notes.md")).toBe("doc/rtl/notes.md");
  });

  test("§2：绝对路径与平台前缀一律拒绝", () => {
    for (const bad of ["/d/work/pwm.v", "/cygdrive/c/pwm.v", "C:\\work\\pwm.v", "D:/work/pwm.v", "/rtl/pwm.v"]) {
      expect(reason(() => validateWorkspacePath(bad))).toContain("WORKSPACE_PATH_INVALID");
    }
  });

  test("路径穿越出不去", () => {
    for (const bad of ["../etc/passwd", "rtl/../../etc/passwd", "rtl//pwm.v", "rtl/./pwm.v", "rtl/"]) {
      expect(reason(() => validateWorkspacePath(bad))).toContain("WORKSPACE_PATH_INVALID");
    }
  });

  test("顶层目录不在白名单内、或文件直接躺在根目录，都拒绝", () => {
    expect(reason(() => validateWorkspacePath("src/pwm.v"))).toContain("RULE-25 §1");
    expect(reason(() => validateWorkspacePath("pwm.v"))).toContain("不得直接放在工作区根目录");
    expect(reason(() => validateWorkspacePath("prj/top.xdc"))).toContain("prj/constr/");
  });

  test("projectId 不能带路径成分", () => {
    expect(validateProjectId("p1")).toBe("p1");
    for (const bad of ["../p1", "a/b", "", ".."]) {
      expect(reason(() => validateProjectId(bad))).toContain("WORKSPACE_PATH_INVALID");
    }
  });

  test("SYNTHIA_WORKSPACES_DIR 覆盖默认位置", () => {
    expect(workspacesRoot()).toBe(root);
    expect(projectWorkspaceDir("p1")).toBe(join(root, "p1"));
  });

  test("sim/ 下的东西是证据不是产物，不可登记", () => {
    expect(isRegisterablePath("sim/run.log")).toBe(false);
    expect(isRegisterablePath("rtl/pwm.v")).toBe(true);
  });

  test("content_location 编解码，非 git scheme 与坏 sha 都返回 null", () => {
    const sha = "a".repeat(40);
    expect(formatGitLocation(sha, "rtl/pwm.v")).toBe(`git://${sha}/rtl/pwm.v`);
    expect(parseGitLocation(`git://${sha}/rtl/pwm.v`)).toEqual({ commit: sha, path: "rtl/pwm.v" });
    expect(parseGitLocation("db://artifact_revision/rev_1")).toBeNull();
    expect(parseGitLocation("git://notasha/rtl/pwm.v")).toBeNull();
    expect(parseGitLocation(`git://${sha}/`)).toBeNull();
  });

  test("同一条路径永远推导出同一个 artifact id（文件的身份就是路径）", () => {
    expect(artifactIdForPath("p1", "rtl/pwm.v")).toBe(artifactIdForPath("p1", "rtl/pwm.v"));
    expect(artifactIdForPath("p1", "rtl/pwm.v")).not.toBe(artifactIdForPath("p1", "tb/pwm.v"));
    expect(artifactIdForPath("p1", "rtl/pwm.v")).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("建区与读写", () => {
  test("建区产出 RULE-25 的五个目录、git 仓库与首个 commit", async () => {
    const dir = await ensureWorkspace("p1");
    expect(dir).toBe(join(root, "p1"));
    for (const sub of ["rtl", "tb", "sim", "doc", "prj/constr"]) {
      expect(await readFile(join(dir, sub, ".gitkeep"), "utf8")).toBe("");
    }
    expect(await headSha(dir)).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain("sim/");
  });

  test("重复建区是幂等的，不会重置已有内容", async () => {
    const dir = await ensureWorkspace("p1");
    await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "module pwm; endmodule\n" }], "首版", AUTHOR);
    const before = await headSha(dir);
    await ensureWorkspace("p1");
    expect(await headSha(dir)).toBe(before);
    expect(await readWorkingFile("p1", "rtl/pwm.v")).toContain("module pwm");
  });

  test("写入即提交，content_location 能把正文原样取回来", async () => {
    const content = "module pwm(input clk); endmodule\n";
    const out = await writeAndCommit("p1", [{ path: "rtl/pwm.v", content }], "agent 首版", AUTHOR);
    expect(out.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(out.changed).toEqual(["rtl/pwm.v"]);

    const location = formatGitLocation(out.commit!, "rtl/pwm.v");
    const readBack = await readAtLocation("p1", location);
    expect(readBack).toBe(content);
    // 可追溯性的全部意义在这一行：取回来的字节 hash 与登记时算的一致。
    expect(sha256Hex(readBack!)).toBe(sha256Hex(content));
  });

  test("历史版本按 sha 各读各的，后一版不会覆盖前一版的可读性", async () => {
    const v1 = await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "v1\n" }], "v1", AUTHOR);
    const v2 = await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "v2\n" }], "v2", AUTHOR);
    expect(await readAtLocation("p1", formatGitLocation(v1.commit!, "rtl/pwm.v"))).toBe("v1\n");
    expect(await readAtLocation("p1", formatGitLocation(v2.commit!, "rtl/pwm.v"))).toBe("v2\n");
  });

  test("正式输入的 Git 读取只接受普通文件，拒绝 symlink 和 gitlink", async () => {
    const regular = await writeAndCommit(
      "p4-regular-input",
      [{ path: "rtl/top.sv", content: "module top; endmodule\n" }],
      "regular",
      AUTHOR,
    );
    const regularBytes = await readRegularFileAtLocation(
      "p4-regular-input",
      formatGitLocation(regular.commit!, "rtl/top.sv"),
    );
    expect(regularBytes).not.toBeNull();
    expect(new TextDecoder().decode(regularBytes!)).toBe("module top; endmodule\n");

    const symlinkRoot = await ensureWorkspace("p4-symlink-input");
    await writeFile(join(symlinkRoot, "rtl", "real.sv"), "module real; endmodule\n", "utf8");
    await symlink("real.sv", join(symlinkRoot, "rtl", "top.sv"));
    await git(symlinkRoot, ["add", "--", "rtl/real.sv", "rtl/top.sv"]);
    await git(symlinkRoot, ["commit", "--no-verify", "--quiet", "-m", "symlink input"]);
    await expect(readRegularFileAtLocation(
      "p4-symlink-input",
      formatGitLocation((await headSha(symlinkRoot))!, "rtl/top.sv"),
    )).rejects.toThrow(/符号链接|submodule/);

    const gitlinkRoot = await ensureWorkspace("p4-gitlink-input");
    const targetCommit = (await headSha(gitlinkRoot))!;
    await git(gitlinkRoot, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${targetCommit},rtl/vendor`,
    ]);
    await git(gitlinkRoot, ["commit", "--no-verify", "--quiet", "-m", "gitlink input"]);
    await expect(readRegularFileAtLocation(
      "p4-gitlink-input",
      formatGitLocation((await headSha(gitlinkRoot))!, "rtl/vendor"),
    )).rejects.toThrow(/符号链接|submodule/);
  });

  test("非 git scheme 或取不到的对象返回 null（调用方据此回落归档副本）", async () => {
    await ensureWorkspace("p1");
    expect(await readAtLocation("p1", "db://artifact_revision/rev_1")).toBeNull();
    expect(await readAtLocation("p1", formatGitLocation("b".repeat(40), "rtl/pwm.v"))).toBeNull();
  });

  test("内容一字未变时不造空 commit，但仍给出 HEAD", async () => {
    const first = await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "same\n" }], "v1", AUTHOR);
    const again = await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "same\n" }], "v1 重放", AUTHOR);
    expect(again.changed).toEqual([]);
    expect(again.commit).toBe(first.commit!);
  });

  test("路径非法时写入直接被拒，不留半个文件", async () => {
    await ensureWorkspace("p1");
    await expect(
      writeAndCommit("p1", [{ path: "doc/rtl/pwm.v", content: "x" }], "非法", AUTHOR),
    ).rejects.toThrow(/RULE-25/);
  });

  test("读不存在的文件报 WORKSPACE_FILE_NOT_FOUND", async () => {
    await ensureWorkspace("p1");
    await expect(readWorkingFile("p1", "rtl/nope.v")).rejects.toThrow(/WORKSPACE_FILE_NOT_FOUND|没有这个文件/);
  });
});

describe("人手改动与一键登记", () => {
  test("编辑器写回只落盘不提交，状态变 dirty", async () => {
    await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "v1\n" }], "v1", AUTHOR);
    expect((await listWorkspace("p1")).find((e) => e.path === "rtl/pwm.v")?.status).toBe("registered");

    expect(await writeWorkingFile("p1", "rtl/pwm.v", "v1 人改过\n")).toBe(true);
    const entry = (await listWorkspace("p1")).find((e) => e.path === "rtl/pwm.v");
    expect(entry?.status).toBe("dirty");
    expect((await pendingChanges("p1")).map((e) => e.path)).toEqual(["rtl/pwm.v"]);
  });

  test("直接在磁盘上新建的文件算 untracked，也进待登记清单", async () => {
    const dir = await ensureWorkspace("p1");
    await writeFile(join(dir, "tb", "tb_top.v"), "module tb_top; endmodule\n", "utf8");
    const pending = await pendingChanges("p1");
    expect(pending.map((e) => e.path)).toEqual(["tb/tb_top.v"]);
    expect(pending[0]!.status).toBe("untracked");
    expect(pending[0]!.bytes).toBeGreaterThan(0);
  });

  test("一键登记把多个改动收进一个 commit", async () => {
    await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "v1\n" }], "v1", AUTHOR);
    const dir = projectWorkspaceDir("p1");
    await writeWorkingFile("p1", "rtl/pwm.v", "人改的\n");
    await writeFile(join(dir, "tb", "tb_top.v"), "新加的\n", "utf8");

    const before = await headSha(dir);
    const out = await commitPending("p1", "人工登记：调占空比", AUTHOR);
    expect(out.changed).toEqual(["rtl/pwm.v", "tb/tb_top.v"]);
    expect(out.commit).not.toBe(before);

    // 一次 commit：两条路径共享同一个 sha，天然可回溯成「这一次登记」。
    expect(await readAtLocation("p1", formatGitLocation(out.commit!, "rtl/pwm.v"))).toBe("人改的\n");
    expect(await readAtLocation("p1", formatGitLocation(out.commit!, "tb/tb_top.v"))).toBe("新加的\n");
    expect(await pendingChanges("p1")).toEqual([]);
  });

  test("没有改动时登记是静默 no-op，不造空 commit", async () => {
    const dir = await ensureWorkspace("p1");
    const before = await headSha(dir);
    const out = await commitPending("p1", "空登记", AUTHOR);
    expect(out.changed).toEqual([]);
    expect(out.commit).toBe(before);
  });

  test("sim/ 下的产物是证据不是产物：状态 ignored，不进待登记清单，也不会被登记", async () => {
    const dir = await ensureWorkspace("p1");
    await writeFile(join(dir, "sim", "run.log"), "simulation finished\n", "utf8");
    const entry = (await listWorkspace("p1")).find((e) => e.path === "sim/run.log");
    expect(entry?.status).toBe("ignored");
    expect(await pendingChanges("p1")).toEqual([]);

    const out = await commitPending("p1", "试图登记 sim", AUTHOR);
    expect(out.changed).toEqual([]);
  });

  test("agent 不得覆盖带未登记人工改动的文件，错误里点名该文件", async () => {
    await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "v1\n" }], "v1", AUTHOR);
    await writeWorkingFile("p1", "rtl/pwm.v", "人正在改\n");

    await expect(
      writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "agent 的新版\n" }], "v2", AUTHOR),
    ).rejects.toThrow(/rtl\/pwm\.v/);
    // 拒绝要彻底：人的改动一个字都不能少。
    expect(await readWorkingFile("p1", "rtl/pwm.v")).toBe("人正在改\n");
  });

  test("批量写入里只要有一个脏文件，整批都不落盘（不留半套状态）", async () => {
    await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "v1\n" }], "v1", AUTHOR);
    await writeWorkingFile("p1", "rtl/pwm.v", "人正在改\n");

    await expect(
      writeAndCommit(
        "p1",
        [
          { path: "tb/tb_top.v", content: "本来该写进去的\n" },
          { path: "rtl/pwm.v", content: "会冲突的\n" },
        ],
        "批量",
        AUTHOR,
      ),
    ).rejects.toThrow(/rtl\/pwm\.v/);
    await expect(readWorkingFile("p1", "tb/tb_top.v")).rejects.toThrow();
  });

  test("多文件 commit 发布前故障不会让主 HEAD、索引或工作树留下半批状态", async () => {
    const initial = await writeAndCommit("p1", [
      { path: "rtl/a.v", content: "a-v1\n" },
      { path: "rtl/b.v", content: "b-v1\n" },
    ], "initial", AUTHOR);
    const dir = projectWorkspaceDir("p1");
    const beforeHead = await headSha(dir);
    const beforeStatus = await statusMap(dir);

    failNextWorkspacePublishBeforeHeadUpdateForTest(dir);
    await expect(writeAndCommit("p1", [
      { path: "rtl/a.v", content: "a-v2\n" },
      { path: "rtl/b.v", content: "b-v2\n" },
    ], "must fail before publish", AUTHOR)).rejects.toThrow("injected workspace publish failure");

    expect(await headSha(dir)).toBe(beforeHead);
    expect(await readWorkingFile("p1", "rtl/a.v")).toBe("a-v1\n");
    expect(await readWorkingFile("p1", "rtl/b.v")).toBe("b-v1\n");
    expect(await statusMap(dir)).toEqual(beforeStatus);
    expect(await readAtLocation("p1", formatGitLocation(initial.commit!, "rtl/a.v"))).toBe("a-v1\n");

    // one-shot failpoint 不会毒化项目锁；同一批重试可以一次性发布。
    const retry = await writeAndCommit("p1", [
      { path: "rtl/a.v", content: "a-v2\n" },
      { path: "rtl/b.v", content: "b-v2\n" },
    ], "retry", AUTHOR);
    expect(retry.changed).toEqual(["rtl/a.v", "rtl/b.v"]);
    expect(await readWorkingFile("p1", "rtl/a.v")).toBe("a-v2\n");
    expect(await readWorkingFile("p1", "rtl/b.v")).toBe("b-v2\n");
    expect(await statusMap(dir)).toEqual(new Map());
  });

  test("HEAD 已发布时硬中断可由 ensureWorkspace 前向恢复整批工作树", async () => {
    await writeAndCommit("p1", [
      { path: "rtl/a.v", content: "a-v1\n" },
      { path: "rtl/b.v", content: "b-v1\n" },
    ], "initial", AUTHOR);
    const dir = projectWorkspaceDir("p1");
    const beforeHead = await headSha(dir);

    failNextWorkspacePublishAfterHeadUpdateForTest(dir);
    await expect(writeAndCommit("p1", [
      { path: "rtl/a.v", content: "a-v2\n" },
      { path: "rtl/b.v", content: "b-v2\n" },
    ], "publish then interrupt", AUTHOR)).rejects.toThrow("after HEAD update");

    // 模拟的硬中断发生在 HEAD CAS 后、checkout 前：commit 已可追溯，
    // marker 使下次建区能幂等地把工作树补齐，不会停在半批。
    expect(await headSha(dir)).not.toBe(beforeHead);
    expect(await readWorkingFile("p1", "rtl/a.v")).toBe("a-v1\n");
    expect(await readWorkingFile("p1", "rtl/b.v")).toBe("b-v1\n");

    await ensureWorkspace("p1");
    expect(await readWorkingFile("p1", "rtl/a.v")).toBe("a-v2\n");
    expect(await readWorkingFile("p1", "rtl/b.v")).toBe("b-v2\n");
    expect(await statusMap(dir)).toEqual(new Map());
    expect((await gitRaw(dir, ["rev-parse", "--verify", "--quiet", "refs/synthia/workspace-publish"])).exitCode)
      .not.toBe(0);
    await ensureWorkspace("p1"); // recovery marker 已清理，再次 ensure 仍幂等。
  });

  test("HEAD CAS 后的普通 checkout 故障在同一调用内恢复，不误报写入失败", async () => {
    await writeAndCommit("p1", [
      { path: "rtl/a.v", content: "a-v1\n" },
      { path: "rtl/b.v", content: "b-v1\n" },
    ], "initial", AUTHOR);
    const dir = projectWorkspaceDir("p1");

    failNextWorkspacePublishCheckoutForTest(dir);
    const out = await writeAndCommit("p1", [
      { path: "rtl/a.v", content: "a-v2\n" },
      { path: "rtl/b.v", content: "b-v2\n" },
    ], "recover checkout", AUTHOR);

    expect(out.commit).toBe(await headSha(dir));
    expect(await readWorkingFile("p1", "rtl/a.v")).toBe("a-v2\n");
    expect(await readWorkingFile("p1", "rtl/b.v")).toBe("b-v2\n");
    expect(await statusMap(dir)).toEqual(new Map());
    expect((await gitRaw(dir, ["rev-parse", "--verify", "--quiet", "refs/synthia/workspace-publish"])).exitCode)
      .not.toBe(0);
  });

  test("宕机后选中路径出现新的人工 staged 改动时，恢复拒绝覆盖并保留 marker", async () => {
    await writeAndCommit("p1", [
      { path: "rtl/a.v", content: "a-v1\n" },
      { path: "rtl/b.v", content: "b-v1\n" },
    ], "initial", AUTHOR);
    const dir = projectWorkspaceDir("p1");

    failNextWorkspacePublishAfterHeadUpdateForTest(dir);
    await expect(writeAndCommit("p1", [
      { path: "rtl/a.v", content: "a-v2\n" },
      { path: "rtl/b.v", content: "b-v2\n" },
    ], "publish then interrupt", AUTHOR)).rejects.toThrow("after HEAD update");
    const publishedHead = (await headSha(dir))!;

    await writeWorkingFile("p1", "rtl/a.v", "宕机后人工改的第三个版本\n");
    await git(dir, ["add", "--", "rtl/a.v"]);
    const stagedBeforeRecovery = await git(dir, ["show", ":rtl/a.v"]);

    await expect(ensureWorkspace("p1")).rejects.toThrow("新的暂存改动");
    expect(await headSha(dir)).toBe(publishedHead);
    expect(await readWorkingFile("p1", "rtl/a.v")).toBe("宕机后人工改的第三个版本\n");
    expect(await git(dir, ["show", ":rtl/a.v"])).toBe(stagedBeforeRecovery);
    // 恢复在验证整批后才 checkout，因此其他选中路径也不会被先写入。
    expect(await readWorkingFile("p1", "rtl/b.v")).toBe("b-v1\n");
    expect(await git(dir, ["rev-parse", "--verify", "refs/synthia/workspace-publish"])).toBe(`${publishedHead}\n`);

    // 即使人工把 index 放回 parent 版，worktree 中的第三个版本也必须独立拦住恢复。
    await git(dir, ["reset", "--quiet", `${publishedHead}^`, "--", "rtl/a.v"]);
    await expect(ensureWorkspace("p1")).rejects.toThrow("新的人工改动");
    expect(await readWorkingFile("p1", "rtl/a.v")).toBe("宕机后人工改的第三个版本\n");
    expect(await git(dir, ["rev-parse", "--verify", "refs/synthia/workspace-publish"])).toBe(`${publishedHead}\n`);
  });

  test("agent commit 不吸收未点名的 staged/dirty 人工改动", async () => {
    const dir = await ensureWorkspace("p1");
    await writeWorkingFile("p1", "doc/manual.md", "人工暂存的内容\n");
    await git(dir, ["add", "--", "doc/manual.md"]);
    await writeWorkingFile("p1", "doc/draft.md", "人工未暂存的草稿\n");

    const out = await writeAndCommit(
      "p1",
      [{ path: "rtl/agent.v", content: "module agent; endmodule\n" }],
      "agent candidate",
      AUTHOR,
    );

    expect(await listTree(dir, out.commit!)).toContain("rtl/agent.v");
    expect(await listTree(dir, out.commit!)).not.toContain("doc/manual.md");
    expect(await listTree(dir, out.commit!)).not.toContain("doc/draft.md");
    expect(await readWorkingFile("p1", "doc/manual.md")).toBe("人工暂存的内容\n");
    expect(await readWorkingFile("p1", "doc/draft.md")).toBe("人工未暂存的草稿\n");
    const status = await statusMap(dir);
    expect(status.get("doc/manual.md")).toBe("modified");
    expect(status.get("doc/draft.md")).toBe("untracked");
    expect(await git(dir, ["diff", "--cached", "--name-only"])).toContain("doc/manual.md");
  });

  test("要写的内容与人改出来的一字不差：不算冲突，且照样收进 commit", async () => {
    await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "v1\n" }], "v1", AUTHOR);
    await writeWorkingFile("p1", "rtl/pwm.v", "一样的\n");
    const out = await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "一样的\n" }], "重放", AUTHOR);
    // 盘上已经是这份字节，所以不该拦；但 git 里还不是（HEAD 仍停在 v1），
    // 不收进 commit 这份内容就永远进不了树，也就永远登记不上。
    expect(out.changed).toEqual(["rtl/pwm.v"]);
    expect(await readAtLocation("p1", formatGitLocation(out.commit!, "rtl/pwm.v"))).toBe("一样的\n");
    expect(await pendingChanges("p1")).toEqual([]);
    // 真正的幂等重放是「git 里已经是这份字节」，那才不造 commit（见「内容一字未变时不造空 commit」）。
    const again = await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "一样的\n" }], "再重放", AUTHOR);
    expect(again.changed).toEqual([]);
    expect(again.commit).toBe(out.commit!);
  });

  test("受保护写入在同一项目锁内复核预览哈希，且不吸收同内容脏改动", async () => {
    await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "v1\n" }], "v1", AUTHOR);
    await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "已经变了\n" }], "concurrent", AUTHOR);

    await expect(writeAndCommit(
      "p1",
      [{ path: "rtl/pwm.v", content: "探索结果\n" }],
      "guarded",
      AUTHOR,
      {
        guards: [{
          path: "rtl/pwm.v",
          expectedContentHash: sha256Hex("v1\n"),
          rejectPending: true,
        }],
      },
    )).rejects.toThrow("预览后发生变化");
    expect(await readWorkingFile("p1", "rtl/pwm.v")).toBe("已经变了\n");

    await writeWorkingFile("p1", "rtl/pwm.v", "探索结果\n");
    await expect(writeAndCommit(
      "p1",
      [{ path: "rtl/pwm.v", content: "探索结果\n" }],
      "guarded-dirty",
      AUTHOR,
      {
        guards: [{
          path: "rtl/pwm.v",
          expectedContentHash: sha256Hex("探索结果\n"),
          rejectPending: true,
        }],
      },
    )).rejects.toThrow("未登记改动");
    expect(await readWorkingFile("p1", "rtl/pwm.v")).toBe("探索结果\n");
  });

  test("登记后人再改一次，还能继续登记（版本链不断）", async () => {
    await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "v1\n" }], "v1", AUTHOR);
    await writeWorkingFile("p1", "rtl/pwm.v", "v2\n");
    const second = await commitPending("p1", "v2", AUTHOR);
    await writeWorkingFile("p1", "rtl/pwm.v", "v3\n");
    const third = await commitPending("p1", "v3", AUTHOR);

    expect(await readAtLocation("p1", formatGitLocation(second.commit!, "rtl/pwm.v"))).toBe("v2\n");
    expect(await readAtLocation("p1", formatGitLocation(third.commit!, "rtl/pwm.v"))).toBe("v3\n");
  });
});

describe("并发与隔离", () => {
  test("同一项目并发写不互相吃掉暂存区，每个文件都进得去", async () => {
    await ensureWorkspace("p1");
    const writes = ["a", "b", "c", "d", "e"].map((name, i) =>
      writeAndCommit("p1", [{ path: `rtl/${name}.v`, content: `module ${name}; endmodule\n` }], `写 ${i}`, AUTHOR),
    );
    const results = await Promise.all(writes);
    expect(results.every((r) => r.commit !== null)).toBe(true);

    const dir = projectWorkspaceDir("p1");
    const tracked = await listTree(dir, "HEAD");
    for (const name of ["a", "b", "c", "d", "e"]) expect(tracked).toContain(`rtl/${name}.v`);
    expect(await statusMap(dir)).toEqual(new Map()); // 全部干净落地，没有遗留在暂存区里的东西
  });

  test("不同项目各有各的工作区，互不可见", async () => {
    await writeAndCommit("p1", [{ path: "rtl/pwm.v", content: "p1 的\n" }], "v1", AUTHOR);
    await writeAndCommit("p2", [{ path: "rtl/pwm.v", content: "p2 的\n" }], "v1", AUTHOR);
    expect(await readWorkingFile("p1", "rtl/pwm.v")).toBe("p1 的\n");
    expect(await readWorkingFile("p2", "rtl/pwm.v")).toBe("p2 的\n");
  });

  test("机器上的 core.autocrlf 不会改写字节（否则 content_hash 会对不上）", async () => {
    const crlf = "line1\r\nline2\r\n";
    const out = await writeAndCommit("p1", [{ path: "rtl/crlf.v", content: crlf }], "crlf", AUTHOR);
    expect(await readAtLocation("p1", formatGitLocation(out.commit!, "rtl/crlf.v"))).toBe(crlf);
  });

  test("带空格与中文的文件名在 status 解析里不会错位", async () => {
    const dir = await ensureWorkspace("p1");
    await mkdir(join(dir, "doc", "交接"), { recursive: true });
    await writeFile(join(dir, "doc", "交接", "说明 v1.md"), "# 交接\n", "utf8");
    await writeFile(join(dir, "doc", "notes.md"), "# notes\n", "utf8");
    const pending = await pendingChanges("p1");
    expect(pending.map((e) => e.path).sort()).toEqual(["doc/notes.md", "doc/交接/说明 v1.md"]);

    const out = await commitPending("p1", "登记", AUTHOR);
    expect(out.changed).toContain("doc/交接/说明 v1.md");
    expect(await readAtLocation("p1", formatGitLocation(out.commit!, "doc/交接/说明 v1.md"))).toBe("# 交接\n");
  });
});
