/**
 * Synthia Core — Content hashing (SHA-256) and manifest digest
 */

import { createHash, randomUUID } from "node:crypto";

export function sha256Hex(data: string | Uint8Array): string {
  const h = createHash("sha256");
  if (typeof data === "string") {
    h.update(data, "utf8");
  } else {
    h.update(data as Buffer);
  }
  return h.digest("hex");
}

export function computeContentHash(content: string | Uint8Array): string {
  return sha256Hex(content);
}

export interface ManifestMember {
  readonly id: string;
  readonly sha256: string;
}

export function computeManifestHash(members: readonly ManifestMember[]): string {
  const sorted = [...members].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return sha256Hex(sorted.map((m) => `${m.id}:${m.sha256}`).join("\n"));
}

export function hashPayload(payload: unknown): string {
  return sha256Hex(stableStringify(payload));
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}
export const sha256 = sha256Hex;
export function stableId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Deterministic idempotency key derived from a structured scope.
 * Scope = actorType + actorId + projectId + operation + key (SYNTHIA-ARC-002 §6 invariants).
 */
export function idempotencyKey(scope: {
  readonly actorType: string;
  readonly actorId: string;
  readonly projectId: string;
  readonly operation: string;
  readonly key: string;
}): string {
  return [scope.actorType, scope.actorId, scope.projectId, scope.operation, scope.key].join("|");
}

/**
 * Canonical request hash for an idempotent operation payload.
 * Stable across key-order variations (keys are sorted recursively before hashing).
 * Same idempotency key with a different canonical hash is a stable conflict.
 */
export const canonicalRequestHash = hashPayload;
