/**
 * Synthia Core — 工作区高层动作（建区 / 读写 / 状态 / 提交）
 *
 * 本文件只碰文件系统和 git，**不碰数据库**：登记成 artifact revision 是 handlers
 * 的事。这样路径契约与 git 行为可以脱离 Postgres 单测，也让「先 git 后 DB」的
 * 写序在代码结构上就是显然的。
 *
 * 写序说明：内容先落 git（内容寻址，重试安全），再写 DB 指向那个 commit。
 * DB 写失败留下的 commit 是无害的——它在分支上，不会被 GC，下次登记会带上它。
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  WORKSPACE_DIRS,
  WorkspaceError,
  absoluteWorkspacePath,
  isRegisterablePath,
  parseGitLocation,
  projectWorkspaceDir,
  validateProjectId,
  validateWorkspacePath,
} from "./paths.ts";
import {
  commitFilesAtomically,
  commitPaths,
  git,
  headSha,
  initRepo,
  isRepo,
  listTree,
  listTreeEntries,
  recoverWorkspacePublish,
  showAt,
  statusMap,
  withProjectLock,
} from "./git.ts";
import { sha256Hex } from "../hashing.ts";

/** 工作区文件的登记状态。`ignored` 只出现在 `sim/` 下（证据不是产物，见 RULE-25 §1）。 */
export type WorkspaceFileStatus = "registered" | "dirty" | "untracked" | "ignored";

export interface WorkspaceEntry {
  /** 工作区相对路径（`rtl/pwm.v`）。 */
  readonly path: string;
  readonly status: WorkspaceFileStatus;
  readonly bytes: number;
  /** 磁盘 mtime，ISO 字符串。 */
  readonly modifiedAt: string;
}

export interface WorkspaceFileInput {
  readonly path: string;
  readonly content: string;
}

export interface CommitOutcome {
  /** 新 commit 的 sha；本次没有任何实际变更时为 null。 */
  readonly commit: string | null;
  /** 本次提交涉及的工作区相对路径。 */
  readonly changed: readonly string[];
}

export interface CommitAuthor {
  readonly name: string;
  readonly email: string;
}

/**
 * Optional compare-and-write guard used by operations such as P3 adoption.
 * The hash is checked again while the project workspace lock is held, closing
 * the gap between an earlier preview and the actual Git write.
 */
export interface WorkspaceWriteGuard {
  readonly path: string;
  readonly expectedContentHash: string | null;
  /** Adoption must never absorb an editor's unregistered change. */
  readonly rejectPending?: boolean;
}

export interface WorkspaceWriteOptions {
  readonly guards?: readonly WorkspaceWriteGuard[];
}

// `sim/*` 而不是 `sim/`：后者排除的是目录本身，git 就再也无法重新纳入目录里的
// 任何文件，`!sim/.gitkeep` 会失效、连占位文件都提交不进去。
const GITIGNORE = `# 仿真/工具运行产物按 EvidenceManifest 登记，不进版本库（SYNTHIA-FPGA-RULE-25 §1）
sim/*
!sim/.gitkeep
`;

// ─── 建区 ────────────────────────────────────────────────────────────────────

/**
 * 幂等地准备好项目工作区：五个目录 + git 仓库 + 首个空 commit。
 * 建项目时调一次，之后每次写入前再调一次也无妨（已存在则只做几次 stat）。
 */
export async function ensureWorkspace(projectId: string): Promise<string> {
  const dir = projectWorkspaceDir(projectId);
  return withProjectLock(projectId, async () => {
    await mkdir(dir, { recursive: true });
    for (const sub of WORKSPACE_DIRS) {
      await mkdir(join(dir, sub), { recursive: true });
      await writeIfAbsent(join(dir, sub, ".gitkeep"), "");
    }
    if (!(await isRepo(dir))) {
      await initRepo(dir);
      await writeFile(join(dir, ".gitignore"), GITIGNORE, "utf8");
      await git(dir, ["add", "--", ".gitignore", ...WORKSPACE_DIRS.map((d) => `${d}/.gitkeep`)]);
      await git(dir, ["commit", "--no-verify", "--quiet", "-m", `工作区初始化（RULE-25 布局）\n\nproject: ${projectId}`]);
    }
    await recoverWorkspacePublish(dir);
    return dir;
  });
}

async function writeIfAbsent(abs: string, content: string): Promise<void> {
  try {
    await stat(abs);
  } catch {
    await writeFile(abs, content, "utf8");
  }
}

// ─── 读 ──────────────────────────────────────────────────────────────────────

/** 读工作区当前内容（含尚未登记的人工改动）。文件不存在抛 `WORKSPACE_FILE_NOT_FOUND`。 */
export async function readWorkingFile(projectId: string, path: string): Promise<string> {
  const abs = absoluteWorkspacePath(projectId, path);
  try {
    return await readFile(abs, "utf8");
  } catch {
    throw new WorkspaceError("WORKSPACE_FILE_NOT_FOUND", `工作区没有这个文件：${path}`, { path });
  }
}

/**
 * 按 `content_location` 取历史某版正文。
 * 不是 `git://` scheme 返回 null（调用方走 db 分支）；是 git 但对象取不到也返回 null
 * （调用方可回落到 DB 里的归档副本）。
 */
export async function readAtLocation(projectId: string, location: string): Promise<string | null> {
  const parsed = parseGitLocation(location);
  if (!parsed) return null;
  const dir = projectWorkspaceDir(validateProjectId(projectId));
  const bytes = await showAt(dir, parsed.commit, parsed.path);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/**
 * Read immutable input bytes only when a governed Git location names a regular
 * file.  Formal delivery must distinguish an ordinary blob from a symlink
 * (120000) or gitlink/submodule (160000); `git show` alone does not preserve
 * that security-relevant distinction.  A syntactically valid Git location
 * that no longer resolves is an integrity failure, not permission to fall back
 * to a mutable database/worktree copy.
 */
export async function readRegularFileAtLocation(
  projectId: string,
  location: string,
): Promise<Uint8Array | null> {
  const parsed = parseGitLocation(location);
  if (!parsed) return null;
  const dir = projectWorkspaceDir(validateProjectId(projectId));
  const entry = (await listTreeEntries(dir, parsed.commit))
    .find((candidate) => candidate.path === parsed.path);
  if (!entry) {
    throw new WorkspaceError(
      "CONTENT_HASH_MISMATCH",
      `正式输入的 Git 位置无法解析：${parsed.path}`,
      { commit: parsed.commit, path: parsed.path },
    );
  }
  if (
    entry.objectType !== "blob"
    || (entry.mode !== "100644" && entry.mode !== "100755")
  ) {
    throw new WorkspaceError(
      "WORKSPACE_PATH_INVALID",
      `正式输入拒绝符号链接或 Git submodule：${parsed.path}`,
      { commit: parsed.commit, path: parsed.path, mode: entry.mode, objectType: entry.objectType },
    );
  }
  const bytes = await showAt(dir, parsed.commit, parsed.path);
  if (bytes === null || entry.sizeBytes === null || bytes.byteLength !== entry.sizeBytes) {
    throw new WorkspaceError(
      "CONTENT_HASH_MISMATCH",
      `正式输入的 Git 字节不可用：${parsed.path}`,
      { commit: parsed.commit, path: parsed.path, expectedSize: entry.sizeBytes },
    );
  }
  return bytes;
}

// ─── 状态 ────────────────────────────────────────────────────────────────────

/**
 * 列出工作区里的全部文件及其登记状态。
 *
 * 状态判定：`git status --porcelain` 里出现的是 dirty/untracked，没出现的即与 HEAD
 * 一致（registered）。`sim/` 被 .gitignore 排除，永远不会出现在 status 里，所以要单独
 * 标成 ignored——否则它们会被误判成 registered，混进「N 个改动」的计数里去。
 */
export async function listWorkspace(projectId: string): Promise<WorkspaceEntry[]> {
  const dir = projectWorkspaceDir(validateProjectId(projectId));
  if (!(await isRepo(dir))) return [];

  const status = await statusMap(dir);
  const entries: WorkspaceEntry[] = [];
  for (const rel of await walkFiles(dir)) {
    const info = await stat(join(dir, rel));
    entries.push({
      path: rel,
      status: !isRegisterablePath(rel) ? "ignored" : (mapStatus(status.get(rel))),
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

function mapStatus(state: string | undefined): WorkspaceFileStatus {
  if (state === "untracked") return "untracked";
  if (state === undefined) return "registered";
  return "dirty";
}

/** 递归列出工作区里的真实文件（跳过 `.git` 与占位用的 `.gitkeep`）。 */
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(abs: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (dirent.name === ".git") continue;
      const child = join(abs, dirent.name);
      if (dirent.isDirectory()) {
        await visit(child);
      } else if (dirent.isFile() && dirent.name !== ".gitkeep" && dirent.name !== ".gitignore") {
        out.push(relative(root, child).split(sep).join("/"));
      }
    }
  }
  await visit(root);
  return out;
}

/** 待登记的改动（dirty + untracked，不含 `sim/`）。「工作区有 N 个改动」就是它的长度。 */
export async function pendingChanges(projectId: string): Promise<WorkspaceEntry[]> {
  const all = await listWorkspace(projectId);
  return all.filter((e) => e.status === "dirty" || e.status === "untracked");
}

// ─── 写 ──────────────────────────────────────────────────────────────────────

/**
 * 只落盘不提交——编辑器保存走这条，改动随即变成 dirty，等人点「登记」。
 * 返回内容是否真的变了（没变时 UI 不必刷新树）。
 */
export async function writeWorkingFile(projectId: string, path: string, content: string): Promise<boolean> {
  const rel = validateWorkspacePath(path);
  const abs = absoluteWorkspacePath(projectId, rel);
  return withProjectLock(projectId, async () => {
    if (await sameOnDisk(abs, content)) return false;
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    return true;
  });
}

/**
 * 写一批文件并提交（agent 产出候选走这条）。
 *
 * **带有未登记人工改动的文件会被拒绝覆盖**，抛 `WORKSPACE_FILE_DIRTY` 并点名该文件。
 * 宁可让 agent 看到「这个文件有人改过还没登记」再自己去读现状，也不能静默吃掉人的
 * 工作——工作区是人机共用的，这是唯一安全的默认。内容与盘上完全一致时不算冲突。
 */
export async function writeAndCommit(
  projectId: string,
  files: readonly WorkspaceFileInput[],
  message: string,
  author: CommitAuthor,
  options: WorkspaceWriteOptions = {},
): Promise<CommitOutcome> {
  const normalized = files.map((f) => ({ path: validateWorkspacePath(f.path), content: f.content }));
  const guards = (options.guards ?? []).map((guard) => ({
    path: validateWorkspacePath(guard.path),
    expectedContentHash: guard.expectedContentHash,
    rejectPending: guard.rejectPending === true,
  }));
  const dir = await ensureWorkspace(projectId);

  return withProjectLock(projectId, async () => {
    const status = await statusMap(dir);
    for (const guard of guards) {
      if (guard.rejectPending && status.has(guard.path)) {
        throw new WorkspaceError(
          "WORKSPACE_FILE_DIRTY",
          `文件有未登记改动，拒绝覆盖：${guard.path}`,
          { paths: [guard.path] },
        );
      }
      const actualHash = await contentHashOnDisk(join(dir, guard.path), guard.path);
      if (actualHash !== guard.expectedContentHash) {
        throw new WorkspaceError(
          "WORKSPACE_FILE_DIRTY",
          `文件在预览后发生变化，拒绝覆盖：${guard.path}`,
          {
            path: guard.path,
            expected: guard.expectedContentHash,
            actual: actualHash,
          },
        );
      }
    }
    const conflicts: string[] = [];
    for (const file of normalized) {
      const state = status.get(file.path);
      if (state === undefined) continue; // 与 HEAD 一致，覆盖它没有风险
      if (await sameOnDisk(join(dir, file.path), file.content)) continue; // 内容相同，不是冲突
      conflicts.push(file.path);
    }
    if (conflicts.length > 0) {
      throw new WorkspaceError(
        "WORKSPACE_FILE_DIRTY",
        `这些文件有未登记的人工改动，拒绝覆盖：${conflicts.join("、")}。请先登记或还原它们，或先读取当前内容再改。`,
        { paths: conflicts },
      );
    }

    const changedFiles: WorkspaceFileInput[] = [];
    for (const file of normalized) {
      const abs = join(dir, file.path);
      const identical = await sameOnDisk(abs, file.content);
      // 盘上恰好已经是这份字节、但 git 里还不是（untracked，或上一次登记 DB 侧失败留下的
      // dirty）时仍要收进本次 commit。只看「内容有没有变」会让这种文件永远进不了树，
      // 也就永远登记不上——agent 重试同样的内容也救不回来。
      if (!identical || status.get(file.path) !== undefined) changedFiles.push(file);
    }
    if (changedFiles.length === 0) {
      // 内容一字未变：不造空 commit，但要给出现 HEAD，让调用方仍能拼出 content_location。
      return { commit: await headSha(dir), changed: [] };
    }
    const commit = await commitFilesAtomically(dir, changedFiles, message, author);
    return {
      commit: commit ?? await headSha(dir),
      changed: changedFiles.map((file) => file.path),
    };
  });
}

/**
 * 「一键登记」的 git 侧：把工作区当前所有待登记改动收进**一个** commit。
 *
 * 一次 commit 对应 N 条修订是刻意的——人这一次编辑的原子性在 git 侧保住了，
 * DB 侧那 N 条修订共享同一个 sha，天然可回溯成「这一次登记」。
 */
export async function commitPending(
  projectId: string,
  message: string,
  author: CommitAuthor,
): Promise<CommitOutcome> {
  const dir = await ensureWorkspace(projectId);
  return withProjectLock(projectId, async () => {
    const pending = (await pendingPaths(dir)).filter(isRegisterablePath);
    if (pending.length === 0) return { commit: await headSha(dir), changed: [] };
    const commit = await commitPaths(dir, pending, message, author);
    return { commit, changed: pending };
  });
}

async function pendingPaths(dir: string): Promise<string[]> {
  const status = await statusMap(dir);
  return [...status.entries()]
    .filter(([, state]) => state !== "deleted")
    .map(([path]) => path)
    .filter(isMeaningfulPath)
    .sort();
}

/** 占位与配置文件不是产物，不该被登记成修订。 */
function isMeaningfulPath(rel: string): boolean {
  return rel !== ".gitignore" && !rel.endsWith("/.gitkeep") && rel !== ".gitkeep";
}

async function sameOnDisk(abs: string, content: string): Promise<boolean> {
  try {
    return (await readFile(abs, "utf8")) === content;
  } catch {
    return false;
  }
}

async function contentHashOnDisk(abs: string, path: string): Promise<string | null> {
  try {
    const bytes = await readFile(abs);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return sha256Hex(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkspaceError(
      "WORKSPACE_FILE_DIRTY",
      `无法安全复核文件，拒绝覆盖：${path}`,
      { path },
    );
  }
}

// ─── 某个 commit 的可登记文件全景 ────────────────────────────────────────────

export interface TreeFile {
  readonly path: string;
  readonly content: string;
  /** sha256(content)；与 `getRevisionContent` 复核时用的是同一个函数、同一份字节。 */
  readonly contentHash: string;
}

export interface TreeSnapshot {
  readonly commit: string;
  readonly files: readonly TreeFile[];
  /** 不是合法 UTF-8、无法作为文本修订登记的路径（例如误放进来的二进制文件）。 */
  readonly skippedBinary: readonly string[];
}

/**
 * 读出某个 commit 下所有**可登记**文件的正文。
 *
 * 「登记」的依据取自 git 树而不是 `git status`，是为了让登记可重试：上一次 commit
 * 成功但 DB 写失败时，改动已经不在 status 里了，只有从树出发才找得回来。
 *
 * 非 UTF-8 的文件被剔除并单独报出——正文是按字符串存的，硬塞进去会让
 * `content_hash` 与实际字节对不上，那正是这套设计要保证不会发生的事。
 */
export async function readTreeAt(projectId: string, commit: string): Promise<TreeSnapshot> {
  const dir = projectWorkspaceDir(validateProjectId(projectId));
  const paths = (await listTree(dir, commit)).filter(isRegisterablePath).filter(isMeaningfulPath);

  const files: TreeFile[] = [];
  const skippedBinary: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const path of paths.sort()) {
    const bytes = await showAt(dir, commit, path);
    if (bytes === null) continue;
    let content: string;
    try {
      content = decoder.decode(bytes);
    } catch {
      skippedBinary.push(path);
      continue;
    }
    files.push({ path, content, contentHash: sha256Hex(content) });
  }
  return { commit, files, skippedBinary };
}
