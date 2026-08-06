import { assertPermission } from "../core/src/policy.ts";
import { error, type ApiResponse } from "../core/src/envelope.ts";
import { stableId } from "../core/src/hashing.ts";
import type { ActorType } from "../core/src/domain/enums.ts";

export type ToolName = "core.query" | "core.candidate_write" | "core.job_submit";
export type AgentPriority = "P0" | "P1" | "P2" | "P3";
export interface GatewayActor { type: ActorType; id: string; priority?: AgentPriority; }
export interface Provenance { id: string; kind: "AgentTaskRun" | "ModelCall" | "AgentToolCall"; correlationId: string; idempotencyKey: string; parentId?: string; tool?: ToolName; }
export interface GatewayRequest { actor: GatewayActor; tool: ToolName | string; projectId: string; correlationId: string; idempotencyKey: string; payload?: unknown; }
export class AgentToolGateway {
  readonly provenance: Provenance[] = [];
  private replay = new Map<string, ApiResponse<unknown>>();
  constructor(private readonly handlers: Partial<Record<ToolName, (payload: unknown) => unknown>> = {}) {}
  invoke(request: GatewayRequest): ApiResponse<unknown> {
    const prior = this.replay.get(request.idempotencyKey); if (prior) return prior;
    const task: Provenance = { id: stableId("task"), kind: "AgentTaskRun", correlationId: request.correlationId, idempotencyKey: request.idempotencyKey }; this.provenance.push(task);
    const allowed = new Set<ToolName>(["core.query", "core.candidate_write", "core.job_submit"]);
    if (!allowed.has(request.tool as ToolName)) return this.fail(request, "UNAUTHORIZED_TOOL", "authorization", "Tool is not exposed by Core gateway");
    const permission = request.tool === "core.query" ? "read" : request.tool === "core.candidate_write" ? "candidate_write" : "tool_submit";
    try { assertPermission(request.actor, permission); } catch { return this.fail(request, "AUTHORIZATION_DENIED", "authorization", "Agent permission denied"); }
    const model: Provenance = { id: stableId("model"), kind: "ModelCall", correlationId: request.correlationId, idempotencyKey: request.idempotencyKey, parentId: task.id }; this.provenance.push(model);
    const call: Provenance = { id: stableId("toolcall"), kind: "AgentToolCall", correlationId: request.correlationId, idempotencyKey: request.idempotencyKey, parentId: task.id, tool: request.tool as ToolName }; this.provenance.push(call);
    const result = { ok: true as const, data: this.handlers[request.tool as ToolName]?.(request.payload) ?? { accepted: true, tool: request.tool }, correlationId: request.correlationId };
    this.replay.set(request.idempotencyKey, result); return result;
  }
  private fail(req: GatewayRequest, code: string, category: string, message: string): ApiResponse<never> { const result = error(code, category, message, req.correlationId, false); this.replay.set(req.idempotencyKey, result); return result; }
}
