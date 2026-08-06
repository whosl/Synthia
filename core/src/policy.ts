/**
 * Synthia Core — Structured Executable RBAC (SYNTHIA-RBAC)
 *
 * Replaces the previous string-identity, flat-permission model with a
 * deterministic, context-bound authorization engine.
 *
 * Design invariants:
 *  - Identity is NEVER derived from a free-form role string. Authorization binds
 *    actorType + actorId + projectId + roles resolved from RoleAssignment.
 *  - Roles are project-scoped; a role granted on project A grants NOTHING on
 *    project B. Cross-project role spoofing is structurally impossible.
 *  - deny wins over allow: a single explicit deny for the same
 *    (actor, project, operation[, resource]) defeats all allows.
 *  - Agents are second-class: priority is capped at P3 and the operations
 *    approve / baseline / publish / hardware_write are unconditionally denied
 *    to every agent regardless of role or grant.
 *  - Authorization is pure & deterministic over AuthorizationContext, so the
 *    same request always yields the same decision (auditable, replayable).
 */

import type {
  ActorType,
  DataClassification,
  RunClass,
} from "./domain/enums.ts";

// ── Permissions / operations ────────────────────────────────────────────────

/**
 * Operation classes the runtime gates. These are the verbs RBAC evaluates;
 * they map 1:1 to the high-risk state transitions in ARC-002 §5 and FLOW-006.
 */
export type Permission =
  | "read"
  | "candidate_write"
  | "tool_submit"
  | "approve"
  | "baseline"
  | "publish"
  | "hardware_write";

/** Agent autonomy level (FLOW-006 §5). Lower number = higher privilege. */
export type AgentPriority = "P0" | "P1" | "P2" | "P3";

const rank: Record<AgentPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Agents may never hold a priority above (numerically greater than) P3. */
export const AGENT_PRIORITY_CEILING: AgentPriority = "P3";

/**
 * Operations an agent is structurally forbidden from performing, regardless of
 * any project role or allow rule. These are human/accountability gates.
 */
export const AGENT_FORBIDDEN_OPERATIONS: ReadonlySet<Permission> = new Set([
  "approve",
  "baseline",
  "publish",
  "hardware_write",
]);

// ── Permission by agent priority ────────────────────────────────────────────
//
// Within the agent's allowed operation set, the priority controls autonomy:
//   P0 — observe only
//   P1 — may author candidate artifacts
//   P2 — may submit tool runs
//   P3 — may submit gate-class / formal tool runs (still never approve/baseline)
// A higher-numbered priority is strictly more capable, so the sets are additive.

const AGENT_OPERATION_SET: Record<AgentPriority, ReadonlySet<Permission>> = {
  P0: new Set<Permission>(["read"]),
  P1: new Set<Permission>(["read", "candidate_write"]),
  P2: new Set<Permission>(["read", "candidate_write", "tool_submit"]),
  P3: new Set<Permission>(["read", "candidate_write", "tool_submit"]),
};

export function canAgentPriority(
  priority: AgentPriority,
  required: AgentPriority,
): boolean {
  return rank[priority] >= rank[required];
}

/**
 * Clamp an agent's declared priority to the P3 ceiling. A priority outside the
 * legal range is never trusted to mean "more privileged"; it is reduced to the
 * ceiling (least autonomy at-or-below P3).
 */
export function clampAgentPriority(priority: AgentPriority): AgentPriority {
  return rank[priority] >= rank[AGENT_PRIORITY_CEILING]
    ? AGENT_PRIORITY_CEILING
    : priority;
}

// ── Authorization context ───────────────────────────────────────────────────

/**
 * Structured, typed authorization request. Every field is bound from typed
 * domain state — never from an untrusted role string supplied by the caller.
 *
 *  - actorType / actorId: identity of the principal (human user / agent / ...).
 *  - projectId:           scope the request targets; roles must be resolved for
 *                         THIS project only.
 *  - roles:               project roles already resolved from RoleAssignment
 *                         rows for (actorType, actorId, projectId). Empty for
 *                         system/connector principals that act by type, not role.
 *  - operation:           the Permission verb being requested.
 *  - runClass:            run class of the target ToolRun (when applicable).
 *  - dataClassification:  sensitivity tier of the data being touched.
 *  - resource:            free-form resource selector (artifact id, run id, ...)
 *                         used to scope deny/allow rules to specific objects.
 */
export interface AuthorizationContext {
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly projectId: string;
  readonly roles: readonly string[];
  readonly operation: Permission;
  readonly runClass: RunClass | null;
  readonly dataClassification: DataClassification | null;
  readonly resource: string | null;
}

/**
 * Declarative allow/deny rule. Deny rules win over allow rules for the same
 * (context match) — this is the explicit-deny-precedence contract.
 */
export interface AuthorizationRule {
  readonly effect: "allow" | "deny";
  readonly actorTypes?: readonly ActorType[];
  readonly actorIds?: readonly string[];
  readonly projectIds?: readonly string[];
  readonly roles?: readonly string[];
  readonly operations?: readonly Permission[];
  readonly runClasses?: readonly RunClass[];
  readonly dataClassifications?: readonly DataClassification[];
  readonly resources?: readonly string[];
}

/** A rule set plus the optional agent priority reported by the principal. */
export interface PolicyDefinition {
  readonly rules: readonly AuthorizationRule[];
  /**
   * Declared agent priority. Agents are clamped to the P3 ceiling before use.
   * Ignored for non-agent actor types.
   */
  readonly agentPriority?: AgentPriority;
}

// ── Decision ────────────────────────────────────────────────────────────────

export interface AuthorizationDecisionAllow {
  readonly authorized: true;
}

export interface AuthorizationDecisionDeny {
  readonly authorized: false;
  /** Stable machine reason; the first match short-circuits evaluation. */
  readonly reason:
    | "agent_forbidden_operation"
    | "agent_priority_exceeded"
    | "deny_rule"
    | "no_allow_rule"
    | "unknown_actor_type";
  readonly operation: Permission;
  readonly actorType: ActorType;
}

export type AuthorizationDecision =
  | AuthorizationDecisionAllow
  | AuthorizationDecisionDeny;

// ── Rule matching ───────────────────────────────────────────────────────────

function matchesField<T>(
  ruleValues: readonly T[] | undefined,
  value: T,
): boolean {
  // An omitted selector matches anything; otherwise an exact membership test.
  return ruleValues === undefined || ruleValues.includes(value);
}

function matchesResource(
  ruleResources: readonly string[] | undefined,
  resource: string | null,
): boolean {
  if (ruleResources === undefined) return true;
  if (resource === null) return false;
  return ruleResources.includes(resource);
}

/** True when every selector in `rule` matches the supplied `ctx`. */
function ruleMatches(
  rule: AuthorizationRule,
  ctx: AuthorizationContext,
): boolean {
  return (
    matchesField(rule.actorTypes, ctx.actorType) &&
    matchesField(rule.actorIds, ctx.actorId) &&
    matchesField(rule.projectIds, ctx.projectId) &&
    matchesField(rule.operations, ctx.operation) &&
    (rule.runClasses === undefined ||
      (ctx.runClass !== null && rule.runClasses.includes(ctx.runClass))) &&
    (rule.dataClassifications === undefined ||
      (ctx.dataClassification !== null &&
        rule.dataClassifications.includes(ctx.dataClassification))) &&
    (rule.roles === undefined ||
      ctx.roles.some((r) => rule.roles!.includes(r))) &&
    matchesResource(rule.resources, ctx.resource)
  );
}

// ── Core engine ─────────────────────────────────────────────────────────────

/**
 * Deterministic authorization over a typed AuthorizationContext.
 *
 * Evaluation order (first deciding rule wins):
 *   1. Unknown actor type → deny.
 *   2. Agent hard guard: forbidden operations (approve/baseline/publish/
 *      hardware_write) are denied to ALL agents before any rule is consulted.
 *   3. Agent hard guard: operation not in the (clamped) priority's set → deny.
 *   4. Explicit deny precedence: any matching deny rule → deny.
 *   5. Any matching allow rule → allow.
 *   6. Default deny.
 *
 * The result is a pure function of (policy, ctx) — auditable & replayable.
 */
export function authorize(
  policy: PolicyDefinition,
  ctx: AuthorizationContext,
): AuthorizationDecision {
  // 1. Unknown / untyped principals are never authorized.
  if (
    ctx.actorType !== "human" &&
    ctx.actorType !== "agent" &&
    ctx.actorType !== "connector" &&
    ctx.actorType !== "system"
  ) {
    return denied(ctx, "unknown_actor_type");
  }

  // 2–3. Agent structural limits. These are non-negotiable: no role or allow
  //      rule can lift them, because approval/baseline/publish/hardware_write
  //      are human accountability gates.
  if (ctx.actorType === "agent") {
    if (AGENT_FORBIDDEN_OPERATIONS.has(ctx.operation)) {
      return denied(ctx, "agent_forbidden_operation");
    }
    const priority = clampAgentPriority(policy.agentPriority ?? "P0");
    if (!AGENT_OPERATION_SET[priority].has(ctx.operation)) {
      return denied(ctx, "agent_priority_exceeded");
    }
  }

  // 4. Explicit deny precedence.
  for (const rule of policy.rules) {
    if (rule.effect === "deny" && ruleMatches(rule, ctx)) {
      return denied(ctx, "deny_rule");
    }
  }

  // 5. Allow rules.
  for (const rule of policy.rules) {
    if (rule.effect === "allow" && ruleMatches(rule, ctx)) {
      return { authorized: true };
    }
  }

  // 6. Default deny.
  return denied(ctx, "no_allow_rule");
}

function denied(
  ctx: AuthorizationContext,
  reason: AuthorizationDecisionDeny["reason"],
): AuthorizationDecision {
  return {
    authorized: false,
    reason,
    operation: ctx.operation,
    actorType: ctx.actorType,
  };
}

/**
 * Throwing variant of {@link authorize}. Throws an `AUTHORIZATION_DENIED`
 * tagged error on denial; returns void on success. Use at command boundaries
 * where a denial must abort the request.
 */
export function requireAuthorization(
  policy: PolicyDefinition,
  ctx: AuthorizationContext,
): void {
  const decision = authorize(policy, ctx);
  if (!decision.authorized) {
    throw new Error(
      `AUTHORIZATION_DENIED:${decision.reason}:${ctx.operation}:${ctx.actorType}`,
    );
  }
}

// ── Back-compat: structural priority assertions ─────────────────────────────
//
// Preserved for call sites that only need the priority relationship (e.g. tool
// run class gating). Full operation authorization MUST go through
// authorize/requireAuthorization.

/**
 * @deprecated Use {@link authorize} / {@link requireAuthorization} for any
 * operation check. This helper only reasons about agent autonomy priority.
 */
export function assertPermission(
  actor: { type: ActorType; priority?: AgentPriority },
  operation: Permission,
): void {
  if (actor.type !== "agent") return;
  if (AGENT_FORBIDDEN_OPERATIONS.has(operation)) {
    throw new Error(`AUTHORIZATION_DENIED:agent_forbidden_operation:${operation}`);
  }
  const priority = clampAgentPriority(actor.priority ?? "P0");
  if (!AGENT_OPERATION_SET[priority].has(operation)) {
    throw new Error(`AUTHORIZATION_DENIED:agent_priority_exceeded:${operation}`);
  }
}
