/**
 * Synthia Core API — 工作区五条（真实磁盘 + git 承载内容）
 *
 *   GET    /projects/:id/workspace/tree      盘上目录树 + 每文件登记状态
 *   GET    /projects/:id/workspace/file      读工作区**当前**内容（含未登记改动）
 *   PUT    /projects/:id/workspace/file      编辑器写回；只落盘不 commit
 *   POST   /projects/:id/workspace/register  **一键登记**：一次 commit → N 条候选修订
 *   POST   /projects/:id/workspace/files     agent 写候选：落盘 + commit + 只登记这几条
 *
 * `register` 是本文件的重点。它刻意**不是**「把 git status 里的东西登记一遍」，而是
 * 「让 DB 追上 git 树」：先把待登记改动收进一个 commit，再拿这个 commit 的整棵树逐
 * 文件与「该产物最新一版的 content_hash」比对，不同的才出新版。
 *
 * 为什么绕这一圈：先 git 后 DB 的写序里，commit 成功而 DB 写失败是会发生的。若按
 * status 登记，重试时改动已经不在 status 里了，那批修订就**永远补不回来**。以树为
 * 准则重试自愈——它比对的是事实（树里的字节 vs 库里的 hash），不是事件。
 *
 * 与「最新一版」而不是「任意一版」比对也是刻意的：内容改回历史上出现过的样子
 * （A→B→A）仍然要产生 v3。回退是一次真实的工程决定，不该在历史里消失。
 *
 * `files` 与 `register` 共用同一套对树的比对（`reconcileIntoRevisions`），区别只在
 * 谁来写盘、以及登记范围限不限于点名的路径——见该 handler 的注释。
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createRevision, type TransactionClient } from "../db/repository.ts";
import type { DataClassification } from "../domain/enums.ts";
import { sha256Hex } from "../hashing.ts";
import {
  artifactIdForPath,
  formatGitLocation,
  isRegisterablePath,
  parseGitLocation,
  validateWorkspacePath,
  WorkspaceError,
} from "../workspace/paths.ts";
import {
  commitPending,
  ensureWorkspace,
  listWorkspace,
  readTreeAt,
  readWorkingFile,
  writeAndCommit,
  writeWorkingFile,
  type CommitAuthor,
  type TreeSnapshot,
} from "../workspace/store.ts";
import { notFoundError, validationError } from "./errors.ts";
import {
  asClient,
  asObject,
  MAX_CONTENT_BYTES,
  optionalString,
  outboxEvent,
  requireProject,
  runIdempotent,
  type HandlerResult,
  type RequestContext,
} from "./handlers.ts";

// ─── 共用：把工作区路径接回 artifact ─────────────────────────────────────────

/** 每个 artifact 的最新一版修订（外加接路径要用的 title / content_location）。 */
interface LatestRevision {
  readonly artifact_id: string;
  readonly id: string;
  readonly version: number;
  readonly content_hash: string;
  readonly content_location: string;
  readonly state: string;
  readonly title: string;
}

/** 索引好的最新修订表，供 `resolveArtifact` 按三种线索查。 */
interface LatestIndex {
  readonly byTitle: Map<string, LatestRevision>;
  readonly byGitPath: Map<string, LatestRevision>;
  readonly byArtifactId: Map<string, LatestRevision>;
}

/** `Pool` 与 `TransactionClient` 的 query 签名不同，取最小公分母以免到处 cast。 */
type QueryFn = (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>;

/**
 * 取该项目每个 artifact 的最新一版修订。
 *
 * `DISTINCT ON (artifact_id) … ORDER BY artifact_id, version DESC` 是 PG 的惯用法，
 * 一趟查询拿到「每组最大」，比 N+1 次查询或窗口函数子查询都直接。
 */
async function loadLatestRevisions(query: QueryFn, projectId: string): Promise<LatestIndex> {
  const { rows } = await query(
    `SELECT DISTINCT ON (ar.artifact_id)
            ar.artifact_id, ar.id, ar.version, ar.content_hash, ar.content_location,
            ar.state::text AS state, a.title
       FROM artifact_revision ar
       JOIN artifact a ON a.id = ar.artifact_id
      WHERE ar.project_id = $1
      ORDER BY ar.artifact_id, ar.version DESC`,
    [projectId],
  );

  const byTitle = new Map<string, LatestRevision>();
  const byGitPath = new Map<string, LatestRevision>();
  const byArtifactId = new Map<string, LatestRevision>();
  for (const row of rows as LatestRevision[]) {
    byArtifactId.set(row.artifact_id, row);
    // 只认「标题本身就是一条合法工作区路径」的情形。老产物的标题是
    // `fpga-rtl-build: rtl/pwm.v` 这种人话，拿它当路径匹配只会误接。
    if (isWorkspacePath(row.title)) byTitle.set(row.title, row);
    const git = parseGitLocation(row.content_location);
    if (git) byGitPath.set(git.path, row);
  }
  return { byTitle, byGitPath, byArtifactId };
}

function isWorkspacePath(value: string): boolean {
  try {
    return validateWorkspacePath(value) === value;
  } catch {
    return false;
  }
}

/**
 * 由工作区路径找到它属于哪个 artifact 的哪一版。
 *
 * 三条线索按可靠性排序：标题就是路径（登记时写的）→ 最新一版的 `git://` 位置指向
 * 这条路径（agent 登记时写的）→ 由路径推导的确定性 id。找不到说明这个文件还没被
 * 登记过，调用方据此新建 artifact。
 */
function resolveArtifact(index: LatestIndex, projectId: string, path: string): LatestRevision | null {
  return (
    index.byTitle.get(path) ??
    index.byGitPath.get(path) ??
    index.byArtifactId.get(artifactIdForPath(projectId, path)) ??
    null
  );
}

async function requireProjectExists(pool: Pool, projectId: string): Promise<void> {
  const { rows } = await pool.query("SELECT 1 FROM project WHERE id = $1", [projectId]);
  if (rows.length === 0) throw notFoundError(`project not found: ${projectId}`);
}

// ─── GET /workspace/tree ─────────────────────────────────────────────────────

export async function getWorkspaceTreeHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  await requireProjectExists(ctx.pool, projectId);

  const entries = await listWorkspace(projectId);
  const latest = await loadLatestRevisions((t, v) => ctx.pool.query(t, v), projectId);

  const files = entries.map((entry) => {
    // `sim/` 下是证据不是产物，永远接不到 artifact——去查一遍只会得到误导性的 null 语义。
    const match = entry.status === "ignored" ? null : resolveArtifact(latest, projectId, entry.path);
    return {
      path: entry.path,
      status: entry.status,
      bytes: entry.bytes,
      modified_at: entry.modifiedAt,
      artifact_id: match?.artifact_id ?? null,
      revision_id: match?.id ?? null,
      version: match?.version ?? null,
      revision_state: match?.state ?? null,
      content_hash: match?.content_hash ?? null,
    };
  });

  return {
    status: 200,
    data: {
      project_id: projectId,
      files,
      pending_count: files.filter((f) => f.status === "dirty" || f.status === "untracked").length,
    },
  };
}

// ─── GET / PUT /workspace/file ───────────────────────────────────────────────

/**
 * 读工作区当前内容，并**当场说清这份字节有没有被登记**。
 *
 * 回报里的 `registered` 是拿刚读到的字节算出的 sha256 与「该产物最新一版的
 * content_hash」比出来的，不是拿 git status 猜的。差别在于：人把文件改回登记时的样
 * 子（改坏又改回来），status 说 dirty，但字节确实就是登记的那一版——按字节判定才对。
 *
 * `commit` 只在 `registered` 为真时给出：它取自那一版的 `git://<sha>/<path>`，意思是
 * 「这份字节就是 <sha> 里的那份」。文件带着未登记改动时给 commit 是有害的——HEAD 根本
 * 不含这些字节，读的人会以为编译的是已登记的版本。
 */
export async function getWorkspaceFileHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const raw = ctx.url.searchParams.get("path");
  if (!raw) throw validationError("query parameter 'path' is required");
  await requireProjectExists(ctx.pool, projectId);

  const path = validateWorkspacePath(raw);
  const content = await readWorkingFile(projectId, path);
  const contentHash = sha256Hex(content);

  const latest = await loadLatestRevisions((t, v) => ctx.pool.query(t, v), projectId);
  const match = resolveArtifact(latest, projectId, path);
  const registered = match !== null && match.content_hash === contentHash;

  return {
    status: 200,
    data: {
      path,
      content,
      content_hash: contentHash,
      registered,
      artifact_id: registered ? match!.artifact_id : null,
      revision_id: registered ? match!.id : null,
      version: registered ? match!.version : null,
      commit: registered ? (parseGitLocation(match!.content_location)?.commit ?? null) : null,
    },
  };
}

/**
 * 编辑器写回：**只落盘不 commit**。
 *
 * 不走幂等中间件也不发 outbox 事件——工作树里的未登记改动不是治理状态，它只是「人正
 * 在改」。PUT 天然幂等（同样内容写两次结果相同），受治理的那一刻是 `register`。
 */
export async function putWorkspaceFileHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  const path = validateWorkspacePath(body.path);
  // 空文件是合法的，所以不能用 requireString（它拒绝空串）。
  if (typeof body.content !== "string") throw validationError("field 'content' must be a string");
  if (Buffer.byteLength(body.content, "utf8") > MAX_CONTENT_BYTES) {
    throw validationError(`field 'content' must be at most ${MAX_CONTENT_BYTES} bytes`);
  }

  // 项目必须先存在，否则会在盘上凭空建出一个没有对应项目的工作区。
  await requireProjectExists(ctx.pool, projectId);
  await ensureWorkspace(projectId);
  const changed = await writeWorkingFile(projectId, path, body.content);

  return { status: 200, data: { path, changed, content_hash: sha256Hex(body.content) } };
}

// ─── 共用：让 DB 追上某个 commit 的树 ────────────────────────────────────────

interface RegisteredFile {
  readonly path: string;
  readonly artifact_id: string;
  readonly revision_id: string;
  readonly version: number;
  readonly content_hash: string;
}

interface SkippedFile {
  readonly path: string;
  readonly reason: "not_utf8" | "too_large" | "invalid_path";
}

interface ReconcileOptions {
  readonly changeReason: string;
  /** 新建 artifact 时的类型覆盖；空串表示按目录推断。 */
  readonly artifactTypeOverride: string;
  /** 只登记这几条路径（agent 定向写入）；省略表示整棵树（一键登记）。 */
  readonly onlyPaths?: readonly string[];
}

interface ReconcileResult {
  readonly registered: RegisteredFile[];
  /** 字节与该产物最新一版完全相同、因而没出新版的文件——连同它指向的那一版。
   *  只回路径的话，调用方（agent 重发同样内容、web 刷新树）就无从知道「那是哪一版」。 */
  readonly unchanged: RegisteredFile[];
  readonly skipped: SkippedFile[];
}

/**
 * 逐文件比对「树里的字节」与「该产物最新一版的 content_hash」，不同的才出新版。
 *
 * `onlyPaths` 是给 agent 定向写入用的：agent 只为自己写的那几个文件负责，把人手边
 * 还没登记完的改动一并算到 agent 头上是错的署名。但**依据仍然是树而不是本次
 * commit 的 changed 列表**——这才是重试自愈的来源：commit 成功而 DB 写失败时，重试
 * 那次的 `changed` 是空的，只有从树出发才补得回来。
 */
async function reconcileIntoRevisions(
  tx: TransactionClient,
  ctx: RequestContext,
  projectId: string,
  snapshot: TreeSnapshot,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const only = opts.onlyPaths ? new Set(opts.onlyPaths) : null;
  const inScope = (path: string) => only === null || only.has(path);

  const latest = await loadLatestRevisions((t, v) => tx.query(t, v), projectId);
  const registered: RegisteredFile[] = [];
  const unchanged: RegisteredFile[] = [];
  const skipped: SkippedFile[] = snapshot.skippedBinary
    .filter(inScope)
    .map((path) => ({ path, reason: "not_utf8" as const }));

  for (const file of snapshot.files) {
    if (!inScope(file.path)) continue;
    if (!isWorkspacePath(file.path)) {
      // 树里混进了不符合 RULE-25 的路径（有人直接往工作区根目录放了文件）。
      skipped.push({ path: file.path, reason: "invalid_path" });
      continue;
    }
    if (Buffer.byteLength(file.content, "utf8") > MAX_CONTENT_BYTES) {
      skipped.push({ path: file.path, reason: "too_large" });
      continue;
    }

    const previous = resolveArtifact(latest, projectId, file.path);
    if (previous && previous.content_hash === file.contentHash) {
      unchanged.push({
        path: file.path,
        artifact_id: previous.artifact_id,
        revision_id: previous.id,
        version: previous.version,
        content_hash: previous.content_hash,
      });
      continue;
    }
    const artifactId = previous?.artifact_id ?? artifactIdForPath(projectId, file.path);

    // `DO UPDATE SET title = artifact.title` 是「不改任何字段但取到行锁」的写法：
    // 锁持续到事务结束，下面读到的 MAX(version) 因此稳定，同一产物的并发登记会
    // 各自阻塞在这里依次拿到 n、n+1。写成 `DO NOTHING` 就拿不到锁了。
    // 已存在的 artifact 保留它自己的标题——那是别人设的治理元数据，不该被覆盖。
    await tx.query(
      `INSERT INTO artifact (id, project_id, artifact_type, title)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET title = artifact.title`,
      [artifactId, projectId, opts.artifactTypeOverride || artifactTypeForPath(file.path), file.path],
    );
    const maxRes = await tx.query(
      "SELECT COALESCE(MAX(version), 0)::int AS max FROM artifact_revision WHERE artifact_id = $1",
      [artifactId],
    );
    const version = ((maxRes.rows[0] as { max: number } | undefined)?.max ?? 0) + 1;

    const revisionId = `rev-${randomUUID()}`;
    await createRevision(asClient(tx), {
      id: revisionId,
      artifactId,
      projectId,
      version,
      state: "candidate",
      parentRevisionId: previous?.id ?? null,
      contentHash: file.contentHash,
      // 正文只在 git 里。进基线时 `freezeBaselineContent` 会把它冻回 content 列。
      contentLocation: formatGitLocation(snapshot.commit, file.path),
      content: null,
      schemaVersion: "v1",
      sourceIds: [],
      dataClassification: ctx.classification as DataClassification,
      toolModelProvenance: null,
      changeReason: opts.changeReason,
      createdBy: ctx.identity.actorId,
      createdByType: ctx.identity.actorType,
      reviewIds: [],
      createdAt: new Date().toISOString(),
    });
    await outboxEvent(tx, ctx, { type: "artifact_revision", id: revisionId }, "revision.created", {
      id: revisionId,
      artifactId,
      projectId,
      version,
      state: "candidate",
      path: file.path,
      commit: snapshot.commit,
    });

    registered.push({
      path: file.path,
      artifact_id: artifactId,
      revision_id: revisionId,
      version,
      content_hash: file.contentHash,
    });
  }

  return { registered, unchanged, skipped };
}

// ─── POST /workspace/register ────────────────────────────────────────────────

export async function registerWorkspaceHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  const changeReason = optionalString(body, "change_reason", "").trim();
  // 新建 artifact 时的类型。`doc/` 下的文档类型机器猜不准，允许调用方指定。
  const artifactTypeOverride = optionalString(body, "artifact_type", "").trim();

  await requireProjectExists(ctx.pool, projectId);
  // 幂等键在 `runIdempotent` 里也会校验，但那时 commit 已经落地了——一个注定 400 的
  // 请求不该在历史里留下痕迹。这里提前挡住。
  if (!ctx.idempotencyKey) throw validationError("Idempotency-Key header is required for writes");

  // ── git 侧：一次 commit 收掉全部待登记改动 ──
  // 放在幂等槽**之外**是安全的：同 key 重放时工作区已经干净，`commitPending` 退化成
  // 「返回当前 HEAD」的空操作，随后 DB 侧照常重放存好的响应。
  const commitMessage = changeReason.length > 0
    ? `登记：${changeReason}\n\nby: ${ctx.identity.actorId}`
    : `登记工作区改动\n\nby: ${ctx.identity.actorId}`;
  const outcome = await commitPending(projectId, commitMessage, gitAuthor(ctx.identity.actorId));
  if (!outcome.commit) {
    // 建区时就有 initial commit，走到这里说明 .git 被外部删了或损坏了。
    throw new WorkspaceError("WORKSPACE_GIT_FAILED", `工作区没有任何提交，可能已损坏：${projectId}`, { projectId });
  }
  const snapshot = await readTreeAt(projectId, outcome.commit);

  // ── DB 侧：让库追上这棵树 ──
  const { result } = await runIdempotent(ctx, "register_workspace", projectId, async (tx) => {
    await requireProject(tx, projectId);
    const reconciled = await reconcileIntoRevisions(tx, ctx, projectId, snapshot, {
      changeReason,
      artifactTypeOverride,
    });
    return { commit: snapshot.commit, committed: outcome.changed, ...reconciled };
  });

  return { status: 200, data: result };
}

// ─── POST /workspace/files ───────────────────────────────────────────────────

/**
 * agent 写候选：**落盘 + commit + 只登记自己写的那几条路径**。
 *
 * 与 `register` 的两点分别，都不是实现细节而是安全边界：
 *
 * 1. 走 `writeAndCommit` 的**脏文件保护**——目标文件带有未登记的人工改动时整个请求
 *    被拒（409），点名该文件。工作区是人机共用的，静默覆盖人正在改的东西是不可接受
 *    的默认；agent 收到这个错误应该先去读现状。
 * 2. 只登记 `files` 里点名的路径。`register` 是「把工作区当前所有改动收归己有」，让
 *    agent 走那条路会把人手边没写完的改动一并署上 agent 的名字。
 */
export async function writeWorkspaceFilesHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  const changeReason = optionalString(body, "change_reason", "").trim();
  const artifactTypeOverride = optionalString(body, "artifact_type", "").trim();
  const files = parseFileInputs(body.files);

  await requireProjectExists(ctx.pool, projectId);
  if (!ctx.idempotencyKey) throw validationError("Idempotency-Key header is required for writes");

  const commitMessage = changeReason.length > 0
    ? `候选产出：${changeReason}\n\nby: ${ctx.identity.actorId}`
    : `agent 写入工作区\n\nby: ${ctx.identity.actorId}`;
  const outcome = await writeAndCommit(projectId, files, commitMessage, gitAuthor(ctx.identity.actorId));
  if (!outcome.commit) {
    throw new WorkspaceError("WORKSPACE_GIT_FAILED", `工作区没有任何提交，可能已损坏：${projectId}`, { projectId });
  }
  const snapshot = await readTreeAt(projectId, outcome.commit);

  const { result } = await runIdempotent(ctx, "write_workspace_files", projectId, async (tx) => {
    await requireProject(tx, projectId);
    const reconciled = await reconcileIntoRevisions(tx, ctx, projectId, snapshot, {
      changeReason,
      artifactTypeOverride,
      onlyPaths: files.map((f) => f.path),
    });
    return { commit: snapshot.commit, committed: outcome.changed, ...reconciled };
  });

  return { status: 200, data: result };
}

const MAX_FILES_PER_WRITE = 32;

/** 校验 `files` 入参，顺带把路径规范化成 RULE-25 相对路径。 */
function parseFileInputs(raw: unknown): { path: string; content: string }[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw validationError("field 'files' must be a non-empty array");
  }
  if (raw.length > MAX_FILES_PER_WRITE) {
    throw validationError(`field 'files' must contain at most ${MAX_FILES_PER_WRITE} entries`);
  }
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw validationError(`files[${i}] must be an object`);
    }
    const item = entry as Record<string, unknown>;
    const path = validateWorkspacePath(item.path);
    // 空文件合法，所以不能用 requireString。
    if (typeof item.content !== "string") throw validationError(`files[${i}].content must be a string`);
    if (Buffer.byteLength(item.content, "utf8") > MAX_CONTENT_BYTES) {
      throw validationError(`files[${i}].content must be at most ${MAX_CONTENT_BYTES} bytes`);
    }
    if (!isRegisterablePath(path)) {
      // `sim/` 被 .gitignore 排除，`git add` 会直接失败；而且仿真产物按
      // EvidenceManifest 登记，本来就不该走产物这条路（RULE-25 §1）。
      throw validationError(`不能往 sim/ 写产物：${path}。仿真与工具运行产物按证据登记，不进版本库（RULE-25 §1）。`);
    }
    if (seen.has(path)) throw validationError(`files 里有重复路径：${path}`);
    seen.add(path);
    return { path, content: item.content };
  });
}


/**
 * 新建 artifact 时按目录推断类型（RULE-25 §1 的目录语义）。
 *
 * `doc/` 下具体是哪种 GJB 文档，从路径上是猜不出来的——落 `DETAILED_DESIGN` 只是个
 * 能进库的占位，需要准确类型时调用方传 `artifact_type` 覆盖。
 */
function artifactTypeForPath(rel: string): string {
  if (rel.startsWith("rtl/")) return "RTL_SOURCE_SET";
  if (rel.startsWith("tb/")) return "TB_SOURCE_SET";
  if (rel.startsWith("prj/constr/")) return "XDC_CANDIDATE";
  return "DETAILED_DESIGN";
}

/** git 的 ident 解析把 `<`、`>`、换行当分隔符，混进去 commit 会直接失败。 */
function gitAuthor(actorId: string): CommitAuthor {
  const name = actorId.replace(/[<>\n\r]/g, "").trim() || "unknown";
  return { name, email: `${name.replace(/[^A-Za-z0-9._-]/g, "-")}@synthia.local` };
}
