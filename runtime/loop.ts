/**
 * Synthia Runtime — closed-loop task executor with GJB gate flow.
 *
 * Stage chain:
 *   intake → [G1] → behavior_wave → [G2] → architecture → register_spec → [G3]
 *   → rtl_build → validate → tb → simulate (repair ≤N) → xdc → synthesize → implement
 *   → [G4] submit.
 *
 * Doc stages produce markdown candidates registered as ArtifactRevisions via
 * the GovernanceClient. At each gate (G1–G4) the loop:
 *   1. registers all pending candidate revisions,
 *   2. creates a ConfigurationSnapshot,
 *   3. creates a GateSubmission,
 *   4. submits it for review (preparing→in_review),
 *   5. stops in `awaiting_approval` status and persists run-state.
 *
 * The operator approves/rejects via the human-only Core approve endpoint.
 * `--resume <runId>` polls the gate submission state: approved → continue;
 * in_review → still waiting; rejected/withdrawn → fail-closed.
 *
 * Every Connector call passes a permission gate (whitelist + versioned
 * capability check). Capability drift / lease errors / unknown_effect are
 * fail-closed. Raw Tcl is never sent.
 */

import type { ConnectorCapability, EvidenceManifest } from "../connector/index.ts";
import { sha256Hex } from "../core/src/hashing.ts";
import type { ArtifactType, GateId } from "../core/src/domain/enums.ts";
import {
  WHITELISTED_OPERATIONS,
  GJB_GATES,
  GATE_AFTER_STAGE,
  type AuditEvent,
  type DocGeneration,
  type EvidenceContent,
  type EvidenceSummary,
  type GovernanceClient,
  type GjbGate,
  type LoopAction,
  type LoopConnector,
  type LoopModel,
  type LoopPhase,
  type LoopResult,
  type LoopStatus,
  type TerminalCause,
  type RegisteredRevision,
  type RunState,
  type RtlGeneration,
  type StageId,
  type TbGeneration,
  type UpstreamArtifacts,
  type UpstreamSection,
  type XdcGeneration,
  type EvidenceSummary,
  type GovernanceClient,
  type GjbGate,
  type LoopAction,
  type LoopConnector,
  type LoopModel,
  type LoopPhase,
  type LoopResult,
  type LoopStatus,
  type TerminalCause,
  type RegisteredRevision,
  type RunState,
  type RtlGeneration,
  type StageId,
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

export interface LoopDeps {
  readonly model: LoopModel;
  readonly connector: LoopConnector;
  readonly skillPrompts: {
    readonly rtl: string;
    readonly tb: string;
    readonly xdc: string;
    readonly repair: string;
    readonly intake: string;
    readonly behaviorWave: string;
    readonly architecture: string;
    readonly registerSpec: string;
  };
  readonly part: string;
  readonly projectId: string;
  readonly processInstanceId: string;
  readonly governance: GovernanceClient;
  readonly toolModelPolicyHash: string;
  readonly actorId?: string;
  readonly maxRepairRounds?: number;
  readonly correlationId?: string;
  readonly onEvent?: (e: AuditEvent) => void;
  /** Called after each stage boundary / gate stop with the updated RunState. */
  readonly onStateChange?: (state: RunState) => Promise<void>;
  /** Called when the loop pauses at a gate, to print the CLI message. */
  readonly onAwaitingApproval?: (gate: GateId, submissionId: string, runId: string) => void;
}


export class LoopExecutor {
  private readonly deps: LoopDeps;
  private readonly audit: AuditEvent[] = [];
  private readonly evidence: EvidenceSummary[] = [];
  private task = "";
  private seq = 0;
  private runId?: string;
  private runState?: RunState;

  constructor(deps: LoopDeps) { this.deps = deps; }

  /**
   * Execute a fresh run from the intake stage through to G4 submission.
   * The loop pauses at each gate (G1–G4) in `awaiting_approval` status.
   */
  async run(task: string, opts?: { runId?: string; runState?: RunState }): Promise<LoopResult> {
    this.task = task;
    this.runId = opts?.runId;
    this.runState = opts?.runState;
    try {
      if (this.runState && this.runState.status === "awaiting_approval" && this.runState.awaitingGate) {
        // Resume: check the pending gate first.
        return await this.resumeFromGate();
      }
      return await this.executeChain(opts?.runState?.currentStage ?? "intake");
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const status: LoopStatus = e instanceof FailClosedError || e instanceof PermissionDeniedError ? "fail_closed" : "failed";
      return this.finish(status, reason, undefined, "execution_error");
    }
  }

  /**
   * Resume a paused run. Polls the pending gate submission; if approved,
   * continues to the next stage.
   */
  async resume(runState: RunState): Promise<LoopResult> {
    this.task = runState.task;
    this.runId = runState.runId;
    this.runState = runState;
    try {
      return await this.resumeFromGate();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const status: LoopStatus = e instanceof FailClosedError || e instanceof PermissionDeniedError ? "fail_closed" : "failed";
      return this.finish(status, reason, undefined, "execution_error");
    }
  }

  // ----- stage chain -----

  private chainCtx: ChainContext = {
    docs: [],
    docRevisions: {},
    gateSubmissions: {},
  };

  /** Execute stages from `startStage` onward, stopping at the next gate. */
  private async executeChain(startStage: StageId): Promise<LoopResult> {
    const { model, skillPrompts } = this.deps;
    const part = this.deps.part;
    const projectId = this.deps.projectId;
    const baseSubmission = { runClass: "exploratory" as const, projectId, part };

    // Determine starting point in the ordered stage list.
    const STAGES: readonly StageId[] = [
      "intake", "behavior_wave", "architecture", "register_spec",
      "rtl_build", "validate", "tb", "simulate", "xdc", "synthesize", "implement",
    ];
    let idx = STAGES.indexOf(startStage);
    if (idx < 0) idx = 0;

    for (; idx < STAGES.length; idx++) {
      const stage = STAGES[idx]!;
      await this.updateState({ currentStage: stage, status: "running" });

      switch (stage) {
        case "intake": {
          const doc = await this.callModel("generate_intake", () => model.generateIntake(this.task, skillPrompts.intake));
          this.chainCtx.docs.push(doc);
          this.auditModel("generate_intake", `intake doc generated: ${doc.docPath}`, doc.docPath, "ok");
          await this.registerDocArtifact(stage, doc, "DEVELOPMENT_REQUIREMENTS");
          break;
        }
        case "behavior_wave": {
          const doc = await this.callModel("generate_behavior_wave", () => model.generateBehaviorWave(skillPrompts.behaviorWave, this.upstreamFor("behavior_wave")));
          this.chainCtx.docs.push(doc);
          this.auditModel("generate_behavior_wave", `behavior/wave doc generated: ${doc.docPath}`, doc.docPath, "ok");
          await this.registerDocArtifact(stage, doc, "DETAILED_DESIGN");
          break;
        }
        case "architecture": {
          const doc = await this.callModel("generate_architecture", () => model.generateArchitecture(skillPrompts.architecture, this.upstreamFor("architecture")));
          this.chainCtx.docs.push(doc);
          this.auditModel("generate_architecture", `architecture doc generated: ${doc.docPath}`, doc.docPath, "ok");
          await this.registerDocArtifact(stage, doc, "ARCHITECTURE_DESIGN");
          break;
        }
        case "register_spec": {
          const doc = await this.callModel("generate_register_spec", () => model.generateRegisterSpec(skillPrompts.registerSpec, this.upstreamFor("register_spec")));
          this.chainCtx.docs.push(doc);
          this.auditModel("generate_register_spec", `register spec doc generated: ${doc.docPath}`, doc.docPath, "ok");
          await this.registerDocArtifact(stage, doc, "DETAILED_DESIGN");
          break;
        }
        case "rtl_build": {
          this.chainCtx.rtl = await this.callModel("generate_rtl", () => model.generateRtl(this.task, skillPrompts.rtl, this.upstreamFor("rtl_build")));
          this.auditModel("generate_rtl", "rtl generated", this.chainCtx.rtl.topModule, "ok");
          await this.registerRtlArtifact();
          break;
        }
        case "validate": {
          if (!this.chainCtx.rtl) throw new FailClosedError("validate stage reached without RTL", "STATE_ERROR");
          await this.runTool("validate_sources", {
            ...baseSubmission, operation: "validate_sources", sources: this.chainCtx.rtl.sources, top: this.chainCtx.rtl.topModule,
          });
          break;
        }
        case "tb": {
          if (!this.chainCtx.rtl) throw new FailClosedError("tb stage reached without RTL", "STATE_ERROR");
          this.chainCtx.tb = await this.callModel("generate_testbench", () => model.generateTestbench(this.chainCtx.rtl!.sources, this.chainCtx.rtl!.topModule, skillPrompts.tb, this.upstreamFor("tb")));
          this.auditModel("generate_testbench", "testbench generated", this.chainCtx.tb.testbenchModule, "ok");
          break;
        }
        case "simulate": {
          if (!this.chainCtx.rtl || !this.chainCtx.tb) throw new FailClosedError("simulate stage reached without RTL+TB", "STATE_ERROR");
          await this.runSimulateLoop(baseSubmission);
          break;
        }
        case "xdc": {
          if (!this.chainCtx.rtl) throw new FailClosedError("xdc stage reached without RTL", "STATE_ERROR");
          this.chainCtx.xdc = await this.callModel("generate_xdc", () => model.generateXdc(this.chainCtx.rtl!.topModule, part, skillPrompts.xdc, false, this.upstreamFor("xdc")));
          break;
        }
        case "synthesize": {
          if (!this.chainCtx.rtl) throw new FailClosedError("synthesize stage reached without RTL", "STATE_ERROR");
          const synth = await this.runTool("synthesize", {
            ...baseSubmission, operation: "synthesize", sources: this.chainCtx.rtl.sources, top: this.chainCtx.rtl.topModule,
          });
          if (synth.status !== "succeeded") {
            return this.finish("fail_closed", `synthesize ended in non-success state ${synth.status}${synth.errorCode ? ` (${synth.errorCode})` : ""}`, this.toolArtifacts(), "execution_error");
          }
          break;
        }
        case "implement": {
          if (!this.chainCtx.rtl || !this.chainCtx.xdc) throw new FailClosedError("implement stage reached without RTL+XDC", "STATE_ERROR");
          const impl = await this.runTool("implement", {
            ...baseSubmission, operation: "implement", sources: this.chainCtx.rtl.sources, top: this.chainCtx.rtl.topModule, constraints: this.chainCtx.xdc.constraints,
          });
          if (impl.status !== "succeeded") {
            return this.finish("fail_closed", `implement ended in non-success state ${impl.status}${impl.errorCode ? ` (${impl.errorCode})` : ""}`, this.toolArtifacts(), "execution_error");
          }
          break;
        }
      }

      // Persist chain context after every stage so a mid-tool-stage crash
      // can resume with the actual RTL/TB/XDC content.
      await this.syncChainContextToState({});

      // Check if a gate follows this stage.
      const gate = this.gateAfterStage(stage);
      if (gate) {
        const result = await this.handleGate(gate);
        if (result) return result; // paused at gate or terminal
      }
    }

    return this.finish("succeeded", "loop completed: full GJB stage chain (intake→…→implement) all gates approved", this.allArtifacts());
  }

  /** Simulate with repair loop (≤N rounds). */
  private async runSimulateLoop(baseSubmission: { runClass: "exploratory"; projectId: string; part: string }): Promise<void> {
    const { model, skillPrompts } = this.deps;
    const rtl = this.chainCtx.rtl!;
    const tb = this.chainCtx.tb!;
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
      if (sim.status === "unsupported" || sim.status === "unknown_effect" || sim.status === "lost" || sim.status === "timeout") {
        this.finish("fail_closed", `simulate ended in non-retryable state ${sim.status}${sim.errorCode ? ` (${sim.errorCode})` : ""}`, this.toolArtifacts());
        throw new FailClosedError(`simulate ended in non-retryable state ${sim.status}`, sim.errorCode ?? sim.status);
      }
      if (round === maxRounds) {
        throw new FailClosedError(`simulate failed and repair budget (${maxRounds}) exhausted`, "REPAIR_BUDGET_EXHAUSTED");
      }
      const diag = await this.fetchFailureDiagnostics(sim);
      this.pushAudit({ category: "tool_call", phase: "repair", action: `diagnostics_fetched=${diag.diagnosticsFetched}`, jobId: sim.jobId, result: "ok", detail: diag.diagnosticsFetched ? "worker-result.json content injected into repair prompt" : "degraded: bare result fields only" });
      const repaired = await this.callModel("repair", () => model.repair({
        sources: simSources, testbench: simTb, topModule: rtl.topModule, testbenchModule: tb.testbenchModule,
        stderr: diag.stderr, stdout: diag.stdout, attempt: round + 1, systemPrompt: skillPrompts.repair,
      }));
      simSources = repaired.sources;
      if (repaired.testbench) simTb = repaired.testbench;
      this.auditModel("repair", `repair round ${round + 1} applied`, repaired.sources.map(s => s.path).join(","), "ok");
      await this.runTool("validate_sources", {
        ...baseSubmission, operation: "validate_sources", sources: [...simSources, simTb], top: rtl.topModule,
      });
    }
  }

  // ----- gate management -----

  /** Determine which gate (if any) follows the given stage. */
  private gateAfterStage(stage: StageId): GjbGate | undefined {
    for (const g of GJB_GATES) {
      if (GATE_AFTER_STAGE[g] === stage) return g;
    }
    return undefined;
  }

  /**
   * At a gate: register pending revisions → snapshot → submission → submit →
   * persist run-state → pause in awaiting_approval.
   * Returns a LoopResult when the loop should pause or terminate; returns
   * undefined to continue (gate already approved, e.g. --no-governance).
   */
  private async handleGate(gate: GjbGate): Promise<LoopResult | undefined> {
    const gov = this.deps.governance;
    // Content-conformity static gate (G3/G4): block submission of off-topic or
    // name/port-inconsistent artifacts. Failures trigger a repair loop; over the
    // budget the loop fails closed. Runs before governance snapshot creation.
    const conformity = await this.runContentConformityGate(gate);
    if (conformity) return conformity;
    // Collect revisions for this gate's snapshot.
    const memberRevs = this.revisionsForGate(gate);
    if (memberRevs.length === 0) return undefined; // nothing to review

    this.pushAudit({ category: "gate", phase: "gate_review", action: `${gate}: creating snapshot (${memberRevs.length} revisions)`, result: "ok" });
    const { snapshotId } = await gov.createSnapshot({
      memberRevisionIds: memberRevs,
      toolModelPolicyHash: this.deps.toolModelPolicyHash,
    });

    const { submissionId } = await gov.createGateSubmission({
      processInstanceId: this.deps.processInstanceId,
      gate,
      snapshotId,
    });
    this.chainCtx.gateSubmissions[gate] = submissionId;

    this.pushAudit({ category: "gate", phase: "gate_review", action: `${gate}: submitting for review`, result: "ok", detail: submissionId });
    const { state: submitState } = await gov.submitGate(submissionId);

    if (submitState === "approved") {
      // --no-governance auto-approves; continue immediately.
      this.pushAudit({ category: "gate", phase: "gate_review", action: `${gate}: auto-approved (no-governance)`, result: "ok" });
      return undefined;
    }

    // Pause: sync ALL chain context into run-state before persisting.
    await this.syncChainContextToState({ status: "awaiting_approval", awaitingGate: gate });
    this.deps.onAwaitingApproval?.(gate, submissionId, this.runId ?? "unknown");
    this.pushAudit({ category: "gate", phase: "gate_review", action: `${gate}: awaiting human approval`, result: "ok", detail: `submission=${submissionId} run=${this.runId}` });
    return this.finishAwaiting(gate, submissionId);
  }

  /**
   * On resume: poll the pending gate. If approved, continue the chain.
   * If rejected/withdrawn, fail-closed. If still in_review, return awaiting.
   */
  private async resumeFromGate(): Promise<LoopResult> {
    if (!this.runState?.awaitingGate) {
      this.restoreChainContext();
      return await this.executeChain(this.runState?.currentStage ?? "intake");
    }
    const gate = this.runState.awaitingGate;
    const submissionId = this.runState.gateSubmissions?.[gate];
    if (!submissionId) {
      return this.finish("failed", `resume: no submission id for pending gate ${gate}`);
    }

    this.pushAudit({ category: "gate", phase: "gate_review", action: `${gate}: polling approval status`, result: "ok", detail: submissionId });
    const { state } = await this.deps.governance.getGateSubmissionState(submissionId);

    if (state === "approved") {
      this.pushAudit({ category: "gate", phase: "gate_review", action: `${gate}: approved — continuing`, result: "ok" });
      // Restore chain context from run-state.
      this.restoreChainContext();
      // Move to the stage AFTER the gate.
      const nextStage = this.stageAfterGate(gate);
      await this.updateState({ status: "running", awaitingGate: undefined });
      if (!nextStage) {
        return this.finish("succeeded", `all gates approved (resumed from ${gate})`, this.allArtifacts());
      }
      return await this.executeChain(nextStage);
    }
    if (state === "rejected" || state === "withdrawn") {
      this.pushAudit({ category: "gate", phase: "gate_review", action: `${gate}: ${state} — fail-closed`, result: "fail_closed", detail: submissionId });
      return this.finish("fail_closed", `gate ${gate} was ${state} — stopping (fail-closed)`, this.allArtifacts(), "governance_rejected");
    }
    // Still in_review / preparing / checking — still waiting.
    this.deps.onAwaitingApproval?.(gate, submissionId, this.runId ?? "unknown");
    return this.finishAwaiting(gate, submissionId);
  }

  /** Determine the stage that follows a gate. */
  private stageAfterGate(gate: GjbGate): StageId | undefined {
    switch (gate) {
      case "G1": return "behavior_wave";
      case "G2": return "architecture";
      case "G3": return "rtl_build";
      case "G4": return undefined; // terminal
    }
  }

  /** Which registered revisions belong in a gate's snapshot. */
  private revisionsForGate(gate: GjbGate): string[] {
    const revs: string[] = [];
    switch (gate) {
      case "G1":
        if (this.chainCtx.docRevisions.intake) revs.push(this.chainCtx.docRevisions.intake.revisionId);
        break;
      case "G2":
        if (this.chainCtx.docRevisions.behavior_wave) revs.push(this.chainCtx.docRevisions.behavior_wave.revisionId);
        break;
      case "G3":
        if (this.chainCtx.docRevisions.architecture) revs.push(this.chainCtx.docRevisions.architecture.revisionId);
        if (this.chainCtx.docRevisions.register_spec) revs.push(this.chainCtx.docRevisions.register_spec.revisionId);
        break;
      case "G4":
        if (this.chainCtx.rtlRevision) revs.push(this.chainCtx.rtlRevision.revisionId);
        // Also include all doc revisions for final review.
        for (const key of ["intake", "behavior_wave", "architecture", "register_spec"] as const) {
          const r = this.chainCtx.docRevisions[key];
          if (r) revs.push(r.revisionId);
        }
        break;
    }
    return revs;
  }

  // ----- artifact registration -----

  private async registerDocArtifact(stage: StageId, doc: DocGeneration, artifactType: ArtifactType): Promise<void> {
    if (!this.deps.governance) return;
    const artifactId = `art-${stage}-${sha256Hex(`${this.runId ?? ""}:${this.task}`).slice(0, 8)}`;
    const version = (this.chainCtx.docRevisions[stage]?.version ?? 0) + 1;
    const raw = await this.deps.governance.registerCandidateArtifact({
      artifactId,
      artifactType,
      title: `${stage} document`,
      content: doc.content,
      contentLocation: doc.docPath,
      changeReason: `Generated by ${doc.phase}`,
      version,
    });
    const rev: RegisteredRevision = { ...raw, contentLocation: doc.docPath };
    this.chainCtx.docRevisions[stage] = rev;
    this.pushAudit({ category: "governance", phase: "governance", action: `registered ${stage} artifact: ${rev.revisionId}`, result: "ok", detail: `type=${artifactType} path=${doc.docPath}` });
    await this.updateState({ docs: { ...this.runState?.docs, [stage]: rev } });
  }

  private async registerRtlArtifact(): Promise<void> {
    if (!this.deps.governance || !this.chainCtx.rtl) return;
    const artifactId = `art-rtl-${sha256Hex(`${this.runId ?? ""}:${this.task}`).slice(0, 8)}`;
    const content = this.chainCtx.rtl.sources.map(s => s.content).join("\n");
    const version = (this.chainCtx.rtlRevision?.version ?? 0) + 1;
    const raw = await this.deps.governance.registerCandidateArtifact({
      artifactId,
      artifactType: "RTL_SOURCE_SET",
      title: `RTL top=${this.chainCtx.rtl.topModule}`,
      content,
      contentLocation: `rtl/${this.chainCtx.rtl.sources[0]?.path ?? "top.v"}`,
      changeReason: "Generated by rtl_build stage",
      version,
    });
    const rev: RegisteredRevision = { ...raw, contentLocation: `rtl/${this.chainCtx.rtl.sources[0]?.path ?? "top.v"}` };
    this.chainCtx.rtlRevision = rev;
    this.pushAudit({ category: "governance", phase: "governance", action: `registered RTL artifact: ${rev.revisionId}`, result: "ok", detail: `top=${this.chainCtx.rtl.topModule}` });
    await this.updateState({ rtlRevision: rev });
  }

  // ----- run-state persistence -----

  private async updateState(patch: Partial<RunState>): Promise<void> {
    if (!this.runState || !this.deps.onStateChange) return;
    this.runState = { ...this.runState, ...patch, updatedAt: new Date().toISOString() };
    await this.deps.onStateChange(this.runState);
  }

  /**
   * Sync the full in-memory chain context (doc revisions, gate submissions,
   * RTL revision, current stage) into run-state, then persist. Called at
   * gate-pause boundaries so --resume has everything it needs.
   */
  private async syncChainContextToState(extra: Partial<RunState>): Promise<void> {
    if (!this.runState || !this.deps.onStateChange) return;
    const docs: Record<string, RegisteredRevision> = {};
    for (const [stage, rev] of Object.entries(this.chainCtx.docRevisions)) {
      if (rev) docs[stage] = rev;
    }
    const gateSubs: Record<string, string> = {};
    for (const [gate, subId] of Object.entries(this.chainCtx.gateSubmissions)) {
      if (subId) gateSubs[gate] = subId;
    }
    this.runState = {
      ...this.runState,
      ...extra,
      docs,
      gateSubmissions: gateSubs,
      ...(this.chainCtx.rtlRevision ? { rtlRevision: this.chainCtx.rtlRevision } : {}),
      ...(this.chainCtx.rtl ? { rtlArtifacts: { topModule: this.chainCtx.rtl.topModule, sources: this.chainCtx.rtl.sources } } : {}),
      ...(this.chainCtx.tb ? { tbArtifacts: { testbenchModule: this.chainCtx.tb.testbenchModule, testbench: this.chainCtx.tb.testbench } } : {}),
      ...(this.chainCtx.xdc ? { xdcArtifacts: { constraints: this.chainCtx.xdc.constraints } } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.deps.onStateChange(this.runState);
  }
  private restoreChainContext(): void {
    if (!this.runState) return;
    if (this.runState.docs) {
      for (const [stage, rev] of Object.entries(this.runState.docs)) {
        if (rev) this.chainCtx.docRevisions[stage as StageId] = rev;
      }
    }
    if (this.runState.rtlRevision) {
      this.chainCtx.rtlRevision = this.runState.rtlRevision;
    }
    if (this.runState.rtlArtifacts) {
      this.chainCtx.rtl = { phase: "generate_rtl", reasoning: "restored from run-state", topModule: this.runState.rtlArtifacts.topModule, sources: this.runState.rtlArtifacts.sources };
    }
    if (this.runState.tbArtifacts) {
      this.chainCtx.tb = { phase: "generate_testbench", reasoning: "restored from run-state", testbenchModule: this.runState.tbArtifacts.testbenchModule, testbench: this.runState.tbArtifacts.testbench };
    }
    if (this.runState.xdcArtifacts) {
      this.chainCtx.xdc = { phase: "generate_xdc", reasoning: "restored from run-state", constraints: this.runState.xdcArtifacts.constraints };
    }
    if (this.runState.gateSubmissions) {
      for (const [gate, subId] of Object.entries(this.runState.gateSubmissions)) {
        if (subId) this.chainCtx.gateSubmissions[gate as GjbGate] = subId;
      }
    }
  }

  /**
   * Build the per-stage upstream artifact sections per the loop contract:
   *   behavior_wave  ← intake
   *   architecture   ← intake + behavior_wave
   *   register_spec  ← intake + behavior_wave + architecture
   *   rtl_build      ← all four docs (≥ architecture port contract + register table)
   *   tb             ← behavior_wave scenario matrix (RTL is passed as the primary arg)
   *   xdc            ← architecture clock/reset strategy
   */
  private upstreamFor(stage: StageId): UpstreamArtifacts | undefined {
    const doc = (phase: LoopPhase) => this.chainCtx.docs.find(d => d.phase === phase);
    const sections: UpstreamSection[] = [];
    switch (stage) {
      case "behavior_wave": {
        const i = doc("generate_intake");
        if (i) sections.push({ label: "Intake 需求摘要", content: i.content });
        break;
      }
      case "architecture": {
        const i = doc("generate_intake");
        const b = doc("generate_behavior_wave");
        if (i) sections.push({ label: "Intake 需求摘要", content: i.content });
        if (b) sections.push({ label: "Behavior/Wave 场景矩阵", content: b.content });
        break;
      }
      case "register_spec": {
        const i = doc("generate_intake");
        const b = doc("generate_behavior_wave");
        const a = doc("generate_architecture");
        if (i) sections.push({ label: "Intake 需求摘要", content: i.content });
        if (b) sections.push({ label: "Behavior/Wave 场景矩阵", content: b.content });
        if (a) sections.push({ label: "Architecture 端口契约 / 模块划分", content: a.content });
        break;
      }
      case "rtl_build": {
        for (const d of this.chainCtx.docs) sections.push({ label: d.docPath, content: d.content });
        break;
      }
      case "tb": {
        const b = doc("generate_behavior_wave");
        if (b) sections.push({ label: "Behavior/Wave 场景矩阵（测试场景来源）", content: b.content });
        break;
      }
      case "xdc": {
        const a = doc("generate_architecture");
        if (a) sections.push({ label: "Architecture 时钟 / 复位策略", content: a.content });
        break;
      }
      default:
        break;
    }
    return sections.length > 0 ? sections : undefined;
  }

  // ----- content-conformity gate (G3/G4) -----

  /**
   * Static content-conformity gate run before G3/G4 submission. Checks topic,
   * name, and port consistency. On failure, regenerates the offending artifact
   * (doc at G3 / RTL at G4) with a feedback section and re-checks, up to the
   * repair budget. Over the budget → fail-closed. Returns a terminal LoopResult
   * on fail-closed, or undefined to proceed.
   */
  private async runContentConformityGate(gate: GjbGate): Promise<LoopResult | undefined> {
    if (gate !== "G3" && gate !== "G4") return undefined;
    const maxRounds = this.deps.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS;
    for (let round = 0; round <= maxRounds; round++) {
      const check = this.checkContentConformity(gate);
      if (check.ok) {
        if (round > 0) {
          this.pushAudit({ category: "gate", phase: "gate_review", action: `content_conformity ${gate} passed after ${round} repair round(s)`, result: "ok" });
        }
        return undefined;
      }
      this.pushAudit({ category: "gate", phase: "gate_review", action: `content_conformity ${gate} failed (round ${round + 1})`, result: "failed", detail: check.problems.join("; ") });
      if (round === maxRounds) {
        return this.finish("fail_closed", `content conformity failed at ${gate} after ${maxRounds} repair round(s): ${check.problems.join("; ")}`, this.allArtifacts(), "execution_error");
      }
      await this.repairContentConformity(gate, check);
    }
    return undefined;
  }

  /** Run the static checks for the given gate. */
  private checkContentConformity(gate: GjbGate): ConformityResult {
    const problems: string[] = [];
    const failingDocPhases: LoopPhase[] = [];
    const intake = this.chainCtx.docs.find(d => d.phase === "generate_intake");
    const keywords = extractTopicKeywords(this.task, intake?.content ?? "");

    if (gate === "G3") {
      // Topic consistency: every submitted downstream doc must mention ≥1 task keyword.
      for (const phase of ["generate_architecture", "generate_register_spec"] as const) {
        const d = this.chainCtx.docs.find(x => x.phase === phase);
        if (!d) continue;
        if (keywords.length > 0 && !keywords.some(k => d.content.toLowerCase().includes(k))) {
          problems.push(`topic: ${phase} "${d.docPath}" mentions none of the task keywords [${keywords.join(", ")}] — likely off-topic`);
          failingDocPhases.push(phase);
        }
      }
    }

    if (gate === "G4") {
      const rtl = this.chainCtx.rtl;
      if (rtl) {
        const rtlText = rtl.sources.map(s => s.content).join("\n").toLowerCase();
        // (a) Topic consistency in RTL.
        if (keywords.length > 0 && !keywords.some(k => rtlText.includes(k))) {
          problems.push(`topic: RTL mentions none of the task keywords [${keywords.join(", ")}] — likely off-topic (top=${rtl.topModule})`);
        }
        // (b) Name consistency: RTL top module must appear in architecture + register_spec docs.
        const topLower = rtl.topModule.toLowerCase();
        const arch = this.chainCtx.docs.find(d => d.phase === "generate_architecture");
        const reg = this.chainCtx.docs.find(d => d.phase === "generate_register_spec");
        if (arch && !arch.content.toLowerCase().includes(topLower)) {
          problems.push(`name: RTL top module "${rtl.topModule}" not found in architecture doc "${arch.docPath}"`);
        }
        if (reg && !reg.content.toLowerCase().includes(topLower)) {
          problems.push(`name: RTL top module "${rtl.topModule}" not found in register_spec doc "${reg.docPath}"`);
        }
        // (c) Port consistency: RTL top ports must appear in the architecture interface doc.
        if (arch) {
          const ports = extractModulePorts(rtl.sources.map(s => s.content).join("\n"), rtl.topModule).filter(p => p.length >= 2);
          const archLower = arch.content.toLowerCase();
          const missing = ports.filter(p => !archLower.includes(p.toLowerCase()));
          if (missing.length > 0) {
            problems.push(`port: RTL top "${rtl.topModule}" ports [${missing.join(", ")}] not found in architecture interface doc "${arch.docPath}"`);
          }
        }
      }
    }

    return problems.length === 0 ? { ok: true, problems: [] } : { ok: false, problems, failingDocPhases };
  }

  /** Regenerate the offending artifact(s) carrying the conformity feedback. */
  private async repairContentConformity(gate: GjbGate, check: ConformityResult): Promise<void> {
    const feedback: UpstreamSection = {
      label: "符合性修复反馈 (Conformity Feedback)",
      content: `上一次输出未通过内容符合性门禁，必须修正后重新生成。具体问题：\n- ${check.problems.join("\n- ")}`,
    };
    if (gate === "G3") {
      for (const phase of check.failingDocPhases) {
        if (phase === "generate_architecture" || phase === "generate_register_spec" || phase === "generate_behavior_wave") {
          await this.regenerateDoc(phase, feedback);
        }
      }
    } else if (gate === "G4") {
      await this.regenerateRtl(feedback);
    }
  }

  /** Re-run a doc-generation phase with upstream + feedback and replace the doc. */
  private async regenerateDoc(phase: "generate_behavior_wave" | "generate_architecture" | "generate_register_spec", feedback: UpstreamSection): Promise<void> {
    const { model, skillPrompts } = this.deps;
    const stage: StageId = phase === "generate_behavior_wave" ? "behavior_wave" : phase === "generate_architecture" ? "architecture" : "register_spec";
    const base = this.upstreamFor(stage);
    const upstream: UpstreamArtifacts = base && base.length > 0 ? [...base, feedback] : [feedback];
    const doc = await this.callModel(phase, () => {
      if (phase === "generate_behavior_wave") return model.generateBehaviorWave(skillPrompts.behaviorWave, upstream);
      if (phase === "generate_architecture") return model.generateArchitecture(skillPrompts.architecture, upstream);
      return model.generateRegisterSpec(skillPrompts.registerSpec, upstream);
    });
    const idx = this.chainCtx.docs.findIndex(d => d.phase === phase);
    if (idx >= 0) this.chainCtx.docs[idx] = doc; else this.chainCtx.docs.push(doc);
    this.auditModel(phase, `conformity repair: regenerated ${doc.docPath}`, doc.docPath, "ok");
    const artifactType: ArtifactType = stage === "architecture" ? "ARCHITECTURE_DESIGN" : "DETAILED_DESIGN";
    await this.registerDocArtifact(stage, doc, artifactType);
  }

  /** Re-run RTL generation with upstream + feedback and replace the RTL. */
  private async regenerateRtl(feedback: UpstreamSection): Promise<void> {
    const { model, skillPrompts } = this.deps;
    const base = this.upstreamFor("rtl_build");
    const upstream: UpstreamArtifacts = base && base.length > 0 ? [...base, feedback] : [feedback];
    const rtl = await this.callModel("generate_rtl", () => model.generateRtl(this.task, skillPrompts.rtl, upstream));
    this.chainCtx.rtl = rtl;
    this.auditModel("generate_rtl", `conformity repair: regenerated RTL top=${rtl.topModule}`, rtl.topModule, "ok");
    await this.registerRtlArtifact();
  }

  // ----- tool execution (unchanged mechanics) -----

  private async runTool(operation: WhitelistedOperation, submission: VivadoSubmission): Promise<VivadoResult> {
    const capabilities = await this.deps.connector.discover();
    const version = permissionGate(operation, this.deps.connector.drift, capabilities);
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
    this.evidence.push({
      jobId: result.jobId, operation, status: result.status, inputSha256: result.inputSha256,
      entries: result.evidence?.entries ?? [],
    });
  }

  /**
   * Fetch the worker-result.json evidence content for a failed job and extract
   * its diagnostic fields (exitCode/phase/stdout/stderr) to feed the repair
   * model a richer "失败诊断" section than the bare VivadoResult. Degrades
   * gracefully: no matching evidence entry, fetch error, or parse error →
   * returns the bare result fields with diagnosticsFetched=false (existing
   * behavior). The `diagnostics_fetched` flag is surfaced via the returned
   * tuple so the caller can audit it.
   */
  private async fetchFailureDiagnostics(
    result: VivadoResult,
  ): Promise<{ stdout: string; stderr: string; diagnosticsFetched: boolean }> {
    const fallback = { stdout: result.stdout ?? "", stderr: result.stderr ?? "", diagnosticsFetched: false };
    const entry = result.evidence?.entries.find((e) => e.name === WORKER_RESULT_NAME);
    if (!entry) return fallback;
    try {
      const content = await this.deps.connector.fetchEvidenceContent(result.jobId, WORKER_RESULT_NAME);
      const parsed = JSON.parse(content.content) as Partial<WorkerResultPayload>;
      return {
        ...renderFailureDiagnostics(parsed),
        diagnosticsFetched: true,
      };
    } catch {
      return fallback;
    }
  }

  private async callModel<T extends LoopAction>(phase: LoopPhase, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
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

  private pushAudit(e: Omit<AuditEvent, "ts" | "seq">): void {
    const event: AuditEvent = { ts: new Date().toISOString(), seq: this.seq++, ...e };
    this.audit.push(event);
    this.deps.onEvent?.(event);
  }

  private toolArtifacts(): { rtl?: RtlGeneration; testbench?: TbGeneration; xdc?: XdcGeneration } {
    return {
      ...(this.chainCtx.rtl ? { rtl: this.chainCtx.rtl } : {}),
      ...(this.chainCtx.tb ? { testbench: this.chainCtx.tb } : {}),
      ...(this.chainCtx.xdc ? { xdc: this.chainCtx.xdc } : {}),
    };
  }

  private allArtifacts(): { rtl?: RtlGeneration; testbench?: TbGeneration; xdc?: XdcGeneration; docs?: DocGeneration[] } {
    return {
      ...this.toolArtifacts(),
      ...(this.chainCtx.docs.length > 0 ? { docs: [...this.chainCtx.docs] } : {}),
    };
  }

  private finishAwaiting(gate: GjbGate, submissionId: string): LoopResult {
    this.pushAudit({ category: "loop", phase: "loop", action: `loop paused at ${gate}`, result: "ok", detail: `awaiting human approval, submission=${submissionId}` });
    return {
      status: "failed", task: this.task, part: this.deps.part,
      ...this.allArtifacts(),
      evidence: this.evidence, audit: this.audit,
      endedReason: `awaiting GJB gate ${gate} approval (submission ${submissionId})`,
      ...(this.runId ? { runId: this.runId } : {}),
      awaitingGate: gate,
    };
  }

  private finish(status: LoopStatus, reason: string, artifacts?: {
    rtl?: RtlGeneration; testbench?: TbGeneration; xdc?: XdcGeneration; docs?: DocGeneration[];
  }, cause?: TerminalCause): LoopResult {
    const lifecycle = (this.deps.connector as { lifecycleEvents?: readonly { action: string; result?: string; detail?: string }[] }).lifecycleEvents;
    if (lifecycle) for (const e of lifecycle) this.pushAudit({ category: "lifecycle", phase: "loop", action: e.action, result: e.result as "ok" | "fail_closed" | undefined, detail: e.detail });
    this.pushAudit({ category: "loop", phase: "loop", action: `loop ${status}`, result: status === "succeeded" ? "ok" : status === "fail_closed" ? "fail_closed" : "failed", detail: reason });
    return {
      status, task: this.task, part: this.deps.part,
      ...(artifacts?.rtl ? { rtl: artifacts.rtl } : {}),
      ...(artifacts?.testbench ? { testbench: artifacts.testbench } : {}),
      ...(artifacts?.xdc ? { xdc: artifacts.xdc } : {}),
      ...(artifacts?.docs ? { docs: artifacts.docs } : {}),
      evidence: this.evidence, audit: this.audit, endedReason: reason,
      ...(cause ? { terminalCause: cause } : {}),
      ...(this.runId ? { runId: this.runId } : {}),
    };
  }
}

interface ChainContext {
  docs: DocGeneration[];
  docRevisions: Partial<Record<StageId, RegisteredRevision>>;
  gateSubmissions: Partial<Record<GjbGate, string>>;
  rtl?: RtlGeneration;
  tb?: TbGeneration;
  xdc?: XdcGeneration;
  rtlRevision?: RegisteredRevision;
}
/** Result of a content-conformity check. */
interface ConformityResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
  /** Doc phases that failed the topic check (G3 repair target). */
  readonly failingDocPhases: readonly LoopPhase[];
}

// ---------------------------------------------------------------------------
// Content-conformity extraction helpers (module-level, exported for unit tests)
// ---------------------------------------------------------------------------
/** Generic English function words and HDL syntax keywords that are never
 *  distinctive topic keywords. Domain words (uart, counter, fifo, …) are
 *  intentionally NOT filtered so real topic drift is caught. */
const KEYWORD_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "were", "not", "but", "all", "any",
  "has", "had", "its", "our", "you", "her", "him", "she", "his", "their", "one", "two", "three", "put",
  "get", "set", "use", "used", "using", "via", "per", "into", "onto", "over", "under", "new", "old",
  "bit", "bits", "design", "module", "modules", "top", "system", "logic",
  "input", "output", "inout", "wire", "reg", "signed", "unsigned", "port", "ports", "signal", "signals",
  "fpga", "verilog", "systemverilog", "hdl", "rtl",
]);

/**
 * Extract distinctive topic keywords (lowercased Latin identifiers ≥3 chars)
 * from the task and intake summary. Generic HDL/English words are filtered.
 * Returns [] when no Latin signal exists (e.g. a CJK-only task) — in which case
 * the topic check is skipped (no false positive on a missing signal).
 */
export function extractTopicKeywords(...sources: string[]): string[] {
  const words = new Set<string>();
  const re = /[A-Za-z][A-Za-z0-9_]{2,}/g;
  for (const src of sources) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      const w = m[0]!.toLowerCase();
      if (!KEYWORD_STOPWORDS.has(w)) words.add(w);
    }
  }
  return [...words];
}

/** Verilog/SystemVerilog type/direction words to exclude from port-name extraction. */
const VERILOG_TYPE_WORDS: ReadonlySet<string> = new Set([
  "wire", "reg", "logic", "signed", "unsigned", "input", "output", "inout", "tri",
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Best-effort extraction of the top-level module's port names from RTL source
 * text. Handles ANSI-style port lists (`module top(input clk, output [7:0] data);`)
 * and falls back to a bare-name list (`module top(clk, rst, data);`). Returns []
 * when the module header or port list cannot be located (the port check is then
 * skipped — leniency over a false alarm).
 */
export function extractModulePorts(content: string, topModule: string): string[] {
  const headerRe = new RegExp(`\\bmodule\\s+${escapeRegex(topModule)}\\b([\\s\\S]*?);`, "m");
  const m = content.match(headerRe);
  if (!m) return [];
  const header = m[1]!;
  const openIdx = header.indexOf("(");
  if (openIdx < 0) return [];
  // Slice the outermost balanced parenthesised group (the port list).
  let depth = 0;
  let end = -1;
  for (let i = openIdx; i < header.length; i++) {
    const ch = header[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return [];
  const portList = header.slice(openIdx + 1, end);

  const lastName = (frag: string): string | null => {
    const ids = frag.match(/[A-Za-z_][A-Za-z0-9_$]*/g);
    if (!ids || ids.length === 0) return null;
    const name = ids[ids.length - 1]!.toLowerCase();
    return VERILOG_TYPE_WORDS.has(name) ? null : ids[ids.length - 1]!;
  };

  const ports: string[] = [];
  // ANSI-style: each port fragment begins with a direction keyword.
  const dirRe = /\b(?:input|output|inout)\b([^,]*)/gi;
  let pm: RegExpExecArray | null;
  while ((pm = dirRe.exec(portList)) !== null) {
    const name = lastName(pm[1]!);
    if (name) ports.push(name);
  }
  // Fallback: non-ANSI bare-name list.
  if (ports.length === 0) {
    for (const raw of portList.split(",")) {
      const name = lastName(raw);
      if (name) ports.push(name);
    }
  }
  return [...new Set(ports)];
}

/** Codes that mandate immediate fail-closed termination. */
export const FAIL_CLOSED_CODES: ReadonlySet<string> = new Set([
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
// Failure diagnostics — worker-result.json content extraction (IF evidence fetch)
// ---------------------------------------------------------------------------

/** Evidence entry name carrying the structured worker outcome (stdout/stderr/exitCode/phase). */
export const WORKER_RESULT_NAME = "worker-result.json";

/** Shape of the worker-result.json content the Worker writes to output/. */
export interface WorkerResultPayload {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly phase?: string;
}

/** Max chars of stdout/stderr tail kept when rendering the diagnostics block. */
const DIAG_TAIL_CHARS = 2000;

function tail(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : `…(head truncated, ${s.length - max} chars)\n` + s.slice(-max);
}

/**
 * Render a parsed worker-result.json into the {stdout, stderr} pair the repair
 * model consumes. exitCode/phase are emitted as a header line at the top of the
 * stderr fence (the failure channel); stdout/stderr tails follow. Module-level
 * so it is unit-testable without a LoopExecutor.
 */
export function renderFailureDiagnostics(parsed: Partial<WorkerResultPayload>): { stdout: string; stderr: string } {
  const headerParts: string[] = [];
  if (parsed.phase) headerParts.push(`phase=${parsed.phase}`);
  if (parsed.exitCode !== undefined) headerParts.push(`exitCode=${parsed.exitCode}`);
  const header = headerParts.length > 0 ? `[失败诊断 ${headerParts.join(", ")}]\n` : "";
  return {
    stdout: tail(parsed.stdout, DIAG_TAIL_CHARS),
    stderr: header + tail(parsed.stderr, DIAG_TAIL_CHARS),
  };
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

  async fetchEvidenceContent(jobId: string, name: string): Promise<EvidenceContent> {
    const fakeBody = JSON.stringify({
      jobId, name, phase: "simulate",
      exitCode: 1,
      stdout: "Vivado Simulator run",
      stderr: "Error: [USF-XSim 62] parse error",
    });
    return {
      content: fakeBody,
      sha256: sha256Hex(fakeBody),
      truncated: false,
      mediaType: "application/json",
    };
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
