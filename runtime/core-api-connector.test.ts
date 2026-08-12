import { describe, expect, test } from "bun:test";
import { RemoteConnectorError } from "../connector/remote.ts";
import {
  CoreApiConnector,
  resolveCoreApiConfig,
} from "./core-api-connector.ts";
import {
  LoopExecutor,
  VIVADO_CAPABILITY_VERSION,
  submissionSha,
} from "./loop.ts";
import type {
  ArtifactFile,
  DocGeneration,
  LoopModel,
  RtlGeneration,
  TbGeneration,
  XdcGeneration,
  RepairGeneration,
  VivadoSubmission,
} from "./types.ts";
import { NoGovernanceClient } from "./types.ts";

// ---------------------------------------------------------------------------
// fetch mock — routes by (method, url), records every call verbatim.
// ---------------------------------------------------------------------------

interface MockResponse { status: number; body?: unknown }
type FetchHandler = (url: string, init: RequestInit) => MockResponse | Promise<MockResponse>;

interface RecordedCall { url: string; method: string; headers: Record<string, string>; body?: unknown }

function mockFetch(handler: FetchHandler) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers as Record<string, string> | undefined) ?? {};
    let parsedBody: unknown;
    if (init?.body != null) {
      try { parsedBody = JSON.parse(init.body as string); } catch { parsedBody = init.body; }
    }
    calls.push({ url, method, headers, body: parsedBody });
    const resp = await handler(url, init ?? {});
    const text = resp.body !== undefined ? JSON.stringify(resp.body) : "";
    return new Response(text, { status: resp.status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

const BASE = "http://127.0.0.1:8787";
const PROJECT = "p1";
const TOKEN = "svc-token-xyz";

function makeConnector(opts: { fetchImpl: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> } & Partial<ConstructorParameters<typeof CoreApiConnector>[0]> = {} as never) {
  return new CoreApiConnector({
    baseUrl: BASE, token: TOKEN, projectId: PROJECT,
    fetchImpl: opts.fetchImpl, pollIntervalMs: 0, retryDelayMs: 0,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });
}

function validateSubmission(): VivadoSubmission {
  return {
    operation: "validate_sources", runClass: "exploratory", projectId: PROJECT,
    sources: [{ path: "top.v", content: "module top; endmodule\n" }], top: "top", part: "xc7k70tfbv676-1",
  };
}

function simulateSubmission(): VivadoSubmission {
  return {
    operation: "simulate", runClass: "exploratory", projectId: PROJECT,
    sources: [{ path: "top.v", content: "module top; endmodule\n" }, { path: "tb.v", content: "module tb; endmodule\n" }],
    top: "top", part: "xc7k70tfbv676-1", testbench: "tb",
  };
}

function implementSubmission(): VivadoSubmission {
  return {
    operation: "implement", runClass: "exploratory", projectId: PROJECT,
    sources: [{ path: "top.v", content: "module top; endmodule\n" }], top: "top", part: "xc7k70tfbv676-1",
    constraints: [{ path: "synthia.xdc", content: "create_clock -period 10 [get_ports clk]\n" }],
  };
}

// ---------------------------------------------------------------------------
// discover / drift
// ---------------------------------------------------------------------------

describe("CoreApiConnector surface", () => {
  test("discover returns the four whitelisted ops at vivado-batch-1 (no network)", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, body: {} }));
    const conn = makeConnector({ fetchImpl });
    const caps = await conn.discover();
    expect(caps.map(c => c.operation).sort()).toEqual(["implement", "simulate", "synthesize", "validate_sources"]);
    for (const c of caps) {
      expect(c.version).toBe(VIVADO_CAPABILITY_VERSION);
      expect(c.runClasses).toContain("exploratory");
    }
    expect(conn.drift).toBe(false);
    expect(calls).toHaveLength(0); // discover is local
  });
});

// ---------------------------------------------------------------------------
// submit happy path + field mapping
// ---------------------------------------------------------------------------

describe("CoreApiConnector.submit happy path", () => {
  test("validate_sources: POST→poll→evidence mapped to VivadoResult", async () => {
    const { fetchImpl, calls } = mockFetch((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "POST") return { status: 201, body: { data: { jobId: "job-abc", runClass: "exploratory", state: "submitted" } } };
      if (url.endsWith("/evidence")) return { status: 200, body: { data: { jobId: "job-abc", entries: [{ name: "validate_sources.log", sha256: "a".repeat(64), sizeBytes: 12, mediaType: "text/plain" }] } } };
      return { status: 200, body: { data: { jobId: "job-abc", state: "succeeded" } } };
    });
    const conn = makeConnector({ fetchImpl });
    const result = await conn.submit(validateSubmission());

    expect(result.status).toBe("succeeded");
    expect(result.jobId).toBe("job-abc");
    expect(result.operation).toBe("validate_sources");
    expect(result.inputSha256).toBe(submissionSha(validateSubmission()));
    expect(result.evidence?.entries[0]?.name).toBe("validate_sources.log");

    // Exactly POST + 1 status poll (terminal) + 1 evidence.
    expect(calls.map(c => c.method)).toEqual(["POST", "GET", "GET"]);
    expect(calls[2]!.url).toBe(`${BASE}/api/v1/projects/${PROJECT}/jobs/job-abc/evidence`);
  });

  test("POST body + headers: run_class_intent=exploratory, Bearer + Idempotency-Key, no auth-context fields", async () => {
    const { fetchImpl, calls } = mockFetch((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "POST") return { status: 201, body: { data: { jobId: "job-x", runClass: "exploratory", state: "submitted" } } };
      if (url.endsWith("/evidence")) return { status: 200, body: { data: { jobId: "job-x", entries: [] } } };
      return { status: 200, body: { data: { jobId: "job-x", state: "succeeded" } } };
    });
    const conn = makeConnector({ fetchImpl });
    await conn.submit(validateSubmission());

    const post = calls[0]!;
    expect(post.url).toBe(`${BASE}/api/v1/projects/${PROJECT}/jobs`);
    expect(post.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(post.headers["Content-Type"]).toBe("application/json");
    expect(post.headers["Idempotency-Key"]).toMatch(/^job-[0-9a-f-]{36}$/);

    const body = post.body as Record<string, unknown>;
    expect(body["operation"]).toBe("validate_sources");
    expect(body["run_class_intent"]).toBe("exploratory");
    expect(body["top"]).toBe("top");
    expect(body["part"]).toBe("xc7k70tfbv676-1");
    expect(body["sources"]).toEqual([{ path: "top.v", content: "module top; endmodule\n" }]);
    // Runtime NEVER sends authorization-context fields.
    expect(body).not.toHaveProperty("gate_submission_id");
    expect(body).not.toHaveProperty("approved_gate_result_id");
    expect(body).not.toHaveProperty("baseline_id");
  });

  test("simulate maps testbench (module name) into the body", async () => {
    const { fetchImpl, calls } = mockFetch((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "POST") return { status: 201, body: { data: { jobId: "job-sim", runClass: "exploratory", state: "submitted" } } };
      if (url.endsWith("/evidence")) return { status: 200, body: { data: { jobId: "job-sim", entries: [] } } };
      return { status: 200, body: { data: { jobId: "job-sim", state: "succeeded" } } };
    });
    const conn = makeConnector({ fetchImpl });
    await conn.submit(simulateSubmission());
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body["testbench"]).toBe("tb");
  });

  test("implement maps constraints array into the body", async () => {
    const { fetchImpl, calls } = mockFetch((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "POST") return { status: 201, body: { data: { jobId: "job-imp", runClass: "exploratory", state: "submitted" } } };
      if (url.endsWith("/evidence")) return { status: 200, body: { data: { jobId: "job-imp", entries: [] } } };
      return { status: 200, body: { data: { jobId: "job-imp", state: "succeeded" } } };
    });
    const conn = makeConnector({ fetchImpl });
    await conn.submit(implementSubmission());
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body["constraints"]).toEqual([{ path: "synthia.xdc", content: "create_clock -period 10 [get_ports clk]\n" }]);
  });

  test("follows server-returned jobId for status + evidence (not the idempotency key)", async () => {
    const { fetchImpl, calls } = mockFetch((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "POST") return { status: 201, body: { data: { jobId: "server-minted-id", runClass: "exploratory", state: "submitted" } } };
      if (url.endsWith("/evidence")) return { status: 200, body: { data: { jobId: "server-minted-id", entries: [] } } };
      return { status: 200, body: { data: { jobId: "server-minted-id", state: "succeeded" } } };
    });
    const conn = makeConnector({ fetchImpl });
    const result = await conn.submit(validateSubmission());
    expect(result.jobId).toBe("server-minted-id");
    expect(calls[1]!.url).toBe(`${BASE}/api/v1/projects/${PROJECT}/jobs/server-minted-id`);
    expect(calls[2]!.url).toBe(`${BASE}/api/v1/projects/${PROJECT}/jobs/server-minted-id/evidence`);
  });

  test("polls until terminal then fetches evidence once", async () => {
    let pollCount = 0;
    const { fetchImpl, calls } = mockFetch((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "POST") return { status: 201, body: { data: { jobId: "j", runClass: "exploratory", state: "submitted" } } };
      if (url.endsWith("/evidence")) return { status: 200, body: { data: { jobId: "j", entries: [] } } };
      pollCount++;
      return { status: 200, body: { data: { jobId: "j", state: pollCount < 3 ? "running" : "succeeded" } } };
    });
    const conn = makeConnector({ fetchImpl });
    const result = await conn.submit(validateSubmission());
    expect(result.status).toBe("succeeded");
    // 3 status polls (running, running, succeeded) + 1 POST + 1 evidence.
    expect(calls.filter(c => c.method === "GET" && !c.url.endsWith("/evidence"))).toHaveLength(3);
    expect(calls.filter(c => c.url.endsWith("/evidence"))).toHaveLength(1);
  });

  test("failed job maps to status failed + errorCode, evidence still attempted", async () => {
    const { fetchImpl, calls } = mockFetch((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "POST") return { status: 201, body: { data: { jobId: "j", runClass: "exploratory", state: "submitted" } } };
      if (url.endsWith("/evidence")) return { status: 404, body: { error: { code: "not_found", message: "no evidence" } } };
      return { status: 200, body: { data: { jobId: "j", state: "failed", errorCode: "VIVADO_SIMULATION_FAILED" } } };
    });
    const conn = makeConnector({ fetchImpl });
    const result = await conn.submit(simulateSubmission());
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("VIVADO_SIMULATION_FAILED");
    expect(result.evidence).toBeUndefined(); // 404 evidence swallowed
    expect(calls.some(c => c.url.endsWith("/evidence"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// envelope error destructure
// ---------------------------------------------------------------------------

describe("CoreApiConnector envelope error handling", () => {
  test("destructures {error:{code,message}} and surfaces the code", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 422, body: { error: { code: "validation", message: "bad sources" } } }));
    const conn = makeConnector({ fetchImpl });
    await expect(conn.submit(validateSubmission())).rejects.toMatchObject({
      name: "RemoteConnectorError", code: "validation", message: "bad sources", retryable: false,
    });
  });
});

// ---------------------------------------------------------------------------
// status code → fail-closed / retryable mappings
// ---------------------------------------------------------------------------

describe("CoreApiConnector status mappings", () => {
  test("401 → fail-closed authorization (non-retryable)", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 401, body: { error: { code: "unauthenticated" } } }));
    const conn = makeConnector({ fetchImpl });
    await expect(conn.submit(validateSubmission())).rejects.toMatchObject({ name: "RemoteConnectorError", code: "unauthenticated", retryable: false });
    expect(calls).toHaveLength(1); // not retried
  });

  test("403 → fail-closed authorization (Core envelope code passed through)", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 403, body: { error: { code: "authorization", message: "core:write required" } } }));
    const conn = makeConnector({ fetchImpl });
    await expect(conn.submit(validateSubmission())).rejects.toMatchObject({ name: "RemoteConnectorError", code: "authorization", retryable: false });
    expect(calls).toHaveLength(1);
  });

  test("404 → fail-closed not_found", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 404, body: { error: { code: "not_found", message: "no such job" } } }));
    const conn = makeConnector({ fetchImpl });
    await expect(conn.submit(validateSubmission())).rejects.toMatchObject({ name: "RemoteConnectorError", code: "not_found", retryable: false });
    expect(calls).toHaveLength(1);
  });

  test("503 retried once, then capability_unavailable surfaces (retryable)", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 503, body: { error: { code: "capability_unavailable", message: "worker draining" } } }));
    const conn = makeConnector({ fetchImpl });
    await expect(conn.submit(validateSubmission())).rejects.toMatchObject({ name: "RemoteConnectorError", code: "capability_unavailable", retryable: true });
    expect(calls).toHaveLength(2); // initial + 1 retry
  });

  test("503 then 201 → recovers on retry", async () => {
    let attempt = 0;
    const { fetchImpl, calls } = mockFetch((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "POST") {
        attempt++;
        if (attempt === 1) return { status: 503, body: { error: { code: "capability_unavailable" } } };
        return { status: 201, body: { data: { jobId: "job-rec", runClass: "exploratory", state: "submitted" } } };
      }
      if (url.endsWith("/evidence")) return { status: 200, body: { data: { jobId: "job-rec", entries: [] } } };
      return { status: 200, body: { data: { jobId: "job-rec", state: "succeeded" } } };
    });
    const conn = makeConnector({ fetchImpl });
    const result = await conn.submit(validateSubmission());
    expect(result.status).toBe("succeeded");
    expect(result.jobId).toBe("job-rec");
    expect(calls.filter(c => c.method === "POST")).toHaveLength(2); // retried POST once
  });

  test("network error retried once, then network_error surfaces", async () => {
    const { fetchImpl, calls } = mockFetch(() => { throw new TypeError("fetch failed"); });
    const conn = makeConnector({ fetchImpl });
    await expect(conn.submit(validateSubmission())).rejects.toMatchObject({ name: "RemoteConnectorError", code: "network_error", retryable: true });
    expect(calls).toHaveLength(2);
  });

  test("network error then success → recovers on retry", async () => {
    let threw = false;
    const { fetchImpl, calls } = mockFetch((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "POST" && !threw) { threw = true; throw new TypeError("ECONNRESET"); }
      if (method === "POST") return { status: 201, body: { data: { jobId: "j", runClass: "exploratory", state: "submitted" } } };
      if (url.endsWith("/evidence")) return { status: 200, body: { data: { jobId: "j", entries: [] } } };
      return { status: 200, body: { data: { jobId: "j", state: "succeeded" } } };
    });
    const conn = makeConnector({ fetchImpl });
    const result = await conn.submit(validateSubmission());
    expect(result.status).toBe("succeeded");
    expect(calls.filter(c => c.method === "POST")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// resolveCoreApiConfig (CLI --via-core env)
// ---------------------------------------------------------------------------

describe("resolveCoreApiConfig", () => {
  test("throws when SYNTHIA_CORE_TOKEN is missing", () => {
    expect(() => resolveCoreApiConfig({})).toThrow(/SYNTHIA_CORE_TOKEN/);
  });
  test("throws when SYNTHIA_CORE_TOKEN is blank", () => {
    expect(() => resolveCoreApiConfig({ SYNTHIA_CORE_TOKEN: "   " })).toThrow(/SYNTHIA_CORE_TOKEN/);
  });
  test("defaults baseUrl to the local Core dev server", () => {
    const cfg = resolveCoreApiConfig({ SYNTHIA_CORE_TOKEN: "tok" });
    expect(cfg.baseUrl).toBe("http://127.0.0.1:8787");
    expect(cfg.token).toBe("tok");
  });
  test("honours SYNTHIA_CORE_URL and trims trailing slashes", () => {
    const cfg = resolveCoreApiConfig({ SYNTHIA_CORE_URL: "http://core.svc:9/", SYNTHIA_CORE_TOKEN: "tok" });
    expect(cfg.baseUrl).toBe("http://core.svc:9");
  });
});

// ---------------------------------------------------------------------------
// Loop integration — scripted model + CoreApiConnector over fake fetch.
// ---------------------------------------------------------------------------

const RTL: ArtifactFile = { path: "counter.v", content: "module counter(input clk,input rst_n,output reg[7:0] c);always@(posedge clk)if(!rst_n)c<=0;else c<=c+1;endmodule\n" };
const TB: ArtifactFile = { path: "tb_counter.v", content: "module tb_counter;reg clk=0;reg rst_n=0;wire[7:0] c;counter d(.clk(clk),.rst_n(rst_n),.c(c));always #5 clk=~clk;initial begin rst_n=0;#20;rst_n=1;repeat(3)@(posedge clk);$display(\"PASS\");$finish;end endmodule\n" };
const XDC: ArtifactFile = { path: "synthia.xdc", content: "set_property SEVERITY {Warning} [get_drc_checks NSTD-1]\ncreate_clock -period 10 [get_ports clk]\n" };

class ScriptedModel implements LoopModel {
  async generateIntake(): Promise<DocGeneration> { return { phase: "generate_intake", reasoning: "ok", docPath: "doc/intake/summary.md", content: "# Intake\n## Task\n8-bit counter." }; }
  async generateBehaviorWave(): Promise<DocGeneration> { return { phase: "generate_behavior_wave", reasoning: "ok", docPath: "doc/spec/behavior_spec.md", content: "# Behavior Spec\n## Rules\nR1: counter increments." }; }
  async generateArchitecture(): Promise<DocGeneration> { return { phase: "generate_architecture", reasoning: "ok", docPath: "doc/arch/module_partition.md", content: "# Architecture\n## Modules\ncounter: top." }; }
  async generateRegisterSpec(): Promise<DocGeneration> { return { phase: "generate_register_spec", reasoning: "ok", docPath: "doc/reg/register_map.md", content: "# Register Map\nNo registers." }; }
  async generateRtl(): Promise<RtlGeneration> { return { phase: "generate_rtl", reasoning: "ok", topModule: "counter", sources: [RTL] }; }
  async generateTestbench(): Promise<TbGeneration> { return { phase: "generate_testbench", reasoning: "ok", testbenchModule: "tb_counter", testbench: TB }; }
  async generateXdc(_top: string, _part: string, _sys: string, _allowPin: boolean): Promise<XdcGeneration> { return { phase: "generate_xdc", reasoning: "ok", constraints: [XDC] }; }
  async repair(): Promise<RepairGeneration> { return { phase: "repair", reasoning: "noop", sources: [RTL], testbench: TB }; }
}

describe("LoopExecutor over CoreApiConnector (via-core integration)", () => {
  test("full loop succeeds end-to-end through the Core API", async () => {
    const { fetchImpl, calls } = mockFetch((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "POST") {
        const body = init.body as string;
        const op = (JSON.parse(body) as { operation: string }).operation;
        return { status: 201, body: { data: { jobId: `job-${op}`, runClass: "exploratory", state: "submitted" } } };
      }
      if (url.endsWith("/evidence")) {
        return { status: 200, body: { data: { jobId: "job", entries: [{ name: `${url.split("/")[ -3 ]}.log`, sha256: "b".repeat(64), sizeBytes: 7, mediaType: "text/plain" }] } } };
      }
      return { status: 200, body: { data: { jobId: "job", state: "succeeded" } } };
    });

    const connector = new CoreApiConnector({
      baseUrl: BASE, token: TOKEN, projectId: PROJECT,
      fetchImpl, pollIntervalMs: 0, retryDelayMs: 0,
      sleep: async () => {},
    });

    const loop = new LoopExecutor({
      model: new ScriptedModel(),
      connector,
      skillPrompts: { rtl: "rtl", tb: "tb", xdc: "xdc", repair: "repair", intake: "intake", behaviorWave: "behavior", architecture: "arch", registerSpec: "reg" },
      part: "xc7k70tfbv676-1", projectId: PROJECT, processInstanceId: "pi-1",
      governance: new NoGovernanceClient(),
      toolModelPolicyHash: "policy-v1",
      actorId: "synthia-runtime",
    });

    const result = await loop.run("8-bit counter");

    expect(result.status).toBe("succeeded");
    // Four tool calls (validate_sources, simulate, synthesize, implement) each
    // produce one evidence summary.
    expect(result.evidence.map(e => e.operation).sort()).toEqual(["implement", "simulate", "synthesize", "validate_sources"]);
    for (const ev of result.evidence) expect(ev.entries.length).toBeGreaterThan(0);

    // Every POST carried Bearer auth + an Idempotency-Key.
    const posts = calls.filter(c => c.method === "POST");
    expect(posts).toHaveLength(4);
    for (const p of posts) {
      expect(p.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
      expect(p.headers["Idempotency-Key"]).toMatch(/^job-[0-9a-f-]{36}$/);
    }
  });

  test("Core 503 on every submit → loop fails closed", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 503, body: { error: { code: "capability_unavailable", message: "draining" } } }));
    const connector = new CoreApiConnector({
      baseUrl: BASE, token: TOKEN, projectId: PROJECT,
      fetchImpl, pollIntervalMs: 0, retryDelayMs: 0, sleep: async () => {},
    });
    const loop = new LoopExecutor({
      model: new ScriptedModel(),
      connector,
      skillPrompts: { rtl: "rtl", tb: "tb", xdc: "xdc", repair: "repair", intake: "intake", behaviorWave: "behavior", architecture: "arch", registerSpec: "reg" },
      part: "xc7k70tfbv676-1", projectId: PROJECT, processInstanceId: "pi-1",
      governance: new NoGovernanceClient(),
      toolModelPolicyHash: "policy-v1",
    });
    const result = await loop.run("counter");
    expect(result.status).toBe("fail_closed");
    // The first tool call (validate_sources) fail-closed with the Core code in audit.
    const submitAudit = result.audit.find(a => a.action === "submit threw");
    expect(submitAudit?.errorCode).toBe("capability_unavailable");
    expect(submitAudit?.result).toBe("fail_closed");
  });
});
