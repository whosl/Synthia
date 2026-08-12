import { describe, expect, test } from "bun:test";
import {
  ModelClient,
  makeXdcValidator,
  validateRtl,
  validateTb,
  validateXdc,
  validateRepair,
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
