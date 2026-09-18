/**
 * 沙箱侧 Step 2：把本机 pg_dump（--inserts 纯 SQL 格式）整文件恢复进 synthia 库。
 * 嵌入式 PG 包不带 psql/pg_restore（bin 只有 initdb/pg_ctl/postgres），
 * 因此用 node:pg 的 simple-query 协议一次执行整个 dump。
 *
 *   node restore.mjs /upload/synthia.dump
 *
 * `pg` 只装在 ./pg-bootstrap/node_modules（10-setup-pg.sh 的安装目录），不在
 * 本脚本所在目录的解析链上——createRequire 按**脚本文件路径**向上解析，与
 * cwd 无关，必须显式给定 pg-bootstrap 的解析路径。
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pg = require(require.resolve("pg", { paths: [join(scriptDir, "pg-bootstrap"), scriptDir] }));

const dumpPath = process.argv[2];
if (typeof dumpPath !== "string" || !dumpPath) {
  console.error("usage: node restore.mjs <synthia.dump>");
  process.exit(2);
}
// pg_dump ≥16.10/17.6 默认在首尾注入 \restrict/\unrestrict psql 元命令；
// simple-query 协议不认反斜杠命令（SQLSTATE 42601），剔除这两行再整体执行。
// 只精确匹配这两种元命令——将来若换 COPY 格式 dump，数据块里的 "\." 不受影响。
const sql = (await readFile(dumpPath, "utf8")).replace(/^\\(?:un)?restrict [^\n]*$/gm, "");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgres://synthia@127.0.0.1:5432/synthia" });
await client.connect();
try {
  await client.query(sql);
  // dump 首部有 set_config('search_path', '', false)（会话级清空），
  // 计数必须用 schema 限定名，否则 42P01。
  const counts = await client.query(`
    SELECT
      (SELECT count(*) FROM public.project) AS projects,
      (SELECT count(*) FROM public.agent_task) AS tasks,
      (SELECT count(*) FROM public.auth_token) AS auth_tokens,
      (SELECT count(*) FROM public.artifact) AS artifacts`);
  console.log("restore-ok " + JSON.stringify(counts.rows[0]));
} finally {
  await client.end();
}
