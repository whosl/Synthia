/**
 * Synthia Runtime — Skill tools assembly (spec 001-agent-freedom, Slice B).
 *
 * Reads the frozen FPGA skill pack (`skills/fpga/skill-pack.json`) and exposes
 * each of its skills as an {@link AgentTool} the free-agent model can choose
 * autonomously. The model generates artifact content (RTL / TB / doc / report);
 * this tool validates the call (fail-closed) and registers the content as a
 * CANDIDATE ArtifactRevision via the governance client — never approved.
 *
 * GJB red lines enforced here:
 *  - Every registration is a candidate. The governance API only registers
 *    candidates; there is no approved/baseline/publish path through a skill
 *    tool, and `declared_status` from the pack is never "approved".
 *  - Skills that declare vivado capabilities (`fpga-compile-and-repair`,
 *    `fpga-sim-run`) do NOT execute vivado themselves — `execute` only registers
 *    a candidate report compiled by the model. The underlying TOOL_RUN evidence
 *    must come from the separate vivado tool (Slice A/D). Tools never touch the
 *    connector and never bypass Core to hit a Worker directly.
 *  - Precondition failures (missing/empty content, governance rejection) return
 *    `isError:true` and write nothing to Core.
 *
 * Integration surface: imports ONLY from `./agent-types.ts` (the fixed contract)
 * and the `ArtifactType` enum. No new types shadow the contract.
 */

import { readFileSync } from "node:fs";
import type { ArtifactType } from "../core/src/domain/enums.ts";
import type { AgentTool, AgentToolResult, ToolExecContext } from "./agent-types.ts";
import { NoGovernanceClient } from "./types.ts";

/** Default pack path, relative to the repo root (the runtime's CWD). */
const DEFAULT_PACK_PATH = "skills/fpga/skill-pack.json";

// ---------------------------------------------------------------------------
// Skill-pack schema (the subset this module consumes).
// ---------------------------------------------------------------------------

interface SkillOutput {
  readonly artifact_type: string;
  readonly declared_status: string;
  readonly description: string;
}
interface SkillEntry {
  readonly skill_id: string;
  readonly purpose: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly SkillOutput[];
  readonly preconditions: readonly string[];
  readonly required_permissions: readonly string[];
  readonly required_capabilities: readonly string[];
  readonly failure_policy: string;
}
interface SkillPackFile {
  readonly skills: readonly SkillEntry[];
}

// ---------------------------------------------------------------------------
// Per-skill tool configuration, derived from the manifest + curated guidance.
// ---------------------------------------------------------------------------

interface SkillToolConfig {
  readonly skillId: string;
  /** Full purpose + structured addendum — drives the model's tool selection. */
  readonly description: string;
  /** Artifact type to register (never approved; candidate by API contract). */
  readonly registerType: ArtifactType;
  /** Default content location / filename when the model omits `filename`. */
  readonly contentPath: string;
  /** What the model must place in `content` (rendered into the JSON Schema). */
  readonly contentHint: string;
  /** Hard upstream artifact dependencies (verified via governance reads). Empty = no gate. */
  readonly requiresUpstream: readonly UpstreamReq[];
  readonly upstream: string;
}

/**
 * Curated upstream guidance per skill_id. Sourced from each skill's
 * `preconditions` and its SKILL.md (read during design); tells the model which
 * skill to run first when a precondition cannot be satisfied.
 */
const UPSTREAM_GUIDANCE: Readonly<Record<string, string>> = {
  "fpga-intake": "入口技能，无强制上游；从 TaskPackage 冻结输入开始。",
  "fpga-architecture": "fpga-intake（doc/intake/summary.md 候选）。",
  "fpga-behavior-and-wave-plan": "fpga-intake（doc/intake/summary.md 候选）。",
  "fpga-register-spec": "fpga-intake / fpga-architecture（需求摘要或架构交接包）。",
  "fpga-rtl-build":
    "fpga-architecture（interface_contract.yaml 设计端口契约）；板级 top.v 另需 fpga-hw-manual-extraction（Core 登记的 doc/hw/extracted_facts.json，每条带 source_ref/evidence_kind）。",
  "fpga-tb-write":
    "fpga-rtl-build（rtl/ 下必须存在可读取的 RTL 候选源；缺失时先调用 fpga-rtl-build）。",
  "fpga-compile-and-repair":
    "fpga-rtl-build + fpga-tb-write（候选源集）；随后经独立 vivado 工具运行 validate_sources 取得 TOOL_RUN 证据，再用本技能登记报告候选。",
  "fpga-sim-run":
    "fpga-tb-write + fpga-compile-and-repair；经独立 vivado 工具运行 simulate 取得 TOOL_RUN 证据，再用本技能登记报告候选。",
  "fpga-hw-manual-extraction":
    "偏入口；可参照 fpga-intake 的 doc/intake/summary.md 限定硬件范围。",
  "fpga-xdc-gen":
    "fpga-hw-manual-extraction（extracted_facts.json 须 status=complete 且每条映射带 source_ref/evidence_kind）+ fpga-rtl-build（板级顶层端口）。",
};

/** A hard upstream artifact dependency a skill's preconditions make absolute. */
interface UpstreamReq {
  /** ArtifactType that must exist with a live (candidate/approved/in_review) revision. */
  readonly type: ArtifactType;
  /** Skill to suggest when the dependency is missing (drives model self-correction). */
  readonly suggest: string;
}

/**
 * Skills whose preconditions declare an ABSOLUTE upstream artifact dependency —
 * i.e. the skill cannot produce a meaningful candidate without it. Sourced from
 * each skill's `preconditions` / SKILL.md. Only these are hard-gated; skills that
 * allow a direct-from-TaskPackage path (rtl-build) or graceful-absence output
 * (xdc-gen missing_info) are deliberately NOT gated.
 */
const UPSTREAM_REQUIRED: Readonly<Record<string, readonly UpstreamReq[]>> = {
  // SKILL: "rtl/ 下存在可读取的 RTL 候选源；缺失时以 needs_input 失败并指明缺失输入"
  "fpga-tb-write": [{ type: "RTL_SOURCE_SET", suggest: "fpga-rtl-build" }],
  // SKILL: "rtl/ 与 tb/ 下候选源集（作为 validate_sources 输入 manifest）"
  "fpga-compile-and-repair": [
    { type: "RTL_SOURCE_SET", suggest: "fpga-rtl-build" },
    { type: "TB_SOURCE_SET", suggest: "fpga-tb-write" },
  ],
  // SKILL: "rtl/ 下至少一个 RTL 候选源" + "tb/ 下至少一个 TB 候选源";
  //        "RTL 缺失路由 fpga-rtl-build，TB 缺失路由 fpga-tb-write"
  "fpga-sim-run": [
    { type: "RTL_SOURCE_SET", suggest: "fpga-rtl-build" },
    { type: "TB_SOURCE_SET", suggest: "fpga-tb-write" },
  ],
};

/** Revision states that count as a "live" upstream artifact (produced + usable). */
const LIVE_STATES: Readonly<Record<string, true>> = {
  candidate: true,
  approved: true,
  in_review: true,
};

/** Extract the leading file path from an output description ("path：desc"). */
function firstPath(desc: string): string {
  // Split on fullwidth "：" (U+FF1A) or ASCII ":" — path always precedes it.
  const idx = desc.search(/[：:]/);
  const path = idx === -1 ? desc : desc.slice(0, idx);
  return path.trim();
}

/** Extract the human description following the leading path. */
function afterPath(desc: string): string {
  const idx = desc.search(/[：:]/);
  const rest = idx === -1 ? desc : desc.slice(idx + 1);
  return rest.trim();
}

/** Plain-object type guard: narrows `unknown` to a string-indexed record. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function buildConfig(skill: SkillEntry): SkillToolConfig {
  const runsVivado = skill.required_capabilities.some((c) => c.startsWith("vivado-"));

  // For vivado skills the primary output is a TOOL_RUN, which can ONLY come
  // from real vivado execution (out of scope for this tool). The model cannot
  // fabricate a TOOL_RUN, so we register the next declared output — the
  // model-compiled report — instead. Pure-generation skills register outputs[0].
  const registerOutput = runsVivado
    ? skill.outputs.find((o) => o.artifact_type !== "TOOL_RUN") ?? skill.outputs[0]
    : skill.outputs[0];

  // Frozen pack: every artifact_type value is a verified ArtifactType enum member.
  const registerType = registerOutput.artifact_type as ArtifactType;
  const contentPath = firstPath(registerOutput.description) || `${skill.skill_id}.md`;
  const contentHint = afterPath(registerOutput.description) || registerOutput.description;

  const upstream = UPSTREAM_GUIDANCE[skill.skill_id] ?? "(见技能 preconditions)";

  // Full description: purpose + structured addendum so the model can decide.
  const lines: string[] = [skill.purpose, ""];
  lines.push(
    `[制品] 登记候选（candidate，非 approved）：${contentPath}（${registerType}）。入参 content=制品全文，可选 filename/notes。`,
  );
  if (skill.preconditions.length > 0) {
    lines.push(`[前置] ${skill.preconditions.join("；")}`);
  }
  lines.push(`[上游建议] ${upstream}`);
  if (runsVivado) {
    lines.push(
      "[注意] 本技能不直接执行 vivado；execute 只登记模型编制的报告候选。底层 TOOL_RUN 证据须先经独立 vivado 工具运行获得。",
    );
  }

  return {
    skillId: skill.skill_id,
    description: lines.join("\n"),
    registerType,
    contentPath,
    contentHint,
    runsVivado,
    requiresUpstream: UPSTREAM_REQUIRED[skill.skill_id] ?? [],
    upstream,
  };
}

// ---------------------------------------------------------------------------
// AgentTool construction.
// ---------------------------------------------------------------------------

/** Universal JSON Schema for every skill tool's parameters. */
function buildParameters(config: SkillToolConfig): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      content: {
        type: "string",
        description: `完整的制品内容（${config.contentHint}）。这是登记为候选 ArtifactRevision 的主体，必须真实、完整，禁止 stub/TODO/占位。`,
      },
      filename: {
        type: "string",
        description: `目标文件路径（相对仓库根）。省略时按技能约定登记为 ${config.contentPath}。`,
      },
      notes: {
        type: "string",
        description: "可选：假设、缺口、上游引用等补充说明，随候选一起登记为 changeReason。",
      },
    },
    required: ["content"],
    additionalProperties: false,
  };
}

/**
 * Verify each hard upstream requirement: the required ArtifactType must have at
 * least one revision in a live state (candidate/approved/in_review). Returns the
 * first missing requirement, `"read-error"` if a Core read throws, or `null` if
 * all satisfied. Called only against real governance clients (NoGovernance
 * exempted by the caller).
 */
async function findMissingUpstream(
  ctx: ToolExecContext,
  reqs: readonly UpstreamReq[],
): Promise<UpstreamReq | "read-error" | null> {
  let artifacts;
  try {
    artifacts = await ctx.governance.listArtifacts(ctx.projectId);
  } catch {
    return "read-error";
  }
  for (const req of reqs) {
    const matches = artifacts.filter((a) => a.artifactType === req.type);
    let present = false;
    for (const a of matches) {
      try {
        const revs = await ctx.governance.listRevisions(ctx.projectId, a.id);
        if (revs.some((r) => LIVE_STATES[r.state] === true)) {
          present = true;
          break;
        }
      } catch {
        return "read-error";
      }
    }
    if (!present) return req;
  }
  return null;
}

function buildTool(config: SkillToolConfig): AgentTool {
  return {
    name: config.skillId,
    description: config.description,
    parameters: buildParameters(config),

    async execute(args: unknown, ctx: ToolExecContext): Promise<AgentToolResult> {
      // (a) Fail-closed argument narrowing. `args` is model-produced and
      //     untrusted — narrow each field rather than casting a shape.
      const argObj: unknown = args ?? {};
      if (!isPlainObject(argObj)) {
        return {
          content:
            `前置校验失败（fail-closed，未写 Core）：${config.skillId} 入参须为 JSON 对象。请按 schema 传 content/filename/notes。`,
          isError: true,
        };
      }
      const content = typeof argObj.content === "string" ? argObj.content : "";
      const filename =
        typeof argObj.filename === "string" && argObj.filename.trim() !== ""
          ? argObj.filename.trim()
          : config.contentPath;
      const notes =
        typeof argObj.notes === "string" && argObj.notes.trim() !== "" ? argObj.notes.trim() : "";

      // Content is the registered artifact body; empty/placeholder never writes to Core.
      if (content.trim() === "") {
        return {
          content:
            `前置校验失败（fail-closed，未写 Core）：${config.skillId} 要求 \`content\` 为非空制品内容` +
            `（${config.contentHint}）。请生成完整制品后重新调用，不要提交空内容或占位。\n` +
            `上游建议：${config.upstream}`,
          isError: true,
        };
      }

      // (a) Hard upstream-artifact preconditions: skills with an absolute
      //     dependency (e.g. tb-write needs RTL) verify the upstream artifact
      //     exists in Core with a live revision before registering. Missing →
      //     fail-closed naming the producing skill (drives self-correction).
      //     NoGovernanceClient (dev/debug) cannot verify and is exempted;
      //     a read failure is also fail-closed (cannot confirm preconditions).
      if (config.requiresUpstream.length > 0 && !(ctx.governance instanceof NoGovernanceClient)) {
        const missing = await findMissingUpstream(ctx, config.requiresUpstream);
        if (missing !== null) {
          if (missing === "read-error") {
            return {
              content:
                `前置校验失败（fail-closed，未写 Core）：${config.skillId} 校验上游制品时 Core 读取异常，无法确认前置满足。请稍后重试或检查 Core 连通性。\n上游建议：${config.upstream}`,
              isError: true,
            };
          }
          return {
            content:
              `前置校验失败（fail-closed，未写 Core）：${config.skillId} 要求上游制品 ${missing.type} 存在（含 candidate/approved/in_review 修订），但 Core 未查到。` +
              `建议先调用 ${missing.suggest} 产出该制品后再重试 ${config.skillId}。\n上游建议：${config.upstream}`,
            isError: true,
          };
        }
      }

      // (b) Vivado capability skills must NOT execute vivado here. We deliberately
      //     do not consult ctx.connector: this tool only registers a candidate
      //     report. The real TOOL_RUN evidence comes from the separate vivado tool.

      // (c) Register the candidate. declared_status is always candidate — the
      //     governance API registers candidates only; there is no approved path.
      let rev;
      try {
        rev = await ctx.governance.registerCandidateArtifact({
          // artifactId becomes a URL path segment on the Core route and is a
          // GLOBAL primary key — include the project id so identical skill
          // outputs across projects/runs do not collide, and normalize
          // slashes/colons from doc paths for URL safety.
          artifactId: `fpga-${ctx.projectId}-${config.skillId}-${filename}`.replace(/[^A-Za-z0-9._-]/g, "-"),
          artifactType: config.registerType,
          title: `${config.skillId}: ${filename}`,
          content,
          contentLocation: filename,
          changeReason: notes
            ? `skill candidate | ${notes}`
            : `skill candidate (free-agent)`,
          version: 1,
        });
      } catch (err) {
        // (d) Any Core failure → isError, never fake success.
        const msg = err instanceof Error ? err.message : String(err);
        const conflict = /RESOURCE_CONFLICT|version/i.test(msg);
        return {
          content:
            `Core 候选登记失败（fail-closed）：${config.skillId} → ${filename}（${config.registerType}）。原因：${msg}` +
            (conflict
              ? " 该 artifact 已有候选修订；本工具按 version=1 登记首次候选，修订重登需会话层版本追踪（非本工具职责）。"
              : ""),
          isError: true,
        };
      }

      // (c2) Record the candidate in the session registry so the gate tool can
      //      run content-conformity on it before submission. No-op outside a
      //      free-agent session (pipeline loop does not set ctx.freeAgent).
      ctx.freeAgent?.recordArtifact({
        revisionId: rev.revisionId,
        artifactType: config.registerType,
        content,
        contentLocation: filename,
        title: `${config.skillId}: ${filename}`,
      });

      // (c) Result: candidate summary (visibly candidate, never approved).
      const lines: string[] = [
        "已登记候选制品（candidate，非 approved）：",
        `  skill      : ${config.skillId}`,
        `  artifact   : ${filename} (${config.registerType})`,
        `  revisionId : ${rev.revisionId}`,
        `  version    : ${rev.version}`,
        `  contentHash: ${rev.contentHash}`,
        `  size       : ${content.length} chars`,
      ];

      if (config.runsVivado) {
        lines.push(
          "",
          "注意：本技能未执行 vivado。上述登记的是模型编制的报告候选；底层 TOOL_RUN 证据须先经独立 vivado 工具" +
            "（validate_sources / simulate）运行获得后才能据实编写报告结论。",
        );
      }

      lines.push("", `上游建议：${config.upstream}`);
      return { content: lines.join("\n") };
    },
  };
}

// ---------------------------------------------------------------------------
// Public API — Slice B fixed signature.
// ---------------------------------------------------------------------------

export interface AssembleSkillToolsOptions {
  /** Path to the skill pack JSON (default: skills/fpga/skill-pack.json). */
  readonly packPath?: string;
}

/**
 * Load the FPGA skill pack and assemble every skill as a model-selectable
 * {@link AgentTool}. Returns one tool per skill (10 for the current pack),
 * each named exactly after its `skill_id`.
 *
 * @throws if the pack cannot be read or contains no skills.
 */
export function assembleSkillTools(opts: AssembleSkillToolsOptions = {}): AgentTool[] {
  const packPath = opts.packPath ?? DEFAULT_PACK_PATH;
  const parsed: unknown = JSON.parse(readFileSync(packPath, "utf8"));
  if (!isPlainObject(parsed) || !Array.isArray(parsed.skills)) {
    throw new Error(`skill pack at ${packPath} is malformed: expected { skills: [...] }`);
  }
  // Frozen, committed pack; structure validated above, fields read via SkillEntry.
  const pack = parsed as SkillPackFile;
  if (pack.skills.length === 0) {
    throw new Error(`skill pack at ${packPath} contains no skills`);
  }

  return pack.skills.map((skill) => buildTool(buildConfig(skill)));
}
