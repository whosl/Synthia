/**
 * Synthia Runtime — Skill loader.
 *
 * Reads the frozen skill pack (`skills/fpga/skill-pack.json`) and the relevant
 * SKILL.md method documents, then builds concise per-phase system prompts that
 * guide the LLM. Skills are injected ONLY as method guidance into the prompt —
 * the actual Vivado operations always go through the versioned Connector
 * capabilities, never as raw Tcl from a skill.
 *
 * The loader is read-only against the frozen skills tree and never modifies it.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SkillPackEntry {
  readonly skill_id: string;
  readonly version: string;
  readonly phase: string;
  readonly purpose: string;
  readonly required_permissions: readonly string[];
  readonly required_capabilities: readonly string[];
  readonly evidence: readonly string[];
  readonly failure_policy: string;
}

export interface SkillPack {
  readonly schema_version: string;
  readonly pack_id: string;
  readonly version: string;
  readonly skills: readonly SkillPackEntry[];
}

/** The five skills the loop consults as method guidance. */
export const LOOP_SKILLS = ["fpga-rtl-build", "fpga-tb-write", "fpga-xdc-gen", "fpga-compile-and-repair", "fpga-sim-run"] as const;
export type LoopSkillId = (typeof LOOP_SKILLS)[number];

export interface LoadedSkill {
  readonly id: LoopSkillId;
  readonly version: string;
  readonly purpose: string;
  readonly evidence: readonly string[];
  readonly method: string; // trimmed SKILL.md body
}

export interface SkillPrompts {
  readonly rtl: string;
  readonly tb: string;
  readonly xdc: string;
  readonly repair: string;
}

export class SkillLoader {
  private readonly root: string;
  private pack?: SkillPack;
  private readonly skillCache = new Map<LoopSkillId, LoadedSkill>();

  constructor(skillsRoot = "skills/fpga") {
    this.root = skillsRoot;
  }

  /** Load + validate the skill pack index. */
  async loadPack(): Promise<SkillPack> {
    if (this.pack) return this.pack;
    const raw = JSON.parse(await readFile(join(this.root, "skill-pack.json"), "utf8")) as SkillPack;
    if (raw.schema_version !== "synthia.skill-pack.v1") throw new Error(`skill-loader: unexpected schema_version ${raw.schema_version}`);
    const ids = new Set(raw.skills.map(s => s.skill_id));
    for (const id of LOOP_SKILLS) if (!ids.has(id)) throw new Error(`skill-loader: skill pack missing ${id}`);
    this.pack = raw;
    return raw;
  }

  /** Load a single skill (index entry + SKILL.md method body). */
  async loadSkill(id: LoopSkillId): Promise<LoadedSkill> {
    const cached = this.skillCache.get(id);
    if (cached) return cached;
    const pack = await this.loadPack();
    const entry = pack.skills.find(s => s.skill_id === id);
    if (!entry) throw new Error(`skill-loader: ${id} not in pack`);
    const methodPath = join(this.root, "skills", id, "SKILL.md");
    const method = (await readFile(methodPath, "utf8")).trim();
    const loaded: LoadedSkill = {
      id,
      version: entry.version,
      purpose: entry.purpose,
      evidence: entry.evidence,
      method,
    };
    this.skillCache.set(id, loaded);
    return loaded;
  }

  /** Build the four per-phase system prompts. */
  async buildPrompts(): Promise<SkillPrompts> {
    const [rtl, tb, xdc, repair, sim] = await Promise.all([
      this.loadSkill("fpga-rtl-build"),
      this.loadSkill("fpga-tb-write"),
      this.loadSkill("fpga-xdc-gen"),
      this.loadSkill("fpga-compile-and-repair"),
      this.loadSkill("fpga-sim-run"),
    ]);
    const header = (s: LoadedSkill, role: string) =>
      `You are the Synthia Runtime executing the ${role} step. Follow the ${s.id} (v${s.version}) method below. ` +
      `Purpose: ${s.purpose} Failure policy: ${s.failure_policy}.\n` +
      `HARD CONSTRAINTS:\n` +
      `- Output ONLY synthesizable Verilog/SystemVerilog or XDC. No raw Tcl, no shell commands, no toolchain invocations — the Runtime executes Vivado exclusively via versioned Connector capabilities.\n` +
      `- No stubs, TODO, FIXME, "// ...", placeholders, or empty always blocks. Complete implementations only.\n` +
      `- Every artifact must be real and complete; narrative claims without real content are failures.\n`;
    return {
      rtl: `${header(rtl, "RTL generation")}\n${methodCore(rtl.method)}\n\n${evidenceBlock(rtl)}`,
      tb: `${header(tb, "testbench generation")}\n${methodCore(tb.method)}\n\n${evidenceBlock(tb)}`,
      xdc: `${header(xdc, "constraint generation")}\n${methodCore(xdc.method)}\n\n${evidenceBlock(xdc)}`,
      repair: `${header(repair, "compile/simulation repair")}\n${methodCore(repair.method)}\n\n${evidenceBlock(repair)}\n` +
        `Note on simulation failures: route TB-structure issues back to a corrected TB and DUT-logic issues back to corrected RTL; you may correct both in one repair step when warranted.`,
    };
  }
}

/** Strip front-matter tables for a tighter prompt but keep the methodical core. */
function methodCore(md: string): string {
  // Keep sections 2 (boundary) onward — the operational rules — and drop the
  // leading property table / purpose which is already summarized in the header.
  const lines = md.split("\n");
  const cut = lines.findIndex(l => /^##\s+2\b/.test(l));
  return cut > 0 ? lines.slice(cut).join("\n") : md;
}

function evidenceBlock(s: LoadedSkill): string {
  return `EVIDENCE REQUIREMENTS:\n- ${s.evidence.join("\n- ")}`;
}

/** In-memory loader for tests: skips disk reads by injecting loaded skills. */
export class InMemorySkillLoader extends SkillLoader {
  private readonly injected: Partial<Record<LoopSkillId, LoadedSkill>>;
  constructor(injected: Partial<Record<LoopSkillId, LoadedSkill>>) {
    super("__inmemory__");
    this.injected = injected;
  }
  async loadSkill(id: LoopSkillId): Promise<LoadedSkill> {
    const s = this.injected[id];
    if (!s) throw new Error(`in-memory skill loader: ${id} not provided`);
    return s;
  }
  async loadPack(): Promise<SkillPack> {
    throw new Error("in-memory skill loader has no pack");
  }
}
