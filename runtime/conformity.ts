/**
 * Synthia Runtime — reusable content-conformity gate (spec 001-agent-freedom).
 *
 * Extracts the static topic / name / port consistency checks that the pipeline
 * loop (`loop.ts#checkContentConformity`) runs before G3/G4 submission into a
 * reusable, pure module so the free-agent gate tool can enforce the same gate
 * on the artifact set it is about to submit. The loop keeps its own private
 * method (its semantics and 166-test contract are untouched); both share the
 * exported `extractTopicKeywords` / `extractModulePorts` helpers.
 *
 * The free-agent operates on Core-registered artifacts (content blobs typed by
 * `ArtifactType`), not the loop's structured `RtlGeneration`/`DocGeneration`.
 * Artifact selection maps the loop's phase keys to ArtifactType:
 *   architecture  → ARCHITECTURE_DESIGN
 *   register_spec → DETAILED_DESIGN
 *   rtl           → RTL_SOURCE_SET
 * The RTL top-module name is derived from the artifact's content-location
 * filename (`rtl/<module>.v` → `<module>`) with a content-parse fallback, since
 * the free-agent does not carry a separate `topModule` field.
 *
 * Topic keywords are derived from the authoritative requirements artifacts
 * (DEVELOPMENT_REQUIREMENTS / SYSTEM_REQUIREMENTS) supplied by the caller; when
 * no Latin keyword can be derived, the topic check is skipped (leniency over a
 * false alarm — mirrors the loop's CJK-only behaviour).
 */

import type { ArtifactType, GjbGate } from "./types.ts";
import { extractTopicKeywords, extractModulePorts } from "./loop.ts";

/** An artifact checked by the conformity gate. */
export interface ConformityArtifact {
  readonly artifactType: ArtifactType;
  readonly content: string;
  readonly contentLocation: string;
  readonly title: string;
}

/** Result of a content-conformity check. */
export interface ConformityResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/** Artifact types treated as authoritative requirements sources for keywords. */
const REQUIREMENTS_TYPES: Readonly<Record<string, true>> = {
  DEVELOPMENT_REQUIREMENTS: true,
  SYSTEM_REQUIREMENTS: true,
};

/** Artifact types treated as design docs (G3 topic / G4 name+port targets). */
const DESIGN_DOC_TYPES: Readonly<Record<string, true>> = {
  ARCHITECTURE_DESIGN: true,
  DETAILED_DESIGN: true,
};

/** Strip the path + extension from a content location → module name guess. */
function moduleNameFromLocation(location: string): string {
  const base = location.split("/").pop() ?? location;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.trim();
}

/**
 * Best-effort extraction of the top-level module name from RTL content.
 * Prefers a module whose name matches the location-derived guess; otherwise
 * takes the last `module <name>` declaration. Returns "" when none is found.
 */
export function extractTopModule(content: string, contentLocation: string): string {
  const guess = moduleNameFromLocation(contentLocation).toLowerCase();
  const re = /\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)/g;
  let m: RegExpExecArray | null;
  let last = "";
  while ((m = re.exec(content)) !== null) {
    const name = m[1]!;
    if (name.toLowerCase() === guess) return name;
    last = name;
  }
  return last;
}

/**
 * Run the static content-conformity checks for a gate submission.
 *
 * - G3: every design doc (architecture / detailed-design) must mention ≥1 task
 *   keyword derived from the requirements sources.
 * - G4: RTL source must mention ≥1 task keyword; its top-module name must appear
 *   in the architecture + detailed-design docs; its top ports must appear in the
 *   architecture interface doc.
 *
 * Returns `{ ok: true }` when no problems are found, or the problem list.
 */
export function checkGateConformity(
  gate: GjbGate,
  artifacts: readonly ConformityArtifact[],
  keywordSources: readonly string[],
): ConformityResult {
  if (gate !== "G3" && gate !== "G4") return { ok: true, problems: [] };

  const keywords = extractTopicKeywords(...keywordSources);
  const designDocs = artifacts.filter((a) => DESIGN_DOC_TYPES[a.artifactType] === true);
  const rtl = artifacts.filter((a) => a.artifactType === "RTL_SOURCE_SET");
  const problems: string[] = [];

  if (gate === "G3") {
    for (const d of designDocs) {
      if (keywords.length > 0 && !keywords.some((k) => d.content.toLowerCase().includes(k))) {
        problems.push(
          `topic: 设计文档 "${d.contentLocation}" 未提及任何任务关键词 [${keywords.join(", ")}] —— 疑似离题产物`,
        );
      }
    }
    return problems.length === 0 ? { ok: true, problems: [] } : { ok: false, problems };
  }

  // gate === "G4"
  const rtlText = rtl.map((r) => r.content).join("\n").toLowerCase();
  if (keywords.length > 0 && !keywords.some((k) => rtlText.includes(k))) {
    problems.push(
      `topic: RTL 未提及任何任务关键词 [${keywords.join(", ")}] —— 疑似离题产物`,
    );
  }

  for (const r of rtl) {
    const top = extractTopModule(r.content, r.contentLocation);
    if (!top) continue; // cannot locate a module header → skip (leniency)
    const topLower = top.toLowerCase();

    // (b) Name consistency: top module must appear in design docs.
    for (const d of designDocs) {
      if (!d.content.toLowerCase().includes(topLower)) {
        problems.push(
          `name: RTL 顶层模块 "${top}" 未出现在设计文档 "${d.contentLocation}" 中`,
        );
      }
    }

    // (c) Port consistency: top ports must appear in the architecture interface doc.
    const arch = artifacts.find((a) => a.artifactType === "ARCHITECTURE_DESIGN");
    if (arch) {
      const ports = extractModulePorts(r.content, top).filter((p) => p.length >= 2);
      const archLower = arch.content.toLowerCase();
      const missing = ports.filter((p) => !archLower.includes(p.toLowerCase()));
      if (missing.length > 0) {
        problems.push(
          `port: RTL 顶层 "${top}" 端口 [${missing.join(", ")}] 未出现在架构接口文档 "${arch.contentLocation}" 中`,
        );
      }
    }
  }

  return problems.length === 0 ? { ok: true, problems: [] } : { ok: false, problems };
}

/**
 * Derive the authoritative keyword sources (requirements artifact contents)
 * from a set of artifacts. Returns the content strings of every requirements
 * artifact; the caller may prepend the task/goal string.
 */
export function collectKeywordSources(artifacts: readonly ConformityArtifact[]): string[] {
  return artifacts
    .filter((a) => REQUIREMENTS_TYPES[a.artifactType] === true)
    .map((a) => a.content);
}
