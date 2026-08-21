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

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** 跑一条 git 命令；不抛，由调用方决定非零退出码是否算失败。 */
export async function gitRaw(cwd: string, args: readonly string[]): Promise<GitResult> {
  const proc = Bun.spawn({
    cmd: ["git", ...GIT_CONFIG_ARGS, ...args],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_ENV },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** 跑一条必须成功的 git 命令，非零退出即抛 `WORKSPACE_GIT_FAILED`。 */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const res = await gitRaw(cwd, args);
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
