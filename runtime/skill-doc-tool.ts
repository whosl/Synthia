/**
 * Synthia Runtime — `read_skill_doc`: on-demand access to the frozen skill pack.
 *
 * The operating manual and the rule documents are small enough to sit in the
 * system prompt permanently (`agent-doc.ts`). The rest of `skills/fpga/` is not:
 * ten `SKILL.md` method documents plus templates, references and checklists come
 * to roughly 240 KB, and the model needs maybe two of them per turn. Before this
 * tool existed the only path from that corpus to the model was a handful of
 * hand-distilled constants in `skill-tools.ts` — so the templates that define the
 * expected file layout and naming were, in practice, unreachable.
 *
 * The tool is read-only and confined to the skills root:
 * - the requested path is resolved against the root and rejected if it escapes
 *   it (`..`, absolute paths), and re-checked after `realpath` so a symlink
 *   cannot be used to step outside either;
 * - directories return a listing, files return content;
 * - content is capped ({@link MAX_BYTES}) with an explicit truncation marker —
 *   a silently clipped template is worse than a visibly clipped one, because the
 *   model would treat the missing tail as "not required".
 *
 * A miss returns the containing directory's listing rather than a bare "not
 * found": the useful next action after a wrong guess is always "what is actually
 * here?", and making the model burn a second call to ask that is pure waste.
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, dirname } from "node:path";
import type { AgentTool, AgentToolResult } from "./agent-types.ts";
import { DEFAULT_SKILLS_ROOT } from "./agent-doc.ts";

/** Content cap. The largest committed doc is ~47 KB (`data/board-catalog.json`). */
const MAX_BYTES = 60_000;

/** Directory listings are capped too, so a stray large directory can't flood the context. */
const MAX_ENTRIES = 200;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(reason: string, extra: Record<string, unknown> = {}): AgentToolResult {
  return { content: JSON.stringify({ error: "read_skill_doc_failed", reason, ...extra }), isError: true };
}

/**
 * Normalize a model-supplied path to a root-relative one, or null if it escapes.
 *
 * Tolerates the two shapes a model most plausibly produces — a leading `./` and
 * a leading `/` (meaning "root of the skills tree", not the filesystem root) —
 * and rejects everything that resolves outside the root.
 */
function toRelative(rootAbs: string, raw: string): string | null {
  const cleaned = raw.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  if (cleaned.includes("\0")) return null;
  const targetAbs = resolve(rootAbs, cleaned);
  const rel = relative(rootAbs, targetAbs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel; // "" means the root itself
}

/** Post-`realpath` containment check: catches a symlink pointing out of the tree. */
async function staysInside(rootAbs: string, targetAbs: string): Promise<boolean> {
  try {
    const realRoot = await realpath(rootAbs);
    const realTarget = await realpath(targetAbs);
    const rel = relative(realRoot, realTarget);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false; // cannot verify → do not read
  }
}

async function listDir(rootAbs: string, rel: string): Promise<AgentToolResult> {
  const dirAbs = join(rootAbs, rel);
  let names: string[];
  try {
    const entries = await readdir(dirAbs, { withFileTypes: true });
    names = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), { path: rel || "." });
  }
  const truncated = names.length > MAX_ENTRIES;
  return {
    content: JSON.stringify({
      path: rel || ".",
      kind: "directory",
      entries: truncated ? names.slice(0, MAX_ENTRIES) : names,
      ...(truncated ? { truncatedEntries: names.length - MAX_ENTRIES } : {}),
      note: "以 `目录名/` 结尾的是子目录，可继续用 read_skill_doc 展开；其余是可直接读取的文件。",
    }),
  };
}

export interface SkillDocToolOptions {
  /** Skills root (default `skills/fpga`, cwd-relative — same as skill-loader.ts). */
  readonly skillsRoot?: string;
}

/**
 * Build the `read_skill_doc` tool. Read-only, confined to the skills root, and
 * independent of session state — it works in any free-agent session and needs
 * no governance or connector access.
 */
export function assembleSkillDocTool(opts: SkillDocToolOptions = {}): AgentTool {
  const skillsRoot = opts.skillsRoot ?? DEFAULT_SKILLS_ROOT;

  return {
    name: "read_skill_doc",
    description:
      "读取技能包（skills/fpga）里的手册、模板与参考文档，路径相对技能包根目录。" +
      "省略 path 或传目录名返回该目录的条目清单（如 `skills/` 列出 10 个技能，" +
      "`skills/fpga-rtl-build/` 列出它的 SKILL.md / templates/ / references/）；" +
      "传文件路径返回正文（如 `skills/fpga-rtl-build/SKILL.md`、" +
      "`skills/fpga-tb-write/templates/tb_top.v`）。" +
      "写 RTL、TB、约束、寄存器表之前先读对应技能的 SKILL.md 与 templates/：" +
      "文件结构与命名在那里已经定好，另起一套会让下游技能读不懂产出。" +
      "只读，不能写；路径找不到时会返回同级目录清单。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "技能包根目录下的相对路径，如 `skills/fpga-rtl-build/SKILL.md` 或 `skills/`。省略则列出根目录。",
        },
      },
      required: [],
    },

    async execute(args: unknown): Promise<AgentToolResult> {
      const argObj = isPlainObject(args) ? args : {};
      const rawPath = typeof argObj.path === "string" ? argObj.path : "";

      const rootAbs = resolve(skillsRoot);
      const rel = toRelative(rootAbs, rawPath);
      if (rel === null) {
        return fail("路径越界：只能读取技能包根目录（skills/fpga）以内的文件", { path: rawPath });
      }

      const targetAbs = join(rootAbs, rel);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(targetAbs);
      } catch {
        // Miss → show what is actually in the containing directory.
        const parent = rel.includes("/") ? dirname(rel) : "";
        const listing = await listDir(rootAbs, parent);
        return {
          content: JSON.stringify({
            error: "not_found",
            path: rel,
            reason: `技能包内不存在 ${rel || "."}`,
            siblings: listing.isError ? null : (JSON.parse(listing.content) as { entries: string[] }).entries,
          }),
          isError: true,
        };
      }

      if (!(await staysInside(rootAbs, targetAbs))) {
        return fail("路径越界：目标解析后落在技能包根目录之外", { path: rel });
      }

      if (info.isDirectory()) return listDir(rootAbs, rel);

      let text: string;
      try {
        text = await readFile(targetAbs, "utf8");
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e), { path: rel });
      }

      // Byte-based cap, sliced on characters: the exact boundary does not matter
      // as long as the truncation is announced.
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > MAX_BYTES) {
        const keep = text.slice(0, MAX_BYTES);
        return {
          content: JSON.stringify({
            path: rel,
            kind: "file",
            truncated: true,
            bytes,
            content: keep,
            note: `文件超过 ${MAX_BYTES} 字节，以上为前半部分，其余已截断——不要把截断处当成文档结尾。`,
          }),
        };
      }

      return { content: JSON.stringify({ path: rel, kind: "file", bytes, content: text }) };
    },
  };
}
