#!/usr/bin/env bun
/**
 * Synthia Core — 一次性迁移：把库里的修订正文重放进各项目的 git 工作区
 *
 * 现存修订的 `content_location` 一律是 `db://artifact_revision/<id>`，正文躺在
 * `content` 列里。本脚本给每个项目建出工作区，把该项目的修订**按时间顺序逐条重放
 * 成一个个 commit**（一条修订 = 一个 commit，commit message 带 revision id），再把
 * 该修订的 `content_location` 回填成 `git://<sha>/<path>`。
 *
 * `content` 列保留不动。它就此变成归档副本（与「已批准修订冻结正文」同一角色），
 * 也让这件事**可回退**：把 content_location 改回 `db://artifact_revision/<id>` 即为
 * 完整回滚，`getRevisionContent` 会照旧读 content 列。
 *
 *   DATABASE_URL=… bun run core/scripts/migrate-to-workspace.ts             # 只出方案，不动盘也不动库
 *   DATABASE_URL=… bun run core/scripts/migrate-to-workspace.ts --apply     # 真的写
 *   …                                                          --project p1 # 只处理一个项目
 *
 * 默认干跑是刻意的：这个脚本同时写磁盘和实库，「先看一眼」应该是默认路径而不是
 * 需要记得加的开关。干跑会把每条修订将落到哪条路径、哪些落进兜底路径全部打出来。
 *
 * 不发 outbox 事件、不写审计：这些修订本来就存在，本次只是把正文搬了个地方，
 * 没有产生任何新的治理事实。
 */

import type { Client } from "pg";
import { getClient } from "../src/db/client.ts";
import { sha256Hex } from "../src/hashing.ts";
import {
  formatGitLocation,
  parseGitLocation,
  projectWorkspaceDir,
  validateWorkspacePath,
  workspacesRoot,
} from "../src/workspace/paths.ts";
import { ensureWorkspace, readAtLocation, writeAndCommit } from "../src/workspace/store.ts";

// ─── 路径：老修订的正文该落到工作区的哪一条路上 ──────────────────────────────

/** 看起来像文件路径：只含路径安全字符，且要么有目录层级、要么有扩展名。 */
const PATH_SHAPE = /^[\w.@+-]+(?:\/[\w.@+-]+)*$/;

/**
 * 从 artifact 标题反解路径——与 `web/src/domain/file-tree.ts:pathFromRevisionTitle`
 * 同一套规则。skill 登记候选时把路径写进了标题（`fpga-rtl-build: rtl/pwm.v`），
 * 那是老数据里**唯一**持久带住路径的地方。
 *
 * 两边必须解出同一条路径：前端那份是显示兜底，这份是落盘依据，解得不一样会让同一个
 * 文件在树上出现两行。
 */
function pathFromTitle(title: string | null): string | null {
  if (!title) return null;
  const sep = title.indexOf(": ");
  const candidate = (sep >= 0 ? title.slice(sep + 2) : title).trim();
  if (!candidate || !PATH_SHAPE.test(candidate)) return null;
  // 既无目录层级又无扩展名的裸词（"document"）不是路径，是标题残片。
  if (!candidate.includes("/") && !/\.[A-Za-z0-9]+$/.test(candidate)) return null;
  return candidate.replace(/^\.\//, "").replace(/^\/+/, "");
}

/** 产物类型 → 该去哪个目录、按什么扩展名命名（RULE-25 §1 的目录语义）。 */
const TYPE_LANDING: Readonly<Record<string, { dir: string; ext: string }>> = {
  RTL_SOURCE_SET: { dir: "rtl", ext: ".v" },
  TB_SOURCE_SET: { dir: "tb", ext: ".v" },
  XDC_CANDIDATE: { dir: "prj/constr", ext: ".xdc" },
};

/**
 * 标题里没有路径的老产物（流水线登记的 `art-<阶段>-<8位hex>`）落到哪儿。
 *
 * 计划里写的是统一落 `doc/<artifactType>.md`，实际数据当场否掉了这个写法：p1 里
 * `art-behavior_wave-*` 与 `art-register_spec-*` 同为 `DETAILED_DESIGN`，会撞成同一条
 * 路径，把两条互不相干的版本链并进一个文件。所以文件名改用 **id 里的阶段名**——它在
 * 项目内唯一，也正是 `phaseFromArtifactId` 反解出来给前端分组用的那个值。
 *
 * 目录与扩展名按产物类型给，不是一律 doc/：`art-rtl-d6841ba9` 的正文是 Verilog，
 * 落成 `doc/rtl.md` 既是睁眼说瞎话，也违反 RULE-25 §3（doc/ 只放分析/规范/交接）。
 */
function fallbackPath(artifactId: string, artifactType: string): string {
  const stage = /^art-(.+)-[0-9a-f]{8}$/.exec(artifactId)?.[1];
  const base = sanitizeSegment(stage ?? artifactId);
  const landing = TYPE_LANDING[artifactType] ?? { dir: "doc", ext: ".md" };
  return `${landing.dir}/${base}${landing.ext}`;
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
  return cleaned.length > 0 ? cleaned : "unnamed";
}

/** 撞路径时的消歧：把 artifact id 塞进扩展名之前，唯一性由 id 本身保证。 */
function disambiguate(path: string, artifactId: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const suffix = sanitizeSegment(artifactId);
  if (dot > slash) return `${path.slice(0, dot)}.${suffix}${path.slice(dot)}`;
  return `${path}.${suffix}`;
}

function isValidWorkspacePath(path: string): boolean {
  try {
    return validateWorkspacePath(path) === path;
  } catch {
    return false;
  }
}

interface ArtifactInfo {
  readonly artifactId: string;
  readonly artifactType: string;
  readonly title: string;
}

interface PathPlan extends ArtifactInfo {
  readonly path: string;
  /** `title` = 标题里就带着路径；`fallback` = 猜的，需要人工核对。 */
  readonly source: "title" | "fallback";
  /** 目标路径被别的产物先占了，这条被改了名。 */
  readonly collided: boolean;
}

/**
 * 给项目里每个 artifact 定一条路径。
 *
 * 两趟是刻意的：标题里带路径的先占位，兜底的后补——否则一个猜出来的 `rtl/rtl.v`
 * 可能抢在真路径前面占掉位置，把有据可查的那条挤去改名。
 *
 * 按 artifact id 排序遍历，让同一份数据每次跑出同一套路径（脚本要可重跑）。
 */
function planPaths(artifacts: readonly ArtifactInfo[]): PathPlan[] {
  const sorted = [...artifacts].sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0));
  const taken = new Set<string>();
  const plans = new Map<string, PathPlan>();

  const claim = (info: ArtifactInfo, desired: string, source: "title" | "fallback"): void => {
    const collided = taken.has(desired);
    const path = collided ? disambiguate(desired, info.artifactId) : desired;
    taken.add(path);
    plans.set(info.artifactId, { ...info, path, source, collided });
  };

  for (const info of sorted) {
    const fromTitle = pathFromTitle(info.title);
    if (fromTitle && isValidWorkspacePath(fromTitle)) claim(info, fromTitle, "title");
  }
  for (const info of sorted) {
    if (plans.has(info.artifactId)) continue;
    claim(info, fallbackPath(info.artifactId, info.artifactType), "fallback");
  }
  return sorted.map((info) => plans.get(info.artifactId)!);
}

// ─── 数据 ────────────────────────────────────────────────────────────────────

interface RevisionRow {
  readonly id: string;
  readonly artifact_id: string;
  readonly project_id: string;
  readonly version: number;
  readonly content: string | null;
  readonly content_hash: string;
  readonly content_location: string;
  readonly created_by: string;
  readonly created_at: Date;
  readonly artifact_type: string;
  readonly title: string;
}

/**
 * 按**时间顺序**取全部修订。
 *
 * 不是按 `(artifact_id, version)`：那样 git 历史会变成「一个文件的所有版本，然后下一个
 * 文件的所有版本」，读起来跟项目实际发生过的事没关系。按 created_at 重放出来的
 * `git log` 就是这个项目的真实时间线。
 */
async function loadRevisions(db: Client, projectId: string): Promise<RevisionRow[]> {
  const { rows } = await db.query(
    `SELECT ar.id, ar.artifact_id, ar.project_id, ar.version, ar.content, ar.content_hash,
            ar.content_location, ar.created_by, ar.created_at,
            a.artifact_type::text AS artifact_type, a.title
       FROM artifact_revision ar
       JOIN artifact a ON a.id = ar.artifact_id
      WHERE ar.project_id = $1
      ORDER BY ar.created_at, ar.artifact_id, ar.version`,
    [projectId],
  );
  return rows as RevisionRow[];
}

/**
 * 同一个 artifact 的版本必须按 v1、v2、v3 的顺序出现在重放序列里。
 *
 * 时间顺序**通常**就是版本顺序，但那是数据的性质不是数据库的约束。真出现倒序时
 * 盘上会先留下 v3 再被 v1 覆盖，最终工作区停在一个不是最新版的状态——这种错误
 * 不会报错、只会悄悄错，所以宁可在这里停下来让人看一眼。
 */
function assertVersionOrder(rows: readonly RevisionRow[]): void {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const previous = seen.get(row.artifact_id) ?? 0;
    if (row.version <= previous) {
      throw new Error(
        `修订的时间顺序与版本顺序不一致：${row.artifact_id} 的 v${row.version}（${row.id}）` +
          `出现在 v${previous} 之后。请人工核对 created_at 后再迁移。`,
      );
    }
    seen.set(row.artifact_id, row.version);
  }
}

// ─── 迁移 ────────────────────────────────────────────────────────────────────

type SkipReason = "already_git" | "no_content" | "hash_mismatch";

const SKIP_TEXT: Readonly<Record<SkipReason, string>> = {
  already_git: "已在 git 里（上一次跑到过这条）",
  no_content: "content 为空，没有可重放的正文",
  hash_mismatch: "content 与 content_hash 对不上，迁移后会读成 500",
};

interface ProjectReport {
  readonly projectId: string;
  readonly migrated: number;
  readonly skipped: Map<SkipReason, string[]>;
  readonly plans: readonly PathPlan[];
  readonly verifyFailures: string[];
}

async function migrateProject(db: Client, projectId: string, apply: boolean): Promise<ProjectReport> {
  const rows = await loadRevisions(db, projectId);
  assertVersionOrder(rows);

  const artifacts = new Map<string, ArtifactInfo>();
  for (const row of rows) {
    if (!artifacts.has(row.artifact_id)) {
      artifacts.set(row.artifact_id, { artifactId: row.artifact_id, artifactType: row.artifact_type, title: row.title });
    }
  }
  const plans = planPaths([...artifacts.values()]);
  const pathByArtifact = new Map(plans.map((p) => [p.artifactId, p.path]));

  const skipped = new Map<SkipReason, string[]>();
  const skip = (reason: SkipReason, id: string): void => {
    const list = skipped.get(reason) ?? [];
    list.push(id);
    skipped.set(reason, list);
  };

  // 空项目也建工作区：项目页的文件树、编辑器写回都要求它存在，没有修订不代表不需要。
  if (apply) await ensureWorkspace(projectId);

  let migrated = 0;
  for (const row of rows) {
    if (parseGitLocation(row.content_location)) {
      skip("already_git", row.id);
      continue;
    }
    if (row.content === null) {
      skip("no_content", row.id);
      continue;
    }
    // 迁移前必须复核：`getRevisionContent` 读 `git://` 时会拿读出来的字节重算 sha256
    // 与 content_hash 比对，对不上直接 500。所以本来对不上的行必须原样留在 db://——
    // 它现在还能读，迁过去就读不了了。
    if (sha256Hex(row.content) !== row.content_hash) {
      skip("hash_mismatch", row.id);
      continue;
    }

    const path = pathByArtifact.get(row.artifact_id)!;
    if (!apply) {
      migrated += 1;
      console.log(`    [干跑] ${row.id}  v${row.version}  →  ${path}`);
      continue;
    }

    const message =
      `迁移历史修订：${path} v${row.version}\n\n` +
      `revision: ${row.id}\nartifact: ${row.artifact_id}\ncreated_at: ${row.created_at.toISOString()}\n`;

    // 让 commit 带上修订原本的时间，`git log` 才是这个项目的真实时间线而不是
    // 「迁移那一刻的 12 个 commit」。git.ts 的 gitRaw 会把 process.env 传给子进程；
    // 脚本是纯顺序执行的，改全局 env 在这里是安全的。
    const restore = { author: process.env.GIT_AUTHOR_DATE, committer: process.env.GIT_COMMITTER_DATE };
    process.env.GIT_AUTHOR_DATE = row.created_at.toISOString();
    process.env.GIT_COMMITTER_DATE = row.created_at.toISOString();
    let commit: string | null;
    try {
      const outcome = await writeAndCommit(projectId, [{ path, content: row.content }], message, gitAuthor(row.created_by));
      commit = outcome.commit;
    } finally {
      setOrDelete("GIT_AUTHOR_DATE", restore.author);
      setOrDelete("GIT_COMMITTER_DATE", restore.committer);
    }
    if (!commit) throw new Error(`${row.id}：提交后取不到 commit sha，工作区可能已损坏`);

    await db.query("UPDATE artifact_revision SET content_location = $1 WHERE id = $2", [
      formatGitLocation(commit, path),
      row.id,
    ]);
    migrated += 1;
    console.log(`    ${row.id}  v${row.version}  →  ${path}  @ ${commit.slice(0, 10)}`);
  }

  const verifyFailures = apply ? await verifyProject(db, projectId) : [];
  return { projectId, migrated, skipped, plans, verifyFailures };
}

/**
 * 回读复核：每条已指向 `git://` 的修订，都从 git 里取出来重算 sha256 与 content_hash 比。
 *
 * 这一步走的是 `getRevisionContent` 用的同一个 `readAtLocation` + `sha256Hex`，
 * 所以它证明的正是「网页现在打开这个文件能读到内容且不报 500」——比「UPDATE 影响了
 * 12 行」有意义得多。上次跑到一半留下的、这次被跳过的行也一并被验到。
 */
async function verifyProject(db: Client, projectId: string): Promise<string[]> {
  const { rows } = await db.query(
    "SELECT id, content_hash, content_location FROM artifact_revision WHERE project_id = $1 AND content_location LIKE 'git://%'",
    [projectId],
  );
  const failures: string[] = [];
  for (const row of rows as { id: string; content_hash: string; content_location: string }[]) {
    const content = await readAtLocation(projectId, row.content_location);
    if (content === null) {
      failures.push(`${row.id}：git 里取不到 ${row.content_location}`);
      continue;
    }
    const actual = sha256Hex(content);
    if (actual !== row.content_hash) {
      failures.push(`${row.id}：sha256 不符（库里 ${row.content_hash.slice(0, 12)}…，git 里 ${actual.slice(0, 12)}…）`);
    }
  }
  return failures;
}

/** git 的 ident 解析把 `<`、`>`、换行当分隔符，混进去 commit 会直接失败。 */
function gitAuthor(actorId: string): { name: string; email: string } {
  const name = actorId.replace(/[<>\n\r]/g, "").trim() || "unknown";
  return { name, email: `${name.replace(/[^A-Za-z0-9._-]/g, "-")}@synthia.local` };
}

function setOrDelete(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const projectFilter = argv.includes("--project") ? argv[argv.indexOf("--project") + 1] : undefined;
if (argv.includes("--project") && !projectFilter) {
  console.error("--project 后面要跟项目 id");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
// 打出连的是哪个库（不含口令）：这个脚本默认会写实库，看清楚再按回车。
const dbUrl = new URL(process.env.DATABASE_URL);
console.log(`数据库：${dbUrl.host}${dbUrl.pathname}`);
console.log(`工作区根目录：${workspacesRoot()}`);
console.log(apply ? "模式：写入（--apply）" : "模式：干跑（加 --apply 才真的写）");
console.log("");

const db = getClient();
await db.connect();
const reports: ProjectReport[] = [];
try {
  const { rows } = projectFilter
    ? await db.query("SELECT id FROM project WHERE id = $1", [projectFilter])
    : await db.query("SELECT id FROM project ORDER BY id");
  const projectIds = (rows as { id: string }[]).map((r) => r.id);
  if (projectIds.length === 0) {
    console.error(projectFilter ? `没有这个项目：${projectFilter}` : "库里一个项目都没有");
    process.exit(1);
  }

  for (const projectId of projectIds) {
    console.log(`▸ ${projectId}  →  ${projectWorkspaceDir(projectId)}`);
    reports.push(await migrateProject(db, projectId, apply));
    console.log("");
  }
} finally {
  await db.end();
}

// ─── 汇总 ────────────────────────────────────────────────────────────────────

console.log("─".repeat(72));
let failed = false;
for (const report of reports) {
  const total = report.migrated + [...report.skipped.values()].reduce((n, ids) => n + ids.length, 0);
  console.log(`${report.projectId}：${report.migrated}/${total} 条修订${apply ? "已迁移" : "待迁移"}`);
  for (const [reason, ids] of report.skipped) {
    console.log(`  跳过 ${ids.length} 条 — ${SKIP_TEXT[reason]}`);
    for (const id of ids) console.log(`    ${id}`);
    if (reason === "hash_mismatch") failed = true;
  }

  // 兜底路径是猜的，必须让人看见——这是计划里说的「打印清单供人工核对」。
  const guessed = report.plans.filter((p) => p.source === "fallback" || p.collided);
  if (guessed.length > 0) {
    console.log(`  以下 ${guessed.length} 个产物的路径是推断出来的，请人工核对：`);
    for (const plan of guessed) {
      const why = plan.collided ? "撞路径已改名" : "标题里没有路径";
      console.log(`    ${plan.path}  ←  ${plan.artifactId}  (${plan.artifactType}，${why}；标题「${plan.title}」)`);
    }
  }
  if (report.verifyFailures.length > 0) {
    failed = true;
    console.log(`  ✗ 回读复核失败 ${report.verifyFailures.length} 条：`);
    for (const line of report.verifyFailures) console.log(`    ${line}`);
  } else if (apply) {
    console.log("  ✓ 回读复核通过（git 里的字节与 content_hash 一致）");
  }
}

if (failed) {
  console.error("\n有未通过的项，见上面的 ✗ / hash_mismatch。");
  process.exit(1);
}
if (!apply) console.log("\n干跑结束，什么都没改。确认无误后加 --apply。");
