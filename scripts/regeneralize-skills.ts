/**
 * One-off maintenance: rewrite existing learned skills into the generalized
 * problem-family register (name/summary/applicability phrased by symptom and
 * method, not by the originating project) and mint the new versions through
 * Core's human-controlled regeneralize endpoint (same scanner + CAS as the
 * distiller patch path).
 *
 * Env:
 *   SYNTHIA_CORE_URL   Core base URL (default http://127.0.0.1:5130)
 *   ADMIN_TOKEN        core:admin human token
 *   SYNTHIA_MODEL_*    model env, same contract as run-evolution-workers.ts
 *
 * Usage:
 *   bun run scripts/regeneralize-skills.ts [--slug <slug> ...]   # default: all skills
 */
import { createRuntimeModelFromEnv } from "../runtime/pi-responses-model.ts";
import { EvolutionModelAdapter } from "../runtime/evolution-model-adapter.ts";
import { EVOLUTION_MODEL_OUTPUT_MAX_BYTES } from "../runtime/evolution-workers.ts";

const coreUrl = process.env.SYNTHIA_CORE_URL ?? "http://127.0.0.1:5130";
const adminToken = required("ADMIN_TOKEN");
const slugFilters = parseSlugFilters(process.argv.slice(2));
const model = new EvolutionModelAdapter(
  createRuntimeModelFromEnv(),
  process.env.SYNTHIA_MODEL_NAME ?? "glm-5.3",
);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseSlugFilters(args: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--slug" && args[i + 1] !== undefined) out.push(args[i + 1]!);
  }
  return out;
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${coreUrl}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as Record<string, unknown> | undefined;
    throw new Error(`HTTP ${response.status}: ${error?.code ?? path} ${error?.message ?? ""}`.trim());
  }
  return payload.data;
}

const SYSTEM_PROMPT = [
  "You rewrite learned skills into a reusable, problem-family register.",
  "Return exactly one JSON object and no markdown or commentary.",
  "Rules:",
  "- applicability must describe WHEN to apply the method by signal, structure, and tool symptoms — never by project name, task id, or one instance's specifics.",
  "- name/summary describe the method + problem family; drop project-bound qualifiers.",
  "- Keep the technical substance of files byte-for-byte where it is already general; only generalize wording that hardcodes the originating instance.",
  "- files keep exactly the same paths, kinds, and languages; exactly one root SKILL.md stays.",
  "Output shape: {name, summary, description, applicability, outcome_contract, files:[{path,kind,language,content}]}.",
].join("\n");

interface VersionFile {
  readonly path: string;
  readonly kind: string;
  readonly language: string | null;
  readonly content: string;
}

async function regeneralize(skill: {
  readonly skill_id: string;
  readonly slug: string;
  readonly active_version_id: string | null;
  readonly control_revision: number;
}): Promise<string> {
  if (skill.active_version_id === null) return "skip: no active version";
  const detail = await api(`/learned-skills/${skill.skill_id}/versions/${skill.active_version_id}`) as {
    skill: Record<string, unknown>;
    version: { description: unknown; applicability: unknown; outcome_contract: unknown; files: VersionFile[] };
  };
  const current = {
    name: detail.skill.name,
    summary: detail.skill.summary,
    description: detail.version.description,
    applicability: detail.version.applicability,
    outcome_contract: detail.version.outcome_contract,
    files: detail.version.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      language: file.language,
      content: file.content,
    })),
  };
  const rewritten = await model.generateJson({
    purpose: "distillation",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: JSON.stringify(current),
    maxOutputBytes: EVOLUTION_MODEL_OUTPUT_MAX_BYTES,
  }) as Record<string, unknown>;
  const result = await api(`/learned-skills/${skill.skill_id}/regeneralize`, {
    method: "POST",
    body: JSON.stringify({
      name: rewritten.name,
      summary: rewritten.summary,
      description: rewritten.description,
      applicability: rewritten.applicability,
      outcome_contract: rewritten.outcome_contract,
      files: rewritten.files,
      expected_active_version_id: skill.active_version_id,
      expected_control_revision: skill.control_revision,
    }),
  }) as Record<string, unknown>;
  return `${result.state} v${result.version_no}`;
}

const list = await api("/learned-skills?limit=100") as Record<string, unknown>;
const skills = (list.items as Array<Record<string, unknown>>)
  .map((item) => ({
    skill_id: String(item.skill_id),
    slug: String(item.slug),
    active_version_id: item.active_version_id === null ? null : String(item.active_version_id),
    control_revision: Number(item.control_revision),
  }))
  .filter((skill) => slugFilters.length === 0 || slugFilters.includes(skill.slug));

let done = 0;
for (const skill of skills) {
  process.stdout.write(`[regeneralize] ${skill.slug} ... `);
  try {
    const outcome = await regeneralize(skill);
    process.stdout.write(`${outcome}\n`);
    done += 1;
  } catch (error) {
    process.stdout.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
process.stdout.write(`[regeneralize] ${done}/${skills.length} done\n`);
