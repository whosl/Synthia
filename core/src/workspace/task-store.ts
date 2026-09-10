/**
 * Synthia Core — isolated task workspaces (P3 side-task slice).
 *
 * A side task receives an independent Git clone fixed at the project's clean
 * HEAD.  The clone is deliberately not a Git worktree: its `.git` directory
 * cannot lead a task process back into the controlled project repository.
 * Only Core resolves these paths and only normalized RULE-25 text files are
 * accepted.
 */

import { mkdir, lstat, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { sha256Hex } from "../hashing.ts";
import {
  git,
  gitRaw,
  headSha,
  isRepo,
  listTree,
  listTreeEntries,
  showAt,
  statusMap,
  withProjectLock,
} from "./git.ts";
import {
  WorkspaceError,
  isRegisterablePath,
  projectWorkspaceDir,
  validateProjectId,
  validateWorkspacePath,
  workspacesRoot,
} from "./paths.ts";
import {
  ensureWorkspace,
  readTreeAt,
  type CommitAuthor,
  type WorkspaceFileInput,
  workspaceFileBytes,
} from "./store.ts";

export type TaskWorkspaceChangeKind = "added" | "modified";

export interface TaskWorkspaceChange {
  readonly path: string;
  readonly change_kind: TaskWorkspaceChangeKind;
  readonly base_hash: string | null;
  readonly result_hash: string;
  readonly size_bytes: number;
  readonly media_type: "text/plain" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "application/octet-stream";
  readonly content_encoding: "utf8" | "base64";
  readonly base_content: string | null;
  readonly base_content_base64: string | null;
  readonly result_content: string | null;
  readonly result_content_base64: string | null;
}

export interface TaskWorkspaceSnapshot {
  readonly base_commit: string;
  readonly result_commit: string;
  readonly output_hash: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly changes: readonly TaskWorkspaceChange[];
}

export interface TaskWorkspaceResultContext {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly summary: string;
  readonly tests: readonly unknown[];
}

export interface TaskWorkspaceTreeEntry {
  readonly path: string;
  readonly content_hash: string;
  readonly size_bytes: number;
}

export interface TaskWorkspaceFileContent {
  readonly path: string;
  readonly content: string | null;
  readonly contentBase64: string | null;
  readonly encoding: "utf8" | "base64";
  readonly contentHash: string;
  readonly commit: string;
}

export interface IsolatedWorkspaceCreated {
  readonly workspaceId: string;
  readonly baseCommit: string;
  readonly baseManifestHash: string;
}

const DEFAULT_TASK_WORKSPACE_DIR = ".task-workspaces";
const MAX_TASK_FILE_BYTES = 1024 * 1024;

export function taskWorkspacesRoot(): string {
  const override = process.env.SYNTHIA_TASK_WORKSPACES_DIR;
  if (override && override.length > 0) return override;
  return join(workspacesRoot(), DEFAULT_TASK_WORKSPACE_DIR);
}

export function validateWorkspaceId(workspaceId: unknown): string {
  if (
    typeof workspaceId !== "string" ||
    workspaceId.length === 0 ||
    workspaceId.length > 160 ||
    !/^[A-Za-z0-9._-]+$/.test(workspaceId) ||
    workspaceId === "." ||
    workspaceId === ".."
  ) {
    throw new WorkspaceError("WORKSPACE_PATH_INVALID", "workspaceId 含非法字符");
  }
  return workspaceId;
}

export function taskWorkspaceDir(projectId: string, workspaceId: string): string {
  const root = taskWorkspacesRoot();
  const abs = resolve(root, validateProjectId(projectId), validateWorkspaceId(workspaceId));
  if (!abs.startsWith(resolve(root) + sep)) {
    throw new WorkspaceError("WORKSPACE_PATH_INVALID", "task workspace 越出根目录");
  }
  return abs;
}

/** Create (or validate) an independent clone of the project's current HEAD. */
export async function createIsolatedTaskWorkspace(
  projectId: string,
  workspaceId: string,
  expectedBaseCommit?: string,
): Promise<IsolatedWorkspaceCreated> {
  const project = validateProjectId(projectId);
  const workspace = validateWorkspaceId(workspaceId);
  const controlledDir = await ensureWorkspace(project);
  const baseCommit = await headSha(controlledDir);
  if (!baseCommit) {
    throw new WorkspaceError("WORKSPACE_GIT_FAILED", "主工作区没有可固定的 HEAD");
  }
  if (expectedBaseCommit !== undefined && expectedBaseCommit !== baseCommit) {
    throw new WorkspaceError(
      "WORKSPACE_FILE_DIRTY",
      "项目主线已变化，探索任务请求的 base_commit 不再是当前 HEAD。",
      { expected: expectedBaseCommit, actual: baseCommit },
    );
  }
  // Inspect the immutable tree before the working-copy cleanliness check so
  // unsupported committed entries (especially an uninitialised gitlink,
  // which Git also reports as a missing worktree path) retain their precise
  // fail-closed reason.
  await assertSupportedGitTree(controlledDir, baseCommit);
  const dirty = [...(await statusMap(controlledDir)).keys()].filter(isMeaningfulPath).sort();
  if (dirty.length > 0) {
    throw new WorkspaceError(
      "WORKSPACE_FILE_DIRTY",
      "主工作区存在未登记改动，不能创建探索副本；请先登记或还原。",
      { paths: dirty },
    );
  }
  const baseTree = await readTreeAt(project, baseCommit);
  const baseManifestHash = manifestHash(baseTree.files);
  const isolatedDir = taskWorkspaceDir(project, workspace);
  const parent = dirname(isolatedDir);

  await mkdir(parent, { recursive: true });
  return withProjectLock(`task:${project}:${workspace}`, async () => {
    if (await pathExists(isolatedDir) && await isRepo(isolatedDir)) {
      const existingHead = await headSha(isolatedDir);
      if (existingHead !== baseCommit) {
        throw new WorkspaceError(
          "WORKSPACE_GIT_FAILED",
          "同名探索副本已存在但基线不一致",
          { workspaceId: workspace, expected: baseCommit, actual: existingHead },
        );
      }
      return { workspaceId: workspace, baseCommit, baseManifestHash };
    }

    // --no-local prevents hardlinks/alternates from coupling the task clone to
    // the controlled repository's object store.
    await git(parent, [
      "clone",
      "--quiet",
      "--no-local",
      "--no-hardlinks",
      controlledDir,
      isolatedDir,
    ]);
    await git(isolatedDir, ["checkout", "--quiet", "--detach", baseCommit]);
    return { workspaceId: workspace, baseCommit, baseManifestHash };
  });
}

export async function readTaskWorkspaceFile(
  projectId: string,
  workspaceId: string,
  inputPath: string,
): Promise<TaskWorkspaceFileContent> {
  const path = validateWorkspacePath(inputPath);
  const dir = taskWorkspaceDir(projectId, workspaceId);
  await assertNoSymlinkPath(dir, path);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(join(dir, path));
  } catch {
    throw new WorkspaceError("WORKSPACE_FILE_NOT_FOUND", `探索副本没有这个文件：${path}`, { path });
  }
  if (bytes.byteLength > MAX_TASK_FILE_BYTES) {
    throw new WorkspaceError("WORKSPACE_PATH_INVALID", `探索文件超过 1 MiB：${path}`, { path });
  }
  const decoded = encodeWorkspaceBytes(bytes);
  const commit = await headSha(dir);
  if (!commit) throw new WorkspaceError("WORKSPACE_GIT_FAILED", "探索副本没有 HEAD");
  return {
    path,
    content: decoded.content,
    contentBase64: decoded.contentBase64,
    encoding: decoded.encoding,
    contentHash: sha256Hex(bytes),
    commit,
  };
}

/** List the complete current tree in the isolated clone, hashing exact bytes. */
export async function readTaskWorkspaceTree(
  projectId: string,
  workspaceId: string,
): Promise<{ commit: string; files: readonly TaskWorkspaceTreeEntry[] }> {
  const dir = taskWorkspaceDir(projectId, workspaceId);
  if (!(await isRepo(dir))) {
    throw new WorkspaceError("WORKSPACE_GIT_FAILED", "探索副本不存在或已损坏", { workspaceId });
  }
  const commit = await headSha(dir);
  if (!commit) throw new WorkspaceError("WORKSPACE_GIT_FAILED", "探索副本没有 HEAD");
  const entries = await assertSupportedGitTree(dir, commit);
  const files: TaskWorkspaceTreeEntry[] = [];
  for (const entry of entries) {
    if (!isMeaningfulPath(entry.path) || !isRegisterablePath(entry.path)) continue;
    const path = validateWorkspacePath(entry.path);
    if (entry.sizeBytes === null || entry.sizeBytes > MAX_TASK_FILE_BYTES) {
      throw new WorkspaceError("WORKSPACE_PATH_INVALID", `探索文件超过 1 MiB：${path}`, { path });
    }
    const bytes = await showAt(dir, commit, path);
    if (bytes === null) throw new WorkspaceError("WORKSPACE_GIT_FAILED", `无法读取探索文件：${path}`);
    files.push({
      path,
      content_hash: sha256Hex(bytes),
      size_bytes: bytes.byteLength,
    });
  }
  files.sort((a, b) => compareCodePoints(a.path, b.path));
  return { commit, files };
}

/** Write and commit files inside the isolated clone. No ArtifactRevision is created. */
export async function writeTaskWorkspaceFiles(
  projectId: string,
  workspaceId: string,
  files: readonly WorkspaceFileInput[],
  message: string,
  author: CommitAuthor,
): Promise<{ commit: string; changed: readonly string[] }> {
  const normalized = files.map((file) => ({
    path: validateWorkspacePath(file.path),
    ...(typeof file.content === "string"
      ? { content: file.content }
      : { contentBase64: file.contentBase64 }),
  }));
  const seen = new Set<string>();
  for (const file of normalized) {
    if (!isRegisterablePath(file.path)) {
      throw new WorkspaceError(
        "WORKSPACE_PATH_INVALID",
        `探索副本不能把 sim/ 作为受控结果写入：${file.path}`,
      );
    }
    if (seen.has(file.path)) {
      throw new WorkspaceError("WORKSPACE_PATH_INVALID", `重复路径：${file.path}`);
    }
    seen.add(file.path);
    const bytes = workspaceFileBytes(file as WorkspaceFileInput);
    if (bytes.byteLength > MAX_TASK_FILE_BYTES) {
      throw new WorkspaceError(
        "WORKSPACE_PATH_INVALID",
        `探索结果文件超过 1 MiB：${file.path}`,
      );
    }
  }

  const dir = taskWorkspaceDir(projectId, workspaceId);
  if (!(await isRepo(dir))) {
    throw new WorkspaceError("WORKSPACE_GIT_FAILED", "探索副本不存在或已损坏", { workspaceId });
  }

  return withProjectLock(`task:${projectId}:${workspaceId}`, async () => {
    const status = await statusMap(dir);
    const conflicts: string[] = [];
    for (const file of normalized) {
      await assertNoSymlinkPath(dir, file.path);
      const currentState = status.get(file.path);
      if (currentState === undefined) continue;
      if (await sameFile(join(dir, file.path), workspaceFileBytes(file as WorkspaceFileInput))) continue;
      conflicts.push(file.path);
    }
    if (conflicts.length > 0) {
      throw new WorkspaceError(
        "WORKSPACE_FILE_DIRTY",
        `探索副本含未提交改动，拒绝覆盖：${conflicts.join("、")}`,
        { paths: conflicts },
      );
    }

    const changed: string[] = [];
    for (const file of normalized) {
      const abs = join(dir, file.path);
      const bytes = workspaceFileBytes(file as WorkspaceFileInput);
      const identical = await sameFile(abs, bytes);
      if (!identical) {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, bytes);
      }
      if (!identical || status.get(file.path) !== undefined) changed.push(file.path);
    }
    if (changed.length > 0) {
      await git(dir, ["add", "--", ...changed]);
      const staged = await git(dir, ["diff", "--cached", "--name-only"]);
      if (staged.trim().length > 0) {
        await git(dir, [
          "-c",
          `user.name=${author.name}`,
          "-c",
          `user.email=${author.email}`,
          "commit",
          "--no-verify",
          "--quiet",
          "-m",
          message,
        ]);
      }
    }
    const commit = await headSha(dir);
    if (!commit) throw new WorkspaceError("WORKSPACE_GIT_FAILED", "探索副本提交后没有 HEAD");
    return { commit, changed };
  });
}

/** Build a self-contained UTF-8 result snapshot from base..HEAD. */
export async function snapshotTaskWorkspace(
  projectId: string,
  workspaceId: string,
  baseCommit: string,
  context: TaskWorkspaceResultContext,
): Promise<TaskWorkspaceSnapshot> {
  const dir = taskWorkspaceDir(projectId, workspaceId);
  if (!(await isRepo(dir))) {
    throw new WorkspaceError("WORKSPACE_GIT_FAILED", "探索副本不存在或已损坏", { workspaceId });
  }
  const dirty = [...(await statusMap(dir)).keys()].filter(isMeaningfulPath);
  if (dirty.length > 0) {
    throw new WorkspaceError(
      "WORKSPACE_FILE_DIRTY",
      "探索副本仍有未提交改动，不能生成结果",
      { paths: dirty },
    );
  }
  const resultCommit = await headSha(dir);
  if (!resultCommit) throw new WorkspaceError("WORKSPACE_GIT_FAILED", "探索副本没有 HEAD");
  const ancestry = await gitRaw(dir, ["merge-base", "--is-ancestor", baseCommit, resultCommit]);
  if (ancestry.exitCode !== 0) {
    throw new WorkspaceError(
      "WORKSPACE_GIT_FAILED",
      "探索结果提交不是固定基线的后代",
      { baseCommit, resultCommit },
    );
  }
  await assertSupportedGitTree(dir, baseCommit);
  await assertSupportedGitTree(dir, resultCommit);

  const changedPaths = await changedResultPaths(dir, baseCommit, resultCommit);
  for (const change of changedPaths) {
    if (change.status !== "A" && change.status !== "M") {
      throw new WorkspaceError(
        "WORKSPACE_PATH_INVALID",
        "P3 首版探索结果只支持新增或修改普通文本文件",
        { path: change.path, status: change.status },
      );
    }
    let normalized: string;
    try {
      normalized = validateWorkspacePath(change.path);
    } catch {
      throw new WorkspaceError(
        "WORKSPACE_PATH_INVALID",
        `探索结果包含非法路径：${change.path}`,
        { path: change.path },
      );
    }
    if (!isMeaningfulPath(normalized) || !isRegisterablePath(normalized)) {
      throw new WorkspaceError(
        "WORKSPACE_PATH_INVALID",
        `探索结果包含不可密封路径：${normalized}`,
        { path: normalized },
      );
    }
  }

  const basePaths = new Set((await listTree(dir, baseCommit)).filter(isMeaningfulPath));
  const resultPaths = new Set((await listTree(dir, resultCommit)).filter(isMeaningfulPath));
  const deleted = [...basePaths].filter((path) => !resultPaths.has(path));
  if (deleted.length > 0) {
    throw new WorkspaceError(
      "WORKSPACE_PATH_INVALID",
      "P3 首版探索结果不支持删除文件",
      { paths: deleted.sort() },
    );
  }

  const changes: TaskWorkspaceChange[] = [];
  for (const path of [...resultPaths].sort()) {
    let normalized: string;
    try {
      normalized = validateWorkspacePath(path);
    } catch {
      continue;
    }
    if (!isRegisterablePath(normalized)) continue;
    const resultBytes = await showAt(dir, resultCommit, normalized);
    if (resultBytes === null) continue;
    if (resultBytes.byteLength > MAX_TASK_FILE_BYTES) {
      throw new WorkspaceError(
        "WORKSPACE_PATH_INVALID",
        `探索结果文件超过 1 MiB：${normalized}`,
      );
    }
    const baseBytes = basePaths.has(normalized) ? await showAt(dir, baseCommit, normalized) : null;
    const resultEncoded = encodeWorkspaceBytes(resultBytes);
    const baseEncoded = baseBytes === null ? null : encodeWorkspaceBytes(baseBytes);
    const resultHash = sha256Hex(resultBytes);
    const baseHash = baseBytes === null ? null : sha256Hex(baseBytes);
    if (baseHash === resultHash) continue;
    changes.push({
      path: normalized,
      change_kind: baseBytes === null ? "added" : "modified",
      base_hash: baseHash,
      result_hash: resultHash,
      size_bytes: resultBytes.byteLength,
      media_type: mediaTypeForPath(normalized, resultEncoded.encoding),
      content_encoding: resultEncoded.encoding,
      base_content: baseEncoded?.content ?? null,
      base_content_base64: baseEncoded?.contentBase64 ?? null,
      result_content: resultEncoded.content,
      result_content_base64: resultEncoded.contentBase64,
    });
  }

  const manifest = {
    schema: "task-result.v1",
    taskId: context.taskId,
    workspaceId: context.workspaceId,
    baseCommit,
    resultCommit,
    summaryHash: sha256Hex(context.summary),
    tests: context.tests,
    files: changes.map((change) => ({
      path: change.path,
      changeKind: change.change_kind,
      baseHash: change.base_hash,
      resultHash: change.result_hash,
      sizeBytes: change.size_bytes,
    })),
  } as const;
  const outputHash = sha256Hex(canonicalJson(manifest));
  return {
    base_commit: baseCommit,
    result_commit: resultCommit,
    output_hash: outputHash,
    manifest,
    changes,
  };
}

async function changedResultPaths(
  dir: string,
  baseCommit: string,
  resultCommit: string,
): Promise<readonly { status: string; path: string }[]> {
  const result = await gitRaw(dir, [
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    baseCommit,
    resultCommit,
  ]);
  if (result.exitCode !== 0) {
    throw new WorkspaceError("WORKSPACE_GIT_FAILED", "无法计算探索结果完整差异");
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    throw new WorkspaceError("WORKSPACE_PATH_INVALID", "探索结果包含非 UTF-8 路径");
  }
  const fields = raw.split("\0").filter((field) => field.length > 0);
  if (fields.length % 2 !== 0) {
    throw new WorkspaceError("WORKSPACE_GIT_FAILED", "git diff 返回了无效的路径记录");
  }
  const changes: { status: string; path: string }[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    changes.push({ status: fields[index]!, path: fields[index + 1]! });
  }
  return changes;
}

export async function currentProjectFile(
  projectId: string,
  path: string,
): Promise<{
  content: string | null;
  contentBase64: string | null;
  encoding: "utf8" | "base64" | null;
  hash: string | null;
}> {
  const normalized = validateWorkspacePath(path);
  const root = projectWorkspaceDir(projectId);
  await assertNoSymlinkPath(root, normalized);
  const abs = join(root, normalized);
  try {
    const bytes = await readFile(abs);
    const encoded = encodeWorkspaceBytes(bytes);
    return { ...encoded, hash: sha256Hex(bytes) };
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new WorkspaceError("WORKSPACE_GIT_FAILED", `无法读取项目目标文件：${normalized}`);
    }
    return { content: null, contentBase64: null, encoding: null, hash: null };
  }
}

function manifestHash(files: readonly { path: string; contentHash: string; sizeBytes: number }[]): string {
  const canonical = [...files]
    .sort((a, b) => compareCodePoints(a.path, b.path))
    .map((file) => `${file.path}\0${file.contentHash}\0${file.sizeBytes}\n`)
    .join("");
  return sha256Hex(canonical);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("canonical JSON does not support undefined");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  const fields = Object.keys(object)
    .sort(compareCodePoints)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${fields.join(",")}}`;
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkspaceError("WORKSPACE_PATH_INVALID", `探索文件只支持 UTF-8 文本：${path}`, { path });
  }
}

function encodeWorkspaceBytes(bytes: Uint8Array): {
  readonly content: string | null;
  readonly contentBase64: string | null;
  readonly encoding: "utf8" | "base64";
} {
  try {
    return {
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      contentBase64: null,
      encoding: "utf8",
    };
  } catch {
    return {
      content: null,
      contentBase64: Buffer.from(bytes).toString("base64"),
      encoding: "base64",
    };
  }
}

function mediaTypeForPath(
  path: string,
  encoding: "utf8" | "base64",
): TaskWorkspaceChange["media_type"] {
  if (path.toLowerCase().endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return encoding === "utf8" ? "text/plain" : "application/octet-stream";
}

async function assertSupportedGitTree(dir: string, commit: string) {
  const entries = await listTreeEntries(dir, commit);
  const invalid = entries
    .filter((entry) => entry.objectType === "commit" || entry.mode === "120000" || entry.mode === "160000")
    .map((entry) => entry.path)
    .sort(compareCodePoints);
  if (invalid.length > 0) {
    throw new WorkspaceError(
      "WORKSPACE_PATH_INVALID",
      "P3 首版探索副本拒绝符号链接和 Git submodule。",
      { paths: invalid },
    );
  }
  const oversized = entries
    .filter((entry) => entry.objectType === "blob"
      && entry.sizeBytes !== null
      && entry.sizeBytes > MAX_TASK_FILE_BYTES
      && isMeaningfulPath(entry.path)
      && isRegisterablePath(entry.path))
    .map((entry) => entry.path)
    .sort(compareCodePoints);
  if (oversized.length > 0) {
    throw new WorkspaceError(
      "WORKSPACE_PATH_INVALID",
      "P3 首版探索文件不能超过 1 MiB。",
      { paths: oversized },
    );
  }
  return entries;
}

function isMeaningfulPath(path: string): boolean {
  return path !== ".gitignore" && path !== ".gitkeep" && !path.endsWith("/.gitkeep");
}

async function sameFile(abs: string, bytes: Uint8Array): Promise<boolean> {
  try {
    return Buffer.from(await readFile(abs)).equals(Buffer.from(bytes));
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Reject an existing symlink at any path component before filesystem I/O. */
async function assertNoSymlinkPath(root: string, relativePath: string): Promise<void> {
  const parts = validateWorkspacePath(relativePath).split("/");
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new WorkspaceError(
          "WORKSPACE_PATH_INVALID",
          `探索副本拒绝符号链接路径：${relativePath}`,
        );
      }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      // A missing leaf/parent is valid for an added file.
      try {
        await stat(current);
      } catch {
        return;
      }
    }
  }
}
