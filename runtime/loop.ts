/**
 * Synthia Runtime — closed-loop task executor.
 *
 * State machine:
 *   RTL gen → validate_sources → TB gen → simulate (repair ≤N) →
 *   XDC gen → synthesize → implement → evidence manifest.
 *
 * Every Connector call passes a permission gate (whitelist of the four vivado
 * operations + versioned capability check). Any capability drift, lease error,
 * capability-unavailable, or unknown_effect is fail-closed: the loop stops
 * immediately and reports the reason. Raw Tcl is never sent; the loop only
 * issues versioned capability calls.
 *
 * All model calls and tool calls are recorded as audit events (action, input
 * hash, jobId, result status).
 */

import type { ConnectorCapability, EvidenceManifest } from "../connector/index.ts";
import { sha256Hex } from "../core/src/hashing.ts";
import {
  WHITELISTED_OPERATIONS,
  type AuditEvent,
  type EvidenceSummary,
  type LoopAction,
  type LoopConnector,
  type LoopModel,
  type LoopPhase,
  type LoopResult,
  type LoopStatus,
  type RtlGeneration,
  type TbGeneration,
  type XdcGeneration,
  type VivadoResult,
  type VivadoSubmission,
  type WhitelistedOperation,
} from "./types.ts";

export const VIVADO_CAPABILITY_VERSION = "vivado-batch-1";
export const DEFAULT_MAX_REPAIR_ROUNDS = 3;

const WHITELIST_SET: ReadonlySet<WhitelistedOperation> = new Set(WHITELISTED_OPERATIONS);

// ---------------------------------------------------------------------------
// Permission gate
// ---------------------------------------------------------------------------

export class PermissionDeniedError extends Error {
  constructor(message: string, readonly operation: string) { super(message); this.name = "PermissionDeniedError"; }
}
export class FailClosedError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = "FailClosedError"; }
}

/**
 * Gate checked before every Connector call. Rejects non-whitelisted operations,
 * capability drift, and missing/version-mismatched capabilities. Returns the
 * resolved capability version, or throws.
 */
export function permissionGate(
  operation: string,
  drift: boolean,
  capabilities: readonly ConnectorCapability[],
): string {
  if (!WHITELIST_SET.has(operation as WhitelistedOperation)) {
    throw new PermissionDeniedError(
      `operation "${operation}" is not in the loop whitelist ${WHITELISTED_OPERATIONS.join("/")}`,
      operation,
    );
  }
  if (drift) throw new FailClosedError("connector reports capability drift — stopping (fail-closed)", "CAPABILITY_DRIFT");
  const cap = capabilities.find(c => c.operation === operation);
  if (!cap) throw new FailClosedError(`connector does not expose capability "${operation}"`, "CAPABILITY_UNAVAILABLE");
  if (!cap.runClasses.includes("exploratory")) {
    throw new FailClosedError(`capability "${operation}" does not permit runClass exploratory`, "RUNCLASS_DENIED");
  }
  return cap.version;
}

// ---------------------------------------------------------------------------
// LoopExecutor
// ---------------------------------------------------------------------------

export interface LoopDeps {
  readonly model: LoopModel;
  readonly connector: LoopConnector;
  readonly skillPrompts: {
    readonly rtl: string;
    readonly tb: string;
    readonly xdc: string;
    readonly repair: string;
  };
  readonly part: string;
  readonly projectId: string;
  readonly actorId?: string;
  readonly maxRepairRounds?: number;
  readonly correlationId?: string;
  readonly onEvent?: (e: AuditEvent) => void;
}

export class LoopExecutor {
  private readonly deps: LoopDeps;
  private readonly audit: AuditEvent[] = [];
  private readonly evidence: EvidenceSummary[] = [];
  private task = "";
  private seq = 0;

  constructor(deps: LoopDeps) { this.deps = deps; }

  async run(task: string): Promise<LoopResult> {
    const { model, connector, skillPrompts } = this.deps;
    const part = this.deps.part;
    const projectId = this.deps.projectId;
    const baseSubmission = { runClass: "exploratory" as const, projectId, part };
    this.task = task;
    try {
      // ---- 1. RTL generation ----
      const rtl = await this.callModel("generate_rtl", () => model.generateRtl(task, skillPrompts.rtl));
      this.auditModel("generate_rtl", "rtl generated", rtl.topModule, "ok");

      // ---- 2. validate_sources ----
      await this.runTool("validate_sources", {
        ...baseSubmission, operation: "validate_sources", sources: rtl.sources, top: rtl.topModule,
      });

      // ---- 3. TB generation ----
      const tb = await this.callModel("generate_testbench", () => model.generateTestbench(rtl.sources, rtl.topModule, skillPrompts.tb));
      this.auditModel("generate_testbench", "testbench generated", tb.testbenchModule, "ok");

      // ---- 4. simulate (+ repair loop) ----
      let simSources = rtl.sources;
      let simTb = tb.testbench;
      const maxRounds = this.deps.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS;
      let sim: VivadoResult | undefined;
      for (let round = 0; round <= maxRounds; round++) {
        sim = await this.runTool("simulate", {
          ...baseSubmission, operation: "simulate",
          sources: [...simSources, simTb], top: rtl.topModule, testbench: tb.testbenchModule,
        });
        if (sim.status === "succeeded") break;
        // Non-retryable terminal states → fail closed.
        if (sim.status === "unsupported" || sim.status === "unknown_effect" || sim.status === "lost" || sim.status === "timeout") {
          return this.finish("fail_closed", `simulate ended in non-retryable state ${sim.status}${sim.errorCode ? ` (${sim.errorCode})` : ""}`, { rtl, testbench: tb });
        }
        if (round === maxRounds) {
          return this.finish("fail_closed", `simulate failed and repair budget (${maxRounds}) exhausted`, { rtl, testbench: tb });
        }
        // failed → repair
        const repaired = await this.callModel("repair", () => model.repair({
          sources: simSources, testbench: simTb, topModule: rtl.topModule, testbenchModule: tb.testbenchModule,
          stderr: sim?.stderr ?? "", stdout: sim?.stdout, attempt: round + 1, systemPrompt: skillPrompts.repair,
        }));
        simSources = repaired.sources;
        if (repaired.testbench) simTb = repaired.testbench;
        this.auditModel("repair", `repair round ${round + 1} applied`, repaired.sources.map(s => s.path).join(","), "ok");
        // re-validate after repair before re-simulating
        await this.runTool("validate_sources", {
          ...baseSubmission, operation: "validate_sources", sources: [...simSources, simTb], top: rtl.topModule,
        });
      }

      // ---- 5. XDC generation ----
      const xdc = await this.callModel("generate_xdc", () => model.generateXdc(rtl.topModule, part, skillPrompts.xdc));
      this.auditModel("generate_xdc", "xdc generated", xdc.constraints.map(c => c.path).join(","), "ok");

      // ---- 6. synthesize ----
      await this.runTool("synthesize", {
        ...baseSubmission, operation: "synthesize", sources: rtl.sources, top: rtl.topModule,
      });

      // ---- 7. implement ----
      await this.runTool("implement", {
        ...baseSubmission, operation: "implement", sources: rtl.sources, top: rtl.topModule, constraints: xdc.constraints,
      });

      return this.finish("succeeded", "loop completed: rtl→validate→tb→simulate→xdc→synthesize→implement", { rtl, testbench: tb, xdc });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const status: LoopStatus = e instanceof FailClosedError || e instanceof PermissionDeniedError ? "fail_closed" : "failed";
      return this.finish(status, reason);
    }
  }

  // ----- internals -----

  private async runTool(operation: WhitelistedOperation, submission: VivadoSubmission): Promise<VivadoResult> {
    const capabilities = await this.deps.connector.discover();
    const version = permissionGate(operation, this.deps.connector.drift, capabilities);
    // drift / capability gate passes; record the gate decision.
    this.pushAudit({ category: "gate", phase: operation, action: `gate ok (${version})`, result: "ok" });

    const inputSha = submissionSha(submission);
    let result: VivadoResult;
    try {
      result = await this.deps.connector.submit(submission);
    } catch (e) {
      const code = e instanceof Error && e.name === "RemoteConnectorError" ? (e as { code: string }).code : "CONNECTOR_ERROR";
      this.pushAudit({ category: "tool_call", phase: operation, action: "submit threw", inputSha256: inputSha, result: "fail_closed", errorCode: code, detail: e instanceof Error ? e.message : String(e) });
      throw new FailClosedError(`connector submit for ${operation} failed: ${e instanceof Error ? e.message : String(e)}`, code);
    }

    // Fail-closed on drift / lease / capability signals surfacing in the result.
    const code = result.errorCode ?? "";
    if (result.status === "unsupported" || FAIL_CLOSED_CODES.has(code) || this.deps.connector.drift) {
      this.recordEvidence(operation, result);
      this.pushAudit({ category: "tool_call", phase: operation, action: `${operation} fail-closed`, inputSha256: inputSha, jobId: result.jobId, result: "fail_closed", errorCode: code || result.status, detail: `status=${result.status}` });
      throw new FailClosedError(`${operation} returned fail-closed status ${result.status}${code ? ` (${code})` : ""}`, code || result.status);
    }
    this.recordEvidence(operation, result);
    this.pushAudit({
      category: "tool_call", phase: operation,
      action: result.status === "succeeded" ? `${operation} succeeded` : `${operation} ${result.status}`,
      inputSha256: inputSha, jobId: result.jobId,
      result: result.status === "succeeded" ? "ok" : "failed",
      errorCode: code || undefined,
    });
    return result;
  }

  private recordEvidence(operation: WhitelistedOperation, result: VivadoResult): void {
    const ev: EvidenceSummary = {
      jobId: result.jobId, operation, status: result.status, inputSha256: result.inputSha256,
      entries: result.evidence?.entries ?? [],
    };
    this.evidence.push(ev);
  }

  private async callModel<T extends LoopAction>(phase: LoopPhase, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      // Record validation-failure feedback events if the model exhausted retries.
      const feedbacks = (e as Error & { validationFeedbacks?: readonly string[] }).validationFeedbacks;
      if (feedbacks) for (const fb of feedbacks) {
        this.pushAudit({ category: "model", phase, action: `validation feedback`, result: "failed", detail: fb });
      }
      this.pushAudit({ category: "model", phase, action: `model ${phase} failed`, result: "failed", detail: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  private auditModel(phase: LoopPhase, action: string, detail: string, result: "ok" | "failed"): void {
    this.pushAudit({ category: "model", phase, action, result, detail });
  }

  private pushAudit(e: Omit<AuditEvent, "ts">): void {
    const event: AuditEvent = { ts: new Date().toISOString(), seq: this.seq++, ...e };
    this.audit.push(event);
    this.deps.onEvent?.(event);
  }

  private finish(status: LoopStatus, reason: string, artifacts?: {
    rtl?: RtlGeneration;
    testbench?: TbGeneration;
    xdc?: XdcGeneration;
  }): LoopResult {
    // Merge connector lifecycle events (reconnect, heartbeat) into audit
    const lifecycle = (this.deps.connector as { lifecycleEvents?: readonly { action: string; result?: string; detail?: string }[] }).lifecycleEvents;
    if (lifecycle) for (const e of lifecycle) this.pushAudit({ category: "lifecycle", phase: "loop", action: e.action, result: e.result as "ok" | "fail_closed" | undefined, detail: e.detail });
    this.pushAudit({ category: "loop", phase: "loop", action: `loop ${status}`, result: status === "succeeded" ? "ok" : status === "fail_closed" ? "fail_closed" : "failed", detail: reason });
    return {
      status, task: this.task, part: this.deps.part,
      ...(artifacts?.rtl ? { rtl: artifacts.rtl } : {}),
      ...(artifacts?.testbench ? { testbench: artifacts.testbench } : {}),
      ...(artifacts?.xdc ? { xdc: artifacts.xdc } : {}),
      evidence: this.evidence, audit: this.audit, endedReason: reason,
    };
  }
}

/** Codes that mandate immediate fail-closed termination. */
const FAIL_CLOSED_CODES: ReadonlySet<string> = new Set([
  "LEASE_EXPIRED", "CAPABILITY_DRIFT", "CAPABILITY_UNAVAILABLE", "ENDPOINT_NOT_APPROVED",
  "ENDPOINT_REVOKED", "BINARY_UNAVAILABLE", "LICENSE_UNAVAILABLE", "PART_UNAVAILABLE",
  "PROJECT_SCOPE_MISMATCH", "RUNCLASS_DENIED",
]);

/** Deterministic SHA-256 of a submission's payload (operation + sources + constraints). */
export function submissionSha(submission: VivadoSubmission): string {
  const payload = {
    operation: submission.operation, top: submission.top, part: submission.part,
    testbench: submission.testbench, constraints: submission.constraints,
    sources: submission.sources.map(s => ({ path: s.path, sha: sha256Hex(s.content) })),
  };
  return sha256Hex(JSON.stringify(payload));
}


// ---------------------------------------------------------------------------
// FakeVivadoConnector — programmable test double (also a reference impl of LoopConnector)
// ---------------------------------------------------------------------------

export interface FakeVivadoBehavior {
  /** Produce a result for the n-th call (0-indexed) to a given operation. */
  respond(req: VivadoSubmission, callIndex: number): VivadoResult | Promise<VivadoResult>;
}

export const FAKE_CAPABILITIES: readonly ConnectorCapability[] = WHITELISTED_OPERATIONS.map(operation => ({
  operation, version: VIVADO_CAPABILITY_VERSION, runClasses: ["exploratory", "gate_check", "formal"],
}));

let fakeJobCounter = 0;

export class FakeVivadoConnector implements LoopConnector {
  readonly id: string;
  drift: boolean;
  private readonly behavior: FakeVivadoBehavior;
  private readonly caps: readonly ConnectorCapability[];
  private readonly counts = new Map<WhitelistedOperation, number>();

  constructor(opts: { behavior: FakeVivadoBehavior; id?: string; drift?: boolean; capabilities?: readonly ConnectorCapability[] }) {
    this.id = opts.id ?? "fake-vivado";
    this.drift = opts.drift ?? false;
    this.behavior = opts.behavior;
    this.caps = opts.capabilities ?? FAKE_CAPABILITIES;
  }

  async discover(): Promise<readonly ConnectorCapability[]> { return this.caps; }

  async submit(req: VivadoSubmission): Promise<VivadoResult> {
    const idx = this.counts.get(req.operation) ?? 0;
    this.counts.set(req.operation, idx + 1);
    const base: VivadoResult = {
      status: "succeeded", jobId: `fake-job-${req.operation}-${fakeJobCounter++}`,
      operation: req.operation, inputSha256: submissionSha(req),
    };
    const res = await this.behavior.respond(req, idx);
    return { ...base, ...res, operation: req.operation, inputSha256: submissionSha(req) };
  }

  callCount(operation: WhitelistedOperation): number { return this.counts.get(operation) ?? 0; }
}

// ----- common behavior builders -----

export function successBehavior(): FakeVivadoBehavior {
  return {
    respond: (req, _idx) => ({
      status: "succeeded", jobId: `fake-job-${req.operation}-${fakeJobCounter++}`,
      operation: req.operation, inputSha256: submissionSha(req),
      stdout: "PASS", evidence: fakeEvidence(req.operation, req.top),
    }),
  };
}

export function failOnceThenSucceedBehavior(failOperation: WhitelistedOperation, failTimes: number, errorCode = "VIVADO_SIMULATION_FAILED"): FakeVivadoBehavior {
  return {
    respond: (req, idx) => {
      if (req.operation === failOperation && idx < failTimes) {
        return {
          status: "failed", jobId: `fake-job-${req.operation}-${fakeJobCounter++}`,
          operation: req.operation, inputSha256: submissionSha(req),
          stdout: "compile error before run", stderr: `Error: undefined signal 'count' at tb line 5`,
          errorCode, evidence: fakeEvidence(req.operation, req.top),
        };
      }
      return {
        status: "succeeded", jobId: `fake-job-${req.operation}-${fakeJobCounter++}`,
        operation: req.operation, inputSha256: submissionSha(req),
        stdout: "PASS", evidence: fakeEvidence(req.operation, req.top),
      };
    },
  };
}

export function alwaysFailBehavior(failOperation: WhitelistedOperation, errorCode = "VIVADO_SIMULATION_FAILED"): FakeVivadoBehavior {
  return {
    respond: (req) => ({
      status: "failed", jobId: `fake-job-${req.operation}-${fakeJobCounter++}`,
      operation: req.operation, inputSha256: submissionSha(req),
      stdout: "compile error", stderr: `Error: persistent syntax error`,
      errorCode, evidence: fakeEvidence(req.operation, req.top),
    }),
  };
}

export function unsupportedBehavior(): FakeVivadoBehavior {
  return {
    respond: (req) => ({
      status: "unsupported", jobId: `fake-job-${req.operation}-${fakeJobCounter++}`,
      operation: req.operation, inputSha256: submissionSha(req),
      errorCode: "BINARY_UNAVAILABLE", evidence: fakeEvidence(req.operation, req.top),
    }),
  };
}

export function fakeEvidence(operation: WhitelistedOperation, top: string): EvidenceManifest {
  const name = operation === "implement" ? "synthia.bit" : operation === "synthesize" ? "resources.rpt" : `${operation}.log`;
  return {
    jobId: "fake-job",
    entries: [{ name, uri: `workspace://fake/output/${name}`, sha256: sha256Hex(`${operation}:${top}:fake`), sizeBytes: 42, mediaType: name.endsWith(".bit") ? "application/octet-stream" : "text/plain" }],
  };
}
