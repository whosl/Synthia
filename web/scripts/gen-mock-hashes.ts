/**
 * 生成 src/mock/content-hashes.ts：对 mock 产物内容真算 SHA-256。
 *
 * mock 数据里 `ArtifactRevision.content_hash` 必须是内容的真实摘要（Core 就是这么
 * 存的），随手编一串十六进制会让「摘要」这个字段在页面上变成假的。这个脚本把
 * 四份手写文档（src/mock/docs.ts）和两版真机 RTL（vivado-fixture.ts）过一遍
 * SHA-256 后落盘，data.ts 直接 import 结果。
 *
 * 用法：`bun run scripts/gen-mock-hashes.ts`（改了文档正文就重跑一次）。
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DOC_INTAKE, DOC_BEHAVIOR, DOC_ARCH, DOC_REG } from "../src/mock/docs.ts";
import { VIVADO_FIXTURE } from "../src/mock/vivado-fixture.ts";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const hashes: Record<string, string> = {
  intake: sha256(DOC_INTAKE),
  behavior_wave: sha256(DOC_BEHAVIOR),
  architecture: sha256(DOC_ARCH),
  register_spec: sha256(DOC_REG),
  rtl_v1: sha256(VIVADO_FIXTURE.sources["pwm_gen.v@v1"]),
  rtl_v2: sha256(VIVADO_FIXTURE.sources["pwm_gen.v"]),
};

const out = `/**
 * mock 产物内容的真实 SHA-256（**自动生成**，由 scripts/gen-mock-hashes.ts 落盘）。
 * 改了 src/mock/docs.ts 的正文就重跑一次生成脚本，不要手改这里的值。
 */

export const CONTENT_SHA: Readonly<Record<string, string>> = ${JSON.stringify(hashes, null, 2)};
`;

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../src/mock/content-hashes.ts");
writeFileSync(target, out);
console.log(`written ${target}`);
for (const [k, v] of Object.entries(hashes)) console.log(`  ${k} ${v}`);
