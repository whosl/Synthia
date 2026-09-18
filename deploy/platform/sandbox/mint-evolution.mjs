/**
 * 沙箱侧：为 self-evolution 的四个服务身份铸造 Bearer token（直插 auth_token，
 * 幂等——已存在未吊销的 token 则只打印提示，不重发、不吊销其它身份的 token，
 * 区别于 bootstrap-self-evolution-gate.ts 的全量重发语义）。
 *
 *   node mint-evolution.mjs     # 在 pg-bootstrap 目录下运行（依赖 pg 包）
 *
 * 输出 SYNTHIA_EVOLUTION_*_TOKEN=plaintext 各一行（只此一次，落 env.real）。
 */
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pg = require(require.resolve("pg", { paths: [join(scriptDir, "pg-bootstrap"), scriptDir] }));

const IDENTITIES = [
  { uid: "synthia-evolution-distiller", scopes: ["core:evolution-distiller"], envVar: "SYNTHIA_EVOLUTION_DISTILLER_TOKEN" },
  { uid: "synthia-evolution-curator", scopes: ["core:evolution-curator"], envVar: "SYNTHIA_EVOLUTION_CURATOR_TOKEN" },
  { uid: "synthia-evolution-scheduler", scopes: ["core:evolution-scheduler"], envVar: "SYNTHIA_EVOLUTION_SCHEDULER_TOKEN" },
  { uid: "synthia-evolution-evaluator", scopes: ["core:evolution-eval"], envVar: "SYNTHIA_EVOLUTION_EVALUATOR_TOKEN" },
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgres://synthia@127.0.0.1:5432/synthia" });
await client.connect();
try {
  for (const identity of IDENTITIES) {
    const user = await client.query("SELECT id, status FROM user_account WHERE uid = $1", [identity.uid]);
    if (user.rowCount === 0) {
      console.error(`FAIL: identity ${identity.uid} 不存在（库恢复不完整？）`);
      process.exit(1);
    }
    const active = await client.query(
      "SELECT count(*)::int AS n FROM auth_token WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
      [user.rows[0].id],
    );
    if (active.rows[0].n > 0) {
      console.log(`# ${identity.uid} 已有 ${active.rows[0].n} 个有效 token，跳过（如需重发先吊销旧 token）`);
      continue;
    }
    const plaintext = `syn_${randomBytes(24).toString("hex")}`;
    const tokenHash = createHash("sha256").update(plaintext, "utf8").digest("hex");
    await client.query(
      "INSERT INTO auth_token (token_hash, user_id, scope) VALUES ($1, $2, $3)",
      [tokenHash, user.rows[0].id, identity.scopes],
    );
    console.log(`${identity.envVar}=${plaintext}`);
  }
  console.log("mint-done");
} finally {
  await client.end();
}
