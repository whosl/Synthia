/**
 * Synthia Core — 已批准修订的正文冻结（git → DB 归档副本）
 *
 * 分工是「内容归 git，治理归 PG」，但 git 的历史**可被改写**（rebase、force push、
 * 甚至有人手动删 .git）。候选修订丢了可以重出，已批准并进了基线的那一版不行——它是
 * 评审签署时看到的字节，GJB 语境下必须能原样复现。所以基线一旦建立，就把该版正文
 * 从 git 读出来固化进 `artifact_revision.content`，作为不可篡改的归档冗余。
 *
 * 这是本模块**唯一**同时碰 DB 与 git 的地方（`store.ts` 刻意 DB-free），放在事务
 * 之外执行：文件 IO 不该拉长审批事务，且失败只记日志不回滚——归档是冗余，git 仍是
 * 权威，`getRevisionContent` 依旧读得到内容。
 */

import type { Pool } from "pg";
import { sha256Hex } from "../hashing.ts";
import { parseGitLocation } from "./paths.ts";
import { readAtLocationBytes } from "./store.ts";

interface RevisionRow {
  readonly id: string;
  readonly content_location: string;
  readonly content_hash: string;
  readonly content_encoding: "utf8" | "base64";
}

export interface FreezeOutcome {
  /** 本次真正回填了正文的修订 id。 */
  readonly frozen: readonly string[];
  /** 内容本来就不在 git 里（老的 `db://`/`mem://` 修订）——没得归档，属正常。 */
  readonly notInGit: readonly string[];
  /** 声称在 git 里却读不到、或读到的字节 hash 对不上——**这才值得告警**。 */
  readonly failed: readonly string[];
}

/**
 * 把某条基线的成员修订中「正文还只在 git 里」的那些冻回 DB。
 *
 * 幂等：已有 content 的行不会被覆盖（`WHERE content IS NULL` 兜住并发重入）。
 * hash 对不上的一律**不写**——归档一份错的比没有归档更坏。
 */
export async function freezeBaselineContent(pool: Pool, baselineId: string): Promise<FreezeOutcome> {
  const baseline = await pool.query(
    "SELECT project_id, member_revision_ids FROM baseline WHERE id = $1",
    [baselineId],
  );
  const row = baseline.rows[0] as { project_id: string; member_revision_ids: string[] } | undefined;
  if (!row || row.member_revision_ids.length === 0) return { frozen: [], notInGit: [], failed: [] };

  const pending = await pool.query(
    `SELECT id, content_location, content_hash,content_encoding FROM artifact_revision
      WHERE id = ANY($1::text[]) AND project_id = $2 AND content IS NULL`,
    [row.member_revision_ids, row.project_id],
  );

  const frozen: string[] = [];
  const notInGit: string[] = [];
  const failed: string[] = [];
  for (const rev of pending.rows as RevisionRow[]) {
    if (!parseGitLocation(rev.content_location)) {
      notInGit.push(rev.id);
      continue;
    }
    const bytes = await readAtLocationBytes(row.project_id, rev.content_location);
    if (bytes === null || sha256Hex(bytes) !== rev.content_hash) {
      failed.push(rev.id);
      continue;
    }
    let content: string;
    let encoding: "utf8" | "base64";
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      encoding = "utf8";
    } catch {
      content = Buffer.from(bytes).toString("base64");
      encoding = "base64";
    }
    if (encoding !== rev.content_encoding) {
      failed.push(rev.id);
      continue;
    }
    await pool.query(
      "UPDATE artifact_revision SET content = $1,content_encoding=$2 WHERE id = $3 AND content IS NULL",
      [content, encoding, rev.id],
    );
    frozen.push(rev.id);
  }
  return { frozen, notInGit, failed };
}
