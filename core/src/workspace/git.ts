/**
 * Synthia Core — git porcelain 薄封装（工作区的版本存储）
 *
 * 只有 Core 写工作区，且同一项目的 git 操作**串行**（`withProjectLock`）——
 * git 的索引（.git/index）不是并发安全的，两个 `add`+`commit` 交错会互相吃掉对方
 * 暂存的文件。不同项目之间互不影响，各有各的锁。
 *
 * 所有命令都显式隔离机器上的 git 配置：`GIT_CONFIG_GLOBAL=/dev/null` +
 * 显式 `-c`。这不是洁癖——操作员的全局 `core.autocrlf=true` 会在 commit 时改写
 * 换行符，让**落库的 content_hash 与 git 里的字节对不上**，而这套设计正是靠
 * 「读出来复核 sha256」来证明可追溯性的。
 */

import { lstat, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkspaceError } from "./paths.ts";

/** 显式身份 + 关掉一切会改写字节或挂起的配置。 */
const GIT_CONFIG_ARGS: readonly string[] = [
  "-c", "user.name=Synthia Core",
  "-c", "user.email=core@synthia.local",
  "-c", "commit.gpgsign=false",
  "-c", "core.autocrlf=false",
  "-c", "core.safecrlf=false",
  "-c", "init.defaultBranch=main",
  "-c", "gc.auto=0",
];

const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

interface GitRunOptions {
  readonly env?: Readonly<Record<string, string>>;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function runGitRaw(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<GitResult> {
  const proc = Bun.spawn({
    cmd: ["git", ...GIT_CONFIG_ARGS, ...args],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_ENV, ...options.env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** 跑一条 git 命令；不抛，由调用方决定非零退出码是否算失败。 */
export function gitRaw(cwd: string, args: readonly string[]): Promise<GitResult> {
  return runGitRaw(cwd, args);
}

/** 跑一条必须成功的 git 命令，非零退出即抛 `WORKSPACE_GIT_FAILED`。 */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  return gitWithOptions(cwd, args);
}

async function gitWithOptions(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<string> {
  const res = await runGitRaw(cwd, args, options);
  if (res.exitCode !== 0) {
    throw new WorkspaceError(
      "WORKSPACE_GIT_FAILED",
      `git ${args[0]} 失败（exit ${res.exitCode}）：${res.stderr.trim() || "(无输出)"}`,
      { args: [...args], cwd },
    );
  }
  return decode(res.stdout);
}

// ─── 每项目串行锁 ────────────────────────────────────────────────────────────

const locks = new Map<string, Promise<void>>();

/**
 * 把 `fn` 排到该项目的操作队列末尾。前一个操作失败不阻塞后一个
 * （`then(settle, settle)`），否则一次写失败会永久卡死这个项目的工作区。
 */
export function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(projectId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(projectId, settled);
  return run;
}

// ─── 用得到的那几个动作 ──────────────────────────────────────────────────────

export async function isRepo(dir: string): Promise<boolean> {
  const res = await gitRaw(dir, ["rev-parse", "--git-dir"]);
  return res.exitCode === 0;
}

export async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "--quiet"]);
}

export async function headSha(dir: string): Promise<string | null> {
  const res = await gitRaw(dir, ["rev-parse", "HEAD"]);
  if (res.exitCode !== 0) return null; // 尚无任何 commit
  return decode(res.stdout).trim();
}

/**
 * 暂存指定路径并提交，返回新 commit 的 sha。
 * 没有任何实际变更时返回 null（不造空 commit）——「一键登记」在没改动时按此静默。
 */
export async function commitPaths(
  dir: string,
  paths: readonly string[],
  message: string,
  author: { readonly name: string; readonly email: string },
): Promise<string | null> {
  if (paths.length === 0) return null;
  await git(dir, ["add", "--", ...paths]);

  const staged = await git(dir, ["diff", "--cached", "--name-only"]);
  if (staged.trim().length === 0) return null;

  await git(dir, [
    "-c", `user.name=${author.name}`,
    "-c", `user.email=${author.email}`,
    "commit", "--no-verify", "--quiet", "-m", message,
  ]);
  const sha = await headSha(dir);
  if (!sha) throw new WorkspaceError("WORKSPACE_GIT_FAILED", "commit 后仍取不到 HEAD");
  return sha;
}

export interface AtomicCommitFile {
  readonly path: string;
  readonly content: string;
}

const WORKSPACE_PUBLISH_REF = "refs/synthia/workspace-publish";
const failBeforePublishForTests = new Set<string>();
const failAfterHeadUpdateForTests = new Set<string>();
const failRecoverableCheckoutForTests = new Set<string>();

/**
 * One-shot fault injection for the atomic workspace writer. The failure fires
 * after the new commit object exists, but before either HEAD or the main index
 * and worktree are changed. Keeping this keyed by the absolute workspace path
 * prevents unrelated tests/projects from observing the hook.
 */
export function failNextWorkspacePublishBeforeHeadUpdateForTest(dir: string): void {
  failBeforePublishForTests.add(dir);
}

/** Simulate a hard exit in the recoverable HEAD-to-worktree transition. */
export function failNextWorkspacePublishAfterHeadUpdateForTest(dir: string): void {
  failAfterHeadUpdateForTests.add(dir);
}

/** Simulate an ordinary post-CAS checkout error that same-process recovery handles. */
export function failNextWorkspacePublishCheckoutForTest(dir: string): void {
  failRecoverableCheckoutForTests.add(dir);
}

function maybeFailBeforeWorkspacePublish(dir: string): void {
  if (!failBeforePublishForTests.delete(dir)) return;
  throw new WorkspaceError(
    "WORKSPACE_GIT_FAILED",
    "injected workspace publish failure before HEAD update",
    { cwd: dir, phase: "before_head_update" },
  );
}

function maybeFailAfterWorkspaceHeadUpdate(dir: string): void {
  if (!failAfterHeadUpdateForTests.delete(dir)) return;
  throw new WorkspaceError(
    "WORKSPACE_GIT_FAILED",
    "injected workspace publish failure after HEAD update",
    { cwd: dir, phase: "after_head_update" },
  );
}

function maybeFailRecoverableWorkspaceCheckout(dir: string): void {
  if (!failRecoverableCheckoutForTests.delete(dir)) return;
  throw new WorkspaceError(
    "WORKSPACE_GIT_FAILED",
    "injected recoverable workspace checkout failure",
    { cwd: dir, phase: "checkout" },
  );
}

/**
 * Finish a commit publication interrupted after its HEAD compare-and-swap.
 *
 * Publication first leaves a ref pointing at the prepared commit, then moves
 * HEAD, then checks out only that commit's paths. A hard process exit can thus
 * leave either (a) the marker with the old HEAD, in which case nothing was
 * published, or (b) HEAD at the marker, in which case replaying the path
 * checkout is idempotent. Unrelated staged/unstaged files are never touched.
 */
export async function recoverWorkspacePublish(dir: string): Promise<void> {
  const markerResult = await gitRaw(dir, ["rev-parse", "--verify", "--quiet", WORKSPACE_PUBLISH_REF]);
  if (markerResult.exitCode !== 0) return;

  const marker = decode(markerResult.stdout).trim();
  const head = await headSha(dir);
  if (head !== marker) {
    await git(dir, ["update-ref", "-d", WORKSPACE_PUBLISH_REF, marker]);
    return;
  }

  const parentResult = await gitRaw(dir, ["rev-parse", "--verify", `${marker}^`]);
  if (parentResult.exitCode !== 0) {
    throw new WorkspaceError(
      "WORKSPACE_GIT_FAILED",
      "workspace publish marker has no recoverable parent commit",
      { cwd: dir, commit: marker },
    );
  }
  const parent = decode(parentResult.stdout).trim();
  const changed = await git(dir, ["diff", "--name-only", "-z", parent, marker, "--"]);
  const paths = changed.split("\0").filter((path) => path.length > 0);
  // Validate the whole batch before touching any path. During the crash gap an
  // editor may have changed or staged a selected file; recovery may only move
  // states that are provably the old parent version or the new marker version.
  // A third state is new human work, so fail closed and deliberately retain the
  // marker for diagnosis/manual resolution.
  for (const path of paths) {
    await assertWorkspacePathRecoverable(dir, parent, marker, path);
  }
  if (paths.length > 0) {
    await git(dir, ["--literal-pathspecs", "checkout", "--quiet", marker, "--", ...paths]);
  }
  await git(dir, ["update-ref", "-d", WORKSPACE_PUBLISH_REF, marker]);
}

interface TreePathState {
  readonly mode: string;
  readonly objectId: string;
  readonly bytes: Uint8Array;
}

interface IndexPathState {
  readonly mode: string;
  readonly objectId: string;
}

interface WorktreePathState {
  readonly mode: string;
  readonly bytes: Uint8Array;
}

async function assertWorkspacePathRecoverable(
  dir: string,
  parent: string,
  marker: string,
  path: string,
): Promise<void> {
  const [parentState, markerState, indexState, worktreeState] = await Promise.all([
    treePathState(dir, parent, path),
    treePathState(dir, marker, path),
    indexPathState(dir, path),
    worktreePathState(dir, path),
  ]);
  if (markerState === null) {
    throw new WorkspaceError(
      "WORKSPACE_GIT_FAILED",
      `workspace publish recovery does not support a deleted path: ${path}`,
      { cwd: dir, path, parent, marker },
    );
  }

  const allowed = [parentState, markerState];
  const indexAllowed = allowed.some((state) => sameIndexAndTreeState(indexState, state));
  if (!indexAllowed) {
    throw new WorkspaceError(
      "WORKSPACE_FILE_DIRTY",
      `文件在工作区恢复期间产生了新的暂存改动，拒绝覆盖：${path}`,
      {
        path,
        layer: "index",
        parent: describeTreePathState(parentState),
        marker: describeTreePathState(markerState),
        actual: indexState,
      },
    );
  }

  const worktreeAllowed = allowed.some((state) => sameWorktreeAndTreeState(worktreeState, state));
  if (!worktreeAllowed) {
    throw new WorkspaceError(
      "WORKSPACE_FILE_DIRTY",
      `文件在工作区恢复期间产生了新的人工改动，拒绝覆盖：${path}`,
      {
        path,
        layer: "worktree",
        parent: describeTreePathState(parentState),
        marker: describeTreePathState(markerState),
        actual: worktreeState === null ? null : { mode: worktreeState.mode, bytes: worktreeState.bytes.byteLength },
      },
    );
  }
}

async function treePathState(dir: string, commit: string, path: string): Promise<TreePathState | null> {
  const out = await git(dir, ["--literal-pathspecs", "ls-tree", "-z", commit, "--", path]);
  if (out.length === 0) return null;
  const records = out.split("\0").filter((record) => record.length > 0);
  if (records.length !== 1) {
    throw new WorkspaceError(
      "WORKSPACE_GIT_FAILED",
      `git tree returned an ambiguous recovery path: ${path}`,
      { cwd: dir, commit, path },
    );
  }
  const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(records[0]!);
  if (!match || match[2] !== "blob" || match[4] !== path) {
    throw new WorkspaceError(
      "WORKSPACE_GIT_FAILED",
      `git tree returned an unsupported recovery entry: ${path}`,
      { cwd: dir, commit, path },
    );
  }
  const objectId = match[3]!;
  const blob = await gitRaw(dir, ["cat-file", "blob", objectId]);
  if (blob.exitCode !== 0) {
    throw new WorkspaceError(
      "WORKSPACE_GIT_FAILED",
      `cannot read recovery blob for path: ${path}`,
      { cwd: dir, commit, path, objectId },
    );
  }
  return { mode: match[1]!, objectId, bytes: blob.stdout };
}

async function indexPathState(dir: string, path: string): Promise<IndexPathState | null> {
  const out = await git(dir, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", path]);
  if (out.length === 0) return null;
  const records = out.split("\0").filter((record) => record.length > 0);
  if (records.length !== 1) {
    throw new WorkspaceError(
      "WORKSPACE_FILE_DIRTY",
      `文件在工作区恢复期间处于未合并索引状态，拒绝覆盖：${path}`,
      { cwd: dir, path, layer: "index" },
    );
  }
  const match = /^([0-7]{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(records[0]!);
  if (!match || match[3] !== "0" || match[4] !== path) {
    throw new WorkspaceError(
      "WORKSPACE_FILE_DIRTY",
      `文件在工作区恢复期间索引状态异常，拒绝覆盖：${path}`,
      { cwd: dir, path, layer: "index" },
    );
  }
  return { mode: match[1]!, objectId: match[2]! };
}

async function worktreePathState(dir: string, path: string): Promise<WorktreePathState | null> {
  const abs = join(dir, path);
  let info;
  try {
    info = await lstat(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkspaceError(
      "WORKSPACE_GIT_FAILED",
      `无法检查待恢复的工作区文件：${path}`,
      { cwd: dir, path },
    );
  }
  try {
    if (info.isFile()) {
      return {
        mode: (info.mode & 0o111) === 0 ? "100644" : "100755",
        bytes: await readFile(abs),
      };
    }
    if (info.isSymbolicLink()) {
      return {
        mode: "120000",
        bytes: new TextEncoder().encode(await readlink(abs)),
      };
    }
  } catch {
    throw new WorkspaceError(
      "WORKSPACE_GIT_FAILED",
      `无法读取待恢复的工作区文件：${path}`,
      { cwd: dir, path },
    );
  }
  return { mode: "unsupported", bytes: new Uint8Array() };
}

function sameIndexAndTreeState(index: IndexPathState | null, tree: TreePathState | null): boolean {
  if (index === null || tree === null) return index === null && tree === null;
  return index.mode === tree.mode && index.objectId === tree.objectId;
}

function sameWorktreeAndTreeState(worktree: WorktreePathState | null, tree: TreePathState | null): boolean {
  if (worktree === null || tree === null) return worktree === null && tree === null;
  return worktree.mode === tree.mode && equalBytes(worktree.bytes, tree.bytes);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function describeTreePathState(state: TreePathState | null): { mode: string; objectId: string } | null {
  return state === null ? null : { mode: state.mode, objectId: state.objectId };
}

/**
 * Build and publish a commit without using the main repository's index or
 * writing its worktree before the commit is ready.
 *
 * A temporary index starts from `baseCommit`; only `files` are replaced with
 * freshly hashed UTF-8 bytes, so an operator's unrelated staged changes cannot
 * leak into the commit. Once the object is complete, HEAD is advanced with an
 * old-value compare-and-swap and only the selected paths are checked out. The
 * publish marker makes the short HEAD/worktree transition forward-recoverable
 * after a hard crash.
 */
export async function commitFilesAtomically(
  dir: string,
  files: readonly AtomicCommitFile[],
  message: string,
  author: { readonly name: string; readonly email: string },
): Promise<string | null> {
  if (files.length === 0) return null;
  await recoverWorkspacePublish(dir);

  const baseCommit = await headSha(dir);
  if (!baseCommit) {
    throw new WorkspaceError("WORKSPACE_GIT_FAILED", "atomic commit requires an existing HEAD", { cwd: dir });
  }

  // Last input wins for a duplicate path, matching sequential file writes but
  // keeping both the temporary tree and the checkout path list unambiguous.
  const byPath = new Map<string, AtomicCommitFile>();
  for (const file of files) byPath.set(file.path, file);
  const uniqueFiles = [...byPath.values()];

  const tempDir = await mkdtemp(join(dirname(dir), ".synthia-workspace-index-"));
  const indexPath = join(tempDir, "index");
  const indexEnv = { GIT_INDEX_FILE: indexPath };
  try {
    await gitWithOptions(dir, ["read-tree", baseCommit], { env: indexEnv });
    for (let i = 0; i < uniqueFiles.length; i += 1) {
      const file = uniqueFiles[i]!;
      const contentPath = join(tempDir, `content-${i}`);
      await writeFile(contentPath, file.content, "utf8");
      const blob = (await git(dir, ["hash-object", "-w", "--no-filters", "--", contentPath])).trim();
      const mode = await regularFileModeAtCommit(dir, baseCommit, file.path);
      await gitWithOptions(
        dir,
        ["update-index", "--add", "--cacheinfo", mode, blob, file.path],
        { env: indexEnv },
      );
    }

    const tree = (await gitWithOptions(dir, ["write-tree"], { env: indexEnv })).trim();
    const baseTree = (await git(dir, ["rev-parse", `${baseCommit}^{tree}`])).trim();
    if (tree === baseTree) return null;

    const commit = (await git(dir, [
      "-c", `user.name=${author.name}`,
      "-c", `user.email=${author.email}`,
      "commit-tree", tree,
      "-p", baseCommit,
      "-m", message,
    ])).trim();

    maybeFailBeforeWorkspacePublish(dir);

    // The marker is written first. If the following CAS never happens,
    // recovery simply removes it; the main HEAD/index/worktree stayed intact.
    await git(dir, ["update-ref", WORKSPACE_PUBLISH_REF, commit]);
    try {
      await git(dir, ["update-ref", "HEAD", commit, baseCommit]);
    } catch (error) {
      await git(dir, ["update-ref", "-d", WORKSPACE_PUBLISH_REF, commit]);
      throw error;
    }

    maybeFailAfterWorkspaceHeadUpdate(dir);
    try {
      maybeFailRecoverableWorkspaceCheckout(dir);
      const paths = uniqueFiles.map((file) => file.path);
      await git(dir, ["--literal-pathspecs", "checkout", "--quiet", commit, "--", ...paths]);
      await git(dir, ["update-ref", "-d", WORKSPACE_PUBLISH_REF, commit]);
      return commit;
    } catch {
      // HEAD already names the durable commit. Treat a normal checkout/ref
      // cleanup failure as recoverable in this call so the DB layer cannot
      // record a failed adoption after Git actually applied it. A validation
      // conflict or repeated Git failure propagates and deliberately leaves
      // the marker for later diagnosis; the hard-crash test hook above stays
      // outside this catch to exercise restart recovery.
      await recoverWorkspacePublish(dir);
      return commit;
    }
  } finally {
    // A temporary-index cleanup failure must not turn an already-published
    // commit into an application-level failure. The directory contains no
    // authoritative state and can be removed by normal host housekeeping.
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function regularFileModeAtCommit(dir: string, commit: string, path: string): Promise<"100644" | "100755"> {
  const out = await git(dir, ["--literal-pathspecs", "ls-tree", "-z", commit, "--", path]);
  if (out.length === 0) return "100644";
  const match = /^([0-7]{6}) (?:blob|commit) [0-9a-f]+\t[\s\S]+\0$/.exec(out);
  return match?.[1] === "100755" ? "100755" : "100644";
}

/** 取某个 commit 下某个路径的原始字节（`git show <sha>:<path>`）。 */
export async function showAt(dir: string, commit: string, path: string): Promise<Uint8Array | null> {
  const res = await gitRaw(dir, ["show", `${commit}:${path}`]);
  if (res.exitCode !== 0) return null;
  return res.stdout;
}

/** 某个 commit 的树里有哪些文件（`git ls-tree -r --name-only`）。 */
export async function listTree(dir: string, commit: string): Promise<string[]> {
  const res = await gitRaw(dir, ["ls-tree", "-r", "--name-only", "-z", commit]);
  if (res.exitCode !== 0) return [];
  return decode(res.stdout).split("\0").filter((p) => p.length > 0);
}

export interface GitTreeEntry {
  readonly path: string;
  /** Raw six-digit Git mode (for example 100644, 120000, or 160000). */
  readonly mode?: string;
  readonly objectType: "blob" | "commit";
  /** `null` is Git's `-` size marker (for example a submodule commit). */
  readonly sizeBytes: number | null;
}

/**
 * List a fixed commit with blob sizes before reading any blob content. Import
 * callers use this as a resource-budget preflight so an authorized but huge
 * project cannot make Core materialize an unbounded tree in memory.
 */
export async function listTreeEntries(dir: string, commit: string): Promise<GitTreeEntry[]> {
  const res = await gitRaw(dir, ["ls-tree", "-r", "-l", "-z", commit]);
  if (res.exitCode !== 0) {
    throw new WorkspaceError(
      "WORKSPACE_GIT_FAILED",
      `git ls-tree 失败（exit ${res.exitCode}）：${res.stderr.trim() || "(无输出)"}`,
      { commit, cwd: dir },
    );
  }
  let output: string;
  try {
    output = new TextDecoder("utf-8", { fatal: true }).decode(res.stdout);
  } catch {
    throw new WorkspaceError("WORKSPACE_PATH_INVALID", "git tree contains a non-UTF-8 path", { commit });
  }
  const entries: GitTreeEntry[] = [];
  for (const field of output.split("\0")) {
    if (!field) continue;
    const match = /^([0-7]{6}) (blob|commit) [0-9a-f]+ +(-|[0-9]+)\t([\s\S]+)$/.exec(field);
    if (!match) {
      throw new WorkspaceError("WORKSPACE_GIT_FAILED", "git ls-tree returned an invalid record", { commit });
    }
    const rawSize = match[3]!;
    const sizeBytes = rawSize === "-" ? null : Number(rawSize);
    if (sizeBytes !== null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) {
      throw new WorkspaceError("WORKSPACE_GIT_FAILED", "git ls-tree returned an invalid blob size", { commit });
    }
    entries.push({
      mode: match[1]!,
      objectType: match[2]! as "blob" | "commit",
      sizeBytes,
      path: match[4]!,
    });
  }
  return entries;
}

export type GitFileState = "modified" | "untracked" | "deleted";

/**
 * `git status --porcelain -z` 的解析结果：路径 → 状态。
 *
 * 用 `-z` 而不是行分隔，是因为带空格/中文的文件名在默认输出里会被加引号并转义，
 * 解析出来的路径喂回 git 就不对了。重命名条目（`R`/`C`）在 `-z` 下占两个字段，
 * 必须多消费一格，否则后面所有条目的对齐都会错位。
 */
export async function statusMap(dir: string): Promise<Map<string, GitFileState>> {
  const out = await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const fields = out.split("\0");
  const result = new Map<string, GitFileState>();

  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code[0] === "R" || code[0] === "C") {
      const from = fields[i + 1];
      i += 1; // 跳过来源路径字段
      if (from) result.set(from, "deleted");
      result.set(path, "modified");
      continue;
    }
    if (code === "??") result.set(path, "untracked");
    else if (code.includes("D")) result.set(path, "deleted");
    else result.set(path, "modified");
  }
  return result;
}
