import { describe, expect, test } from "bun:test";
import {
  ModelClient,
  makeXdcValidator,
  makeDocValidator,
  validateRtl,
  validateTb,
  validateXdc,
  validateRepair,
  validateIntake,
  validateBehaviorWave,
  validateArchitecture,
  validateRegisterSpec,
  DOC_SCHEMA,
  type ChatPoster,
  type ActionProtocol,
} from "./model-client.ts";
import { ModelActionError } from "./types.ts";

const BASE_CFG = { baseUrl: "http://x/v1", apiKey: "k", model: "m" };

/** Builds a canned ChatPoster serving a queued list of scripted responses. */
function scriptedPoster(scripts: Array<(call: number) => { status?: number; toolArgs?: unknown; content?: unknown }>): { poster: ChatPoster; count: () => number } {
  let n = 0;
  const poster: ChatPoster = async () => {
    const idx = n;
    n++;
    const r = scripts[Math.min(idx, scripts.length - 1)]!(idx);
    const message = r.toolArgs !== undefined
      ? { tool_calls: [{ function: { arguments: typeof r.toolArgs === "string" ? r.toolArgs : JSON.stringify(r.toolArgs) } }] }
      : { content: typeof r.content === "string" ? r.content : JSON.stringify(r.content) };
    const json = { choices: [{ message }] };
    return { status: r.status ?? 200, json, text: "{}" };
  };
  return { poster, count: () => n };
}

function makeClient(protocol: ActionProtocol, poster: ChatPoster, opts: { maxParseRetries?: number; networkRetries?: number } = {}): ModelClient {
  return new ModelClient({ ...BASE_CFG, protocol, post: poster, maxParseRetries: opts.maxParseRetries ?? 1, networkRetries: opts.networkRetries ?? 0, timeoutMs: 1000 });
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

describe("action validators", () => {
  test("validateRtl accepts well-formed payload and tolerates camelCase topModule", () => {
    const a = validateRtl({ reasoning: "r", top_module: "counter", sources: [{ path: "counter.v", content: "module counter;endmodule\n" }] });
    expect(a.phase).toBe("generate_rtl");
    expect((a as { topModule: string }).topModule).toBe("counter");
    const b = validateRtl({ reasoning: "r", topModule: "foo", sources: [{ path: "foo.sv", content: "x" }] });
    expect((b as { topModule: string }).topModule).toBe("foo");
  });
  test("validateRtl rejects stub/placeholder-free empties and bad paths", () => {
    expect(() => validateRtl({ reasoning: "r", top_module: "c", sources: [] })).toThrow();
    expect(() => validateRtl({ reasoning: "r", top_module: "c", sources: [{ path: "counter.txt", content: "x" }] })).toThrow();
    expect(() => validateRtl({ reasoning: "", top_module: "c", sources: [{ path: "c.v", content: "x" }] })).toThrow();
    expect(() => validateRtl({ reasoning: "r", top_module: "9bad", sources: [{ path: "c.v", content: "x" }] })).toThrow();
    expect(() => validateRtl({ reasoning: "r", top_module: "c", sources: [{ path: "c.xdc", content: "x" }] })).toThrow();
  });
  test("validateXdc requires .xdc constraints", () => {
    expect(() => validateXdc({ reasoning: "r", constraints: [{ path: "top.v", content: "x" }] })).toThrow();
    expect(validateXdc({ reasoning: "r", constraints: [{ path: "top.xdc", content: "x" }] }).phase).toBe("generate_xdc");
  });
  test("validateRepair requires sources, testbench optional", () => {
    expect(validateRepair({ reasoning: "r", sources: [{ path: "c.v", content: "x" }] }).phase).toBe("repair");
    const withTb = validateRepair({ reasoning: "r", sources: [{ path: "c.v", content: "x" }], testbench: { path: "tb.v", content: "y" } }) as { testbench?: { path: string } };
    expect(withTb.testbench?.path).toBe("tb.v");
    expect(() => validateRepair({ reasoning: "r", sources: [] })).toThrow();
  });
  test("makeXdcValidator(false) rejects XDC containing PACKAGE_PIN", () => {
    const v = makeXdcValidator(false);
    expect(() => v({ reasoning: "r", constraints: [{ path: "top.xdc", content: "set_property PACKAGE_PIN AH15 [get_ports clk]\n" }] })).toThrow(/PACKAGE_PIN/);
  });
  test("makeXdcValidator(false) rejects XDC containing IOSTANDARD", () => {
    const v = makeXdcValidator(false);
    expect(() => v({ reasoning: "r", constraints: [{ path: "top.xdc", content: "set_property IOSTANDARD LVCMOS33 [get_ports clk]\n" }] })).toThrow(/IOSTANDARD/);
  });
  test("makeXdcValidator(false) accepts XDC with only clock + DRC downgrade (no pin assignments)", () => {
    const v = makeXdcValidator(false);
    const smoke = "set_property SEVERITY {Warning} [get_drc_checks NSTD-1]\nset_property SEVERITY {Warning} [get_drc_checks UCIO-1]\ncreate_clock -period 10.0 [get_ports clk]\n";
    const a = v({ reasoning: "smoke", constraints: [{ path: "top.xdc", content: smoke }] });
    expect(a.phase).toBe("generate_xdc");
  });
  test("makeXdcValidator(true) allows PACKAGE_PIN (when verified pin data exists)", () => {
    const v = makeXdcValidator(true);
    const a = v({ reasoning: "verified", constraints: [{ path: "top.xdc", content: "set_property PACKAGE_PIN AH15 [get_ports clk]\n" }] });
    expect(a.phase).toBe("generate_xdc");
  });
  test("makeXdcValidator(false) error message has no format pollution (no {{ or |)", () => {
    const v = makeXdcValidator(false);
    let msg = "";
    try { v({ reasoning: "r", constraints: [{ path: "top.xdc", content: "set_property PACKAGE_PIN AH15 [get_ports clk]\n" }] }); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
    expect(msg).toContain("PACKAGE_PIN");
    expect(msg).not.toContain("{{");
    expect(msg).not.toContain("|");
    // Should mention the template elements in natural language
    expect(msg).toContain("create_clock");
    expect(msg).toContain("NSTD-1");
    expect(msg).toContain("UCIO-1");
  });
});

// ---------------------------------------------------------------------------
// emitAction: tool + json protocols, parse-retry, network retry
// ---------------------------------------------------------------------------

describe("ModelClient.emitAction", () => {
  const req = {
    phase: "generate_rtl" as const, systemPrompt: "s", userMessage: "u",
    actionName: "generate_rtl", actionDescription: "d", schema: {},
  };

  test("tools protocol: extracts tool_call arguments", async () => {
    const { poster, count } = scriptedPoster([() => ({ toolArgs: { reasoning: "r", top_module: "counter", sources: [{ path: "counter.v", content: "x" }] } })]);
    const client = makeClient("tools", poster);
    const out = await client.emitAction(req, validateRtl);
    expect(out.action.phase).toBe("generate_rtl");
    expect(out.attempts).toBe(1);
    expect(count()).toBe(1);
  });

  test("json protocol: extracts content object", async () => {
    const { poster } = scriptedPoster([() => ({ content: { reasoning: "r", top_module: "counter", sources: [{ path: "counter.v", content: "x" }] } })]);
    const client = makeClient("json", poster);
    const out = await client.emitAction(req, validateRtl);
    expect(out.action.phase).toBe("generate_rtl");
    expect(out.protocol).toBe("json");
  });

  test("malformed first response → retries once → succeeds on second", async () => {
    const { poster, count } = scriptedPoster([
      () => ({ content: "not json at all" }),           // invalid JSON content
      () => ({ content: { reasoning: "r", top_module: "counter", sources: [{ path: "counter.v", content: "x" }] } }),
    ]);
    const client = makeClient("json", poster, { maxParseRetries: 1 });
    const out = await client.emitAction(req, validateRtl);
    expect(out.action.phase).toBe("generate_rtl");
    expect(out.attempts).toBe(2);
    expect(count()).toBe(2);
  });

  test("validation failure → retry once → still invalid → ModelActionError", async () => {
    const { poster, count } = scriptedPoster([
      () => ({ content: { reasoning: "r", top_module: "c", sources: [] } }), // empty sources
      () => ({ content: { reasoning: "r", top_module: "c", sources: [] } }),
    ]);
    const client = makeClient("json", poster, { maxParseRetries: 1 });
    await expect(client.emitAction(req, validateRtl)).rejects.toBeInstanceOf(ModelActionError);
    expect(count()).toBe(2);
  });

  test("tools protocol: missing tool_calls → retry then succeed", async () => {
    const { poster, count } = scriptedPoster([
      () => ({ content: "I will not use the tool" }),    // no tool_calls → invalid for tools mode
      () => ({ toolArgs: { reasoning: "r", top_module: "counter", sources: [{ path: "counter.v", content: "x" }] } }),
    ]);
    const client = makeClient("tools", poster, { maxParseRetries: 1 });
    const out = await client.emitAction(req, validateRtl);
    expect(out.attempts).toBe(2);
    expect(count()).toBe(2);
  });

  test("non-retryable 4xx (400) surfaces immediately, no retry", async () => {
    const { poster, count } = scriptedPoster([() => ({ status: 400, content: {} })]);
    const client = makeClient("json", poster, { maxParseRetries: 2, networkRetries: 2 });
    await expect(client.emitAction(req, validateRtl)).rejects.toThrow(/400/);
    expect(count()).toBe(1);
  });

  test("network error retries up to budget then rethrows", async () => {
    let n = 0;
    const poster: ChatPoster = async () => { n++; throw new Error("ECONNREFUSED"); };
    const client = makeClient("json", poster, { networkRetries: 2 });
    await expect(client.emitAction(req, validateRtl)).rejects.toThrow("ECONNREFUSED");
    // 1 initial + 2 retries
    expect(n).toBe(3);
  });

  test("5xx is retried within parse budget then fails", async () => {
    const { poster, count } = scriptedPoster([
      () => ({ status: 503, content: {} }),
      () => ({ status: 503, content: {} }),
    ]);
    const client = makeClient("json", poster, { maxParseRetries: 1 });
    await expect(client.emitAction(req, validateRtl)).rejects.toBeInstanceOf(ModelActionError);
    expect(count()).toBe(2);
  });
  test("validation failure (illegal file type) → phase-specific feedback retry → corrected → succeeds", async () => {
    // First response: model includes a .md documentation file (the real e2e failure mode)
    const { poster, count } = scriptedPoster([
      () => ({ toolArgs: { reasoning: "r", top_module: "counter", sources: [{ path: "doc/spec/behavior_spec.md", content: "# spec" }, { path: "counter.v", content: "module counter;endmodule\n" }] } }),
      // Second response: model corrects after seeing the feedback, outputs only .v files
      () => ({ toolArgs: { reasoning: "r", top_module: "counter", sources: [{ path: "counter.v", content: "module counter;endmodule\n" }] } }),
    ]);
    const client = makeClient("tools", poster, { maxParseRetries: 1 });
    const out = await client.emitAction(req, validateRtl);
    expect(out.action.phase).toBe("generate_rtl");
    expect(out.attempts).toBe(2);
    // Feedback was recorded
    expect(out.validationFeedbacks).toBeDefined();
    expect(out.validationFeedbacks!.length).toBe(1);
    // The feedback mentions .v/.sv/.vh and explicitly excludes docs
    expect(out.validationFeedbacks![0]).toContain(".v");
    expect(out.validationFeedbacks![0]).toContain("documentation");
    expect(count()).toBe(2);
  });

  test("validation failure twice → ModelActionError with recorded feedbacks", async () => {
    const { poster, count } = scriptedPoster([
      () => ({ toolArgs: { reasoning: "r", top_module: "counter", sources: [{ path: "notes.md", content: "x" }] } }),
      () => ({ toolArgs: { reasoning: "r", top_module: "counter", sources: [{ path: "readme.txt", content: "x" }] } }),
    ]);
    const client = makeClient("tools", poster, { maxParseRetries: 1 });
    let caught: ModelActionError | undefined;
    try { await client.emitAction(req, validateRtl); } catch (e) { caught = e as ModelActionError; }
    expect(caught).toBeInstanceOf(ModelActionError);
    expect(count()).toBe(2); // initial + 1 retry
    // Both feedbacks recorded on the error
    const feedbacks = (caught as ModelActionError & { validationFeedbacks?: readonly string[] }).validationFeedbacks;
    expect(feedbacks).toBeDefined();
    expect(feedbacks!.length).toBe(2);
  });

  test("XDC phase: validation feedback mentions .xdc only, excludes .v", async () => {
    const xdcReq = { ...req, phase: "generate_xdc" as const, actionName: "generate_xdc" };
    const { poster, count } = scriptedPoster([
      () => ({ content: { reasoning: "r", constraints: [{ path: "top.v", content: "x" }] } }),
      () => ({ content: { reasoning: "r", constraints: [{ path: "top.xdc", content: "x" }] } }),
    ]);
    const client = makeClient("json", poster, { maxParseRetries: 1 });
    const out = await client.emitAction(xdcReq, validateXdc);
    expect(out.action.phase).toBe("generate_xdc");
    expect(out.attempts).toBe(2);
    // The feedback for XDC should say .xdc
    expect(out.validationFeedbacks![0]).toContain(".xdc");
    expect(count()).toBe(2);
  });

  test("XDC phase: PACKAGE_PIN in first response → feedback retry → corrected (no pin) → succeeds", async () => {
    const xdcReq = { ...req, phase: "generate_xdc" as const, actionName: "generate_xdc" };
    const { poster, count } = scriptedPoster([
      // First: model hallucinates PACKAGE_PIN
      () => ({ content: { reasoning: "r", constraints: [{ path: "top.xdc", content: "set_property PACKAGE_PIN AH15 [get_ports clk]\n" }] } }),
      // Second: model corrects to smoke-only XDC (no pins)
      () => ({ content: { reasoning: "smoke", constraints: [{ path: "top.xdc", content: "set_property SEVERITY {Warning} [get_drc_checks NSTD-1]\ncreate_clock -period 10 [get_ports clk]\n" }] } }),
    ]);
    const client = makeClient("json", poster, { maxParseRetries: 1 });
    const out = await client.emitAction(xdcReq, makeXdcValidator(false));
    expect(out.action.phase).toBe("generate_xdc");
    expect(out.attempts).toBe(2);
    expect(out.validationFeedbacks).toBeDefined();
    expect(out.validationFeedbacks![0]).toContain("PACKAGE_PIN");
    expect(count()).toBe(2);
  });

  test("generateXdc prompt (no pin table) contains verbatim template with no format pollution", async () => {
    let capturedBody = "";
    const poster: ChatPoster = async (input) => {
      capturedBody = input.body;
      return { status: 200, json: { choices: [{ message: { content: JSON.stringify({ reasoning: "smoke", constraints: [{ path: "top.xdc", content: "create_clock -name sys_clk -period 10.000 [get_ports clk]\nset_property SEVERITY {Warning} [get_drc_checks NSTD-1]\nset_property SEVERITY {Warning} [get_drc_checks UCIO-1]\n" }] }) } }] }, text: "" };
    };
    const client = new ModelClient({ ...BASE_CFG, protocol: "json", post: poster, maxParseRetries: 0, networkRetries: 0, timeoutMs: 1000 });
    await client.generateXdc("top", "xc7k70tfbv676-1", "sys", false);
    // The body must contain the verbatim template
    expect(capturedBody).toContain("create_clock -name sys_clk -period 10.000");
    expect(capturedBody).toContain("set_property SEVERITY");
    expect(capturedBody).toContain("NSTD-1");
    expect(capturedBody).toContain("UCIO-1");
    // No double-brace or pipe pollution
    expect(capturedBody).not.toContain("{{");
    // The instruction must be positive (template-first), not just a prohibition
    expect(capturedBody).toContain("EXACTLY the following template");
  });

});

// ---------------------------------------------------------------------------
// Doc generation validators + protocol
// ---------------------------------------------------------------------------

describe("doc validators", () => {
  test("validateIntake accepts well-formed markdown doc", () => {
    const a = validateIntake({ reasoning: "r", doc_path: "doc/intake/summary.md", content: "# Counter 需求梳理摘要\n## Task Summary\n8-bit counter." });
    expect(a.phase).toBe("generate_intake");
  });
  test("validateIntake rejects non-.md doc_path", () => {
    expect(() => validateIntake({ reasoning: "r", doc_path: "doc/intake/summary.txt", content: "# heading" })).toThrow(/\.md/);
  });
  test("validateIntake rejects content without a heading", () => {
    expect(() => validateIntake({ reasoning: "r", doc_path: "doc/intake/summary.md", content: "just prose, no heading" })).toThrow(/heading/);
  });
  test("validateArchitecture accepts valid doc", () => {
    const a = validateArchitecture({ reasoning: "r", doc_path: "doc/arch/module_partition.md", content: "# Architecture\n## Modules\ncounter." });
    expect(a.phase).toBe("generate_architecture");
  });
  test("validateRegisterSpec accepts valid doc", () => {
    const a = validateRegisterSpec({ reasoning: "r", doc_path: "doc/reg/register_map.md", content: "# Register Map\nNo registers." });
    expect(a.phase).toBe("generate_register_spec");
  });
  test("validateBehaviorWave accepts valid doc", () => {
    const a = validateBehaviorWave({ reasoning: "r", doc_path: "doc/spec/behavior_spec.md", content: "# Behavior Spec\n## Rules\nR1." });
    expect(a.phase).toBe("generate_behavior_wave");
  });
  test("makeDocValidator tolerates camelCase docPath", () => {
    const v = makeDocValidator("generate_intake");
    const a = v({ reasoning: "r", docPath: "doc/intake/summary.md", content: "# Title\nContent." });
    expect((a as { docPath: string }).docPath).toBe("doc/intake/summary.md");
  });
  test("doc validator rejects bare file paths outside code fences", () => {
    // A bare path reference outside fences/backticks should be rejected.
    expect(() => validateIntake({
      reasoning: "r", doc_path: "doc/intake/summary.md",
      content: "# Summary\nSee doc/intake/summary.md for details.\nMore text with rtl/counter.v reference.",
    })).toThrow(/bare file paths/);
  });
  test("doc validator allows file paths inside code fences", () => {
    const a = validateIntake({
      reasoning: "r", doc_path: "doc/intake/summary.md",
      content: "# Summary\n```\ndoc/intake/summary.md\nrtl/counter.v\n```\nDone.",
    });
    expect(a.phase).toBe("generate_intake");
  });
  test("doc validator allows file paths in inline code backticks", () => {
    const a = validateIntake({
      reasoning: "r", doc_path: "doc/intake/summary.md",
      content: "# Summary\nSee `doc/intake/summary.md` for details.\nAlso `rtl/counter.v`.",
    });
    expect(a.phase).toBe("generate_intake");
  });
});

describe("ModelClient.generateIntake", () => {
  test("generates intake doc via tools protocol", async () => {
    const { poster, count } = scriptedPoster([
      () => ({ toolArgs: { reasoning: "intake analysis", doc_path: "doc/intake/summary.md", content: "# Counter 需求梳理摘要\n## Task Summary\n8-bit counter.\n## Acceptance Criteria\nCounts up." } }),
    ]);
    const client = makeClient("tools", poster);
    const doc = await client.generateIntake("实现一个8位计数器", "sys-prompt");
    expect(doc.phase).toBe("generate_intake");
    expect(doc.docPath).toBe("doc/intake/summary.md");
    expect(doc.content).toContain("## Task Summary");
    expect(count()).toBe(1);
  });

  test("doc validation failure → retry → corrected → succeeds", async () => {
    const { poster, count } = scriptedPoster([
      () => ({ toolArgs: { reasoning: "r", doc_path: "notes.txt", content: "# heading" } }), // wrong extension
      () => ({ toolArgs: { reasoning: "r", doc_path: "doc/intake/summary.md", content: "# Fixed\n## Content" } }),
    ]);
    const client = makeClient("tools", poster, { maxParseRetries: 1 });
    const doc = await client.generateIntake("task", "sys");
    expect(doc.docPath).toBe("doc/intake/summary.md");
    expect(count()).toBe(2);
  });

  test("generateArchitecture uses DOC_SCHEMA", async () => {
    let capturedSchema: Record<string, unknown> = {};
    const poster: ChatPoster = async (input) => {
      const body = JSON.parse(input.body);
      capturedSchema = body.tools?.[0]?.function?.parameters ?? {};
      const args = JSON.stringify({ reasoning: "r", doc_path: "doc/arch/module_partition.md", content: "# Arch\n## Modules" });
      return {
        status: 200,
        json: { choices: [{ message: { tool_calls: [{ function: { arguments: args } }] } }] },
        text: "",
      };
    };
    const client = new ModelClient({ ...BASE_CFG, protocol: "tools", post: poster, maxParseRetries: 0, timeoutMs: 1000 });
    await client.generateArchitecture("sys", [{ label: "up", content: "intake" }]);
    expect(capturedSchema).toEqual(DOC_SCHEMA);
  });
});

describe("doc-phase content salvage + debug + max_tokens", () => {
  test("salvages doc from message.content when tool_calls absent (raw markdown)", async () => {
    // Model puts the full markdown document in message.content, no tool_calls.
    const poster: ChatPoster = async () => ({
      status: 200,
      json: { choices: [{ message: { content: "# Architecture Design\n## Module Partition\ncounter: top module." } }] },
      text: "",
    });
    const client = new ModelClient({ ...BASE_CFG, protocol: "tools", post: poster, maxParseRetries: 0, timeoutMs: 1000 });
    const doc = await client.generateArchitecture("sys");
    expect(doc.phase).toBe("generate_architecture");
    expect(doc.docPath).toBe("doc/arch/module_partition.md");
    expect(doc.content).toContain("# Architecture Design");
  });

  test("salvages doc from message.content when content is JSON object", async () => {
    const poster: ChatPoster = async () => ({
      status: 200,
      json: {
        choices: [{
          message: {
            content: JSON.stringify({
              reasoning: "from content",
              doc_path: "doc/intake/summary.md",
              content: "# Intake\n## Task Summary\n8-bit counter.",
            }),
          },
        }],
      },
      text: "",
    });
    const client = new ModelClient({ ...BASE_CFG, protocol: "tools", post: poster, maxParseRetries: 0, timeoutMs: 1000 });
    const doc = await client.generateIntake("task", "sys");
    expect(doc.phase).toBe("generate_intake");
    expect(doc.docPath).toBe("doc/intake/summary.md");
    expect(doc.content).toContain("## Task Summary");
  });

  test("salvaged content still goes through validator (rejects bare paths)", async () => {
    // Salvaged markdown with bare file paths should fail validation.
    const poster: ChatPoster = async () => ({
      status: 200,
      json: { choices: [{ message: { content: "# Bad\nSee doc/intake/summary.md bare path." } }] },
      text: "",
    });
    const client = new ModelClient({ ...BASE_CFG, protocol: "tools", post: poster, maxParseRetries: 1, timeoutMs: 1000 });
    await expect(client.generateIntake("task", "sys")).rejects.toBeInstanceOf(ModelActionError);
  });

  test("doc phases use higher max_tokens than tool phases", async () => {
    let docTokens = 0;
    let toolTokens = 0;
    const makePoster = (capture: { val: number }): ChatPoster => async (input) => {
      const body = JSON.parse(input.body);
      capture.val = body.max_tokens;
      const args = JSON.stringify({ reasoning: "r", doc_path: "doc/intake/summary.md", content: "# Title\n## S" });
      return { status: 200, json: { choices: [{ message: { tool_calls: [{ function: { arguments: args } }] } }] }, text: "" };
    };
    const docCapture = { val: 0 };
    const docClient = new ModelClient({ ...BASE_CFG, protocol: "tools", post: makePoster(docCapture), maxParseRetries: 0, timeoutMs: 1000, docMaxTokens: 9999, toolMaxTokens: 1111 });
    await docClient.generateIntake("t", "s");
    docTokens = docCapture.val;

    const toolCapture = { val: 0 };
    const rtlArgs = JSON.stringify({ reasoning: "r", top_module: "c", sources: [{ path: "c.v", content: "x" }] });
    const toolPoster: ChatPoster = async (input) => {
      const body = JSON.parse(input.body);
      toolCapture.val = body.max_tokens;
      return { status: 200, json: { choices: [{ message: { tool_calls: [{ function: { arguments: rtlArgs } }] } }] }, text: "" };
    };
    const toolClient = new ModelClient({ ...BASE_CFG, protocol: "tools", post: toolPoster, maxParseRetries: 0, timeoutMs: 1000, docMaxTokens: 9999, toolMaxTokens: 1111 });
    await toolClient.generateRtl("t", "s");
    toolTokens = toolCapture.val;

    expect(docTokens).toBe(9999);
    expect(toolTokens).toBe(1111);
    expect(docTokens).toBeGreaterThan(toolTokens);
  });

  test("debug mode logs response summary to stderr", async () => {
    const originalStderr = process.stderr.write.bind(process.stderr);
    const debugLines: string[] = [];
    process.stderr.write = (s: string) => { if (s.includes("[model-debug]")) debugLines.push(s); return true; };
    try {
      const poster: ChatPoster = async () => ({
        status: 200,
        json: {
          choices: [{ finish_reason: "stop", message: { tool_calls: [{ function: { arguments: JSON.stringify({ reasoning: "r", doc_path: "doc/intake/summary.md", content: "# T\n## S" }) } }] } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        },
        text: "",
      });
      const client = new ModelClient({ ...BASE_CFG, protocol: "tools", post: poster, maxParseRetries: 0, timeoutMs: 1000, debug: true });
      await client.generateIntake("t", "s");
      expect(debugLines.length).toBeGreaterThanOrEqual(1);
      expect(debugLines[0]).toContain("generate_intake");
      expect(debugLines[0]).toContain("finish=stop");
      expect(debugLines[0]).toContain("tool_calls=true");
      expect(debugLines[0]).toContain("tokens=");
    } finally {
      process.stderr.write = originalStderr;
    }
  });

  test("doc salvage fallback not used for non-doc phases (RTL)", async () => {
    // RTL phase should NOT salvage from content — it must use tool_calls.
    const poster: ChatPoster = async () => ({
      status: 200,
      json: { choices: [{ message: { content: "module counter; endmodule" } }] },
      text: "",
    });
    const client = new ModelClient({ ...BASE_CFG, protocol: "tools", post: poster, maxParseRetries: 0, timeoutMs: 1000 });
    await expect(client.generateRtl("t", "s")).rejects.toBeInstanceOf(ModelActionError);
  });
});
// ---------------------------------------------------------------------------
// Upstream artifact injection — every generate* method embeds the upstream section
// ---------------------------------------------------------------------------

describe("ModelClient upstream injection", () => {
  const MARKER = "UNIQUE_UPSTREAM_MARKER_42";
  const upstream = [{ label: "Intake 需求摘要", content: MARKER }];

  /** Poster that captures the request body and returns a minimal valid action per phase. */
  function capturingPoster(responseFor: (phase: string) => unknown): { poster: ChatPoster; body: () => string } {
    let captured = "";
    const poster: ChatPoster = async (input) => {
      captured = input.body;
      const parsed = JSON.parse(input.body);
      const phase = parsed.tools?.[0]?.function?.name ?? "unknown";
      return { status: 200, json: { choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(responseFor(phase)) } }] } }] }, text: "" };
    };
    return { poster, body: () => captured };
  }

  function client(poster: ChatPoster): ModelClient {
    return new ModelClient({ ...BASE_CFG, protocol: "tools", post: poster, maxParseRetries: 0, timeoutMs: 1000 });
  }

  test("generateRtl embeds upstream section + marker", async () => {
    const { poster, body } = capturingPoster(() => ({ reasoning: "r", top_module: "counter", sources: [{ path: "counter.v", content: "module counter;endmodule\n" }] }));
    await client(poster).generateRtl("t", "s", upstream);
    expect(body()).toContain("上游产物 (Upstream Artifacts)");
    expect(body()).toContain(MARKER);
  });

  test("generateTestbench embeds upstream section + marker", async () => {
    const { poster, body } = capturingPoster(() => ({ reasoning: "r", testbench_module: "tb", testbench: { path: "tb.v", content: "module tb;endmodule\n" } }));
    await client(poster).generateTestbench([{ path: "c.v", content: "x" }], "counter", "s", upstream);
    expect(body()).toContain(MARKER);
  });

  test("generateXdc embeds upstream section + marker", async () => {
    const { poster, body } = capturingPoster(() => ({ reasoning: "r", constraints: [{ path: "top.xdc", content: "create_clock -period 10 [get_ports clk]\n" }] }));
    await client(poster).generateXdc("top", "xc7k70tfbv676-1", "s", false, upstream);
    expect(body()).toContain(MARKER);
  });

  test("generateIntake embeds upstream section + marker", async () => {
    const { poster, body } = capturingPoster(() => ({ reasoning: "r", doc_path: "doc/intake/summary.md", content: "# T\n## S" }));
    await client(poster).generateIntake("t", "s", upstream);
    expect(body()).toContain(MARKER);
  });

  test("generateBehaviorWave embeds upstream section + marker", async () => {
    const { poster, body } = capturingPoster(() => ({ reasoning: "r", doc_path: "doc/spec/behavior_spec.md", content: "# T\n## S" }));
    await client(poster).generateBehaviorWave("s", upstream);
    expect(body()).toContain(MARKER);
  });

  test("generateArchitecture embeds upstream section + marker", async () => {
    const { poster, body } = capturingPoster(() => ({ reasoning: "r", doc_path: "doc/arch/module_partition.md", content: "# T\n## S" }));
    await client(poster).generateArchitecture("s", upstream);
    expect(body()).toContain(MARKER);
  });

  test("generateRegisterSpec embeds upstream section + marker", async () => {
    const { poster, body } = capturingPoster(() => ({ reasoning: "r", doc_path: "doc/reg/register_map.md", content: "# T\n## S" }));
    await client(poster).generateRegisterSpec("s", upstream);
    expect(body()).toContain(MARKER);
  });

  test("no upstream → body has no upstream section header", async () => {
    const { poster, body } = capturingPoster(() => ({ reasoning: "r", top_module: "counter", sources: [{ path: "counter.v", content: "x" }] }));
    await client(poster).generateRtl("t", "s");
    expect(body()).not.toContain("上游产物 (Upstream Artifacts)");
  });

  test("upstream section carries consistency instructions", async () => {
    const { poster, body } = capturingPoster(() => ({ reasoning: "r", top_module: "counter", sources: [{ path: "counter.v", content: "x" }] }));
    await client(poster).generateRtl("t", "s", upstream);
    expect(body()).toContain("不得偏离上游");
  });
});
