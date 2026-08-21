/**
 * Synthia Runtime — static agent documentation for the free-agent system prompt.
 *
 * The free agent used to receive exactly one system message: the auto-generated
 * project **status** snapshot (`context-snapshot.ts`). That tells the model
 * *where the project is* and nothing about *who it is or how to work here* —
 * no role, no permission boundary, no gate protocol, no reply convention.
 * Meanwhile `skills/fpga/rules/*.md` held eight prompt-ready rule documents that
 * no code path ever read.
 *
 * {@link buildAgentDoc} closes that gap: it concatenates the operating manual
 * (`skills/fpga/AGENT.md`) with every rule document, in filename order (the
 * `00-`/`10-`/`20-` prefixes are the intended reading order), into one static
 * block. `server.ts` puts it **before** the status snapshot so the system
 * message is static-prefix-then-dynamic-tail — the shape prompt caching wants.
 *
 * Fault tolerance mirrors `buildContextSnapshot`'s discipline: **never throws**.
 * A missing AGENT.md, an unreadable rules directory, or a rule file that
 * disappeared mid-run all degrade to less guidance, never to a dead session —
 * an agent with a partial manual is strictly better than no agent at all.
 * Failures are reported through {@link AgentDocResult.problems} so the caller
 * can log them; they are deliberately **not** rendered into the prompt (the
 * model can do nothing about a filesystem error, and a scary banner in the
 * system message would just skew its behaviour).
 *
 * The corpus is committed, frozen, and identical for every session, so it is
 * read once per root and cached for the process lifetime.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Default skills root, cwd-relative — same convention as skill-loader.ts / skill-tools.ts. */
export const DEFAULT_SKILLS_ROOT = "skills/fpga";

/** Operating manual filename inside the skills root. */
const MANUAL_FILE = "AGENT.md";

/** Rules subdirectory inside the skills root. */
const RULES_DIR = "rules";

export interface AgentDocResult {
  /** The assembled document; empty string when nothing could be read at all. */
  readonly text: string;
  /** Manual + rule files actually included, in prompt order. */
  readonly sources: readonly string[];
  /** Human-readable read failures, for logging. Empty when everything loaded. */
  readonly problems: readonly string[];
}

export interface BuildAgentDocOptions {
  /** Skills root (default {@link DEFAULT_SKILLS_ROOT}). Tests point this at a fixture. */
  readonly skillsRoot?: string;
  /** Bypass the process-lifetime cache (tests that rewrite fixture files). */
  readonly noCache?: boolean;
  /** Free projects deliberately do not receive the GJB operating manual. */
  readonly mode?: "free" | "engineering";
}

/** Short guidance for a free project. It describes the collaboration role
 * without importing milestone, review, or GJB-specific rules. */
export const FREE_AGENT_GUIDANCE = `# Synthia 自由编码助手

你在一个自由 FPGA/Coding 项目中工作。这里没有固定的 GJB 阶段、门禁或里程碑；按用户当前任务处理代码、排错、试验、文档和工具运行。先理解用户目标，修改文件时说明将影响哪些路径；遇到未登记的人手改动或覆盖风险就停下并询问。不要臆造硬件事实，缺少器件、板卡或约束时明确标注。输出应说明做了什么、验证了什么、还缺什么。`;

/** Cache keyed by skills root: the corpus is frozen, so one read per root is enough. */
const cache = new Map<string, Promise<AgentDocResult>>();

/** Clear the cache — for tests that mutate fixtures between assertions. */
export function clearAgentDocCache(): void {
  cache.clear();
}

async function readIfPossible(path: string, problems: string[]): Promise<string | null> {
  try {
    const text = await readFile(path, "utf8");
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (e) {
    problems.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Rule filenames in prompt order.
 *
 * Sorted as plain strings, which is exactly right for the `NN-name.md`
 * convention (`00-` < `10-` < `25-` < `60-`); a numeric sort would be no
 * different and would add a parsing failure mode for any file that ever
 * lands here without a numeric prefix. Non-`.md` entries are skipped.
 */
async function listRuleFiles(rulesDir: string, problems: string[]): Promise<string[]> {
  try {
    const entries = await readdir(rulesDir);
    return entries.filter((n) => n.endsWith(".md")).sort();
  } catch (e) {
    problems.push(`${rulesDir}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

async function assemble(skillsRoot: string): Promise<AgentDocResult> {
  const problems: string[] = [];
  const sources: string[] = [];
  const blocks: string[] = [];

  const manualPath = join(skillsRoot, MANUAL_FILE);
  const manual = await readIfPossible(manualPath, problems);
  if (manual !== null) {
    sources.push(manualPath);
    blocks.push(manual);
  }

  const rulesDir = join(skillsRoot, RULES_DIR);
  const ruleNames = await listRuleFiles(rulesDir, problems);
  for (const name of ruleNames) {
    const path = join(rulesDir, name);
    const body = await readIfPossible(path, problems);
    if (body === null) continue; // unreadable or empty: skip this rule, keep the rest
    sources.push(path);
    blocks.push(body);
  }

  // `---` between documents: each one already opens with an `#` heading, and the
  // rule bodies contain `##` sections that would otherwise read as continuations
  // of the previous document.
  const text = blocks.length > 0 ? `${blocks.join("\n\n---\n\n")}\n` : "";
  return { text, sources, problems };
}

/**
 * Read and assemble the static agent documentation. Never throws; a partial or
 * even empty result is returned instead, with the causes in `problems`.
 */
export function buildAgentDoc(opts: BuildAgentDocOptions = {}): Promise<AgentDocResult> {
  if (opts.mode === "free") {
    return Promise.resolve({ text: `${FREE_AGENT_GUIDANCE}\n`, sources: [], problems: [] });
  }
  const skillsRoot = opts.skillsRoot ?? DEFAULT_SKILLS_ROOT;
  if (opts.noCache === true) return assemble(skillsRoot);

  const hit = cache.get(skillsRoot);
  if (hit) return hit;
  // Cache the promise, not the result: concurrent session creation is the normal
  // case here, and this collapses it to a single read.
  const pending = assemble(skillsRoot);
  cache.set(skillsRoot, pending);
  return pending;
}

/**
 * Compose the free agent's full system prompt: static manual + rules first,
 * live project status last.
 *
 * Order is load-bearing in two ways. The static half is byte-identical across
 * every session and every turn, so putting it first lets the provider's prompt
 * cache hit on it while the snapshot tail changes freely. And the manual tells
 * the model how to *read* the snapshot (`AGENT.md` §5) — that only works if the
 * manual comes first.
 */
export function composeSystemPrompt(agentDoc: string, contextSnapshot: string): string {
  const doc = agentDoc.trim();
  const snapshot = contextSnapshot.trim();
  if (!doc) return `${snapshot}\n`;
  if (!snapshot) return `${doc}\n`;
  return `${doc}\n\n---\n\n${snapshot}\n`;
}
