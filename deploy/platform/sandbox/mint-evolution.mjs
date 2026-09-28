/**
 * 沙箱侧：为 self-evolution 的四个服务身份铸造 Bearer token 并**直接写入
 * env.real**——token 明文只在沙箱文件系统内流转，不经过任何对话/报告通道。
 *
 *   node mint-evolution.mjs     # 在 pg-bootstrap 目录下运行（依赖 pg 包）
 *
 * 幂等：env.real 已有该变量的非空行则完全跳过（不重发、不吊销）。
 * 输出只有变量名与状态，没有明文。
 */
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pg = require(require.resolve("pg", { paths: [scriptDir, join(scriptDir, "pg-bootstrap")] }));

// env.real 位置探测：tar 平铺解包时脚本在部署根（scriptDir/env.real）；
// 嵌套布局时在上级（scriptDir/../env.real）；从子目录运行时以 cwd 兜底。
// import.meta.url 锚定的是脚本文件位置而非 cwd——三种候选依次探测。
const ENV_REAL = await (async () => {
  const { access } = await import("node:fs/promises");
  const candidates = [join(scriptDir, "env.real"), join(scriptDir, "..", "env.real"), join(process.cwd(), "env.real")];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  console.error(`FAIL: env.real 不存在于任何候选路径（已探测：${candidates.join("、")}）`);
  process.exit(1);
})();
const IDENTITIES = [
  { uid: "synthia-evolution-distiller", scopes: ["core:evolution-distiller"], envVar: "SYNTHIA_EVOLUTION_DISTILLER_TOKEN" },
  { uid: "synthia-evolution-curator", scopes: ["core:evolution-curator"], envVar: "SYNTHIA_EVOLUTION_CURATOR_TOKEN" },
  { uid: "synthia-evolution-scheduler", scopes: ["core:evolution-scheduler"], envVar: "SYNTHIA_EVOLUTION_SCHEDULER_TOKEN" },
  { uid: "synthia-evolution-evaluator", scopes: ["core:evolution-eval"], envVar: "SYNTHIA_EVOLUTION_EVALUATOR_TOKEN" },
];

let existing = "";
try { existing = await readFile(ENV_REAL, "utf8"); } catch {
  console.error("FAIL: env.real 不存在于部署根（先上传/创建再运行）");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgres://synthia@127.0.0.1:5432/synthia" });
await client.connect();
const appended = [];
try {
  for (const identity of IDENTITIES) {
    if (new RegExp(`^${identity.envVar}=\\S`, "m").test(existing)) {
      console.log(`skip ${identity.envVar}（env.real 已有值）`);
      continue;
    }
    const user = await client.query("SELECT id FROM user_account WHERE uid = $1", [identity.uid]);
    if (user.rowCount === 0) {
      console.error(`FAIL: identity ${identity.uid} 不存在（库恢复不完整？）`);
      process.exit(1);
    }
    const plaintext = `syn_${randomBytes(24).toString("hex")}`;
    const tokenHash = createHash("sha256").update(plaintext, "utf8").digest("hex");
    await client.query(
      "INSERT INTO auth_token (token_hash, user_id, scope) VALUES ($1, $2, $3)",
      [tokenHash, user.rows[0].id, identity.scopes],
    );
    appended.push(`${identity.envVar}=${plaintext}`);
    console.log(`minted ${identity.envVar} -> 写入 env.real`);
  }
  if (appended.length > 0) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(ENV_REAL, `\n# ── evolution tokens（mint-evolution.mjs 自动生成，勿入对话/报告）──\n${appended.join("\n")}\n`, "utf8");
  }
  console.log(`mint-done（新发 ${appended.length}/4，其余已在 env.real）`);
} finally {
  await client.end();
}
