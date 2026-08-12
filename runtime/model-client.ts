/**
 * Synthia Runtime — OpenAI-compatible model client.
 *
 * Implements {@link LoopModel} against an internal vLLM endpoint
 * (deepseek-v4-flash). Two action protocols:
 *
 *  - "tools" (primary): the model is given a single function tool per phase and
 *    returns structured arguments via `tool_calls`. Probe confirmed this is
 *    supported by the endpoint.
 *  - "json" (fallback): the model emits a strict JSON object (response_format
 *    json_object) which is parsed and validated.
 *
 * In both modes the raw model output is run through a strict validator; on a
 * validation failure the request is retried once with a corrective instruction.
 *
 * Credentials are read ONLY from the environment and never logged. The
 * Authorization header carries the bearer key; no other path touches it.
 */

import { ModelActionError } from "./types.ts";
import type { ArtifactFile, LoopModel, LoopPhase, LoopAction, RtlGeneration, TbGeneration, XdcGeneration, RepairGeneration } from "./types.ts";

export type ActionProtocol = "tools" | "json";

export interface ModelClientConfig {
  /** Base URL, e.g. http://172.16.0.3:4000/v1 (no trailing slash). */
  readonly baseUrl: string;
  /** Bearer key; sourced from env, never logged. */
  readonly apiKey: string;
  readonly model: string;
  readonly protocol: ActionProtocol;
  /** Per-request timeout (cold start can exceed 30s). Default 120000ms. */
  readonly timeoutMs?: number;
  /** Extra attempts after the first malformed response. Default 1. */
  readonly maxParseRetries?: number;
  /** Network/timeout retries. Default 2. */
  readonly networkRetries?: number;
  /** Injectable for tests. */
  readonly post?: ChatPoster;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** Low-level poster abstraction (tests inject a canned responder). */
export interface ChatPoster {
  (input: { url: string; headers: Record<string, string>; body: string; timeoutMs: number }): Promise<ChatCompletionResponse>;
}

export interface ChatCompletionResponse {
  readonly status: number;
  readonly json?: unknown;
  readonly text: string;
}

export interface ActionRequest {
  readonly phase: LoopPhase;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly actionName: string;
  readonly actionDescription: string;
  readonly schema: Record<string, unknown>;
}

export interface EmitOutcome {
  readonly action: LoopAction;
  readonly attempts: number;
  readonly protocol: ActionProtocol;
  /** Recorded reasons for invalid responses (feedback injected into retries). */
  readonly validationFeedbacks?: readonly string[];
}

export type ActionValidator = (raw: unknown) => LoopAction;

// ---------------------------------------------------------------------------
// env wiring
// ---------------------------------------------------------------------------

export function modelConfigFromEnv(env: Record<string, string | undefined> = process.env): ModelClientConfig {
  const required = (k: string): string => {
    const v = env[k];
    if (!v || !v.trim()) throw new Error(`model-client: ${k} is required in the environment`);
    return v.trim();
  };
  const protocol: ActionProtocol = (env.SYNTHIA_MODEL_PROTOCOL ?? "tools") === "json" ? "json" : "tools";
  const timeoutMs = env.SYNTHIA_MODEL_TIMEOUT_MS ? Number(env.SYNTHIA_MODEL_TIMEOUT_MS) : 120_000;
  return {
    baseUrl: required("SYNTHIA_MODEL_URL").replace(/\/+$/, ""),
    apiKey: required("SYNTHIA_MODEL_KEY"),
    model: required("SYNTHIA_MODEL_NAME"),
    protocol,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000,
    maxParseRetries: env.SYNTHIA_MODEL_PARSE_RETRIES ? Number(env.SYNTHIA_MODEL_PARSE_RETRIES) : 1,
    networkRetries: env.SYNTHIA_MODEL_NETWORK_RETRIES ? Number(env.SYNTHIA_MODEL_NETWORK_RETRIES) : 2,
  };
}

// ---------------------------------------------------------------------------
// default poster: native fetch, no proxy, abortable timeout
// ---------------------------------------------------------------------------

const defaultPost: ChatPoster = async ({ url, headers, body, timeoutMs }) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
};

function extractArguments(json: unknown, protocol: ActionProtocol): { ok: true; value: unknown } | { ok: false; reason: string } {
  interface ToolCallFn { function?: { arguments?: unknown } }
  interface Msg { content?: string; tool_calls?: ToolCallFn[] }
  const choices = (json as { choices?: Array<{ message?: Msg }> } | undefined)?.choices;
  const msg = choices?.[0]?.message;
  if (!msg) return { ok: false, reason: "response has no message" };
  if (protocol === "tools") {
    const call = msg.tool_calls?.[0]?.function?.arguments;
    if (call === undefined) return { ok: false, reason: "no tool_calls in response" };
    if (typeof call === "string") {
      try { return { ok: true, value: JSON.parse(call) }; } catch { return { ok: false, reason: "tool arguments are not valid JSON" }; }
    }
    return { ok: true, value: call };
  }
  const content = msg.content;
  if (typeof content !== "string" || !content.trim()) return { ok: false, reason: "empty content" };
  try { return { ok: true, value: JSON.parse(content) }; } catch { return { ok: false, reason: "content is not valid JSON" }; }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
function backoffMs(attempt: number): number { return Math.min(8000, 250 * 2 ** (attempt - 1)); }

// ---------------------------------------------------------------------------
// ModelClient
// ---------------------------------------------------------------------------

export class ModelClient implements LoopModel {
  private readonly cfg: ModelClientConfig;
  private readonly post: ChatPoster;

  constructor(config: ModelClientConfig) {
    this.cfg = config;
    this.post = config.post ?? defaultPost;
  }

  /** Low-level structured-action emission used by every phase method. */
  async emitAction(req: ActionRequest, validate: ActionValidator): Promise<EmitOutcome> {
    const maxParse = Math.max(0, this.cfg.maxParseRetries ?? 1);
    const maxNetwork = Math.max(0, this.cfg.networkRetries ?? 2);
    const feedbacks: string[] = [];
    let lastReason = "no attempt made";
    let attempt = 0;
    for (let parseRound = 0; parseRound <= maxParse; parseRound++) {
      attempt = parseRound + 1;
      const messages = this.buildMessages(req, parseRound > 0 ? lastReason : undefined);
      let response: ChatCompletionResponse;
      let netAttempt = 0;
      while (true) {
        try {
          response = await this.post(this.buildRequest(req, messages));
          break;
        } catch (e) {
          netAttempt++;
          if (netAttempt > maxNetwork) throw e;
          lastReason = `network error: ${e instanceof Error ? e.message : String(e)}`;
          await sleep(backoffMs(netAttempt));
        }
      }
      if (response.status < 200 || response.status >= 300) {
        lastReason = `HTTP ${response.status}`;
        // Non-retryable client errors surface immediately.
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
          throw new Error(`model-client: upstream returned ${response.status}`);
        }
        continue;
      }
      const extracted = extractArguments(response.json, this.cfg.protocol);
      if (!extracted.ok) { lastReason = extracted.reason; continue; }
      try {
        const action = validate(extracted.value);
        return { action, attempts: attempt, protocol: this.cfg.protocol, ...(feedbacks.length ? { validationFeedbacks: [...feedbacks] } : {}) };
      } catch (e) {
        lastReason = e instanceof Error ? e.message : String(e);
        feedbacks.push(lastReason);
      }
    }
    const e = new ModelActionError(
      `model produced no valid action for phase ${req.phase}: ${lastReason}`,
      req.phase,
      attempt,
    );
    (e as ModelActionError & { validationFeedbacks?: readonly string[] }).validationFeedbacks = feedbacks.length ? [...feedbacks] : undefined;
    throw e;
  }

  private buildMessages(req: ActionRequest, correction?: string): ChatMessage[] {
    const sys: ChatMessage = { role: "system", content: req.systemPrompt };
    const instr = this.cfg.protocol === "json"
      ? `You MUST respond with a single JSON object matching this schema. No prose, no markdown fences:\n${JSON.stringify(req.schema)}`
      : `You MUST call the "${req.actionName}" tool with the required arguments. Do not respond with prose.`;
    const user: ChatMessage = { role: "user", content: `${instr}\n\n${PHASE_CONSTRAINTS[req.phase] ?? ""}\n\n${req.userMessage}` };
    const msgs = [sys, user];
    if (correction) {
      msgs.push({ role: "assistant", content: "(previous response was invalid)" });
      msgs.push({ role: "user", content: `Your previous response was REJECTED: ${correction}\n\n${PHASE_CONSTRAINTS[req.phase] ?? ""}\nFix the problem and respond again. Output ONLY the required source/constraint files — no documentation, no .md/.txt/.yaml/.json files.` });
    }
    return msgs;
  }

  private buildRequest(req: ActionRequest, messages: ChatMessage[]): { url: string; headers: Record<string, string>; body: string; timeoutMs: number } {
    const base: Record<string, unknown> = { model: this.cfg.model, temperature: 0, max_tokens: 4096, messages };
    if (this.cfg.protocol === "tools") {
      base.tools = [{ type: "function", function: { name: req.actionName, description: req.actionDescription, parameters: req.schema } }];
      base.tool_choice = { type: "function", function: { name: req.actionName } };
    } else {
      base.response_format = { type: "json_object" };
    }
    return {
      url: `${this.cfg.baseUrl}/chat/completions`,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(base),
      timeoutMs: this.cfg.timeoutMs ?? 120_000,
    };
  }

  // ----- LoopModel implementation -----

  async generateRtl(task: string, systemPrompt: string): Promise<RtlGeneration> {
    const outcome = await this.emitAction(
      {
        phase: "generate_rtl", systemPrompt,
        userMessage: `User task:\n${task}\n\nProduce a synthesizable Verilog RTL module implementing this task. Output one module.`,
        actionName: "generate_rtl", actionDescription: "Produce an RTL source set for the requested task.",
        schema: RTL_SCHEMA,
      },
      validateRtl,
    );
    return outcome.action as RtlGeneration;
  }

  async generateTestbench(rtl: readonly ArtifactFile[], topModule: string, systemPrompt: string): Promise<TbGeneration> {
    const rtlBlock = rtl.map(f => `# ${f.path}\n\`\`\`verilog\n${f.content}\n\`\`\``).join("\n\n");
    const outcome = await this.emitAction(
      {
        phase: "generate_testbench", systemPrompt,
        userMessage: `RTL top module: ${topModule}\n\nRTL sources:\n${rtlBlock}\n\nProduce a self-checking testbench that drives the DUT and prints PASS/FAIL.`,
        actionName: "generate_testbench", actionDescription: "Produce a self-checking testbench for the given RTL.",
        schema: TB_SCHEMA,
      },
      validateTb,
    );
    return outcome.action as TbGeneration;
  }

  async generateXdc(topModule: string, part: string, systemPrompt: string, allowPinAssignments: boolean): Promise<XdcGeneration> {
    const pinGuidance = allowPinAssignments
      ? "You MAY include PACKAGE_PIN and IOSTANDARD assignments IF AND ONLY IF you have verified pin data from the hardware manual. Do not invent pin numbers."
      : [
          "No verified pin table is available for this target part.",
          "Do NOT output any PACKAGE_PIN or IOSTANDARD assignment — those would be fabricated.",
          "Instead, output EXACTLY the following template verbatim, changing only the clock port name if your design uses a different clock signal name:",
          "",
          "```",
          "# Flow-validation smoke constraints (no verified pin table for this target)",
          "create_clock -name sys_clk -period 10.000 [get_ports clk]",
          "set_property SEVERITY {Warning} [get_drc_checks NSTD-1]",
          "set_property SEVERITY {Warning} [get_drc_checks UCIO-1]",
          "```",
          "",
          "These constraints downgrade the two DRC checks that fail on unconstrained-pin designs so write_bitstream completes.",
          "This is a flow-validation smoke design, not a hardware-deployment bitstream.",
        ].join("\n");
    const outcome = await this.emitAction(
      {
        phase: "generate_xdc", systemPrompt,
        userMessage: `Target part: ${part}\nRTL top module: ${topModule}\n\n${pinGuidance}`,
        actionName: "generate_xdc", actionDescription: "Produce XDC constraints for the target part.",
        schema: XDC_SCHEMA,
      },
      makeXdcValidator(allowPinAssignments),
    );
    return outcome.action as XdcGeneration;
  }

  async repair(input: {
    sources: readonly ArtifactFile[];
    testbench?: ArtifactFile;
    topModule: string;
    testbenchModule?: string;
    stderr: string;
    stdout?: string;
    attempt: number;
    systemPrompt: string;
  }): Promise<RepairGeneration> {
    const srcBlock = input.sources.map(f => `# ${f.path}\n\`\`\`verilog\n${f.content}\n\`\`\``).join("\n\n");
    const tbBlock = input.testbench ? `\n\nTestbench:\n\`\`\`verilog\n${input.testbench.content}\n\`\`\`` : "";
    const outcome = await this.emitAction(
      {
        phase: "repair", systemPrompt: input.systemPrompt,
        userMessage: `Repair attempt ${input.attempt}. Apply a minimal patch.\n\nCurrent sources:\n${srcBlock}${tbBlock}\n\nSimulator stdout:\n\`\`\`\n${input.stdout ?? ""}\n\`\`\`\n\nSimulator stderr:\n\`\`\`\n${input.stderr}\n\`\`\`\n\nReturn the FULL corrected sources (and testbench if the TB is at fault).`,
        actionName: "repair_sources", actionDescription: "Return corrected RTL/TB sources fixing the reported errors.",
        schema: REPAIR_SCHEMA,
      },
      validateRepair,
    );
    return outcome.action as RepairGeneration;
  }
}

// ---------------------------------------------------------------------------
// JSON Schemas + strict validators (fail loudly → triggers one retry)
// ---------------------------------------------------------------------------

const MODULE_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Phase-specific file-type constraints injected into every user message and
 *  repeated explicitly on validation-failure retry, so the model knows exactly
 *  what is allowed and what is forbidden. */
const PHASE_CONSTRAINTS: Record<LoopPhase, string> = {
  generate_rtl: "FILE TYPE CONSTRAINT: sources[] may ONLY contain .v, .sv, or .vh files. Do NOT output .md, .txt, .yaml, .json, .xdc, or any documentation files.",
  generate_testbench: "FILE TYPE CONSTRAINT: testbench.path must be a .v, .sv, or .vh file. Do NOT output .md, .txt, .yaml, .json, or any documentation files.",
  generate_xdc: "FILE TYPE CONSTRAINT: constraints[] may ONLY contain .xdc files. Do NOT output .md, .txt, .yaml, .json, .v, .sv, or any documentation files.",
  repair: "FILE TYPE CONSTRAINT: sources[] may ONLY contain .v, .sv, or .vh files. testbench (if provided) must also be .v/.sv/.vh. Do NOT output documentation files.",
};

function err(msg: string): never { throw new Error(msg); }

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) err(`field "${field}" must be a non-empty string`);
  return v;
}

function asFiles(v: unknown, field: string, allowed: { kind: "source" | "constraint"; extensions: readonly string[] }): ArtifactFile[] {
  if (!Array.isArray(v) || v.length === 0) err(`field "${field}" must be a non-empty array`);
  const out: ArtifactFile[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") err(`each item of "${field}" must be an object`);
    const o = item as Record<string, unknown>;
    const path = asString(o.path, `${field}.path`);
    const lower = path.toLowerCase();
    const okExt = allowed.extensions.some(ext => lower.endsWith(ext));
    if (!okExt) err(`${field}.path "${path}" must be ${allowed.extensions.length === 1 ? `a ${allowed.extensions[0]} file` : `one of: ${allowed.extensions.join("/")}`}. Do NOT include documentation files (.md/.txt/.yaml/.json) or any other type.`);
    const content = asString(o.content, `${field}.content`);
    out.push({ path, content, ...(typeof o.mediaType === "string" ? { mediaType: o.mediaType } : {}) });
  }
  return out;
}

const SOURCE_EXTS = [".v", ".sv", ".vh"] as const;
const XDC_EXTS = [".xdc"] as const;

function asFile(v: unknown, field: string): ArtifactFile {
  return asFiles([v], field, { kind: "source", extensions: SOURCE_EXTS })[0];
}

export const RTL_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    top_module: { type: "string" },
    sources: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  },
  required: ["reasoning", "top_module", "sources"],
} as const;

export function validateRtl(raw: unknown): LoopAction {
  if (!raw || typeof raw !== "object") err("rtl action must be an object");
  const o = raw as Record<string, unknown>;
  const reasoning = asString(o.reasoning, "reasoning");
  const topModule = asString(o.top_module ?? o.topModule, "top_module");
  if (!MODULE_RE.test(topModule)) err(`top_module "${topModule}" is not a valid identifier`);
  const sources = asFiles(o.sources, "sources", { kind: "source", extensions: SOURCE_EXTS });
  return { phase: "generate_rtl", reasoning, topModule, sources };
}

export const TB_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    testbench_module: { type: "string" },
    testbench: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  required: ["reasoning", "testbench_module", "testbench"],
} as const;

export function validateTb(raw: unknown): LoopAction {
  if (!raw || typeof raw !== "object") err("testbench action must be an object");
  const o = raw as Record<string, unknown>;
  const reasoning = asString(o.reasoning, "reasoning");
  const testbenchModule = asString(o.testbench_module ?? o.testbenchModule, "testbench_module");
  if (!MODULE_RE.test(testbenchModule)) err(`testbench_module "${testbenchModule}" is not a valid identifier`);
  const testbench = asFile(o.testbench, "testbench");
  return { phase: "generate_testbench", reasoning, testbenchModule, testbench };
}

export const XDC_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    constraints: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  },
  required: ["reasoning", "constraints"],
} as const;

/** Regex detecting PACKAGE_PIN / IOSTANDARD pin assignments in XDC content. */
const XDC_PIN_RE = /\b(?:set_property\s+(?:PACKAGE_PIN|IOSTANDARD)|PACKAGE_PIN|IOSTANDARD)\b/i;

export function makeXdcValidator(allowPinAssignments: boolean): ActionValidator {
  return (raw: unknown): LoopAction => {
    if (!raw || typeof raw !== "object") err("xdc action must be an object");
    const o = raw as Record<string, unknown>;
    const reasoning = asString(o.reasoning, "reasoning");
    const constraints = asFiles(o.constraints, "constraints", { kind: "constraint", extensions: XDC_EXTS });
    if (!allowPinAssignments) {
      for (const c of constraints) {
        if (XDC_PIN_RE.test(c.content)) {
          err(`constraints content must NOT contain PACKAGE_PIN or IOSTANDARD assignments because no verified pin table is available for this target. Use only a clock constraint and the two DRC severity downgrades. Output exactly this template, changing only the clock port name if needed: create_clock -name sys_clk -period 10.000 [get_ports clk] then set_property SEVERITY Warning for DRC checks NSTD-1 and UCIO-1.`);
        }
      }
    }
    return { phase: "generate_xdc", reasoning, constraints };
  };
}

/** Backward-compatible validator: allows pin assignments (for tests that only
 *  check structural validity). Production code uses makeXdcValidator(false). */
export const validateXdc = makeXdcValidator(true);


export const REPAIR_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    sources: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    testbench: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  required: ["reasoning", "sources"],
} as const;

export function validateRepair(raw: unknown): LoopAction {
  if (!raw || typeof raw !== "object") err("repair action must be an object");
  const o = raw as Record<string, unknown>;
  const reasoning = asString(o.reasoning, "reasoning");
  const sources = asFiles(o.sources, "sources", { kind: "source", extensions: SOURCE_EXTS });
  const tb: ArtifactFile | undefined = o.testbench !== undefined && o.testbench !== null ? asFile(o.testbench, "testbench") : undefined;
  return { phase: "repair", reasoning, sources, ...(tb ? { testbench: tb } : {}) };
}
