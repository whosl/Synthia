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
          const ctx = this.docContext();
          const doc = await this.callModel("generate_behavior_wave", () => model.generateBehaviorWave(ctx, skillPrompts.behaviorWave));
          this.chainCtx.docs.push(doc);
          this.auditModel("generate_behavior_wave", `behavior/wave doc generated: ${doc.docPath}`, doc.docPath, "ok");
          await this.registerDocArtifact(stage, doc, "DETAILED_DESIGN");
          break;
        }
        case "architecture": {
          const ctx = this.docContext();
          const doc = await this.callModel("generate_architecture", () => model.generateArchitecture(ctx, skillPrompts.architecture));
          this.chainCtx.docs.push(doc);
          this.auditModel("generate_architecture", `architecture doc generated: ${doc.docPath}`, doc.docPath, "ok");
          await this.registerDocArtifact(stage, doc, "ARCHITECTURE_DESIGN");
          break;
        }
        case "register_spec": {
          const ctx = this.docContext();
          const doc = await this.callModel("generate_register_spec", () => model.generateRegisterSpec(ctx, skillPrompts.registerSpec));
          this.chainCtx.docs.push(doc);
          this.auditModel("generate_register_spec", `register spec doc generated: ${doc.docPath}`, doc.docPath, "ok");
          await this.registerDocArtifact(stage, doc, "DETAILED_DESIGN");
          break;
        }
        case "rtl_build": {
          const ctx = this.docContext();
          this.chainCtx.rtl = await this.callModel("generate_rtl", () => model.generateRtl(ctx, skillPrompts.rtl));
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
          this.chainCtx.tb = await this.callModel("generate_testbench", () => model.generateTestbench(this.chainCtx.rtl!.sources, this.chainCtx.rtl!.topModule, skillPrompts.tb));
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
          this.chainCtx.xdc = await this.callModel("generate_xdc", () => model.generateXdc(this.chainCtx.rtl!.topModule, part, skillPrompts.xdc, false));
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
      const repaired = await this.callModel("repair", () => model.repair({
        sources: simSources, testbench: simTb, topModule: rtl.topModule, testbenchModule: tb.testbenchModule,
        stderr: sim?.stderr ?? "", stdout: sim?.stdout, attempt: round + 1, systemPrompt: skillPrompts.repair,
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
    const artifactId = `art-${stage}-${sha256Hex(this.task).slice(0, 8)}`;
    const raw = await this.deps.governance.registerCandidateArtifact({
      artifactId,
      artifactType,
      title: `${stage} document`,
      content: doc.content,
      contentLocation: doc.docPath,
      changeReason: `Generated by ${doc.phase}`,
    });
    const rev: RegisteredRevision = { ...raw, contentLocation: doc.docPath };
    this.chainCtx.docRevisions[stage] = rev;
    this.pushAudit({ category: "governance", phase: "governance", action: `registered ${stage} artifact: ${rev.revisionId}`, result: "ok", detail: `type=${artifactType} path=${doc.docPath}` });
    await this.updateState({ docs: { ...this.runState?.docs, [stage]: rev } });
  }

  private async registerRtlArtifact(): Promise<void> {
    if (!this.deps.governance || !this.chainCtx.rtl) return;
    const artifactId = `art-rtl-${sha256Hex(this.task).slice(0, 8)}`;
    const content = this.chainCtx.rtl.sources.map(s => s.content).join("\n");
    const raw = await this.deps.governance.registerCandidateArtifact({
      artifactId,
      artifactType: "RTL_SOURCE_SET",
      title: `RTL top=${this.chainCtx.rtl.topModule}`,
      content,
      contentLocation: `rtl/${this.chainCtx.rtl.sources[0]?.path ?? "top.v"}`,
      changeReason: "Generated by rtl_build stage",
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

  // ----- context builders -----

  /** Build a context string from accumulated docs for downstream stages. */
  private docContext(): string {
    const parts: string[] = [];
    for (const doc of this.chainCtx.docs) {
      parts.push(`## ${doc.docPath}\n\n${doc.content}`);
    }
    return parts.join("\n\n---\n\n") || "(no upstream artifacts yet)";
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
